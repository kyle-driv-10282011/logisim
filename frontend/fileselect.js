//
// The console-style file-select screen shown on every page load: four
// shared save files (GET /api/slots), each started with a player name and
// erasable, everyone picking from the same four. Nothing else loads until a
// file is picked - startGame() (app.js) then loads that file's world. All
// four files keep running on the server whether or not anyone has them
// open, so a file card's clock and on-the-road count are live.
//
// Mouse or keyboard, like the real thing: arrows move the cursor, Enter
// picks, Esc backs out of naming/erasing.
//

const LAST_SLOT_STORAGE_KEY = "lastSaveSlot";
const FILE_SELECT_COLUMNS = 2;

let fileSelectSlots = [];
let fileSelectCursor = 0;

//
// "select": pick a file to play (or an empty one to start).
// "erase": the next file picked asks to be erased instead.
// "name": entering a name for the empty file under the cursor.
// "confirm-erase": the YES/NO question for the file under the cursor.
//
let fileSelectMode = "select";


async function showFileSelect() {

    try {
        const stored = Number(localStorage.getItem(LAST_SLOT_STORAGE_KEY));
        if (stored >= 1 && stored <= 4) {
            fileSelectCursor = stored - 1;
        }
    } catch (e) {
        // no remembered file - cursor starts on File 1
    }

    document.addEventListener("keydown", handleFileSelectKey);

    document.getElementById("fs-erase-button").onclick = () => {
        setFileSelectMode(fileSelectMode === "erase" ? "select" : "erase");
    };

    await refreshFileSelect();
}


async function refreshFileSelect() {

    try {

        const response = await fetch(API + "/api/slots");

        if (!response.ok) {
            throw new Error();
        }

        fileSelectSlots = await response.json();

    } catch (e) {
        fileSelectSlots = [];
        setFileSelectMessage("Couldn't reach the server - refresh to try again.", true);
    }

    renderFileSelect();
}


function setFileSelectMode(mode) {

    fileSelectMode = mode;

    setFileSelectMessage(
        mode === "erase" ? "Choose a file to erase." : "",
        false
    );

    renderFileSelect();
}


function setFileSelectMessage(text, isError) {

    const message = document.getElementById("fs-message");

    message.textContent = text;
    message.classList.toggle("error", Boolean(isError));
}


function formatFileClock(isoGameTime) {

    return new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "short",
        hour: "numeric",
        minute: "2-digit"
    }).format(parseGameTime(isoGameTime));
}


function escapeFileText(text) {

    const div = document.createElement("div");
    div.textContent = text;

    return div.innerHTML;
}


function renderFileSelect() {

    const container = document.getElementById("fs-files");
    const eraseButton = document.getElementById("fs-erase-button");

    eraseButton.classList.toggle("active", fileSelectMode === "erase");
    eraseButton.textContent = fileSelectMode === "erase" ? "CANCEL" : "ERASE";

    container.innerHTML = "";

    fileSelectSlots.forEach((slot, index) => {

        const card = document.createElement("div");
        const atCursor = index === fileSelectCursor;

        card.className = "fs-file" +
            (slot.started ? "" : " empty") +
            (atCursor ? " cursor" : "") +
            (atCursor && (fileSelectMode === "erase" || fileSelectMode === "confirm-erase") ? " erasing" : "");

        let body;

        if (atCursor && fileSelectMode === "name") {

            body =
                `<div class="fs-file-label">FILE ${slot.id}</div>` +
                `<div class="fs-prompt">ENTER YOUR NAME</div>` +
                `<input id="fs-name-input" class="fs-name-input" maxlength="16" autocomplete="off" spellcheck="false">` +
                `<div class="fs-choices">` +
                `<button class="fs-button" data-action="start">START</button>` +
                `<button class="fs-button" data-action="cancel">CANCEL</button>` +
                `</div>`;

        } else if (atCursor && fileSelectMode === "confirm-erase") {

            body =
                `<div class="fs-file-label">FILE ${slot.id}</div>` +
                `<div class="fs-prompt">ERASE ${escapeFileText(slot.name)}?</div>` +
                `<div class="fs-warning">This can't be undone.</div>` +
                `<div class="fs-choices">` +
                `<button class="fs-button danger" data-action="erase-yes">YES</button>` +
                `<button class="fs-button" data-action="cancel">NO</button>` +
                `</div>`;

        } else if (slot.started) {

            body =
                `<div class="fs-file-label">FILE ${slot.id}</div>` +
                `<div class="fs-file-name">${escapeFileText(slot.name)}</div>` +
                `<div class="fs-file-stats">` +
                `<div>${slot.vehicles} vehicle${slot.vehicles === 1 ? "" : "s"}` +
                (slot.driving ? ` · ${slot.driving} on the road` : "") + `</div>` +
                `<div>${Math.round(slot.total_miles).toLocaleString()} mi</div>` +
                `<div>${formatFileClock(slot.game_time)} · x${slot.time_multiplier}</div>` +
                `</div>`;

        } else {

            body =
                `<div class="fs-file-label">FILE ${slot.id}</div>` +
                `<div class="fs-file-name">NEW GAME</div>` +
                `<div class="fs-file-stats"><div>- empty -</div></div>`;
        }

        card.innerHTML = `<span class="fs-cursor">&#9654;</span>` + body;

        card.onclick = (event) => {

            const action = event.target.dataset && event.target.dataset.action;

            if (action) {
                event.stopPropagation();
                handleFileAction(action);
                return;
            }

            //
            // Clicking inside the name box (or anywhere on a card mid-question)
            // shouldn't re-trigger the card itself.
            //
            if (atCursor && (fileSelectMode === "name" || fileSelectMode === "confirm-erase")) {
                return;
            }

            fileSelectCursor = index;
            activateFileUnderCursor();
        };

        container.appendChild(card);
    });

    const nameInput = document.getElementById("fs-name-input");

    if (nameInput) {
        nameInput.focus();
    }
}


