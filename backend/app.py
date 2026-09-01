from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from geopy.geocoders import Nominatim
from geopy.extra.rate_limiter import RateLimiter
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Optional
import psycopg2
import requests
import json
import bisect
import logging
import random


logger = logging.getLogger("uvicorn.error")


#
# Game time runs at time_multiplier x real speed (e.g. a 5 hour drive
# plays out over 5 minutes at multiplier=60) - this is now a live,
# database-backed setting (see the `settings` table and get_settings()
# below) rather than a hardcoded constant, adjustable via
# PUT /api/settings. Used only to seed that row the first time it's read.
#
DEFAULT_TIME_MULTIPLIER = 60

#
# How long (in real seconds) an arrived trip keeps showing up in
# /api/trips/active, so a vehicle doesn't just vanish from the map
# the instant it arrives.
#
ARRIVAL_GRACE_SECONDS = 30

#
# The container's system clock is UTC, but rush-hour congestion needs to
# be judged against a real local clock - otherwise "rush hour" ends up
# keyed to whatever the UTC offset happens to be, not when commuters are
# actually on the road.
#
SIMULATION_TIMEZONE = ZoneInfo("America/Chicago")

#
# OSRM's per-segment speed annotation is distance/duration for that one
# tiny segment, so a segment with a near-zero reported duration (common
# right at intersection/ramp nodes) can spike to an unrealistic value.
# Clamp to a plausible range for a road vehicle instead of showing that.
#
MIN_REALISTIC_SPEED_MPH = 5
MAX_REALISTIC_SPEED_MPH = 85

METERS_PER_MILE = 1609.344

#
# Synthetic traffic model. Road "tier" is inferred from a segment's own
# free-flow speed (OSRM's own speed annotation already reflects road class
# and any real maxspeed tag), rather than fetching separate classification
# data. Congestion is heavier on higher-tier roads during weekday rush
# hours, since that's where commuter volume concentrates.
#
INTERSTATE_MIN_MPH = 55
ARTERIAL_MIN_MPH = 35

#
# OSRM's public demo profile caps out well below real posted limits for
# long stretches of highway (observed 0% of drive time above 65 mph on an
# interstate route that's actually signed 70) - likely untagged maxspeed
# falling back to a conservative default. Once a segment is classified
# into a tier, use whichever is higher: OSRM's own number (in case it
# ever does reflect a real, even higher, tag) or this tier's realistic
# default - never lower a segment OSRM already reports accurately.
#
TIER_DEFAULT_MPH = {

    "interstate": 70,

    "arterial": 50,

    "local": 30
}

CONGESTION_BASELINE = {

    "interstate": {"rush": 0.55, "normal": 0.90},

    "arterial": {"rush": 0.65, "normal": 0.92},

    "local": {"rush": 0.85, "normal": 0.97}
}

INCIDENT_CHANCE = 0.03
INCIDENT_FACTOR = 0.4
JITTER_RANGE = 0.08


def road_tier(free_flow_mph):

    if free_flow_mph >= INTERSTATE_MIN_MPH:
        return "interstate"

    if free_flow_mph >= ARTERIAL_MIN_MPH:
        return "arterial"

    return "local"


def local_now_naive():

    return datetime.now(SIMULATION_TIMEZONE).replace(tzinfo=None)


def to_local_naive(dt):

    #
    # A naive datetime (no tzinfo) is treated as already being in
    # SIMULATION_TIMEZONE - e.g. a user-supplied simulated_datetime with
    # no offset. An aware one gets converted so the stored wall-clock
    # value is consistently local, regardless of what offset it came in
    # with.
    #
    if dt.tzinfo is not None:
        return dt.astimezone(SIMULATION_TIMEZONE).replace(tzinfo=None)

    return dt


def ensure_settings_row(conn, cur):

    #
    # Seeded lazily on first use rather than in init.sql, using Python's
    # own clock for both anchors - anchor_real_utc has to be genuinely
    # comparable to datetime.utcnow() (see get_settings() below), which
    # NOW() at the Postgres level can't guarantee without depending on
    # the container's configured timezone matching that assumption.
    #
    cur.execute(
        """
        INSERT INTO settings (id, time_multiplier, anchor_real_utc, anchor_game_time)
        VALUES (1, %s, %s, %s)
        ON CONFLICT (id) DO NOTHING
        """,
        (DEFAULT_TIME_MULTIPLIER, datetime.utcnow(), local_now_naive())
    )

    conn.commit()


def get_settings(conn, cur):

    #
    # The game clock is derived on every read from an anchor pair, not
    # stored directly - it was anchor_game_time at the real UTC moment
    # anchor_real_utc, and has advanced at time_multiplier x real speed
    # ever since. Comparing against datetime.utcnow() (not local_now_naive())
    # here since anchor_real_utc is always written from datetime.utcnow().
    #
    ensure_settings_row(conn, cur)

    cur.execute("SELECT time_multiplier, anchor_real_utc, anchor_game_time FROM settings WHERE id = 1")

    multiplier, anchor_real_utc, anchor_game_time = cur.fetchone()

    elapsed_real_seconds = (datetime.utcnow() - anchor_real_utc).total_seconds()

    game_time = anchor_game_time + timedelta(seconds=elapsed_real_seconds * multiplier)

    return multiplier, game_time


