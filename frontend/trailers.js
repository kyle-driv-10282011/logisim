//
// Trailers. A vehicle with a hitch can pull one (see the "Trailers" section
// in app.py): it adds cargo space, opens up loads only a trailer carries
// (cars, boats, machines), and costs mpg and top speed while it's on.
//
// Two parts here:
//   - My Vehicles' Trailers list: the file's own trailers, bought from the
//     Marketplace - where each one is, hitching it to a parked vehicle
//     close by that can pull it, unhitching, and selling.
//   - The Vehicle Models page's Trailer Models table (admin): the kinds of
//     trailer there are, shared by every save file, with an editor.
//

let trailersList = [];
let trailerModelsList = [];

//
// The trailer editor's model (null for a new one) while it's open.
//
let trailerEditorId = null;

//
// The picture to save with it: { blob, previewUrl } for a new one,
// "remove" to drop the current one, or null for no change.
//
let trailerEditorPicture = null;

//
// Mirrors TRAILER_BODIES in app.py.
//
const TRAILER_BODIES = {
    utility: "Utility",
    enclosed: "Enclosed cargo",
    car_hauler: "Car hauler",
    boat: "Boat",
    equipment: "Equipment",
    flatbed: "Flatbed",
    dry_van: "Dry van",
};


function trailerModelLabel(trailerModel) {

    return `${trailerModel.year} ${trailerModel.brand} ${trailerModel.model}`;
}


//
// "Enclosed cargo · 400 cu ft · 2,990 lbs loaded · Class II receiver".
//
function trailerModelSpecs(trailerModel) {

    return [
        TRAILER_BODIES[trailerModel.body] || trailerModel.body,
        trailerModel.cargo_capacity_cuft ? `${trailerModel.cargo_capacity_cuft.toLocaleString()} cu ft` : null,
        `${trailerModel.gross_weight_lbs.toLocaleString()} lbs loaded`,
        HITCH_LABELS[trailerModel.hitch_type] || trailerModel.hitch_type,
    ].filter(Boolean).join(" · ");
}


// ---------- How a trailer looks: outlines, pictures, and on the map ----------

