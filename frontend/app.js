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

    updateAutoRefuelToggle(settings.auto_refuel_level);

    updateSimClock();
}


//
// Auto-refuel is stored as a level (settings.auto_refuel_level, 0 = off)
// so it can become an upgradeable perk later - for now the UI only exposes
// it as an on/off checkbox, where "on" means level 1.
//
function updateAutoRefuelToggle(level) {

    document.getElementById("auto-refuel-toggle").checked = level > 0;
}


async function setAutoRefuel(checkbox) {

    checkbox.disabled = true;

    try {

        const response = await fetch(API + "/api/settings", {

            method: "PUT",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({ auto_refuel_level: checkbox.checked ? 1 : 0 })

        });

        const data = await response.json();

        if (!response.ok) {
            alert(data.detail || "Could not update auto-refuel");
            checkbox.checked = !checkbox.checked;
            return;
        }

        updateAutoRefuelToggle(data.auto_refuel_level);

    } finally {
        checkbox.disabled = false;
    }
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
let vehicleModelsById = new Map();         // vehicle_model_id -> vehicle model (from GET /api/vehicle-models)
let pathsById = new Map();         // path_id -> path (from GET /api/paths)
let vehiclesById = new Map();      // vehicle_id -> vehicle - current fleet, not sold (from GET /api/vehicles)
let placesById = new Map();        // place_id -> place (from GET /api/places)
let activeTripsById = new Map();   // vehicle_id -> trip (from the last poll)
let activeVehicleIds = new Set();  // vehicle ids seen on the last poll
let selectedVehicleId = null;      // vehicle id followed in the In Route tab
let selectedTripVehicleId = null;  // vehicle id chosen (in the Vehicles tab) to start a trip
let selectedVehicleModelId = null;         // vehicle model id highlighted in the Vehicle Models tab (purely visual, no map focus)
let selectedPlaceId = null;        // place id focused in the Places tab
let selectedPathId = null;         // path id currently previewed in the Paths tab

//
// Set by createPath() when it was reached via a vehicle's "create one in
// the Paths tab" hint (see renderPathSelectForTripVehicle()), so the Paths
// tab can offer a way back to that vehicle once the new path exists -
// previewPath() (which createPath() calls right after creating one) clears
// selectedTripVehicleId via clearFocus(), so this is the only place that
// remembers where the user came from. null means "didn't come from a
// vehicle", not just "no path created yet" - cleared by clearFocus() itself
// so it doesn't linger past whatever focus change happens next.
//
let pathCreatedFromVehicleId = null;

//
// Set alongside the Origin field whenever it's prefilled from a selected
// vehicle's own place (showTab()'s vehicle-aware branch below), so
// createPath() can send it straight through as origin_place_id instead of
// re-geocoding whatever text ends up in the box. Re-geocoding a vehicle's
// own already-resolved address was a real bug: Nominatim doesn't reliably
// return the exact same coordinates for the same query twice, so the new
// path's origin could land a hair outside ROUND_DECIMALS of the vehicle's
// actual place - a near-duplicate place a few meters off, invisible to
// coordsMatch() and so never offered as a path that vehicle can take.
// Cleared the moment the user edits Origin by hand (see the "input"
// listener near the bottom of this file), since at that point whatever
// they're typing may no longer describe that vehicle's place at all.
//
let originPlaceId = null;

//
// Places tab's continent/country/state/city filter (see renderPlaceFilterChips()
// below) - null at a level means "no filter chosen there yet". Persists across
// re-renders (a poll tick, adding/removing a place) so the chosen chips don't
// reset out from under the user; only cleared by clicking an active chip again.
//
const PLACE_FILTER_LEVELS = ["continent", "country", "state", "city"];
let placesFilter = { continent: null, country: null, state: null, city: null };
let restingVehicleMarker = null;   // dot marking a clicked non-driving vehicle's resting location
let placeMarker = null;            // dot marking a clicked place's location

let gasPricesByPlaceId = new Map(); // place_id -> gas price row (from GET /api/gas-prices)
const gasPriceMarkers = new Map();  // place_id -> persistent Leaflet circleMarker (the map overlay itself)
let gasPriceOverlayVisible = true;  // toggled by the gas pump icon floating over the map

//
// preferCanvas: true draws vector layers (the gas price circleMarkers - one
// per gas station, potentially thousands after a bulk/city upload) onto a
// single shared <canvas> instead of one SVG DOM node each. SVG per-marker
// is fine at dozens/hundreds of markers but bogs down badly at thousands -
// both the initial render and every pan/zoom afterward, since the browser
// has to manage that many DOM nodes. Canvas keeps tooltip/click
// interactivity (Leaflet hit-tests canvas layers itself), it's just no
// longer one element per marker.
//
// Create the map
map = L.map("map", { preferCanvas: true }).setView([44.977, -93.265], 6);

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


//
// Same idea as showRestingVehicleMarker(), a different color so a place pin
// doesn't get mistaken for a vehicle sitting there.
//
function showPlaceMarker(place) {

    clearPlaceMarker();

    placeMarker = L.circleMarker([place.lat, place.lng], {

        radius: 8,
        color: "#f08c00",
        weight: 2,
        fillColor: "#f08c00",
        fillOpacity: 1

    }).addTo(map);

    placeMarker.bindTooltip(place.description, { direction: "top", offset: [0, -10] });
}


function clearPlaceMarker() {

    if (placeMarker) {
        map.removeLayer(placeMarker);
        placeMarker = null;
    }
}


//
// Vehicles (In Route follow), vehicles (trip-start pick), paths (zone
// editor preview), and places all compete for the same map focus -
// clicking any one of them should drop whatever the others had selected,
// rather than leaving e.g. a followed driving vehicle still yanking the
// view back every poll tick while a place is being looked at. Every click
// entry point below calls this first, then applies its own selection on
// top. Re-renders the place list too, since unlike the others its
// "selected" highlight has no other trigger to refresh it when cleared
// from here.
//
function clearFocus() {

    selectedVehicleId = null;
    selectedTripVehicleId = null;
    selectedPlaceId = null;
    pathCreatedFromVehicleId = null;

    clearRestingVehicleMarker();
    clearPlaceMarker();

    renderPlaceList();
}


function renderFocusDependentViews() {

    renderVehicleList();
    renderPathSelectForTripVehicle();
    renderBackToVehicleHint();
}


//
// Generic click-to-spinner wrapper for every button in the app: disables
// the button and shows a spinner (see button.spinning in index.html) for
// as long as fn takes to settle, sync or async alike. Promise.resolve()
// .then(fn) defers the call to a microtask, so a purely synchronous fn
// resolves before the browser ever paints the spinning class - no flash
// for instant actions like tab switches, only for ones that actually wait
// on a fetch.
//
function withSpinner(button, fn) {

    button.classList.add("spinning");
    button.disabled = true;

    return Promise.resolve()
        .then(fn)
        .finally(() => {
            button.classList.remove("spinning");
            button.disabled = false;
        });
}


//
// Endpoints that need to geocode a free-text place (creating a path,
// uploading a batch of gas prices) hand back a job id instead of blocking
// on the result - see job_executor in app.py. This polls GET
// /api/jobs/{id} until the backend marks it done/error, optionally
// reporting progress (progress_current/progress_total) back to the
// caller via onProgress so a big upload can show a running count.
//
async function pollJob(jobId, onProgress) {

    for (;;) {

        const response = await fetch(API + "/api/jobs/" + jobId);
        const job = await response.json();

        if (!response.ok) {
            throw new Error(job.detail || "Could not check job status");
        }

        if (onProgress) {
            onProgress(job);
        }

        if (job.status === "done") {
            return job.result;
        }

        if (job.status === "error") {
            throw new Error(job.error || "Job failed");
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}


//
// Background Jobs tab - a generic status view over the jobs table (see
// job_executor/GET /api/jobs in app.py), rather than one bespoke view per
// job type. Polled on the same always-on timer as the rest of the app's
// live data (see the setInterval calls at the bottom of this file), so it
// stays current whether or not the tab is the one currently showing.
//
const JOB_STATUS_COLORS = {
    pending: "#868e96",
    running: "#1c7ed6",
    done: "#2f9e44",
    error: "#e03131"
};


function prettyJobType(jobType) {

    return jobType
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}


async function loadJobs() {

    const response = await fetch(API + "/api/jobs");
    const data = await response.json();

    renderJobsSummary(data);
    renderJobsList(data.jobs);
}


function renderJobsSummary(data) {

    document.getElementById("jobs-summary").textContent =
        `${data.running}/${data.workers_max} workers busy - ${data.queued} queued`;
}


function renderJobsList(jobs) {

    const list = document.getElementById("jobs-list");

    list.innerHTML = "";

    for (const job of jobs) {

        const item = document.createElement("div");

        item.className = "vehicle-item list-row";

        const progress = job.progress_total > 0
            ? `${job.progress_current}/${job.progress_total} - `
            : "";

        // job.created/updated are ISO strings with an explicit UTC offset
        // (see list_jobs() in app.py) - toLocaleString with timeZoneName
        // shown converts that to the viewer's own local time rather than
        // silently mislabeling it, and spells out which zone that is.
        const started = new Date(job.created).toLocaleString(undefined, { timeZoneName: "short" });
        const updated = new Date(job.updated).toLocaleString(undefined, { timeZoneName: "short" });

        const errorLine = job.error
            ? `<div class="list-item-details" style="color:#e03131;">${job.error}</div>`
            : "";

        item.innerHTML =
            `<span class="list-item-label"><span>#${job.id} ${prettyJobType(job.job_type)}` +
            `<div class="list-item-details">${progress}started ${started} - updated ${updated}</div>` +
            errorLine +
            `</span></span>` +
            `<span style="color:${JOB_STATUS_COLORS[job.status] || "#333"};font-weight:bold;">${job.status}</span>`;

        list.appendChild(item);
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


//
// The tab bar collapses into a dropdown (too many tabs to fit as a row in
// the 280px sidebar) - this is its label text, keyed the same way as the
// tab/tab-button element ids showTab() below already toggles "active" on.
//
const TAB_LABELS = {
    vehiclemodels: "Vehicle Models",
    places: "Places",
    myvehicles: "My Vehicles",
    paths: "Paths",
    gasprices: "Gas Prices",
    jobs: "Background Jobs"
};


function toggleTabMenu() {

    document.getElementById("tab-menu").classList.toggle("open");
}


function closeTabMenu() {

    document.getElementById("tab-menu").classList.remove("open");
}


//
// Clicking anywhere outside the open dropdown closes it, the usual
// expectation for this kind of menu - a click on the toggle button or an
// item inside the list is still "inside" tab-menu, so this only fires for
// a genuine click elsewhere (the map, another panel).
//
document.addEventListener("click", (event) => {

    const menu = document.getElementById("tab-menu");

    if (menu.classList.contains("open") && !menu.contains(event.target)) {
        closeTabMenu();
    }
});


//
// Typing over a vehicle-prefilled Origin means the user wants a different
// starting point than that vehicle's own place - drop originPlaceId so
// createPath() falls back to geocoding whatever's actually in the box,
// instead of silently ignoring the edit and creating a path from the
// vehicle's place anyway. Setting .value from JS (as showTab()/
// fillOriginWithFullAddress() both do) doesn't fire "input", so this only
// reacts to genuine typing.
//
document.getElementById("origin").addEventListener("input", () => {
    originPlaceId = null;
});


function showTab(tab) {

    for (const name of ["vehiclemodels", "places", "myvehicles", "paths", "gasprices", "jobs"]) {

        document.getElementById(`tab-${name}`).classList.toggle("active", name === tab);
        document.getElementById(`tab-button-${name}`).classList.toggle("active", name === tab);
    }

    document.getElementById("tab-menu-current").textContent = TAB_LABELS[tab];
    closeTabMenu();

    //
    // Jumping to Paths with a vehicle focused (selectedVehicleId/
    // selectedTripVehicleId - clearFocus() keeps these mutually exclusive)
    // most likely means "make a path starting from that vehicle", so
    // default Origin to where it is rather than leaving whatever was
    // typed there before.
    //
    if (tab === "paths") {

        const vehicle = vehiclesById.get(selectedVehicleId !== null ? selectedVehicleId : selectedTripVehicleId);

        if (vehicle) {

            // current_location is just a city name, which is ambiguous
            // between same-named cities in different states - fill it in
            // right away so Origin isn't left blank, then swap in the full
            // street address once it resolves (reverse-geocoding is rate
            // limited on the backend, so this can take a moment). Either
            // way, origin_place_id (set below) is what actually determines
            // where the path starts from - this text is just what the user
            // sees.
            document.getElementById("origin").value = vehicle.current_location;
            originPlaceId = vehicle.place_id;

            fillOriginWithFullAddress(vehicle.id);

        } else {

            originPlaceId = null;
        }
    }
}


async function fillOriginWithFullAddress(vehicleId) {

    const response = await fetch(API + "/api/vehicles/" + vehicleId + "/address");

    if (!response.ok) {
        return;
    }

    const data = await response.json();

    //
    // Ignore a stale response if the user switched tabs or vehicles, or
    // edited Origin by hand, while this was in flight.
    //
    const stillFocused = vehicleId === (selectedVehicleId !== null ? selectedVehicleId : selectedTripVehicleId);
    const origin = document.getElementById("origin");

    if (stillFocused && document.getElementById("tab-paths").classList.contains("active")
        && origin.value === vehiclesById.get(vehicleId).current_location) {

        origin.value = data.address;
    }
}


//
// Vehicle models are served by the backend as a filename (e.g. "2026-Chevy-Express.png"),
// not a URL - the frontend is what knows it's serving frontend/images/ at its
// own origin (same host/port index.html was loaded from), so this is a plain
// relative path rather than going through the API host/port.
//
function vehicleModelImageUrl(filename) {

    return filename ? `images/${encodeURIComponent(filename)}` : null;
}


function vehicleModelLabel(vehicleModel) {

    return `${vehicleModel.year} ${vehicleModel.brand} ${vehicleModel.model}`;
}


async function loadVehicleModels() {

    const response = await fetch(API + "/api/vehicle-models");
    const vehicleModels = await response.json();

    vehicleModelsById = new Map(vehicleModels.map((vehicleModel) => [vehicleModel.id, vehicleModel]));

    const select = document.getElementById("vehicle-model-select");
    const previousValue = select.value;

    select.innerHTML = vehicleModels.length
        ? ""
        : '<option value="">No vehicle models yet - add one below</option>';

    for (const vehicleModel of vehicleModels) {

        const option = document.createElement("option");

        option.value = vehicleModel.id;
        option.textContent = vehicleModelLabel(vehicleModel);

        select.appendChild(option);
    }

    if (vehicleModels.some((vehicleModel) => String(vehicleModel.id) === previousValue)) {
        select.value = previousValue;
    }

    renderVehicleList();
    renderVehicleModelList();
}


function renderVehicleModelList() {

    const list = document.getElementById("vehicle-model-list");

    list.innerHTML = "";

    for (const vehicleModel of vehicleModelsById.values()) {

        const item = document.createElement("div");

        item.className = "vehicle-item list-row" + (vehicleModel.id === selectedVehicleModelId ? " selected" : "");
        item.onclick = () => selectVehicleModel(vehicleModel.id);

        const imageUrl = vehicleModelImageUrl(vehicleModel.image);

        item.innerHTML =
            `<span class="list-item-label">` +
            (imageUrl ? `<img class="list-item-thumb" src="${imageUrl}">` : "") +
            `<span>${vehicleModelLabel(vehicleModel)}` +
            `<div class="list-item-details">` +
            `${vehicleModel.person_capacity} people &middot; ${vehicleModel.cargo_capacity_cuft} cu ft &middot; ` +
            `$${Math.round(vehicleModel.cost).toLocaleString()} &middot; ${vehicleModel.mpg} mpg &middot; ` +
            `${vehicleModel.fuel_tank_gallons} gal tank` +
            `</div></span></span>` +
            `<button class="remove-vehicle-model-button" data-id="${vehicleModel.id}">Delete</button>`;

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".remove-vehicle-model-button")) {

        button.onclick = (event) => {
            event.stopPropagation();
            withSpinner(button, () => removeVehicleModel(Number(button.dataset.id)));
        };
    }
}


//
// Clicking a vehicle model just highlights it (click again to clear) - purely
// a visual focus like the Places tab's own selection, not tied to the map
// (a vehicle model has no location).
//
function selectVehicleModel(vehicleModelId) {

    selectedVehicleModelId = selectedVehicleModelId === vehicleModelId ? null : vehicleModelId;

    renderVehicleModelList();
}


async function addVehicleModel() {

    const response = await fetch(API + "/api/vehicle-models", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            year: Number(document.getElementById("vehicle-model-year").value),

            brand: document.getElementById("vehicle-model-brand").value,

            model: document.getElementById("vehicle-model-model").value,

            person_capacity: Number(document.getElementById("vehicle-model-person-capacity").value),

            cargo_capacity_cuft: Number(document.getElementById("vehicle-model-cargo-capacity").value),

            cost: Number(document.getElementById("vehicle-model-cost").value),

            mpg: Number(document.getElementById("vehicle-model-mpg").value),

            fuel_tank_gallons: Number(document.getElementById("vehicle-model-fuel-tank").value),

            image: document.getElementById("vehicle-model-image").value || null

        })

    });

    const data = await response.json();

    if (!response.ok) {
        alert(data.detail || "Could not add vehicle model");
        return;
    }

    loadVehicleModels();
}


async function removeVehicleModel(vehicleModelId) {

    const vehicleModel = vehicleModelsById.get(vehicleModelId);

    if (!confirm(`Delete vehicle model "${vehicleModel ? vehicleModelLabel(vehicleModel) : vehicleModelId}"?`)) {
        return;
    }

    const response = await fetch(API + "/api/vehicle-models/" + vehicleModelId, { method: "DELETE" });

    if (!response.ok) {

        const data = await response.json();
        alert(data.detail || "Could not delete vehicle model");
        return;
    }

    if (selectedVehicleModelId === vehicleModelId) {
        selectedVehicleModelId = null;
    }

    loadVehicleModels();
}


async function loadPlaces() {

    const response = await fetch(API + "/api/places");
    const places = await response.json();

    placesById = new Map(places.map((place) => [place.id, place]));

    //
    // A plain <datalist>, not a <select> - every free-text location box
    // (vehicle starting location, path origin/destination) keeps accepting
    // a brand-new description, this just suggests ones already saved.
    //
    const datalist = document.getElementById("places-list");

    datalist.innerHTML = places
        .map((place) => `<option value="${place.description}">${place.address}</option>`)
        .join("");

    renderPlaceList();
}


//
// Adds/updates one place in local state without re-fetching the full
// places list - at tens of thousands of saved places that list is
// multiple megabytes, and a single-row action (adding one gas price,
// adding one vehicle) shouldn't cost re-downloading and re-parsing all of
// it just to make sure that one row is known. Only appends a new
// <option> when the place is genuinely new (not already in placesById),
// so re-saving an existing place's price doesn't pile up duplicate
// datalist entries.
//
function patchPlaceLocally(place) {

    const isNew = !placesById.has(place.id);

    placesById.set(place.id, place);

    if (isNew) {

        const option = document.createElement("option");
        option.value = place.description;
        option.textContent = place.address;

        document.getElementById("places-list").appendChild(option);
    }

    renderPlaceList();
}


//
// A place matches up to (but not including) levelIndex when every filter
// level *before* it either isn't set or matches this place - i.e. "is this
// place still a valid candidate for picking a value at levelIndex", not "does
// it match levelIndex's own filter too". That's what lets the chip row for a
// level keep showing every sibling value (so you can jump straight from one
// country to another) instead of only the one currently selected there.
//
function placeMatchesFiltersUpTo(place, levelIndex) {

    for (let i = 0; i < levelIndex; i++) {

        const level = PLACE_FILTER_LEVELS[i];

        if (placesFilter[level] !== null && place[level] !== placesFilter[level]) {
            return false;
        }
    }

    return true;
}


function placePassesAllFilters(place) {
    return placeMatchesFiltersUpTo(place, PLACE_FILTER_LEVELS.length);
}


function distinctValuesAtLevel(levelIndex) {

    const level = PLACE_FILTER_LEVELS[levelIndex];
    const values = new Set();

    for (const place of placesById.values()) {

        if (place[level] && placeMatchesFiltersUpTo(place, levelIndex)) {
            values.add(place[level]);
        }
    }

    return [...values].sort();
}


//
// If a place backing the currently-selected chip at some level disappeared
// (deleted, or a filter above it just changed to something incompatible),
// that level - and everything below it, since their candidates depend on
// it - falls back to "not filtered" instead of silently showing an empty
// list with no obvious way out.
//
function sanitizePlacesFilter() {

    PLACE_FILTER_LEVELS.forEach((level, levelIndex) => {

        if (placesFilter[level] !== null && !distinctValuesAtLevel(levelIndex).includes(placesFilter[level])) {

            for (let i = levelIndex; i < PLACE_FILTER_LEVELS.length; i++) {
                placesFilter[PLACE_FILTER_LEVELS[i]] = null;
            }
        }
    });
}


function setPlaceFilter(level, value) {

    const levelIndex = PLACE_FILTER_LEVELS.indexOf(level);

    if (placesFilter[level] === value) {

        placesFilter[level] = null;

    } else {

        placesFilter[level] = value;

        for (let i = levelIndex + 1; i < PLACE_FILTER_LEVELS.length; i++) {
            placesFilter[PLACE_FILTER_LEVELS[i]] = null;
        }
    }

    renderPlaceList();
}


function renderPlaceFilterChips() {

    sanitizePlacesFilter();

    const container = document.getElementById("place-filter-chips");

    container.innerHTML = "";

    for (const [levelIndex, level] of PLACE_FILTER_LEVELS.entries()) {

        //
        // Progressive reveal: Country only appears once a Continent chip is
        // picked, State only once Country is picked, and so on - rather than
        // dumping all four rows on screen at once before there's any real
        // narrowing to show. The first level (Continent) has no prior level
        // to wait on, so it always renders as soon as there's a value for it.
        //
        const previousLevel = PLACE_FILTER_LEVELS[levelIndex - 1];

        if (previousLevel && placesFilter[previousLevel] === null) {
            break;
        }

        const values = distinctValuesAtLevel(levelIndex);

        if (values.length === 0) {
            break;
        }

        const row = document.createElement("div");
        row.className = "place-filter-row";

        const label = document.createElement("span");
        label.className = "place-filter-label";
        label.textContent = level.charAt(0).toUpperCase() + level.slice(1) + ":";
        row.appendChild(label);

        for (const value of values) {

            const chip = document.createElement("button");

            chip.type = "button";
            chip.className = "place-filter-chip" + (placesFilter[level] === value ? " active" : "");
            chip.textContent = value;
            chip.onclick = () => setPlaceFilter(level, value);

            row.appendChild(chip);
        }

        container.appendChild(row);
    }
}


function renderPlaceList() {

    renderPlaceFilterChips();

    const list = document.getElementById("place-list");

    list.innerHTML = "";

    //
    // Picking a continent is the entry point into the list, not an optional
    // narrowing on top of an already-shown flat list - with a lot of saved
    // places, showing everything by default is exactly the wall of rows the
    // filter chips exist to avoid.
    //
    if (placesFilter.continent === null) {

        const hint = document.createElement("div");
        hint.className = "list-item-details";
        hint.textContent = "Pick a continent above to see places.";

        list.appendChild(hint);
        return;
    }

    for (const place of placesById.values()) {

        if (!placePassesAllFilters(place)) {
            continue;
        }

        const item = document.createElement("div");

        item.className = "vehicle-item list-row" + (place.id === selectedPlaceId ? " selected" : "");
        item.onclick = () => selectPlace(place.id);

        item.innerHTML =
            `<span class="list-item-label"><span>${place.description}` +
            `<div class="list-item-details">${place.address}</div></span></span>` +
            `<button class="remove-place-button" data-id="${place.id}">Delete</button>`;

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".remove-place-button")) {

        button.onclick = (event) => {
            event.stopPropagation();
            withSpinner(button, () => removePlace(Number(button.dataset.id)));
        };
    }
}


