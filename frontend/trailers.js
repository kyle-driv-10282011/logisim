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
            `<button class="refuel-button trailer-map-button">Map</button>` +
            `<button class="sell-button trailer-sell-button">Sell</button>`;
    }

    card.innerHTML =
        `<div class="vehicle-card-top">` +
        `<span class="trailer-card-glyph">${TRAILER_GLYPH}</span>` +
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
            `<td class="trailer-model-name"></td>` +
            `<td>${TRAILER_BODIES[trailerModel.body] || escapeLoadText(trailerModel.body)}</td>` +
            `<td>${HITCH_LABELS[trailerModel.hitch_type] || escapeLoadText(trailerModel.hitch_type)}</td>` +
            `<td class="budget-cost">${trailerModel.cargo_capacity_cuft ? trailerModel.cargo_capacity_cuft.toLocaleString() : "&mdash;"}</td>` +
            `<td class="budget-cost">${trailerModel.empty_weight_lbs.toLocaleString()} / ${trailerModel.gross_weight_lbs.toLocaleString()}</td>` +
            `<td class="budget-cost">${formatDoubloons(trailerModel.cost)}</td>` +
            `<td class="trailer-model-actions">` +
            `<button class="trailer-model-edit">Edit</button>` +
            `<button class="trailer-model-delete">Delete</button>` +
            `</td>`;

        row.querySelector(".trailer-model-name").textContent = trailerModelLabel(trailerModel);
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
};


function openTrailerEditor(trailerModelId = null) {

    trailerEditorId = trailerModelId;

    const trailerModel = trailerModelsList.find((other) => other.id === trailerModelId) || null;
    const values = trailerModel || NEW_TRAILER_DEFAULTS;

    for (const [key, id] of TRAILER_EDITOR_FIELDS) {
        document.getElementById(id).value = values[key] ?? "";
    }

    document.getElementById("trailer-editor-title").textContent =
        trailerModel ? `Edit ${trailerModelLabel(trailerModel)}` : "New trailer model";
    document.getElementById("trailer-editor-error").textContent = "";

    document.getElementById("trailer-editor").style.display = "";
    document.getElementById("trailer-field-year").focus();
}


function closeTrailerEditor() {

    document.getElementById("trailer-editor").style.display = "none";
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

    closeTrailerEditor();
    setModelsResult("success", `${isNew ? "Added" : "Saved"} ${trailerModelLabel(data)}.`);

    await loadTrailerModels();
}

