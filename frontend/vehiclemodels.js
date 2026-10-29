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
// The map icon to save with it, the same way: { blob, previewUrl } for a
// newly created one, "remove" to drop the current one, or null.
//
let modelEditorIcon = null;

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
            (vehicleModel.icon_url
                ? `<img class="model-card-icon" src="${vehicleModel.icon_url}" alt="" title="Map icon">`
                : "") +
            `</div>` +
            `<div class="model-card-body">` +
            `<div class="model-card-name"></div>` +
            `<div class="model-card-stats">` +
            `<span>${vehicleModel.person_capacity} people</span>` +
            `<span>${vehicleModel.cargo_capacity_cuft} cu ft</span>` +
            `<span>${vehicleModel.mpg} mpg</span>` +
            `<span>${vehicleModel.fuel_tank_gallons} gal tank</span>` +
            (vehicleModel.tire_count ? `<span>${vehicleModel.tire_count} tires</span>` : "") +
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
// The spec selects (engine, and tires): element id -> model field, with how
// a select's value maps to and from the stored one ("" is "not set").
//
const MODEL_ENGINE_SELECTS = [
    ["model-field-cylinders", "engine_cylinders", (v) => (v ? Number(v) : null), (v) => (v ?? "")],
    ["model-field-turbo", "engine_turbo", (v) => (v ? v === "yes" : null), (v) => (v === null || v === undefined ? "" : v ? "yes" : "no")],
    ["model-field-fuel", "fuel_type", (v) => v || null, (v) => v || ""],
    ["model-field-transmission", "transmission", (v) => v || null, (v) => v || ""],
    ["model-field-tires", "tire_count", (v) => (v ? Number(v) : null), (v) => (v ?? "")],
    ["model-field-icon-front", "icon_front", (v) => v || "left", (v) => v || "left"]
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
    transmission: null,
    tire_count: 4,
    icon_front: "left"
};


function openModelEditor(vehicleModelId = null) {

    modelEditorId = vehicleModelId;
    setModelEditorImage(null);
    setModelEditorIcon(null);
    closeImageTool();

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

    closeImageTool();
    setModelEditorImage(null);
    setModelEditorIcon(null);

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
function editorPicture() {

    const vehicleModel = modelEditorId !== null ? vehicleModelsById.get(modelEditorId) : null;
    const filename = document.getElementById("model-field-image-file").value.trim();

    if (modelEditorImage && modelEditorImage.previewUrl) {
        return { url: modelEditorImage.previewUrl, caption: "New picture - saved with the model" };
    }

    if (modelEditorImage !== "remove" && vehicleModel && vehicleModel.has_uploaded_image) {
        return { url: vehicleModelImageUrl(vehicleModel), caption: "Uploaded picture" };
    }

    if (filename) {
        return { url: `images/${encodeURIComponent(filename)}`, caption: `Built-in file: ${filename}` };
    }

    return { url: null, caption: "No picture" };
}


function renderModelEditorPreview() {

    const preview = document.getElementById("model-image-preview");
    const removeButton = document.getElementById("model-image-remove");
    const vehicleModel = modelEditorId !== null ? vehicleModelsById.get(modelEditorId) : null;
    const { url, caption } = editorPicture();

    //
    // A tool (crop, background, icon) draws its own stage in the preview.
    //
    if (!modelImageTool) {
        preview.innerHTML = url ? `<img src="${url}" alt="">` : "";
        preview.classList.toggle("empty", !url);
    }

    document.getElementById("model-image-caption").textContent = caption;

    for (const button of document.querySelectorAll(".model-image-tools button")) {
        button.disabled = !url;
        button.classList.toggle("active", button.dataset.tool === modelImageTool);
    }

    renderModelEditorIcon();

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

    if (modelEditorIcon && modelEditorIcon.blob) {

        const formData = new FormData();
        formData.append("file", modelEditorIcon.blob, "icon.png");

        response = await apiFetch(API + `/api/vehicle-models/${savedId}/icon`, { method: "PUT", body: formData });

        if (!response.ok) {
            data = await response.json();
            modelEditorId = savedId;
            setModelEditorImage(null);
            await loadVehicleModels();
            error.textContent = "Saved, but the icon wasn't - " + (data.detail || "try again.");
            return;
        }

    } else if (modelEditorIcon === "remove") {

        await apiFetch(API + `/api/vehicle-models/${savedId}/icon`, { method: "DELETE" });
    }

    closeModelEditor();
    setModelsResult("success", `${isNew ? "Added" : "Saved"} ${body.year} ${body.brand} ${body.model}.`);

    await loadVehicleModels();
}


// ---------- Picture tools: crop, detect vehicle, remove background, eraser, create icon ----------

//
// They all work on whatever the preview shows (editorPicture()) in a
// canvas, right here in the browser, so each can be adjusted and looked at
// before it's applied. Crop, Remove background and the eraser replace the
// pending picture with their result (still only saved with the model); Create icon
// makes the map icon from it. Every picture here is same-origin (a blob,
// /api or images/), so the canvas can always be read back.
//
let modelImageTool = null;

//
// The open tool's working state: the source image, plus the crop box (in
// source pixels), or the background tool's source pixels and result
// canvas, or the icon canvas.
//
let modelToolState = null;

const ICON_SIZE = 128;
const ICON_PADDING = 6;


function setModelEditorIcon(icon) {

    if (modelEditorIcon && modelEditorIcon.previewUrl) {
        URL.revokeObjectURL(modelEditorIcon.previewUrl);
    }

    modelEditorIcon = icon;
}


function renderModelEditorIcon() {

    const vehicleModel = modelEditorId !== null ? vehicleModelsById.get(modelEditorId) : null;
    const preview = document.getElementById("model-icon-preview");
    const caption = document.getElementById("model-icon-caption");
    const removeButton = document.getElementById("model-icon-remove");

    let url = null;

    if (modelEditorIcon && modelEditorIcon.previewUrl) {
        url = modelEditorIcon.previewUrl;
        caption.textContent = "New - saved with the model";
    } else if (modelEditorIcon !== "remove" && vehicleModel && vehicleModel.icon_url) {
        url = vehicleModel.icon_url;
        caption.textContent = "Shown on the map for this model";
    } else {
        caption.textContent = "None - the map uses the view's own marker";
    }

    preview.innerHTML = url ? `<img src="${url}" alt="">` : "";
    removeButton.style.display = url ? "" : "none";
}


function removeModelEditorIcon() {

    const vehicleModel = modelEditorId !== null ? vehicleModelsById.get(modelEditorId) : null;

    setModelEditorIcon(vehicleModel && vehicleModel.icon_url ? "remove" : null);
    renderModelEditorIcon();
}


function loadImage(url) {

    return new Promise((resolve, reject) => {

        const image = new Image();

        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Couldn't load the picture"));
        image.src = url;
    });
}


function canvasToBlob(canvas) {

    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}


function imageToCanvas(image) {

    const canvas = document.createElement("canvas");

    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);

    return canvas;
}


