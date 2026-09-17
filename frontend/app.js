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
let placesById = new Map();        // place_id -> place (from GET /api/places)
let activeTripsById = new Map();   // vehicle_id -> trip (from the last poll)
let activeVehicleIds = new Set();  // vehicle ids seen on the last poll
let selectedVehicleId = null;      // vehicle id followed in the In Route tab
let selectedTripVehicleId = null;  // vehicle id chosen (in the Vehicles tab) to start a trip
let selectedSpecId = null;         // spec id highlighted in the Templates tab (purely visual, no map focus)
let selectedPlaceId = null;        // place id focused in the Places tab
let selectedPathId = null;         // path id currently previewed in the Paths tab

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
let gasPriceOverlayVisible = true;  // toggled by the "Show on map" checkbox in the Gas Prices tab

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

    clearRestingVehicleMarker();
    clearPlaceMarker();

    renderPlaceList();
}


function renderFocusDependentViews() {

    renderInRouteList();
    renderVehicleList();
    renderPathSelectForTripVehicle();
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
            ? `<div class="spec-item-details" style="color:#e03131;">${job.error}</div>`
            : "";

        item.innerHTML =
            `<span class="spec-item-label"><span>#${job.id} ${prettyJobType(job.job_type)}` +
            `<div class="spec-item-details">${progress}started ${started} - updated ${updated}</div>` +
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
    templates: "Templates",
    places: "Places",
    myvehicles: "My Vehicles",
    paths: "Paths",
    inroute: "In Route",
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


function showTab(tab) {

    for (const name of ["templates", "places", "myvehicles", "paths", "inroute", "gasprices", "jobs"]) {

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
            // limited on the backend, so this can take a moment).
            document.getElementById("origin").value = vehicle.current_location;

            fillOriginWithFullAddress(vehicle.id);
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

    renderVehicleList();
    renderInRouteList();
    renderSpecList();
}


function renderSpecList() {

    const list = document.getElementById("spec-list");

    list.innerHTML = "";

    for (const spec of specsById.values()) {

        const item = document.createElement("div");

        item.className = "vehicle-item list-row" + (spec.id === selectedSpecId ? " selected" : "");
        item.onclick = () => selectSpec(spec.id);

        const imageUrl = specImageUrl(spec.image);

        item.innerHTML =
            `<span class="spec-item-label">` +
            (imageUrl ? `<img class="spec-thumb" src="${imageUrl}">` : "") +
            `<span>${specLabel(spec)}` +
            `<div class="spec-item-details">` +
            `${spec.person_capacity} people &middot; ${spec.cargo_capacity_cuft} cu ft &middot; ` +
            `$${Math.round(spec.cost).toLocaleString()} &middot; ${spec.mpg} mpg &middot; ` +
            `${spec.fuel_tank_gallons} gal tank` +
            `</div></span></span>` +
            `<button class="remove-spec-button" data-id="${spec.id}">Delete</button>`;

        list.appendChild(item);
    }

    for (const button of list.querySelectorAll(".remove-spec-button")) {

        button.onclick = (event) => {
            event.stopPropagation();
            withSpinner(button, () => removeSpec(Number(button.dataset.id)));
        };
    }
}


//
// Clicking a spec just highlights it (click again to clear) - purely a
// visual focus like the Places tab's own selection, not tied to the map
// (a template has no location).
//
function selectSpec(specId) {

    selectedSpecId = selectedSpecId === specId ? null : specId;

    renderSpecList();
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

            fuel_tank_gallons: Number(document.getElementById("spec-fuel-tank").value),

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

    if (selectedSpecId === specId) {
        selectedSpecId = null;
    }

    loadSpecs();
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

    PLACE_FILTER_LEVELS.forEach((level, levelIndex) => {

        const values = distinctValuesAtLevel(levelIndex);

        if (values.length === 0) {
            return;
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
    });
}


function renderPlaceList() {

    renderPlaceFilterChips();

    const list = document.getElementById("place-list");

    list.innerHTML = "";

    for (const place of placesById.values()) {

        if (!placePassesAllFilters(place)) {
            continue;
        }

        const item = document.createElement("div");

        item.className = "vehicle-item list-row" + (place.id === selectedPlaceId ? " selected" : "");
        item.onclick = () => selectPlace(place.id);

        item.innerHTML =
            `<span class="spec-item-label"><span>${place.description}` +
            `<div class="spec-item-details">${place.address}</div></span></span>` +
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
function gasPriceColor(price, allPrices) {

    const min = Math.min(...allPrices);
    const max = Math.max(...allPrices);

    if (allPrices.length <= 1 || max === min) {
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
function renderGasPriceMarkers() {

    const seen = new Set();
    const allPrices = [...gasPricesByPlaceId.values()].map((gasPrice) => gasPrice.price_per_gallon);

    for (const gasPrice of gasPricesByPlaceId.values()) {

        seen.add(gasPrice.place_id);

        const color = gasPriceColor(gasPrice.price_per_gallon, allPrices);
        const label = `${gasPrice.description}: $${gasPrice.price_per_gallon.toFixed(2)}/gal`;

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

    gasPriceOverlayVisible = document.getElementById("gasprice-toggle").checked;

    for (const marker of gasPriceMarkers.values()) {

        if (gasPriceOverlayVisible) {
            marker.addTo(map);
        } else {
            map.removeLayer(marker);
        }
    }
}


function renderGasPriceList() {

    const list = document.getElementById("gasprice-list");

    list.innerHTML = "";

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
            `<span class="spec-item-label"><span>${gasPrice.description}` +
            `<div class="spec-item-details">$${gasPrice.price_per_gallon.toFixed(2)}/gal</div></span></span>` +
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
    const priceInput = document.getElementById("gasprice-price");

    const response = await fetch(API + "/api/gas-prices", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({
            description: descriptionInput.value,
            price_per_gallon: Number(priceInput.value)
        })

    });

    const data = await response.json();

    if (!response.ok) {
        alert(data.detail || "Could not add gas price");
        return;
    }

    descriptionInput.value = "";
    priceInput.value = "";

    loadGasPrices();
    loadPlaces();
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

    loadGasPrices();
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

        const driving = vehicle.status === "DRIVING" || vehicle.status === "STRANDED";
        const ready = vehicle.status === "READY";

        item.className = "vehicle-item vehicle-row vehicle-card" +
            (driving || ready ? " clickable" : "") +
            (driving && vehicle.id === selectedVehicleId ? " selected" : "") +
            (ready && vehicle.id === selectedTripVehicleId ? " selected" : "");

        if (driving) {
            item.onclick = () => selectVehicle(vehicle.id);
        } else if (ready) {
            item.onclick = () => selectTripVehicle(vehicle.id);
        }

        const imageUrl = vehicle.spec ? specImageUrl(vehicle.spec.image) : null;

        //
        // Trip-scoped, not the vehicle's lifetime odometer - these badges
        // mirror the In Route tab's own per-trip miles/gallons, so they
        // only render at all while this vehicle actually has an active
        // trip (activeTripsById), and show nothing otherwise.
        //
        const trip = activeTripsById.get(vehicle.id);
        const gallonsUsed = trip ? tripGallonsUsed(trip, vehicle) : null;

        //
        // A driving/stranded vehicle's fuel gauge comes from the live trip
        // (tripFuelRemaining()); a READY one shows its persisted tank level
        // instead - both against the same spec.fuel_tank_gallons capacity.
        //
        const fuelRemaining = trip ? tripFuelRemaining(trip) : vehicle.fuel_gallons;
        const fuelGauge = fuelRemaining !== null && vehicle.spec
            ? fuelGaugeHtml(fuelRemaining, vehicle.spec.fuel_tank_gallons)
            : "";

        item.innerHTML =
            `<div class="vehicle-card-top">` +
            (imageUrl ? `<img class="spec-thumb" src="${imageUrl}">` : "") +
            `<div class="vehicle-card-title">` +
            `<div class="vehicle-card-name">${vehicle.name}` +
            (vehicle.spec ? ` (${specLabel(vehicle.spec)})` : "") +
            `</div>` +
            `<div class="vehicle-card-location">${vehicle.current_location}</div>` +
            `</div>` +
            `<span class="status-badge status-${vehicle.status}">${vehicle.status}</span>` +
            `</div>` +
            (trip || fuelGauge
                ? `<div class="vehicle-card-meta">` +
                  (trip ? `<span class="miles-badge">${Math.round(trip.distance_miles).toLocaleString()} mi</span>` : "") +
                  (gallonsUsed !== null ? `<span class="gas-badge">&#9981; ${formatGallons(gallonsUsed)} gal</span>` : "") +
                  fuelGauge +
                  `</div>`
                : "") +
            (vehicle.status === "READY"
                ? `<div class="vehicle-card-actions">` +
                  `<button class="refuel-button" data-id="${vehicle.id}">Refuel</button>` +
                  `<button class="sell-button" data-id="${vehicle.id}">Sell</button>` +
                  `</div>`
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

        button.onclick = (event) => {
            event.stopPropagation();
            withSpinner(button, () => refuelVehicle(Number(button.dataset.id)));
        };
    }
}


async function refuelVehicle(vehicleId) {

    const response = await fetch(API + "/api/vehicles/" + vehicleId + "/refuel", { method: "POST" });

    if (!response.ok) {

        const data = await response.json();
        alert(data.detail || "Could not refuel vehicle");
        return;
    }

    loadVehicles();
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

    hint.style.display = matching.length === 0 ? "" : "none";

    //
    // showTab("paths") already prefills Origin from whichever vehicle is
    // focused (selectedTripVehicleId here, since this hint only renders
    // once a vehicle is selected for a trip - see the !vehicle guard
    // above) via its own vehicle-aware logic, so jumping there from this
    // link lands right where a "create one" click implies: a path form
    // already started from this vehicle's location.
    //
    hint.innerHTML = `No paths from ${vehicle.current_location} yet - ` +
        `<a href="#" class="hint-link" onclick="showTab('paths'); return false;">create one in the Paths tab</a>.`;

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

        showTab("inroute");
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
        renderInRouteList();
    }
}


//
// Gas used so far on the current trip is derived client-side -
// trip.distance_miles (from GET /api/trips/active's derive_position())
// divided by the vehicle's own spec.mpg, rather than a value stored/
// computed on the backend. Returns null when the vehicle or its spec (and
// so its mpg) isn't known yet.
//
function tripGallonsUsed(trip, vehicle) {

    const mpg = vehicle && vehicle.spec ? vehicle.spec.mpg : null;

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
// null when the vehicle/spec's mpg isn't trackable (see resolve_trip_progress()).
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


function fuelGaugeHtml(remainingGallons, capacityGallons) {

    const fraction = capacityGallons > 0 ? Math.max(0, Math.min(1, remainingGallons / capacityGallons)) : 0;

    return (
        `<span class="fuel-gauge" title="${formatGallons(remainingGallons)} / ${capacityGallons} gal">` +
        `<span class="fuel-gauge-bar"><span class="fuel-gauge-fill" style="width:${(fraction * 100).toFixed(0)}%;background:${fuelGaugeColor(fraction)}"></span></span>` +
        `<span class="fuel-gauge-label">${formatGallons(remainingGallons)}/${capacityGallons} gal</span>` +
        `</span>`
    );
}


function renderInRouteList() {

    const list = document.getElementById("inroute-list");

    list.innerHTML = "";

    for (const trip of activeTripsById.values()) {

        const vehicle = vehiclesById.get(trip.vehicle_id);

        const item = document.createElement("div");

        item.className = "vehicle-item" + (trip.vehicle_id === selectedVehicleId ? " selected" : "");
        item.onclick = () => selectVehicle(trip.vehicle_id);

        const gallonsUsed = tripGallonsUsed(trip, vehicle);

        item.innerHTML =
            `${vehicle ? vehicle.name : trip.vehicle_name} ` +
            `<span class="status-badge status-${trip.status}">${trip.status}</span>` +
            (gallonsUsed !== null
                ? ` <span class="gas-badge">&#9981; ${formatGallons(gallonsUsed)} gal</span>`
                : "");

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

    const gallonsUsed = tripGallonsUsed(trip, vehicle);
    const fuelRemaining = tripFuelRemaining(trip);

    const fuelLine = fuelRemaining !== null && spec
        ? `Fuel: ${formatGallons(fuelRemaining)} / ${spec.fuel_tank_gallons} gal<br>`
        : "";

    let statusLine;

    if (trip.status === "ARRIVED") {
        statusLine = "Arrived";
    } else if (trip.status === "STRANDED") {
        statusLine =
            `Out of fuel - stranded ${trip.distance_miles.toFixed(1)} mi in<br>` +
            `<button id="roadside-refuel-button" data-id="${trip.vehicle_id}">` +
            `Send roadside fuel ($${ROADSIDE_ASSIST_FEE_USD})</button>`;
    } else {
        statusLine =
            `Speed: ${Math.round(trip.speed_mph)} mph<br>` +
            `Arriving in: ${formatHMS(trip.remaining_sim_seconds)}`;
    }

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
        `Distance so far: ${trip.distance_miles.toFixed(1)} mi<br>` +
        (gallonsUsed !== null ? `Gas used: ${formatGallons(gallonsUsed)} gal<br>` : "") +
        fuelLine +
        statusLine;

    const roadsideButton = document.getElementById("roadside-refuel-button");

    if (roadsideButton) {
        roadsideButton.onclick = () => withSpinner(roadsideButton, () => roadsideRefuel(Number(roadsideButton.dataset.id)));
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


function renderPathList() {

    const list = document.getElementById("path-list");

    list.innerHTML = "";

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
    renderPathList();

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

    await loadPaths();
    loadPlaces();

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

    renderInRouteList();

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


loadSpecs().then(loadVehicles);
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

setInterval(() => {

    if (selectedVehicleId !== null) {
        fetchCurrentCity();
    }

}, 7000);
