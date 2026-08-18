//
// Same host the page was loaded from (works whether that's localhost, a
// hostname, or an IP) - just a different port for the backend container.
//
const API = `http://${window.location.hostname}:5000`;

let map;
let pathPreviewLine;

const tripLayers = new Map();      // vehicle_id -> { marker, routeLine }
let pathsById = new Map();         // path_id -> path (from GET /api/paths)
let vehiclesById = new Map();      // vehicle_id -> vehicle (from GET /api/vehicles)
let activeTripsById = new Map();   // vehicle_id -> trip (from the last poll)
let activeVehicleIds = new Set();  // vehicle ids seen on the last poll
let selectedVehicleId = null;      // vehicle id followed in the In Route tab
let selectedTripVehicleId = null;  // vehicle id chosen (in the Vehicles tab) to start a trip

// Create the map
map = L.map("map").setView([44.977, -93.265], 6);

// Add OpenStreetMap tiles
L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    }
).addTo(map);


function formatHMS(totalSeconds) {

    totalSeconds = Math.max(0, Math.round(totalSeconds));

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}


function showTab(tab) {

    for (const name of ["vehicles", "paths", "inroute"]) {

        document.getElementById(`tab-${name}`).classList.toggle("active", name === tab);
        document.getElementById(`tab-button-${name}`).classList.toggle("active", name === tab);
    }
}


async function loadVehicles() {

    const response = await fetch(API + "/api/vehicles");
    const vehicles = await response.json();

    vehiclesById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));

    //
    // The vehicle chosen for a trip might have been sold, or started driving
    // via another tab/tab session - drop the selection if it's no longer a
    // valid READY vehicle.
    //
    const selected = vehiclesById.get(selectedTripVehicleId);

    if (!selected || selected.status !== "READY") {
        selectedTripVehicleId = null;
    }

    renderVehicleList();
    updateStartTripVisibility();
}


function renderVehicleList() {

    const list = document.getElementById("vehicle-list");

    list.innerHTML = "";

    for (const vehicle of vehiclesById.values()) {

        const item = document.createElement("div");

        const driving = vehicle.status === "DRIVING";
        const ready = vehicle.status === "READY";

        item.className = "vehicle-item list-row vehicle-row" +
            (driving || ready ? " clickable" : "") +
            (driving && vehicle.id === selectedVehicleId ? " selected" : "") +
            (ready && vehicle.id === selectedTripVehicleId ? " selected" : "");

        if (driving) {
            item.onclick = () => selectVehicle(vehicle.id);
        } else if (ready) {
            item.onclick = () => selectTripVehicle(vehicle.id);
        }

        item.innerHTML =
            `<span>${vehicle.name} (${vehicle.vehicle_type}) ` +
            `<span class="status-badge status-${vehicle.status}">${vehicle.status}</span></span>` +
            (vehicle.status === "READY"
                ? `<button class="sell-button" data-id="${vehicle.id}">Sell</button>`
                : "");

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".sell-button")) {

        button.onclick = (event) => {
            event.stopPropagation();
            sellVehicle(Number(button.dataset.id));
        };
    }
}


async function sellVehicle(vehicleId) {

    const vehicle = vehiclesById.get(vehicleId);

    if (!confirm(`Sell ${vehicle ? vehicle.name : "this vehicle"}?`)) {
        return;
    }

    await fetch(API + "/api/vehicles/" + vehicleId, { method: "DELETE" });

    loadVehicles();
}


function selectTripVehicle(vehicleId) {

    selectedTripVehicleId = selectedTripVehicleId === vehicleId ? null : vehicleId;

    renderVehicleList();
    updateStartTripVisibility();
}


function updateStartTripVisibility() {

    const pathId = document.getElementById("path-select").value;

    document.getElementById("start-trip-button").style.display =
        selectedTripVehicleId !== null && pathId !== "" ? "" : "none";
}


function selectVehicle(vehicleId) {

    selectedVehicleId = selectedVehicleId === vehicleId ? null : vehicleId;

    //
    // Jump to the vehicle right away on selection; afterwards pollActiveTrips()
    // keeps following it every tick without touching zoom.
    //
    const trip = activeTripsById.get(selectedVehicleId);

    if (trip) {
        map.panTo(trip.position);
    }

    currentCity = null;

    if (selectedVehicleId !== null) {
        showTab("inroute");
        fetchCurrentCity();
    }

    renderInRouteList();
    renderVehicleList();
}