//
// Each body type's built-in side view, used wherever a trailer model has
// no picture of its own: front (the tongue, or for a fifth-wheel trailer
// the end over the tractor) on the left, wheels touching the bottom, and
// filling the viewBox edge to edge so the map can line it up exactly.
// Filled in currentColor; the wheels get a light rim so they read apart
// from the body.
//
const TRAILER_WHEEL = (cx, cy, r) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="rgba(255,255,255,0.85)" stroke-width="1.2"/>`;

const TRAILER_OUTLINES = {
    utility: {
        width: 60, height: 20,
        shapes: `<rect x="0" y="11" width="13" height="2.4" rx="1"/>` +
            `<rect x="11" y="5" width="45" height="9" rx="1"/>` +
            `<rect x="55" y="0" width="5" height="14" rx="1"/>` +
            TRAILER_WHEEL(35, 15.5, 4.5)
    },
    enclosed: {
        width: 70, height: 32,
        shapes: `<rect x="0" y="23" width="15" height="2.4" rx="1"/>` +
            `<path d="M13 5 L20 0 H70 V26 H13 Z"/>` +
            TRAILER_WHEEL(46, 27, 5)
    },
    car_hauler: {
        width: 80, height: 22,
        shapes: `<rect x="0" y="13" width="12" height="2.4" rx="1"/>` +
            `<rect x="10" y="10" width="64" height="4.5" rx="1"/>` +
            `<rect x="10" y="6" width="2.5" height="5"/>` +
            `<path d="M73 10 L80 19 L77.5 19 L71 12 Z"/>` +
            TRAILER_WHEEL(46, 17.5, 4.5) + TRAILER_WHEEL(57, 17.5, 4.5)
    },
    boat: {
        width: 70, height: 22,
        shapes: `<rect x="0" y="14" width="16" height="2.4" rx="1"/>` +
            `<rect x="12" y="5" width="3" height="11" rx="1"/>` +
            `<rect x="14" y="12" width="56" height="3.5" rx="1"/>` +
            `<rect x="22" y="8.5" width="44" height="3" rx="1.5"/>` +
            TRAILER_WHEEL(44, 17.5, 4.5)
    },
    equipment: {
        width: 80, height: 22,
        shapes: `<rect x="0" y="12" width="12" height="2.4" rx="1"/>` +
            `<rect x="10" y="9" width="60" height="5" rx="1"/>` +
            `<path d="M69 9 L77 11.5 V14 H69 Z"/>` +
            `<path d="M71 0 H75 L80 14 H76.5 Z"/>` +
            TRAILER_WHEEL(46, 17.5, 4.5) + TRAILER_WHEEL(57, 17.5, 4.5)
    },
    flatbed: {
        width: 92, height: 24,
        shapes: `<rect x="0" y="2" width="19" height="5" rx="1"/>` +
            `<rect x="14" y="2" width="5" height="14"/>` +
            `<rect x="14" y="11.5" width="78" height="5" rx="1"/>` +
            TRAILER_WHEEL(70, 19.5, 4.5) + TRAILER_WHEEL(81, 19.5, 4.5)
    },
    dry_van: {
        width: 120, height: 38,
        shapes: `<rect x="0" y="0" width="120" height="30" rx="1.5"/>` +
            `<rect x="6" y="29" width="110" height="3"/>` +
            `<rect x="22" y="30" width="2.5" height="7"/>` +
            TRAILER_WHEEL(95, 33, 5) + TRAILER_WHEEL(107, 33, 5)
    },
};


function trailerOutlineSvg(body, className = "") {

    const outline = TRAILER_OUTLINES[body] || TRAILER_OUTLINES.enclosed;

    return `<svg class="trailer-outline ${className}" viewBox="0 0 ${outline.width} ${outline.height}" ` +
        `fill="currentColor" aria-hidden="true">${outline.shapes}</svg>`;
}


//
// A trailer model's picture if it has one, otherwise its body's outline -
// for cards, lists and the editor.
//
function trailerArtHtml(trailerModel, className = "") {

    if (trailerModel && trailerModel.picture_url) {
        return `<img class="trailer-picture ${className}" src="${trailerModel.picture_url}" alt="">`;
    }

    return trailerOutlineSvg(trailerModel ? trailerModel.body : null, className);
}


//
// How long a hitched trailer is drawn against the vehicle pulling it (the
// vehicle's picture, as wide as it shows): a semi trailer (fifth wheel) is
// over twice a tractor; the rest by body.
//
const TRAILER_LENGTH_RATIO = {
    utility: 0.6,
    enclosed: 0.85,
    car_hauler: 1.0,
    boat: 0.85,
    equipment: 1.0,
    flatbed: 1.35,
    dry_van: 1.6,
};

const FIFTH_WHEEL_LENGTH_RATIO = 2.2;

//
// How far the trailer's front reaches over the vehicle's back, as a share
// of the vehicle's length: a fifth wheel sits well over the tractor, a
// gooseneck over the pickup's bed, a receiver's tongue just meets the
// bumper.
//
const TRAILER_HITCH_OVERLAP = {
    fifth_wheel: 0.3,
    gooseneck: 0.2,
};

const RECEIVER_HITCH_OVERLAP = 0.02;

//
// The map icons' box (vehicleMapIcon() in app.js), in px.
//
const MAP_ICON_SIZE = 48;

//
// Where a picture's visible (not transparent) part is, as fractions of
// its width and height, plus its width / height - so a trailer can be put
// right against the vehicle's back with their wheels on the same line.
// Measured once per picture (pictureBounds()); fallback is what to assume
// if it can't be read.
//
const pictureBoundsCache = new Map();

//
// A vehicle icon (the editor's Create icon) is the vehicle trimmed and
// centered in a square, wider than tall.
//
const VEHICLE_ICON_FALLBACK_BOUNDS = { left: 0.06, right: 0.94, top: 0.28, bottom: 0.72, aspect: 1 };
const PICTURE_FALLBACK_BOUNDS = { left: 0, right: 1, top: 0, bottom: 1, aspect: 2.5 };


function measurePictureBounds(image, fallback) {

    const scale = Math.min(1, 160 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const aspect = image.naturalWidth / image.naturalHeight;

    let data;

    try {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, width, height);
        data = context.getImageData(0, 0, width, height).data;
    } catch (e) {
        return { ...fallback, aspect };
    }

    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] > 40) {
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        }
    }

    if (right < 0) {
        return { ...fallback, aspect };
    }

    return {
        left: left / width,
        right: (right + 1) / width,
        top: top / height,
        bottom: (bottom + 1) / height,
        aspect,
    };
}


//
// The bounds if they're known; otherwise null, and they're measured in
// the background - the map is redrawn (restyleMap()) once they are.
//
function pictureBounds(url, fallback) {

    const cached = pictureBoundsCache.get(url);

    if (cached) {
        return cached === "loading" ? null : cached;
    }

    pictureBoundsCache.set(url, "loading");

    const image = new Image();

    image.onload = () => {
        pictureBoundsCache.set(url, measurePictureBounds(image, fallback));
        restyleMap();
    };

    image.onerror = () => {
        pictureBoundsCache.set(url, fallback);
        restyleMap();
    };

    image.src = url;

    return null;
}


//
// The trailer as drawn behind a vehicle's map icon, positioned in the
// icon's MAP_ICON_SIZE box: its front against the vehicle's back (which
// side that is comes from the vehicle's icon_front), wheels level with
// the vehicle's, turned to face the same way, and underneath it so a cab
// stays in front of a fifth-wheel trailer. It's inside the box that
// orientVehicleMarker() flips and tilts, so it stays hitched as the
// vehicle turns. "" until the pictures involved have been measured.
//
function trailerRigHtml(vehicleIconUrl, vehicleFront, trailerModel) {

    const vehicleBounds = pictureBounds(vehicleIconUrl, VEHICLE_ICON_FALLBACK_BOUNDS);

    if (!vehicleBounds) {
        return "";
    }

    let bounds;
    let art;
    let trailerFront;

    if (trailerModel.picture_url) {

        bounds = pictureBounds(trailerModel.picture_url, PICTURE_FALLBACK_BOUNDS);

        if (!bounds) {
            return "";
        }

        art = `<img src="${trailerModel.picture_url}" alt="">`;
        trailerFront = trailerModel.picture_front || "left";

    } else {

        const outline = TRAILER_OUTLINES[trailerModel.body] || TRAILER_OUTLINES.enclosed;

        bounds = { left: 0, right: 1, top: 0, bottom: 1, aspect: outline.width / outline.height };
        art = trailerOutlineSvg(trailerModel.body);
        trailerFront = "left";
    }

    //
    // Turned around to face the way the vehicle does - and its visible
    // part's sides swap with it.
    //
    const mirrored = trailerFront !== vehicleFront;

    if (mirrored) {
        bounds = { ...bounds, left: 1 - bounds.right, right: 1 - bounds.left };
    }

    const vehicleLength = (vehicleBounds.right - vehicleBounds.left) * MAP_ICON_SIZE;
    const ratio = trailerModel.hitch_type === "fifth_wheel"
        ? FIFTH_WHEEL_LENGTH_RATIO
        : TRAILER_LENGTH_RATIO[trailerModel.body] || 1;

    const width = vehicleLength * ratio / (bounds.right - bounds.left);
    const height = width / bounds.aspect;
    const overlap = (TRAILER_HITCH_OVERLAP[trailerModel.hitch_type] ?? RECEIVER_HITCH_OVERLAP) * vehicleLength;

    //
    // Behind a vehicle facing left is to its right, and the other way round.
    //
    const left = vehicleFront === "right"
        ? vehicleBounds.left * MAP_ICON_SIZE + overlap - bounds.right * width
        : vehicleBounds.right * MAP_ICON_SIZE - overlap - bounds.left * width;

    const top = vehicleBounds.bottom * MAP_ICON_SIZE - bounds.bottom * height;

    return `<div class="map-trailer" style="left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;` +
        `width:${width.toFixed(1)}px;height:${height.toFixed(1)}px` +
        `${mirrored ? ";transform:scaleX(-1)" : ""}">${art}</div>`;
}


