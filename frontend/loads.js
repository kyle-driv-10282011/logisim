//
// The load board: the work a parked vehicle can take on. Selecting a READY
// vehicle in My Vehicles shows loads it can carry with pickups near where
// it's parked (GET /api/vehicles/{id}/loads - the backend tops the board up
// as needed), nearest first. Accepting one sends the vehicle to the pickup,
// then on to the delivery, where it's paid (see handle_load_arrival() in
// app.py); vehicles don't go anywhere on their own any more.
//
// Hovering a load shows it on the map: the empty run to its pickup
// (dashed) and the loaded run to its delivery. Clicking it also zooms the
// map to fit it.
//

let loadBoard = { vehicleId: null, loads: [], location: "", status: "idle", error: "" };

let loadPreviewLayer = null;

//
// How far the board usually looks for pickups (LOAD_BOARD_RADIUS_MILES in
// app.py) - further only when there's nothing that close.
//
const LOAD_BOARD_USUAL_RADIUS_MILES = 120;


function renderLoadBoard() {

    const container = document.getElementById("load-board");
    const vehicle = vehiclesById.get(selectedTripVehicleId);

    if (!vehicle) {

        //
        // Forgotten on deselect, so picking the vehicle again later shows
        // the board as it is then, not offers that may have expired.
        //
        loadBoard = { vehicleId: null, loads: [], location: "", status: "idle", error: "" };

        container.style.display = "none";
        clearLoadPreview();
        return;
    }

    container.style.display = "";

    if (vehicle.load) {
        clearLoadPreview();
        container.innerHTML =
            `<div class="load-board-empty">${escapeLoadText(vehicle.name)} is busy with ` +
            `${escapeLoadText(activeLoadSummary(vehicle.load))}.</div>`;
        return;
    }

    if (loadBoard.vehicleId !== vehicle.id) {
        fetchLoadBoard(vehicle.id);
        return;
    }

    const header =
        `<div class="load-board-header">` +
        `<div><b>Loads near ${escapeLoadText(loadBoard.location || vehicle.current_location)}</b>` +
        `<div class="load-board-sub">for ${escapeLoadText(vehicle.name)}</div></div>` +
        `<button class="load-board-refresh" title="Check the board again">&#8635;</button>` +
        `</div>`;

    let body;

    if (loadBoard.status === "loading") {
        body = `<div class="list-loading">Checking the board...</div>`;
    } else if (loadBoard.status === "error") {
        body = `<div class="list-loading-error">${escapeLoadText(loadBoard.error)}</div>`;
    } else if (!loadBoard.loads.length) {
        body = `<div class="load-board-empty">Nothing this vehicle can carry nearby right now - check back soon.</div>`;
    } else {

        //
        // Out in the sticks the board looks further than its usual 120 mi
        // (LOAD_SEARCH_RADII in app.py) - say so, since the drive to the
        // pickup will be a long, unpaid one.
        //
        const nearest = loadBoard.loads[0].pickup_miles;
        const widened = loadBoard.searchRadius > LOAD_BOARD_USUAL_RADIUS_MILES
            ? `<div class="load-board-widened">Nothing within ${LOAD_BOARD_USUAL_RADIUS_MILES} mi - ` +
              `the nearest work is about ${Math.round(nearest)} mi away (an unpaid drive).</div>`
            : "";

        body = widened + loadBoard.loads.map(loadRowHtml).join("");
    }

    container.innerHTML = header + body;

    container.querySelector(".load-board-refresh").onclick = () => fetchLoadBoard(vehicle.id);

    for (const row of container.querySelectorAll(".load-row")) {

        const load = loadBoard.loads.find((entry) => entry.id === Number(row.dataset.id));

        row.onmouseenter = () => showLoadPreview(vehicle, load, false);
        row.onmouseleave = clearLoadPreview;

        row.onclick = (event) => {
            if (!event.target.closest(".load-accept")) {
                showLoadPreview(vehicle, load, true);
            }
        };

        const accept = row.querySelector(".load-accept");

        accept.onclick = () => withSpinner(accept, () => acceptLoad(vehicle.id, load));
    }
}


function escapeLoadText(text) {

    const div = document.createElement("div");
    div.textContent = text;

    return div.innerHTML;
}


