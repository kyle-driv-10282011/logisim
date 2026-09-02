//
// Same host the page was loaded from (works whether that's localhost, a
// hostname, or an IP) - just a different port for the backend container.
//
const API = `http://${window.location.hostname}:5000`;

//
// Mirrors the backend's own tier classification (app.py) so the path
// preview can color-code each section by its effective speed limit
// without a round trip - same thresholds/defaults, kept in sync by hand.
//
const MIN_REALISTIC_SPEED_MPH = 5;
const MAX_REALISTIC_SPEED_MPH = 85;
const INTERSTATE_MIN_MPH = 55;
const ARTERIAL_MIN_MPH = 35;
const TIER_DEFAULT_MPH = { interstate: 70, arterial: 50, local: 30 };

let map;

//
// The game clock (app.py's get_settings()) is transmitted as a naive
// local wall-clock string (e.g. "2026-08-27T13:15:00.123456", no
// timezone/offset - see settings_dict() in app.py). gameClockAnchor
// holds the last fetch: {gameTimeMs, realTimeMs, multiplier}, where
// gameTimeMs/realTimeMs are both epoch milliseconds. Every second,
// updateSimClock() extrapolates forward from this anchor rather than
// polling every tick, so the clock ticks smoothly between the periodic
// GET /api/settings refreshes (loadSettings()).
//
let gameClockAnchor = null;


//
// Parses the naive local string as if it were UTC (appending "Z" forces
// that) so its digits are preserved exactly - formatting later with
// timeZone: "UTC" reads those same digits back out unchanged. This
// avoids ever reinterpreting the value through the *browser's* own
// timezone, which would misrepresent it since it's not a real UTC instant.
//
function parseGameTime(iso) {

    return new Date(iso + "Z");
}


async function loadSettings() {

    const response = await fetch(API + "/api/settings");
    const settings = await response.json();

    gameClockAnchor = {

        gameTimeMs: parseGameTime(settings.game_time).getTime(),

        realTimeMs: Date.now(),

        multiplier: settings.time_multiplier
    };

    //
    // Don't clobber the input while the user is mid-edit typing a new value.
    //
    const input = document.getElementById("time-multiplier-input");

    if (document.activeElement !== input) {
        input.value = settings.time_multiplier;
    }

    updateSimClock();
}


//
// Changing the multiplier mid-trip would retroactively rescale a
// schedule already shown to the user as an ETA, so the backend rejects
// it (409) while any vehicle is in route - this mirrors that state in
// the UI rather than just waiting for the request to fail. Excludes
// "ARRIVED" trips still lingering in activeTripsById during the arrival
// grace period, matching the backend's own in-route check.
//
function updateTimeMultiplierControlState() {

    const anyInRoute = [...activeTripsById.values()].some((trip) => trip.status !== "ARRIVED");

    const input = document.getElementById("time-multiplier-input");
    const button = document.getElementById("time-multiplier-set-button");

    input.disabled = anyInRoute;
    button.disabled = anyInRoute;

    document.getElementById("time-multiplier-control").title =
        anyInRoute ? "Cannot change while vehicles are in route" : "";
}


async function setTimeMultiplier() {

    const value = Number(document.getElementById("time-multiplier-input").value);

    if (!(value > 0)) {
        alert("Time multiplier must be positive");
        return;
    }

    const response = await fetch(API + "/api/settings", {

        method: "PUT",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({ time_multiplier: value })

    });

    const data = await response.json();

    if (!response.ok) {
        alert(data.detail || "Could not update time multiplier");
        return;
    }

    gameClockAnchor = {

        gameTimeMs: parseGameTime(data.game_time).getTime(),

        realTimeMs: Date.now(),

        multiplier: data.time_multiplier
    };

    updateSimClock();
}