def settle_arrived_vehicles(conn, cur, time_multiplier):

    #
    # A vehicle's current_lat/current_lng only updates once its most
    # recent trip has actually arrived (real elapsed time since started_at
    # has passed the compressed playback duration - same condition
    # list_vehicles()/active_trips() use to decide DRIVING vs not) - not
    # the instant a trip is created, and not continuously while driving.
    # A single bulk UPDATE covers every vehicle at once rather than
    # looping per vehicle; IS DISTINCT FROM skips vehicles already settled
    # at that destination so this is cheap to call on every read.
    #
    cur.execute(
        """
        UPDATE vehicles v
        SET current_lat = p.destination_lat,
            current_lng = p.destination_lng
        FROM trips t
        JOIN paths p ON p.id = t.path_id
        WHERE t.id = (
            SELECT t2.id FROM trips t2
            WHERE t2.vehicle_id = v.id
            ORDER BY t2.started_at DESC
            LIMIT 1
        )
        AND t.vehicle_id = v.id
        AND EXTRACT(EPOCH FROM (NOW() - t.started_at)) >= t.realized_duration_seconds / %s
        AND (v.current_lat IS DISTINCT FROM p.destination_lat OR v.current_lng IS DISTINCT FROM p.destination_lng)
        """,
        (time_multiplier,)
    )

    conn.commit()


def is_rush_hour(effective_dt):

    is_weekday = effective_dt.weekday() < 5
    hour = effective_dt.hour + effective_dt.minute / 60

    return is_weekday and ((7 <= hour < 9) or (16 <= hour < 18))


def zone_is_rush_hour(effective_dt, rush_hour_start, rush_hour_end):

    if rush_hour_start is None or rush_hour_end is None:
        return False

    if effective_dt.weekday() >= 5:
        return False

    hour = effective_dt.hour + effective_dt.minute / 60

    #
    # Support a window that wraps past midnight (e.g. 22 -> 2), not just
    # the common same-day case.
    #
    if rush_hour_start <= rush_hour_end:
        return rush_hour_start <= hour < rush_hour_end

    return hour >= rush_hour_start or hour < rush_hour_end


def find_zone(zones, position_miles):

    for zone in zones:
        if zone["start_miles"] <= position_miles < zone["end_miles"]:
            return zone

    return None


def congestion_factor(trip_id, segment_index, free_flow_mph, effective_dt, traffic_bias, zone=None):

    #
    # A user-defined zone fully replaces the tier-based rush/normal
    # baseline with its own rush window and severity - it's an explicit
    # override (e.g. "construction, 45mph, 7-9am"), not something that
    # should still be shaped by the generic road-tier model.
    #
    if zone is not None:
        baseline = zone["rush_hour_factor"] if zone_is_rush_hour(
            effective_dt, zone["rush_hour_start"], zone["rush_hour_end"]
        ) else 1.0
    else:
        tier = road_tier(free_flow_mph)
        baseline = CONGESTION_BASELINE[tier]["rush" if is_rush_hour(effective_dt) else "normal"]

    #
    # Seeded per trip+segment so repeated polls of the same trip agree on
    # the same jitter/incident instead of flickering every second.
    #
    rng = random.Random(f"{trip_id}:{segment_index}")

    jitter = rng.uniform(-JITTER_RANGE, JITTER_RANGE)
    incident = INCIDENT_FACTOR if rng.random() < INCIDENT_CHANCE else 1.0

    return max(0.15, min(1.05, baseline * incident + jitter)) * traffic_bias


def segment_speed_mph(zones, max_speeds_mph, segment_index, position_miles, effective_dt, traffic_bias, trip_id):

    #
    # A user-defined zone covering this segment overrides the road entirely
    # - its speed_limit_mph replaces both OSRM's reported speed and the
    # tier default.
    #
    zone = find_zone(zones, position_miles)

    if zone is not None:

        free_flow_mph = zone["speed_limit_mph"]

        factor = congestion_factor(trip_id, segment_index, free_flow_mph, effective_dt, traffic_bias, zone=zone)

    else:

        reported_mph = max(
            MIN_REALISTIC_SPEED_MPH,
            min(MAX_REALISTIC_SPEED_MPH, max_speeds_mph[segment_index])
        )

        #
        # OSRM's reported speed is only used to classify the road's tier
        # here - the tier's realistic default takes over as the actual
        # free-flow baseline whenever it's higher than what OSRM reported,
        # since OSRM's number is frequently an under-tagged fallback
        # rather than the real posted limit.
        #
        tier = road_tier(reported_mph)

        free_flow_mph = max(reported_mph, TIER_DEFAULT_MPH[tier])

        factor = congestion_factor(trip_id, segment_index, free_flow_mph, effective_dt, traffic_bias)

    return max(MIN_REALISTIC_SPEED_MPH, min(MAX_REALISTIC_SPEED_MPH, free_flow_mph * factor))


def build_trip_schedule(distances_miles, max_speeds_mph, zones, traffic_base_datetime, traffic_bias, trip_id):

    #
    # A trip's actual drive time is derived from distance / effective speed
    # for every segment, not trusted from OSRM's own duration estimate -
    # this is what lets a zone's speed limit (or rush hour, or traffic_bias)
    # actually change how long the drive takes, not just what's displayed.
    #
    # This has to be a sequential walk rather than a closed-form
    # calculation: a segment's effective speed depends on the wall-clock
    # moment it's reached (for rush hour), which depends on how long every
    # prior segment took.
    #
    cumulative_seconds = [0.0]

    for segment_index in range(len(distances_miles) - 1):

        segment_miles = distances_miles[segment_index + 1] - distances_miles[segment_index]

        effective_dt = traffic_base_datetime + timedelta(seconds=cumulative_seconds[-1])

        speed_mph = segment_speed_mph(
            zones,
            max_speeds_mph,
            segment_index,
            distances_miles[segment_index],
            effective_dt,
            traffic_bias,
            trip_id
        )

        cumulative_seconds.append(cumulative_seconds[-1] + (segment_miles / speed_mph) * 3600)

    return cumulative_seconds


geolocator = Nominatim(user_agent="logisim-vehicle-sim")

#
# Nominatim's public instance allows at most 1 request/second. This is only
# used for reverse-geocoding a vehicle's current city, which the frontend
# polls on its own slow timer (not from the 1s /api/trips/active poll), but
# the rate limiter is a hard backstop in case of multiple concurrent users.
#
reverse_geocode_limited = RateLimiter(geolocator.reverse, min_delay_seconds=1)