//
// A view's own marker (no model icon to hitch anything to) with a small
// trailer badge on its corner - one per marker, made once.
//
const trailerBadgeIcons = new Map();

function trailerBadgeIcon(icon) {

    if (!trailerBadgeIcons.has(icon)) {

        const options = icon.options;

        //
        // The plain view's marker is Leaflet's own pin image, not HTML -
        // createIcon() gives its resolved src.
        //
        const html = options.html !== undefined
            ? options.html
            : `<img class="map-pin-img" src="${icon.createIcon().src}" alt="">`;

        trailerBadgeIcons.set(icon, L.divIcon({
            className: `${options.className || ""} trailer-badged-icon`,
            html: html + `<span class="map-trailer-badge">${TRAILER_GLYPH}</span>`,
            iconSize: options.iconSize,
            iconAnchor: options.iconAnchor,
            tooltipAnchor: options.tooltipAnchor,
            popupAnchor: options.popupAnchor,
        }));
    }

    return trailerBadgeIcons.get(icon);
}


// ---------- My Vehicles: the file's trailers ----------

async function loadTrailers() {

    try {

        const response = await apiFetch(API + "/api/trailers");

        if (!response.ok) {
            return;
        }

        trailersList = await response.json();

    } catch (e) {
        return;
    }

    renderTrailerList();
}