const tripLayers = new Map();      // vehicle_id -> { marker, routeLine }
let specsById = new Map();         // spec_id -> vehicle spec (from GET /api/vehicle-specs)
let pathsById = new Map();         // path_id -> path (from GET /api/paths)
let vehiclesById = new Map();      // vehicle_id -> vehicle - current fleet, not sold (from GET /api/vehicles)
let allVehiclesById = new Map();   // vehicle_id -> vehicle - full history, sold or not (from GET /api/vehicles?include_sold=true)
let activeTripsById = new Map();   // vehicle_id -> trip (from the last poll)
let activeVehicleIds = new Set();  // vehicle ids seen on the last poll
let selectedVehicleId = null;      // vehicle id followed in the In Route tab
let selectedTripVehicleId = null;  // vehicle id chosen (in the Vehicles tab) to start a trip
let restingVehicleMarker = null;   // dot marking a clicked non-driving vehicle's resting location

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


//
// A small dot marking where a non-driving (READY/SOLD) vehicle is
// currently sitting - a driving vehicle already has its own live marker
// from pollActiveTrips(), so this is only ever shown for one that doesn't.
//
function showRestingVehicleMarker(vehicle) {

    clearRestingVehicleMarker();

    restingVehicleMarker = L.circleMarker([vehicle.current_lat, vehicle.current_lng], {

        radius: 8,
        color: "#3388ff",
        weight: 2,
        fillColor: "#3388ff",
        fillOpacity: 1

    }).addTo(map);

    restingVehicleMarker.bindTooltip(vehicle.name, { direction: "top", offset: [0, -10] });
}


function clearRestingVehicleMarker() {

    if (restingVehicleMarker) {
        map.removeLayer(restingVehicleMarker);
        restingVehicleMarker = null;
    }
}


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

    for (const name of ["templates", "myvehicles", "allvehicles", "paths", "inroute"]) {

        document.getElementById(`tab-${name}`).classList.toggle("active", name === tab);
        document.getElementById(`tab-button-${name}`).classList.toggle("active", name === tab);
    }
}


//
// Specs are served by the backend as a filename (e.g. "2026-Chevy-Express.png"),
// not a URL - the frontend is what knows it's serving frontend/images/ at its
// own origin (same host/port index.html was loaded from), so this is a plain
// relative path rather than going through the API host/port.
//
function specImageUrl(filename) {

    return filename ? `images/${encodeURIComponent(filename)}` : null;
}


function specLabel(spec) {

    return `${spec.year} ${spec.brand} ${spec.model}`;
}


async function loadSpecs() {

    const response = await fetch(API + "/api/vehicle-specs");
    const specs = await response.json();

    specsById = new Map(specs.map((spec) => [spec.id, spec]));

    const select = document.getElementById("vehicle-spec-select");
    const previousValue = select.value;

    select.innerHTML = specs.length
        ? ""
        : '<option value="">No specs yet - add one below</option>';

    for (const spec of specs) {

        const option = document.createElement("option");

        option.value = spec.id;
        option.textContent = specLabel(spec);

        select.appendChild(option);
    }

    if (specs.some((spec) => String(spec.id) === previousValue)) {
        select.value = previousValue;
    }

    renderSpecList();
    renderVehicleList();
    renderInRouteList();
}


function renderSpecList() {

    const list = document.getElementById("spec-list");

    list.innerHTML = "";

    for (const spec of specsById.values()) {

        const item = document.createElement("div");

        item.className = "vehicle-item list-row";

        const imageUrl = specImageUrl(spec.image);

        item.innerHTML =
            `<span class="spec-item-label">` +
            (imageUrl ? `<img class="spec-thumb" src="${imageUrl}">` : "") +
            `<span>${specLabel(spec)}` +
            `<div class="spec-item-details">` +
            `${spec.person_capacity} people &middot; ${spec.cargo_capacity_cuft} cu ft &middot; ` +
            `$${Math.round(spec.cost).toLocaleString()} &middot; ${spec.mpg} mpg` +
            `</div></span></span>` +
            `<button class="remove-spec-button" data-id="${spec.id}">Delete</button>`;

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".remove-spec-button")) {

        button.onclick = (event) => {
            event.stopPropagation();
            removeSpec(Number(button.dataset.id));
        };
    }
}