#
# The DB only ever stores lat/lng (see paths.origin_lat etc and
# vehicles.current_lat/current_lng in init.sql) - an address is purely an
# API-boundary convenience, geocoded to coordinates on the way in and
# reverse-geocoded back to a label on the way out. Rounding to a fixed
# precision (~1m) before storing/comparing means two independently-geocoded
# coordinates for "the same place" (e.g. a vehicle's current_lat/lng and a
# path's origin_lat/lng) still compare equal despite whatever float noise
# came out of Nominatim.
#
ROUND_DECIMALS = 5


def round_coord(value):

    return round(value, ROUND_DECIMALS)


def geocode(place):

    location = geolocator.geocode(place)

    if location is None:
        raise HTTPException(
            status_code=400,
            detail=f"Could not geocode location: {place}"
        )

    return (location.latitude, location.longitude)


def coord_label(lat, lng):

    return f"{lat}, {lng}"


#
# Reverse-geocoding the same rounded coordinates always used to mean the
# same real-world place, so caching by (rounded lat, rounded lng) avoids
# re-hitting Nominatim's rate-limited endpoint every time a vehicle/path
# list is read - which, unlike the live-position "current city" lookup this
# was originally written for, can revisit the same coordinates constantly
# (e.g. every vehicle sitting at the same depot).
#
_reverse_geocode_cache = {}


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
            "annotations": "speed,distance",
            "steps": "true"
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
    # Per-point-to-point-segment distance, turned into cumulative miles
    # along the route - a fixed geometric property of the path, independent
    # of any traffic model. A trip's actual drive time gets derived from
    # this (distance / effective speed) rather than from OSRM's own
    # duration estimate.
    #
    segment_distances_m = osrm_route["legs"][0]["annotation"]["distance"]

    cumulative_miles = [0.0]

    for segment_distance_m in segment_distances_m:
        cumulative_miles.append(cumulative_miles[-1] + segment_distance_m / METERS_PER_MILE)

    #
    # OSRM's own per-segment speed (real routed distance / duration, in
    # m/s), not our own straight-line approximation. Its car profile reads
    # the OSM maxspeed tag directly when one exists, so this tracks posted
    # limits where OSM has them and falls back to the profile's road-class
    # default speed elsewhere. Used only to classify a segment's road tier
    # and as the free-flow default when no zone overrides it.
    #
    max_speeds_mph = [
        speed_ms * 2.23694
        for speed_ms in osrm_route["legs"][0]["annotation"]["speed"]
    ]

    #
    # Road names come from OSRM's turn-by-turn steps, not the fine-grained
    # per-point annotations above - a step covers a whole named road
    # between two maneuvers. road_name_boundary_miles are cumulative miles
    # (same domain as cumulative_miles), so the current one can be looked
    # up the same way as a driving segment.
    #
    steps = osrm_route["legs"][0]["steps"]

    road_names = [step_label(step) for step in steps]

    road_name_boundary_miles = [0.0]

    for step in steps:
        road_name_boundary_miles.append(road_name_boundary_miles[-1] + step["distance"] / METERS_PER_MILE)

    return route, cumulative_miles, max_speeds_mph, road_names, road_name_boundary_miles


def step_label(step):

    return step.get("ref") or step.get("name") or "Unnamed road"


def current_road_name(road_names, road_name_boundaries, position):

    if not road_names:
        return None

    name_index = bisect.bisect_right(road_name_boundaries, position) - 1
    name_index = max(0, min(name_index, len(road_names) - 1))

    return road_names[name_index]


def derive_position(
    trip_id,
    route,
    distances_miles,
    max_speeds_mph,
    road_names,
    road_name_boundary_miles,
    zones,
    realized_seconds,
    realized_duration_seconds,
    traffic_base_datetime,
    traffic_bias,
    elapsed_real_seconds,
    time_multiplier
):

    elapsed_seconds = elapsed_real_seconds * time_multiplier

    if elapsed_seconds >= realized_duration_seconds:

        return {

            "position": route[-1],

            "status": "ARRIVED",

            "remaining_sim_seconds": 0,

            "speed_mph": 0,

            "road_name": current_road_name(road_names, road_name_boundary_miles, distances_miles[-1]),

            "distance_miles": distances_miles[-1]
        }

    #
    # Find which route segment we're currently inside of, and how far
    # across it (by time), then interpolate position within it.
    #
    segment_index = bisect.bisect_right(realized_seconds, elapsed_seconds) - 1

    segment_start, segment_end = realized_seconds[segment_index], realized_seconds[segment_index + 1]

    fraction = 0 if segment_end == segment_start else (
        (elapsed_seconds - segment_start) / (segment_end - segment_start)
    )

    lat1, lon1 = route[segment_index]
    lat2, lon2 = route[segment_index + 1]

    position = [

        lat1 + (lat2 - lat1) * fraction,

        lon1 + (lon2 - lon1) * fraction
    ]

    distance_start, distance_end = distances_miles[segment_index], distances_miles[segment_index + 1]
    current_distance = distance_start + (distance_end - distance_start) * fraction

    road_name = current_road_name(road_names, road_name_boundary_miles, current_distance)

    #
    # The wall-clock moment this segment is reached, advancing through the
    # trip by real (uncompressed) drive time - so a long trip can drive
    # into a different rush-hour window partway through, not just reflect
    # conditions frozen at departure. segment_start comes from the trip's
    # own realized_seconds schedule (computed once at trip start), so this
    # matches exactly the effective_dt build_trip_schedule() used for this
    # same segment.
    #
    effective_dt = traffic_base_datetime + timedelta(seconds=segment_start)

    speed_mph = segment_speed_mph(
        zones, max_speeds_mph, segment_index, distance_start, effective_dt, traffic_bias, trip_id
    )

    return {

        "position": position,

        "status": "DRIVING",

        "remaining_sim_seconds": (realized_duration_seconds - elapsed_seconds) / time_multiplier,

        "speed_mph": round(speed_mph, 1),

        "road_name": road_name,

        "distance_miles": current_distance
    }


