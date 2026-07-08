let currentVehicles = [];
let currentJobs = [];
let currentDeliveries = [];
let map = null;
let vehicleMarkers = {};
let jobMarkers = [];
let deliveryRoutes = [];
let deliveryMarkers = [];
let liveTimer = null;
let hasAutoFittedMap = false;

async function loadData() {
  const [gameState, vehicles, jobs, deliveries] = await Promise.all([
    fetch('/api/game-state').then((res) => res.json()),
    fetch('/api/vehicles').then((res) => res.json()),
    fetch('/api/jobs').then((res) => res.json()),
    fetch('/api/deliveries').then((res) => res.json()),
  ]);

  currentVehicles = vehicles;
  currentJobs = jobs;
  currentDeliveries = deliveries;

  renderCompany(gameState.company);
  renderVehicles(vehicles);
  renderJobs(jobs);
  renderDeliveries(deliveries);
  renderSimulationTime(gameState.simulation_time);
  renderDispatchPanel();
  renderMap(vehicles, jobs, deliveries);

  if (!liveTimer) {
    liveTimer = window.setInterval(() => {
      fetch('/api/deliveries').then((res) => res.json()).then((deliveries) => {
        currentDeliveries = deliveries;
        renderDeliveries(deliveries);
        renderMap(currentVehicles, currentJobs, deliveries);
      });
    }, 1000);
  }
}

function renderCompany(company) {
  document.getElementById('company-summary').innerHTML = `
    <p><strong>Name:</strong> ${company.name}</p>
    <p><strong>Cash:</strong> $${company.cash.toLocaleString()}</p>
    <p><strong>Reputation:</strong> ${company.reputation}</p>
    <p><strong>Level:</strong> ${company.level}</p>
  `;
}

function renderVehicles(vehicles) {
  const container = document.getElementById('vehicle-list');
  container.innerHTML = vehicles.map((vehicle) => `
    <div class="metric">
      <strong>${vehicle.name}</strong><br />
      ${vehicle.type} • ${vehicle.status}<br />
      Fuel ${vehicle.fuel_level}% • ${vehicle.current_city}
    </div>
  `).join('');
}

function renderJobs(jobs) {
  const container = document.getElementById('job-list');
  container.innerHTML = jobs.map((job) => `
    <div class="metric">
      <strong>${job.pickup_city} → ${job.dropoff_city}</strong><br />
      Cargo: ${job.cargo_type}<br />
      Reward: $${job.reward}<br />
      Deadline: ${job.deadline_hours}h
      <button class="dispatch-button" data-job-id="${job.id}">Dispatch</button>
    </div>
  `).join('');

  container.querySelectorAll('.dispatch-button').forEach((button) => {
    button.addEventListener('click', () => selectJob(Number(button.dataset.jobId)));
  });
}

function renderDeliveries(deliveries) {
  const container = document.getElementById('delivery-list');
  if (!deliveries.length) {
    container.innerHTML = '<p>No deliveries in progress.</p>';
    return;
  }

  container.innerHTML = deliveries.map((delivery) => `
    <div class="metric">
      <strong>${delivery.status}</strong><br />
      ${delivery.origin} → ${delivery.destination}<br />
      ETA: ${delivery.eta}<br />
      Vehicle: ${delivery.vehicle_name || 'Unknown'}
    </div>
  `).join('');
}

function renderDispatchPanel() {
  const container = document.getElementById('dispatch-panel');
  const idleVehicles = currentVehicles.filter((vehicle) => vehicle.status === 'idle');
  if (!currentJobs.length || !idleVehicles.length) {
    container.innerHTML = '<p>Select a job and assign an available vehicle.</p>';
    return;
  }

  const selectedJob = currentJobs[0];
  container.innerHTML = `
    <p><strong>Selected job:</strong> ${selectedJob.pickup_city} → ${selectedJob.dropoff_city}</p>
    <label for="vehicle-select">Vehicle</label>
    <select id="vehicle-select">
      ${idleVehicles.map((vehicle) => `<option value="${vehicle.id}">${vehicle.name} (${vehicle.type})</option>`).join('')}
    </select>
    <button id="assign-button">Assign Vehicle</button>
  `;

  document.getElementById('assign-button').addEventListener('click', async () => {
    const vehicleId = Number(document.getElementById('vehicle-select').value);
    await assignJob(selectedJob.id, vehicleId);
  });
}

