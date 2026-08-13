from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from geopy.geocoders import Nominatim
import psycopg2
import requests
import json
import bisect
import logging


logger = logging.getLogger("uvicorn.error")


#
# Real drive time is compressed into simulated time by this factor,
# e.g. a 6 hour drive plays out over 6 minutes.
#
TIME_COMPRESSION = 60

#
# How long (in real seconds) an arrived trip keeps showing up in
# /api/trips/active, so a vehicle doesn't just vanish from the map
# the instant it arrives.
#
ARRIVAL_GRACE_SECONDS = 30


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


def derive_position(route, durations, duration_seconds, elapsed_real_seconds):

    elapsed_seconds = elapsed_real_seconds * TIME_COMPRESSION

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


app = FastAPI()


#
# Without this, an unhandled exception propagates all the way out to
# Starlette's ServerErrorMiddleware, which sits outside CORSMiddleware in the
# stack, so the 500 response never gets CORS headers and the browser reports
# it as a CORS failure instead of showing the real error. Registering this as
# an app.exception_handler(Exception) doesn't work either - Starlette
# special-cases handlers for the bare Exception class into that same outer
# ServerErrorMiddleware. A plain middleware placed inside CORSMiddleware is
# the only way to have the 500 response actually pick up CORS headers.
#
@app.middleware("http")
async def catch_unhandled_exceptions(request: Request, call_next):

    try:
        return await call_next(request)

    except Exception:

        logger.exception("Unhandled exception while handling request")

        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error"}
        )


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



class CreateVehicleRequest(BaseModel):

    name: str
    vehicle_type: str = "truck"



class CreatePathRequest(BaseModel):

    name: str
    origin: str
    destination: str



class StartTripRequest(BaseModel):

    vehicle_id: int
    path_id: int



@app.post("/api/vehicles")
def create_vehicle(req: CreateVehicleRequest):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        INSERT INTO vehicles (name, vehicle_type)
        VALUES (%s, %s)
        RETURNING id
        """,
        (req.name, req.vehicle_type)
    )

    vehicle_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": vehicle_id,

        "name": req.name,

        "vehicle_type": req.vehicle_type,

        "status": "READY"
    }



@app.get("/api/vehicles")
def list_vehicles():

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            v.id,
            v.name,
            v.vehicle_type,
            CASE WHEN EXISTS (
                SELECT 1
                FROM trips t
                JOIN paths p ON p.id = t.path_id
                WHERE t.vehicle_id = v.id
                AND EXTRACT(EPOCH FROM (NOW() - t.started_at)) < p.duration_seconds / %s
            ) THEN 'DRIVING' ELSE 'READY' END
        FROM vehicles v
        ORDER BY v.id
        """,
        (TIME_COMPRESSION,)
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    return [
        {

            "id": row[0],

            "name": row[1],

            "vehicle_type": row[2],

            "status": row[3]
        }
        for row in rows
    ]



@app.delete("/api/vehicles/{id}")
def delete_vehicle(id: int):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        "DELETE FROM vehicles WHERE id=%s RETURNING id",
        (id,)
    )

    deleted = cur.fetchone()

    conn.commit()

    cur.close()
    conn.close()

    if deleted is None:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    return {"deleted": id}



@app.post("/api/paths")
def create_path(req: CreatePathRequest):

    origin_coords = geocode(req.origin)
    destination_coords = geocode(req.destination)

    route, durations, duration_seconds = road_route(
        origin_coords, destination_coords
    )

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        INSERT INTO paths
        (
            name,
            origin,
            destination,
            route,
            durations,
            duration_seconds
        )

        VALUES
        (%s,%s,%s,%s,%s,%s)

        RETURNING id
        """,
        (
            req.name,
            req.origin,
            req.destination,
            json.dumps(route),
            json.dumps(durations),
            duration_seconds
        )
    )

    path_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": path_id,

        "name": req.name,

        "origin": req.origin,

        "destination": req.destination,

        "route": route,

        "durations": durations,

        "duration_seconds": duration_seconds
    }



@app.get("/api/paths")
def list_paths():

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT id, name, origin, destination, route, durations, duration_seconds
        FROM paths
        ORDER BY id
        """
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    return [
        {

            "id": row[0],

            "name": row[1],

            "origin": row[2],

            "destination": row[3],

            "route": row[4],

            "durations": row[5],

            "duration_seconds": row[6]
        }
        for row in rows
    ]



@app.post("/api/trips")
def start_trip(req: StartTripRequest):

    conn = db()
    cur = conn.cursor()

    cur.execute("SELECT id FROM vehicles WHERE id=%s", (req.vehicle_id,))

    if cur.fetchone() is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle not found")

    cur.execute(
        "SELECT route, durations, duration_seconds FROM paths WHERE id=%s",
        (req.path_id,)
    )

    path_row = cur.fetchone()

    if path_row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Path not found")

    route, durations, duration_seconds = path_row

    cur.execute(
        """
        SELECT 1
        FROM trips t
        JOIN paths p ON p.id = t.path_id
        WHERE t.vehicle_id = %s
        AND EXTRACT(EPOCH FROM (NOW() - t.started_at)) < p.duration_seconds / %s
        """,
        (req.vehicle_id, TIME_COMPRESSION)
    )

    if cur.fetchone() is not None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle already on a trip")

    cur.execute(
        """
        INSERT INTO trips (vehicle_id, path_id)
        VALUES (%s, %s)
        RETURNING id
        """,
        (req.vehicle_id, req.path_id)
    )

    trip_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": trip_id,

        "vehicle_id": req.vehicle_id,

        "path_id": req.path_id,

        "position": route[0],

        "route": route,

        "duration_seconds": duration_seconds,

        "sim_duration_seconds": duration_seconds / TIME_COMPRESSION,

        "status": "DRIVING"
    }



@app.get("/api/trips/active")
def active_trips():

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            t.id,
            t.vehicle_id,
            v.name,
            t.path_id,
            p.route,
            p.durations,
            p.duration_seconds,
            EXTRACT(EPOCH FROM (NOW() - t.started_at))
        FROM trips t
        JOIN vehicles v ON v.id = t.vehicle_id
        JOIN paths p ON p.id = t.path_id
        WHERE EXTRACT(EPOCH FROM (NOW() - t.started_at)) < (p.duration_seconds / %s) + %s
        """,
        (TIME_COMPRESSION, ARRIVAL_GRACE_SECONDS)
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    trips = []

    for (
        trip_id,
        vehicle_id,
        vehicle_name,
        path_id,
        route,
        durations,
        duration_seconds,
        elapsed_real_seconds
    ) in rows:

        derived = derive_position(
            route, durations, duration_seconds, float(elapsed_real_seconds)
        )

        trips.append({

            "trip_id": trip_id,

            "vehicle_id": vehicle_id,

            "vehicle_name": vehicle_name,

            "path_id": path_id,

            "route": route,

            **derived
        })

    return {"trips": trips}
