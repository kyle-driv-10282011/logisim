from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from geopy.geocoders import Nominatim
from geopy.extra.rate_limiter import RateLimiter
import psycopg2
import requests
import json
import bisect
import logging
import math


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

#
# Nominatim's public instance allows at most 1 request/second. This is only
# used for reverse-geocoding a vehicle's current city, which the frontend
# polls on its own slow timer (not from the 1s /api/trips/active poll), but
# the rate limiter is a hard backstop in case of multiple concurrent users.
#
reverse_geocode_limited = RateLimiter(geolocator.reverse, min_delay_seconds=1)


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
            "annotations": "duration,maxspeed"
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

    #
    # Posted speed limit per segment, where OSM has the tag. Segments
    # without one come back as speed: null and fall back to a derived
    # estimate in derive_position().
    #
    max_speeds_mph = [
        maxspeed_to_mph(entry)
        for entry in osrm_route["legs"][0]["annotation"]["maxspeed"]
    ]

    return route, cumulative_durations, duration_seconds, max_speeds_mph


def maxspeed_to_mph(maxspeed_annotation):

    speed = maxspeed_annotation.get("speed")

    if speed is None:
        return None

    if maxspeed_annotation.get("unit") == "mph":
        return speed

    return speed * 0.621371


def haversine_miles(lat1, lon1, lat2, lon2):

    EARTH_RADIUS_MILES = 3958.8

    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)

    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )

    return 2 * EARTH_RADIUS_MILES * math.asin(math.sqrt(a))


def derive_position(route, durations, duration_seconds, max_speeds, elapsed_real_seconds):

    elapsed_seconds = elapsed_real_seconds * TIME_COMPRESSION

    if elapsed_seconds >= duration_seconds:

        return {

            "position": route[-1],

            "status": "ARRIVED",

            "remaining_sim_seconds": 0,

            "speed_mph": 0
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

    #
    # Prefer the road's actual posted speed limit. Not every segment has
    # one tagged in OSM, so fall back to a derived real-world speed (not
    # scaled by TIME_COMPRESSION - the vehicle's speed on the actual road,
    # not however fast it appears to move in sim time).
    #
    maxspeed = max_speeds[segment_index] if segment_index < len(max_speeds) else None

    if maxspeed is not None:

        speed_mph = maxspeed

    else:

        segment_seconds = segment_end - segment_start

        speed_mph = (
            haversine_miles(lat1, lon1, lat2, lon2) / segment_seconds * 3600
            if segment_seconds > 0 else 0
        )

    return {

        "position": position,

        "status": "DRIVING",

        "remaining_sim_seconds": (duration_seconds - elapsed_seconds) / TIME_COMPRESSION,

        "speed_mph": round(speed_mph, 1)
    }


def reverse_geocode(position):

    location = reverse_geocode_limited((position[0], position[1]), zoom=10, language="en")

    if location is None:
        return None

    address = location.raw.get("address", {})

    return (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("hamlet")
        or address.get("county")
        or location.address
    )


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


#
# Allow the frontend to call this API from any host (not just localhost) -
# there's no auth/cookies here, so a wildcard origin is fine. Note
# allow_credentials must be False for "*" to be a legal CORS response.
#
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
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



@app.get("/api/vehicles/{id}/city")
def vehicle_city(id: int):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            p.route,
            p.durations,
            p.duration_seconds,
            p.max_speeds_mph,
            EXTRACT(EPOCH FROM (NOW() - t.started_at))
        FROM trips t
        JOIN paths p ON p.id = t.path_id
        WHERE t.vehicle_id = %s
        AND EXTRACT(EPOCH FROM (NOW() - t.started_at)) < (p.duration_seconds / %s) + %s
        ORDER BY t.started_at DESC
        LIMIT 1
        """,
        (id, TIME_COMPRESSION, ARRIVAL_GRACE_SECONDS)
    )

    row = cur.fetchone()

    cur.close()
    conn.close()

    if row is None:
        raise HTTPException(status_code=404, detail="Vehicle is not currently on a trip")

    route, durations, duration_seconds, max_speeds_mph, elapsed_real_seconds = row

    derived = derive_position(route, durations, duration_seconds, max_speeds_mph, float(elapsed_real_seconds))

    return {"city": reverse_geocode(derived["position"])}



@app.post("/api/paths")
def create_path(req: CreatePathRequest):

    conn = db()
    cur = conn.cursor()

    #
    # Same origin/destination (case-insensitive) is the same path - return
    # the existing one instead of geocoding/routing and inserting a duplicate.
    #
    cur.execute(
        """
        SELECT id, origin, destination, route, durations, duration_seconds, max_speeds_mph
        FROM paths
        WHERE lower(origin) = lower(%s) AND lower(destination) = lower(%s)
        """,
        (req.origin, req.destination)
    )

    existing = cur.fetchone()

    if existing is not None:

        cur.close()
        conn.close()

        return {

            "id": existing[0],

            "origin": existing[1],

            "destination": existing[2],

            "route": existing[3],

            "durations": existing[4],

            "duration_seconds": existing[5],

            "max_speeds_mph": existing[6]
        }

    origin_coords = geocode(req.origin)
    destination_coords = geocode(req.destination)

    route, durations, duration_seconds, max_speeds_mph = road_route(
        origin_coords, destination_coords
    )

    cur.execute(
        """
        INSERT INTO paths
        (
            origin,
            destination,
            route,
            durations,
            duration_seconds,
            max_speeds_mph
        )

        VALUES
        (%s,%s,%s,%s,%s,%s)

        RETURNING id
        """,
        (
            req.origin,
            req.destination,
            json.dumps(route),
            json.dumps(durations),
            duration_seconds,
            json.dumps(max_speeds_mph)
        )
    )

    path_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": path_id,

        "origin": req.origin,

        "destination": req.destination,

        "route": route,

        "durations": durations,

        "duration_seconds": duration_seconds,

        "max_speeds_mph": max_speeds_mph
    }



@app.get("/api/paths")
def list_paths():

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT id, origin, destination, route, durations, duration_seconds, max_speeds_mph
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

            "origin": row[1],

            "destination": row[2],

            "route": row[3],

            "durations": row[4],

            "duration_seconds": row[5],

            "max_speeds_mph": row[6]
        }
        for row in rows
    ]



@app.delete("/api/paths/{id}")
def delete_path(id: int):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        "DELETE FROM paths WHERE id=%s RETURNING id",
        (id,)
    )

    deleted = cur.fetchone()

    conn.commit()

    cur.close()
    conn.close()

    if deleted is None:
        raise HTTPException(status_code=404, detail="Path not found")

    return {"deleted": id}



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
            p.max_speeds_mph,
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
        max_speeds_mph,
        elapsed_real_seconds
    ) in rows:

        derived = derive_position(
            route, durations, duration_seconds, max_speeds_mph, float(elapsed_real_seconds)
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