function renderTrailerList() {

    const list = document.getElementById("trailer-list");

    list.innerHTML = "";

    if (!trailersList.length) {
        return;
    }

    const heading = document.createElement("div");
    heading.className = "trailer-list-heading";
    heading.textContent = "Trailers";
    list.appendChild(heading);

    for (const trailer of trailersList) {
        list.appendChild(trailerCard(trailer));
    }
}


function trailerCard(trailer) {

    const card = document.createElement("div");
    const trailerModel = trailer.trailer_model;

    card.className = "vehicle-item vehicle-card trailer-card";

    const where = trailer.vehicle_id
        ? `Hitched to ${escapeLoadText(trailer.vehicle_name)} &middot; ${escapeLoadText(trailer.location)}`
        : `Parked in ${escapeLoadText(trailer.location)}`;

    let actions;

    if (trailer.vehicle_id) {

        //
        // Not while what's pulling it is out - it's coming along.
        //
        actions = trailer.vehicle_busy
            ? `<span class="trailer-card-note">On the road with it</span>`
            : `<button class="refuel-button trailer-unhitch-button">Unhitch</button>` +
              `<button class="sell-button trailer-sell-button">Sell</button>`;

    } else {

        const ready = trailer.candidates.filter((candidate) => !candidate.reason);

        //
        // Every vehicle in the fleet is listed, the ones that can't hitch
        // it right now greyed out with why - so it's clear what to do
        // about it (drive one over, unhitch another trailer, ...).
        //
        actions =
            `<select class="trailer-hitch-select">` +
            (trailer.candidates.length
                ? trailer.candidates.map((candidate) =>
                    `<option value="${candidate.vehicle_id}"${candidate.reason ? " disabled" : ""}>` +
                    escapeLoadText(candidate.name) +
                    (candidate.reason ? ` - ${escapeLoadText(candidate.reason)}` : "") +
                    `</option>`
                ).join("")
                : `<option disabled>No vehicles</option>`) +
            `</select>` +
            `<button class="refuel-button trailer-hitch-button"${ready.length ? "" : " disabled"}>Hitch</button>` +
            `<button class="refuel-button trailer-drive-button"></button>` +
            `<button class="refuel-button trailer-map-button">Map</button>` +
            `<button class="sell-button trailer-sell-button">Sell</button>`;
    }

    card.innerHTML =
        `<div class="vehicle-card-top">` +
        `<span class="trailer-card-glyph">${trailerArtHtml(trailerModel)}</span>` +
        `<div class="vehicle-card-title">` +
        `<div class="vehicle-card-name"></div>` +
        `<div class="vehicle-card-location">${where}</div>` +
        `<div class="trailer-card-specs"></div>` +
        `</div>` +
        `</div>` +
        `<div class="vehicle-card-actions trailer-card-actions">${actions}</div>`;

    card.querySelector(".vehicle-card-name").textContent = trailer.name;
    card.querySelector(".trailer-card-specs").textContent = trailerModel ? trailerModelSpecs(trailerModel) : "";

    const select = card.querySelector(".trailer-hitch-select");

    //
    // Starts on the first vehicle that can actually hitch it.
    //
    if (select) {
        const first = trailer.candidates.find((candidate) => !candidate.reason);
        if (first) {
            select.value = String(first.vehicle_id);
        }
    }

    const hitch = card.querySelector(".trailer-hitch-button");

    if (hitch) {
        hitch.onclick = () => withSpinner(hitch, () => hitchTrailer(trailer, Number(select.value)));
    }

    const drive = card.querySelector(".trailer-drive-button");

    if (drive) {

        //
        // Too far off is the one greyed-out reason a click can fix, so
        // those vehicles stay pickable for this button - Hitch only
        // takes the ones that are close enough already.
        //
        for (const candidate of trailer.candidates) {
            if (candidate.can_drive_to) {
                select.querySelector(`option[value="${candidate.vehicle_id}"]`).disabled = false;
            }
        }

        if (!trailer.candidates.some((candidate) => !candidate.reason)) {
            const firstFar = trailer.candidates.find((candidate) => candidate.can_drive_to);
            if (firstFar) {
                select.value = String(firstFar.vehicle_id);
            }
        }

        const syncButtons = () => {

            const chosen = trailer.candidates.find((candidate) => candidate.vehicle_id === Number(select.value));

            hitch.disabled = !chosen || Boolean(chosen.reason);
            drive.disabled = !chosen || !chosen.can_drive_to || driveToTrailerInFlight.has(trailer.id);
            drive.textContent = driveToTrailerInFlight.has(trailer.id) ? "Heading out..." : "Drive here";
        };

        select.onchange = syncButtons;
        syncButtons();

        drive.onclick = () => driveToTrailer(trailer, Number(select.value));
    }

    const unhitch = card.querySelector(".trailer-unhitch-button");

    if (unhitch) {
        unhitch.onclick = () => withSpinner(unhitch, () => unhitchTrailer(trailer));
    }

    const sell = card.querySelector(".trailer-sell-button");

    if (sell) {
        sell.onclick = () => withSpinner(sell, () => sellTrailer(trailer));
    }

    const mapButton = card.querySelector(".trailer-map-button");

    if (mapButton) {
        mapButton.onclick = () => showTrailerOnMap(trailer);
    }

    return card;
}