async function addSpec() {

    const response = await fetch(API + "/api/vehicle-specs", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            year: Number(document.getElementById("spec-year").value),

            brand: document.getElementById("spec-brand").value,

            model: document.getElementById("spec-model").value,

            person_capacity: Number(document.getElementById("spec-person-capacity").value),

            cargo_capacity_cuft: Number(document.getElementById("spec-cargo-capacity").value),

            cost: Number(document.getElementById("spec-cost").value),

            mpg: Number(document.getElementById("spec-mpg").value),

            image: document.getElementById("spec-image").value || null

        })

    });

    const data = await response.json();

    if (!response.ok) {
        alert(data.detail || "Could not add spec");
        return;
    }

    loadSpecs();
}


async function removeSpec(specId) {

    const spec = specsById.get(specId);

    if (!confirm(`Delete spec "${spec ? specLabel(spec) : specId}"?`)) {
        return;
    }

    const response = await fetch(API + "/api/vehicle-specs/" + specId, { method: "DELETE" });

    if (!response.ok) {

        const data = await response.json();
        alert(data.detail || "Could not delete spec");
        return;
    }

    loadSpecs();
}


async function loadVehicles() {

    const [ownedResponse, allResponse] = await Promise.all([
        fetch(API + "/api/vehicles"),
        fetch(API + "/api/vehicles?include_sold=true")
    ]);

    const vehicles = await ownedResponse.json();
    const allVehicles = await allResponse.json();

    vehiclesById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
    allVehiclesById = new Map(allVehicles.map((vehicle) => [vehicle.id, vehicle]));

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
    renderAllVehicleList();
    renderPathSelectForTripVehicle();
}