async function openImageTool(tool) {

    if (modelImageTool === tool) {
        closeImageTool();
        return;
    }

    closeImageTool();

    const { url } = editorPicture();

    if (!url) {
        return;
    }

    let image;

    try {
        image = await loadImage(url);
    } catch (e) {
        document.getElementById("model-editor-error").textContent = e.message;
        return;
    }

    modelImageTool = tool;
    modelToolState = { image };

    document.getElementById("model-tool-panel").style.display = "";
    document.getElementById("model-image-preview").classList.add("tool-open");

    if (tool === "crop") {
        startCrop();
    } else if (tool === "background") {
        startBackgroundRemoval();
    } else if (tool === "erase") {
        startEraser();
    } else if (tool === "detect") {
        startDetect();
    } else {
        startIcon();
    }

    renderModelEditorPreview();
}


function closeImageTool() {

    if (modelToolState && modelToolState.resizeObserver) {
        modelToolState.resizeObserver.disconnect();
    }

    modelImageTool = null;
    modelToolState = null;

    const panel = document.getElementById("model-tool-panel");

    panel.style.display = "none";
    panel.innerHTML = "";
    document.getElementById("model-image-preview").classList.remove("tool-open", "erasing", "detecting");

    renderModelEditorPreview();
}


function toolPanel(html, onApply) {

    const panel = document.getElementById("model-tool-panel");

    panel.innerHTML =
        html +
        `<div class="model-tool-actions">` +
        `<button type="button" class="model-tool-cancel">Cancel</button>` +
        `<button type="button" class="model-tool-apply">Apply</button>` +
        `</div>`;

    panel.querySelector(".model-tool-cancel").onclick = closeImageTool;

    const apply = panel.querySelector(".model-tool-apply");

    apply.onclick = () => withSpinner(apply, onApply);

    return panel;
}


//
// Replaces the pending picture with a tool's result and closes the tool.
//
async function applyPictureResult(canvas) {

    const blob = await canvasToBlob(canvas);

    setModelEditorImage({ blob, previewUrl: URL.createObjectURL(blob) });
    closeImageTool();
}


// --- Crop: drag a box over the picture ---

