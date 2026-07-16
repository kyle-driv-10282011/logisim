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
    // Create truck marker
    //
    marker = L.marker(data.position).addTo(map);

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

    updateTimer = setInterval(updateVehicle, 10000);

}



async function updateVehicle() {

    const response =
        await fetch(API + "/api/vehicle/" + vehicleId);

    const data =
        await response.json();

    marker.setLatLng(data.position);

    map.panTo(data.position);

    if (data.status === "ARRIVED") {

        clearInterval(updateTimer);

        alert("Vehicle arrived");

    }

}