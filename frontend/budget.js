//
// The Budget page: every Gold Doubloon this save file has spent or been
// refunded (GET /api/ledger), newest first, as a full-width page over the
// map - the side panel is too narrow for its columns. Opened from the tab
// menu's "Budget" entry; it's not a tab itself, so whatever tab was showing
// is still there when it's closed.
//

const BUDGET_PAGE_SIZE = 100;

let budgetOldestId = null;

//
// The dropdown choices (GET /api/ledger/filters): vehicle names, and trips
// as { key, vehicle, trip, started }. Re-fetched each time the page opens.
//
let budgetFilterOptions = { vehicles: [], trips: [], loads: [] };

//
// The Additions / Subtractions / Both toggle: "in" (delivery pay, sales),
// "out" (charges) or "both" - filtered by the backend, so "Load older" pages
// through only the matching entries.
//
let budgetDirection = "both";

for (const button of document.querySelectorAll("#budget-direction button")) {
    button.onclick = () => setBudgetDirection(button.dataset.direction);
}


function setBudgetDirection(direction) {

    budgetDirection = direction;

    for (const button of document.querySelectorAll("#budget-direction button")) {

        const active = button.dataset.direction === direction;

        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
    }

    reloadBudgetRows();
}


async function openBudgetPage() {

    closeTabMenu();

    document.getElementById("budget-page").style.display = "";

    try {

        const response = await apiFetch(API + "/api/ledger/filters");

        if (response.ok) {
            budgetFilterOptions = await response.json();
        }

    } catch (e) {
        // no choices beyond "All" - the table still loads
    }

    renderBudgetVehicleFilter();
    renderBudgetTripFilter();
    renderBudgetLoadFilter();

    reloadBudgetRows();
}


function addBudgetOption(select, value, label) {

    const option = document.createElement("option");

    option.value = value;
    option.textContent = label;

    select.appendChild(option);
}


function renderBudgetVehicleFilter() {

    const select = document.getElementById("budget-vehicle-filter");
    const previous = select.value;

    select.innerHTML = "";

    addBudgetOption(select, "", "All vehicles");

    for (const vehicle of budgetFilterOptions.vehicles) {
        addBudgetOption(select, vehicle, vehicle);
    }

    select.value = budgetFilterOptions.vehicles.includes(previous) ? previous : "";
}


//
// Only the chosen vehicle's trips once one is picked; every trip (with its
// vehicle named) otherwise. The date tells repeat drives of the same route
// apart. A trip that's no longer in the list (a different vehicle was
// picked) falls back to "All trips".
//
function renderBudgetTripFilter() {

    const vehicle = document.getElementById("budget-vehicle-filter").value;
    const select = document.getElementById("budget-trip-filter");
    const previous = select.value;

    const trips = budgetFilterOptions.trips.filter((trip) => !vehicle || trip.vehicle === vehicle);

    select.innerHTML = "";

    addBudgetOption(select, "", vehicle ? `All trips (${trips.length})` : "All trips");

    for (const trip of trips) {

        const started = new Date(trip.started).toLocaleDateString(undefined, { month: "short", day: "numeric" });

        addBudgetOption(
            select,
            trip.key,
            vehicle ? `${trip.trip} · ${started}` : `${trip.trip} · ${trip.vehicle} · ${started}`
        );
    }

    select.value = trips.some((trip) => trip.key === previous) ? previous : "";
}


//
// Loads with money against them - fuel and fees run up hauling them, and
// their delivery pay - narrowed to the chosen vehicle's, like trips.
//
function renderBudgetLoadFilter() {

    const vehicle = document.getElementById("budget-vehicle-filter").value;
    const select = document.getElementById("budget-load-filter");
    const previous = select.value;

    const loads = (budgetFilterOptions.loads || []).filter((load) => !vehicle || load.vehicle === vehicle);

    select.innerHTML = "";

    addBudgetOption(select, "", vehicle ? `All loads (${loads.length})` : "All loads");

    for (const load of loads) {
        addBudgetOption(select, String(load.id), vehicle ? load.label : `${load.label} · ${load.vehicle}`);
    }

    select.value = loads.some((load) => String(load.id) === previous) ? previous : "";
}