function startCrop() {

    const { image } = modelToolState;
    const preview = document.getElementById("model-image-preview");

    preview.innerHTML =
        `<div class="crop-stage">` +
        `<img src="${image.src}" alt="" draggable="false">` +
        `<div class="crop-box" hidden></div>` +
        `</div>`;

    const stage = preview.querySelector(".crop-stage");
    const shown = stage.querySelector("img");
    const box = stage.querySelector(".crop-box");

    const panel = toolPanel(
        `<div class="model-tool-hint">Drag over the picture to choose what to keep.</div>` +
        `<div class="model-tool-readout" id="crop-readout">Whole picture: ${image.naturalWidth} × ${image.naturalHeight}</div>`,
        () => applyCrop()
    );

    const apply = panel.querySelector(".model-tool-apply");

    apply.disabled = true;

    let start = null;

    const point = (event) => {

        const rect = shown.getBoundingClientRect();

        return {
            x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
            y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
            scale: image.naturalWidth / rect.width
        };
    };

    stage.onpointerdown = (event) => {
        event.preventDefault();
        stage.setPointerCapture(event.pointerId);
        start = point(event);
    };

    stage.onpointermove = (event) => {

        if (!start) {
            return;
        }

        const now = point(event);
        const left = Math.min(start.x, now.x);
        const top = Math.min(start.y, now.y);
        const width = Math.abs(now.x - start.x);
        const height = Math.abs(now.y - start.y);

        Object.assign(box.style, {
            left: `${shown.offsetLeft + left}px`,
            top: `${shown.offsetTop + top}px`,
            width: `${width}px`,
            height: `${height}px`
        });
        box.hidden = false;

        const crop = {
            x: Math.round(left * now.scale),
            y: Math.round(top * now.scale),
            width: Math.round(width * now.scale),
            height: Math.round(height * now.scale)
        };

        modelToolState.crop = crop;

        document.getElementById("crop-readout").textContent = `Keep ${crop.width} × ${crop.height}`;
        apply.disabled = crop.width < 8 || crop.height < 8;
    };

    stage.onpointerup = () => {
        start = null;
    };
}


async function applyCrop() {

    const { image, crop } = modelToolState;
    const canvas = document.createElement("canvas");

    canvas.width = crop.width;
    canvas.height = crop.height;
    canvas.getContext("2d").drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

    await applyPictureResult(canvas);
}


// --- Remove background: flood in from the edges ---

//
// The background is taken to be the color around the picture's edge (the
// median of the border pixels). Everything connected to the edge that's
// within `tolerance` of it is cleared - so a white window inside the van
// stays, since it isn't connected - and pixels near the cut fade out with
// the background color taken back out of them, so edges come out soft
// rather than with a halo.
//
function removeBackground(source, tolerance) {

    const { width, height } = source;
    const data = source.data;
    const out = new ImageData(new Uint8ClampedArray(data), width, height);
    const pixels = out.data;

    const border = [[], [], []];

    const sample = (x, y) => {
        const i = (y * width + x) * 4;
        border[0].push(data[i]);
        border[1].push(data[i + 1]);
        border[2].push(data[i + 2]);
    };

    for (let x = 0; x < width; x++) {
        sample(x, 0);
        sample(x, height - 1);
    }

    for (let y = 0; y < height; y++) {
        sample(0, y);
        sample(width - 1, y);
    }

    const background = border.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);

    const distance = (i) => Math.max(
        Math.abs(data[i] - background[0]),
        Math.abs(data[i + 1] - background[1]),
        Math.abs(data[i + 2] - background[2])
    );

    const seen = new Uint8Array(width * height);
    const stack = [];

    const push = (x, y) => {

        const p = y * width + x;

        if (!seen[p] && (data[p * 4 + 3] < 16 || distance(p * 4) < tolerance)) {
            seen[p] = 1;
            stack.push(p);
        }
    };

    for (let x = 0; x < width; x++) {
        push(x, 0);
        push(x, height - 1);
    }

    for (let y = 0; y < height; y++) {
        push(0, y);
        push(width - 1, y);
    }

    while (stack.length) {

        const p = stack.pop();
        const x = p % width;
        const y = (p - x) / width;

        if (x > 0) push(x - 1, y);
        if (x < width - 1) push(x + 1, y);
        if (y > 0) push(x, y - 1);
        if (y < height - 1) push(x, y + 1);
    }

    for (let p = 0; p < width * height; p++) {

        if (!seen[p]) {
            continue;
        }

        const i = p * 4;
        const alpha = Math.min(1, distance(i) / tolerance) ** 2;

        if (alpha < 0.04) {
            pixels[i + 3] = 0;
            continue;
        }

        for (let c = 0; c < 3; c++) {
            pixels[i + c] = (data[i + c] - (1 - alpha) * background[c]) / alpha;
        }

        pixels[i + 3] = data[i + 3] * alpha;
    }

    return out;
}


