//
// The Vehicle Models page (admin): a full-width page over the map, like
// Budget, for the models every save file shares - a card per model with
// its picture, an editor for adding and changing one, and CSV import and
// export. Opened from the tab menu's locked "Vehicle Models" entry; the
// admin password unlocks it for as long as it's open (admin.js), and
// closing it locks admin again.
//
// Pictures can be uploaded, fetched from a URL, or a built-in file under
// frontend/images/. Uploaded and fetched ones are stored by the backend in
// Postgres, re-encoded as WebP (normalize_vehicle_image() in app.py).
//

let vehicleModelsPageOpen = false;

//
// The editor's state while it's open: which model (null for a new one),
// and the picture to save with it - { blob, previewUrl } for an upload or
// fetched URL, "remove" to drop an uploaded one, or null for no change.
//
let modelEditorId = null;
let modelEditorImage = null;

//
// The engine size exactly as it'll be saved, in liters. The two size boxes
// show it rounded (L to 2 places, cubic inches whole), so typing in either
// sets this precisely and refills the other - 351 ci stays 351 ci rather
// than drifting through a rounded liter value.
//
let modelEditorLiters = null;


function openVehicleModelsPage() {

    closeTabMenu();

    if (isAdmin() && adminUnlockedTab === "vehiclemodels") {
        showVehicleModelsPage();
        return;
    }

    openAdminPrompt({
        title: "Unlock Vehicle Models",
        hint: "Admin only - shared by every save file. It locks again when you close the page.",
        submitLabel: "Unlock",
        onToken: (token, expires) => {
            setAdminSession({ token, expires }, "vehiclemodels");
            showVehicleModelsPage();
        }
    });
}


function showVehicleModelsPage() {

    vehicleModelsPageOpen = true;

    document.getElementById("models-page").style.display = "";
    setModelsResult("", "");

    renderVehicleModelsPage();
    loadVehicleModels();
}


//
// relock: false when admin has already ended on its own (expired) and
// applyAdminState() is just closing the page after it.
//
function closeVehicleModelsPage(relock = true) {

    closeModelEditor();

    vehicleModelsPageOpen = false;
    document.getElementById("models-page").style.display = "none";

    if (relock) {
        setAdminSession(null);
    }
}


function setModelsResult(kind, message) {

    const result = document.getElementById("models-result");

    result.className = "form-result " + kind;
    result.textContent = message;
}


function renderVehicleModelsPage() {

    if (!vehicleModelsPageOpen) {
        return;
    }

    const grid = document.getElementById("models-grid");
    const models = [...vehicleModelsById.values()];

    document.getElementById("models-count").textContent =
        `${models.length} model${models.length === 1 ? "" : "s"} · shared by every save file`;

    grid.innerHTML = "";

    for (const vehicleModel of models) {

        const card = document.createElement("div");
        const imageUrl = vehicleModelImageUrl(vehicleModel);
        const starter = isStarterVehicleModel(vehicleModel);

        card.className = "model-card";

        card.innerHTML =
            `<div class="model-card-image">` +
            (imageUrl ? `<img src="${imageUrl}" alt="">` : `<span class="model-card-noimage">No picture</span>`) +
            (starter ? `<span class="model-card-starter" title="Every new file starts with one">STARTER</span>` : "") +
            `</div>` +
            `<div class="model-card-body">` +
            `<div class="model-card-name"></div>` +
            `<div class="model-card-stats">` +
            `<span>${vehicleModel.person_capacity} people</span>` +
            `<span>${vehicleModel.cargo_capacity_cuft} cu ft</span>` +
            `<span>${vehicleModel.mpg} mpg</span>` +
            `<span>${vehicleModel.fuel_tank_gallons} gal tank</span>` +
            `</div>` +
            `<div class="model-card-engine"></div>` +
            `<div class="model-card-cost">${formatDoubloons(vehicleModel.cost)}</div>` +
            `</div>` +
            `<div class="model-card-actions">` +
            `<button class="model-edit-button">Edit</button>` +
            (starter ? "" : `<button class="model-delete-button">Delete</button>`) +
            `</div>`;

        card.querySelector(".model-card-name").textContent = vehicleModelLabel(vehicleModel);
        card.querySelector(".model-card-engine").textContent = engineSummary(vehicleModel) || "Engine not set";
        card.querySelector(".model-edit-button").onclick = () => openModelEditor(vehicleModel.id);

        const deleteButton = card.querySelector(".model-delete-button");

        if (deleteButton) {
            deleteButton.onclick = () => withSpinner(deleteButton, () => deleteVehicleModel(vehicleModel.id));
        }

        grid.appendChild(card);
    }

    if (!models.length) {
        grid.innerHTML = `<div class="models-empty">No vehicle models yet - add one.</div>`;
    }
}


