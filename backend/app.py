from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from geopy.geocoders import Nominatim
import psycopg2
import requests
import json


geolocator = Nominatim(user_agent="logisim-vehicle-sim")


def geocode(place):

    location = geolocator.geocode(place)

    if location is None:
        raise HTTPException(
            status_code=400,
            detail=f"Could not geocode location: {place}"
        )

    return (location.latitude, location.longitude)


def road_route(origin_coords, destination_coords):

    #
    # OSRM expects "lon,lat" ordering
    #
    coords = (
        f"{origin_coords[1]},{origin_coords[0]};"
        f"{destination_coords[1]},{destination_coords[0]}"
    )

    response = requests.get(
        f"http://router.project-osrm.org/route/v1/driving/{coords}",
        params={
            "overview": "full",
            "geometries": "geojson"
        },
        timeout=10
    )

    response.raise_for_status()
    data = response.json()

    if data.get("code") != "Ok":
        raise HTTPException(
            status_code=400,
            detail="Could not find a driving route between those locations"
        )

    #
    # GeoJSON coordinates are [lon, lat]; Leaflet wants [lat, lon]
    #
    return [
        [lat, lon]
        for lon, lat in data["routes"][0]["geometry"]["coordinates"]
    ]


app = FastAPI()


# Allow frontend browser to call backend API
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8700"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def db():

    return psycopg2.connect(
        "dbname=vehicle_sim "
        "user=simulator "
        "password=simulator_password "
        "host=postgres"
    )



class StartRequest(BaseModel):

    origin: str
    destination: str



@app.post("/api/start")
def start(req: StartRequest):

    origin_coords = geocode(req.origin)
    destination_coords = geocode(req.destination)

    route = road_route(origin_coords, destination_coords)


    conn = db()
    cur = conn.cursor()


    cur.execute(
        """
        INSERT INTO vehicles
        (
            origin,
            destination,
            route
        )

        VALUES
        (%s,%s,%s)

        RETURNING id
        """,
        (
            req.origin,
            req.destination,
            json.dumps(route)
        )
    )


    vehicle_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()


    return {

        "id": vehicle_id,

        "position": route[0],

        "route": route
    }





@app.get("/api/vehicle/{id}")
def vehicle(id:int):


    conn = db()
    cur = conn.cursor()


    cur.execute(
        """
        SELECT route,current_index
        FROM vehicles
        WHERE id=%s
        """,
        (id,)
    )


    route,index = cur.fetchone()


    if index < len(route)-1:

        index += 1


        cur.execute(
            """
            UPDATE vehicles

            SET current_index=%s,
                updated=NOW()

            WHERE id=%s
            """,
            (index,id)
        )

        conn.commit()

        status = "DRIVING"


    else:

        status = "ARRIVED"



    cur.close()
    conn.close()


    return {

        "position": route[index],

        "status": status

    }