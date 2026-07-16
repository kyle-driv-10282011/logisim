from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from geopy.geocoders import Nominatim
import psycopg2
import requests
import json
import bisect


#
# Real drive time is compressed into simulated time by this factor,
# e.g. a 6 hour drive plays out over 6 minutes.
#
TIME_COMPRESSION = 60


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
            "geometries": "geojson",
            "annotations": "duration"
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

    osrm_route = data["routes"][0]

    #
    # GeoJSON coordinates are [lon, lat]; Leaflet wants [lat, lon]
    #
    route = [
        [lat, lon]
        for lon, lat in osrm_route["geometry"]["coordinates"]
    ]

    #
    # Per-segment durations (speed-limit based, from OSRM's annotation),
    # turned into cumulative seconds elapsed at each point along the route.
    #
    segment_durations = osrm_route["legs"][0]["annotation"]["duration"]

    cumulative_durations = [0]

    for segment_duration in segment_durations:
        cumulative_durations.append(
            cumulative_durations[-1] + segment_duration
        )

    #
    # osrm_route["duration"] also includes turn penalties that aren't
    # broken out per-segment, so rescale the cumulative durations to
    # land on it exactly at the final point.
    #
    duration_seconds = osrm_route["duration"]

    if cumulative_durations[-1] > 0:

        scale = duration_seconds / cumulative_durations[-1]

        cumulative_durations = [
            d * scale
            for d in cumulative_durations
        ]

    return route, cumulative_durations, duration_seconds


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

    route, durations, duration_seconds = road_route(
        origin_coords, destination_coords
    )


    conn = db()
    cur = conn.cursor()


    cur.execute(
        """
        INSERT INTO vehicles
        (
            origin,
            destination,
            route,
            durations,
            duration_seconds
        )

        VALUES
        (%s,%s,%s,%s,%s)

        RETURNING id
        """,
        (
            req.origin,
            req.destination,
            json.dumps(route),
            json.dumps(durations),
            duration_seconds
        )
    )


    vehicle_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()


    return {

        "id": vehicle_id,

        "position": route[0],

        "route": route,

        "duration_seconds": duration_seconds,

        "sim_duration_seconds": duration_seconds / TIME_COMPRESSION
    }





@app.get("/api/vehicle/{id}")
def vehicle(id:int):


    conn = db()
    cur = conn.cursor()


    cur.execute(
        """
        SELECT
            route,
            durations,
            duration_seconds,
            EXTRACT(EPOCH FROM (NOW() - created))
        FROM vehicles
        WHERE id=%s
        """,
        (id,)
    )


    route, durations, duration_seconds, elapsed_sim_seconds = cur.fetchone()

    cur.close()
    conn.close()


    elapsed_seconds = float(elapsed_sim_seconds) * TIME_COMPRESSION


    if elapsed_seconds >= duration_seconds:

        return {

            "position": route[-1],

            "status": "ARRIVED",

            "remaining_sim_seconds": 0
        }


    #
    # Find which route segment we're currently inside of, and how far
    # across it (by time), then interpolate position within it.
    #
    segment_index = bisect.bisect_right(durations, elapsed_seconds) - 1

    segment_start, segment_end = durations[segment_index], durations[segment_index + 1]

    fraction = 0 if segment_end == segment_start else (
        (elapsed_seconds - segment_start) / (segment_end - segment_start)
    )

    lat1, lon1 = route[segment_index]
    lat2, lon2 = route[segment_index + 1]

    position = [

        lat1 + (lat2 - lat1) * fraction,

        lon1 + (lon2 - lon1) * fraction
    ]


    return {

        "position": position,

        "status": "DRIVING",

        "remaining_sim_seconds": (duration_seconds - elapsed_seconds) / TIME_COMPRESSION
    }