function onBudgetVehicleFilterChange() {

    renderBudgetTripFilter();
    renderBudgetLoadFilter();
    reloadBudgetRows();
}


//
// Starts the table over from the newest entry that matches the dropdowns.
//
function reloadBudgetRows() {

    document.getElementById("budget-rows").innerHTML = "";

    budgetOldestId = null;

    loadBudgetPage();
}


function closeBudgetPage() {

    document.getElementById("budget-page").style.display = "none";
}


async function loadBudgetPage() {

    const status = document.getElementById("budget-status");
    const more = document.getElementById("budget-load-more");

    status.textContent = "Loading...";
    more.style.display = "none";

    const params = new URLSearchParams({ limit: BUDGET_PAGE_SIZE });

    if (budgetOldestId !== null) {
        params.set("before_id", budgetOldestId);
    }

    const vehicle = document.getElementById("budget-vehicle-filter").value;
    const trip = document.getElementById("budget-trip-filter").value;

    if (vehicle) {
        params.set("vehicle", vehicle);
    }

    if (trip) {
        params.set("trip", trip);
    }

    const load = document.getElementById("budget-load-filter").value;

    if (load) {
        params.set("load_id", load);
    }

    if (budgetDirection !== "both") {
        params.set("direction", budgetDirection);
    }

    let data;

    try {

        const response = await apiFetch(API + "/api/ledger?" + params);

        if (!response.ok) {
            throw new Error();
        }

        data = await response.json();

    } catch (e) {
        status.textContent = "Couldn't load transactions - try again.";
        return;
    }

    document.getElementById("budget-balance").textContent = formatDoubloons(data.balance);
    document.getElementById("budget-balance").classList.toggle("negative", data.balance < 0);
    renderBalance(data.balance);

    const rows = document.getElementById("budget-rows");

    for (const entry of data.entries) {
        rows.appendChild(budgetRow(entry));
    }

    if (data.entries.length) {
        budgetOldestId = data.entries[data.entries.length - 1].id;
    }

    const filtered = Boolean(vehicle || trip || load || budgetDirection !== "both");

    status.textContent = rows.children.length
        ? ""
        : filtered
            ? "No transactions match these filters."
            : "No transactions yet - fuel, vehicles and delivery pay show up here.";
    more.style.display = data.has_more ? "" : "none";
}


function budgetCell(text, className) {

    const cell = document.createElement("td");

    cell.textContent = text || "—";

    if (className) {
        cell.className = className;
    }

    return cell;
}


function budgetRow(entry) {

    const row = document.createElement("tr");

    row.title = new Date(entry.created).toLocaleString();

    const cost = document.createElement("td");
    const amount = document.createElement("div");
    const detail = document.createElement("div");

    cost.className = "budget-cost";

    amount.className = "budget-amount " + (entry.amount < 0 ? "charge" : "refund");
    amount.textContent = (entry.amount > 0 ? "+" : "") + formatDoubloons(entry.amount);

    detail.className = "budget-detail";
    detail.textContent = entry.description;

    cost.append(amount, detail);

    const balance = budgetCell(
        entry.balance_after !== null ? formatDoubloons(entry.balance_after) : null,
        "budget-balance-after" + (entry.balance_after < 0 ? " negative" : "")
    );

    row.append(
        budgetCell(entry.vehicle),
        budgetCell(entry.location),
        budgetCell(entry.trip),
        budgetCell(entry.load),
        cost,
        balance
    );

    return row;
}


document.addEventListener("keydown", (event) => {

    if (event.key === "Escape" && document.getElementById("budget-page").style.display !== "none") {
        closeBudgetPage();
    }
});