//
// A place has an actual location, so selecting one claims the shared map
// focus (see clearFocus()) the way selecting a vehicle or previewing a
// path does: pan to it and drop a marker, clearing whatever the others
// had.
//
function selectPlace(placeId) {

    const alreadySelected = selectedPlaceId === placeId;

    clearFocus();

    if (!alreadySelected) {

        selectedPlaceId = placeId;

        const place = placesById.get(placeId);

        if (place) {
            map.panTo([place.lat, place.lng]);
            showPlaceMarker(place);
        }
    }

    renderFocusDependentViews();
    renderPlaceList();
}


async function addPlace() {

    const descriptionInput = document.getElementById("place-description");

    const response = await fetch(API + "/api/places", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({
            description: descriptionInput.value
        })

    });

    const data = await response.json();

    if (!response.ok) {
        alert(data.detail || "Could not add place");
        return;
    }

    descriptionInput.value = "";

    loadPlaces();
}


async function removePlace(placeId) {

    const place = placesById.get(placeId);

    if (!confirm(`Delete place "${place ? place.description : placeId}"?`)) {
        return;
    }

    const response = await fetch(API + "/api/places/" + placeId, { method: "DELETE" });

    if (!response.ok) {

        const data = await response.json();
        alert(data.detail || "Could not delete place");
        return;
    }

    if (selectedPlaceId === placeId) {
        selectedPlaceId = null;
    }

    loadPlaces();
}