async function assignJob(jobId, vehicleId) {
  const response = await fetch(`/api/jobs/${jobId}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehicle_id: vehicleId }),
  });
  const result = await response.json();
  if (result.status === 'assigned') {
    await loadData();
  }
}

function selectJob(jobId) {
  const selectedJob = currentJobs.find((job) => job.id === jobId);
  if (!selectedJob) return;
  const panel = document.getElementById('dispatch-panel');
  const idleVehicles = currentVehicles.filter((vehicle) => vehicle.status === 'idle');
  panel.innerHTML = `
    <p><strong>Selected job:</strong> ${selectedJob.pickup_city} → ${selectedJob.dropoff_city}</p>
    <label for="vehicle-select">Vehicle</label>
    <select id="vehicle-select">
      ${idleVehicles.map((vehicle) => `<option value="${vehicle.id}">${vehicle.name} (${vehicle.type})</option>`).join('')}
    </select>
    <button id="assign-button">Assign Vehicle</button>
  `;

  document.getElementById('assign-button').addEventListener('click', async () => {
    const vehicleId = Number(document.getElementById('vehicle-select').value);
    await assignJob(selectedJob.id, vehicleId);
  });
}

function renderSimulationTime(time) {
  document.getElementById('simulation-time').textContent = `Sim time: ${time}`;
}

function initMap() {
  if (map) {
    return;
  }

  map = L.map('map').setView([44.98, -93.26], 5);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
}

function renderMap(vehicles, jobs, deliveries) {
  initMap();

  deliveryRoutes.forEach((layer) => map.removeLayer(layer));
  deliveryMarkers.forEach((marker) => map.removeLayer(marker));
  jobMarkers.forEach((marker) => map.removeLayer(marker));
  Object.values(vehicleMarkers).forEach((marker) => map.removeLayer(marker));

  deliveryRoutes = [];
  deliveryMarkers = [];
  jobMarkers = [];
  vehicleMarkers = {};

  vehicles.forEach((vehicle) => {
    const marker = L.marker([vehicle.current_lat || 44.9778, vehicle.current_lon || -93.2650])
      .addTo(map)
      .bindPopup(`${vehicle.name} • ${vehicle.status}`);
    vehicleMarkers[vehicle.id] = marker;
  });

  jobs.forEach((job) => {
    const pickupMarker = L.circleMarker([job.pickup_lat, job.pickup_lon], { radius: 6 }).addTo(map).bindPopup(`${job.pickup_city}`);
    const dropoffMarker = L.circleMarker([job.dropoff_lat, job.dropoff_lon], { radius: 6 }).addTo(map).bindPopup(`${job.dropoff_city}`);
    jobMarkers.push(pickupMarker, dropoffMarker);
  });

  deliveries.forEach((delivery) => {
    if (!delivery.route || !delivery.route.length) {
      return;
    }

    const routeLayer = L.polyline(delivery.route, { color: '#38bdf8', weight: 4 }).addTo(map);
    deliveryRoutes.push(routeLayer);

    const vehicleMarker = L.marker([delivery.current_lat, delivery.current_lon], { title: delivery.vehicle_name })
      .addTo(map)
      .bindPopup(`${delivery.vehicle_name || 'Vehicle'} • ${delivery.status}`);
    deliveryMarkers.push(vehicleMarker);
  });

  if (!hasAutoFittedMap && deliveries.length) {
    const bounds = deliveries.flatMap((delivery) => delivery.route || []);
    if (bounds.length) {
      map.fitBounds(bounds);
      hasAutoFittedMap = true;
    }
  }
}

loadData();
