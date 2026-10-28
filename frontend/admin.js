//
// The admin role. Everyone plays as a "user" (save files, My Vehicles,
// Budget); anyone who knows the instance's ADMIN_PASSWORD (.env) can unlock
// what every save file shares - gas stations, vehicle models, background
// jobs, erasing files. Not a login: unlocking just gets a signed, expiring
// token from POST /api/admin/elevate, which apiFetch() sends along as
// X-Admin-Token.
//
// Admin is scoped to the one area that was unlocked: the admin tabs
// (Vehicle Models, Gas Prices, Background Jobs) and Config's backups stay
// listed with a lock (.admin-locked, see index.html), ask for the password
// when opened, and lock again as soon as another tab is shown (showTab()
// calls relockAdminUnless()). The token is only kept in memory, so a
// reload locks everything too.
//

let adminSession = null; // { token, expires } - expires in epoch seconds

//
// The tab admin was unlocked for - leaving it locks admin again.
//
let adminUnlockedTab = null;

let adminExpiryTimer = null;


function adminToken() {

    return adminSession && adminSession.expires * 1000 > Date.now() ? adminSession.token : null;
}


function isAdmin() {

    return adminToken() !== null;
}


function setAdminSession(session, unlockedTab = null) {

    adminSession = session;
    adminUnlockedTab = session ? unlockedTab : null;

    applyAdminState();
}


//
// Locks admin again unless the tab now showing is the one it was unlocked
// for.
//
function relockAdminUnless(tab) {

    if (adminSession && tab !== adminUnlockedTab) {
        setAdminSession(null);
    }
}


//
// Shows or locks everything admin-only, and steps off an admin tab that
// was open when admin ended (expired, or the password changed).
//
function applyAdminState() {

    const admin = isAdmin();

    document.body.classList.toggle("admin", admin);

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

        if (activeTab && activeTab.classList.contains("admin-tab")) {
            showTab("myvehicles");
        }
    }
}


//
// An admin tab's menu entry: asks for the password (unless that tab is
// already unlocked), then opens it.
//
function openAdminTab(tab) {

    closeTabMenu();

    if (isAdmin() && adminUnlockedTab === tab) {
        showTab(tab);
        return;
    }

    openAdminPrompt({
        title: `Unlock ${TAB_LABELS[tab]}`,
        hint: "Admin only - shared by every save file. It locks again when you leave this tab.",
        submitLabel: "Unlock",
        onToken: (token, expires) => {
            setAdminSession({ token, expires }, tab);
            showTab(tab);
        }
    });
}


//
// Config's backups (export/import): unlocked in place - Config itself is
// for everyone - until Config is left.
//
function unlockConfigBackups() {

    openAdminPrompt({
        title: "Unlock backups",
        hint: "Exporting and importing gas stations and vehicle models is admin only. " +
            "It locks again when you leave Config.",
        submitLabel: "Unlock",
        onToken: (token, expires) => setAdminSession({ token, expires }, "config")
    });
}


//
// The password prompt, for whatever needs admin: onToken(token, expires)
// runs with a fresh admin token once the password checks out - elevating
// the page, or a one-off like erasing a file (eraseSelectedFile()).
//
let adminPromptOnToken = null;

function openAdminPrompt({ title, hint, submitLabel, danger = false, onToken }) {

    adminPromptOnToken = onToken;

    document.getElementById("admin-dialog-title").textContent = title;
    document.getElementById("admin-dialog-hint").textContent = hint;

    const submit = document.getElementById("admin-dialog-submit");

    submit.textContent = submitLabel;
    submit.classList.toggle("danger", danger);

    document.getElementById("admin-password").value = "";
    document.getElementById("admin-dialog-error").textContent = "";
    document.getElementById("admin-dialog").style.display = "";
    document.getElementById("admin-password").focus();
}


function closeAdminDialog() {

    document.getElementById("admin-dialog").style.display = "none";

    adminPromptOnToken = null;
}


async function submitAdminPassword() {

    const input = document.getElementById("admin-password");
    const error = document.getElementById("admin-dialog-error");

    error.textContent = "";

    let data;

    try {

        const response = await fetch(API + "/api/admin/elevate", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({ password: input.value })

        });

        data = await response.json();

        if (!response.ok) {
            error.textContent = data.detail || "Couldn't check the password";
            input.select();
            return;
        }

    } catch (e) {
        error.textContent = "Couldn't reach the server - try again.";
        return;
    }

    const onToken = adminPromptOnToken;

    closeAdminDialog();

    try {
        await onToken(data.token, data.expires);
    } catch (e) {
        alert("Couldn't reach the server - try again.");
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