//
// Interpolates green (cheapest currently loaded) -> orange (mid) -> red
// (priciest) rather than a fixed dollar scale, so the color spread stays
// meaningful whether prices span cents or dollars. A single price (or all
// equal) just renders mid-color - there's nothing to contrast it against.
//
function gasPriceColor(price, min, max) {

    if (min === undefined || max === undefined || max === min) {
        return "#f08c00";
    }

    const t = (price - min) / (max - min);

    return t < 0.5
        ? interpolateColor("#2f9e44", "#f08c00", t / 0.5)
        : interpolateColor("#f08c00", "#e03131", (t - 0.5) / 0.5);
}


function interpolateColor(hexA, hexB, t) {

    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);

    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);

    return `rgb(${r}, ${g}, ${bl})`;
}


function hexToRgb(hex) {

    const n = parseInt(hex.slice(1), 16);

    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}


async function loadGasPrices() {

    const response = await fetch(API + "/api/gas-prices");
    const gasPrices = await response.json();

    gasPricesByPlaceId = new Map(gasPrices.map((gasPrice) => [gasPrice.place_id, gasPrice]));

    renderGasPriceMarkers();
    renderGasPriceList();
}


//
// Unlike showPlaceMarker() (one marker for whatever's currently selected),
// every known gas price gets its own always-on marker - this *is* the map
// overlay, not a selection highlight. Diffs against the existing
// gasPriceMarkers layer (add/update in place/remove) the same way
// pollActiveTrips() diffs tripLayers, rather than tearing down and
// rebuilding every marker on each refresh.
//
//
// Shared by the map marker tooltip, the Gas Prices list, and the divert-to-
// gas-station button labels - brand ("Shell") is optional (see CreateGasPriceRequest.brand
// in app.py), so this is the one place that decides how to show a station
// when it's missing, rather than three separate ad-hoc fallbacks drifting
// apart.
//
function gasStationLabel(brand, description) {
    return brand ? `${brand} - ${description}` : description;
}