//
// POST to one of a trailer's actions; alerts the refusal, if any, and
// reloads the fleet either way - a hitch changes what a vehicle can carry,
// so its load board is fetched fresh too.
//
async function trailerAction(trailer, action, body, failure) {

    let response;
    let data;

    try {

        response = await apiFetch(API + `/api/trailers/${trailer.id}/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined
        });

        data = await response.json();

    } catch (e) {
        alert("Couldn't reach the server - try again.");
        return false;
    }

    if (!response.ok) {
        alert(typeof data.detail === "string" ? data.detail : failure);
    }

    loadBoard.vehicleId = null;

    await loadVehicles();

    return response.ok;
}


async function hitchTrailer(trailer, vehicleId) {

    await trailerAction(trailer, "hitch", { vehicle_id: vehicleId }, "Couldn't hitch it");
}


//
// Trailers a vehicle is being sent to (the job routing it hasn't started
// its trip yet), so their Drive here button stays off meanwhile.
//
const driveToTrailerInFlight = new Set();

//
// Starts the vehicle off toward the trailer as a background job, the way
// refuelVehicle() (app.js) drives to a station. Once it's parked there,
// Hitch picks it up.
//
async function driveToTrailer(trailer, vehicleId) {

    driveToTrailerInFlight.add(trailer.id);
    driveInFlightVehicleId = vehicleId;
    renderTrailerList();
    renderVehicleList();

    try {

        const response = await apiFetch(API + `/api/trailers/${trailer.id}/drive-to`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vehicle_id: vehicleId })
        });

        const data = await response.json();

        if (!response.ok) {
            alert(typeof data.detail === "string" ? data.detail : "Couldn't send it there");
            return;
        }

        await pollJob(data.job_id);

    } catch (e) {
        alert(e.message || "Couldn't reach the server - try again.");
    } finally {
        driveToTrailerInFlight.delete(trailer.id);
        driveInFlightVehicleId = null;
        loadBoard.vehicleId = null;
        await loadVehicles();
        refreshLiveData();
    }
}


async function unhitchTrailer(trailer) {

    await trailerAction(trailer, "unhitch", null, "Couldn't unhitch it");
}


async function sellTrailer(trailer) {

    if (!confirm(
        `Sell ${trailer.name}?\n\n` +
        (trailer.purchase_price > 0
            ? `You'll get back ${formatDoubloons(trailer.purchase_price)}, what it was bought for.`
            : "It was free, so it sells for nothing.")
    )) {
        return;
    }

    if (await trailerAction(trailer, "sell", null, "Couldn't sell it")) {
        loadSettings();
    }
}