//
// A vehicle's settled total_miles_traveled (from GET /api/vehicles) only
// picks up a trip once it's arrived - while DRIVING, the distance covered
// so far on the current trip comes from the live poll (GET
// /api/trips/active's distance_miles, see derive_position()) instead, so
// the odometer shown in the vehicle lists keeps ticking up in real time.
//
function vehicleTotalMiles(vehicle) {

    const trip = activeTripsById.get(vehicle.id);
    const liveMiles = trip && trip.status === "DRIVING" ? trip.distance_miles : 0;

    return vehicle.total_miles_traveled + liveMiles;
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

        const imageUrl = vehicle.spec ? specImageUrl(vehicle.spec.image) : null;

        item.innerHTML =
            `<span class="spec-item-label">` +
            (imageUrl ? `<img class="spec-thumb" src="${imageUrl}">` : "") +
            `<span>${vehicle.name}` +
            (vehicle.spec ? ` (${specLabel(vehicle.spec)})` : "") +
            ` &middot; ${vehicle.current_location} ` +
            `&middot; ${Math.round(vehicleTotalMiles(vehicle)).toLocaleString()} mi ` +
            `<span class="status-badge status-${vehicle.status}">${vehicle.status}</span></span></span>` +
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


function renderAllVehicleList() {

    const list = document.getElementById("all-vehicle-list");

    list.innerHTML = "";

    for (const vehicle of allVehiclesById.values()) {

        const item = document.createElement("div");

        item.className = "vehicle-item list-row vehicle-row clickable";

        //
        // Just pans to wherever the vehicle currently is - unlike
        // selectVehicle() (the In Route "follow" flow) or
        // selectTripVehicle() (path-select filtering for starting a
        // trip), clicking here doesn't change tabs or any other state. A
        // driving vehicle already has its own live marker, so the resting
        // dot is only for one that isn't.
        //
        item.onclick = () => {

            map.panTo([vehicle.current_lat, vehicle.current_lng]);

            if (vehicle.status === "DRIVING") {
                clearRestingVehicleMarker();
            } else {
                showRestingVehicleMarker(vehicle);
            }
        };

        const imageUrl = vehicle.spec ? specImageUrl(vehicle.spec.image) : null;

        item.innerHTML =
            `<span class="spec-item-label">` +
            (imageUrl ? `<img class="spec-thumb" src="${imageUrl}">` : "") +
            `<span>${vehicle.name}` +
            (vehicle.spec ? ` (${specLabel(vehicle.spec)})` : "") +
            ` &middot; ${vehicle.current_location} ` +
            `&middot; ${Math.round(vehicleTotalMiles(vehicle)).toLocaleString()} mi ` +
            `<span class="status-badge status-${vehicle.status}">${vehicle.status}</span></span></span>`;

        list.appendChild(item);
    }
}


async function sellVehicle(vehicleId) {

    const vehicle = vehiclesById.get(vehicleId);

    if (!confirm(`Sell ${vehicle ? vehicle.name : "this vehicle"}?`)) {
        return;
    }

    const response = await fetch(API + "/api/vehicles/" + vehicleId + "/sell", { method: "POST" });

    if (!response.ok) {

        const data = await response.json();
        alert(data.detail || "Could not sell vehicle");
        return;
    }

    loadVehicles();
}


function selectTripVehicle(vehicleId) {

    selectedTripVehicleId = selectedTripVehicleId === vehicleId ? null : vehicleId;

    //
    // Jump to wherever the vehicle currently is (its settled
    // current_lat/current_lng, not a live trip position - it's READY, not
    // driving) when it's selected, not when deselecting.
    //
    if (selectedTripVehicleId !== null) {

        const vehicle = vehiclesById.get(selectedTripVehicleId);

        if (vehicle) {
            map.panTo([vehicle.current_lat, vehicle.current_lng]);
            showRestingVehicleMarker(vehicle);
        }

    } else {
        clearRestingVehicleMarker();
    }

    renderVehicleList();
    renderPathSelectForTripVehicle();
}


//
// A vehicle can only start a trip on a path whose origin is where it
// currently is (enforced server-side too, in POST /api/trips) - so the
// dropdown only offers paths matching the selected vehicle's
// current_lat/current_lng, rather than every path that's ever been created.
//
const COORD_MATCH_EPSILON = 0.0001; // matches the backend's ROUND_DECIMALS precision

function coordsMatch(lat1, lng1, lat2, lng2) {

    return Math.abs(lat1 - lat2) < COORD_MATCH_EPSILON && Math.abs(lng1 - lng2) < COORD_MATCH_EPSILON;
}


function renderPathSelectForTripVehicle() {

    const select = document.getElementById("path-select");
    const hint = document.getElementById("path-select-hint");

    const previousValue = select.value;
    const vehicle = vehiclesById.get(selectedTripVehicleId);

    select.innerHTML = '<option value="">Select a path...</option>';

    if (!vehicle) {

        select.disabled = true;
        hint.style.display = "none";

        updateStartTripVisibility();
        return;
    }

    select.disabled = false;

    const matching = [...pathsById.values()].filter((path) =>
        coordsMatch(path.origin_lat, path.origin_lng, vehicle.current_lat, vehicle.current_lng)
    );

    for (const path of matching) {

        const option = document.createElement("option");

        option.value = path.id;
        option.textContent = pathLabel(path);

        select.appendChild(option);
    }

    if (matching.some((path) => String(path.id) === previousValue)) {
        select.value = previousValue;
    }

    hint.style.display = matching.length === 0 ? "" : "none";
    hint.textContent = `No paths from ${vehicle.current_location} yet - create one in the Paths tab.`;

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
    // A driving vehicle gets its own live marker below - drop any resting
    // dot left over from a previously clicked non-driving vehicle.
    //
    clearRestingVehicleMarker();

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

    const spec = vehicle ? vehicle.spec : null;

    details.innerHTML =
        `<b>${vehicle ? vehicle.name : trip.vehicle_name}</b><br>` +
        (spec
            ? `Spec: ${specLabel(spec)}<br>` +
              `Capacity: ${spec.person_capacity} people, ${spec.cargo_capacity_cuft} cu ft cargo<br>` +
              `Cost: $${Math.round(spec.cost).toLocaleString()} &middot; ${spec.mpg} mpg<br>`
            : "") +
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

    const specId = document.getElementById("vehicle-spec-select").value;

    if (!specId) {
        alert("Add a hauling spec first");
        return;
    }

    const response = await fetch(API + "/api/vehicles", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            name: document.getElementById("vehicle-name").value,

            spec_id: Number(specId),

            current_location: document.getElementById("vehicle-location").value,

            starting_mileage: Number(document.getElementById("vehicle-starting-mileage").value || 0)

        })

    });

    const data = await response.json();

    if (!response.ok) {
        alert(data.detail || "Could not add vehicle");
        return;
    }

    loadVehicles();
}


function pathLabel(path) {

    return `${path.origin}-${path.destination}`;
}