//
// Mirrors is_starter_vehicle_model() in app.py - the backend refuses to
// delete it or rename it either way; this just doesn't offer to.
//
function isStarterVehicleModel(vehicleModel) {

    return vehicleModel.year === 1978 &&
        vehicleModel.brand.trim().toLowerCase() === "ford" &&
        vehicleModel.model.trim().toLowerCase() === "econoline";
}


async function deleteVehicleModel(vehicleModelId) {

    const vehicleModel = vehicleModelsById.get(vehicleModelId);

    if (!confirm(`Delete vehicle model "${vehicleModel ? vehicleModelLabel(vehicleModel) : vehicleModelId}"?`)) {
        return;
    }

    const response = await apiFetch(API + "/api/vehicle-models/" + vehicleModelId, { method: "DELETE" });

    if (!response.ok) {
        const data = await response.json();
        setModelsResult("error", "Not deleted - " + (data.detail || "the server refused."));
        return;
    }

    setModelsResult("success", `Deleted ${vehicleModel ? vehicleModelLabel(vehicleModel) : "that model"}.`);

    await loadVehicleModels();
}


// ---------- The editor ----------

const MODEL_EDITOR_FIELDS = [
    ["year", "model-field-year", Number],
    ["brand", "model-field-brand", String],
    ["model", "model-field-model", String],
    ["person_capacity", "model-field-people", Number],
    ["cargo_capacity_cuft", "model-field-cargo", Number],
    ["cost", "model-field-cost", Number],
    ["mpg", "model-field-mpg", Number],
    ["fuel_tank_gallons", "model-field-tank", Number],
    ["image", "model-field-image-file", String]
];

//
// The engine selects: element id -> model field, with how a select's value
// maps to and from the stored one ("" is "not set").
//
const MODEL_ENGINE_SELECTS = [
    ["model-field-cylinders", "engine_cylinders", (v) => (v ? Number(v) : null), (v) => (v ?? "")],
    ["model-field-turbo", "engine_turbo", (v) => (v ? v === "yes" : null), (v) => (v === null || v === undefined ? "" : v ? "yes" : "no")],
    ["model-field-fuel", "fuel_type", (v) => v || null, (v) => v || ""],
    ["model-field-transmission", "transmission", (v) => v || null, (v) => v || ""]
];


function trimNumber(value, places) {

    return String(Number(value.toFixed(places)));
}


function setModelEditorLiters(liters, from) {

    modelEditorLiters = liters;

    if (from !== "liters") {
        document.getElementById("model-field-liters").value = liters === null ? "" : trimNumber(liters, 2);
    }

    if (from !== "ci") {
        document.getElementById("model-field-ci").value =
            liters === null ? "" : String(Math.round(liters * CUBIC_INCHES_PER_LITER));
    }
}


const NEW_MODEL_DEFAULTS = {
    year: new Date().getFullYear(),
    brand: "",
    model: "",
    person_capacity: 2,
    cargo_capacity_cuft: 240,
    cost: 45000,
    mpg: 18,
    fuel_tank_gallons: 20,
    image: "",
    engine_liters: null,
    engine_cylinders: null,
    engine_turbo: null,
    fuel_type: null,
    transmission: null
};


function openModelEditor(vehicleModelId = null) {

    modelEditorId = vehicleModelId;
    setModelEditorImage(null);

    const vehicleModel = vehicleModelId !== null ? vehicleModelsById.get(vehicleModelId) : null;
    const values = vehicleModel || NEW_MODEL_DEFAULTS;

    for (const [key, id] of MODEL_EDITOR_FIELDS) {
        document.getElementById(id).value = values[key] ?? "";
    }

    setModelEditorLiters(values.engine_liters ?? null, null);

    for (const [id, key, , toSelect] of MODEL_ENGINE_SELECTS) {
        document.getElementById(id).value = toSelect(values[key]);
    }

    //
    // The starter van is recognized by its year, brand and model, so those
    // stay put (the backend refuses a change too).
    //
    const starter = vehicleModel && isStarterVehicleModel(vehicleModel);

    for (const id of ["model-field-year", "model-field-brand", "model-field-model"]) {
        document.getElementById(id).disabled = Boolean(starter);
    }

    document.getElementById("model-editor-title").textContent =
        vehicleModel ? `Edit ${vehicleModelLabel(vehicleModel)}` : "New vehicle model";
    document.getElementById("model-editor-starter-note").style.display = starter ? "" : "none";
    document.getElementById("model-editor-error").textContent = "";
    document.getElementById("model-image-url").value = "";
    document.getElementById("model-image-input").value = "";

    showModelImageSource("upload");
    renderModelEditorPreview();

    document.getElementById("model-editor").style.display = "";
    document.getElementById(starter ? "model-field-people" : "model-field-year").focus();
}