function showTrailerOnMap(trailer) {

    if (!map) {
        return;
    }

    L.popup()
        .setLatLng([trailer.lat, trailer.lng])
        .setContent(`<b>${escapeLoadText(trailer.name)}</b><br>Parked in ${escapeLoadText(trailer.location)}`)
        .openOn(map);

    map.setView([trailer.lat, trailer.lng], Math.max(map.getZoom(), 9));
}


// ---------- Vehicle Models page: trailer models (admin) ----------

async function loadTrailerModels() {

    try {

        const response = await apiFetch(API + "/api/trailer-models");

        if (!response.ok) {
            return;
        }

        trailerModelsList = await response.json();

    } catch (e) {
        return;
    }

    renderTrailerModels();
}


function renderTrailerModels() {

    const rows = document.getElementById("trailer-models-rows");

    document.getElementById("trailer-models-count").textContent =
        `${trailerModelsList.length} model${trailerModelsList.length === 1 ? "" : "s"}`;

    rows.innerHTML = "";

    for (const trailerModel of trailerModelsList) {

        const row = document.createElement("tr");

        row.innerHTML =
            `<td class="trailer-model-name"><span class="trailer-model-art">${trailerArtHtml(trailerModel)}</span><span></span></td>` +
            `<td>${TRAILER_BODIES[trailerModel.body] || escapeLoadText(trailerModel.body)}</td>` +
            `<td>${HITCH_LABELS[trailerModel.hitch_type] || escapeLoadText(trailerModel.hitch_type)}</td>` +
            `<td class="budget-cost">${trailerModel.cargo_capacity_cuft ? trailerModel.cargo_capacity_cuft.toLocaleString() : "&mdash;"}</td>` +
            `<td class="budget-cost">${trailerModel.empty_weight_lbs.toLocaleString()} / ${trailerModel.gross_weight_lbs.toLocaleString()}</td>` +
            `<td class="budget-cost">${formatDoubloons(trailerModel.cost)}</td>` +
            `<td class="trailer-model-actions">` +
            `<button class="trailer-model-edit">Edit</button>` +
            `<button class="trailer-model-delete">Delete</button>` +
            `</td>`;

        row.querySelector(".trailer-model-name span:last-child").textContent = trailerModelLabel(trailerModel);
        row.querySelector(".trailer-model-edit").onclick = () => openTrailerEditor(trailerModel.id);

        const remove = row.querySelector(".trailer-model-delete");
        remove.onclick = () => withSpinner(remove, () => deleteTrailerModel(trailerModel));

        rows.appendChild(row);
    }

    if (!trailerModelsList.length) {
        rows.innerHTML = `<tr><td colspan="7" class="models-empty">No trailer models yet - add one.</td></tr>`;
    }
}