//
// distances_miles is cumulative miles from the origin at every route
// point (see road_route() in app.py) - its last entry is the path's
// total distance, not a separately stored value.
//
function pathDistanceMiles(path) {

    return path.distances_miles[path.distances_miles.length - 1];
}


async function loadPaths() {

    const response = await fetch(API + "/api/paths");
    const paths = await response.json();

    pathsById = new Map(paths.map((path) => [path.id, path]));

    renderPathList();
    renderPathSelectForTripVehicle();
}


function renderPathList() {

    const list = document.getElementById("path-list");

    list.innerHTML = "";

    for (const path of pathsById.values()) {

        const item = document.createElement("div");

        item.className = "vehicle-item list-row";
        item.onclick = () => previewPath(path);

        item.innerHTML =
            `<span>${pathLabel(path)} <span class="path-distance">(${Math.round(pathDistanceMiles(path))} mi)</span></span>` +
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
        selectedSection = null;

        resetZoneDraw();
        clearRouteSections();

        document.getElementById("zone-form").style.display = "none";
        document.getElementById("zone-editor").style.display = "none";
    }

    loadPaths();
}


function roadTier(freeFlowMph) {

    if (freeFlowMph >= INTERSTATE_MIN_MPH) {
        return "interstate";
    }

    if (freeFlowMph >= ARTERIAL_MIN_MPH) {
        return "arterial";
    }

    return "local";
}


function zoneAtMiles(zones, positionMiles) {

    for (const zone of zones || []) {
        if (zone.start_miles <= positionMiles && positionMiles < zone.end_miles) {
            return zone;
        }
    }

    return null;
}


function segmentSpeedLimitMph(path, segmentIndex) {

    //
    // Same override rule as the backend's segment_speed_mph(): a zone
    // covering this segment replaces the road entirely, otherwise fall
    // back to OSRM's reported speed floored by the tier default.
    //
    const zone = zoneAtMiles(path.zones, path.distances_miles[segmentIndex]);

    if (zone) {
        return zone.speed_limit_mph;
    }

    const reported = Math.max(
        MIN_REALISTIC_SPEED_MPH,
        Math.min(MAX_REALISTIC_SPEED_MPH, path.max_speeds_mph[segmentIndex])
    );

    return Math.max(reported, TIER_DEFAULT_MPH[roadTier(reported)]);
}


function speedOverlayColor(mph) {

    if (mph >= 65) {
        return "#2f9e44";
    }

    if (mph >= 45) {
        return "#f08c00";
    }

    return "#e03131";
}


//
// The whole route is split into clickable "sections" - each one either an
// existing road_zone (its exact start/end) or a run of consecutive segments
// sharing the same non-zoned speed color. Every section shows its effective
// speed limit (zone override or tier default), so the whole road is visible
// and editable, not just stretches that already have a zone.
//
function buildRouteSections(path) {

    const sections = [];
    const segmentCount = path.max_speeds_mph.length;

    if (segmentCount === 0) {
        return sections;
    }

    const sectionAt = (i) => {

        const zone = zoneAtMiles(path.zones, path.distances_miles[i]);

        return {
            zone,
            mph: zone ? zone.speed_limit_mph : segmentSpeedLimitMph(path, i),
            key: zone ? `zone:${zone.id}` : `tier:${speedOverlayColor(segmentSpeedLimitMph(path, i))}`
        };
    };

    let runStart = 0;
    let run = sectionAt(0);

    for (let i = 1; i <= segmentCount; i++) {

        const current = i < segmentCount ? sectionAt(i) : null;

        if (!current || current.key !== run.key) {

            sections.push({

                startIndex: runStart,

                endIndex: i,

                startMiles: path.distances_miles[runStart],

                endMiles: path.distances_miles[i],

                speedLimitMph: run.mph,

                zone: run.zone
            });

            runStart = i;
            run = current;
        }
    }

    return sections;
}


let zoneDraftPath = null;    // path currently shown in the zone editor
let zoneDraftPoints = [];    // cumulative-miles values of picked points (0-2 of them), for "Draw a zone"
let zoneDraftMarkers = [];   // Leaflet markers for the picked points
let zoneDrawArmed = false;   // true while waiting for the next map click to pick a point
let routeSectionLines = [];  // every drawn Leaflet polyline for the current path's sections
let selectedSection = null;  // { zoneId: number|null, startMiles, endMiles } loaded into the edit form


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