function startBackgroundRemoval() {

    const canvas = imageToCanvas(modelToolState.image);

    modelToolState.source = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    modelToolState.result = canvas;

    const preview = document.getElementById("model-image-preview");

    preview.innerHTML = "";
    preview.appendChild(canvas);

    const panel = toolPanel(
        `<label class="model-tool-slider">Tolerance <input type="range" min="4" max="160" value="48"></label>` +
        `<div class="model-tool-hint">Clears the color around the edge and anything joined to it. ` +
        `Raise it if background is left behind, lower it if the vehicle starts to vanish.</div>`,
        () => applyPictureResult(modelToolState.result)
    );

    const slider = panel.querySelector("input[type=range]");

    const update = () => {
        canvas.getContext("2d").putImageData(removeBackground(modelToolState.source, Number(slider.value)), 0, 0);
    };

    slider.oninput = update;
    update();
}


// --- Create icon: trim, square up, preview on the map ---

//
// Trims to what's actually visible (pixels that aren't transparent - so
// Remove background first for a clean marker), then centers it in a
// transparent ICON_SIZE square.
//
function makeIcon(image) {

    const canvas = imageToCanvas(image);
    const { width, height } = canvas;
    const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;

    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] > 16) {
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        }
    }

    if (right < 0) {
        left = 0;
        top = 0;
        right = width - 1;
        bottom = height - 1;
    }

    const trimmedWidth = right - left + 1;
    const trimmedHeight = bottom - top + 1;
    const scale = (ICON_SIZE - ICON_PADDING * 2) / Math.max(trimmedWidth, trimmedHeight);

    const icon = document.createElement("canvas");

    icon.width = ICON_SIZE;
    icon.height = ICON_SIZE;

    const context = icon.getContext("2d");

    context.imageSmoothingQuality = "high";
    context.drawImage(
        canvas, left, top, trimmedWidth, trimmedHeight,
        (ICON_SIZE - trimmedWidth * scale) / 2, (ICON_SIZE - trimmedHeight * scale) / 2,
        trimmedWidth * scale, trimmedHeight * scale
    );

    //
    // Nothing transparent to trim to means the picture still has its
    // background - worth a nudge.
    //
    const hasBackground = left === 0 && top === 0 && right === width - 1 && bottom === height - 1 &&
        [0, width - 1].every((x) => [0, height - 1].every((y) => data[(y * width + x) * 4 + 3] > 200));

    return { icon, hasBackground };
}


function startIcon() {

    const { icon, hasBackground } = makeIcon(modelToolState.image);

    modelToolState.icon = icon;

    const url = icon.toDataURL("image/png");
    const preview = document.getElementById("model-image-preview");

    preview.innerHTML =
        `<div class="icon-stage">` +
        `<img class="icon-stage-big" src="${url}" alt="">` +
        `<div class="icon-stage-maps">` +
        `<span class="icon-on-map light"><img src="${url}" alt=""></span>` +
        `<span class="icon-on-map dark"><img src="${url}" alt=""></span>` +
        `</div>` +
        `</div>`;

    toolPanel(
        `<div class="model-tool-hint">How this model's driving vehicles will look on the map ` +
        `(light and dark maps, right).` +
        (hasBackground ? ` <b>It still has a background</b> - Remove background first for a clean marker.` : "") +
        `</div>`,
        async () => {
            const blob = await canvasToBlob(modelToolState.icon);
            setModelEditorIcon({ blob, previewUrl: URL.createObjectURL(blob) });
            closeImageTool();
        }
    );
}


// --- Detect vehicle: an AI cutout, done by the backend ---

//
// Sends the picture as it is now to POST /api/vehicle-models/cutout, where
// an AI model (IS-Net, see cut_out_vehicle() in app.py) finds the vehicle
// and clears everything else - street, buildings, shadows, what shows
// through the windows - then trims to it. Takes a few seconds; nothing is
// stored until the model's saved. Touch up with the eraser afterwards.
//
async function startDetect() {

    const preview = document.getElementById("model-image-preview");

    preview.innerHTML =
        `<img src="${modelToolState.image.src}" alt="" class="detect-source">` +
        `<div class="detect-working">Finding the vehicle...</div>`;

    const panel = toolPanel(
        `<label class="model-tool-check"><input type="checkbox" class="detect-trim" checked> Trim to the vehicle</label>` +
        `<div class="model-tool-hint" id="detect-status">An AI model finds the vehicle and clears the rest. ` +
        `A few seconds - the first one after a restart takes a little longer.</div>`,
        () => applyPictureResult(modelToolState.result)
    );

    const apply = panel.querySelector(".model-tool-apply");
    const trim = panel.querySelector(".detect-trim");

    trim.onchange = () => runDetect();

    apply.disabled = true;

    modelToolState.source = await (await fetch(modelToolState.image.src)).blob();

    await runDetect();
}