function closeModelEditor() {

    setModelEditorImage(null);

    document.getElementById("model-editor").style.display = "none";
}


//
// Frees the old preview's object URL when the pending picture changes.
//
function setModelEditorImage(image) {

    if (modelEditorImage && modelEditorImage.previewUrl) {
        URL.revokeObjectURL(modelEditorImage.previewUrl);
    }

    modelEditorImage = image;
}


function showModelImageSource(source) {

    for (const tab of document.querySelectorAll(".model-image-tab")) {
        tab.classList.toggle("active", tab.dataset.source === source);
    }

    for (const pane of document.querySelectorAll(".model-image-pane")) {
        pane.style.display = pane.dataset.source === source ? "" : "none";
    }
}


//
// What the card will show once saved: the pending picture, else (unless
// it's being removed) the model's current one, else the built-in filename
// typed in.
//
function renderModelEditorPreview() {

    const preview = document.getElementById("model-image-preview");
    const removeButton = document.getElementById("model-image-remove");
    const vehicleModel = modelEditorId !== null ? vehicleModelsById.get(modelEditorId) : null;
    const filename = document.getElementById("model-field-image-file").value.trim();

    let url = null;
    let caption = "No picture";

    if (modelEditorImage && modelEditorImage.previewUrl) {

        url = modelEditorImage.previewUrl;
        caption = "New picture - saved with the model";

    } else if (modelEditorImage !== "remove" && vehicleModel && vehicleModel.has_uploaded_image) {

        url = vehicleModelImageUrl(vehicleModel);
        caption = "Uploaded picture";

    } else if (filename) {

        url = `images/${encodeURIComponent(filename)}`;
        caption = `Built-in file: ${filename}`;
    }

    preview.innerHTML = url ? `<img src="${url}" alt="">` : "";
    preview.classList.toggle("empty", !url);
    document.getElementById("model-image-caption").textContent = caption;

    removeButton.style.display =
        (modelEditorImage && modelEditorImage.previewUrl) ||
        (modelEditorImage !== "remove" && vehicleModel && vehicleModel.has_uploaded_image)
            ? ""
            : "none";
}


function pickModelImageFile(file) {

    if (!file) {
        return;
    }

    if (!file.type.startsWith("image/")) {
        document.getElementById("model-editor-error").textContent = "That file isn't an image.";
        return;
    }

    document.getElementById("model-editor-error").textContent = "";

    setModelEditorImage({ blob: file, previewUrl: URL.createObjectURL(file) });
    renderModelEditorPreview();
}


//
// The backend fetches the URL and hands back exactly what it would store
// (POST /api/vehicle-models/image-preview), so the preview is honest and
// saving just uploads those bytes - the URL is never fetched twice, and the
// browser never loads it from the other site itself.
//
async function fetchModelImageUrl() {

    const url = document.getElementById("model-image-url").value.trim();
    const error = document.getElementById("model-editor-error");

    error.textContent = "";

    if (!url) {
        error.textContent = "Paste an image URL first.";
        return;
    }

    try {

        const response = await apiFetch(API + "/api/vehicle-models/image-preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url })
        });

        if (!response.ok) {
            const data = await response.json();
            error.textContent = data.detail || "Couldn't fetch that image.";
            return;
        }

        const blob = await response.blob();

        setModelEditorImage({ blob, previewUrl: URL.createObjectURL(blob) });
        renderModelEditorPreview();

    } catch (e) {
        error.textContent = "Couldn't reach the server - try again.";
    }
}


function removeModelEditorImage() {

    const vehicleModel = modelEditorId !== null ? vehicleModelsById.get(modelEditorId) : null;

    setModelEditorImage(vehicleModel && vehicleModel.has_uploaded_image ? "remove" : null);
    renderModelEditorPreview();
}


