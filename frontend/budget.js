//
// The Budget page: every Gold Doubloon this save file has spent or been
// refunded (GET /api/ledger), newest first, as a full-width page over the
// map - the side panel is too narrow for its columns. Opened from the tab
// menu's "Budget" entry; it's not a tab itself, so whatever tab was showing
// is still there when it's closed.
//

const BUDGET_PAGE_SIZE = 100;

let budgetOldestId = null;


function openBudgetPage() {

    closeTabMenu();

    document.getElementById("budget-page").style.display = "";
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

    status.textContent = rows.children.length ? "" : "No transactions yet - gas bought and refunded shows up here.";
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