function loadQuantity(load) {

    return load.kind === "passengers"
        ? `${load.quantity} passenger${load.quantity === 1 ? "" : "s"}`
        : `${load.quantity} cu ft`;
}


function formatGameDateTime(iso) {

    return new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "short",
        hour: "numeric",
        minute: "2-digit"
    }).format(parseGameTime(iso));
}


function loadRowHtml(load) {

    const perMile = load.pay / Math.max(load.estimated_miles, 1);

    return (
        `<div class="load-row" data-id="${load.id}">` +
        `<div class="load-row-top">` +
        `<div class="load-cargo">${escapeLoadText(load.cargo)} <span>${loadQuantity(load)}</span></div>` +
        `<div class="load-pay">${formatDoubloons(load.pay)}<span>${formatDoubloons(perMile)}/mi</span></div>` +
        `</div>` +
        `<div class="load-route">${escapeLoadText(load.origin)} &rarr; ${escapeLoadText(load.destination)}</div>` +
        `<div class="load-meta">` +
        `<span>${load.pickup_miles ? `Pickup ${Math.round(load.pickup_miles)} mi away` : "Pickup here"}</span>` +
        `<span>~${Math.round(load.estimated_miles)} mi loaded</span>` +
        `<span title="If accepted now">Due ${formatGameDateTime(load.deliver_by_if_accepted)} (${load.allowed_hours} h)</span>` +
        `<span>Offer ends ${formatGameDateTime(load.expires_game_time)}</span>` +
        `</div>` +
        `<button class="load-accept">Accept</button>` +
        `</div>`
    );
}


async function fetchLoadBoard(vehicleId) {

    loadBoard = { vehicleId, loads: [], location: "", status: "loading", error: "" };
    renderLoadBoard();

    try {

        const response = await apiFetch(API + `/api/vehicles/${vehicleId}/loads`);
        const data = await response.json();

        if (loadBoard.vehicleId !== vehicleId) {
            return;
        }

        if (!response.ok) {
            loadBoard = { ...loadBoard, status: "error", error: data.detail || "Couldn't load the board." };
        } else {
            loadBoard = {
                vehicleId, loads: data.loads, location: data.location, status: "ready", error: "",
                searchRadius: data.search_radius_miles
            };
        }

    } catch (e) {

        if (loadBoard.vehicleId === vehicleId) {
            loadBoard = { ...loadBoard, status: "error", error: "Couldn't reach the server - try again." };
        }
    }

    if (selectedTripVehicleId === vehicleId) {
        renderLoadBoard();
    }
}