def reverse_geocode(position):

    cache_key = (round_coord(position[0]), round_coord(position[1]))

    if cache_key in _reverse_geocode_cache:
        return _reverse_geocode_cache[cache_key]

    location = reverse_geocode_limited((position[0], position[1]), zoom=10, language="en")

    if location is None:
        _reverse_geocode_cache[cache_key] = None
        return None

    address = location.raw.get("address", {})

    result = (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("hamlet")
        or address.get("county")
        or location.address
    )

    _reverse_geocode_cache[cache_key] = result

    return result


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


@app.on_event("startup")
def run_migrations():

    #
    # init.sql only runs against a brand-new postgres volume, so a column
    # added after someone's DB already exists needs its own migration -
    # this one's additive (has a default) and idempotent, safe to run
    # against a fresh DB too (where init.sql already created the column).
    #
    conn = db()
    cur = conn.cursor()

    cur.execute("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS starting_mileage DOUBLE PRECISION NOT NULL DEFAULT 0")

    conn.commit()

    cur.close()
    conn.close()


def zone_dict(row):

    return {

        "id": row[0],

        "path_id": row[1],

        "start_miles": row[2],

        "end_miles": row[3],

        "speed_limit_mph": row[4],

        "rush_hour_start": row[5],

        "rush_hour_end": row[6],

        "rush_hour_factor": row[7]
    }


def spec_dict(row):

    return {

        "id": row[0],

        "year": row[1],

        "brand": row[2],

        "model": row[3],

        "person_capacity": row[4],

        "cargo_capacity_cuft": row[5],

        "cost": row[6],

        "mpg": row[7],

        "image": row[8]
    }


SPEC_COLUMNS = """
    id, year, brand, model, person_capacity, cargo_capacity_cuft, cost, mpg, image
"""


def fetch_specs_by_id(cur, spec_ids):

    spec_ids = list(set(spec_ids))

    if not spec_ids:
        return {}

    cur.execute(
        f"SELECT {SPEC_COLUMNS} FROM vehicle_specs WHERE id = ANY(%s)",
        (spec_ids,)
    )

    return {row[0]: spec_dict(row) for row in cur.fetchall()}


def fetch_zones_for_paths(cur, path_ids):

    path_ids = list(set(path_ids))

    if not path_ids:
        return {}

    cur.execute(
        """
        SELECT id, path_id, start_miles, end_miles, speed_limit_mph,
            rush_hour_start, rush_hour_end, rush_hour_factor
        FROM road_zones
        WHERE path_id = ANY(%s)
        ORDER BY path_id, start_miles
        """,
        (path_ids,)
    )

    zones_by_path = {}

    for row in cur.fetchall():
        zones_by_path.setdefault(row[1], []).append(zone_dict(row))

    return zones_by_path



class CreateVehicleRequest(BaseModel):

    name: str
    spec_id: int

    #
    # Free-text address, geocoded to current_lat/current_lng on the way in
    # (see geocode() in app.py) - the DB only ever stores coordinates.
    # Matching against a path's origin (to decide which paths this vehicle
    # can start a trip on) is done on those coordinates, not this text.
    #
    current_location: str

    #
    # Odometer reading at the moment this vehicle joins the fleet (e.g. a
    # used vehicle bought with miles already on it) - added to every mile
    # it drives afterward to get its displayed total (see list_vehicles()).
    #
    starting_mileage: float = 0



class UpdateSettingsRequest(BaseModel):

    time_multiplier: float



class CreateVehicleSpecRequest(BaseModel):

    year: int
    brand: str
    model: str
    person_capacity: int
    cargo_capacity_cuft: float
    cost: float
    mpg: float

    #
    # Filename under frontend/images/ (e.g. "2026-Chevy-Express.png"), not a
    # full URL - the frontend is what knows it's serving that directory at
    # its own origin.
    #
    image: Optional[str] = None



class CreatePathRequest(BaseModel):

    #
    # Free-text addresses, geocoded to lat/lng on the way in (see geocode()
    # in app.py) - the DB only ever stores coordinates.
    #
    origin: str
    destination: str



class RoadZoneRequest(BaseModel):

    #
    # Position along the path, in miles from the origin - a fixed
    # geometric property of the route, unlike time (which now depends on
    # the traffic model itself and would differ trip to trip).
    #
    start_miles: float
    end_miles: float

    speed_limit_mph: float

    #
    # Both null (the default) means this zone never has a rush-hour
    # slowdown - it's just a flat speed override (e.g. a permanent
    # construction zone). Setting both defines a custom rush window
    # independent of the app-wide 7-9am/4-6pm weekday windows.
    #
    rush_hour_start: Optional[float] = None
    rush_hour_end: Optional[float] = None
    rush_hour_factor: float = 0.6



class StartTripRequest(BaseModel):

    vehicle_id: int
    path_id: int

    #
    # Optional user-injected traffic variance: pretend the trip departed
    # at a different moment (to test rush hour on demand), and/or scale
    # the computed congestion up or down for deliberately demoing a
    # better/worse traffic day. Both default to "just use real conditions".
    #
    simulated_datetime: Optional[datetime] = None
    traffic_bias: float = 1.0



def settings_dict(time_multiplier, game_time):

    return {

        "time_multiplier": time_multiplier,

        #
        # Naive local wall-clock value (no tzinfo, no UTC offset) - the
        # frontend treats these digits as literal calendar/clock values
        # (parsing/formatting both as UTC) rather than converting through
        # the browser's own timezone. See updateSimClock() in app.js.
        #
        "game_time": game_time.isoformat()
    }



@app.get("/api/settings")
def read_settings():

    conn = db()
    cur = conn.cursor()

    time_multiplier, game_time = get_settings(conn, cur)

    cur.close()
    conn.close()

    return settings_dict(time_multiplier, game_time)