async function runDetect() {

    const state = modelToolState;

    if (!state || modelImageTool !== "detect") {
        return;
    }

    const panel = document.getElementById("model-tool-panel");
    const apply = panel.querySelector(".model-tool-apply");
    const status = document.getElementById("detect-status");
    const preview = document.getElementById("model-image-preview");
    const trim = panel.querySelector(".detect-trim").checked;
    const run = (state.run || 0) + 1;

    state.run = run;
    apply.disabled = true;
    preview.classList.add("detecting");

    const formData = new FormData();
    formData.append("file", state.source, "picture");

    let response;

    try {
        response = await apiFetch(API + `/api/vehicle-models/cutout?trim=${trim}`, { method: "POST", body: formData });
    } catch (e) {
        response = null;
    }

    //
    // The tool was closed, or the checkbox changed again, while this one
    // was out - its answer is stale.
    //
    if (modelToolState !== state || state.run !== run) {
        return;
    }

    preview.classList.remove("detecting");

    if (!response || !response.ok) {

        const data = response ? await response.json().catch(() => ({})) : {};

        status.textContent = "Didn't work - " + (data.detail || "couldn't reach the server, try again.");
        preview.querySelector(".detect-working")?.remove();
        return;
    }

    const image = await loadImage(URL.createObjectURL(await response.blob()));

    state.result = imageToCanvas(image);
    URL.revokeObjectURL(image.src);

    preview.innerHTML = "";
    preview.appendChild(state.result);

    status.textContent = "Found it. Apply to use it, then touch up with the Eraser if needed.";
    apply.disabled = false;
}


// --- Eraser: paint transparency by hand, GIMP-style ---

//
// A brush over the picture: Erase clears what it passes over, Restore
// paints the original back (GIMP's "anti-erase") - for tidying up after
// Remove background, or outlining a vehicle by hand. Size is in the
// picture's own pixels and Softness feathers the brush edge. Zoom makes
// the stage scroll so an outline can be traced closely. Bucket clears a
// whole area with one click, bounded by what's already erased (see
// bucketErase()) - trace round the vehicle, then click the background.
// Ctrl+click sets a start point and the next Ctrl+click brushes a
// straight line to it (previewed while Ctrl is held), chaining on from
// there - for long clean edges. Every stroke, line and fill can be undone
// (Undo, or Ctrl+Z); [ and ] change the size; holding Alt while painting
// flips Erase and Restore for that stroke.
//
const ERASER_UNDO_LIMIT = 30;

//
// For Bucket, a pixel this transparent or more is erased space - the wall
// the fill stops at. Low enough that a stroke's soft edge is still filled
// through (so no faint halo is left outside an outline), and only its
// fully cleared core holds the fill back.
//
const BUCKET_WALL_ALPHA = 8;
const ERASER_ZOOMS = [1, 2, 3, 4];


