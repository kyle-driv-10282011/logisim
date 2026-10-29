//
// The Marketplace: where vehicles come from. Each save file has its own
// used-vehicle listings in real cities near its fleet (GET /api/market),
// topped up whenever the page opens - each one of the shared vehicle models
// with its own mileage, condition and asking price. Buying one (POST
// /api/market/{id}/buy) parks it in the fleet where it's listed.
//
// Full screen like Loads, opened from the tab menu or My Vehicles' "Shop
// the Marketplace" button. Its cards reuse the Vehicle Models page's
// (vehiclemodels.css), so every view themes them the same way.
//

let marketListings = [];
let marketBalance = 0;

//
// The "Show on map" pin - one at a time, gone once its popup closes.
//
let marketPreviewMarker = null;


function openMarketPage() {

    closeTabMenu();

    document.getElementById("market-page").style.display = "";
    setMarketResult("", "");

    fetchMarket();
}


function closeMarketPage() {

    document.getElementById("market-page").style.display = "none";
}


function setMarketResult(kind, message) {

    const result = document.getElementById("market-result");

    result.className = "form-result " + kind;
    result.textContent = message;
}


async function fetchMarket() {

    const grid = document.getElementById("market-grid");

    if (!marketListings.length) {
        grid.innerHTML = `<div class="models-empty">Checking the classifieds...</div>`;
    }

    let data;

    try {

        const response = await apiFetch(API + "/api/market");

        data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail);
        }

    } catch (e) {
        grid.innerHTML = `<div class="models-empty">Couldn't load the marketplace - try again.</div>`;
        return;
    }

    marketListings = data.listings;
    marketBalance = data.balance;

    renderMarketPage();
}


//
// Which Type filter a vehicle model falls under, from its size: seats for
// people movers, tires and cargo space for the rest.
//
function marketVehicleType(vehicleModel) {

    if ((vehicleModel.tire_count || 4) >= 18) {
        return "semi";
    }

    if (vehicleModel.person_capacity >= 10) {
        return "passenger";
    }

    if ((vehicleModel.tire_count || 4) > 4 && vehicleModel.cargo_capacity_cuft >= 600) {
        return "truck";
    }

    if (vehicleModel.cargo_capacity_cuft >= 100) {
        return "van";
    }

    return "car";
}


//
// Stands in for a picture - the bundled vehicles come without one until an
// admin adds it (Vehicle Models).
//
const MARKET_TYPE_EMOJI = {
    car: "&#128663;",
    van: "&#128656;",
    passenger: "&#128652;",
    truck: "&#128666;",
    semi: "&#128667;",
};


