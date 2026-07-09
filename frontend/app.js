const API="http://localhost:5000";


let map;
let marker;
let vehicleId;


map = new maplibregl.Map({
    container:'map',

    style:
    'https://demotiles.maplibre.org/style.json',

    center:[
        -93.265,
        44.977
    ],

    zoom:5
});


async function start(){

    let response =
        await fetch(API+"/api/start",
        {
            method:"POST",

            headers:{
                "Content-Type":"application/json"
            },

            body:JSON.stringify({

                origin:
                document.getElementById("origin").value,

                destination:
                document.getElementById("destination").value
            })
        });


    let data = await response.json();

    vehicleId=data.id;


    marker =
        new maplibregl.Marker()
        .setLngLat(data.position)
        .addTo(map);


    setInterval(updateVehicle,10000);

}



async function updateVehicle(){

    let response =
        await fetch(
        API+"/api/vehicle/"+vehicleId);


    let data =
        await response.json();


    marker
        .setLngLat(data.position);


    map.easeTo({
        center:data.position
    });


    if(data.status==="ARRIVED"){
        alert("Arrived!");
    }

}