//
// Accepting starts the first leg as a background job (routing takes a
// moment): straight to the delivery if the vehicle's already at the
// pickup, otherwise to the pickup first. driveInFlightVehicleId (app.js)
// keeps Sell off its card meanwhile.
//
async function acceptLoad(vehicleId, load) {

    const response = await apiFetch(API + `/api/loads/${load.id}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle_id: vehicleId })
    });

    const data = await response.json();

    if (!response.ok) {
        alert(data.detail || "Couldn't take that load");
        fetchLoadBoard(vehicleId);
        return;
    }

    clearLoadPreview();

    driveInFlightVehicleId = vehicleId;
    renderVehicleList();

    try {
        await pollJob(data.job_id);
    } catch (e) {
        alert(e.message);
    } finally {
        driveInFlightVehicleId = null;
    }

    loadBoard = { vehicleId: null, loads: [], location: "", status: "idle", error: "" };

    await refreshLiveData();
    await loadVehicles();

    //
    // Follow it, now driving, the way the old Drive button did.
    //
    selectVehicle(vehicleId);

    const trip = activeTripsById.get(vehicleId);

    if (trip) {
        map.fitBounds(L.latLngBounds(trip.route), { paddingBottomRight: vehicleOverlayInset() });
    }
}


function showLoadPreview(vehicle, load, fit) {

    clearLoadPreview();

    if (!load) {
        return;
    }

    const here = [vehicle.current_lat, vehicle.current_lng];
    const pickup = [load.origin_lat, load.origin_lng];
    const dropoff = [load.destination_lat, load.destination_lng];
    const color = currentView() === "80s" ? "#2de2e6" : currentView() === "90s" ? "#000080" : "#2f9e44";

    loadPreviewLayer = L.layerGroup([
        L.polyline([here, pickup], { color, weight: 3, opacity: 0.8, dashArray: "6 8", interactive: false }),
        L.polyline([pickup, dropoff], { color, weight: 4, opacity: 0.9, interactive: false }),
        L.circleMarker(pickup, { radius: 6, color, weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false })
            .bindTooltip(`Pickup: ${load.origin}`, { permanent: true, direction: "top", offset: [0, -6] }),
        L.circleMarker(dropoff, { radius: 6, color, weight: 2, fillColor: color, fillOpacity: 1, interactive: false })
            .bindTooltip(`Deliver: ${load.destination}`, { permanent: true, direction: "top", offset: [0, -6] })
    ]).addTo(map);

    if (fit) {
        map.fitBounds(L.latLngBounds([here, pickup, dropoff]).pad(0.2), { paddingBottomRight: vehicleOverlayInset() });
    }
}


function clearLoadPreview() {

    if (loadPreviewLayer) {
        map.removeLayer(loadPreviewLayer);
        loadPreviewLayer = null;
    }
}


//
// A vehicle's load in progress, as one line for its card and spotlight.
//
function activeLoadSummary(load) {

    const what = `${load.cargo} (${loadQuantity(load)})`;
    const due = `due ${formatGameDateTime(load.deliver_by_game_time)}`;

    return load.status === "accepted"
        ? `${what} - heading to pickup in ${load.origin}, ${due}`
        : `${what} - delivering to ${load.destination}, ${due}`;
}


// ---------- The Loads page: every load in this save file ----------

//
// Full screen like Budget (tab menu -> Loads): on the board, in progress,
// delivered, expired and failed, newest first (GET /api/loads), filtered by
// status and vehicle, a page at a time. An available load can be taken
// straight from here by any parked vehicle that fits it - wherever its
// pickup is (the deadline allows for the drive there).
//
const LOAD_STATUS_LABELS = {
    available: "On the board",
    accepted: "To pickup",
    loaded: "Aboard",
    delivered: "Delivered",
    expired: "Expired",
    failed: "Failed",
};

const LOADS_PAGE_SIZE = 100;

let loadsPageOldestId = null;


function openLoadsPage() {

    closeTabMenu();

    const select = document.getElementById("loads-vehicle-filter");
    const previous = select.value;

    select.innerHTML = `<option value="">All vehicles</option>`;

    for (const vehicle of vehiclesById.values()) {
        select.insertAdjacentHTML("beforeend", `<option value="${vehicle.id}">${escapeLoadText(vehicle.name)}</option>`);
    }

    select.value = vehiclesById.has(Number(previous)) ? previous : "";

    document.getElementById("loads-page").style.display = "";

    reloadLoadsPage();
}


function closeLoadsPage() {

    document.getElementById("loads-page").style.display = "none";
}


function reloadLoadsPage() {

    document.getElementById("loads-rows").innerHTML = "";
    loadsPageOldestId = null;

    fetchLoadsPage();
}


async function fetchLoadsPage() {

    const status = document.getElementById("loads-status");
    const more = document.getElementById("loads-load-more");
    const params = new URLSearchParams({ limit: LOADS_PAGE_SIZE });
    const statusFilter = document.getElementById("loads-status-filter").value;
    const vehicleFilter = document.getElementById("loads-vehicle-filter").value;

    if (statusFilter) {
        params.set("status", statusFilter);
    }

    if (vehicleFilter) {
        params.set("vehicle_id", vehicleFilter);
    }

    if (loadsPageOldestId !== null) {
        params.set("before_id", loadsPageOldestId);
    }

    status.textContent = "Loading...";
    more.style.display = "none";

    let data;

    try {

        const response = await apiFetch(API + "/api/loads?" + params);

        data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail);
        }

    } catch (e) {
        status.textContent = "Couldn't load the loads - try again.";
        return;
    }

    renderLoadsSummary(data);

    const rows = document.getElementById("loads-rows");

    for (const load of data.loads) {
        rows.appendChild(loadsPageRow(load));
    }

    if (data.loads.length) {
        loadsPageOldestId = data.loads[data.loads.length - 1].id;
    }

    status.textContent = rows.children.length
        ? ""
        : statusFilter || vehicleFilter
            ? "No loads match these filters."
            : "No loads yet - select a parked vehicle in My Vehicles to see its load board.";
    more.style.display = data.has_more ? "" : "none";
}


function renderLoadsSummary(data) {

    const counts = data.counts;

    document.getElementById("loads-summary").textContent =
        `${counts.available} on the board · ${counts.in_progress} in progress · ` +
        `${counts.delivered} delivered (${formatDoubloons(data.earned)} earned)` +
        (counts.expired ? ` · ${counts.expired} expired` : "") +
        (counts.failed ? ` · ${counts.failed} failed` : "");

    //
    // Each status filter shows how many it would list.
    //
    for (const option of document.querySelectorAll("#loads-status-filter option")) {
        if (option.value) {
            const label = option.textContent.replace(/ \(\d+\)$/, "");
            option.textContent = `${label} (${counts[option.value]})`;
        }
    }
}


//
// Mirrors load_capacity() in app.py: freight up to the cargo space,
// passengers up to the seats less the driver's.
//
function vehicleCanTakeLoad(vehicle, load) {

    const vehicleModel = vehicle.vehicle_model;

    if (!vehicleModel || vehicle.status !== "READY" || vehicle.load || driveInFlightVehicleId === vehicle.id) {
        return false;
    }

    return load.kind === "passengers"
        ? load.quantity <= Math.max(0, vehicleModel.person_capacity - 1)
        : load.quantity <= vehicleModel.cargo_capacity_cuft;
}


function loadsPageRow(load) {

    const row = document.createElement("tr");

    let when = "";

    if (load.status === "available") {
        when = `Offer ends ${formatGameDateTime(load.expires_game_time)}`;
    } else if (load.status === "accepted" || load.status === "loaded") {
        when = `Due ${formatGameDateTime(load.deliver_by_game_time)}`;
    } else if (load.status === "delivered") {
        const late = load.delivered_game_time > load.deliver_by_game_time;
        when = `Delivered ${formatGameDateTime(load.delivered_game_time)}${late ? " (late)" : ""}`;
    } else if (load.status === "expired") {
        when = `Ended ${formatGameDateTime(load.expires_game_time)}`;
    }

    const pay = load.status === "delivered"
        ? formatDoubloons(load.paid) + (load.paid < load.pay ? ` <span class="loads-of">of ${formatDoubloons(load.pay)}</span>` : "")
        : formatDoubloons(load.pay);

    row.innerHTML =
        `<td><span class="load-status load-status-${load.status}">${LOAD_STATUS_LABELS[load.status] || load.status}</span></td>` +
        `<td>${escapeLoadText(load.cargo)}<div class="budget-detail">${loadQuantity(load)}</div></td>` +
        `<td>${escapeLoadText(load.origin)} &rarr; ${escapeLoadText(load.destination)}` +
        `<div class="budget-detail">~${Math.round(load.estimated_miles)} mi</div></td>` +
        `<td>${load.vehicle_name ? escapeLoadText(load.vehicle_name) : "&mdash;"}</td>` +
        `<td>${when || "&mdash;"}</td>` +
        `<td class="budget-cost">${pay}</td>` +
        `<td class="loads-action"></td>`;

    if (load.status === "available") {

        const vehicles = [...vehiclesById.values()].filter((vehicle) => vehicleCanTakeLoad(vehicle, load));
        const cell = row.querySelector(".loads-action");

        if (!vehicles.length) {

            cell.innerHTML = `<span class="budget-detail">No parked vehicle fits</span>`;

        } else {

            cell.innerHTML =
                `<select class="loads-vehicle">` +
                vehicles.map((vehicle) => `<option value="${vehicle.id}">${escapeLoadText(vehicle.name)}</option>`).join("") +
                `</select>` +
                `<button class="loads-accept">Accept</button>`;

            const accept = cell.querySelector(".loads-accept");

            accept.onclick = () => withSpinner(accept, async () => {
                const vehicleId = Number(cell.querySelector(".loads-vehicle").value);
                closeLoadsPage();
                await acceptLoad(vehicleId, load);
            });
        }
    }

    return row;
}


document.addEventListener("keydown", (event) => {

    if (event.key === "Escape" && document.getElementById("loads-page").style.display !== "none") {
        closeLoadsPage();
    }
});