@app.put("/api/settings")
def update_settings(req: UpdateSettingsRequest):

    if req.time_multiplier <= 0:
        raise HTTPException(status_code=400, detail="time_multiplier must be positive")

    conn = db()
    cur = conn.cursor()

    #
    # Re-anchor at the game time the OLD multiplier had reached, right
    # before switching - so changing the multiplier speeds up/slows down
    # the clock from here, rather than jumping it to a different value.
    #
    time_multiplier, game_time = get_settings(conn, cur)

    #
    # Changing the multiplier mid-trip would retroactively rescale a
    # schedule already shown to the user as an ETA (same reasoning as
    # zones_snapshot freezing a trip's zones at creation) - block it
    # entirely while any vehicle is in route rather than let it distort
    # trips already underway.
    #
    cur.execute(
        """
        SELECT 1
        FROM trips t
        WHERE EXTRACT(EPOCH FROM (NOW() - t.started_at)) < t.realized_duration_seconds / %s
        LIMIT 1
        """,
        (time_multiplier,)
    )

    if cur.fetchone() is not None:
        cur.close()
        conn.close()
        raise HTTPException(
            status_code=409,
            detail="Cannot change time multiplier while vehicles are in route"
        )

    cur.execute(
        """
        UPDATE settings
        SET time_multiplier = %s, anchor_real_utc = %s, anchor_game_time = %s
        WHERE id = 1
        """,
        (req.time_multiplier, datetime.utcnow(), game_time)
    )

    conn.commit()

    cur.close()
    conn.close()

    return settings_dict(req.time_multiplier, game_time)



@app.post("/api/vehicles")
def create_vehicle(req: CreateVehicleRequest):

    #
    # Geocoded up front (same as create_path()'s origin/destination) so a
    # bad location name fails fast, before touching the DB.
    #
    current_lat, current_lng = geocode(req.current_location)
    current_lat = round_coord(current_lat)
    current_lng = round_coord(current_lng)

    conn = db()
    cur = conn.cursor()

    cur.execute("SELECT id FROM vehicle_specs WHERE id=%s", (req.spec_id,))

    if cur.fetchone() is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle spec not found")

    cur.execute(
        """
        INSERT INTO vehicles (name, spec_id, current_lat, current_lng, starting_mileage)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id
        """,
        (req.name, req.spec_id, current_lat, current_lng, req.starting_mileage)
    )

    vehicle_id = cur.fetchone()[0]

    spec = fetch_specs_by_id(cur, [req.spec_id])[req.spec_id]

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": vehicle_id,

        "name": req.name,

        "spec": spec,

        "current_location": req.current_location,

        "current_lat": current_lat,

        "current_lng": current_lng,

        "starting_mileage": req.starting_mileage,

        #
        # A brand-new vehicle has no trips yet, so its total is just what
        # it started with.
        #
        "total_miles_traveled": req.starting_mileage,

        "status": "READY"
    }



@app.post("/api/vehicle-specs")
def create_vehicle_spec(req: CreateVehicleSpecRequest):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        INSERT INTO vehicle_specs
        (year, brand, model, person_capacity, cargo_capacity_cuft, cost, mpg, image)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            req.year,
            req.brand,
            req.model,
            req.person_capacity,
            req.cargo_capacity_cuft,
            req.cost,
            req.mpg,
            req.image
        )
    )

    spec_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()

    return {**req.model_dump(), "id": spec_id}



@app.get("/api/vehicle-specs")
def list_vehicle_specs():

    conn = db()
    cur = conn.cursor()

    cur.execute(f"SELECT {SPEC_COLUMNS} FROM vehicle_specs ORDER BY id")

    specs = [spec_dict(row) for row in cur.fetchall()]

    cur.close()
    conn.close()

    return specs



@app.delete("/api/vehicle-specs/{id}")
def delete_vehicle_spec(id: int):

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute(
            "DELETE FROM vehicle_specs WHERE id=%s RETURNING id",
            (id,)
        )

        deleted = cur.fetchone()

        conn.commit()

    except psycopg2.errors.ForeignKeyViolation:

        conn.rollback()
        cur.close()
        conn.close()

        raise HTTPException(
            status_code=409,
            detail="Vehicle spec is still in use by one or more vehicles"
        )

    cur.close()
    conn.close()

    if deleted is None:
        raise HTTPException(status_code=404, detail="Vehicle spec not found")

    return {"deleted": id}



@app.get("/api/vehicles")
def list_vehicles(include_sold: bool = False):

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur)

    settle_arrived_vehicles(conn, cur, time_multiplier)

    #
    # "My Vehicles" (the current fleet, include_sold=False - the default)
    # filters to sold = FALSE; "All Vehicles" (include_sold=True) is the
    # full history, sold or not. This is a static, non-user-controlled
    # clause (only the bool toggles which literal is used), so it's safe
    # to splice in rather than parameterize.
    #
    # completed_trip_miles sums, per vehicle, the full length of every path
    # driven on a trip that's actually arrived (same "arrived" condition as
    # the DRIVING check below) - a trip in progress contributes its
    # partial distance separately, via GET /api/trips/active's own
    # distance_miles (see derive_position()), not here.
    #
    cur.execute(
        f"""
        SELECT
            v.id,
            v.name,
            v.spec_id,
            v.current_lat,
            v.current_lng,
            v.starting_mileage,
            v.sold,
            v.sold_at,
            CASE
                WHEN v.sold THEN 'SOLD'
                WHEN EXISTS (
                    SELECT 1
                    FROM trips t
                    WHERE t.vehicle_id = v.id
                    AND EXTRACT(EPOCH FROM (NOW() - t.started_at)) < t.realized_duration_seconds / %s
                ) THEN 'DRIVING'
                ELSE 'READY'
            END,
            COALESCE(ctm.miles, 0)
        FROM vehicles v
        LEFT JOIN (
            SELECT t.vehicle_id, SUM((p.distances_miles ->> -1)::double precision) AS miles
            FROM trips t
            JOIN paths p ON p.id = t.path_id
            WHERE EXTRACT(EPOCH FROM (NOW() - t.started_at)) >= t.realized_duration_seconds / %s
            GROUP BY t.vehicle_id
        ) ctm ON ctm.vehicle_id = v.id
        {"" if include_sold else "WHERE v.sold = FALSE"}
        ORDER BY v.id
        """,
        (time_multiplier, time_multiplier)
    )

    rows = cur.fetchall()

    specs_by_id = fetch_specs_by_id(cur, [row[2] for row in rows])

    cur.close()
    conn.close()

    return [
        {

            "id": row[0],

            "name": row[1],

            "spec": specs_by_id.get(row[2]),

            "current_location": reverse_geocode((row[3], row[4])) or coord_label(row[3], row[4]),

            "current_lat": row[3],

            "current_lng": row[4],

            "starting_mileage": row[5],

            "total_miles_traveled": row[5] + row[9],

            "sold": row[6],

            "sold_at": row[7],

            "status": row[8]
        }
        for row in rows
    ]