function startEraser() {

    const source = imageToCanvas(modelToolState.image);
    const work = imageToCanvas(modelToolState.image);

    Object.assign(modelToolState, {
        source,
        work,
        undo: [],
        mode: "erase",
        size: Math.max(4, Math.round(Math.max(work.width, work.height) / 40)),
        softness: 30,
        zoom: 1
    });

    const preview = document.getElementById("model-image-preview");

    preview.classList.add("erasing");
    preview.innerHTML =
        `<div class="erase-stage">` +
        `<div class="erase-surface"></div>` +
        `<div class="erase-cursor" hidden></div>` +
        `<svg class="erase-line" hidden><line></line><circle r="4"></circle></svg>` +
        `</div>`;

    const stage = preview.querySelector(".erase-stage");
    const surface = stage.querySelector(".erase-surface");
    const cursor = stage.querySelector(".erase-cursor");
    const lineOverlay = stage.querySelector(".erase-line");

    surface.appendChild(work);

    const panel = toolPanel(
        `<div class="eraser-row">` +
        `<div class="eraser-modes" role="group" aria-label="Brush">` +
        `<button type="button" data-mode="erase" class="active">Erase</button>` +
        `<button type="button" data-mode="restore">Restore</button>` +
        `<button type="button" data-mode="fill" title="Clear a whole area, up to what's already erased">Bucket</button>` +
        `</div>` +
        `<div class="eraser-zooms" role="group" aria-label="Zoom">` +
        ERASER_ZOOMS.map((zoom) => `<button type="button" data-zoom="${zoom}"${zoom === 1 ? ' class="active"' : ""}>${zoom}×</button>`).join("") +
        `</div>` +
        `<button type="button" class="eraser-undo" disabled>Undo</button>` +
        `</div>` +
        `<label class="model-tool-slider">Size <input type="range" class="eraser-size" min="1" max="200"> <span class="eraser-size-value"></span></label>` +
        `<label class="model-tool-slider">Softness <input type="range" class="eraser-softness" min="0" max="100"> <span class="eraser-softness-value"></span></label>` +
        `<div class="model-tool-hint">Paint over what to clear. Restore brings the original back. ` +
        `Bucket clears a whole area with one click, stopping at what's already erased - ` +
        `trace a closed outline round the vehicle, then click the background. ` +
        `Ctrl+click, then Ctrl+click again, for a straight line between them. ` +
        `[ and ] change the size, Ctrl+Z undoes, Alt flips the brush while held.</div>`,
        () => applyPictureResult(modelToolState.work)
    );

    const sizeSlider = panel.querySelector(".eraser-size");
    const softnessSlider = panel.querySelector(".eraser-softness");
    const undoButton = panel.querySelector(".eraser-undo");

    const renderControls = () => {

        const state = modelToolState;

        sizeSlider.value = state.size;
        softnessSlider.value = state.softness;
        panel.querySelector(".eraser-size-value").textContent = `${state.size}px`;
        panel.querySelector(".eraser-softness-value").textContent = `${state.softness}%`;
        undoButton.disabled = !state.undo.length;

        for (const button of panel.querySelectorAll("[data-mode]")) {
            button.classList.toggle("active", button.dataset.mode === state.mode);
        }

        //
        // Bucket is a click, not a brush - a crosshair instead of the ring.
        //
        stage.classList.toggle("bucket", state.mode === "fill");

        for (const button of panel.querySelectorAll("[data-zoom]")) {
            button.classList.toggle("active", Number(button.dataset.zoom) === state.zoom);
        }
    };

    //
    // How big the picture is drawn: fit to the stage at 1x, then zoomed -
    // the stage scrolls once it's bigger than the box.
    //
    const layout = () => {

        const state = modelToolState;
        const fit = Math.min((stage.clientWidth - 8) / work.width, (stage.clientHeight - 8) / work.height, 1);

        state.displayScale = fit * state.zoom;

        work.style.width = `${work.width * state.displayScale}px`;
        work.style.height = `${work.height * state.displayScale}px`;
    };

    const toPicture = (event) => {
        const rect = work.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) / modelToolState.displayScale,
            y: (event.clientY - rect.top) / modelToolState.displayScale
        };
    };

    const moveCursor = (event) => {

        const stageRect = stage.getBoundingClientRect();
        const diameter = modelToolState.size * modelToolState.displayScale;

        Object.assign(cursor.style, {
            width: `${diameter}px`,
            height: `${diameter}px`,
            left: `${event.clientX - stageRect.left + stage.scrollLeft - diameter / 2}px`,
            top: `${event.clientY - stageRect.top + stage.scrollTop - diameter / 2}px`
        });
        cursor.hidden = false;
    };

    //
    // A point on the picture -> where it sits in the stage's scrolled
    // content, for drawing the line preview over it.
    //
    const toStage = (point) => {

        const workRect = work.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();

        return {
            x: workRect.left - stageRect.left + stage.scrollLeft + point.x * modelToolState.displayScale,
            y: workRect.top - stageRect.top + stage.scrollTop + point.y * modelToolState.displayScale
        };
    };

    let pointer = null; // the last pointer position over the stage, in picture pixels

    //
    // The pending line: a dot at the start point whenever there is one,
    // plus the line itself - brush-wide - to the pointer while Ctrl is held.
    //
    const renderLinePreview = (ctrlHeld) => {

        const anchor = modelToolState.lineAnchor;

        if (!anchor) {
            lineOverlay.hidden = true;
            return;
        }

        lineOverlay.hidden = false;
        lineOverlay.setAttribute("width", stage.scrollWidth);
        lineOverlay.setAttribute("height", stage.scrollHeight);

        const start = toStage(anchor);
        const dot = lineOverlay.querySelector("circle");
        const line = lineOverlay.querySelector("line");

        dot.setAttribute("cx", start.x);
        dot.setAttribute("cy", start.y);

        line.style.display = ctrlHeld && pointer ? "" : "none";

        if (ctrlHeld && pointer) {

            const end = toStage(pointer);

            line.setAttribute("x1", start.x);
            line.setAttribute("y1", start.y);
            line.setAttribute("x2", end.x);
            line.setAttribute("y2", end.y);
            line.setAttribute("stroke-width", Math.max(1, modelToolState.size * modelToolState.displayScale));
        }
    };

    modelToolState.renderLinePreview = renderLinePreview;

    let last = null;
    let strokeMode = null;

    const pushUndo = () => {

        const state = modelToolState;

        state.undo.push(work.getContext("2d").getImageData(0, 0, work.width, work.height));

        if (state.undo.length > ERASER_UNDO_LIMIT) {
            state.undo.shift();
        }
    };

    stage.onpointerdown = (event) => {

        if (event.button !== 0) {
            return;
        }

        event.preventDefault();

        const state = modelToolState;
        const brushMode = event.altKey ? (state.mode === "erase" ? "restore" : "erase") : state.mode;

        //
        // Ctrl+click: the first sets the start point (nothing painted yet),
        // each one after brushes a straight line from it and becomes the
        // next start.
        //
        if ((event.ctrlKey || event.metaKey) && state.mode !== "fill") {

            const point = toPicture(event);

            if (state.lineAnchor) {
                pushUndo();
                eraserSegment(state.lineAnchor, point, brushMode, true);
            }

            state.lineAnchor = point;

            renderLinePreview(true);
            renderControls();
            return;
        }

        state.lineAnchor = null;
        renderLinePreview(false);

        stage.setPointerCapture(event.pointerId);
        pushUndo();

        if (state.mode === "fill") {

            //
            // Nothing to fill (clicked on erased space, or off the
            // picture) - that click shouldn't cost an undo step.
            //
            if (!bucketErase(toPicture(event))) {
                state.undo.pop();
            }

            renderControls();
            return;
        }

        strokeMode = brushMode;
        last = toPicture(event);

        eraserStamp(last.x, last.y, strokeMode);
        renderControls();
    };

    stage.onpointermove = (event) => {

        moveCursor(event);

        pointer = toPicture(event);
        renderLinePreview(event.ctrlKey || event.metaKey);

        if (!last) {
            return;
        }

        if (eraserSegment(last, pointer, strokeMode, false)) {
            last = pointer;
        }
    };

    stage.onscroll = () => renderLinePreview(false);

    stage.onpointerup = () => {
        last = null;
    };

    stage.onpointerleave = () => {
        cursor.hidden = true;
    };

    for (const button of panel.querySelectorAll("[data-mode]")) {
        button.onclick = () => {

            modelToolState.mode = button.dataset.mode;

            //
            // Bucket has no lines, so a pending start point goes with it.
            //
            if (modelToolState.mode === "fill") {
                modelToolState.lineAnchor = null;
                renderLinePreview(false);
            }

            renderControls();
        };
    }

    for (const button of panel.querySelectorAll("[data-zoom]")) {
        button.onclick = () => {
            modelToolState.zoom = Number(button.dataset.zoom);
            layout();
            renderControls();
        };
    }

    sizeSlider.oninput = () => {
        modelToolState.size = Number(sizeSlider.value);
        renderControls();
    };

    softnessSlider.oninput = () => {
        modelToolState.softness = Number(softnessSlider.value);
        renderControls();
    };

    undoButton.onclick = eraserUndo;

    modelToolState.renderControls = renderControls;

    //
    // Refit when the editor changes size (the window, or the stacked
    // layout on a narrow screen) - disconnected in closeImageTool().
    //
    modelToolState.resizeObserver = new ResizeObserver(layout);
    modelToolState.resizeObserver.observe(stage);

    layout();
    renderControls();
}


