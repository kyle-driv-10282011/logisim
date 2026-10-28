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
        body = loadBoard.loads.map(loadRowHtml).join("");
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
            loadBoard = { vehicleId, loads: data.loads, location: data.location, status: "ready", error: "" };
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
