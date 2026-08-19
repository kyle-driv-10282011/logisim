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

    if (zoneDraftPath && zoneDraftPath.id === pathId) {

        zoneDraftPath = null;

        cancelZoneDraft();
        clearZoneOverlays();

        document.getElementById("zone-editor").style.display = "none";
    }

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

    renderZoneEditor(path);
}


//
// Zones let a user override the traffic model (speed limit, rush hour
// window/severity) for a specific chunk of one path's route, instead of
// relying purely on the synthetic tier-based model. A chunk is picked by
// clicking two points on the previewed route; each click snaps to the
// nearest route vertex, whose cumulative-distance value (miles from the
// origin - a fixed geometric property of the route, unlike time, which
// now depends on the traffic model itself) becomes the zone's start/end.
//
let zoneDraftPath = null;          // path currently shown in the zone editor
let zoneDraftPoints = [];          // cumulative-miles values of picked points (0-2 of them)
let zoneDraftMarkers = [];         // Leaflet markers for the picked points
let zoneDrawArmed = false;         // true while waiting for the next map click to pick a point
let zoneOverlayLines = [];         // polylines highlighting this path's existing zones


function milesToRouteIndex(distancesMiles, miles) {

    let lo = 0, hi = distancesMiles.length - 1;

    while (lo < hi) {

        const mid = (lo + hi) >> 1;

        if (distancesMiles[mid] < miles) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    return lo;
}


function nearestRouteIndex(route, latlng) {

    let bestIndex = 0;
    let bestDist = Infinity;

    for (let i = 0; i < route.length; i++) {

        const dLat = route[i][0] - latlng.lat;
        const dLon = route[i][1] - latlng.lng;
        const dist = dLat * dLat + dLon * dLon;

        if (dist < bestDist) {
            bestDist = dist;
            bestIndex = i;
        }
    }

    return bestIndex;
}


function formatHour(hour) {

    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);

    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}


function zoneSummary(zone) {

    const rush = zone.rush_hour_start !== null && zone.rush_hour_end !== null
        ? ` (rush ${formatHour(zone.rush_hour_start)}-${formatHour(zone.rush_hour_end)}, severity ${zone.rush_hour_factor})`
        : "";

    return `mile ${zone.start_miles.toFixed(1)}-${zone.end_miles.toFixed(1)}: ` +
        `${Math.round(zone.speed_limit_mph)} mph${rush}`;
}


function clearZoneOverlays() {

    for (const line of zoneOverlayLines) {
        map.removeLayer(line);
    }

    zoneOverlayLines = [];
}


function renderZoneOverlays(path) {

    clearZoneOverlays();

    for (const zone of path.zones || []) {

        const startIndex = milesToRouteIndex(path.distances_miles, zone.start_miles);
        const endIndex = Math.max(startIndex, milesToRouteIndex(path.distances_miles, zone.end_miles));

        const line = L.polyline(path.route.slice(startIndex, endIndex + 1), {

            color: "orange",

            weight: 7,

            opacity: 0.85

        }).addTo(map);

        zoneOverlayLines.push(line);
    }
}


function renderZoneList(path) {

    const list = document.getElementById("zone-list");

    list.innerHTML = "";

    for (const zone of path.zones || []) {

        const item = document.createElement("div");

        item.className = "vehicle-item list-row";

        item.innerHTML =
            `<span>${zoneSummary(zone)}</span>` +
            `<button class="remove-zone-button" data-id="${zone.id}">Delete</button>`;

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".remove-zone-button")) {
        button.onclick = () => removeZone(Number(button.dataset.id));
    }
}


function renderZoneEditor(path) {

    zoneDraftPath = path;

    cancelZoneDraft();

    document.getElementById("zone-editor").style.display = "";
    document.getElementById("zone-editor-path-label").textContent = pathLabel(path);

    renderZoneOverlays(path);
    renderZoneList(path);
}


function clearZoneDraftMarkers() {

    for (const marker of zoneDraftMarkers) {
        map.removeLayer(marker);
    }

    zoneDraftMarkers = [];
}


function startZoneDraw() {

    zoneDrawArmed = true;
    zoneDraftPoints = [];

    clearZoneDraftMarkers();

    document.getElementById("zone-draw-hint").style.display = "";
    document.getElementById("zone-form").style.display = "none";
}


function cancelZoneDraft() {

    zoneDrawArmed = false;
    zoneDraftPoints = [];

    clearZoneDraftMarkers();

    document.getElementById("zone-draw-hint").style.display = "none";
    document.getElementById("zone-form").style.display = "none";
}


map.on("click", (event) => {

    if (!zoneDrawArmed || !zoneDraftPath) {
        return;
    }

    const index = nearestRouteIndex(zoneDraftPath.route, event.latlng);

    const marker = L.circleMarker(zoneDraftPath.route[index], {

        radius: 6,

        color: "orange"

    }).addTo(map);

    zoneDraftMarkers.push(marker);
    zoneDraftPoints.push(zoneDraftPath.distances_miles[index]);

    if (zoneDraftPoints.length === 2) {

        zoneDrawArmed = false;

        document.getElementById("zone-draw-hint").style.display = "none";
        document.getElementById("zone-form").style.display = "";
    }
});


async function saveZoneDraft() {

    const [a, b] = zoneDraftPoints;

    const rushStartRaw = document.getElementById("zone-rush-start").value;
    const rushEndRaw = document.getElementById("zone-rush-end").value;

    const response = await fetch(API + "/api/paths/" + zoneDraftPath.id + "/zones", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            start_miles: Math.min(a, b),

            end_miles: Math.max(a, b),

            speed_limit_mph: Number(document.getElementById("zone-speed").value),

            rush_hour_start: rushStartRaw === "" ? null : Number(rushStartRaw),

            rush_hour_end: rushEndRaw === "" ? null : Number(rushEndRaw),

            rush_hour_factor: Number(document.getElementById("zone-rush-factor").value)

        })

    });

    const data = await response.json();

    if (!response.ok) {
        alert(data.detail || "Could not save zone");
        return;
    }

    const pathId = zoneDraftPath.id;

    cancelZoneDraft();

    await loadPaths();

    const refreshed = pathsById.get(pathId);

    if (refreshed) {
        renderZoneEditor(refreshed);
    }
}


async function removeZone(zoneId) {

    if (!confirm("Delete this zone?")) {
        return;
    }

    const pathId = zoneDraftPath.id;

    await fetch(API + "/api/zones/" + zoneId, { method: "DELETE" });

    await loadPaths();

    const refreshed = pathsById.get(pathId);

    if (refreshed) {
        renderZoneEditor(refreshed);
    }
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