//
// Reverse-geocoding is rate-limited on the backend, so this is only fetched
// for the one selected vehicle, on its own slow timer - not every 1s poll tick.
//
let currentCity = null; // { vehicleId, city }

async function fetchCurrentCity() {

    const vehicleId = selectedVehicleId;

    if (vehicleId === null) {
        return;
    }

    const response = await fetch(API + "/api/vehicles/" + vehicleId + "/city");

    if (!response.ok) {
        return;
    }

    const data = await response.json();

    //
    // Ignore a stale response if the selection changed while this was in flight.
    //
    if (selectedVehicleId === vehicleId) {
        currentCity = { vehicleId, city: data.city };
        renderInRouteList();
    }
}


function renderInRouteList() {

    const list = document.getElementById("inroute-list");

    list.innerHTML = "";

    for (const trip of activeTripsById.values()) {

        const vehicle = vehiclesById.get(trip.vehicle_id);

        const item = document.createElement("div");

        item.className = "vehicle-item" + (trip.vehicle_id === selectedVehicleId ? " selected" : "");
        item.onclick = () => selectVehicle(trip.vehicle_id);

        item.innerHTML =
            `${vehicle ? vehicle.name : trip.vehicle_name} ` +
            `<span class="status-badge status-${trip.status}">${trip.status}</span>`;

        list.appendChild(item);
    }

    const details = document.getElementById("vehicle-details");
    const trip = activeTripsById.get(selectedVehicleId);

    if (!trip) {
        details.textContent = "Select a vehicle to see details.";
        return;
    }

    const vehicle = vehiclesById.get(selectedVehicleId);

    const cityLine = currentCity && currentCity.vehicleId === selectedVehicleId
        ? `Near: ${currentCity.city || "unknown"}<br>`
        : "Near: (looking up...)<br>";

    details.innerHTML =
        `<b>${vehicle ? vehicle.name : trip.vehicle_name}</b><br>` +
        (vehicle ? `Type: ${vehicle.vehicle_type}<br>` : "") +
        `Status: ${trip.status}<br>` +
        cityLine +
        `Position: ${trip.position[0].toFixed(4)}, ${trip.position[1].toFixed(4)}<br>` +
        (trip.road_name ? `Road: ${trip.road_name}<br>` : "") +
        (trip.status === "ARRIVED"
            ? "Arrived"
            : `Speed: ${Math.round(trip.speed_mph)} mph<br>` +
              `Arriving in: ${formatHMS(trip.remaining_sim_seconds)}`);
}


async function addVehicle() {

    await fetch(API + "/api/vehicles", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            name: document.getElementById("vehicle-name").value,

            vehicle_type: document.getElementById("vehicle-type").value

        })

    });

    loadVehicles();
}


function pathLabel(path) {

    return `${path.origin}-${path.destination}`;
}


async function loadPaths() {

    const response = await fetch(API + "/api/paths");
    const paths = await response.json();

    pathsById = new Map(paths.map((path) => [path.id, path]));

    const select = document.getElementById("path-select");
    const previousValue = select.value;

    select.innerHTML = '<option value="">Select a path...</option>';

    for (const path of paths) {

        const option = document.createElement("option");

        option.value = path.id;
        option.textContent = pathLabel(path);

        select.appendChild(option);
    }

    select.value = previousValue;

    renderPathList();
    updateStartTripVisibility();
}


function renderPathList() {

    const list = document.getElementById("path-list");

    list.innerHTML = "";

    for (const path of pathsById.values()) {

        const item = document.createElement("div");

        item.className = "vehicle-item list-row";
        item.onclick = () => previewPath(path);

        item.innerHTML =
            `<span>${pathLabel(path)}</span>` +
            `<button class="remove-path-button" data-id="${path.id}">Remove</button>`;

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".remove-path-button")) {

        button.onclick = (event) => {
            event.stopPropagation();
            removePath(Number(button.dataset.id));
        };
    }
}


async function removePath(pathId) {

    const path = pathsById.get(pathId);

    if (!confirm(`Remove path "${path ? pathLabel(path) : pathId}"?`)) {
        return;
    }

    await fetch(API + "/api/paths/" + pathId, { method: "DELETE" });

    loadPaths();
}