@app.post("/api/vehicles/{id}/sell")
def sell_vehicle(id: int):

    conn = db()
    cur = conn.cursor()

    cur.execute("SELECT sold FROM vehicles WHERE id=%s", (id,))

    row = cur.fetchone()

    if row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle not found")

    if row[0]:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle already sold")

    time_multiplier, _ = get_settings(conn, cur)

    cur.execute(
        """
        SELECT 1
        FROM trips t
        WHERE t.vehicle_id = %s
        AND EXTRACT(EPOCH FROM (NOW() - t.started_at)) < t.realized_duration_seconds / %s
        """,
        (id, time_multiplier)
    )

    if cur.fetchone() is not None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle is currently on a trip")

    cur.execute(
        "UPDATE vehicles SET sold = TRUE, sold_at = NOW() WHERE id=%s",
        (id,)
    )

    conn.commit()

    cur.close()
    conn.close()

    return {"id": id, "sold": True}



@app.delete("/api/vehicles/{id}")
def delete_vehicle(id: int):

    #
    # Permanently erases the row (cascades its trips) - distinct from
    # selling, which just marks sold = TRUE so it still shows up in "All
    # Vehicles" history. Not exposed in the UI; kept for cleanup.
    #
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

    time_multiplier, _ = get_settings(conn, cur)

    cur.execute(
        """
        SELECT
            t.id,
            p.route,
            p.distances_miles,
            p.max_speeds_mph,
            p.road_names,
            p.road_name_boundary_miles,
            t.zones_snapshot,
            t.realized_seconds,
            t.realized_duration_seconds,
            t.traffic_base_datetime,
            t.traffic_bias,
            EXTRACT(EPOCH FROM (NOW() - t.started_at))
        FROM trips t
        JOIN paths p ON p.id = t.path_id
        WHERE t.vehicle_id = %s
        AND EXTRACT(EPOCH FROM (NOW() - t.started_at)) < (t.realized_duration_seconds / %s) + %s
        ORDER BY t.started_at DESC
        LIMIT 1
        """,
        (id, time_multiplier, ARRIVAL_GRACE_SECONDS)
    )

    row = cur.fetchone()

    cur.close()
    conn.close()

    if row is None:
        raise HTTPException(status_code=404, detail="Vehicle is not currently on a trip")

    (
        trip_id,
        route,
        distances_miles,
        max_speeds_mph,
        road_names,
        road_name_boundary_miles,
        zones_snapshot,
        realized_seconds,
        realized_duration_seconds,
        traffic_base_datetime,
        traffic_bias,
        elapsed_real_seconds
    ) = row

    derived = derive_position(
        trip_id,
        route,
        distances_miles,
        max_speeds_mph,
        road_names,
        road_name_boundary_miles,
        zones_snapshot,
        realized_seconds,
        realized_duration_seconds,
        traffic_base_datetime,
        traffic_bias,
        float(elapsed_real_seconds),
        time_multiplier
    )

    return {"city": reverse_geocode(derived["position"])}



@app.post("/api/paths")
def create_path(req: CreatePathRequest):

    origin_lat, origin_lng = geocode(req.origin)
    destination_lat, destination_lng = geocode(req.destination)

    origin_lat = round_coord(origin_lat)
    origin_lng = round_coord(origin_lng)
    destination_lat = round_coord(destination_lat)
    destination_lng = round_coord(destination_lng)

    conn = db()
    cur = conn.cursor()

    #
    # Same origin/destination coordinates is the same path - return the
    # existing one instead of re-routing and inserting a duplicate.
    #
    cur.execute(
        """
        SELECT id, origin_lat, origin_lng, destination_lat, destination_lng,
            route, distances_miles, max_speeds_mph, road_names, road_name_boundary_miles
        FROM paths
        WHERE origin_lat = %s AND origin_lng = %s
            AND destination_lat = %s AND destination_lng = %s
        """,
        (origin_lat, origin_lng, destination_lat, destination_lng)
    )

    existing = cur.fetchone()

    if existing is not None:

        zones = fetch_zones_for_paths(cur, [existing[0]]).get(existing[0], [])

        cur.close()
        conn.close()

        return {

            "id": existing[0],

            "origin": reverse_geocode((existing[1], existing[2])) or coord_label(existing[1], existing[2]),

            "origin_lat": existing[1],

            "origin_lng": existing[2],

            "destination": reverse_geocode((existing[3], existing[4])) or coord_label(existing[3], existing[4]),

            "destination_lat": existing[3],

            "destination_lng": existing[4],

            "route": existing[5],

            "distances_miles": existing[6],

            "max_speeds_mph": existing[7],

            "road_names": existing[8],

            "road_name_boundary_miles": existing[9],

            "zones": zones
        }

    route, distances_miles, max_speeds_mph, road_names, road_name_boundary_miles = road_route(
        (origin_lat, origin_lng), (destination_lat, destination_lng)
    )

    cur.execute(
        """
        INSERT INTO paths
        (
            origin_lat,
            origin_lng,
            destination_lat,
            destination_lng,
            route,
            distances_miles,
            max_speeds_mph,
            road_names,
            road_name_boundary_miles
        )

        VALUES
        (%s,%s,%s,%s,%s,%s,%s,%s,%s)

        RETURNING id
        """,
        (
            origin_lat,
            origin_lng,
            destination_lat,
            destination_lng,
            json.dumps(route),
            json.dumps(distances_miles),
            json.dumps(max_speeds_mph),
            json.dumps(road_names),
            json.dumps(road_name_boundary_miles)
        )
    )

    path_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": path_id,

        "origin": req.origin,

        "origin_lat": origin_lat,

        "origin_lng": origin_lng,

        "destination": req.destination,

        "destination_lat": destination_lat,

        "destination_lng": destination_lng,

        "route": route,

        "distances_miles": distances_miles,

        "max_speeds_mph": max_speeds_mph,

        "road_names": road_names,

        "road_name_boundary_miles": road_name_boundary_miles,

        "zones": []
    }