function clearRouteSections() {

    for (const line of routeSectionLines) {
        map.removeLayer(line);
    }

    routeSectionLines = [];
}


function sectionIsSelected(section) {

    if (!selectedSection) {
        return false;
    }

    if (selectedSection.zoneId !== null) {
        return section.zone !== null && section.zone.id === selectedSection.zoneId;
    }

    return section.zone === null
        && Math.abs(section.startMiles - selectedSection.startMiles) < 1e-6
        && Math.abs(section.endMiles - selectedSection.endMiles) < 1e-6;
}


//
// The visible line is much thinner than a comfortable click target,
// especially for short zones - so each section also gets an invisible,
// much wider "hit" line stacked on top of it purely to catch clicks
// (Leaflet's default CSS gives interactive vector layers
// `pointer-events: auto`, so a zero-opacity stroke still registers
// clicks across its full weight).
//
const SECTION_CLICK_WEIGHT = 24;


function renderRouteSections(path) {

    clearRouteSections();

    let selectedLine = null;

    for (const section of buildRouteSections(path)) {

        const selected = sectionIsSelected(section);
        const points = path.route.slice(section.startIndex, section.endIndex + 1);

        //
        // While "Draw a custom zone" is armed, a section's own click
        // shouldn't fire - the click still needs to bubble up to the map's
        // click handler below, which is what actually places draft points.
        //
        const onClick = () => {

            if (zoneDrawArmed) {
                return;
            }

            selectSection(path, section);
        };

        const lineWeight = selected ? 8 : (section.zone ? 6 : 4);

        //
        // A custom zone's color alone can coincidentally match the tier
        // color of the plain road right next to it (e.g. a 50mph zone
        // butting up against a 50mph arterial default), so weight/dash
        // alone can be too subtle to notice at a glance. A dark casing
        // drawn underneath - wider than the zone's own line, so only its
        // edges peek out - makes any custom zone unmistakable regardless
        // of what color it happens to render in.
        //
        if (section.zone) {

            routeSectionLines.push(L.polyline(points, {

                color: "#1a1a1a",

                weight: lineWeight + 5,

                opacity: 0.9

            }).addTo(map));
        }

        const line = L.polyline(points, {

            color: selected ? "#c92a2a" : speedOverlayColor(section.speedLimitMph),

            weight: lineWeight,

            dashArray: section.zone ? null : "6 4",

            opacity: selected ? 0.95 : 0.85

        }).addTo(map);

        const hitLine = L.polyline(points, {

            weight: SECTION_CLICK_WEIGHT,

            opacity: 0

        }).addTo(map);

        line.on("click", onClick);
        hitLine.on("click", onClick);

        routeSectionLines.push(line, hitLine);

        if (selected) {
            selectedLine = line;
        }
    }

    //
    // Drawn last so the highlighted section renders on top of any
    // overlapping neighbor.
    //
    if (selectedLine) {
        selectedLine.bringToFront();
    }
}


function fillZoneForm(values) {

    document.getElementById("zone-range-label").textContent =
        `mile ${values.startMiles.toFixed(1)} - ${values.endMiles.toFixed(1)}`;

    document.getElementById("zone-speed").value = Math.round(values.speedLimitMph);
    document.getElementById("zone-rush-start").value = values.rushHourStart ?? "";
    document.getElementById("zone-rush-end").value = values.rushHourEnd ?? "";
    document.getElementById("zone-rush-factor").value = values.rushHourFactor;

    document.getElementById("zone-delete-button").style.display =
        selectedSection.zoneId !== null ? "" : "none";

    document.getElementById("zone-draw-hint").style.display = "none";
    document.getElementById("zone-form").style.display = "";
}


function selectZoneObject(path, zone) {

    selectedSection = { zoneId: zone.id, startMiles: zone.start_miles, endMiles: zone.end_miles };

    fillZoneForm({

        startMiles: zone.start_miles,

        endMiles: zone.end_miles,

        speedLimitMph: zone.speed_limit_mph,

        rushHourStart: zone.rush_hour_start,

        rushHourEnd: zone.rush_hour_end,

        rushHourFactor: zone.rush_hour_factor
    });

    renderRouteSections(path);
    renderZoneList(path);
}