function renderGasPriceMarkers() {

    const seen = new Set();

    let minPrice, maxPrice;

    for (const gasPrice of gasPricesByPlaceId.values()) {
        if (minPrice === undefined || gasPrice.price_per_gallon < minPrice) minPrice = gasPrice.price_per_gallon;
        if (maxPrice === undefined || gasPrice.price_per_gallon > maxPrice) maxPrice = gasPrice.price_per_gallon;
    }

    for (const gasPrice of gasPricesByPlaceId.values()) {

        seen.add(gasPrice.place_id);

        const color = gasPriceColor(gasPrice.price_per_gallon, minPrice, maxPrice);
        const label = `${gasStationLabel(gasPrice.brand, gasPrice.description)}: $${gasPrice.price_per_gallon.toFixed(2)}/gal`;

        let marker = gasPriceMarkers.get(gasPrice.place_id);

        if (!marker) {

            marker = L.circleMarker([gasPrice.lat, gasPrice.lng], {

                radius: 7,
                weight: 2,
                fillOpacity: 0.9

            });

            marker.bindTooltip("", { direction: "top", offset: [0, -8] });

            gasPriceMarkers.set(gasPrice.place_id, marker);
        }

        marker.setLatLng([gasPrice.lat, gasPrice.lng]);
        marker.setStyle({ color, fillColor: color });
        marker.setTooltipContent(label);

        if (gasPriceOverlayVisible && !map.hasLayer(marker)) {
            marker.addTo(map);
        }
    }

    for (const [placeId, marker] of gasPriceMarkers) {

        if (!seen.has(placeId)) {

            map.removeLayer(marker);
            gasPriceMarkers.delete(placeId);
        }
    }
}


function toggleGasPriceOverlay() {

    gasPriceOverlayVisible = !gasPriceOverlayVisible;

    document.getElementById("gasprice-overlay-toggle").classList.toggle("active", gasPriceOverlayVisible);

    for (const marker of gasPriceMarkers.values()) {

        if (gasPriceOverlayVisible) {
            marker.addTo(map);
        } else {
            map.removeLayer(marker);
        }
    }
}


//
// Collapsed by default - a bulk-imported price CSV can run into the
// hundreds of rows (see the Bulk import form below), which would otherwise
// dump a wall of list items into the tab the moment it's opened. Nothing
// resets this back to collapsed on its own - it stays however the user
// last left it across re-renders (a poll tick, adding/removing a price).
//
let gasPriceListExpanded = false;

function toggleGasPriceList() {

    gasPriceListExpanded = !gasPriceListExpanded;

    renderGasPriceList();
}


function renderGasPriceList() {

    const list = document.getElementById("gasprice-list");
    const arrow = document.getElementById("gasprice-list-arrow");
    const summary = document.getElementById("gasprice-list-summary");

    const count = gasPricesByPlaceId.size;

    summary.textContent = `Gas Stations (${count})`;
    arrow.innerHTML = gasPriceListExpanded ? "&#9662;" : "&#9656;";
    list.style.display = gasPriceListExpanded ? "" : "none";

    list.innerHTML = "";

    //
    // Skip building the (potentially hundreds of) row elements at all while
    // collapsed - no point paying for DOM nodes nobody can see yet.
    //
    if (!gasPriceListExpanded) {
        return;
    }

    const sorted = [...gasPricesByPlaceId.values()].sort((a, b) => a.price_per_gallon - b.price_per_gallon);

    for (const gasPrice of sorted) {

        const item = document.createElement("div");

        item.className = "vehicle-item list-row";
        item.style.cursor = "pointer";

        //
        // Same reasoning as clearFocus() itself - without this, a followed
        // driving vehicle (selectedVehicleId) would just yank the map back
        // to its own position on the very next poll tick, undoing this pan.
        //
        item.onclick = () => {
            clearFocus();
            renderFocusDependentViews();
            map.panTo([gasPrice.lat, gasPrice.lng]);
        };

        item.innerHTML =
            `<span class="list-item-label"><span>${gasStationLabel(gasPrice.brand, gasPrice.description)}` +
            `<div class="list-item-details">$${gasPrice.price_per_gallon.toFixed(2)}/gal</div></span></span>` +
            `<button class="remove-gasprice-button" data-id="${gasPrice.place_id}">Delete</button>`;

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".remove-gasprice-button")) {

        button.onclick = (event) => {
            event.stopPropagation();
            withSpinner(button, () => removeGasPrice(Number(button.dataset.id)));
        };
    }
}


async function addGasPrice() {

    const descriptionInput = document.getElementById("gasprice-description");
    const brandInput = document.getElementById("gasprice-brand");
    const priceInput = document.getElementById("gasprice-price");

    const response = await fetch(API + "/api/gas-prices", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({
            description: descriptionInput.value,
            brand: brandInput.value || null,
            price_per_gallon: Number(priceInput.value)
        })

    });

    const data = await response.json();

    if (!response.ok) {
        alert(data.detail || "Could not add gas price");
        return;
    }

    descriptionInput.value = "";
    brandInput.value = "";
    priceInput.value = "";

    //
    // Patches local state from this response instead of loadGasPrices() +
    // loadPlaces() - both of those re-fetch their *entire* multi-megabyte
    // lists, which turned "add one price" into the same multi-second cost
    // as a full page reload once there were tens of thousands of rows. The
    // response already has everything one new/updated row needs.
    //
    patchPlaceLocally(data.place);
    gasPricesByPlaceId.set(data.place_id, data);

    renderGasPriceMarkers();
    renderGasPriceList();
}


async function removeGasPrice(placeId) {

    const gasPrice = gasPricesByPlaceId.get(placeId);

    if (!confirm(`Delete gas price for "${gasPrice ? gasPrice.description : placeId}"?`)) {
        return;
    }

    const response = await fetch(API + "/api/gas-prices/" + placeId, { method: "DELETE" });

    if (!response.ok) {

        const data = await response.json();
        alert(data.detail || "Could not delete gas price");
        return;
    }

    // Same reasoning as addGasPrice() above - no need to re-fetch everything
    // just to drop the one row we already know was deleted.
    gasPricesByPlaceId.delete(placeId);

    renderGasPriceMarkers();
    renderGasPriceList();
}