//
// One dab of the brush at (x, y) in picture pixels. Softness is how much
// of the radius fades out (a radial gradient); Restore copies that same
// dab of the original back in.
//
function eraserStamp(x, y, mode) {

    const { source, work, size, softness } = modelToolState;
    const radius = size / 2;
    const context = work.getContext("2d");

    const brush = (target, ox, oy) => {

        const gradient = target.createRadialGradient(ox, oy, 0, ox, oy, radius);
        const hard = Math.min(0.99, 1 - softness / 100);

        gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
        gradient.addColorStop(hard, "rgba(0, 0, 0, 1)");
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

        target.fillStyle = gradient;
        target.beginPath();
        target.arc(ox, oy, radius, 0, Math.PI * 2);
        target.fill();
    };

    if (mode === "erase") {

        context.save();
        context.globalCompositeOperation = "destination-out";
        brush(context, x, y);
        context.restore();
        return;
    }

    const diameter = Math.ceil(size) + 2;
    const stamp = document.createElement("canvas");

    stamp.width = diameter;
    stamp.height = diameter;

    const stampContext = stamp.getContext("2d");
    const left = x - diameter / 2;
    const top = y - diameter / 2;

    stampContext.drawImage(source, -left, -top);
    stampContext.globalCompositeOperation = "destination-in";
    brush(stampContext, diameter / 2, diameter / 2);

    context.drawImage(stamp, left, top);
}