const MARKET_SORTS = {
    distance: (a, b) => a.distance_miles - b.distance_miles,
    price: (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
    year: (a, b) => b.vehicle_model.year - a.vehicle_model.year || a.mileage - b.mileage,
    mileage: (a, b) => a.mileage - b.mileage,
};


function renderMarketPage() {

    const grid = document.getElementById("market-grid");
    const type = document.getElementById("market-type-filter").value;
    const sort = document.getElementById("market-sort").value;
    const affordableOnly = document.getElementById("market-affordable").checked;

    const listings = marketListings
        .filter((listing) => listing.vehicle_model)
        .filter((listing) => !type || marketVehicleType(listing.vehicle_model) === type)
        .filter((listing) => !affordableOnly || listing.price <= marketBalance)
        .sort(MARKET_SORTS[sort] || MARKET_SORTS.distance);

    const affordable = marketListings.filter((listing) => listing.price <= marketBalance).length;

    document.getElementById("market-summary").textContent =
        `${marketListings.length} for sale nearby · ${affordable} you can afford with ${formatDoubloons(marketBalance)}`;

    grid.innerHTML = "";

    for (const listing of listings) {
        grid.appendChild(marketCard(listing));
    }

    if (!listings.length) {
        grid.innerHTML = `<div class="models-empty">${
            marketListings.length ? "Nothing matches these filters." : "Nothing for sale right now - check back soon."
        }</div>`;
    }
}


function marketCard(listing) {

    const vehicleModel = listing.vehicle_model;
    const imageUrl = vehicleModelImageUrl(vehicleModel);
    const canAfford = listing.price <= marketBalance;
    const card = document.createElement("div");

    card.className = "model-card market-card";

    const from = listing.nearest_vehicle
        ? `${Math.round(listing.distance_miles)} mi from ${escapeLoadText(listing.nearest_vehicle)}`
        : `${Math.round(listing.distance_miles)} mi away`;

    card.innerHTML =
        `<div class="model-card-image">` +
        (imageUrl
            ? `<img src="${imageUrl}" alt="">`
            : `<span class="market-noimage">${MARKET_TYPE_EMOJI[marketVehicleType(vehicleModel)]}</span>`) +
        `<span class="market-condition market-condition-${listing.condition.toLowerCase()}">${escapeLoadText(listing.condition)}</span>` +
        `</div>` +
        `<div class="model-card-body">` +
        `<div class="model-card-name"></div>` +
        `<div class="market-mileage">${Math.round(listing.mileage).toLocaleString()} miles</div>` +
        `<div class="model-card-stats">` +
        `<span>${vehicleModel.person_capacity} people</span>` +
        `<span>${vehicleModel.cargo_capacity_cuft} cu ft</span>` +
        `<span>${vehicleModel.mpg} mpg</span>` +
        `<span>${vehicleModel.fuel_tank_gallons} gal tank</span>` +
        (vehicleModel.tire_count ? `<span>${vehicleModel.tire_count} tires</span>` : "") +
        `</div>` +
        `<div class="model-card-engine"></div>` +
        `<div class="market-location">${escapeLoadText(listing.location)} &middot; ${from}</div>` +
        `<div class="market-until">Listed until ${formatGameDateTime(listing.expires_game_time)}</div>` +
        `<div class="model-card-cost">${formatDoubloons(listing.price)}</div>` +
        `<div class="market-new">${formatDoubloons(vehicleModel.cost)} new</div>` +
        `</div>` +
        `<div class="model-card-actions">` +
        `<button class="market-map-button">Show on map</button>` +
        `<button class="market-buy-button"${canAfford ? "" : " disabled"}` +
        `${canAfford ? "" : ` title="Not enough Gold Doubloons"`}>Buy</button>` +
        `</div>`;

    card.querySelector(".model-card-name").textContent = vehicleModelLabel(vehicleModel);
    card.querySelector(".model-card-engine").textContent = engineSummary(vehicleModel) || "";

    card.querySelector(".market-map-button").onclick = () => showListingOnMap(listing);

    const buy = card.querySelector(".market-buy-button");
    buy.onclick = () => withSpinner(buy, () => buyListing(listing));

    return card;
}


async function buyListing(listing) {

    const label = vehicleModelLabel(listing.vehicle_model);

    if (!confirm(
        `Buy this ${label} (${listing.condition.toLowerCase()}, ${Math.round(listing.mileage).toLocaleString()} mi) ` +
        `for ${formatDoubloons(listing.price)}?\n\nIt's parked in ${listing.location} - that's where it'll start.`
    )) {
        return;
    }

    let response;
    let data;

    try {
        response = await apiFetch(API + `/api/market/${listing.id}/buy`, { method: "POST" });
        data = await response.json();
    } catch (e) {
        setMarketResult("error", "Couldn't reach the server - try again.");
        return;
    }

    if (!response.ok) {
        setMarketResult("error", "Not bought - " + (data.detail || "the seller backed out."));
        fetchMarket();
        return;
    }

    closeMarketPage();

    //
    // Fresh off the lot: it joins My Vehicles and the map, selected, and
    // the balance drops.
    //
    marketListings = marketListings.filter((other) => other.id !== listing.id);

    await loadVehicles();
    loadSettings();

    showTab("myvehicles");
    selectVehicle(data.vehicle_id);

    if (map) {
        map.setView([listing.lat, listing.lng], Math.max(map.getZoom(), 9));
    }
}


function showListingOnMap(listing) {

    closeMarketPage();

    if (marketPreviewMarker) {
        marketPreviewMarker.remove();
    }

    const label = `${vehicleModelLabel(listing.vehicle_model)} - ${formatDoubloons(listing.price)}`;

    marketPreviewMarker = L.marker([listing.lat, listing.lng], { title: label })
        .addTo(map)
        .bindPopup(
            `<b>${escapeLoadText(label)}</b><br>` +
            `${escapeLoadText(listing.condition)}, ${Math.round(listing.mileage).toLocaleString()} mi<br>` +
            `${escapeLoadText(listing.location)}<br>` +
            `<a href="#" class="market-popup-back">Back to the Marketplace</a>`
        )
        .openPopup();

    marketPreviewMarker.on("popupclose", () => {
        if (marketPreviewMarker) {
            marketPreviewMarker.remove();
            marketPreviewMarker = null;
        }
    });

    marketPreviewMarker.getPopup().getElement()?.querySelector(".market-popup-back")?.addEventListener("click", (event) => {
        event.preventDefault();
        marketPreviewMarker.closePopup();
        openMarketPage();
    });

    map.setView([listing.lat, listing.lng], Math.max(map.getZoom(), 8));
}


document.addEventListener("keydown", (event) => {

    if (event.key === "Escape" && document.getElementById("market-page").style.display !== "none") {
        closeMarketPage();
    }
});