async function uploadGasPrices() {

    const fileInput = document.getElementById("gasprice-file-input");
    const resultDiv = document.getElementById("gasprice-upload-result");

    if (!fileInput.files.length) {
        alert("Choose a CSV or JSON file first");
        return;
    }

    const formData = new FormData();
    formData.append("file", fileInput.files[0]);

    const response = await fetch(API + "/api/gas-prices/upload", {

        method: "POST",

        body: formData

    });

    const submitted = await response.json();

    if (!response.ok) {
        alert(submitted.detail || "Could not upload gas prices");
        return;
    }

    resultDiv.textContent = "Processing...";

    let data;

    try {

        data = await pollJob(submitted.job_id, (job) => {
            resultDiv.textContent = `Processing ${job.progress_current}/${job.progress_total}...`;
        });

    } catch (e) {
        alert(e.message);
        return;
    }

    resultDiv.textContent = `Added/updated ${data.created} price(s)` +
        (data.errors.length ? ` - ${data.errors.length} row(s) failed, see console` : "");

    if (data.errors.length) {
        console.warn("Gas price upload errors:", data.errors);
    }

    fileInput.value = "";

    loadGasPrices();
    loadPlaces();
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
    renderPathSelectForTripVehicle();
}


function renderVehicleList() {

    const list = document.getElementById("vehicle-list");

    list.innerHTML = "";

    for (const vehicle of vehiclesById.values()) {

        const item = document.createElement("div");

        //
        // Trip-scoped, not the vehicle's lifetime odometer - gas used only
        // renders at all while this vehicle actually has an active trip
        // (activeTripsById); the distance-driven equivalent now lives in
        // the expanded card's tripometer instead of a badge here.
        //
        const trip = activeTripsById.get(vehicle.id);
        const gallonsUsed = trip ? tripGallonsUsed(trip, vehicle) : null;

        //
        // vehicle.status (GET /api/vehicles) only gets re-fetched when a
        // vehicle enters or leaves the active-trips set (see
        // pollActiveTrips()'s setsEqual() check) - going DRIVING -> STRANDED
        // doesn't change set membership at all, so that fetch never fires
        // and vehicle.status would otherwise stay stuck on "DRIVING"
        // forever once a vehicle strands. trip.status (from the 1s poll)
        // is always current, so prefer it for exactly that transition.
        //
        const displayStatus = trip && trip.status === "STRANDED" ? "STRANDED" : vehicle.status;

        const driving = displayStatus === "DRIVING" || displayStatus === "STRANDED";
        const ready = displayStatus === "READY";

        item.className = "vehicle-item vehicle-row vehicle-card" +
            (driving || ready ? " clickable" : "") +
            (driving && vehicle.id === selectedVehicleId ? " selected" : "") +
            (ready && vehicle.id === selectedTripVehicleId ? " selected" : "");

        if (driving) {
            item.onclick = () => selectVehicle(vehicle.id);
        } else if (ready) {
            item.onclick = () => selectTripVehicle(vehicle.id);
        }

        const imageUrl = vehicle.vehicle_model ? vehicleModelImageUrl(vehicle.vehicle_model.image) : null;

        //
        // A driving/stranded vehicle's fuel gauge comes from the live trip
        // (tripFuelRemaining()); a READY one shows its persisted tank level
        // instead - both against the same vehicle_model.fuel_tank_gallons capacity.
        //
        const fuelRemaining = trip ? tripFuelRemaining(trip) : vehicle.fuel_gallons;
        const fuelGauge = fuelRemaining !== null && vehicle.vehicle_model
            ? fuelGaugeHtml(fuelRemaining, vehicle.vehicle_model.fuel_tank_gallons, vehicle.vehicle_model.mpg)
            : "";

        //
        // trip.remaining_miles (derive_position() in app.py) - how much
        // route is left regardless of status: still closing while
        // DRIVING, frozen wherever the tank ran dry if STRANDED (useful
        // context for how close it was), 0 once ARRIVED. Shown right next
        // to the fuel gauge's own "mi to empty" so the two ranges are easy
        // to compare at a glance.
        //
        const milesToDestination = trip && typeof trip.remaining_miles === "number"
            ? Math.round(trip.remaining_miles)
            : null;
        const milesToDestinationBadge = milesToDestination !== null
            ? `<span class="miles-badge" title="Remaining route distance">${milesToDestination.toLocaleString()} mi to destination</span>`
            : "";

        item.innerHTML =
            `<div class="vehicle-card-top">` +
            (imageUrl ? `<img class="list-item-thumb" src="${imageUrl}">` : "") +
            `<div class="vehicle-card-title">` +
            `<div class="vehicle-card-name">${vehicle.name}` +
            (vehicle.vehicle_model ? ` (${vehicleModelLabel(vehicle.vehicle_model)})` : "") +
            `</div>` +
            `<div class="vehicle-card-location">${vehicle.current_location}</div>` +
            `</div>` +
            `<span class="status-badge status-${displayStatus}">${displayStatus}</span>` +
            `</div>` +
            (trip || fuelGauge
                ? `<div class="vehicle-card-meta">` +
                  (gallonsUsed !== null ? `<span class="gas-badge">&#9981; ${formatGallons(gallonsUsed)} gal</span>` : "") +
                  milesToDestinationBadge +
                  fuelGauge +
                  `</div>`
                : "") +
            (displayStatus === "READY"
                ? `<div class="vehicle-card-actions">` +
                  (refuelInFlightVehicleId === vehicle.id
                      ? `<button class="refuel-button" disabled>Refueling...</button>`
                      : `<button class="refuel-button" data-id="${vehicle.id}">Refuel</button>`) +
                  `<button class="sell-button" data-id="${vehicle.id}">Sell</button>` +
                  `</div>`
                : "") +
            (driving && vehicle.id === selectedVehicleId && trip
                ? vehicleDetailHtml(vehicle, trip)
                : "");

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".sell-button")) {

        button.onclick = (event) => {
            event.stopPropagation();
            withSpinner(button, () => sellVehicle(Number(button.dataset.id)));
        };
    }

    for (const button of list.querySelectorAll(".refuel-button")) {

        //
        // Not wrapped in withSpinner() - when refueling means driving to a
        // station first (a multi-second background job), refuelVehicle()
        // tracks that itself via refuelInFlightVehicleId so the "Refueling..."
        // state survives every 1s poll-driven re-render of this list
        // instead of being wiped by the very next one (see
        // divertInFlightVehicleId above for the same fix applied to the
        // divert button).
        //
        if (!button.disabled) {
            button.onclick = (event) => {
                event.stopPropagation();
                refuelVehicle(Number(button.dataset.id));
            };
        }
    }

    const roadsideButton = document.getElementById("roadside-refuel-button");

    if (roadsideButton) {
        roadsideButton.onclick = (event) => {
            event.stopPropagation();
            withSpinner(roadsideButton, () => roadsideRefuel(Number(roadsideButton.dataset.id)));
        };
    }

    //
    // Not wrapped in withSpinner() like other buttons - divertToNearestGasStation()
    // already re-renders this whole list itself via divertInFlightVehicleId,
    // so a second, independent spinner/disabled mechanism on the same
    // (about to be replaced) button would just be redundant.
    //
    for (const button of list.querySelectorAll(".divert-nearest-button")) {

        if (!button.disabled) {
            button.onclick = (event) => {
                event.stopPropagation();
                divertToNearestGasStation(Number(button.dataset.vehicleId));
            };
        }
    }
}


//
// When the vehicle isn't already at a gas station, POST .../refuel starts
// a background job (drive there, refuel, park - see app.py) instead of
// refueling instantly, so this has to poll it the same way createPath()
// and divertToGasStation() do rather than treating every response as
// already finished.
//
let refuelInFlightVehicleId = null;