function selectFreshSection(path, startMiles, endMiles, defaultSpeedMph) {

    selectedSection = { zoneId: null, startMiles, endMiles };

    fillZoneForm({

        startMiles,

        endMiles,

        speedLimitMph: defaultSpeedMph,

        rushHourStart: null,

        rushHourEnd: null,

        rushHourFactor: 0.6
    });

    renderRouteSections(path);
    renderZoneList(path);
}


function selectSection(path, section) {

    if (section.zone) {
        selectZoneObject(path, section.zone);
    } else {
        selectFreshSection(path, section.startMiles, section.endMiles, section.speedLimitMph);
    }
}


function renderZoneList(path) {

    const list = document.getElementById("zone-list");

    list.innerHTML = "";

    for (const zone of path.zones || []) {

        const item = document.createElement("div");

        const selected = selectedSection && selectedSection.zoneId === zone.id;

        item.className = "vehicle-item list-row" + (selected ? " selected" : "");
        item.style.cursor = "pointer";
        item.onclick = () => selectZoneObject(path, zone);

        item.innerHTML =
            `<span>${zoneSummary(zone)}</span>` +
            `<button class="remove-zone-button" data-id="${zone.id}">Delete</button>`;

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".remove-zone-button")) {

        button.onclick = (event) => {
            event.stopPropagation();
            removeZone(Number(button.dataset.id));
        };
    }
}


function resetZoneDraw() {

    zoneDrawArmed = false;
    zoneDraftPoints = [];

    for (const marker of zoneDraftMarkers) {
        map.removeLayer(marker);
    }

    zoneDraftMarkers = [];

    document.getElementById("zone-draw-hint").style.display = "none";
}


function renderZoneEditor(path) {

    zoneDraftPath = path;
    selectedSection = null;

    resetZoneDraw();

    document.getElementById("zone-form").style.display = "none";
    document.getElementById("zone-editor").style.display = "";
    document.getElementById("zone-editor-path-label").textContent =
        `${pathLabel(path)} (${Math.round(pathDistanceMiles(path))} mi)`;

    renderRouteSections(path);
    renderZoneList(path);
}


function startZoneDraw() {

    selectedSection = null;

    resetZoneDraw();

    zoneDrawArmed = true;

    document.getElementById("zone-draw-hint").style.display = "";
    document.getElementById("zone-form").style.display = "none";

    renderRouteSections(zoneDraftPath);
}


function cancelZoneForm() {

    selectedSection = null;

    resetZoneDraw();

    document.getElementById("zone-form").style.display = "none";

    renderRouteSections(zoneDraftPath);
    renderZoneList(zoneDraftPath);
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

        const [a, b] = zoneDraftPoints;

        zoneDrawArmed = false;

        document.getElementById("zone-draw-hint").style.display = "none";

        for (const marker of zoneDraftMarkers) {
            map.removeLayer(marker);
        }

        zoneDraftMarkers = [];

        selectFreshSection(zoneDraftPath, Math.min(a, b), Math.max(a, b), 35);
    }
});


