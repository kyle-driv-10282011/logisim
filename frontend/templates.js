//
// Same host the page was loaded from (works whether that's localhost, a
// hostname, or an IP) - just a different port for the backend container.
//
const API = `http://${window.location.hostname}:5000`;

let specsById = new Map();  // spec_id -> vehicle spec (from GET /api/vehicle-specs)
let selectedSpecId = null;  // spec id highlighted in the list


//
// Generic click-to-spinner wrapper for every button on this page: disables
// the button and shows a spinner (see button.spinning in styles.css) for
// as long as fn takes to settle, sync or async alike. Copied from app.js
// rather than shared - this page is intentionally standalone and doesn't
// load app.js, which assumes DOM elements (the map, vehicle/path lists,
// ...) that don't exist here.
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
// Specs are served by the backend as a filename (e.g. "2026-Chevy-Express.png"),
// not a URL - the frontend is what knows it's serving frontend/images/ at its
// own origin (same host/port this page was loaded from), so this is a plain
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
            `$${Math.round(spec.cost).toLocaleString()} &middot; ${spec.mpg} mpg` +
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
// visual focus, same idea as the Places tab's own selection back on the
// main app.
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


loadSpecs();
