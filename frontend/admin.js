//
// The admin role. Everyone plays as a "user" (save files, My Vehicles,
// Budget); anyone who knows the instance's ADMIN_PASSWORD (.env) can
// elevate to "admin" for what every save file shares - gas stations,
// vehicle models, background jobs, erasing files. Not a login: elevating
// just gets a signed, expiring token from POST /api/admin/elevate, which
// apiFetch() sends along as X-Admin-Token.
//
// Admin-only UI carries the .admin-only class and is hidden unless <body>
// has .admin (see index.html). The token lives in sessionStorage, so it
// lasts through the file-select reload but not past closing the tab.
//

const ADMIN_STORAGE_KEY = "logisim-admin";

let adminSession = null; // { token, expires } - expires in epoch seconds

let adminExpiryTimer = null;

try {
    adminSession = JSON.parse(sessionStorage.getItem(ADMIN_STORAGE_KEY));
} catch (e) {
    // not elevated
}


function adminToken() {

    return adminSession && adminSession.expires * 1000 > Date.now() ? adminSession.token : null;
}


function isAdmin() {

    return adminToken() !== null;
}


function setAdminSession(session) {

    adminSession = session;

    try {
        if (session) {
            sessionStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(session));
        } else {
            sessionStorage.removeItem(ADMIN_STORAGE_KEY);
        }
    } catch (e) {
        // admin just won't survive a reload
    }

    applyAdminState();
}


//
// Shows or hides everything admin-only, and steps off anything admin-only
// that was open when admin ended.
//
function applyAdminState() {

    const admin = isAdmin();

    document.body.classList.toggle("admin", admin);

    document.getElementById("tab-button-admin").textContent = admin ? "Leave admin mode" : "Admin mode";
    document.getElementById("fs-admin-button").textContent = admin ? "LEAVE ADMIN" : "ADMIN";

    //
    // Plain download links can't send a header, so they carry the token
    // in the URL instead.
    //
    for (const link of document.querySelectorAll("a[data-admin-href]")) {
        link.href = admin
            ? `${link.dataset.adminHref}?admin_token=${encodeURIComponent(adminToken())}`
            : "#";
    }

    clearTimeout(adminExpiryTimer);

    if (admin) {

        adminExpiryTimer = setTimeout(() => setAdminSession(null), adminSession.expires * 1000 - Date.now());

        loadJobs();

    } else {

        const activeTab = document.querySelector(".tab-button.active");

        if (activeTab && activeTab.classList.contains("admin-only")) {
            showTab("myvehicles");
        }

        if (fileSelectMode === "erase" || fileSelectMode === "confirm-erase") {
            setFileSelectMode("select");
        }
    }
}


//
// The tab menu's "Admin mode" entry and the file-select screen's ADMIN
// button: asks for the password, or leaves admin if already elevated.
//
function toggleAdminMode() {

    closeTabMenu();

    if (isAdmin()) {
        setAdminSession(null);
        return;
    }

    document.getElementById("admin-password").value = "";
    document.getElementById("admin-dialog-error").textContent = "";
    document.getElementById("admin-dialog").style.display = "";
    document.getElementById("admin-password").focus();
}


function closeAdminDialog() {

    document.getElementById("admin-dialog").style.display = "none";
}


async function submitAdminPassword() {

    const input = document.getElementById("admin-password");
    const error = document.getElementById("admin-dialog-error");

    error.textContent = "";

    try {

        const response = await fetch(API + "/api/admin/elevate", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({ password: input.value })

        });

        const data = await response.json();

        if (!response.ok) {
            error.textContent = data.detail || "Couldn't elevate";
            input.select();
            return;
        }

        closeAdminDialog();
        setAdminSession({ token: data.token, expires: data.expires });

    } catch (e) {
        error.textContent = "Couldn't reach the server - try again.";
    }
}


//
// Keys typed in the dialog stay in the dialog - the file-select screen
// listens on the whole document for arrows/Enter/Esc.
//
document.getElementById("admin-dialog").addEventListener("keydown", (event) => {

    event.stopPropagation();

    if (event.key === "Escape") {
        closeAdminDialog();
    }
});


applyAdminState();