async function refuelVehicle(vehicleId) {

    refuelInFlightVehicleId = vehicleId;
    renderVehicleList();

    try {

        const response = await fetch(API + "/api/vehicles/" + vehicleId + "/refuel", { method: "POST" });

        const data = await response.json();

        if (!response.ok) {
            alert(data.detail || "Could not refuel vehicle");
            return;
        }

        if (data.job_id) {
            await pollJob(data.job_id);
        }

    } catch (e) {
        alert(e.message);
    } finally {
        refuelInFlightVehicleId = null;
        loadVehicles();
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

    const alreadySelected = selectedTripVehicleId === vehicleId;

    clearFocus();

    //
    // Jump to wherever the vehicle currently is (its settled
    // current_lat/current_lng, not a live trip position - it's READY, not
    // driving) when it's selected, not when deselecting.
    //
    if (!alreadySelected) {

        selectedTripVehicleId = vehicleId;

        const vehicle = vehiclesById.get(vehicleId);

        if (vehicle) {
            map.panTo([vehicle.current_lat, vehicle.current_lng]);
            showRestingVehicleMarker(vehicle);
        }
    }

    renderFocusDependentViews();
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

    //
    // Shown whenever a vehicle is selected, not just when it has zero
    // matching paths - there's always a reason to jump straight to making
    // another path from here, even if some already exist.
    //
    hint.style.display = "";

    //
    // showTab("paths") already prefills Origin from whichever vehicle is
    // focused (selectedTripVehicleId here, since this hint only renders
    // once a vehicle is selected for a trip - see the !vehicle guard
    // above) via its own vehicle-aware logic, so jumping there from this
    // link lands right where a "create one" click implies: a path form
    // already started from this vehicle's location.
    //
    hint.innerHTML = (
        matching.length === 0
            ? `No paths from ${vehicle.current_location} yet - `
            : `Need another path from ${vehicle.current_location}? `
    ) + `<a href="#" class="hint-link" onclick="showTab('paths'); return false;">create one in the Paths tab</a>.`;

    updateStartTripVisibility();
}


function updateStartTripVisibility() {

    const pathId = document.getElementById("path-select").value;

    document.getElementById("start-trip-button").style.display =
        selectedTripVehicleId !== null && pathId !== "" ? "" : "none";
}


function selectVehicle(vehicleId) {

    const alreadySelected = selectedVehicleId === vehicleId;

    clearFocus();

    currentCity = null;

    if (!alreadySelected) {

        selectedVehicleId = vehicleId;

        //
        // Jump to the vehicle right away on selection; afterwards
        // pollActiveTrips() keeps following it every tick without touching
        // zoom.
        //
        const trip = activeTripsById.get(vehicleId);

        if (trip) {
            map.panTo(trip.position);
        }

        fetchCurrentCity();
    }

    renderFocusDependentViews();
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
        renderVehicleList();
    }
}


//
// Looks up the nearest qualifying station on demand (GET .../gas-station-ahead
// already sorts its candidates by distance - see find_gas_station_options()
// in app.py) and diverts straight to it, rather than polling continuously
// and showing a pick-one list - a single button replaces what used to be
// a per-vehicle "watch" toggle plus a list of "Divert to ..." options.
// Sets divertInFlightVehicleId itself before that first lookup (not just
// inside divertToGasStation() below) so the button shows "Diverting..."
// for the whole operation, not just the part after a station is found.
//
async function divertToNearestGasStation(vehicleId) {

    divertInFlightVehicleId = vehicleId;
    renderVehicleList();

    try {

        const response = await fetch(API + "/api/vehicles/" + vehicleId + "/gas-station-ahead");

        if (!response.ok) {
            alert("Could not look up nearby gas stations");
            return;
        }

        const data = await response.json();

        if (!data.stations.length) {
            alert("No reachable gas station found nearby");
            return;
        }

        await divertToGasStation(vehicleId, data.stations[0].place_id);

    } finally {

        if (divertInFlightVehicleId === vehicleId) {
            divertInFlightVehicleId = null;
            renderVehicleList();
        }
    }
}


//
// Gas used so far on the current trip is derived client-side -
// trip.distance_miles (from GET /api/trips/active's derive_position())
// divided by the vehicle's own vehicle_model.mpg, rather than a value stored/
// computed on the backend. Returns null when the vehicle or its vehicle model
// (and so its mpg) isn't known yet.
//
function tripGallonsUsed(trip, vehicle) {

    const mpg = vehicle && vehicle.vehicle_model ? vehicle.vehicle_model.mpg : null;

    return mpg ? trip.distance_miles / mpg : null;
}


function formatGallons(gallons) {

    return gallons.toFixed(2);
}


//
// Unlike tripGallonsUsed() above (a pure mpg x distance readout, unaffected
// by tank size), this is the actual live tank level from the backend's own
// resolve_trip_progress() - it reflects the vehicle's real starting fuel,
// any roadside refuels used so far, and clamps to 0 once truly dry, so it's
// what should drive the fuel gauge and the STRANDED/roadside-refuel UI.
// null when the vehicle/vehicle model's mpg isn't trackable (see resolve_trip_progress()).
//
function tripFuelRemaining(trip) {

    return typeof trip.fuel_gallons_remaining === "number" ? trip.fuel_gallons_remaining : null;
}


//
// A small visual fuel gauge (bar + gallons label) for the My Vehicles list -
// color shifts from green to red as the tank empties (same "lower = worse"
// idea as the gas-price/speed-limit color scales elsewhere in the app), so a
// vehicle that needs fuel soon stands out at a glance without reading the
// number.
//
function fuelGaugeColor(fraction) {

    if (fraction <= 0.15) {
        return "#c92a2a";
    }

    if (fraction <= 0.4) {
        return "#f08c00";
    }

    return "#2a8f2a";
}


function fuelGaugeHtml(remainingGallons, capacityGallons, mpg) {

    const fraction = capacityGallons > 0 ? Math.max(0, Math.min(1, remainingGallons / capacityGallons)) : 0;

    //
    // A straight gallons × mpg estimate - the same math resolve_trip_progress()
    // uses on the backend for a driving vehicle's own dry-distance, just
    // run here for display rather than pulled from the API, so it updates
    // instantly as the gauge itself does rather than lagging a poll cycle.
    //
    const milesToEmpty = mpg ? Math.round(remainingGallons * mpg) : null;
    const milesToEmptyText = milesToEmpty !== null ? ` &middot; ${milesToEmpty.toLocaleString()} mi to empty` : "";

    return (
        `<span class="fuel-gauge" title="${formatGallons(remainingGallons)} / ${capacityGallons} gal${milesToEmpty !== null ? ` (${milesToEmpty.toLocaleString()} mi to empty)` : ""}">` +
        `<span class="fuel-gauge-bar"><span class="fuel-gauge-fill" style="width:${(fraction * 100).toFixed(0)}%;background:${fuelGaugeColor(fraction)}"></span></span>` +
        `<span class="fuel-gauge-label">${formatGallons(remainingGallons)}/${capacityGallons} gal${milesToEmptyText}</span>` +
        `</span>`
    );
}


//
// One point along a 180-degree arc gauge running from the left point
// (fraction 0) through the top (fraction 0.5) to the right point
// (fraction 1) - screen-space angle theta = 180 + fraction*180 degrees,
// measured the usual SVG way (0 deg = right, 90 deg = down, since y grows
// downward). cos/sin at theta=180 gives (-1,0) - the left point - and at
// theta=360 gives (1,0) - the right point - with theta=270 (top) exactly
// halfway between, which is what makes a speedometer/fuel-dial needle
// read left-to-right through the top instead of the bottom.
//
function arcPoint(cx, cy, r, fraction) {

    const theta = (180 + fraction * 180) * Math.PI / 180;

    return [cx + r * Math.cos(theta), cy + r * Math.sin(theta)];
}


//
// Shared by the speedometer and the fuel dial below - same 180-degree arc,
// tick marks, and needle, just a different needle color/fraction/labels.
// The needle is drawn as a plain vertical line (pointing straight up, i.e.
// already at fraction 0.5's position) and then rotated into place with a
// plain SVG rotate() - since rotate() turns clockwise and increasing
// fraction also reads left-to-right (clockwise) on this arc, the needed
// rotation is just fraction*180-90 degrees, no per-frame trig needed for
// the moving part.
//
function gaugeArcSvg(fraction, { needleColor, endLabels, valueText, unitLabel, redZone = null }) {

    const clamped = Math.max(0, Math.min(1, fraction));
    const cx = 60, cy = 56, r = 46, needleLength = 40;
    const angle = clamped * 180 - 90;

    const [trackStartX, trackStartY] = arcPoint(cx, cy, r, 0);
    const [trackEndX, trackEndY] = arcPoint(cx, cy, r, 1);

    //
    // Major ticks at quarters, minor ticks at eighths between them - the
    // finer graduation is most of what makes the dial read as a real
    // instrument rather than a progress meter.
    //
    const ticks = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((t, index) => {

        const major = index % 2 === 0;
        const [x1, y1] = arcPoint(cx, cy, r - (major ? 9 : 5), t);
        const [x2, y2] = arcPoint(cx, cy, r, t);

        return `<line class="gauge-tick${major ? "" : " gauge-tick-minor"}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />`;

    }).join("");

    //
    // An optional red band along the arc (e.g. the bottom of the fuel
    // dial), drawn over the track the same way a printed dial face marks
    // its warning range.
    //
    let redZoneArc = "";

    if (redZone) {

        const [zoneStartX, zoneStartY] = arcPoint(cx, cy, r, redZone[0]);
        const [zoneEndX, zoneEndY] = arcPoint(cx, cy, r, redZone[1]);

        redZoneArc = `<path class="gauge-red-zone" d="M ${zoneStartX.toFixed(1)} ${zoneStartY.toFixed(1)} A ${r} ${r} 0 0 1 ${zoneEndX.toFixed(1)} ${zoneEndY.toFixed(1)}" />`;
    }

    return (
        `<svg class="gauge-svg" viewBox="0 0 120 74">` +
        `<path class="gauge-track" d="M ${trackStartX.toFixed(1)} ${trackStartY.toFixed(1)} A ${r} ${r} 0 0 1 ${trackEndX.toFixed(1)} ${trackEndY.toFixed(1)}" />` +
        redZoneArc +
        ticks +
        `<text class="gauge-end-label" x="${trackStartX.toFixed(1)}" y="${cy + 13}" font-size="9" text-anchor="middle">${endLabels[0]}</text>` +
        `<text class="gauge-end-label" x="${trackEndX.toFixed(1)}" y="${cy + 13}" font-size="9" text-anchor="middle">${endLabels[1]}</text>` +
        `<line class="gauge-needle" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - needleLength}" ` +
        `stroke="${needleColor}" transform="rotate(${angle.toFixed(1)} ${cx} ${cy})" />` +
        `<circle class="gauge-hub" cx="${cx}" cy="${cy}" r="5" />` +
        `</svg>` +
        `<div class="gauge-value">${valueText}</div>` +
        `<div class="gauge-label">${unitLabel}</div>`
    );
}