@app.get("/api/paths")
def list_paths():

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT id, origin_lat, origin_lng, destination_lat, destination_lng,
            route, distances_miles, max_speeds_mph, road_names, road_name_boundary_miles
        FROM paths
        ORDER BY id
        """
    )

    rows = cur.fetchall()

    zones_by_path = fetch_zones_for_paths(cur, [row[0] for row in rows])

    cur.close()
    conn.close()

    return [
        {

            "id": row[0],

            "origin": reverse_geocode((row[1], row[2])) or coord_label(row[1], row[2]),

            "origin_lat": row[1],

            "origin_lng": row[2],

            "destination": reverse_geocode((row[3], row[4])) or coord_label(row[3], row[4]),

            "destination_lat": row[3],

            "destination_lng": row[4],

            "route": row[5],

            "distances_miles": row[6],

            "max_speeds_mph": row[7],

            "road_names": row[8],

            "road_name_boundary_miles": row[9],

            "zones": zones_by_path.get(row[0], [])
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



@app.post("/api/paths/{path_id}/zones")
def create_zone(path_id: int, req: RoadZoneRequest):

    conn = db()
    cur = conn.cursor()

    cur.execute("SELECT distances_miles FROM paths WHERE id=%s", (path_id,))

    path_row = cur.fetchone()

    if path_row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Path not found")

    total_miles = path_row[0][-1]

    #
    # Clamp to the path's actual domain and normalize ordering, rather than
    # trusting whatever the client computed from clicking points on the map.
    #
    start_miles = max(0.0, min(req.start_miles, req.end_miles))
    end_miles = min(total_miles, max(req.start_miles, req.end_miles))

    if end_miles <= start_miles:
        cur.close()
        conn.close()
        raise HTTPException(status_code=400, detail="Zone must cover a non-empty stretch of the route")

    if req.speed_limit_mph <= 0:
        cur.close()
        conn.close()
        raise HTTPException(status_code=400, detail="speed_limit_mph must be positive")

    if (req.rush_hour_start is None) != (req.rush_hour_end is None):
        cur.close()
        conn.close()
        raise HTTPException(
            status_code=400,
            detail="rush_hour_start and rush_hour_end must both be set, or both omitted"
        )

    cur.execute(
        """
        INSERT INTO road_zones
        (path_id, start_miles, end_miles, speed_limit_mph, rush_hour_start, rush_hour_end, rush_hour_factor)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            path_id,
            start_miles,
            end_miles,
            req.speed_limit_mph,
            req.rush_hour_start,
            req.rush_hour_end,
            req.rush_hour_factor
        )
    )

    zone_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": zone_id,

        "path_id": path_id,

        "start_miles": start_miles,

        "end_miles": end_miles,

        "speed_limit_mph": req.speed_limit_mph,

        "rush_hour_start": req.rush_hour_start,

        "rush_hour_end": req.rush_hour_end,

        "rush_hour_factor": req.rush_hour_factor
    }