//
// Clears everything connected to the clicked pixel that isn't already
// erased (alpha above BUCKET_WALL_ALPHA) - a flood fill whose boundary is
// the erased space. False if there was nothing there to clear.
//
function bucketErase(point) {

    const { work } = modelToolState;
    const { width, height } = work;
    const x = Math.floor(point.x);
    const y = Math.floor(point.y);

    if (x < 0 || y < 0 || x >= width || y >= height) {
        return false;
    }

    const context = work.getContext("2d");
    const image = context.getImageData(0, 0, width, height);
    const data = image.data;
    const start = y * width + x;

    if (data[start * 4 + 3] <= BUCKET_WALL_ALPHA) {
        return false;
    }

    const seen = new Uint8Array(width * height);
    const stack = [start];

    seen[start] = 1;

    const visit = (p) => {
        if (!seen[p] && data[p * 4 + 3] > BUCKET_WALL_ALPHA) {
            seen[p] = 1;
            stack.push(p);
        }
    };

    while (stack.length) {

        const p = stack.pop();
        const px = p % width;

        data[p * 4 + 3] = 0;

        if (px > 0) visit(p - 1);
        if (px < width - 1) visit(p + 1);
        if (p >= width) visit(p - width);
        if (p < width * (height - 1)) visit(p + width);
    }

    context.putImageData(image, 0, 0);

    return true;
}


//
// Brushes from `from` to `to` in dabs a fifth of the brush apart - a drag's
// latest stretch, or a whole Ctrl+click line (withStart: the line's first
// dab too, which a drag already painted). False if the two are closer than
// one dab, so a drag can wait for the pointer to move further.
//
function eraserSegment(from, to, mode, withStart) {

    const step = Math.max(1, modelToolState.size / 5);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);

    if (withStart) {
        eraserStamp(from.x, from.y, mode);
    }

    for (let travelled = step; travelled <= distance; travelled += step) {
        const t = travelled / distance;
        eraserStamp(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, mode);
    }

    if (withStart && distance > 0) {
        eraserStamp(to.x, to.y, mode);
    }

    return distance >= step;
}


function eraserUndo() {

    const state = modelToolState;

    if (!state || !state.undo || !state.undo.length) {
        return;
    }

    state.work.getContext("2d").putImageData(state.undo.pop(), 0, 0);
    state.renderControls();
}


document.addEventListener("keydown", (event) => {

    if (modelImageTool !== "erase" || event.target.matches("input:not([type=range]), select, textarea")) {
        return;
    }

    if (event.key === "Control" || event.key === "Meta") {
        modelToolState.renderLinePreview(true);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        eraserUndo();
    } else if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        const state = modelToolState;
        const factor = event.key === "]" ? 1.25 : 0.8;
        state.size = Math.min(200, Math.max(1, Math.round(state.size * factor + (event.key === "]" ? 1 : -1))));
        state.renderControls();
    }
});


document.addEventListener("keyup", (event) => {

    if (modelImageTool === "erase" && (event.key === "Control" || event.key === "Meta")) {
        modelToolState.renderLinePreview(false);
    }
});


// ---------- Import ----------

//
// The other half of "Export (ZIP)" (POST /api/vehicle-models/upload). Small
// enough to run inline on the backend, so the result comes straight back,
// no job to poll. The export's ZIP brings its pictures and map icons back
// too; a plain CSV leaves each model's pictures as they are.
//
async function uploadVehicleModels() {

    const fileInput = document.getElementById("vehicle-model-file-input");

    if (!fileInput.files.length) {
        setModelsResult("error", "Not imported - choose a vehicle model export (.zip or .csv) first.");
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

    if (data.pictures) {
        parts.push(`${data.pictures} picture${data.pictures === 1 ? "" : "s"} / icon${data.pictures === 1 ? "" : "s"} restored`);
    }

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

    for (const button of document.querySelectorAll(".model-image-tools button")) {
        button.onclick = () => openImageTool(button.dataset.tool);
    }

    document.getElementById("model-icon-remove").onclick = removeModelEditorIcon;

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

    if (modelImageTool === "erase" && modelToolState.lineAnchor) {
        modelToolState.lineAnchor = null;
        modelToolState.renderLinePreview(false);
    } else if (modelImageTool) {
        closeImageTool();
    } else if (document.getElementById("model-editor").style.display !== "none") {
        closeModelEditor();
    } else {
        closeVehicleModelsPage();
    }
});