async function deleteTrailerModel(trailerModel) {

    if (!confirm(`Delete trailer model "${trailerModelLabel(trailerModel)}"?`)) {
        return;
    }

    const response = await apiFetch(API + "/api/trailer-models/" + trailerModel.id, { method: "DELETE" });

    if (!response.ok) {
        const data = await response.json();
        setModelsResult("error", "Not deleted - " + (data.detail || "the server refused."));
        return;
    }

    setModelsResult("success", `Deleted ${trailerModelLabel(trailerModel)}.`);

    await loadTrailerModels();
}


//
// The editor's fields: model field -> element id, and how its text is read.
//
const TRAILER_EDITOR_FIELDS = [
    ["year", "trailer-field-year", Number],
    ["brand", "trailer-field-brand", String],
    ["model", "trailer-field-model", String],
    ["body", "trailer-field-body", String],
    ["hitch_type", "trailer-field-hitch", String],
    ["cargo_capacity_cuft", "trailer-field-cargo", Number],
    ["empty_weight_lbs", "trailer-field-empty", Number],
    ["gross_weight_lbs", "trailer-field-gross", Number],
    ["cost", "trailer-field-cost", Number],
    ["picture_front", "trailer-field-front", String],
];

const NEW_TRAILER_DEFAULTS = {
    year: new Date().getFullYear(),
    brand: "",
    model: "",
    body: "enclosed",
    hitch_type: "class3",
    cargo_capacity_cuft: 400,
    empty_weight_lbs: 1500,
    gross_weight_lbs: 7000,
    cost: 8000,
    picture_front: "left",
};


function openTrailerEditor(trailerModelId = null) {

    trailerEditorId = trailerModelId;

    const trailerModel = trailerModelsList.find((other) => other.id === trailerModelId) || null;
    const values = trailerModel || NEW_TRAILER_DEFAULTS;

    for (const [key, id] of TRAILER_EDITOR_FIELDS) {
        document.getElementById(id).value = values[key] ?? NEW_TRAILER_DEFAULTS[key] ?? "";
    }

    document.getElementById("trailer-editor-title").textContent =
        trailerModel ? `Edit ${trailerModelLabel(trailerModel)}` : "New trailer model";
    document.getElementById("trailer-editor-error").textContent = "";
    document.getElementById("trailer-picture-input").value = "";

    setTrailerEditorPicture(null);

    document.getElementById("trailer-editor").style.display = "";
    document.getElementById("trailer-field-year").focus();
}


function closeTrailerEditor() {

    setTrailerEditorPicture(null);

    document.getElementById("trailer-editor").style.display = "none";
}


//
// Frees the old preview's object URL, and shows what the trailer will look
// like: the new picture, the current one, or - with none - its body type's
// outline, which is what the map and Marketplace use then.
//
function setTrailerEditorPicture(picture) {

    if (trailerEditorPicture && trailerEditorPicture.previewUrl) {
        URL.revokeObjectURL(trailerEditorPicture.previewUrl);
    }

    trailerEditorPicture = picture;

    renderTrailerEditorPicture();
}