@app.put("/api/zones/{id}")
def update_zone(id: int, req: RoadZoneRequest):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT z.path_id, p.distances_miles
        FROM road_zones z
        JOIN paths p ON p.id = z.path_id
        WHERE z.id = %s
        """,
        (id,)
    )

    row = cur.fetchone()

    if row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Zone not found")

    path_id, distances_miles = row
    total_miles = distances_miles[-1]

    #
    # Clamp to the path's actual domain and normalize ordering, rather than
    # trusting whatever the client computed from clicking points on the map.
    #
    start_miles = max(0.0, min(req.start_miles, req.end_miles))
    end_miles = min(total_miles, max(req.start_miles, req.end_miles))

    if end_miles <= start_miles:
        cur.close()
        conn.close()
        raise HTTPException(status_code=400, detail="Zone must cover a non-empty stretch of the route")

    if req.speed_limit_mph <= 0:
        cur.close()
        conn.close()
        raise HTTPException(status_code=400, detail="speed_limit_mph must be positive")

    if (req.rush_hour_start is None) != (req.rush_hour_end is None):
        cur.close()
        conn.close()
        raise HTTPException(
            status_code=400,
            detail="rush_hour_start and rush_hour_end must both be set, or both omitted"
        )

    cur.execute(
        """
        UPDATE road_zones
        SET start_miles = %s, end_miles = %s, speed_limit_mph = %s,
            rush_hour_start = %s, rush_hour_end = %s, rush_hour_factor = %s
        WHERE id = %s
        """,
        (
            start_miles,
            end_miles,
            req.speed_limit_mph,
            req.rush_hour_start,
            req.rush_hour_end,
            req.rush_hour_factor,
            id
        )
    )

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": id,

        "path_id": path_id,

        "start_miles": start_miles,

        "end_miles": end_miles,

        "speed_limit_mph": req.speed_limit_mph,

        "rush_hour_start": req.rush_hour_start,

        "rush_hour_end": req.rush_hour_end,

        "rush_hour_factor": req.rush_hour_factor
    }



@app.delete("/api/zones/{id}")
def delete_zone(id: int):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        "DELETE FROM road_zones WHERE id=%s RETURNING id",
        (id,)
    )

    deleted = cur.fetchone()

    conn.commit()

    cur.close()
    conn.close()

    if deleted is None:
        raise HTTPException(status_code=404, detail="Zone not found")

    return {"deleted": id}



@app.post("/api/trips")
def start_trip(req: StartTripRequest):

    conn = db()
    cur = conn.cursor()

    time_multiplier, game_time = get_settings(conn, cur)

    #
    # Settle before reading current_lat/current_lng below - otherwise a
    # vehicle whose previous trip just arrived (but hasn't been read since,
    # e.g. GET /api/vehicles hasn't been polled yet) would still show its
    # old, pre-arrival location here.
    #
    settle_arrived_vehicles(conn, cur, time_multiplier)

    cur.execute("SELECT sold, current_lat, current_lng FROM vehicles WHERE id=%s", (req.vehicle_id,))

    vehicle_row = cur.fetchone()

    if vehicle_row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle not found")

    sold, vehicle_lat, vehicle_lng = vehicle_row

    if sold:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle has been sold")

    cur.execute(
        "SELECT route, distances_miles, max_speeds_mph, origin_lat, origin_lng FROM paths WHERE id=%s",
        (req.path_id,)
    )

    path_row = cur.fetchone()

    if path_row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Path not found")

    route, distances_miles, max_speeds_mph, origin_lat, origin_lng = path_row

    if round_coord(vehicle_lat) != round_coord(origin_lat) or round_coord(vehicle_lng) != round_coord(origin_lng):

        vehicle_location = reverse_geocode((vehicle_lat, vehicle_lng)) or coord_label(vehicle_lat, vehicle_lng)
        origin_location = reverse_geocode((origin_lat, origin_lng)) or coord_label(origin_lat, origin_lng)

        cur.close()
        conn.close()
        raise HTTPException(
            status_code=409,
            detail=f"Vehicle is currently in {vehicle_location}, not {origin_location} - pick a path that starts there"
        )

    cur.execute(
        """
        SELECT 1
        FROM trips t
        WHERE t.vehicle_id = %s
        AND EXTRACT(EPOCH FROM (NOW() - t.started_at)) < t.realized_duration_seconds / %s
        """,
        (req.vehicle_id, time_multiplier)
    )

    if cur.fetchone() is not None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle already on a trip")

    #
    # A trip departs "now" in game time (not real wall-clock time) unless
    # the caller explicitly overrides it - the game clock is what the
    # traffic model's rush-hour windows are judged against throughout the
    # trip (build_trip_schedule()/derive_position() below), consistent
    # with the clock shown in the frontend.
    #
    traffic_base_datetime = (
        to_local_naive(req.simulated_datetime) if req.simulated_datetime else game_time
    )

    #
    # A trip freezes its own snapshot of the path's zones at creation time,
    # same as traffic_base_datetime/traffic_bias - so a zone added or
    # removed later doesn't retroactively contradict a schedule (and
    # displayed speed) already computed for a trip in progress.
    #
    zones = fetch_zones_for_paths(cur, [req.path_id]).get(req.path_id, [])

    cur.execute(
        """
        INSERT INTO trips (vehicle_id, path_id, traffic_base_datetime, traffic_bias, zones_snapshot)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id
        """,
        (req.vehicle_id, req.path_id, traffic_base_datetime, req.traffic_bias, json.dumps(zones))
    )

    trip_id = cur.fetchone()[0]

    #
    # Needs the trip's own id (for jitter/incident seeding), so this can
    # only run after the row above exists.
    #
    realized_seconds = build_trip_schedule(
        distances_miles, max_speeds_mph, zones, traffic_base_datetime, req.traffic_bias, trip_id
    )

    realized_duration_seconds = realized_seconds[-1]

    cur.execute(
        """
        UPDATE trips
        SET realized_seconds = %s, realized_duration_seconds = %s
        WHERE id = %s
        """,
        (json.dumps(realized_seconds), realized_duration_seconds, trip_id)
    )

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": trip_id,

        "vehicle_id": req.vehicle_id,

        "path_id": req.path_id,

        "position": route[0],

        "route": route,

        "duration_seconds": realized_duration_seconds,

        "sim_duration_seconds": realized_duration_seconds / time_multiplier,

        "status": "DRIVING"
    }



@app.get("/api/trips/active")
def active_trips():

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur)

    cur.execute(
        """
        SELECT
            t.id,
            t.vehicle_id,
            v.name,
            t.path_id,
            p.route,
            p.distances_miles,
            p.max_speeds_mph,
            p.road_names,
            p.road_name_boundary_miles,
            t.zones_snapshot,
            t.realized_seconds,
            t.realized_duration_seconds,
            t.traffic_base_datetime,
            t.traffic_bias,
            EXTRACT(EPOCH FROM (NOW() - t.started_at))
        FROM trips t
        JOIN vehicles v ON v.id = t.vehicle_id
        JOIN paths p ON p.id = t.path_id
        WHERE EXTRACT(EPOCH FROM (NOW() - t.started_at)) < (t.realized_duration_seconds / %s) + %s
        """,
        (time_multiplier, ARRIVAL_GRACE_SECONDS)
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
        distances_miles,
        max_speeds_mph,
        road_names,
        road_name_boundary_miles,
        zones_snapshot,
        realized_seconds,
        realized_duration_seconds,
        traffic_base_datetime,
        traffic_bias,
        elapsed_real_seconds
    ) in rows:

        derived = derive_position(
            trip_id,
            route,
            distances_miles,
            max_speeds_mph,
            road_names,
            road_name_boundary_miles,
            zones_snapshot,
            realized_seconds,
            realized_duration_seconds,
            traffic_base_datetime,
            traffic_bias,
            float(elapsed_real_seconds),
            time_multiplier
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