async function saveModelEditor() {

    const error = document.getElementById("model-editor-error");
    const body = {};

    for (const [key, id, type] of MODEL_EDITOR_FIELDS) {
        body[key] = type(document.getElementById(id).value.trim());
    }

    body.image = body.image || null;
    body.engine_liters = modelEditorLiters;

    for (const [id, key, fromSelect] of MODEL_ENGINE_SELECTS) {
        body[key] = fromSelect(document.getElementById(id).value);
    }

    error.textContent = "";

    const isNew = modelEditorId === null;

    let response = await apiFetch(API + "/api/vehicle-models" + (isNew ? "" : "/" + modelEditorId), {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    let data = await response.json();

    if (!response.ok) {
        error.textContent = typeof data.detail === "string" ? data.detail : "Check the fields - some aren't valid.";
        return;
    }

    const savedId = data.id;

    //
    // The picture goes up once the model exists - a new one only has an id
    // now. If it fails the model is still saved, so say so and keep the
    // editor open on it to retry.
    //
    if (modelEditorImage && modelEditorImage.blob) {

        const formData = new FormData();
        formData.append("file", modelEditorImage.blob, "image");

        response = await apiFetch(API + `/api/vehicle-models/${savedId}/image`, { method: "PUT", body: formData });

        if (!response.ok) {
            data = await response.json();
            modelEditorId = savedId;
            await loadVehicleModels();
            error.textContent = "Saved, but the picture wasn't - " + (data.detail || "try again.");
            return;
        }

    } else if (modelEditorImage === "remove") {

        await apiFetch(API + `/api/vehicle-models/${savedId}/image`, { method: "DELETE" });
    }

    closeModelEditor();
    setModelsResult("success", `${isNew ? "Added" : "Saved"} ${body.year} ${body.brand} ${body.model}.`);

    await loadVehicleModels();
}


// ---------- Import ----------

//
// The other half of "Export CSV" (POST /api/vehicle-models/upload). Small
// enough to run inline on the backend, so the result comes straight back,
// no job to poll. Only built-in image filenames travel in the CSV - an
// uploaded picture stays with its model in the database.
//
async function uploadVehicleModels() {

    const fileInput = document.getElementById("vehicle-model-file-input");

    if (!fileInput.files.length) {
        setModelsResult("error", "Not imported - choose a vehicle model CSV first.");
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
        setModelsResult("error", "Not imported - couldn't reach the server. Check your connection and try again.");
        return;
    }

    if (!response.ok) {
        setModelsResult("error", "Not imported - " + (data.detail || "the server couldn't read that file."));
        return;
    }

    const parts = [`${data.created} added`, `${data.updated} updated`];

    if (data.errors.length) {

        parts.push(`${data.errors.length} skipped`);
        console.warn("Vehicle model import errors:", data.errors);

        setModelsResult(
            data.created || data.updated ? "success" : "error",
            `Imported: ${parts.join(", ")}. First problem - row ${data.errors[0].row}: ${data.errors[0].error}`
        );

    } else {
        setModelsResult("success", `Imported: ${parts.join(", ")}.`);
    }

    fileInput.value = "";

    loadVehicleModels();
}


// ---------- Wiring ----------

(function wireVehicleModelsPage() {

    for (const tab of document.querySelectorAll(".model-image-tab")) {
        tab.onclick = () => showModelImageSource(tab.dataset.source);
    }

    const input = document.getElementById("model-image-input");
    const drop = document.getElementById("model-image-drop");

    input.onchange = () => pickModelImageFile(input.files[0]);
    drop.onclick = () => input.click();

    drop.ondragover = (event) => {
        event.preventDefault();
        drop.classList.add("dragging");
    };

    drop.ondragleave = () => drop.classList.remove("dragging");

    drop.ondrop = (event) => {
        event.preventDefault();
        drop.classList.remove("dragging");
        pickModelImageFile(event.dataTransfer.files[0]);
    };

    document.getElementById("model-field-image-file").oninput = renderModelEditorPreview;

    //
    // Either engine size box fills the other (see modelEditorLiters).
    //
    document.getElementById("model-field-liters").oninput = (event) => {
        const value = event.target.value.trim();
        setModelEditorLiters(value === "" ? null : Number(value), "liters");
    };

    document.getElementById("model-field-ci").oninput = (event) => {
        const value = event.target.value.trim();
        setModelEditorLiters(value === "" ? null : Number(value) / CUBIC_INCHES_PER_LITER, "ci");
    };

    document.getElementById("model-image-url").onkeydown = (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            withSpinner(document.getElementById("model-image-fetch"), fetchModelImageUrl);
        }
    };
})();


document.addEventListener("keydown", (event) => {

    if (event.key !== "Escape" || !vehicleModelsPageOpen) {
        return;
    }

    if (document.getElementById("admin-dialog").style.display !== "none") {
        return;
    }

    if (document.getElementById("model-editor").style.display !== "none") {
        closeModelEditor();
    } else {
        closeVehicleModelsPage();
    }
});
