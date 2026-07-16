const API = "http://localhost:5000";

let map;
let marker;
let vehicleId;
let routeLine;
let updateTimer;

// Create the map
map = L.map("map").setView([44.977, -93.265], 6);

// Add OpenStreetMap tiles
L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    }
).addTo(map);


function formatHMS(totalSeconds) {

    totalSeconds = Math.max(0, Math.round(totalSeconds));

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}


async function start() {

    const response = await fetch(API + "/api/start", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            origin: document.getElementById("origin").value,

            destination: document.getElementById("destination").value

        })

    });

    const data = await response.json();

    vehicleId = data.id;

    //
    // Remove previous route if one exists
    //
    if (routeLine) {
        map.removeLayer(routeLine);
    }

    if (marker) {
        map.removeLayer(marker);
    }

    //
    // Draw route
    //
    routeLine = L.polyline(data.route, {

        color: "blue",

        weight: 5

    }).addTo(map);

    //
    // Create truck marker, labeled with the real drive time and how
    // fast it will play out (compressed by 60x)
    //
    marker = L.marker(data.position).addTo(map);

    marker.bindTooltip(
        `Drive time: ${formatHMS(data.duration_seconds)}` +
        ` (playing in ${formatHMS(data.sim_duration_seconds)})`,
        { permanent: true, direction: "top", offset: [0, -10] }
    ).openTooltip();

    //
    // Zoom to route
    //
    map.fitBounds(routeLine.getBounds());

    //
    // Prevent multiple timers
    //
    if (updateTimer) {
        clearInterval(updateTimer);
    }

    updateTimer = setInterval(updateVehicle, 1000);

}



async function updateVehicle() {

    const response =
        await fetch(API + "/api/vehicle/" + vehicleId);

    const data =
        await response.json();

    marker.setLatLng(data.position);

    map.panTo(data.position);

    if (data.status === "ARRIVED") {

        marker.setTooltipContent("Arrived");

        clearInterval(updateTimer);

        alert("Vehicle arrived");

    } else {

        marker.setTooltipContent(
            `Arriving in ${formatHMS(data.remaining_sim_seconds)}`
        );

    }

}