async function saveZone() {

    const rushStartRaw = document.getElementById("zone-rush-start").value;
    const rushEndRaw = document.getElementById("zone-rush-end").value;

    const url = selectedSection.zoneId !== null
        ? API + "/api/zones/" + selectedSection.zoneId
        : API + "/api/paths/" + zoneDraftPath.id + "/zones";

    const method = selectedSection.zoneId !== null ? "PUT" : "POST";

    const response = await fetch(url, {

        method,

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            start_miles: selectedSection.startMiles,

            end_miles: selectedSection.endMiles,

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

    selectedSection = { zoneId: data.id, startMiles: data.start_miles, endMiles: data.end_miles };

    //
    // Whether this save created a fresh zone or updated an existing one,
    // the section now definitely corresponds to a real zone - show the
    // delete button even if this was just created (fillZoneForm() only
    // ran with zoneId still null, before the save completed).
    //
    document.getElementById("zone-delete-button").style.display = "";

    await loadPaths();

    const refreshed = pathsById.get(pathId);

    if (refreshed) {

        zoneDraftPath = refreshed;

        renderRouteSections(refreshed);
        renderZoneList(refreshed);
    }
}


function deleteSelectedZone() {

    if (selectedSection && selectedSection.zoneId !== null) {
        removeZone(selectedSection.zoneId);
    }
}


async function removeZone(zoneId) {

    if (!confirm("Delete this zone?")) {
        return;
    }

    const pathId = zoneDraftPath.id;

    if (selectedSection && selectedSection.zoneId === zoneId) {
        selectedSection = null;
        document.getElementById("zone-form").style.display = "none";
    }

    await fetch(API + "/api/zones/" + zoneId, { method: "DELETE" });

    await loadPaths();

    const refreshed = pathsById.get(pathId);

    if (refreshed) {

        zoneDraftPath = refreshed;

        renderRouteSections(refreshed);
        renderZoneList(refreshed);
    }
}


function previewPath(path) {

    if (selectedVehicleId !== null) {
        selectedVehicleId = null;
        renderInRouteList();
        renderVehicleList();
    }

    map.fitBounds(L.latLngBounds(path.route));

    renderZoneEditor(path);
}


function swapOriginDestination() {

    const originInput = document.getElementById("origin");
    const destinationInput = document.getElementById("destination");

    const temp = originInput.value;
    originInput.value = destinationInput.value;
    destinationInput.value = temp;
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

    //
    // Keeps each vehicle's displayed odometer (starting_mileage + its
    // settled total + whatever it's covered on its current trip so far)
    // ticking up live while driving, not just once the trip arrives.
    //
    renderVehicleList();
    renderAllVehicleList();

    updateTimeMultiplierControlState();

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


//
// Mirrors the backend's is_rush_hour() (app.py): weekday, and either
// 7-9am or 4-6pm. `gameDate` was built by parseGameTime()/updateSimClock()
// treating the naive game-time digits as UTC, so timeZone: "UTC" here
// reads those same digits back out rather than converting through the
// browser's own timezone. hourCycle: "h23" avoids Intl's well-known
// quirk of formatting midnight as hour "24" instead of "0".
//
function isRushHour(gameDate) {

    const parts = new Intl.DateTimeFormat("en-US", {

        timeZone: "UTC",

        weekday: "short",

        hour: "numeric",

        hourCycle: "h23"

    }).formatToParts(gameDate);

    const weekday = parts.find((part) => part.type === "weekday").value;
    const hour = Number(parts.find((part) => part.type === "hour").value);

    const isWeekday = weekday !== "Sat" && weekday !== "Sun";

    return isWeekday && ((hour >= 7 && hour < 9) || (hour >= 16 && hour < 18));
}


function updateSimClock() {

    const clockText = document.getElementById("sim-clock-text");

    if (!gameClockAnchor) {
        clockText.textContent = "Loading game clock...";
        return;
    }

    //
    // Extrapolate forward from the last GET /api/settings fetch rather
    // than fetching every tick - 1 real ms since that fetch is
    // `multiplier` game ms.
    //
    const elapsedRealMs = Date.now() - gameClockAnchor.realTimeMs;
    const gameDate = new Date(gameClockAnchor.gameTimeMs + elapsedRealMs * gameClockAnchor.multiplier);

    const formatted = new Intl.DateTimeFormat("en-US", {

        timeZone: "UTC",

        weekday: "long",

        hour: "numeric",

        minute: "2-digit",

        hour12: true

    }).format(gameDate);

    clockText.innerHTML =
        formatted + (isRushHour(gameDate) ? ' <span class="rush-badge">Rush Hour</span>' : "");
}


loadSpecs().then(loadVehicles);
loadPaths();

loadSettings();

setInterval(pollActiveTrips, 1000);

setInterval(updateSimClock, 1000);

//
// Re-syncs against the backend's own anchor every few seconds, correcting
// for client clock drift and picking up a multiplier change made from
// another browser/tab - the 1s updateSimClock() tick above just
// extrapolates smoothly between these refreshes.
//
setInterval(loadSettings, 5000);

setInterval(() => {

    if (selectedVehicleId !== null) {
        fetchCurrentCity();
    }

}, 7000);