function previewPath(path) {

    if (pathPreviewLine) {
        map.removeLayer(pathPreviewLine);
    }

    pathPreviewLine = L.polyline(path.route, {

        color: "gray",

        dashArray: "6 6",

        weight: 3

    }).addTo(map);

    map.fitBounds(pathPreviewLine.getBounds());
}


async function createPath() {

    const response = await fetch(API + "/api/paths", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            origin: document.getElementById("origin").value,

            destination: document.getElementById("destination").value

        })

    });

    const path = await response.json();

    previewPath(path);

    await loadPaths();

    document.getElementById("path-select").value = path.id;
    updateStartTripVisibility();
}


async function startTrip() {

    const vehicleId = selectedTripVehicleId;
    const pathId = document.getElementById("path-select").value;

    const response = await fetch(API + "/api/trips", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            vehicle_id: Number(vehicleId),

            path_id: Number(pathId)

        })

    });

    const data = await response.json();

    if (!response.ok) {
        alert(data.detail || "Could not start trip");
        return;
    }

    //
    // Remove any previous layers for this vehicle (e.g. a prior completed trip)
    //
    const existing = tripLayers.get(data.vehicle_id);

    if (existing) {
        map.removeLayer(existing.marker);
        map.removeLayer(existing.routeLine);
    }

    const routeLine = L.polyline(data.route, {

        color: "blue",

        weight: 5

    }).addTo(map);

    const marker = L.marker(data.position).addTo(map);

    marker.bindTooltip(
        `Drive time: ${formatHMS(data.duration_seconds)}` +
        ` (playing in ${formatHMS(data.sim_duration_seconds)})`,
        { permanent: true, direction: "top", offset: [0, -10] }
    ).openTooltip();

    marker.on("click", () => selectVehicle(data.vehicle_id));

    tripLayers.set(data.vehicle_id, { marker, routeLine });

    map.fitBounds(routeLine.getBounds());

    selectedTripVehicleId = null;
    document.getElementById("path-select").value = "";
    updateStartTripVisibility();

    loadVehicles();
}


async function pollActiveTrips() {

    const response = await fetch(API + "/api/trips/active");
    const data = await response.json();

    const seen = new Set();

    activeTripsById = new Map(data.trips.map((trip) => [trip.vehicle_id, trip]));

    for (const trip of data.trips) {

        seen.add(trip.vehicle_id);

        let layer = tripLayers.get(trip.vehicle_id);

        if (!layer) {

            const routeLine = L.polyline(trip.route, {

                color: "blue",

                weight: 5

            }).addTo(map);

            const marker = L.marker(trip.position).addTo(map);

            marker.bindTooltip(
                "", { permanent: true, direction: "top", offset: [0, -10] }
            ).openTooltip();

            marker.on("click", () => selectVehicle(trip.vehicle_id));

            layer = { marker, routeLine };

            tripLayers.set(trip.vehicle_id, layer);
        }

        layer.marker.setLatLng(trip.position);

        layer.marker.setTooltipContent(
            trip.status === "ARRIVED"
                ? `${trip.vehicle_name}: Arrived`
                : `${trip.vehicle_name}: arriving in ${formatHMS(trip.remaining_sim_seconds)}`
        );

        //
        // Keep the map centered on the selected vehicle as it moves, without
        // touching zoom (a full fitBounds/setView would fight the user's view).
        //
        if (trip.vehicle_id === selectedVehicleId) {
            map.panTo(trip.position);
        }
    }

    //
    // Any vehicle we were tracking that's no longer in this poll's response
    // has fully expired past the arrival grace period - remove its layers.
    //
    for (const [vehicleId, layer] of tripLayers) {

        if (!seen.has(vehicleId)) {

            map.removeLayer(layer.marker);
            map.removeLayer(layer.routeLine);

            tripLayers.delete(vehicleId);
        }
    }

    renderInRouteList();

    if (!setsEqual(seen, activeVehicleIds)) {

        activeVehicleIds = seen;

        loadVehicles();
    }
}


function setsEqual(a, b) {

    if (a.size !== b.size) {
        return false;
    }

    for (const item of a) {
        if (!b.has(item)) {
            return false;
        }
    }

    return true;
}


loadVehicles();
loadPaths();

setInterval(pollActiveTrips, 1000);

setInterval(() => {

    if (selectedVehicleId !== null) {
        fetchCurrentCity();
    }

}, 7000);