//
// A hauling vehicle's trip speed is bounded by road speed limits, not its
// own top speed (there's no such rating in vehicle_models) - 90 covers
// every zone tier this app has (see README's "<45/45-64/65+" road-color
// legend) with headroom to spare, so the needle is never pinned at max
// during normal driving.
//
const SPEEDOMETER_MAX_MPH = 90;

function speedometerHtml(speedMph) {

    return gaugeArcSvg(speedMph / SPEEDOMETER_MAX_MPH, {

        needleColor: "#ff5a1f",

        endLabels: ["0", String(SPEEDOMETER_MAX_MPH)],

        valueText: `${Math.round(speedMph)}`,

        unitLabel: "mph"
    });
}


//
// Same green-to-red scale as the compact card's linear fuel-gauge-bar
// (fuelGaugeColor()) applied to the needle instead of a fill width, so a
// low tank reads the same way in both places.
//
function fuelDialHtml(remainingGallons, capacityGallons) {

    const fraction = capacityGallons > 0 ? remainingGallons / capacityGallons : 0;

    return gaugeArcSvg(fraction, {

        needleColor: fuelGaugeColor(fraction),

        endLabels: ["E", "F"],

        valueText: formatGallons(remainingGallons),

        unitLabel: "gal",

        redZone: [0, 0.125]
    });
}


//
// A classic mechanical odometer's fixed digit count, not a plain number -
// padded to 6 digits (999,999 miles of hauling is far past anything this
// sim will ever accumulate) so it always looks like a real instrument
// rather than growing/shrinking width as the total changes.
//
function odometerHtml(miles) {

    const digits = String(Math.max(0, Math.round(miles))).padStart(6, "0").split("");

    return (
        `<div class="odometer" title="${Math.round(miles).toLocaleString()} total miles">` +
        digits.map((digit) => `<span class="odometer-digit">${digit}</span>`).join("") +
        `</div>` +
        `<div class="gauge-label">odometer</div>`
    );
}


//
// A real trip odometer resets per trip and shows one decimal place
// (tenths of a mile) rather than the main odometer's whole-mile total -
// padStart still works character-for-character with the "." included, so
// "42.7" becomes "0042.7" the same way "42" becomes "000042" above.
//
function tripometerHtml(miles) {

    const text = Math.max(0, miles).toFixed(1).padStart(6, "0");

    return (
        `<div class="odometer" title="${miles.toFixed(1)} mi this trip">` +
        text.split("").map((char) => char === "."
            ? `<span class="odometer-digit odometer-dot">.</span>`
            : `<span class="odometer-digit">${char}</span>`
        ).join("") +
        `</div>` +
        `<div class="gauge-label">trip</div>`
    );
}


//
// The expanded block shown inline on a DRIVING/STRANDED vehicle's own card
// once it's selected - this used to be a separate "In Route" tab's detail
// panel, keyed off the same selectedVehicleId, just rendered somewhere
// else on the page. Skips anything the compact card above it already
// shows (name/model, status badge, trip miles, gas used, fuel gauge) so
// selecting a vehicle adds detail rather than repeating it.
//
function vehicleDetailHtml(vehicle, trip) {

    const cityLine = currentCity && currentCity.vehicleId === vehicle.id
        ? `Near: ${currentCity.city || "unknown"}<br>`
        : "Near: (looking up...)<br>";

    const vehicleModel = vehicle.vehicle_model;

    let statusLine;

    if (trip.status === "ARRIVED") {

        statusLine = "Arrived";

    } else if (trip.status === "STRANDED") {

        statusLine =
            `Out of fuel - stranded ${trip.distance_miles.toFixed(1)} mi in<br>` +
            `<button id="roadside-refuel-button" data-id="${trip.vehicle_id}">` +
            `Send roadside fuel ($${ROADSIDE_ASSIST_FEE_USD})</button>`;

    } else {

        const diverting = divertInFlightVehicleId === trip.vehicle_id;

        //
        // Set by the backend only while this trip is itself a gas-station
        // detour (see active_trips() in app.py) - without this, a vehicle
        // that successfully diverted just looks like any other vehicle
        // driving somewhere, with nothing distinguishing "headed to
        // refuel" from "still on its original trip".
        //
        const refuelingDetourLine = trip.resume_destination
            ? `&#9981; Refueling detour - resuming to ${trip.resume_destination} after<br>`
            : "";

        const divertButton =
            `<button class="divert-nearest-button" data-vehicle-id="${vehicle.id}" ${diverting ? "disabled" : ""}>` +
            (diverting ? "Diverting..." : "Divert to nearest gas station") +
            `</button>`;

        statusLine =
            refuelingDetourLine +
            `Arriving in: ${formatHMS(trip.remaining_sim_seconds)}<br>` +
            divertButton;
    }

    //
    // The instrument cluster - speedometer (frozen at 0 once STRANDED/
    // ARRIVED, same as a real one with the engine off), fuel dial (same
    // live trip fuel the compact card's linear bar already shows, just as
    // a dial here), and an odometer for the vehicle's real lifetime total
    // rather than just this trip's distance.
    //
    const fuelRemaining = tripFuelRemaining(trip);

    const dashboard =
        `<div class="dashboard">` +
        `<div class="gauge">${speedometerHtml(trip.status === "DRIVING" ? trip.speed_mph : 0)}</div>` +
        (fuelRemaining !== null && vehicleModel
            ? `<div class="gauge">${fuelDialHtml(fuelRemaining, vehicleModel.fuel_tank_gallons)}</div>`
            : "") +
        //
        // vehicle.total_miles_traveled (GET /api/vehicles) only counts
        // trips that have actually settled - a trip in progress is
        // deliberately excluded there (see its own comment in
        // list_vehicles()) so its distance isn't double-counted once it
        // arrives. trip.distance_miles (GET /api/trips/active) is that
        // missing piece - adding it in is what makes this tick up live
        // while driving instead of jumping only once the trip ends.
        //
        `<div class="gauge">${odometerHtml(vehicle.total_miles_traveled + trip.distance_miles)}</div>` +
        //
        // trip_meter_miles, not distance_miles - it keeps counting across
        // every leg of a gas-station detour (see active_trips() in app.py)
        // instead of resetting to 0 at the station.
        //
        `<div class="gauge">${tripometerHtml(trip.trip_meter_miles ?? trip.distance_miles)}</div>` +
        `</div>`;

    return (
        `<div class="vehicle-card-detail">` +
        dashboard +
        (vehicleModel
            ? `Capacity: ${vehicleModel.person_capacity} people, ${vehicleModel.cargo_capacity_cuft} cu ft cargo<br>` +
              `Cost: $${Math.round(vehicleModel.cost).toLocaleString()} &middot; ${vehicleModel.mpg} mpg<br>`
            : "") +
        cityLine +
        `Position: ${trip.position[0].toFixed(4)}, ${trip.position[1].toFixed(4)}<br>` +
        (trip.road_name ? `Road: ${trip.road_name}<br>` : "") +
        statusLine +
        `</div>`
    );
}



