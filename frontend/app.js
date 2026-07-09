const API = "http://localhost:5000";

let map;
let marker;
let vehicleId;


map = new maplibregl.Map({

    container: "map",

    style:
    "https://demotiles.maplibre.org/style.json",

    center:[
        -93.265,
        44.977
    ],

    zoom:6

});


async function start(){

    const response =
        await fetch(API + "/api/start",
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


    const data = await response.json();

    vehicleId=data.id;


    //
    // Draw route
    //
    map.addSource("route", {

        type:"geojson",

        data:{
            type:"Feature",

            geometry:{
                type:"LineString",

                coordinates:data.route
            }
        }

    });


    map.addLayer({

        id:"route",

        type:"line",

        source:"route",

        paint:{

            "line-width":5

        }

    });



    //
    // Add truck marker
    //
    marker =
        new maplibregl.Marker()
        .setLngLat(data.position)
        .addTo(map);


    //
    // Zoom to route
    //
    const bounds =
        new maplibregl.LngLatBounds();


    data.route.forEach(point =>
        bounds.extend(point)
    );


    map.fitBounds(bounds,{
        padding:50
    });


    setInterval(updateVehicle,10000);

}



async function updateVehicle(){

    const response =
        await fetch(
        API + "/api/vehicle/"+vehicleId);


    const data =
        await response.json();


    marker.setLngLat(
        data.position
    );


    map.easeTo({

        center:data.position

    });


    if(data.status==="ARRIVED"){

        alert("Vehicle arrived");

    }

}