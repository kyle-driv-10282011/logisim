//
// Same origin as the page: nginx (frontend/nginx.conf.template) passes
// /api/ on to the backend container, which publishes no port of its own.
//
const API = "";

//
// The save file being played (1-4), picked on the file-select screen
// (fileselect.js) before anything else loads. Every API call names it in an
// X-Save-Slot header - the backend scopes vehicles, trips, settings and the
// file's own jobs to it (current_slot() in app.py). Shared-world calls (gas
// prices, vehicle models) just ignore it.
//
let currentSlotId = null;

//
// Gold Doubloons, written exactly like US dollars: $14,328.45 (and
// -$12.30 when a file is in the red).
//
const DOUBLOON_FORMAT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function formatDoubloons(amount) {

    return DOUBLOON_FORMAT.format(amount);
}


function renderBalance(balance) {

    const display = document.getElementById("balance-display");

    display.textContent = formatDoubloons(balance);
    display.classList.toggle("negative", balance < 0);
}


function apiFetch(url, options = {}) {

    const headers = new Headers(options.headers || {});

    if (currentSlotId !== null) {
        headers.set("X-Save-Slot", String(currentSlotId));
    }

    //
    // Admin mode (admin.js). The backend answers 403 only for "admin
    // required", so a 403 on an elevated request means it has lapsed
    // (expired, or the password changed) - drop back to user.
    //
    const token = adminToken();

    if (token) {
        headers.set("X-Admin-Token", token);
    }

    return fetch(url, { ...options, headers }).then((response) => {

        if (response.status === 403 && token) {
            setAdminSession(null);
        }

        return response;
    });
}

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

    const response = await apiFetch(API + "/api/settings");
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

    renderBalance(settings.balance);

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

        const response = await apiFetch(API + "/api/settings", {

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

    const response = await apiFetch(API + "/api/settings", {

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

const tripLayers = new Map();      // vehicle_id -> { marker, routeGlow, routeLine, tripId }
let vehicleModelsById = new Map();         // vehicle_model_id -> vehicle model (from GET /api/vehicle-models)
let vehiclesById = new Map();      // vehicle_id -> vehicle - current fleet, not sold (from GET /api/vehicles)
let activeTripsById = new Map();   // vehicle_id -> trip (from the last poll)
let activeVehicleIds = new Set();  // vehicle ids seen on the last poll
let selectedVehicleId = null;      // vehicle id followed in the In Route tab
let selectedTripVehicleId = null;  // vehicle id chosen (in the Vehicles tab) to start a trip
let selectedVehicleModelId = null;         // vehicle model id highlighted in the Vehicle Models tab (purely visual, no map focus)


let restingVehicleMarker = null;   // dot marking a clicked non-driving vehicle's resting location
let savedGasStationMarker = null;  // pin on the station just added/updated via the Gas Prices form

let gasPricesByPlaceId = new Map(); // place_id -> gas price row (from GET /api/gas-prices)
const gasPriceMarkers = new Map();  // place_id -> persistent Leaflet circleMarker (the map overlay itself)
let gasPriceOverlayVisible = false; // toggled by the gas pump icon floating over the map - off by default, tens of thousands of markers is slow

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

//
// OpenStreetMap tiles. The 80's view turns them into a dark neon map
// (theme80s.css filters the tile pane), the black & white view greys
// them (themebw.css); blue & white and 90's show them as they are.
//
L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    }
).addTo(map);

//
// The map's own pieces for each view (Config -> View, see setView()) -
// canvas paths and Leaflet markers can't be restyled by a stylesheet:
//
//   routeGlow / routeCore: the route line, drawn twice - a wide faint glow
//     under a bright core in the 80's view, the glow hidden otherwise.
//   vehicleIcon: a driving vehicle's marker - a pulsing neon dot
//     (.neon-vehicle-marker in theme80s.css), a yellow square
//     (.nineties-vehicle-marker in theme90s.css) or Leaflet's own pin.
//   resting: the dot under a selected parked vehicle.
//
// Black & white uses blue & white's - themebw.css greys the whole page,
// map included.
//
const neonVehicleIcon = L.divIcon({
    className: "",
    html: '<div class="neon-vehicle-marker"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    tooltipAnchor: [0, -2]
});

const ninetiesVehicleIcon = L.divIcon({
    className: "",
    html: '<div class="nineties-vehicle-marker"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    tooltipAnchor: [0, -2]
});

const PLAIN_MAP_STYLE = {
    routeGlow: { color: "blue", weight: 12, opacity: 0 },
    routeCore: { color: "blue", weight: 5, opacity: 1 },
    vehicleIcon: new L.Icon.Default(),
    resting: { color: "#3388ff", weight: 2, fillColor: "#3388ff" }
};

const MAP_STYLES = {
    "80s": {
        routeGlow: { color: "#ff4fd8", weight: 12, opacity: 0.25 },
        routeCore: { color: "#ff4fd8", weight: 4, opacity: 0.95 },
        vehicleIcon: neonVehicleIcon,
        resting: { color: "#fff1a8", weight: 3, fillColor: "#2de2e6" }
    },
    "90s": {
        routeGlow: { color: "#ffffff", weight: 9, opacity: 1 },
        routeCore: { color: "#000080", weight: 5, opacity: 1 },
        vehicleIcon: ninetiesVehicleIcon,
        resting: { color: "#000000", weight: 2, fillColor: "#ffff00" }
    },
    blue: PLAIN_MAP_STYLE,
    bw: PLAIN_MAP_STYLE
};


function mapStyle() {

    return MAP_STYLES[currentView()] || MAP_STYLES["80s"];
}


//
// A small dot marking where a non-driving (READY/SOLD) vehicle is
// currently sitting - a driving vehicle already has its own live marker
// from pollActiveTrips(), so this is only ever shown for one that doesn't.
//
function showRestingVehicleMarker(vehicle) {

    clearRestingVehicleMarker();

    restingVehicleMarker = L.circleMarker([vehicle.current_lat, vehicle.current_lng], {

        radius: 8,
        fillOpacity: 1,
        ...mapStyle().resting

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
// A followed driving vehicle and a vehicle picked to drive compete for the
// same map focus (and the same highlighted card) - selecting either
// should drop the other, rather than leaving e.g. a followed driving
// vehicle still yanking the view back on every refresh. Every click entry
// point below calls this first, then applies its own selection on top.
//
function clearFocus() {

    selectedVehicleId = null;
    selectedTripVehicleId = null;

    clearRestingVehicleMarker();
    clearSavedGasStationMarker();
}


function renderFocusDependentViews() {

    renderVehicleList();
    renderDriveForm();
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

        const response = await apiFetch(API + "/api/jobs/" + jobId);
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

    //
    // Background jobs are admin-only (admin.js) - and per file, so there's
    // nothing to list before one is picked.
    //
    if (!isAdmin() || currentSlotId === null) {
        return;
    }

    const response = await apiFetch(API + "/api/jobs");
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
    myvehicles: "My Vehicles",
    paths: "Paths",
    gasprices: "Gas Prices",
    jobs: "Background Jobs",
    config: "Config"
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

    //
    // Admin is scoped to the tab it was unlocked for (admin.js).
    //
    relockAdminUnless(tab);

    for (const name of ["vehiclemodels", "myvehicles", "gasprices", "jobs", "config"]) {

        document.getElementById(`tab-${name}`).classList.toggle("active", name === tab);
        document.getElementById(`tab-button-${name}`).classList.toggle("active", name === tab);
    }

    document.getElementById("tab-menu-current").textContent = TAB_LABELS[tab];
    closeTabMenu();

    //
    // Jobs only refresh on live-update events now (see refreshLiveData()),
    // so opening the tab fetches them fresh rather than showing whatever
    // the last event left behind.
    //
    if (tab === "jobs") {
        loadJobs();
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

    const response = await apiFetch(API + "/api/vehicle-models");
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
// a visual focus, not tied to the map (a vehicle model has no location).
//
function selectVehicleModel(vehicleModelId) {

    selectedVehicleModelId = selectedVehicleModelId === vehicleModelId ? null : vehicleModelId;

    renderVehicleModelList();
}


async function addVehicleModel() {

    const response = await apiFetch(API + "/api/vehicle-models", {

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


//
// Config tab's vehicle model restore (POST /api/vehicle-models/upload) - the
// other half of its "Export all vehicle models" link. Small enough to run
// inline on the backend, so the result comes straight back, no job to poll.
//
async function uploadVehicleModels() {

    const fileInput = document.getElementById("vehicle-model-file-input");
    const result = document.getElementById("vehicle-model-upload-result");

    const show = (kind, message) => {
        result.className = "form-result " + kind;
        result.textContent = message;
    };

    if (!fileInput.files.length) {
        show("error", "Not imported - choose a vehicle model CSV first.");
        return;
    }

    const formData = new FormData();
    formData.append("file", fileInput.files[0]);

    let response;
    let data;

    try {
        response = await apiFetch(API + "/api/vehicle-models/upload", { method: "POST", body: formData });
        data = await response.json();
    } catch (e) {
        show("error", "Not imported - couldn't reach the server. Check your connection and try again.");
        return;
    }

    if (!response.ok) {
        show("error", "Not imported - " + (data.detail || "the server couldn't read that file."));
        return;
    }

    const parts = [`${data.created} added`, `${data.updated} updated`];

    if (data.errors.length) {

        parts.push(`${data.errors.length} skipped`);
        console.warn("Vehicle model import errors:", data.errors);

        show(
            data.created || data.updated ? "success" : "error",
            `Imported: ${parts.join(", ")}. First problem - row ${data.errors[0].row}: ${data.errors[0].error}`
        );

    } else {
        show("success", `Imported: ${parts.join(", ")}.`);
    }

    fileInput.value = "";

    loadVehicleModels();
}


async function removeVehicleModel(vehicleModelId) {

    const vehicleModel = vehicleModelsById.get(vehicleModelId);

    if (!confirm(`Delete vehicle model "${vehicleModel ? vehicleModelLabel(vehicleModel) : vehicleModelId}"?`)) {
        return;
    }

    const response = await apiFetch(API + "/api/vehicle-models/" + vehicleModelId, { method: "DELETE" });

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

    const response = await apiFetch(API + "/api/gas-prices");
    const gasPrices = await response.json();

    gasPricesByPlaceId = new Map(gasPrices.map((gasPrice) => [gasPrice.place_id, gasPrice]));

    renderGasPriceMarkers();
    renderGasPriceList();
}


//
// Unlike showRestingVehicleMarker() (one marker for whatever's selected),
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

    //
    // Markers are only built while the overlay is showing - creating one
    // per station (tens of thousands after a bulk import) is what made page
    // load slow. toggleGasPriceOverlay() calls back in here when it's
    // turned on, and the diff below picks up whatever changed meanwhile.
    //
    if (!gasPriceOverlayVisible) {
        return;
    }

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

    if (gasPriceOverlayVisible) {
        renderGasPriceMarkers();
        return;
    }

    for (const marker of gasPriceMarkers.values()) {
        map.removeLayer(marker);
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


//
// Inline result line under the Add / Update Price form (gasprice-add-result)
// rather than alert() popups - a green confirmation of exactly what was
// saved where, or a red explanation of what went wrong, left in place until
// the next attempt so it can be read at leisure.
//
function showGasPriceResult(kind, message) {

    const result = document.getElementById("gasprice-add-result");

    result.className = "form-result " + kind;
    result.textContent = message;
}


function gasPriceErrorMessage(data, fallback) {

    const detail = data && data.detail;

    if (detail && typeof detail === "object") {
        return detail.message || fallback;
    }

    return detail || fallback;
}


async function addGasPrice() {

    const descriptionInput = document.getElementById("gasprice-description");
    const brandInput = document.getElementById("gasprice-brand");
    const priceInput = document.getElementById("gasprice-price");

    const description = descriptionInput.value.trim();
    const price = Number(priceInput.value);

    if (!description) {
        showGasPriceResult("error", "Not saved - enter the station's location (an address, or a name with the city and state).");
        return;
    }

    if (!(price > 0)) {
        showGasPriceResult("error", "Not saved - enter a price per gallon above $0.");
        return;
    }

    showGasPriceResult("pending", `Looking up "${description}"...`);

    const submit = (confirmLocation) => apiFetch(API + "/api/gas-prices", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({
            description,
            brand: brandInput.value.trim() || null,
            price_per_gallon: price,
            confirm_location: confirmLocation
        })

    });

    let response;
    let data;

    try {

        response = await submit(false);
        data = await response.json();

        //
        // The description resolved somewhere that isn't a gas station (e.g.
        // "gas station near X" matching town X itself - see
        // resolve_gas_station_place() in app.py). Say what it found and let
        // the user decide, rather than silently pricing the middle of town.
        //
        if (response.status === 409 && data.detail && data.detail.code === "not_a_gas_station") {

            if (!confirm(`${data.detail.message}\n\nSave the price at that location anyway?`)) {
                showGasPriceResult("error", `Not saved - ${data.detail.message}`);
                return;
            }

            response = await submit(true);
            data = await response.json();
        }

    } catch (e) {
        showGasPriceResult("error", "Not saved - couldn't reach the server. Check your connection and try again.");
        return;
    }

    if (!response.ok) {
        showGasPriceResult("error", "Not saved - " + gasPriceErrorMessage(data, "the server couldn't add this gas price."));
        return;
    }

    const previous = gasPricesByPlaceId.get(data.place_id);
    const label = gasStationLabel(data.brand, data.description);
    const where = data.place && data.place.address ? ` at ${data.place.address}` : "";

    showGasPriceResult(
        "success",
        previous
            ? `Updated ${label}${where}: $${previous.price_per_gallon.toFixed(2)} → $${data.price_per_gallon.toFixed(2)}/gal.`
            : `Added ${label}${where} at $${data.price_per_gallon.toFixed(2)}/gal.`
    );

    descriptionInput.value = "";
    brandInput.value = "";
    priceInput.value = "";

    //
    // Patches local state from this response instead of loadGasPrices() -
    // that re-fetches the *entire* multi-megabyte list, which turned "add
    // one price" into the same multi-second cost as a full page reload
    // once there were tens of thousands of rows. The response already has
    // everything one new/updated row needs.
    //
    gasPricesByPlaceId.set(data.place_id, data);

    renderGasPriceMarkers();
    renderGasPriceList();

    showSavedGasStation(data);
}


//
// Centers the map on a just-saved station and pins it - its own marker,
// not the overlay's, since the overlay is off by default (tens of
// thousands of markers is slow) and the point is to show *this* one
// either way. Zooms in only if the map is further out than street-ish
// level, so a user already zoomed in close isn't yanked back out.
//
const SAVED_GAS_STATION_MIN_ZOOM = 14;

//
// The pin is a "here's what you just saved" cue, not a permanent marker -
// it removes itself after this long.
//
const SAVED_GAS_STATION_PIN_MS = 60 * 1000;

let savedGasStationTimer = null;

function showSavedGasStation(gasPrice) {

    clearSavedGasStationMarker();

    const latLng = [gasPrice.lat, gasPrice.lng];

    savedGasStationMarker = L.circleMarker(latLng, {

        radius: 9,
        color: "#1b5e20",
        weight: 3,
        fillColor: "#2f9e44",
        fillOpacity: 1

    }).addTo(map);

    savedGasStationMarker.bindTooltip(
        `${gasStationLabel(gasPrice.brand, gasPrice.description)}: $${gasPrice.price_per_gallon.toFixed(2)}/gal`,
        { permanent: true, direction: "top", offset: [0, -10] }
    ).openTooltip();

    map.setView(latLng, Math.max(map.getZoom(), SAVED_GAS_STATION_MIN_ZOOM));

    savedGasStationTimer = setTimeout(clearSavedGasStationMarker, SAVED_GAS_STATION_PIN_MS);
}


function clearSavedGasStationMarker() {

    clearTimeout(savedGasStationTimer);
    savedGasStationTimer = null;

    if (savedGasStationMarker) {
        map.removeLayer(savedGasStationMarker);
        savedGasStationMarker = null;
    }
}


async function removeGasPrice(placeId) {

    const gasPrice = gasPricesByPlaceId.get(placeId);

    if (!confirm(`Delete gas price for "${gasPrice ? gasPrice.description : placeId}"?`)) {
        return;
    }

    const response = await apiFetch(API + "/api/gas-prices/" + placeId, { method: "DELETE" });

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

    const response = await apiFetch(API + "/api/gas-prices/upload", {

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
}


async function loadVehicles() {

    const response = await apiFetch(API + "/api/vehicles");
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
    renderDriveForm();
}


function renderVehicleList() {

    const list = document.getElementById("vehicle-list");

    list.innerHTML = "";

    //
    // Every vehicle stays listed while one is selected - the selected card
    // is just highlighted (.selected), and a driving one's details show in
    // the map overlay (renderVehicleOverlay()) rather than inline here.
    //
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
        // pollActiveTrips()'s setsEqual() check) - going DRIVING -> STRANDED,
        // or back to DRIVING after a roadside refuel, doesn't change set
        // membership at all, so that fetch never fires and vehicle.status
        // stays stuck on whichever it was last loaded as. trip.status (from
        // the latest live-update refresh) is always current and only ever
        // DRIVING or STRANDED (active_trips() drops ARRIVED), so it wins
        // whenever there's a trip - both directions, not just stranding.
        //
        const displayStatus = trip ? trip.status : vehicle.status;

        const driving = displayStatus === "DRIVING" || displayStatus === "STRANDED" || displayStatus === "REFUELING";
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
                : "");

        list.appendChild(item);
    }

    renderVehicleOverlay();

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
    for (const button of document.querySelectorAll("#vehicle-overlay .divert-nearest-button")) {

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
// refueling instantly, so this has to poll it the same way driveToDestination()
// and divertToGasStation() do rather than treating every response as
// already finished.
//
let refuelInFlightVehicleId = null;

async function refuelVehicle(vehicleId) {

    refuelInFlightVehicleId = vehicleId;
    renderVehicleList();

    try {

        const response = await apiFetch(API + "/api/vehicles/" + vehicleId + "/refuel", { method: "POST" });

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
        refreshLiveData();
    }
}


async function sellVehicle(vehicleId) {

    const vehicle = vehiclesById.get(vehicleId);

    if (!confirm(`Sell ${vehicle ? vehicle.name : "this vehicle"}?`)) {
        return;
    }

    const response = await apiFetch(API + "/api/vehicles/" + vehicleId + "/sell", { method: "POST" });

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
// Paths are behind the scenes now (see forget_unused_paths() in app.py):
// selecting a READY vehicle shows a destination box, and driving there
// creates the path from the vehicle's current place and starts the trip
// in one background job - nothing to pick, and nothing left behind once
// it arrives.
//
function renderDriveForm() {

    const form = document.getElementById("drive-form");
    const vehicle = vehiclesById.get(selectedTripVehicleId);

    if (!vehicle) {
        form.style.display = "none";
        return;
    }

    form.style.display = "";

    document.getElementById("drive-form-label").textContent =
        `Drive ${vehicle.name} from ${vehicle.current_location} to:`;
}


async function driveToDestination() {

    const vehicleId = selectedTripVehicleId;

    if (vehicleId === null) {
        return;
    }

    const input = document.getElementById("drive-destination");

    const response = await apiFetch(API + "/api/vehicles/" + vehicleId + "/drive", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({ destination: input.value })

    });

    const submitted = await response.json();

    if (!response.ok) {
        alert(submitted.detail || "Could not start trip");
        return;
    }

    try {
        await pollJob(submitted.job_id);
    } catch (e) {

        alert(e.message);

        //
        // A refused drive (e.g. "Vehicle already on a trip") usually means
        // this page's view of the vehicle is out of date - re-fetch so the
        // card shows what it's really doing instead of inviting a retry.
        //
        await refreshLiveData();
        await loadVehicles();
        return;
    }

    input.value = "";

    await refreshLiveData();
    await loadVehicles();

    //
    // Keep following the same vehicle, now as a driving one (its live
    // card and map position) rather than dropping back to the full list.
    //
    selectVehicle(vehicleId);

    const trip = activeTripsById.get(vehicleId);

    if (trip) {
        map.fitBounds(L.latLngBounds(trip.route), { paddingBottomRight: vehicleOverlayInset() });
    }
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
        fetchCurrentCity();
    }

    //
    // Rendered before panning, so the overlay's size is known and the
    // vehicle lands clear of it.
    //
    renderFocusDependentViews();

    const trip = activeTripsById.get(selectedVehicleId);

    if (trip) {
        panToVehicle(trip.position);
    }
}


//
// The selected driving vehicle's details, over the map's bottom-right
// corner. Collapsing shrinks it to its header row; the choice sticks across
// selections. The vehicle is kept out from under it by panToVehicle().
//
let vehicleOverlayCollapsed = false;

function renderVehicleOverlay() {

    const overlay = document.getElementById("vehicle-overlay");
    const vehicle = vehiclesById.get(selectedVehicleId);
    const trip = activeTripsById.get(selectedVehicleId);

    if (!vehicle || !trip) {
        overlay.style.display = "none";
        overlay.innerHTML = "";
        return;
    }

    overlay.style.display = "";
    overlay.classList.toggle("collapsed", vehicleOverlayCollapsed);

    overlay.innerHTML =
        `<div class="vehicle-overlay-header" title="${vehicleOverlayCollapsed ? "Show" : "Hide"} details">` +
        `<span class="vehicle-overlay-toggle">${vehicleOverlayCollapsed ? "&#9650;" : "&#9660;"}</span>` +
        `<span class="vehicle-overlay-name">${vehicle.name}</span>` +
        `<span class="status-badge status-${trip.status}">${trip.status}</span>` +
        `<button class="vehicle-overlay-close" title="Deselect">&times;</button>` +
        `</div>` +
        (vehicleOverlayCollapsed ? "" : vehicleDetailHtml(vehicle, trip));

    overlay.querySelector(".vehicle-overlay-header").onclick = toggleVehicleOverlay;

    overlay.querySelector(".vehicle-overlay-close").onclick = (event) => {
        event.stopPropagation();
        selectVehicle(selectedVehicleId);
    };
}


function toggleVehicleOverlay() {

    vehicleOverlayCollapsed = !vehicleOverlayCollapsed;

    renderVehicleList();

    const trip = activeTripsById.get(selectedVehicleId);

    if (trip) {
        panToVehicle(trip.position);
    }
}


//
// How much of the map's right or bottom edge the vehicle overlay covers -
// whichever leaves the roomier clear area (beside it vs. above it), the
// other being 0. As { x, y } it doubles as fitBounds' paddingBottomRight.
//
function vehicleOverlayInset() {

    const overlay = document.getElementById("vehicle-overlay");

    if (overlay.style.display === "none") {
        return L.point(0, 0);
    }

    const size = map.getSize();
    const mapRect = map.getContainer().getBoundingClientRect();
    const rect = overlay.getBoundingClientRect();

    const clearWidth = rect.left - mapRect.left;
    const clearHeight = rect.top - mapRect.top;

    return clearWidth * size.y >= clearHeight * size.x
        ? L.point(size.x - clearWidth, 0)
        : L.point(0, size.y - clearHeight);
}


//
// Centers the vehicle in the part of the map the overlay leaves clear, so
// following it never parks it underneath. Only while the overlay is open
// and expanded - collapsing it stops the map following, leaving it free to
// pan around, and expanding it again picks the vehicle back up.
//
function panToVehicle(latLng) {

    if (vehicleOverlayCollapsed || document.getElementById("vehicle-overlay").style.display === "none") {
        return;
    }

    const zoom = map.getZoom();
    const offset = vehicleOverlayInset().divideBy(2);

    map.panTo(map.unproject(map.project(latLng, zoom).add(offset), zoom));
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

    const response = await apiFetch(API + "/api/vehicles/" + vehicleId + "/city");

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

        const response = await apiFetch(API + "/api/vehicles/" + vehicleId + "/gas-station-ahead");

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
// The detail block in the map overlay (renderVehicleOverlay()) for the
// selected DRIVING/STRANDED vehicle. Skips anything its compact card in
// the list already shows (model, trip miles, gas used, fuel gauge) so
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

    } else if (trip.status === "REFUELING") {

        statusLine = `&#9981; Refueling - back on the road to ${trip.resume_destination} shortly`;

    } else if (trip.status === "STRANDED") {

        statusLine =
            `Out of fuel - stranded ${trip.distance_miles.toFixed(1)} mi in<br>` +
            `<button id="roadside-refuel-button" data-id="${trip.vehicle_id}">` +
            `Send roadside fuel (gas + ${formatDoubloons(ROADSIDE_ASSIST_FEE)} fee)</button>`;

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

        const response = await apiFetch(API + "/api/vehicles/" + vehicleId + "/divert-to-gas-station", {

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

        refreshLiveData();

    } catch (e) {
        alert(e.message);
    } finally {
        divertInFlightVehicleId = null;
        renderVehicleList();
    }
}


//
// Mirrors ROADSIDE_ASSIST_FEE in app.py - charged on top of a full tank of
// gas at the nearest station's price, and never refunded.
//
const ROADSIDE_ASSIST_FEE = 75;


async function roadsideRefuel(vehicleId) {

    const vehicle = vehiclesById.get(vehicleId);

    const tankGallons = vehicle && vehicle.vehicle_model ? vehicle.vehicle_model.fuel_tank_gallons : null;

    if (!confirm(
        `Send roadside fuel to ${vehicle ? vehicle.name : "this vehicle"}?

` +
        `Costs a full tank${tankGallons ? ` (${tankGallons} gal)` : ""} at the nearest gas station's price, ` +
        `plus a ${formatDoubloons(ROADSIDE_ASSIST_FEE)} assistance fee. The gas is refunded when the trip ` +
        `finishes; the fee isn't.`
    )) {
        return;
    }

    const response = await apiFetch(API + "/api/vehicles/" + vehicleId + "/roadside-refuel", { method: "POST" });

    if (!response.ok) {

        const data = await response.json();
        alert(data.detail || "Could not send roadside fuel");
        return;
    }

    //
    // Refueling un-strands the trip, so it has events again - this tab's
    // own actions always re-fetch (and re-arm the next live-update event)
    // rather than waiting on one that may never come.
    //
    refreshLiveData();
}


async function addVehicle() {

    const vehicleModelId = document.getElementById("vehicle-model-select").value;

    if (!vehicleModelId) {
        alert("Add a hauling vehicle model first");
        return;
    }

    const response = await apiFetch(API + "/api/vehicles", {

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
}


async function pollActiveTrips() {

    const refreshOption = activeRefreshOption();

    const params = new URLSearchParams({ refresh_on: refreshOption.refreshOn });

    if (refreshOption.everyMiles) {
        params.set("every_miles", refreshOption.everyMiles);
    }

    const response = await apiFetch(API + "/api/trips/active?" + params);
    const data = await response.json();

    scheduleNextRefresh(data.next_refresh_seconds);

    const seen = new Set();

    const previousTripsById = activeTripsById;

    activeTripsById = new Map(data.trips.map((trip) => [trip.vehicle_id, trip]));

    //
    // A gas-station detour that just reached its station has no trip until
    // the backend's resume job routes the next leg (see
    // settle_arrived_vehicles() in app.py), which can take a while when
    // the job pool is busy. Rather than dropping the vehicle off the map
    // and closing its spotlight for that gap, its last leg stays on as a
    // REFUELING placeholder at the station until the real next leg shows
    // up - or until no trip-starting job is left (it failed) or
    // PENDING_LEG_TIMEOUT_MS passes.
    //
    let newPlaceholder = false;

    for (const [vehicleId, previous] of previousTripsById) {

        if (activeTripsById.has(vehicleId) || !data.trip_job_in_flight) {
            continue;
        }

        if (previous.status === "REFUELING") {

            if (Date.now() - previous.refuelingSince < PENDING_LEG_TIMEOUT_MS) {
                activeTripsById.set(vehicleId, previous);
            }

        } else if (previous.status === "DRIVING" && previous.resume_destination) {

            activeTripsById.set(vehicleId, refuelingPlaceholder(previous));
            newPlaceholder = true;
        }
    }

    for (const trip of activeTripsById.values()) {

        seen.add(trip.vehicle_id);

        let layer = tripLayers.get(trip.vehicle_id);

        //
        // The whole journey, not just the leg being driven: after a
        // gas-station detour the current leg only starts at the station, so
        // what was already driven (journey_route_before) goes in front of it.
        //
        const journeyRoute = trip.journey_route_before.concat(trip.route);

        if (!layer) {

            const style = mapStyle();

            const routeGlow = L.polyline(journeyRoute, { ...style.routeGlow, interactive: false }).addTo(map);
            const routeLine = L.polyline(journeyRoute, style.routeCore).addTo(map);

            const marker = L.marker(trip.position, { icon: style.vehicleIcon }).addTo(map);

            marker.bindTooltip(
                "", { permanent: true, direction: "top", offset: [0, -10] }
            ).openTooltip();

            marker.on("click", () => selectVehicle(trip.vehicle_id));

            layer = { marker, routeGlow, routeLine, tripId: trip.trip_id };

            tripLayers.set(trip.vehicle_id, layer);
        }

        //
        // A vehicle stays on the map from one leg to the next (diverting to a
        // station, resuming after it), so its line is redrawn whenever the leg
        // changes - otherwise it kept showing whichever leg it was first
        // drawn for.
        //
        if (layer.tripId !== trip.trip_id) {
            layer.routeGlow.setLatLngs(journeyRoute);
            layer.routeLine.setLatLngs(journeyRoute);
            layer.tripId = trip.trip_id;
        }

        layer.marker.setLatLng(trip.position);

        layer.marker.setTooltipContent(
            trip.status === "ARRIVED"
                ? `${trip.vehicle_name}: Arrived`
                : trip.status === "REFUELING"
                ? `${trip.vehicle_name}: refueling`
                : trip.status === "STRANDED"
                ? `${trip.vehicle_name}: Out of fuel - stranded`
                : `${trip.vehicle_name}: arriving in ${formatHMS(trip.remaining_sim_seconds)}`
        );

        //
        // Keep the map centered on the selected vehicle as it moves, without
        // touching zoom (a full fitBounds/setView would fight the user's view)
        // - unless its overlay is collapsed (see panToVehicle()).
        //
        if (trip.vehicle_id === selectedVehicleId) {
            panToVehicle(trip.position);
        }
    }

    //
    // Any vehicle we were tracking that's no longer in this poll's response
    // has fully expired past the arrival grace period - remove its layers.
    //
    for (const [vehicleId, layer] of tripLayers) {

        if (!seen.has(vehicleId)) {

            map.removeLayer(layer.marker);
            map.removeLayer(layer.routeGlow);
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

    //
    // A new placeholder keeps the vehicle in the active set, but its detour
    // did settle (fuel bought, miles added) - so the vehicle list is
    // re-fetched for that the same as for a change in the set.
    //
    if (newPlaceholder || !setsEqual(seen, activeVehicleIds)) {

        activeVehicleIds = seen;

        loadVehicles();
    }
}


const PENDING_LEG_TIMEOUT_MS = 10 * 60 * 1000;

//
// The last poll's detour leg, parked at its gas station with a full tank
// while the next leg is routed. distance_miles goes to 0 since the detour's
// miles are now in the vehicle's settled total (the odometer adds the
// two); the trip meter keeps counting the whole journey. trip_id is kept,
// so the route line isn't redrawn until the real next leg arrives.
//
function refuelingPlaceholder(trip) {

    const vehicle = vehiclesById.get(trip.vehicle_id);
    const detourMiles = trip.distance_miles + (trip.remaining_miles || 0);

    return {
        ...trip,
        status: "REFUELING",
        refuelingSince: Date.now(),
        position: trip.route[trip.route.length - 1],
        speed_mph: 0,
        distance_miles: 0,
        remaining_miles: null,
        trip_meter_miles: (trip.trip_meter_miles ?? trip.distance_miles) - trip.distance_miles + detourMiles,
        fuel_gallons_remaining: vehicle && vehicle.vehicle_model
            ? vehicle.vehicle_model.fuel_tank_gallons
            : trip.fuel_gallons_remaining
    };
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


//
// The gas price list is several MB once bulk-imported, so it waits for the
// vehicle list rather than competing with it for bandwidth and parse time.
// A failed first load replaces the vehicle list's loading placeholder
// (see index.html) with an error instead of leaving it spinning.
//

//
// Live updates are event-driven rather than a fixed-rate poll: each GET
// /api/trips/active names the Config tab's refresh_on mode, and the
// backend answers with next_refresh_seconds - when the next such event
// (a mile mark, a refill, an arrival) is due for any driving vehicle -
// so nothing is fetched in between. See seconds_until_refresh_event() in
// app.py for exactly what counts as each event.
//
// The map badge next to the gas station toggle only switches between
// "off" and whatever the slider is set to. updateSimClock() keeps ticking
// either way: it only extrapolates locally from the last loadSettings()
// anchor, no request. Both settings are remembered per browser; storage
// can throw (private mode, blocked site data), in which case they just
// fall back to the defaults below.
//
//
// Saved by key, not slider position, so adding a stop in the middle (like
// "1 mile" was) doesn't silently shift what a browser had saved.
//
const REFRESH_OPTIONS = [
    { key: "never", label: "Never", refreshOn: "never" },
    { key: "refill", label: "On Fuel Refill", refreshOn: "refill" },
    { key: "miles-1", label: "1 mile", refreshOn: "miles", everyMiles: 1 },
    { key: "miles-10", label: "10 miles", refreshOn: "miles", everyMiles: 10 },
    { key: "miles-50", label: "50 miles", refreshOn: "miles", everyMiles: 50 },
    { key: "miles-100", label: "100 Miles", refreshOn: "miles", everyMiles: 100 },
    { key: "miles-1000", label: "1000 Miles", refreshOn: "miles", everyMiles: 1000 },
    { key: "arrival", label: "On arrival", refreshOn: "arrival" }
];

const DEFAULT_REFRESH_INDEX = REFRESH_OPTIONS.findIndex((option) => option.key === "miles-10");

const LIVE_UPDATES_STORAGE_KEY = "liveUpdatesEnabled";
const REFRESH_OPTION_STORAGE_KEY = "refreshOption";

//
// Rechecked after a refresh that failed outright (backend down, network
// blip) - otherwise nothing would ever schedule the next one.
//
const REFRESH_RETRY_SECONDS = 5;

//
// next_refresh_seconds is the exact moment of the event, so this lands
// just past it - by then the backend's settle has definitely seen it.
//
const REFRESH_EVENT_BUFFER_MS = 500;

let liveUpdatesEnabled = true;
let refreshIndex = DEFAULT_REFRESH_INDEX;
let refreshTimer = null;

try {

    liveUpdatesEnabled = localStorage.getItem(LIVE_UPDATES_STORAGE_KEY) !== "false";

    const storedKey = localStorage.getItem(REFRESH_OPTION_STORAGE_KEY);
    const storedIndex = REFRESH_OPTIONS.findIndex((option) => option.key === storedKey);

    if (storedIndex !== -1) {
        refreshIndex = storedIndex;
    }

} catch (e) {
    // fall back to the defaults
}

function saveSetting(key, value) {

    try {
        localStorage.setItem(key, String(value));
    } catch (e) {
        // not persisted, still applies for this page load
    }
}

//
// What pollActiveTrips() actually asks the backend for - "never" while the
// badge is off, so an off badge stops scheduling the same way the Never
// setting does.
//
function activeRefreshOption() {

    return liveUpdatesEnabled ? REFRESH_OPTIONS[refreshIndex] : REFRESH_OPTIONS[0];
}

//
// "Off" - the badge paused, or the slider on Never - still isn't frozen
// forever: a slow fallback refresh keeps the page from drifting
// arbitrarily far out of date. It replaces whatever the backend said
// (always nothing for "never") rather than adding to it.
//
const OFF_REFRESH_SECONDS = 20 * 60;

function refreshIsOff() {

    return activeRefreshOption().refreshOn === "never";
}

function scheduleNextRefresh(seconds) {

    clearTimeout(refreshTimer);
    refreshTimer = null;

    if (refreshIsOff()) {
        seconds = OFF_REFRESH_SECONDS;
    }

    if (seconds === null || seconds === undefined) {
        return;
    }

    refreshTimer = setTimeout(refreshLiveData, Math.max(1, seconds) * 1000 + REFRESH_EVENT_BUFFER_MS);
}

//
// One refresh event: everything that used to poll on its own timer
// (active trips, jobs, settings re-sync, the selected vehicle's city)
// now updates together, only when an event is due. pollActiveTrips()
// schedules the next one itself from its response.
//
async function refreshLiveData() {

    try {
        await pollActiveTrips();
    } catch (e) {
        scheduleNextRefresh(REFRESH_RETRY_SECONDS);
        return;
    }

    loadJobs();
    loadSettings();

    if (selectedVehicleIsDriving()) {
        fetchCurrentCity();
    }
}

function renderLiveUpdatesToggle() {

    const toggle = document.getElementById("live-updates-toggle");
    const label = REFRESH_OPTIONS[refreshIndex].label;

    toggle.classList.toggle("active", liveUpdatesEnabled);
    toggle.title = liveUpdatesEnabled
        ? `Live updates on (${label}) - click to pause`
        : `Live updates paused (refreshing every 20 min) - click to resume (${label})`;
}

function toggleLiveUpdates() {

    liveUpdatesEnabled = !liveUpdatesEnabled;

    saveSetting(LIVE_UPDATES_STORAGE_KEY, liveUpdatesEnabled);
    renderLiveUpdatesToggle();

    //
    // Pausing swaps the pending event for the slow off-fallback (see
    // scheduleNextRefresh()). Resuming catches up right away - vehicles
    // may have moved a long way while paused - and that refresh's
    // response schedules the next event.
    //
    if (liveUpdatesEnabled) {
        refreshLiveData();
    } else {
        scheduleNextRefresh(null);
    }
}

function renderRefreshIntervalControl() {

    document.getElementById("refresh-interval-slider").value = refreshIndex;
    document.getElementById("refresh-interval-value").textContent = REFRESH_OPTIONS[refreshIndex].label;
}

//
// Config -> View: black & white, blue & white (the app's original look),
// 80's (the default) or 90's (a Windows 95 desktop). A per-browser preference like the refresh setting -
// each person picks their own. The stylesheet half is switched by enabling
// one of index.html's theme <link>s (an inline script there applies the
// saved choice before first paint); the map half is restyled here.
//
const VIEW_STORAGE_KEY = "logisim-view";
const VIEWS = ["bw", "blue", "80s", "90s"];

//
// Each view's stylesheet <link> in index.html - blue & white has none.
//
const VIEW_STYLESHEETS = { bw: "theme-bw-css", "80s": "theme-80s-css", "90s": "theme-90s-css" };

function currentView() {

    return document.documentElement.dataset.view || "80s";
}


function setView(view) {

    if (!VIEWS.includes(view)) {
        return;
    }

    try {
        localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch (e) {
        // just won't be remembered next time
    }

    document.documentElement.dataset.view = view;

    for (const [stylesheetView, linkId] of Object.entries(VIEW_STYLESHEETS)) {
        document.getElementById(linkId).disabled = stylesheetView !== view;
    }

    renderViewChoice();
    restyleMap();
}


function renderViewChoice() {

    for (const input of document.querySelectorAll('input[name="view-choice"]')) {
        input.checked = input.value === currentView();
    }
}


function restyleMap() {

    const style = mapStyle();

    for (const layer of tripLayers.values()) {
        layer.routeGlow.setStyle(style.routeGlow);
        layer.routeLine.setStyle(style.routeCore);
        layer.marker.setIcon(style.vehicleIcon);
    }

    if (restingVehicleMarker) {
        restingVehicleMarker.setStyle(style.resting);
    }
}


renderViewChoice();


function renderRefreshIntervalTicks() {

    const ticks = document.getElementById("refresh-interval-ticks");

    ticks.innerHTML = "";

    REFRESH_OPTIONS.forEach((option, index) => {

        const tick = document.createElement("span");

        tick.textContent = option.label;
        tick.onclick = () => setRefreshInterval(index);

        ticks.appendChild(tick);
    });
}

function setRefreshInterval(index) {

    refreshIndex = Number(index);

    saveSetting(REFRESH_OPTION_STORAGE_KEY, REFRESH_OPTIONS[refreshIndex].key);

    renderRefreshIntervalControl();
    renderLiveUpdatesToggle();

    //
    // Re-asks with the new mode so the pending event is replaced by the
    // new mode's next one, rather than firing on the old schedule first.
    //
    refreshLiveData();
}

//
// Gated on the selected vehicle actually still being in activeTripsById,
// not just selectedVehicleId being set - /api/vehicles/{id}/city 404s for
// a vehicle that isn't currently driving (READY, SOLD, or just arrived and
// past its grace period), and a vehicle stays "selected" in the In Route
// tab long after it stops driving (nothing ever clears the selection on
// its own). Without this check, every refresh would fire it for a
// long-idle selection, filling the browser console with failed-request
// noise that no amount of try/catch on the JS side can suppress - the
// browser logs the network failure itself.
//
function selectedVehicleIsDriving() {
    return selectedVehicleId !== null && activeTripsById.has(selectedVehicleId);
}

renderRefreshIntervalTicks();
renderRefreshIntervalControl();
renderLiveUpdatesToggle();

//
// Loads the chosen save file's world - called once by the file-select
// screen (fileselect.js) after a file is picked or started. Picking a
// different file later reloads the page instead of re-calling this, so
// nothing from the previous file's map layers or state can leak across.
//
function startGame(slotId, slotName) {

    currentSlotId = slotId;

    document.getElementById("current-file-label").textContent = `FILE ${slotId} · ${slotName}`;

    //
    // The gas price list is several MB once bulk-imported, so it waits for
    // the vehicle list rather than competing with it for bandwidth and
    // parse time. A failed first load replaces the vehicle list's loading
    // placeholder (see index.html) with an error instead of leaving it
    // spinning.
    //
    loadVehicleModels()
        .then(loadVehicles)
        .catch(() => {
            document.getElementById("vehicle-list").innerHTML =
                '<div class="list-loading-error">Could not load vehicles - refresh to try again.</div>';
        })
        .finally(loadGasPrices);

    loadJobs();
    loadSettings();

    //
    // The first load always happens, badge on or off - with it off (or set
    // to Never) the next one is just the 20-minute fallback.
    //
    pollActiveTrips().catch(() => scheduleNextRefresh(REFRESH_RETRY_SECONDS));

    setInterval(updateSimClock, 1000);
}