//
// Diverting runs as a background job (a couple of seconds - a live reverse
// geocode plus an OSRM route), but renderVehicleList() rebuilds the whole
// card from scratch on every 1s active-trips poll regardless - without
// tracking this separately, that next poll tick would just overwrite
// withSpinner()'s disabled/spinning button with a fresh one before the
// click had any visible effect at all, making it look like nothing
// happened even though the job was quietly running the whole time.
// divertInFlightVehicleId makes the in-progress state part of what
// renderVehicleList() itself renders, so it survives every re-render
// instead of being clobbered by the very next one.
//
let divertInFlightVehicleId = null;

async function divertToGasStation(vehicleId, gasStationPlaceId) {

    divertInFlightVehicleId = vehicleId;
    renderVehicleList();

    try {

        const response = await fetch(API + "/api/vehicles/" + vehicleId + "/divert-to-gas-station", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                gas_station_place_id: gasStationPlaceId
            })

        });

        const submitted = await response.json();

        if (!response.ok) {
            alert(submitted.detail || "Could not divert to gas station");
            return;
        }

        await pollJob(submitted.job_id);

    } catch (e) {
        alert(e.message);
    } finally {
        divertInFlightVehicleId = null;
        renderVehicleList();
    }
}


//
// There's no money/budget system in the app yet (see ROADSIDE_ASSIST_FEE_USD
// in app.py), so this fee isn't actually charged anywhere - it's just shown
// to set expectations for when one exists.
//
const ROADSIDE_ASSIST_FEE_USD = 75;


async function roadsideRefuel(vehicleId) {

    const vehicle = vehiclesById.get(vehicleId);

    if (!confirm(`Send roadside fuel to ${vehicle ? vehicle.name : "this vehicle"} for $${ROADSIDE_ASSIST_FEE_USD}?`)) {
        return;
    }

    const response = await fetch(API + "/api/vehicles/" + vehicleId + "/roadside-refuel", { method: "POST" });

    if (!response.ok) {

        const data = await response.json();
        alert(data.detail || "Could not send roadside fuel");
        return;
    }
}


async function addVehicle() {

    const vehicleModelId = document.getElementById("vehicle-model-select").value;

    if (!vehicleModelId) {
        alert("Add a hauling vehicle model first");
        return;
    }

    const response = await fetch(API + "/api/vehicles", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            vehicle_model_id: Number(vehicleModelId),

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
    loadPlaces();
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


//
// Collapsed by default, same reasoning (and pattern) as the Gas Prices
// tab's station list - a fleet that's been driving routes all over the
// place can build up a long list of paths, and there's no reason to dump
// all of it into the tab the moment it's opened. previewPath() expands
// this itself (see below) whenever a path is actually selected - clicking
// an already-visible row, or a brand-new path just created - so the
// highlighted selection is never hidden behind a collapsed list.
//
let pathListExpanded = false;

function togglePathList() {

    pathListExpanded = !pathListExpanded;

    renderPathList();
}


function renderPathList() {

    const list = document.getElementById("path-list");
    const arrow = document.getElementById("path-list-arrow");
    const summary = document.getElementById("path-list-summary");

    summary.textContent = `Paths (${pathsById.size})`;
    arrow.innerHTML = pathListExpanded ? "&#9662;" : "&#9656;";
    list.style.display = pathListExpanded ? "" : "none";

    list.innerHTML = "";

    if (!pathListExpanded) {
        return;
    }

    for (const path of pathsById.values()) {

        const item = document.createElement("div");

        item.className = "vehicle-item list-row" + (path.id === selectedPathId ? " selected" : "");
        item.onclick = () => previewPath(path);

        item.innerHTML =
            `<span>${pathLabel(path)} <span class="path-distance">(${Math.round(pathDistanceMiles(path))} mi)</span></span>` +
            `<button class="remove-path-button" data-id="${path.id}">Remove</button>`;

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".remove-path-button")) {

        button.onclick = (event) => {
            event.stopPropagation();
            withSpinner(button, () => removePath(Number(button.dataset.id)));
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

    if (selectedPathId === pathId) {
        selectedPathId = null;
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
            withSpinner(button, () => removeZone(Number(button.dataset.id)));
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
        return removeZone(selectedSection.zoneId);
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

    clearFocus();
    renderFocusDependentViews();

    selectedPathId = path.id;
    pathListExpanded = true;
    renderPathList();

    map.fitBounds(L.latLngBounds(path.route));

    renderZoneEditor(path);
}


function clearOriginInput() {

    document.getElementById("origin").value = "";

    //
    // Same reasoning as swapOriginDestination() below - a directly-set
    // .value doesn't fire "input", so the listener that normally drops
    // originPlaceId on a manual edit never runs; this has to clear it
    // itself instead of leaving a stale place_id behind an empty box.
    //
    originPlaceId = null;
}


function clearDestinationInput() {

    document.getElementById("destination").value = "";
}


function swapOriginDestination() {

    const originInput = document.getElementById("origin");
    const destinationInput = document.getElementById("destination");

    const temp = originInput.value;
    originInput.value = destinationInput.value;
    destinationInput.value = temp;

    //
    // Whatever now sits in Origin came from the Destination box, which has
    // no known place_id behind it - keeping the old one would silently
    // create the path from the vehicle's place instead of the text now
    // actually shown.
    //
    originPlaceId = null;
}


async function createPath() {

    //
    // previewPath() below clears selectedTripVehicleId (via clearFocus()),
    // so this is captured before that happens - it's how renderBackToVehicleHint()
    // knows to offer a way back once the new path exists.
    //
    const originVehicleId = selectedTripVehicleId;

    const response = await fetch(API + "/api/paths", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            origin: document.getElementById("origin").value,

            origin_place_id: originPlaceId,

            destination: document.getElementById("destination").value

        })

    });

    const submitted = await response.json();

    if (!response.ok) {
        alert(submitted.detail || "Could not create path");
        return;
    }

    let path;

    try {
        path = await pollJob(submitted.job_id);
    } catch (e) {
        alert(e.message);
        return;
    }

    previewPath(path);

    pathCreatedFromVehicleId = originVehicleId;
    renderBackToVehicleHint();

    await loadPaths();
    loadPlaces();

    document.getElementById("path-select").value = path.id;
    updateStartTripVisibility();
}


//
// Only shown right after creating a path that was reached from a vehicle's
// own "create one in the Paths tab" hint (see renderPathSelectForTripVehicle()) -
// re-validated against the vehicle's current status every render (not just
// once at creation) since it could have been sold or started driving via
// another tab/session in the meantime.
//
function renderBackToVehicleHint() {

    const hint = document.getElementById("back-to-vehicle-hint");

    const vehicle = pathCreatedFromVehicleId !== null ? vehiclesById.get(pathCreatedFromVehicleId) : null;

    if (!vehicle || vehicle.status !== "READY") {
        hint.style.display = "none";
        return;
    }

    hint.style.display = "";

    hint.innerHTML =
        `<a href="#" class="hint-link" onclick="backToVehicle(${vehicle.id}); return false;">` +
        `&larr; Back to ${vehicle.name}</a>`;
}


function backToVehicle(vehicleId) {

    showTab("myvehicles");
    selectTripVehicle(vehicleId);
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
                : trip.status === "STRANDED"
                ? `${trip.vehicle_name}: Out of fuel - stranded`
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

    //
    // Keeps each vehicle's displayed odometer (starting_mileage + its
    // settled total + whatever it's covered on its current trip so far)
    // ticking up live while driving, not just once the trip arrives.
    //
    renderVehicleList();

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


loadVehicleModels().then(loadVehicles);
loadPaths();
loadPlaces();
loadGasPrices();
loadJobs();

loadSettings();

setInterval(pollActiveTrips, 1000);

setInterval(loadJobs, 2000);

setInterval(updateSimClock, 1000);

//
// Re-syncs against the backend's own anchor every few seconds, correcting
// for client clock drift and picking up a multiplier change made from
// another browser/tab - the 1s updateSimClock() tick above just
// extrapolates smoothly between these refreshes.
//
setInterval(loadSettings, 5000);

//
// Gated on the selected vehicle actually still being in activeTripsById,
// not just selectedVehicleId being set - both endpoints 404/no-op for a
// vehicle that isn't currently driving (READY, SOLD, or just arrived and
// past its grace period), and a vehicle stays "selected" in the In Route
// tab long after it stops driving (nothing ever clears the selection on
// its own). Without this check, either poll would keep firing every tick
// forever for a long-idle selection, filling the browser console with
// failed-request noise that no amount of try/catch on the JS side can
// suppress - the browser logs the network failure itself.
//
function selectedVehicleIsDriving() {
    return selectedVehicleId !== null && activeTripsById.has(selectedVehicleId);
}

setInterval(() => {

    if (selectedVehicleIsDriving()) {
        fetchCurrentCity();
    }

}, 7000);