function renderTrailerEditorPicture() {

    const trailerModel = trailerModelsList.find((other) => other.id === trailerEditorId) || null;
    const body = document.getElementById("trailer-field-body").value;
    const preview = document.getElementById("trailer-picture-preview");
    const caption = document.getElementById("trailer-picture-caption");

    let url = null;

    if (trailerEditorPicture && trailerEditorPicture.previewUrl) {
        url = trailerEditorPicture.previewUrl;
    } else if (trailerEditorPicture !== "remove" && trailerModel) {
        url = trailerModel.picture_url;
    }

    preview.innerHTML = url ? `<img src="${url}" alt="">` : trailerOutlineSvg(body);
    caption.textContent = url
        ? (trailerEditorPicture && trailerEditorPicture.blob ? "New picture - saved with the trailer" : "Its picture")
        : `No picture - the built-in ${(TRAILER_BODIES[body] || body).toLowerCase()} outline is used`;

    document.getElementById("trailer-picture-remove").style.display = url ? "" : "none";
}


function removeTrailerEditorPicture() {

    document.getElementById("trailer-picture-input").value = "";
    setTrailerEditorPicture("remove");
}


//
// A chosen file, with its background cut out first if the box is ticked -
// the same AI cutout the vehicle editor's Detect vehicle uses, trimmed to
// the trailer, since the map hitches it behind a vehicle.
//
async function chooseTrailerEditorPicture(input) {

    const file = input.files[0];
    const error = document.getElementById("trailer-editor-error");

    if (!file) {
        return;
    }

    error.textContent = "";

    let blob = file;

    if (document.getElementById("trailer-picture-cutout").checked) {

        document.getElementById("trailer-picture-caption").textContent = "Cutting out the background...";

        try {

            const formData = new FormData();
            formData.append("file", file, file.name);

            const response = await apiFetch(API + "/api/vehicle-models/cutout?trim=true", { method: "POST", body: formData });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.detail);
            }

            blob = await response.blob();

        } catch (e) {
            error.textContent = "Couldn't cut it out (" + (e.message || "server error") + ") - using the picture as it is.";
        }
    }

    setTrailerEditorPicture({ blob, previewUrl: URL.createObjectURL(blob) });
}


async function saveTrailerEditor() {

    const error = document.getElementById("trailer-editor-error");
    const body = {};

    for (const [key, id, type] of TRAILER_EDITOR_FIELDS) {
        body[key] = type(document.getElementById(id).value.trim());
    }

    error.textContent = "";

    const isNew = trailerEditorId === null;

    let response;
    let data;

    try {

        response = await apiFetch(API + "/api/trailer-models" + (isNew ? "" : "/" + trailerEditorId), {
            method: isNew ? "POST" : "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        data = await response.json();

    } catch (e) {
        error.textContent = "Couldn't reach the server - try again.";
        return;
    }

    if (!response.ok) {
        error.textContent = typeof data.detail === "string" ? data.detail : "Check the fields - some aren't valid.";
        return;
    }

    const savedId = data.id;

    //
    // The picture goes up once the model exists. If it fails the model is
    // still saved, so say so and keep the editor open on it to retry.
    //
    if (trailerEditorPicture && trailerEditorPicture.blob) {

        const formData = new FormData();
        formData.append("file", trailerEditorPicture.blob, "picture");

        response = await apiFetch(API + `/api/trailer-models/${savedId}/picture`, { method: "PUT", body: formData });

        if (!response.ok) {
            data = await response.json();
            trailerEditorId = savedId;
            await loadTrailerModels();
            error.textContent = "Saved, but the picture wasn't - " + (data.detail || "try again.");
            return;
        }

    } else if (trailerEditorPicture === "remove") {

        await apiFetch(API + `/api/trailer-models/${savedId}/picture`, { method: "DELETE" });
    }

    closeTrailerEditor();
    setModelsResult("success", `${isNew ? "Added" : "Saved"} ${trailerModelLabel(data)}.`);

    await loadTrailerModels();

    //
    // Hitched trailers and listings on the map and Marketplace pick it up.
    //
    loadVehicles();
}

