const API = "http://localhost:5000";

let map;
let pathPreviewLine;

const tripLayers = new Map();      // vehicle_id -> { marker, routeLine }
let pathsById = new Map();         // path_id -> path (from GET /api/paths)
let activeVehicleIds = new Set();  // vehicle ids seen on the last poll

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


async function loadVehicles() {

    const response = await fetch(API + "/api/vehicles");
    const vehicles = await response.json();

    const select = document.getElementById("vehicle-select");
    const previousValue = select.value;

    select.innerHTML = "";

    for (const vehicle of vehicles) {

        const option = document.createElement("option");

        option.value = vehicle.id;
        option.textContent = `${vehicle.name} (${vehicle.vehicle_type}) - ${vehicle.status}`;
        option.disabled = vehicle.status !== "READY";

        select.appendChild(option);
    }

    select.value = previousValue;
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


async function loadPaths() {

    const response = await fetch(API + "/api/paths");
    const paths = await response.json();

    pathsById = new Map(paths.map((path) => [path.id, path]));

    const select = document.getElementById("path-select");
    const previousValue = select.value;

    select.innerHTML = "";

    for (const path of paths) {

        const option = document.createElement("option");

        option.value = path.id;
        option.textContent = path.name;

        select.appendChild(option);
    }

    select.value = previousValue;
}


async function createPath() {

    const response = await fetch(API + "/api/paths", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            name: document.getElementById("path-name").value,

            origin: document.getElementById("origin").value,

            destination: document.getElementById("destination").value

        })

    });

    const path = await response.json();

    if (pathPreviewLine) {
        map.removeLayer(pathPreviewLine);
    }

    pathPreviewLine = L.polyline(path.route, {

        color: "gray",

        dashArray: "6 6",

        weight: 3

    }).addTo(map);

    map.fitBounds(pathPreviewLine.getBounds());

    await loadPaths();

    document.getElementById("path-select").value = path.id;
}


async function startTrip() {

    const vehicleId = document.getElementById("vehicle-select").value;
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

    tripLayers.set(data.vehicle_id, { marker, routeLine });

    map.fitBounds(routeLine.getBounds());

    loadVehicles();
}


async function pollActiveTrips() {

    const response = await fetch(API + "/api/trips/active");
    const data = await response.json();

    const seen = new Set();

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

            layer = { marker, routeLine };

            tripLayers.set(trip.vehicle_id, layer);
        }

        layer.marker.setLatLng(trip.position);

        layer.marker.setTooltipContent(
            trip.status === "ARRIVED"
                ? `${trip.vehicle_name}: Arrived`
                : `${trip.vehicle_name}: arriving in ${formatHMS(trip.remaining_sim_seconds)}`
        );
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