function activateFileUnderCursor() {

    const slot = fileSelectSlots[fileSelectCursor];

    if (!slot) {
        return;
    }

    if (fileSelectMode === "erase") {

        if (!slot.started) {
            setFileSelectMessage(`File ${slot.id} is already empty.`, false);
            renderFileSelect();
            return;
        }

        fileSelectMode = "confirm-erase";
        setFileSelectMessage("", false);
        renderFileSelect();
        return;
    }

    if (slot.started) {
        playFile(slot);
        return;
    }

    fileSelectMode = "name";
    setFileSelectMessage("", false);
    renderFileSelect();
}


function handleFileAction(action) {

    if (action === "start") {
        startNewFile();
    } else if (action === "erase-yes") {
        eraseFileUnderCursor();
    } else if (action === "cancel") {
        setFileSelectMode("select");
    }
}


async function startNewFile() {

    const slot = fileSelectSlots[fileSelectCursor];
    const name = document.getElementById("fs-name-input").value.trim();

    if (!name) {
        setFileSelectMessage("Enter a name first.", true);
        document.getElementById("fs-name-input").focus();
        return;
    }

    try {

        const response = await fetch(API + "/api/slots/" + slot.id, {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({ name })

        });

        const data = await response.json();

        if (!response.ok) {
            setFileSelectMessage(data.detail || "Couldn't start that file.", true);
            return;
        }

        playFile({ id: slot.id, name: data.name });

    } catch (e) {
        setFileSelectMessage("Couldn't reach the server - try again.", true);
    }
}


async function eraseFileUnderCursor() {

    const slot = fileSelectSlots[fileSelectCursor];

    try {

        const response = await fetch(API + "/api/slots/" + slot.id, { method: "DELETE" });

        if (!response.ok) {
            const data = await response.json();
            setFileSelectMessage(data.detail || "Couldn't erase that file.", true);
            return;
        }

        fileSelectMode = "select";
        setFileSelectMessage(`File ${slot.id} erased.`, false);

        await refreshFileSelect();

    } catch (e) {
        setFileSelectMessage("Couldn't reach the server - try again.", true);
    }
}


function playFile(slot) {

    try {
        localStorage.setItem(LAST_SLOT_STORAGE_KEY, String(slot.id));
    } catch (e) {
        // just won't pre-select it next time
    }

    document.removeEventListener("keydown", handleFileSelectKey);
    document.getElementById("file-select").style.display = "none";

    startGame(slot.id, slot.name);
}


//
// The clock box's "FILE n · NAME" chip. A full reload, not an in-place
// swap, so nothing from this file (map layers, refresh timers, selection)
// carries over into the next one picked.
//
function returnToFileSelect() {

    location.reload();
}


function handleFileSelectKey(event) {

    if (fileSelectMode === "name") {

        if (event.key === "Enter") {
            event.preventDefault();
            startNewFile();
        } else if (event.key === "Escape") {
            setFileSelectMode("select");
        }

        return;
    }

    if (event.key === "Escape") {
        setFileSelectMode("select");
        return;
    }

    if (fileSelectMode === "confirm-erase") {
        return;
    }

    const moves = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -FILE_SELECT_COLUMNS,
        ArrowDown: FILE_SELECT_COLUMNS
    };

    if (event.key in moves) {

        event.preventDefault();

        const next = fileSelectCursor + moves[event.key];

        if (next >= 0 && next < fileSelectSlots.length) {
            fileSelectCursor = next;
            renderFileSelect();
        }

        return;
    }

    //
    // A focused button (ERASE/CANCEL, YES/NO) already handles its own Enter
    // as a click - acting on the file under the cursor too would do both.
    //
    if (event.key === "Enter" && event.target.tagName !== "BUTTON") {
        event.preventDefault();
        activateFileUnderCursor();
    }
}


showFileSelect();
