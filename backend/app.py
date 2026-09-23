from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from geopy.geocoders import Nominatim
from geopy.extra.rate_limiter import RateLimiter
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Optional
from concurrent.futures import ThreadPoolExecutor
from psycopg2.extras import Json
import psycopg2
import requests
import json
import bisect
import csv
import io
import logging
import math
import random
import re
import threading
import time


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

#
# Flat placeholder fee for a roadside refuel (see POST
# /api/vehicles/{id}/roadside-refuel) - there's no money/budget system
# anywhere else in the app yet (a vehicle model's "cost" and a gas price's
# "price_per_gallon" are both purely informational, never actually
# charged), so this isn't deducted from anything either. It's surfaced in
# that endpoint's response so a future balance system has a real number to
# charge against without needing to change this endpoint's own logic.
#
ROADSIDE_ASSIST_FEE_USD = 75.0


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
    # A vehicle's place only updates once its most recent trip has actually
    # arrived - not the instant a trip is created, and not continuously
    # while driving. "Arrived" is decided by calling resolve_trip_progress()
    # for every vehicle with an unsettled (non-cancelled) trip, the exact
    # same function GET /api/trips/active and GET /api/vehicles use for
    # their own live status - not a plain elapsed-time check. That used to
    # be a plain SQL "has realized_duration_seconds passed" condition, which
    # ignored fuel entirely: a route longer than the vehicle's tank could
    # cover would still get marked arrived (with fuel_gallons clamped to
    # 0 by a GREATEST()) once enough real time passed, instead of staying
    # STRANDED partway there and waiting on a refuel like it should. Calling
    # the real progress function here is what keeps that from happening -
    # a vehicle that's actually STRANDED is simply left alone, exactly like
    # a vehicle that's simply still DRIVING.
    #
    # A cancelled trip (see divert_to_gas_station()) never counts as arrived
    # either, no matter how much real time passes - it's excluded here the
    # same as everywhere else a trip's "still in progress" state is checked.
    #
    cur.execute(
        """
        SELECT
            v.id, t.id, p.destination_place_id, t.resume_destination_place_id, t.auto_refuel,
            p.distances_miles, t.realized_seconds, t.realized_duration_seconds,
            t.starting_fuel_gallons, t.roadside_refuel_count, t.paused_seconds,
            vm.mpg, vm.fuel_tank_gallons, EXTRACT(EPOCH FROM (NOW() - t.started_at))
        FROM vehicles v
        JOIN trips t ON t.id = (
            SELECT t2.id FROM trips t2
            WHERE t2.vehicle_id = v.id
            ORDER BY t2.started_at DESC
            LIMIT 1
        )
        JOIN paths p ON p.id = t.path_id
        JOIN vehicle_models vm ON vm.id = v.vehicle_model_id
        WHERE t.cancelled_at IS NULL
        AND v.place_id IS DISTINCT FROM p.destination_place_id
        """
    )

    rows = cur.fetchall()

    #
    # auto_refuel (set explicitly by divert_to_gas_station()/POST
    # /api/vehicles/{id}/refuel, never inferred from whether the
    # destination happens to have a gas_prices entry - see the `trips`
    # comment in init.sql) tops the tank back up to full on arrival. A trip
    # with resume_destination_place_id set is specifically a detour that
    # still owes the vehicle a way back to wherever it was actually headed -
    # arriving there additionally kicks off that next leg
    # (_run_resume_trip_job()), which needs a live OSRM/geocoding call and
    # so can't run inline here - collected into pending_resumes and handed
    # to job_executor once every actual arrival below has been committed.
    #
    pending_resumes = []
    refueling_vehicle_ids = []

    for (
        vehicle_id, trip_id, destination_place_id, resume_destination_place_id, auto_refuel,
        distances_miles, realized_seconds, realized_duration_seconds,
        starting_fuel_gallons, roadside_refuel_count, paused_seconds,
        mpg, fuel_tank_gallons, elapsed_real_seconds
    ) in rows:

        progress = resolve_trip_progress(
            distances_miles, realized_seconds, realized_duration_seconds,
            mpg, fuel_tank_gallons, starting_fuel_gallons, roadside_refuel_count, paused_seconds,
            float(elapsed_real_seconds), time_multiplier
        )

        if progress["status"] != "ARRIVED":
            continue

        fuel_gallons_remaining = progress["fuel_gallons_remaining"]

        cur.execute(
            "UPDATE vehicles SET place_id = %s, fuel_gallons = %s WHERE id = %s",
            (destination_place_id, fuel_gallons_remaining if fuel_gallons_remaining is not None else 0.0, vehicle_id)
        )

        if auto_refuel:
            refueling_vehicle_ids.append(vehicle_id)

        if resume_destination_place_id is not None:
            pending_resumes.append((vehicle_id, destination_place_id, resume_destination_place_id))

    #
    # An auto_refuel arrival gets topped back up to full separately, right
    # after settling - it wouldn't make sense to still show it arriving low
    # right where it can refuel.
    #
    if refueling_vehicle_ids:

        cur.execute(
            """
            UPDATE vehicles v
            SET fuel_gallons = vm.fuel_tank_gallons
            FROM vehicle_models vm
            WHERE vm.id = v.vehicle_model_id
            AND v.id = ANY(%s)
            """,
            (refueling_vehicle_ids,)
        )

    conn.commit()

    for vehicle_id, gas_station_place_id, resume_destination_place_id in pending_resumes:

        job_id = create_job("resume_trip_after_refuel")
        job_executor.submit(_run_resume_trip_job, job_id, vehicle_id, gas_station_place_id, resume_destination_place_id, False)


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


#
# geopy defaults to a 1s timeout, which the public Nominatim instance
# routinely blows past (GeocoderUnavailable/ReadTimeoutError) - give it the
# same 10s budget road_route() already uses for OSRM.
#
geolocator = Nominatim(user_agent="logisim-vehicle-sim", timeout=10)

#
# Nominatim's public instance allows at most 1 request/second, full stop,
# across the whole app - and returns 429 ("Non-successful status code 429")
# once that's exceeded. geocode_limited and reverse_geocode_limited below
# each independently cap themselves to 1/sec, which was enough back when
# forward and reverse geocoding never ran at the same time, but a vehicle
# currently driving polls its own reverse-geocoded city every 7s (GET
# /api/vehicles/{id}/city) while job_executor can concurrently be running a
# create_path/gas-price-upload job that forward-geocodes - two independent
# 1/sec limiters can burst to ~2 outbound requests/sec between them, which
# is exactly the kind of burst Nominatim's real, combined limit rejects.
# geocode_throttle_gate() is a third, lower-level gate shared by both, so
# the *actual* combined request rate (whichever type) never exceeds 1/sec,
# on top of (not instead of) each RateLimiter's own retry/backoff handling.
#
_geocode_throttle_lock = threading.Lock()
_last_geocode_call_monotonic = [0.0]


def geocode_throttle_gate():

    with _geocode_throttle_lock:

        wait_seconds = 1.0 - (time.monotonic() - _last_geocode_call_monotonic[0])

        if wait_seconds > 0:
            time.sleep(wait_seconds)

        _last_geocode_call_monotonic[0] = time.monotonic()


#
# swallow_exceptions=False + a few retries means a transient 429 gets
# retried with backoff instead of immediately failing the whole job.
# Sharing one RateLimiter instance across threads is the pattern geopy
# itself documents for bulk/concurrent geocoding - it's thread-safe.
#
reverse_geocode_limited = RateLimiter(geolocator.reverse, min_delay_seconds=1)

geocode_limited = RateLimiter(
    geolocator.geocode,
    min_delay_seconds=1,
    max_retries=3,
    error_wait_seconds=2.0,
    swallow_exceptions=False,
)


#
# Coordinates only ever live on the places table (see init.sql) - vehicles
# and paths reference a place by id (place_id / origin_place_id /
# destination_place_id) rather than duplicating lat/lng themselves.
# Rounding to a fixed precision (~1m) before storing/comparing in
# find_or_create_place() means two independently-geocoded results for "the
# same place" still resolve to one row despite whatever float noise came
# out of Nominatim.
#
ROUND_DECIMALS = 5


def round_coord(value):

    return round(value, ROUND_DECIMALS)


#
# Nominatim's search is a plain token match against its address/POI index,
# not a natural-language parser - "target, brooklyn park, mn" finds the
# store fine, but "target IN brooklyn park, mn" or "starbucks NEAR
# minneapolis" (how a person would actually type it) return nothing,
# because "in"/"near" aren't tokens that appear anywhere in the indexed
# address. Swapping either for a comma before searching turns that
# phrasing into the same query Nominatim already handles, without changing
# behavior for input that has neither word (plain addresses, city names)
# or a place that's legitimately named with one of them outside this
# pattern (word-boundary + surrounding spaces keeps "Union" or "Indiana"
# untouched).
#
PLACE_IN_PATTERN = re.compile(r"\s+(?:in|near)\s+", re.IGNORECASE)


#
# Nominatim's addressdetails never includes a continent - only a
# country_code (ISO 3166-1 alpha-2) - so the Places tab's continent filter
# has to derive it from a static lookup instead. Covers every currently
# assigned alpha-2 code; a code not in here (a very new/unusual one) just
# leaves continent unset rather than failing the whole geocode.
#
CONTINENT_BY_COUNTRY_CODE = {

    **{cc: "Africa" for cc in (
        "DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CG", "CD",
        "CI", "DJ", "EG", "GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN", "GW", "KE",
        "LS", "LR", "LY", "MG", "MW", "ML", "MR", "MU", "YT", "MA", "MZ", "NA", "NE",
        "NG", "RE", "RW", "SH", "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD", "TZ",
        "TG", "TN", "UG", "EH", "ZM", "ZW"
    )},

    **{cc: "Antarctica" for cc in ("AQ", "BV", "TF", "HM", "GS")},

    **{cc: "Asia" for cc in (
        "AF", "AM", "AZ", "BH", "BD", "BT", "BN", "KH", "CN", "CY", "GE", "HK", "IN",
        "ID", "IR", "IQ", "IL", "JP", "JO", "KZ", "KP", "KR", "KW", "KG", "LA", "LB",
        "MO", "MY", "MV", "MN", "MM", "NP", "OM", "PK", "PS", "PH", "QA", "SA", "SG",
        "LK", "SY", "TW", "TJ", "TH", "TL", "TR", "TM", "AE", "UZ", "VN", "YE"
    )},

    **{cc: "Europe" for cc in (
        "AX", "AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CZ", "DK", "EE", "FO",
        "FI", "FR", "DE", "GI", "GR", "GG", "VA", "HU", "IS", "IE", "IM", "IT", "JE",
        "XK", "LV", "LI", "LT", "LU", "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL",
        "PT", "RO", "RU", "SM", "RS", "SK", "SI", "ES", "SJ", "SE", "CH", "UA", "GB"
    )},

    **{cc: "North America" for cc in (
        "AI", "AG", "AW", "BS", "BB", "BZ", "BM", "VG", "CA", "KY", "CR", "CU", "CW",
        "DM", "DO", "SV", "GL", "GD", "GP", "GT", "HT", "HN", "JM", "MQ", "MX", "MS",
        "NI", "PA", "PR", "BL", "KN", "LC", "MF", "PM", "VC", "SX", "TT", "TC", "US",
        "VI", "BQ"
    )},

    **{cc: "Oceania" for cc in (
        "AS", "AU", "CX", "CC", "CK", "FJ", "PF", "GU", "KI", "MH", "FM", "NR", "NC",
        "NZ", "NU", "NF", "MP", "PW", "PG", "PN", "WS", "SB", "TK", "TO", "TV", "UM",
        "VU", "WF"
    )},

    **{cc: "South America" for cc in (
        "AR", "BO", "BR", "CL", "CO", "EC", "FK", "GF", "GY", "PY", "PE", "SR", "UY", "VE"
    )},
}


#
# Shared by find_or_create_place() (a fresh place, from Nominatim's forward-
# geocode addressdetails) and _run_backfill_place_locations_job() (an
# existing place, re-derived from its own lat/lng via reverse geocoding) -
# both hand this the same shape of raw_address dict Nominatim returns
# either way, so the two paths can never disagree on how a field falls back.
#
def extract_address_components(raw_address):

    country_code = (raw_address.get("country_code") or "").upper()

    continent = CONTINENT_BY_COUNTRY_CODE.get(country_code)
    country = raw_address.get("country")

    state = (
        raw_address.get("state")
        or raw_address.get("region")
        or raw_address.get("state_district")
        or raw_address.get("province")
    )

    #
    # Same fallback chain as reverse_geocode()'s own city guess below, for
    # the same reason - not every place has an OSM node tagged "city".
    #
    city = (
        raw_address.get("city")
        or raw_address.get("town")
        or raw_address.get("village")
        or raw_address.get("municipality")
        or raw_address.get("hamlet")
        or raw_address.get("county")
    )

    return continent, country, state, city


def geocode_full(place):

    normalized_place = PLACE_IN_PATTERN.sub(", ", place)

    geocode_throttle_gate()
    location = geocode_limited(normalized_place, addressdetails=True)

    if location is None and normalized_place != place:
        geocode_throttle_gate()
        location = geocode_limited(place, addressdetails=True)

    if location is None:
        raise HTTPException(
            status_code=400,
            detail=f"Could not geocode location: {place}"
        )

    return (location.latitude, location.longitude, location.address, location.raw.get("address", {}))


#
# Every free-text location box in the app (vehicle starting location, path
# origin/destination) funnels through here instead of calling
# geocode_full() directly, so typing the same description twice - or two
# descriptions that resolve to the same spot - reuses one row rather than
# piling up near-duplicates. Takes the request's own cursor so the place
# insert commits atomically with whatever row (vehicle/path) is being
# created alongside it, rather than opening a second connection.
#
# Returns (place_id, lat, lng): vehicles/paths store the id as a foreign
# key (see vehicles.place_id, paths.origin_place_id/destination_place_id
# in init.sql) rather than duplicating lat/lng themselves, so a place's
# description/address/coordinates live in exactly one row no matter how
# many vehicles or paths point at it. The lat/lng are handed back too
# since callers like create_path() need real coordinates for road_route()
# regardless of the id.
#
def find_or_create_place(cur, description):

    lat, lng, address, raw_address = geocode_full(description)

    lat = round_coord(lat)
    lng = round_coord(lng)

    cur.execute("SELECT id FROM places WHERE lat = %s AND lng = %s", (lat, lng))

    existing = cur.fetchone()

    if existing is not None:
        return existing[0], lat, lng

    continent, country, state, city = extract_address_components(raw_address)

    cur.execute(
        """
        INSERT INTO places (description, address, lat, lng, continent, country, state, city)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (description, address, lat, lng, continent, country, state, city)
    )

    return cur.fetchone()[0], lat, lng


#
# The divert-to-gas-station equivalent of find_or_create_place() - the
# vehicle's live position mid-route is already a set of real coordinates,
# not free text, so there's no forward-geocode step at all here, just the
# same dedup-by-rounded-coordinates check and a reverse geocode (full
# addressdetails, unlike the plain-string reverse_geocode() above) to give
# the new place a human-readable label and the same continent/country/
# state/city breakdown every other place gets.
#
def find_or_create_place_by_coords(cur, lat, lng):

    lat = round_coord(lat)
    lng = round_coord(lng)

    cur.execute("SELECT id FROM places WHERE lat = %s AND lng = %s", (lat, lng))

    existing = cur.fetchone()

    if existing is not None:
        return existing[0]

    geocode_throttle_gate()
    location = reverse_geocode_limited((lat, lng), zoom=14, language="en")

    raw_address = location.raw.get("address", {}) if location is not None else {}
    continent, country, state, city = extract_address_components(raw_address)

    label = city or country
    description = f"En route near {label}" if label else "En route"
    address = location.address if location is not None else description

    cur.execute(
        """
        INSERT INTO places (description, address, lat, lng, continent, country, state, city)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (description, address, lat, lng, continent, country, state, city)
    )

    return cur.fetchone()[0]


#
# Reverse-geocoding the same rounded coordinates always used to mean the
# same real-world place, so caching by (rounded lat, rounded lng) avoids
# re-hitting Nominatim's rate-limited endpoint on every poll of the same
# driving vehicle's live position (vehicle_city() below is the only
# remaining caller - a settled vehicle/path's location comes from its
# saved place row instead, see find_or_create_place()).
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


def interpolate_seconds_at_distance(distances_miles, realized_seconds, target_distance_miles):

    #
    # Within one route segment, distance and time are linearly related
    # (build_trip_schedule() prices a whole segment at one constant speed),
    # so this is the exact inverse of the distance -> time step
    # derive_position() does the other way around, not an approximation.
    #
    segment_index = bisect.bisect_right(distances_miles, target_distance_miles) - 1
    segment_index = max(0, min(segment_index, len(distances_miles) - 2))

    d0, d1 = distances_miles[segment_index], distances_miles[segment_index + 1]
    t0, t1 = realized_seconds[segment_index], realized_seconds[segment_index + 1]

    fraction = 0 if d1 == d0 else (target_distance_miles - d0) / (d1 - d0)

    return t0 + (t1 - t0) * fraction


#
# The distance-domain twin of the segment interpolation derive_position()
# does in the time domain - used by find_gas_station_options() to turn a
# trip's current cumulative distance (from resolve_trip_progress) into an
# actual lat/lon, since that's all it has to work with (no elapsed_seconds
# of its own to bisect realized_seconds with).
#
def interpolate_position_at_distance(route, distances_miles, target_distance_miles):

    segment_index = bisect.bisect_right(distances_miles, target_distance_miles) - 1
    segment_index = max(0, min(segment_index, len(distances_miles) - 2))

    d0, d1 = distances_miles[segment_index], distances_miles[segment_index + 1]
    fraction = 0 if d1 == d0 else (target_distance_miles - d0) / (d1 - d0)

    lat1, lon1 = route[segment_index]
    lat2, lon2 = route[segment_index + 1]

    return [lat1 + (lat2 - lat1) * fraction, lon1 + (lon2 - lon1) * fraction]


EARTH_RADIUS_MILES = 3958.7613


def haversine_miles(lat1, lon1, lat2, lon2):

    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2

    return 2 * EARTH_RADIUS_MILES * math.asin(math.sqrt(a))


#
# How far off the actual route a gas station can be and still count as
# "near" it for find_gas_station_options() below - a station 15 miles from
# the nearest point on the remaining route is a real detour; one much
# farther than that almost certainly isn't meant for this stretch of road.
#
MAX_GAS_STATION_DETOUR_MILES = 15

#
# A second, independent way for a station to qualify: physically close to
# the vehicle right now, regardless of which direction it's in. 15 miles of
# "ahead" is judged against the road actually being driven, so a station a
# short hop behind (or just off to the side) never qualifies through that
# path alone - this exists specifically so a genuinely nearby option still
# shows up rather than being excluded purely for being in the "wrong"
# direction, since a 10-mile round trip is a reasonable one to offer even
# though it's not "on the way".
#
NEARBY_GAS_STATION_MILES = 10


#
# Every gas station worth offering for POST /api/vehicles/{id}/divert-to-gas-station -
# not just one auto-picked "best" one - so the user can choose between
# several. A station qualifies either by being near the *remaining* (not
# yet driven) part of the route (MAX_GAS_STATION_DETOUR_MILES) or by simply
# being close to the vehicle's current position (NEARBY_GAS_STATION_MILES),
# whichever direction that is. Sorted by straight-line distance from the
# vehicle's current position, since the diversion itself is a fresh, direct
# (OSRM-routed) drive from here to the station, not a continuation of the
# current route - that's what actually determines how long each option's
# detour takes, not how soon a station comes up along the original route.
#
def find_gas_station_options(cur, route, distances_miles, current_distance_miles):

    cur.execute(
        """
        SELECT p.id, p.description, p.lat, p.lng, g.price_per_gallon, g.brand
        FROM gas_prices g
        JOIN places p ON p.id = g.place_id
        """
    )

    stations = cur.fetchall()

    if not stations:
        return []

    current_lat, current_lng = interpolate_position_at_distance(route, distances_miles, current_distance_miles)

    ahead_start_index = bisect.bisect_left(distances_miles, current_distance_miles)
    ahead_route = route[ahead_start_index:]

    options = []

    for place_id, description, lat, lng, price_per_gallon, brand in stations:

        distance_from_vehicle_miles = haversine_miles(current_lat, current_lng, lat, lng)

        ahead = False

        if ahead_route:

            nearest_gap_miles = min(
                haversine_miles(lat, lng, point_lat, point_lng)
                for point_lat, point_lng in ahead_route
            )

            ahead = nearest_gap_miles <= MAX_GAS_STATION_DETOUR_MILES

        nearby = distance_from_vehicle_miles <= NEARBY_GAS_STATION_MILES

        if not (ahead or nearby):
            continue

        options.append({

            "place_id": place_id,

            "description": description,

            "brand": brand,

            "lat": lat,

            "lng": lng,

            "price_per_gallon": price_per_gallon,

            "distance_miles": round(distance_from_vehicle_miles, 1),

            "ahead": ahead
        })

    options.sort(key=lambda option: option["distance_miles"])

    return options


#
# Used by POST /api/vehicles/{id}/refuel for a READY vehicle that isn't
# already sitting at a gas station - unlike find_gas_station_options() above,
# there's no route to stay "ahead" of (the vehicle isn't going anywhere
# yet), so this just picks whichever priced place is physically closest,
# with no detour-distance cutoff.
#
def find_closest_gas_station(cur, lat, lng):

    cur.execute(
        """
        SELECT p.id, p.description, p.lat, p.lng, g.price_per_gallon, g.brand
        FROM gas_prices g
        JOIN places p ON p.id = g.place_id
        """
    )

    stations = cur.fetchall()

    best = None
    best_distance_miles = None

    for place_id, description, lat_station, lng_station, price_per_gallon, brand in stations:

        distance_miles = haversine_miles(lat, lng, lat_station, lng_station)

        if best_distance_miles is None or distance_miles < best_distance_miles:

            best_distance_miles = distance_miles

            best = {

                "place_id": place_id,

                "description": description,

                "brand": brand,

                "lat": lat_station,

                "lng": lng_station,

                "price_per_gallon": price_per_gallon,

                "distance_miles": round(distance_miles, 1)
            }

    return best


#
# Central fuel/time bookkeeping for one trip, shared by settle_arrived_vehicles()
# (bulk arrival check), list_vehicles() (fleet status), and derive_position()
# (live position/map). Kept separate from derive_position's own lat/lon/road-name
# work below so the cheaper callers (which only need status + fuel, not a
# point on the map) don't have to touch route/road_names/zones at all.
#
# A trip's total fuel budget is starting_fuel_gallons (the vehicle's tank
# when it departed) plus one more full tank per roadside refuel used so far
# (roadside_refuel_count) - see the `trips` table comment in init.sql. If
# that's enough to cover the whole route, this behaves exactly like the
# pre-fuel model. If not, the vehicle runs dry at a fixed distance along the
# route (independent of speed/traffic, since gallons are consumed by
# distance, not time) and STRANDED freezes progress right there until a
# roadside refuel bumps roadside_refuel_count and pushes the dry point
# further out.
#
# paused_seconds is schedule time (the same domain as realized_seconds/
# realized_duration_seconds, not wall-clock real time) "refunded" by a past
# roadside refuel - see resolve the endpoint below - so time spent stranded
# never counts as progress once the trip resumes.
#
def resolve_trip_progress(
    distances_miles,
    realized_seconds,
    realized_duration_seconds,
    mpg,
    fuel_tank_gallons,
    starting_fuel_gallons,
    roadside_refuel_count,
    paused_seconds,
    elapsed_real_seconds,
    time_multiplier
):

    total_miles = distances_miles[-1]

    schedule_elapsed = elapsed_real_seconds * time_multiplier - paused_seconds

    total_fuel_available = None

    if mpg and mpg > 0:
        total_fuel_available = starting_fuel_gallons + roadside_refuel_count * fuel_tank_gallons

    dry_miles = None

    if total_fuel_available is not None:

        candidate = total_fuel_available * mpg

        if candidate < total_miles:
            dry_miles = candidate

    if dry_miles is not None:

        dry_elapsed = interpolate_seconds_at_distance(distances_miles, realized_seconds, dry_miles)

        if schedule_elapsed >= dry_elapsed:

            return {

                "status": "STRANDED",

                "elapsed_seconds": dry_elapsed,

                "distance_miles": dry_miles,

                "fuel_gallons_remaining": max(0.0, total_fuel_available - dry_miles / mpg),

                "remaining_sim_seconds": (realized_duration_seconds - dry_elapsed) / time_multiplier
            }

    if schedule_elapsed >= realized_duration_seconds:

        fuel_remaining = (
            max(0.0, total_fuel_available - total_miles / mpg)
            if total_fuel_available is not None else None
        )

        return {

            "status": "ARRIVED",

            "elapsed_seconds": realized_duration_seconds,

            "distance_miles": total_miles,

            "fuel_gallons_remaining": fuel_remaining,

            "remaining_sim_seconds": 0
        }

    #
    # Still driving - find the current segment the same way derive_position()
    # will (so the two can never disagree about "how far along is it"),
    # purely to report a live current_distance/fuel_gallons_remaining.
    #
    segment_index = bisect.bisect_right(realized_seconds, schedule_elapsed) - 1
    segment_index = max(0, min(segment_index, len(distances_miles) - 2))

    segment_start, segment_end = realized_seconds[segment_index], realized_seconds[segment_index + 1]

    fraction = 0 if segment_end == segment_start else (
        (schedule_elapsed - segment_start) / (segment_end - segment_start)
    )

    distance_start, distance_end = distances_miles[segment_index], distances_miles[segment_index + 1]
    current_distance = distance_start + (distance_end - distance_start) * fraction

    fuel_remaining = (
        max(0.0, total_fuel_available - current_distance / mpg)
        if total_fuel_available is not None else None
    )

    return {

        "status": "DRIVING",

        "elapsed_seconds": schedule_elapsed,

        "distance_miles": current_distance,

        "fuel_gallons_remaining": fuel_remaining,

        "remaining_sim_seconds": (realized_duration_seconds - schedule_elapsed) / time_multiplier
    }


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
    mpg,
    fuel_tank_gallons,
    starting_fuel_gallons,
    roadside_refuel_count,
    paused_seconds,
    elapsed_real_seconds,
    time_multiplier
):

    progress = resolve_trip_progress(
        distances_miles,
        realized_seconds,
        realized_duration_seconds,
        mpg,
        fuel_tank_gallons,
        starting_fuel_gallons,
        roadside_refuel_count,
        paused_seconds,
        elapsed_real_seconds,
        time_multiplier
    )

    #
    # schedule_elapsed pins the exact point on the route to show: for
    # ARRIVED/STRANDED it's a fixed value (the end of the route, or the
    # distance the tank ran dry at), for DRIVING it's wherever "now" maps
    # to - the same segment-interpolation code below handles all three
    # without special-casing, since bisecting realized_seconds against its
    # own maximum value naturally resolves to the last segment at
    # fraction=1 (i.e. route[-1]) for ARRIVED.
    #
    schedule_elapsed = progress["elapsed_seconds"]

    segment_index = bisect.bisect_right(realized_seconds, schedule_elapsed) - 1
    segment_index = max(0, min(segment_index, len(distances_miles) - 2))

    segment_start, segment_end = realized_seconds[segment_index], realized_seconds[segment_index + 1]

    fraction = 0 if segment_end == segment_start else (
        (schedule_elapsed - segment_start) / (segment_end - segment_start)
    )

    lat1, lon1 = route[segment_index]
    lat2, lon2 = route[segment_index + 1]

    position = [

        lat1 + (lat2 - lat1) * fraction,

        lon1 + (lon2 - lon1) * fraction
    ]

    road_name = current_road_name(road_names, road_name_boundary_miles, progress["distance_miles"])

    speed_mph = 0

    if progress["status"] == "DRIVING":

        #
        # The wall-clock moment this segment is reached, advancing through
        # the trip by real (uncompressed) drive time - so a long trip can
        # drive into a different rush-hour window partway through, not just
        # reflect conditions frozen at departure. segment_start comes from
        # the trip's own realized_seconds schedule (computed once at trip
        # start), so this matches exactly the effective_dt
        # build_trip_schedule() used for this same segment.
        #
        effective_dt = traffic_base_datetime + timedelta(seconds=segment_start)

        speed_mph = round(
            segment_speed_mph(
                zones, max_speeds_mph, segment_index, distances_miles[segment_index],
                effective_dt, traffic_bias, trip_id
            ),
            1
        )

    return {

        "position": position,

        "status": progress["status"],

        "remaining_sim_seconds": progress["remaining_sim_seconds"],

        "speed_mph": speed_mph,

        "road_name": road_name,

        "distance_miles": progress["distance_miles"],

        "fuel_gallons_remaining": progress["fuel_gallons_remaining"]
    }


def reverse_geocode(position):

    cache_key = (round_coord(position[0]), round_coord(position[1]))

    if cache_key in _reverse_geocode_cache:
        return _reverse_geocode_cache[cache_key]

    geocode_throttle_gate()
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

    #
    # Renamed from vehicle_specs/spec_id to vehicle_models/vehicle_model_id
    # (the "Templates" tab became "Vehicle Models") - ALTER TABLE's own
    # IF EXISTS only guards the table/column being altered, not "has this
    # rename already happened", so each is wrapped in its own existence
    # check instead. That keeps this idempotent forever: a DB that's
    # already been renamed (or a fresh one, created directly with the new
    # names via init.sql) just finds nothing to do here, rather than
    # erroring on a table/column that no longer has the old name.
    #
    cur.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'vehicle_specs') THEN
                ALTER TABLE vehicle_specs RENAME TO vehicle_models;
            END IF;
        END $$;
        """
    )

    cur.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'vehicles' AND column_name = 'spec_id'
            ) THEN
                ALTER TABLE vehicles RENAME COLUMN spec_id TO vehicle_model_id;
            END IF;
        END $$;
        """
    )

    cur.execute("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS starting_mileage DOUBLE PRECISION NOT NULL DEFAULT 0")

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS gas_prices (
            place_id INTEGER PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
            price_per_gallon DOUBLE PRECISION NOT NULL,
            updated TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """
    )

    #
    # Fuel tank support - additive columns with defaults, safe to run against
    # both a pre-existing DB and a fresh one (where init.sql already created
    # them). Existing vehicles start full (see the UPDATE below); existing
    # trips get 0/0/0, which is exactly right for a trip that already
    # finished before this migration ever ran.
    #
    cur.execute("ALTER TABLE vehicle_models ADD COLUMN IF NOT EXISTS fuel_tank_gallons DOUBLE PRECISION NOT NULL DEFAULT 20")
    cur.execute("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_gallons DOUBLE PRECISION NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS starting_fuel_gallons DOUBLE PRECISION NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS roadside_refuel_count INTEGER NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS paused_seconds DOUBLE PRECISION NOT NULL DEFAULT 0")

    cur.execute(
        """
        UPDATE vehicles v
        SET fuel_gallons = vs.fuel_tank_gallons
        FROM vehicle_models vs
        WHERE vs.id = v.vehicle_model_id AND v.fuel_gallons = 0 AND v.sold = FALSE
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS jobs (
            id SERIAL PRIMARY KEY,
            job_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            progress_current INTEGER NOT NULL DEFAULT 0,
            progress_total INTEGER NOT NULL DEFAULT 0,
            result JSONB,
            error TEXT,
            created TIMESTAMP DEFAULT NOW(),
            updated TIMESTAMP DEFAULT NOW()
        )
        """
    )

    #
    # Places tab filter-chip support - additive nullable columns, safe
    # against both a pre-existing DB and a fresh one (where init.sql already
    # created them).
    #
    cur.execute("ALTER TABLE places ADD COLUMN IF NOT EXISTS continent TEXT")
    cur.execute("ALTER TABLE places ADD COLUMN IF NOT EXISTS country TEXT")
    cur.execute("ALTER TABLE places ADD COLUMN IF NOT EXISTS state TEXT")
    cur.execute("ALTER TABLE places ADD COLUMN IF NOT EXISTS city TEXT")

    #
    # Divert-to-gas-station support - additive/nullable, safe against both a
    # pre-existing DB and a fresh one (where init.sql already created them).
    #
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS resume_destination_place_id INTEGER REFERENCES places(id)")
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP")
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS auto_refuel BOOLEAN NOT NULL DEFAULT FALSE")

    #
    # Gas station brand/name - additive/nullable, safe against both a
    # pre-existing DB and a fresh one (where init.sql already created it).
    #
    cur.execute("ALTER TABLE gas_prices ADD COLUMN IF NOT EXISTS brand TEXT")

    conn.commit()

    cur.execute("SELECT COUNT(*) FROM places WHERE country IS NULL")
    places_needing_backfill = cur.fetchone()[0]

    cur.close()
    conn.close()

    #
    # A place created before the columns above existed (or one whose
    # geocode simply didn't resolve a country) has no continent/country/
    # state/city yet - backfill it from its own already-known lat/lng via
    # reverse geocoding, same as a live vehicle's city lookup does, just
    # once per place rather than on every poll. Runs in the same
    # rate-limited background-job pool as every other bulk geocoding
    # operation (see job_executor below) rather than blocking startup;
    # `country IS NULL` makes this safe to re-trigger on every container
    # restart - already-backfilled places are simply skipped.
    #
    if places_needing_backfill:

        job_id = create_job("backfill_place_locations", total=places_needing_backfill)
        job_executor.submit(_run_backfill_place_locations_job, job_id)


#
# Anything that has to geocode a free-text place (find_or_create_place())
# is too slow, and too likely to blow a proxy/browser timeout, to run
# inline in the request that triggers it - Nominatim's public instance has
# no bulk endpoint and is rate-capped, so a CSV upload of many addresses or
# even a single create_path() can take well past what a client is willing
# to wait on one HTTP request. Both run their real work in this pool
# instead, tracked via the jobs table, and hand the request back a job id
# to poll (GET /api/jobs/{id}) rather than blocking on the result.
#
JOB_EXECUTOR_MAX_WORKERS = 4

job_executor = ThreadPoolExecutor(max_workers=JOB_EXECUTOR_MAX_WORKERS)


def create_job(job_type, total=0):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        "INSERT INTO jobs (job_type, progress_total) VALUES (%s, %s) RETURNING id",
        (job_type, total)
    )

    job_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()

    return job_id


def update_job(job_id, **fields):

    if not fields:
        return

    if "result" in fields:
        fields["result"] = Json(fields["result"])

    set_clause = ", ".join(f"{column} = %s" for column in fields)

    conn = db()
    cur = conn.cursor()

    cur.execute(
        f"UPDATE jobs SET {set_clause}, updated = NOW() WHERE id = %s",
        (*fields.values(), job_id)
    )

    conn.commit()

    cur.close()
    conn.close()


#
# Status page for the background-job system itself (see job_executor
# above) - every job type that ever runs through it shows up here, most
# recent first, so a growing list of job types doesn't need its own
# bespoke monitoring view. "queued" mirrors a job sitting in
# job_executor's internal work queue (status is only flipped to 'running'
# once a worker thread actually picks it up - see create_job()/
# update_job() callers), and workers_max is the hard cap on how many can
# run at once.
#
@app.get("/api/jobs")
def list_jobs():

    conn = db()
    cur = conn.cursor()

    cur.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status")
    counts = dict(cur.fetchall())

    cur.execute(
        """
        SELECT id, job_type, status, progress_current, progress_total, error, created, updated
        FROM jobs
        ORDER BY created DESC
        LIMIT 50
        """
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    return {

        "workers_max": JOB_EXECUTOR_MAX_WORKERS,
        "running": counts.get("running", 0),
        "queued": counts.get("pending", 0),

        "jobs": [
            {
                "id": row[0],
                "job_type": row[1],
                "status": row[2],
                "progress_current": row[3],
                "progress_total": row[4],
                "error": row[5],
                # Naive in Postgres (the container clock is UTC - see
                # SIMULATION_TIMEZONE above), so tag it explicitly rather
                # than letting the browser's Date parser assume the
                # viewer's own local zone for a bare (no offset) string.
                "created": row[6].replace(tzinfo=ZoneInfo("UTC")),
                "updated": row[7].replace(tzinfo=ZoneInfo("UTC")),
            }
            for row in rows
        ]
    }


@app.get("/api/jobs/{job_id}")
def get_job(job_id: int):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT status, progress_current, progress_total, result, error
        FROM jobs
        WHERE id = %s
        """,
        (job_id,)
    )

    row = cur.fetchone()

    cur.close()
    conn.close()

    if row is None:
        raise HTTPException(status_code=404, detail="Job not found")

    status, progress_current, progress_total, result, error = row

    return {
        "status": status,
        "progress_current": progress_current,
        "progress_total": progress_total,
        "result": result,
        "error": error,
    }


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


def vehicle_model_dict(row):

    return {

        "id": row[0],

        "year": row[1],

        "brand": row[2],

        "model": row[3],

        "person_capacity": row[4],

        "cargo_capacity_cuft": row[5],

        "cost": row[6],

        "mpg": row[7],

        "image": row[8],

        "fuel_tank_gallons": row[9]
    }


VEHICLE_MODEL_COLUMNS = """
    id, year, brand, model, person_capacity, cargo_capacity_cuft, cost, mpg, image, fuel_tank_gallons
"""


def fetch_vehicle_models_by_id(cur, vehicle_model_ids):

    vehicle_model_ids = list(set(vehicle_model_ids))

    if not vehicle_model_ids:
        return {}

    cur.execute(
        f"SELECT {VEHICLE_MODEL_COLUMNS} FROM vehicle_models WHERE id = ANY(%s)",
        (vehicle_model_ids,)
    )

    return {row[0]: vehicle_model_dict(row) for row in cur.fetchall()}


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


PLACE_COLUMNS = "id, description, address, lat, lng, continent, country, state, city"


def place_dict(row):

    return {

        "id": row[0],

        "description": row[1],

        "address": row[2],

        "lat": row[3],

        "lng": row[4],

        #
        # Structured breakdown for the Places tab's filter chips - null
        # until extract_address_components() has run for this row, either
        # at creation or via the backfill job (see init.sql's `places`
        # comment).
        #
        "continent": row[5],

        "country": row[6],

        "state": row[7],

        "city": row[8]
    }


def gas_price_dict(row):

    return {

        "place_id": row[0],

        "price_per_gallon": row[1],

        "updated": row[2],

        "description": row[3],

        "lat": row[4],

        "lng": row[5],

        "brand": row[6]
    }


GAS_PRICE_COLUMNS = "g.place_id, g.price_per_gallon, g.updated, p.description, p.lat, p.lng, g.brand"


def upsert_gas_price_row(cur, place_id, price_per_gallon, brand=None):

    #
    # One current price (and brand) per place, not a history - re-submitting
    # for a place that already has one (single POST, or a re-uploaded
    # CSV/JSON row referencing the same place) refreshes it in place
    # instead of accumulating stale duplicates. brand is set to whatever's
    # given each time, same as price_per_gallon - a re-upload/edit that
    # omits it clears it back to unset rather than silently keeping the old
    # value around.
    #
    cur.execute(
        """
        INSERT INTO gas_prices (place_id, price_per_gallon, brand, updated)
        VALUES (%s, %s, %s, NOW())
        ON CONFLICT (place_id) DO UPDATE
        SET price_per_gallon = EXCLUDED.price_per_gallon, brand = EXCLUDED.brand, updated = NOW()
        """,
        (place_id, price_per_gallon, brand)
    )


def fetch_places_by_id(cur, place_ids):

    place_ids = list(set(place_ids))

    if not place_ids:
        return {}

    cur.execute(
        f"SELECT {PLACE_COLUMNS} FROM places WHERE id = ANY(%s)",
        (place_ids,)
    )

    return {row[0]: place_dict(row) for row in cur.fetchall()}



class CreateVehicleRequest(BaseModel):

    #
    # No user-supplied name - create_vehicle() derives "<year> <brand>
    # <model> <n>" from the vehicle model plus how many vehicles already exist on
    # it, so fleet vehicles are named consistently instead of whatever a
    # user happens to type (e.g. "2026 Chevy Express 1").
    #
    vehicle_model_id: int

    #
    # Free-text address or place description, resolved to a place row on
    # the way in (see find_or_create_place() in app.py) - the vehicle
    # stores that place's id, not its own copy of the coordinates.
    # Matching against a path's origin (to decide which paths this vehicle
    # can start a trip on) is done by comparing place ids, not this text.
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



class CreateVehicleModelRequest(BaseModel):

    year: int
    brand: str
    model: str
    person_capacity: int
    cargo_capacity_cuft: float
    cost: float
    mpg: float

    #
    # Capacity of every vehicle created against this vehicle model, in gallons - a
    # new vehicle starts with a full tank (see create_vehicle()), and this
    # is also how far a roadside refuel extends a stranded trip's range
    # (see resolve_trip_progress()).
    #
    fuel_tank_gallons: float

    #
    # Filename under frontend/images/ (e.g. "2026-Chevy-Express.png"), not a
    # full URL - the frontend is what knows it's serving that directory at
    # its own origin.
    #
    image: Optional[str] = None



class CreatePathRequest(BaseModel):

    #
    # Free-text addresses or place descriptions, resolved to a place row
    # on the way in (see find_or_create_place() in app.py) - the path
    # stores each place's id, not its own copy of the coordinates.
    #
    origin: str
    destination: str

    #
    # Set by the frontend when Origin was prefilled from a selected
    # vehicle's own current place (see showTab()'s vehicle-aware branch in
    # app.js), rather than typed fresh - takes priority over `origin` and
    # skips geocoding it entirely. Re-geocoding that vehicle's own already-
    # resolved address text was the bug this exists to avoid: Nominatim
    # doesn't reliably return the exact same coordinates for the same query
    # twice, so re-resolving it could land a hair outside ROUND_DECIMALS of
    # the vehicle's actual place, silently creating a near-duplicate place
    # a few meters off - the new path's origin then no longer matches the
    # vehicle it was created from (coordsMatch() in app.js), so it never
    # shows up as a path that vehicle can take. NULL for an ordinary path
    # typed (or picked from the datalist) with no vehicle behind it.
    #
    origin_place_id: Optional[int] = None



class CreatePlaceRequest(BaseModel):

    #
    # Same free-text a vehicle/path location box accepts - an address, or
    # a description like "Target near Minneapolis". Resolved the same way
    # (find_or_create_place()), so pre-adding a place here and typing that
    # same description into one of those boxes later reuses this row.
    #
    description: str



class CreateGasPriceRequest(BaseModel):

    #
    # Same free-text a place/vehicle/path location box accepts - resolved
    # via find_or_create_place() the same way, so pricing a place already
    # known to the app (or typing the same description again) reuses that
    # place's row rather than creating a near-duplicate.
    #
    description: str

    price_per_gallon: float

    #
    # Free text - the chain ("Shell", "Costco Gas") or a plain name for an
    # unbranded station, distinct from the place's own description/address
    # (which might just be a typed-in location, not what's actually on the
    # sign). Optional since not every priced place has one (e.g. a
    # bulk-uploaded citywide price dataset).
    #
    brand: Optional[str] = None



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



class DivertToGasStationRequest(BaseModel):

    #
    # Which of the GET /api/vehicles/{id}/gas-station-ahead options the user
    # picked - find_gas_station_options() returns several, not just one
    # auto-picked "best" choice, so the caller has to say which.
    #
    gas_station_place_id: int



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
        WHERE t.cancelled_at IS NULL
        AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * %s - t.paused_seconds) < t.realized_duration_seconds
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

    conn = db()
    cur = conn.cursor()

    vehicle_models_by_id = fetch_vehicle_models_by_id(cur, [req.vehicle_model_id])
    vehicle_model = vehicle_models_by_id.get(req.vehicle_model_id)

    if vehicle_model is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle model not found")

    #
    # Geocoded/resolved up front (same as create_path()'s origin/
    # destination) so a bad location name fails fast, before the vehicle
    # row is inserted.
    #
    place_id, current_lat, current_lng = find_or_create_place(cur, req.current_location)

    #
    # "<year> <brand> <model> <n>" instead of a user-typed name, e.g.
    # "2026 Chevy Express 1" then "... 2" for the next one on that same
    # vehicle model. Counts every vehicle ever created on this vehicle model (sold ones
    # included) so numbers stay unique across "My Vehicles" and "All
    # Vehicles" rather than getting reused after a sale.
    #
    cur.execute("SELECT COUNT(*) FROM vehicles WHERE vehicle_model_id=%s", (req.vehicle_model_id,))

    vehicle_number = cur.fetchone()[0] + 1

    name = f"{vehicle_model['year']} {vehicle_model['brand']} {vehicle_model['model']} {vehicle_number}"

    #
    # A brand-new vehicle always starts with a full tank of its vehicle model's
    # capacity - there's no "starting fuel level" input the way
    # starting_mileage has one, since a fresh vehicle joining the fleet is
    # assumed fueled up and ready to go.
    #
    fuel_gallons = vehicle_model["fuel_tank_gallons"]

    cur.execute(
        """
        INSERT INTO vehicles (name, vehicle_model_id, place_id, starting_mileage, fuel_gallons)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id
        """,
        (name, req.vehicle_model_id, place_id, req.starting_mileage, fuel_gallons)
    )

    vehicle_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": vehicle_id,

        "name": name,

        "vehicle_model": vehicle_model,

        "current_location": req.current_location,

        "current_lat": current_lat,

        "current_lng": current_lng,

        "starting_mileage": req.starting_mileage,

        "fuel_gallons": fuel_gallons,

        #
        # A brand-new vehicle has no trips yet, so its total is just what
        # it started with.
        #
        "total_miles_traveled": req.starting_mileage,

        "status": "READY"
    }



@app.post("/api/vehicle-models")
def create_vehicle_model(req: CreateVehicleModelRequest):

    if req.mpg <= 0:
        raise HTTPException(status_code=400, detail="mpg must be positive")

    if req.fuel_tank_gallons <= 0:
        raise HTTPException(status_code=400, detail="fuel_tank_gallons must be positive")

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        INSERT INTO vehicle_models
        (year, brand, model, person_capacity, cargo_capacity_cuft, cost, mpg, image, fuel_tank_gallons)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
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
            req.image,
            req.fuel_tank_gallons
        )
    )

    vehicle_model_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()

    return {**req.model_dump(), "id": vehicle_model_id}



@app.get("/api/vehicle-models")
def list_vehicle_models():

    conn = db()
    cur = conn.cursor()

    cur.execute(f"SELECT {VEHICLE_MODEL_COLUMNS} FROM vehicle_models ORDER BY id")

    vehicle_models = [vehicle_model_dict(row) for row in cur.fetchall()]

    cur.close()
    conn.close()

    return vehicle_models



@app.delete("/api/vehicle-models/{id}")
def delete_vehicle_model(id: int):

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute(
            "DELETE FROM vehicle_models WHERE id=%s RETURNING id",
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
            detail="Vehicle model is still in use by one or more vehicles"
        )

    cur.close()
    conn.close()

    if deleted is None:
        raise HTTPException(status_code=404, detail="Vehicle model not found")

    return {"deleted": id}



#
# For every vehicle_id whose fleet-wide status query (below) says 'DRIVING'
# (i.e. its latest trip's realized_duration_seconds hasn't been reached
# yet), get the trip/path/vehicle-model data resolve_trip_progress() needs to tell a
# genuinely-driving vehicle apart from one that's actually STRANDED (out of
# fuel) - and its live fuel_gallons_remaining either way. Batched into one
# query rather than one per vehicle, same pattern as fetch_vehicle_models_by_id().
#
def fetch_live_trip_progress(cur, vehicle_ids, time_multiplier):

    vehicle_ids = list(set(vehicle_ids))

    if not vehicle_ids:
        return {}

    cur.execute(
        """
        SELECT DISTINCT ON (t.vehicle_id)
            t.vehicle_id, p.distances_miles, t.realized_seconds, t.realized_duration_seconds,
            t.starting_fuel_gallons, t.roadside_refuel_count, t.paused_seconds,
            EXTRACT(EPOCH FROM (NOW() - t.started_at)), vs.mpg, vs.fuel_tank_gallons
        FROM trips t
        JOIN paths p ON p.id = t.path_id
        JOIN vehicles v ON v.id = t.vehicle_id
        JOIN vehicle_models vs ON vs.id = v.vehicle_model_id
        WHERE t.vehicle_id = ANY(%s)
        AND t.cancelled_at IS NULL
        ORDER BY t.vehicle_id, t.started_at DESC
        """,
        (vehicle_ids,)
    )

    progress_by_vehicle = {}

    for (
        vehicle_id, distances_miles, realized_seconds, realized_duration_seconds,
        starting_fuel_gallons, roadside_refuel_count, paused_seconds,
        elapsed_real_seconds, mpg, fuel_tank_gallons
    ) in cur.fetchall():

        progress_by_vehicle[vehicle_id] = resolve_trip_progress(
            distances_miles, realized_seconds, realized_duration_seconds,
            mpg, fuel_tank_gallons, starting_fuel_gallons, roadside_refuel_count, paused_seconds,
            float(elapsed_real_seconds), time_multiplier
        )

    return progress_by_vehicle


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
    # Both conditions below now account for paused_seconds (see
    # resolve_trip_progress()) so a vehicle stuck STRANDED for a long real
    # time is never mistaken for arrived just because a lot of wall-clock
    # time has passed - completed_trip_miles sums, per vehicle, the full
    # length of every path driven on a trip that's actually arrived (a trip
    # in progress contributes its partial distance separately, via GET
    # /api/trips/active's own distance_miles, not here). The status CASE
    # only tells DRIVING-or-STRANDED apart from READY/SOLD here - the two are
    # disambiguated below via fetch_live_trip_progress(), which is the only
    # place that actually knows about fuel.
    #
    cur.execute(
        f"""
        SELECT
            v.id,
            v.name,
            v.vehicle_model_id,
            v.place_id,
            v.starting_mileage,
            v.sold,
            v.sold_at,
            v.fuel_gallons,
            CASE
                WHEN v.sold THEN 'SOLD'
                WHEN EXISTS (
                    SELECT 1
                    FROM trips t
                    WHERE t.vehicle_id = v.id
                    AND t.cancelled_at IS NULL
                    AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * %s - t.paused_seconds) < t.realized_duration_seconds
                ) THEN 'DRIVING'
                ELSE 'READY'
            END,
            COALESCE(ctm.miles, 0)
        FROM vehicles v
        LEFT JOIN (
            SELECT t.vehicle_id, SUM((p.distances_miles ->> -1)::double precision) AS miles
            FROM trips t
            JOIN paths p ON p.id = t.path_id
            WHERE t.cancelled_at IS NULL
            AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * %s - t.paused_seconds) >= t.realized_duration_seconds
            GROUP BY t.vehicle_id
        ) ctm ON ctm.vehicle_id = v.id
        {"" if include_sold else "WHERE v.sold = FALSE"}
        ORDER BY v.id
        """,
        (time_multiplier, time_multiplier)
    )

    rows = cur.fetchall()

    vehicle_models_by_id = fetch_vehicle_models_by_id(cur, [row[2] for row in rows])
    places_by_id = fetch_places_by_id(cur, [row[3] for row in rows])

    progress_by_vehicle = fetch_live_trip_progress(
        cur, [row[0] for row in rows if row[8] == "DRIVING"], time_multiplier
    )

    cur.close()
    conn.close()

    result = []

    for row in rows:

        progress = progress_by_vehicle.get(row[0])

        result.append({

            "id": row[0],

            "name": row[1],

            "vehicle_model": vehicle_models_by_id.get(row[2]),

            #
            # A single source of truth for a vehicle's location text/
            # coordinates - the place row itself - rather than an
            # independent reverse_geocode() call that could drift from
            # whatever the Places tab shows for the same spot.
            #
            # place_id itself is also exposed so the frontend can create a
            # path FROM this exact place (POST /api/paths's origin_place_id)
            # without re-geocoding current_location as free text - see that
            # field's own comment for why that matters.
            #
            "place_id": row[3],

            "current_location": places_by_id[row[3]]["description"],

            "current_lat": places_by_id[row[3]]["lat"],

            "current_lng": places_by_id[row[3]]["lng"],

            "starting_mileage": row[4],

            "total_miles_traveled": row[4] + row[9],

            "sold": row[5],

            "sold_at": row[6],

            #
            # A settled vehicle's fuel is just its persisted value; a
            # DRIVING/STRANDED one gets the live figure from
            # resolve_trip_progress() instead, the same way its odometer
            # comes from the active trip's own distance_miles rather than
            # v.starting_mileage while driving.
            #
            "fuel_gallons": progress["fuel_gallons_remaining"] if progress else row[7],

            "status": progress["status"] if progress else row[8]
        })

    return result



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
        AND t.cancelled_at IS NULL
        AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * %s - t.paused_seconds) < t.realized_duration_seconds
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



#
# Refuels a READY vehicle. If it's already sitting at a real gas station
# (a place with an entry in gas_prices - the Gas Prices tab/map), this just
# tops the tank off in place, same as always. Otherwise it drives there
# first: finds the closest gas station anywhere (find_closest_gas_station()),
# starts a trip to it, and once it actually arrives, settle_arrived_vehicles()
# auto-refuels it and leaves it parked (no resume_destination_place_id, so
# nothing auto-continues afterward - unlike a divert-to-gas-station detour,
# this was the whole point of the drive). A vehicle currently DRIVING or
# STRANDED has to use POST /api/vehicles/{id}/roadside-refuel or
# divert-to-gas-station instead - this is only for a vehicle that isn't
# going anywhere yet.
#
@app.post("/api/vehicles/{id}/refuel")
def refuel_vehicle(id: int):

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur)

    settle_arrived_vehicles(conn, cur, time_multiplier)

    cur.execute("SELECT sold, place_id, vehicle_model_id FROM vehicles WHERE id=%s", (id,))

    row = cur.fetchone()

    if row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle not found")

    sold, place_id, vehicle_model_id = row

    if sold:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle has been sold")

    cur.execute(
        """
        SELECT 1
        FROM trips t
        WHERE t.vehicle_id = %s
        AND t.cancelled_at IS NULL
        AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * %s - t.paused_seconds) < t.realized_duration_seconds
        """,
        (id, time_multiplier)
    )

    if cur.fetchone() is not None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle is currently on a trip")

    cur.execute("SELECT 1 FROM gas_prices WHERE place_id=%s", (place_id,))

    if cur.fetchone() is not None:

        fuel_tank_gallons = fetch_vehicle_models_by_id(cur, [vehicle_model_id])[vehicle_model_id]["fuel_tank_gallons"]

        cur.execute("UPDATE vehicles SET fuel_gallons = %s WHERE id = %s", (fuel_tank_gallons, id))

        conn.commit()

        cur.close()
        conn.close()

        return {"id": id, "fuel_gallons": fuel_tank_gallons}

    current_place = fetch_places_by_id(cur, [place_id])[place_id]

    station = find_closest_gas_station(cur, current_place["lat"], current_place["lng"])

    if station is None:
        cur.close()
        conn.close()
        raise HTTPException(
            status_code=404,
            detail="No gas stations found - add one on the Gas Prices tab first"
        )

    cur.close()
    conn.close()

    job_id = create_job("drive_to_refuel")

    job_executor.submit(_run_resume_trip_job, job_id, id, place_id, station["place_id"], True)

    return {"job_id": job_id, "station": station}



#
# Recovers a STRANDED vehicle (one that ran out of fuel mid-route) without
# needing it to be at any place - there's no gas station out on the open
# road, so this ignores the gas_prices check the normal refuel above
# requires entirely. Tops the tank back up to full and lets the trip
# continue from wherever it stopped (see resolve_trip_progress()'s
# paused_seconds/roadside_refuel_count handling).
#
@app.post("/api/vehicles/{id}/roadside-refuel")
def roadside_refuel_vehicle(id: int):

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur)

    settle_arrived_vehicles(conn, cur, time_multiplier)

    cur.execute("SELECT sold FROM vehicles WHERE id=%s", (id,))

    row = cur.fetchone()

    if row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle not found")

    if row[0]:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle has been sold")

    cur.execute(
        """
        SELECT
            t.id, t.paused_seconds, t.roadside_refuel_count, t.starting_fuel_gallons,
            t.realized_seconds, t.realized_duration_seconds, p.distances_miles,
            vs.mpg, vs.fuel_tank_gallons, EXTRACT(EPOCH FROM (NOW() - t.started_at))
        FROM trips t
        JOIN paths p ON p.id = t.path_id
        JOIN vehicles v ON v.id = t.vehicle_id
        JOIN vehicle_models vs ON vs.id = v.vehicle_model_id
        WHERE t.vehicle_id = %s
        AND t.cancelled_at IS NULL
        ORDER BY t.started_at DESC
        LIMIT 1
        """,
        (id,)
    )

    row = cur.fetchone()

    if row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle has never been on a trip")

    (
        trip_id, paused_seconds, roadside_refuel_count, starting_fuel_gallons,
        realized_seconds, realized_duration_seconds, distances_miles,
        mpg, fuel_tank_gallons, elapsed_real_seconds
    ) = row

    elapsed_real_seconds = float(elapsed_real_seconds)

    progress = resolve_trip_progress(
        distances_miles, realized_seconds, realized_duration_seconds,
        mpg, fuel_tank_gallons, starting_fuel_gallons, roadside_refuel_count, paused_seconds,
        elapsed_real_seconds, time_multiplier
    )

    if progress["status"] != "STRANDED":
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle is not currently stranded")

    #
    # "Refund" exactly the schedule time spent stuck since it ran dry, so
    # the trip resumes right where it left off instead of jumping ahead by
    # however long it sat there in real time - see resolve_trip_progress()'s
    # own paused_seconds comment.
    #
    schedule_elapsed_before = elapsed_real_seconds * time_multiplier - paused_seconds
    new_paused_seconds = paused_seconds + (schedule_elapsed_before - progress["elapsed_seconds"])
    new_roadside_refuel_count = roadside_refuel_count + 1

    cur.execute(
        "UPDATE trips SET paused_seconds = %s, roadside_refuel_count = %s WHERE id = %s",
        (new_paused_seconds, new_roadside_refuel_count, trip_id)
    )

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": id,

        "trip_id": trip_id,

        "roadside_refuel_count": new_roadside_refuel_count,

        "cost_usd": ROADSIDE_ASSIST_FEE_USD
    }



#
# Shared by GET /api/vehicles/{id}/gas-station-ahead and POST
# /api/vehicles/{id}/divert-to-gas-station - both need the vehicle's
# current (non-cancelled) trip's route geometry plus its live
# resolve_trip_progress(), so the two endpoints can never disagree about
# where the vehicle actually is or whether it's genuinely DRIVING (as
# opposed to READY, STRANDED, or already ARRIVED) right now.
#
def fetch_active_trip_for_diversion(cur, vehicle_id, time_multiplier):

    cur.execute(
        """
        SELECT
            t.id, p.route, p.distances_miles, p.max_speeds_mph,
            t.realized_seconds, t.realized_duration_seconds, t.starting_fuel_gallons,
            t.roadside_refuel_count, t.paused_seconds, t.resume_destination_place_id,
            p.destination_place_id, vm.mpg, vm.fuel_tank_gallons,
            EXTRACT(EPOCH FROM (NOW() - t.started_at))
        FROM trips t
        JOIN paths p ON p.id = t.path_id
        JOIN vehicles v ON v.id = t.vehicle_id
        JOIN vehicle_models vm ON vm.id = v.vehicle_model_id
        WHERE t.vehicle_id = %s
        AND t.cancelled_at IS NULL
        ORDER BY t.started_at DESC
        LIMIT 1
        """,
        (vehicle_id,)
    )

    row = cur.fetchone()

    if row is None:
        return None

    (
        trip_id, route, distances_miles, max_speeds_mph,
        realized_seconds, realized_duration_seconds, starting_fuel_gallons,
        roadside_refuel_count, paused_seconds, resume_destination_place_id,
        destination_place_id, mpg, fuel_tank_gallons, elapsed_real_seconds
    ) = row

    progress = resolve_trip_progress(
        distances_miles, realized_seconds, realized_duration_seconds,
        mpg, fuel_tank_gallons, starting_fuel_gallons, roadside_refuel_count, paused_seconds,
        float(elapsed_real_seconds), time_multiplier
    )

    return {
        "trip_id": trip_id,
        "route": route,
        "distances_miles": distances_miles,
        "resume_destination_place_id": resume_destination_place_id,
        "destination_place_id": destination_place_id,
        "progress": progress
    }


#
# Polled by the frontend for whichever vehicle is currently selected in the
# In Route tab (same cadence as its city lookup - see GET
# /api/vehicles/{id}/city) to decide whether to show a "Divert to gas
# station" option at all, and what to offer. {"stations": []} (not a 404)
# whenever there's nothing to offer - not driving, or nothing within
# MAX_GAS_STATION_DETOUR_MILES of the remaining route or
# NEARBY_GAS_STATION_MILES of the vehicle's current position - since that's
# a perfectly normal thing for this to report, not an error.
#
@app.get("/api/vehicles/{id}/gas-station-ahead")
def gas_station_ahead(id: int):

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur)

    settle_arrived_vehicles(conn, cur, time_multiplier)

    context = fetch_active_trip_for_diversion(cur, id, time_multiplier)

    if context is None or context["progress"]["status"] != "DRIVING":
        cur.close()
        conn.close()
        return {"stations": []}

    stations = find_gas_station_options(
        cur, context["route"], context["distances_miles"], context["progress"]["distance_miles"]
    )

    cur.close()
    conn.close()

    return {"stations": stations}


#
# Diverts a DRIVING vehicle to whichever gas station the user picked from
# GET .../gas-station-ahead's list (req.gas_station_place_id), remembering
# wherever it was actually headed (its current destination, or - if it's
# already mid-detour - whatever it was trying to get to before that) so the
# trip there resumes automatically once the vehicle has refueled (see
# settle_arrived_vehicles()). The actual work (cancelling the current trip,
# reverse-geocoding the live position, routing to the station) needs live
# network calls, so it runs in job_executor like every other geocode/route
# operation - this only validates and hands off.
#
@app.post("/api/vehicles/{id}/divert-to-gas-station", status_code=202)
def divert_to_gas_station(id: int, req: DivertToGasStationRequest):

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur)

    settle_arrived_vehicles(conn, cur, time_multiplier)

    cur.execute("SELECT sold FROM vehicles WHERE id=%s", (id,))

    row = cur.fetchone()

    if row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle not found")

    if row[0]:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle has been sold")

    context = fetch_active_trip_for_diversion(cur, id, time_multiplier)

    if context is None or context["progress"]["status"] != "DRIVING":
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle is not currently driving")

    #
    # Trusts the client's choice of place as long as it's a real gas
    # station - not re-derived from find_gas_station_options() here, since
    # the user already picked from exactly that list a moment ago and
    # re-deriving it would just risk rejecting a perfectly good choice over
    # a transient difference (e.g. the vehicle having moved slightly since
    # that GET).
    #
    cur.execute(
        "SELECT p.id, p.description, p.lat, p.lng, g.brand FROM gas_prices g JOIN places p ON p.id = g.place_id WHERE p.id = %s",
        (req.gas_station_place_id,)
    )

    station_row = cur.fetchone()

    if station_row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="That place isn't a priced gas station")

    station_place_id, station_description, station_lat, station_lng, station_brand = station_row

    resume_destination_place_id = context["resume_destination_place_id"] or context["destination_place_id"]

    lat, lng = interpolate_position_at_distance(
        context["route"], context["distances_miles"], context["progress"]["distance_miles"]
    )

    cur.close()
    conn.close()

    job_id = create_job("divert_to_gas_station")

    job_executor.submit(
        _run_divert_job, job_id, id, context["trip_id"], lat, lng,
        context["progress"]["distance_miles"], context["progress"]["fuel_gallons_remaining"] or 0.0,
        station_place_id, resume_destination_place_id
    )

    return {
        "job_id": job_id,
        "station": {
            "place_id": station_place_id,
            "description": station_description,
            "brand": station_brand,
            "lat": station_lat,
            "lng": station_lng
        }
    }



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
            vs.mpg,
            vs.fuel_tank_gallons,
            t.starting_fuel_gallons,
            t.roadside_refuel_count,
            t.paused_seconds,
            EXTRACT(EPOCH FROM (NOW() - t.started_at))
        FROM trips t
        JOIN paths p ON p.id = t.path_id
        JOIN vehicles v ON v.id = t.vehicle_id
        JOIN vehicle_models vs ON vs.id = v.vehicle_model_id
        WHERE t.vehicle_id = %s
        AND t.cancelled_at IS NULL
        AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * %s - t.paused_seconds) < t.realized_duration_seconds + %s * %s
        ORDER BY t.started_at DESC
        LIMIT 1
        """,
        (id, time_multiplier, ARRIVAL_GRACE_SECONDS, time_multiplier)
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
        mpg,
        fuel_tank_gallons,
        starting_fuel_gallons,
        roadside_refuel_count,
        paused_seconds,
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
        mpg,
        fuel_tank_gallons,
        starting_fuel_gallons,
        roadside_refuel_count,
        paused_seconds,
        float(elapsed_real_seconds),
        time_multiplier
    )

    return {"city": reverse_geocode(derived["position"])}


#
# Unlike vehicle_city() above (a driving vehicle's live mid-trip position),
# this is for a settled vehicle sitting at its place - used to prefill the
# Paths tab's Origin field with a disambiguated address when a vehicle is
# selected (see showTab() in app.js). The place's address was already
# resolved once at creation (geocode_full(), via find_or_create_place()),
# so this is a plain join - no fresh geocoding call needed.
#
@app.get("/api/vehicles/{id}/address")
def vehicle_address(id: int):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        "SELECT p.address FROM vehicles v JOIN places p ON p.id = v.place_id WHERE v.id=%s",
        (id,)
    )

    row = cur.fetchone()

    cur.close()
    conn.close()

    if row is None:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    return {"address": row[0]}


#
# The saved-places bank (Places tab): every location a vehicle/path box has
# ever resolved via find_or_create_place(), plus whatever's added directly
# here, so a description only needs to be typed - and geocoded - once.
#
@app.get("/api/places")
def list_places():

    conn = db()
    cur = conn.cursor()

    cur.execute(f"SELECT {PLACE_COLUMNS} FROM places ORDER BY description")

    rows = cur.fetchall()

    cur.close()
    conn.close()

    return [place_dict(row) for row in rows]


@app.post("/api/places")
def create_place(req: CreatePlaceRequest):

    conn = db()
    cur = conn.cursor()

    place_id, _, _ = find_or_create_place(cur, req.description)

    cur.execute(f"SELECT {PLACE_COLUMNS} FROM places WHERE id=%s", (place_id,))

    place = place_dict(cur.fetchone())

    conn.commit()

    cur.close()
    conn.close()

    return place


@app.delete("/api/places/{id}")
def delete_place(id: int):

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute("DELETE FROM places WHERE id=%s RETURNING id", (id,))

        deleted = cur.fetchone()

        conn.commit()

    except psycopg2.errors.ForeignKeyViolation:

        conn.rollback()
        cur.close()
        conn.close()

        raise HTTPException(
            status_code=409,
            detail="Place is still in use by a vehicle or path"
        )

    cur.close()
    conn.close()

    if deleted is None:
        raise HTTPException(status_code=404, detail="Place not found")

    return {"deleted": id}



#
# Gas prices are keyed by place (see gas_prices in init.sql) - the map
# overlay this feeds shows one marker per priced place, not a history of
# price changes there.
#
@app.get("/api/gas-prices")
def list_gas_prices():

    conn = db()
    cur = conn.cursor()

    cur.execute(
        f"SELECT {GAS_PRICE_COLUMNS} FROM gas_prices g JOIN places p ON p.id = g.place_id ORDER BY g.updated DESC"
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    return [gas_price_dict(row) for row in rows]


@app.post("/api/gas-prices")
def upsert_gas_price(req: CreateGasPriceRequest):

    if req.price_per_gallon <= 0:
        raise HTTPException(status_code=400, detail="price_per_gallon must be positive")

    conn = db()
    cur = conn.cursor()

    place_id, _, _ = find_or_create_place(cur, req.description)

    upsert_gas_price_row(cur, place_id, req.price_per_gallon, req.brand)

    cur.execute(
        f"SELECT {GAS_PRICE_COLUMNS} FROM gas_prices g JOIN places p ON p.id = g.place_id WHERE g.place_id = %s",
        (place_id,)
    )

    result = gas_price_dict(cur.fetchone())

    conn.commit()

    cur.close()
    conn.close()

    return result


@app.delete("/api/gas-prices/{place_id}")
def delete_gas_price(place_id: int):

    conn = db()
    cur = conn.cursor()

    cur.execute("DELETE FROM gas_prices WHERE place_id=%s RETURNING place_id", (place_id,))

    deleted = cur.fetchone()

    conn.commit()

    cur.close()
    conn.close()

    if deleted is None:
        raise HTTPException(status_code=404, detail="Gas price not found for that place")

    return {"deleted": place_id}


#
# One-time (per place) backfill triggered from run_migrations() - see the
# `places` table comment in init.sql. Reverse-geocodes each place missing
# structured location data from its own already-known lat/lng, the same way
# a live vehicle's city lookup does (reverse_geocode()), just persisted
# instead of only ever used for a single display string. Runs sequentially
# through geocode_throttle_gate() like every other geocode call, so this
# can take a while for a lot of backlogged places - that's fine, it's a
# background job (GET /api/jobs/{id}) that never blocks the request that
# triggered it (here, app startup).
#
def _run_backfill_place_locations_job(job_id):

    update_job(job_id, status="running")

    conn = db()
    cur = conn.cursor()

    cur.execute("SELECT id, lat, lng FROM places WHERE country IS NULL ORDER BY id")
    rows = cur.fetchall()

    cur.close()
    conn.close()

    updated = 0

    for index, (place_id, lat, lng) in enumerate(rows):

        try:

            geocode_throttle_gate()
            location = reverse_geocode_limited((lat, lng), zoom=18, language="en")

            raw_address = location.raw.get("address", {}) if location is not None else {}
            continent, country, state, city = extract_address_components(raw_address)

            conn = db()
            cur = conn.cursor()

            cur.execute(
                "UPDATE places SET continent=%s, country=%s, state=%s, city=%s WHERE id=%s",
                (continent, country, state, city, place_id)
            )

            conn.commit()

            cur.close()
            conn.close()

            updated += 1

        except Exception:
            logger.exception(f"Failed to backfill location for place {place_id}")

        update_job(job_id, progress_current=index + 1)

    update_job(job_id, status="done", result={"updated": updated, "total": len(rows)})


#
# Bulk import via a CSV or JSON file (".json" filename -> JSON, otherwise
# CSV). Each row/object needs a description/address (a "description",
# "address", or "location" column/key), a price ("price_per_gallon" or
# "price"), and optionally a "brand" (or "name") column/key. Reuses
# find_or_create_place()/upsert_gas_price_row() from the single-entry
# endpoint above, so a re-uploaded file just refreshes existing prices
# (and brands) rather than duplicating them.
#
# Each row commits independently (rather than one commit for the whole
# batch) so a bad row's rollback can't wipe out earlier good rows already
# written to the same connection's open transaction - a hand-edited
# CSV/JSON is likely to have at least one typo, and that shouldn't cost the
# rows that parsed fine.
#
# The actual row loop runs in job_executor (see find_or_create_place() -
# each new place is a live geocode call) rather than inline here, so a
# file with hundreds of addresses doesn't hold the request open for
# minutes. This handler only does the fast part (parsing) before handing
# off to _run_gas_price_upload_job() and returning a job id to poll.
#
def _run_gas_price_upload_job(job_id, entries):

    update_job(job_id, status="running")

    try:

        conn = db()
        cur = conn.cursor()

        created = 0
        errors = []

        for index, entry in enumerate(entries):

            description = None

            try:

                if not isinstance(entry, dict):
                    raise ValueError("row is not an object/record")

                description = entry.get("description") or entry.get("address") or entry.get("location")

                if not description:
                    raise ValueError("missing description/address/location")

                price_raw = entry.get("price_per_gallon")
                price_raw = price_raw if price_raw is not None else entry.get("price")

                price = float(price_raw)

                if price <= 0:
                    raise ValueError("price_per_gallon must be positive")

                brand = entry.get("brand") or entry.get("name")

                place_id, _, _ = find_or_create_place(cur, description)

                upsert_gas_price_row(cur, place_id, price, brand)

                conn.commit()

                created += 1

            except Exception as e:

                conn.rollback()

                errors.append({
                    "row": index,
                    "description": description,
                    "error": getattr(e, "detail", str(e))
                })

            update_job(job_id, progress_current=index + 1)

        cur.close()
        conn.close()

    except Exception as e:
        update_job(job_id, status="error", error=getattr(e, "detail", str(e)))
        return

    update_job(job_id, status="done", result={"created": created, "errors": errors})


#
# csv.DictReader always treats row 0 as field names, whatever it contains -
# so a file with no header row silently turns its first data row's values
# into the field names, and every row (including that one) then fails
# find_or_create_place()'s entry.get("description")/... lookups with
# "missing description/address/location", instantly (no geocode throttle
# hit yet), which is why a bad upload looks like it "finishes fast and does
# nothing" rather than erroring loudly. Detect a real header by checking
# whether row 0 actually contains one of the recognized column names
# (loosely - case/spacing/punctuation-insensitive, so "Price Per Gallon" or
# "price_per_gallon" both match); if not, assume the file is headerless and
# fall back to the common description/address, price[, brand] column order.
#
CSV_HEADER_ALIASES = {
    "description": "description",
    "address": "description",
    "location": "description",
    "name": "brand",
    "brand": "brand",
    "price": "price_per_gallon",
    "priceper gallon": "price_per_gallon",
    "pricepergallon": "price_per_gallon",
}


def normalize_csv_header_cell(cell):
    return re.sub(r"[^a-z0-9]", "", (cell or "").strip().lower())


def parse_gas_price_csv(text):

    rows = list(csv.reader(io.StringIO(text)))

    if not rows:
        return []

    header_map = {i: CSV_HEADER_ALIASES.get(normalize_csv_header_cell(cell)) for i, cell in enumerate(rows[0])}
    has_header = any(canonical is not None for canonical in header_map.values())

    if has_header:
        fieldnames = [header_map[i] or normalize_csv_header_cell(cell) for i, cell in enumerate(rows[0])]
        data_rows = rows[1:]
    else:
        fieldnames = ["description", "price_per_gallon", "brand"]
        data_rows = rows

    return [
        {fieldnames[i]: value for i, value in enumerate(row) if i < len(fieldnames)}
        for row in data_rows
    ]


@app.post("/api/gas-prices/upload", status_code=202)
async def upload_gas_prices(file: UploadFile = File(...)):

    raw = await file.read()

    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 text (CSV or JSON)")

    if (file.filename or "").lower().endswith(".json"):

        try:
            entries = json.loads(text)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")

        if not isinstance(entries, list):
            raise HTTPException(
                status_code=400,
                detail="JSON must be a list of {description, price_per_gallon} objects"
            )

    else:

        entries = parse_gas_price_csv(text)

    job_id = create_job("gas_prices_upload", total=len(entries))

    job_executor.submit(_run_gas_price_upload_job, job_id, entries)

    return {"job_id": job_id}



#
# The geocoding (find_or_create_place(), x2) and routing (road_route())
# below are both live third-party HTTP calls - too slow, and too likely to
# blow a proxy/browser timeout, to do inline in the request. This builds
# the same result a synchronous create_path() used to return directly, but
# is only ever called from job_executor (see _run_create_path_job()),
# which stores it on the job row for the frontend to poll for instead.
#
def _build_path_result(origin, destination, origin_place_id=None):

    conn = db()
    cur = conn.cursor()

    try:

        if origin_place_id is not None:

            #
            # Already know exactly which place this is (see
            # CreatePathRequest.origin_place_id's own comment) - skip
            # geocoding `origin` as free text entirely.
            #
            place = fetch_places_by_id(cur, [origin_place_id]).get(origin_place_id)

            if place is None:
                raise HTTPException(status_code=404, detail="origin_place_id not found")

            origin_lat, origin_lng = place["lat"], place["lng"]
            origin = place["description"]

        else:
            origin_place_id, origin_lat, origin_lng = find_or_create_place(cur, origin)

        destination_place_id, destination_lat, destination_lng = find_or_create_place(cur, destination)

        #
        # Same origin/destination place is the same path - return the existing
        # one instead of re-routing and inserting a duplicate.
        #
        cur.execute(
            """
            SELECT id, origin_place_id, destination_place_id,
                route, distances_miles, max_speeds_mph, road_names, road_name_boundary_miles
            FROM paths
            WHERE origin_place_id = %s AND destination_place_id = %s
            """,
            (origin_place_id, destination_place_id)
        )

        existing = cur.fetchone()

        if existing is not None:

            zones = fetch_zones_for_paths(cur, [existing[0]]).get(existing[0], [])
            places_by_id = fetch_places_by_id(cur, [existing[1], existing[2]])

            #
            # Nothing new for the path itself, but find_or_create_place() above
            # may have inserted new places rows - commit those rather than
            # rolling them back on close.
            #
            conn.commit()

            return {

                "id": existing[0],

                "origin": places_by_id[existing[1]]["description"],

                "origin_lat": places_by_id[existing[1]]["lat"],

                "origin_lng": places_by_id[existing[1]]["lng"],

                "destination": places_by_id[existing[2]]["description"],

                "destination_lat": places_by_id[existing[2]]["lat"],

                "destination_lng": places_by_id[existing[2]]["lng"],

                "route": existing[3],

                "distances_miles": existing[4],

                "max_speeds_mph": existing[5],

                "road_names": existing[6],

                "road_name_boundary_miles": existing[7],

                "zones": zones
            }

        route, distances_miles, max_speeds_mph, road_names, road_name_boundary_miles = road_route(
            (origin_lat, origin_lng), (destination_lat, destination_lng)
        )

        cur.execute(
            """
            INSERT INTO paths
            (
                origin_place_id,
                destination_place_id,
                route,
                distances_miles,
                max_speeds_mph,
                road_names,
                road_name_boundary_miles
            )

            VALUES
            (%s,%s,%s,%s,%s,%s,%s)

            RETURNING id
            """,
            (
                origin_place_id,
                destination_place_id,
                json.dumps(route),
                json.dumps(distances_miles),
                json.dumps(max_speeds_mph),
                json.dumps(road_names),
                json.dumps(road_name_boundary_miles)
            )
        )

        path_id = cur.fetchone()[0]

        conn.commit()

        return {

            "id": path_id,

            "origin": origin,

            "origin_lat": origin_lat,

            "origin_lng": origin_lng,

            "destination": destination,

            "destination_lat": destination_lat,

            "destination_lng": destination_lng,

            "route": route,

            "distances_miles": distances_miles,

            "max_speeds_mph": max_speeds_mph,

            "road_names": road_names,

            "road_name_boundary_miles": road_name_boundary_miles,

            "zones": []
        }

    finally:
        cur.close()
        conn.close()


#
# Shared by _divert_to_gas_station() (current live position -> a chosen gas
# station) and _resume_trip_after_refuel() (that gas station -> wherever
# the vehicle actually still needs to go) - both already have real place
# ids and coordinates for both ends (no free-text geocoding needed, unlike
# _build_path_result() above), so this only ever does the OSRM routing
# step, reusing an existing path between the same two places instead of
# re-routing one that's already been driven.
#
def find_or_create_path_between_places(
    cur, origin_place_id, origin_lat, origin_lng, destination_place_id, destination_lat, destination_lng
):

    cur.execute(
        "SELECT id, route, distances_miles, max_speeds_mph FROM paths WHERE origin_place_id = %s AND destination_place_id = %s",
        (origin_place_id, destination_place_id)
    )

    existing = cur.fetchone()

    if existing is not None:
        return existing

    route, distances_miles, max_speeds_mph, road_names, road_name_boundary_miles = road_route(
        (origin_lat, origin_lng), (destination_lat, destination_lng)
    )

    cur.execute(
        """
        INSERT INTO paths
        (origin_place_id, destination_place_id, route, distances_miles, max_speeds_mph, road_names, road_name_boundary_miles)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            origin_place_id,
            destination_place_id,
            json.dumps(route),
            json.dumps(distances_miles),
            json.dumps(max_speeds_mph),
            json.dumps(road_names),
            json.dumps(road_name_boundary_miles)
        )
    )

    path_id = cur.fetchone()[0]

    return path_id, route, distances_miles, max_speeds_mph


#
# Starts a brand-new trip that repositions a vehicle directly to
# origin_place_id, rather than picking it up from wherever it last
# settled - used for both legs of a gas-station detour (a divert away from
# the vehicle's live mid-route position, and the automatic resume once
# refueled). Neither goes through POST /api/trips's normal same-place
# invariant (the vehicle's place_id is set here, to origin_place_id,
# instead of being checked against it) since a live position isn't
# somewhere the vehicle was ever "settled" the normal way.
#
def start_diversion_trip(
    conn, cur, vehicle_id,
    origin_place_id, origin_lat, origin_lng,
    destination_place_id, destination_lat, destination_lng,
    starting_fuel_gallons, resume_destination_place_id, auto_refuel
):

    path_id, route, distances_miles, max_speeds_mph = find_or_create_path_between_places(
        cur, origin_place_id, origin_lat, origin_lng, destination_place_id, destination_lat, destination_lng
    )

    cur.execute("UPDATE vehicles SET place_id = %s WHERE id = %s", (origin_place_id, vehicle_id))

    _, game_time = get_settings(conn, cur)

    zones = fetch_zones_for_paths(cur, [path_id]).get(path_id, [])

    cur.execute(
        """
        INSERT INTO trips
        (vehicle_id, path_id, traffic_base_datetime, traffic_bias, zones_snapshot, starting_fuel_gallons, resume_destination_place_id, auto_refuel)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (vehicle_id, path_id, game_time, 1.0, json.dumps(zones), starting_fuel_gallons, resume_destination_place_id, auto_refuel)
    )

    trip_id = cur.fetchone()[0]

    realized_seconds = build_trip_schedule(distances_miles, max_speeds_mph, zones, game_time, 1.0, trip_id)
    realized_duration_seconds = realized_seconds[-1]

    cur.execute(
        "UPDATE trips SET realized_seconds = %s, realized_duration_seconds = %s WHERE id = %s",
        (json.dumps(realized_seconds), realized_duration_seconds, trip_id)
    )

    return trip_id


#
# The divert action itself - cancels the vehicle's current trip, folds the
# distance it already covered on that trip into its permanent odometer
# (starting_mileage), and starts a fresh trip from its live position to the
# chosen gas station. All the actual geocoding/routing calls this needs
# (find_or_create_place_by_coords(), road_route() inside
# start_diversion_trip()) are why this only ever runs inside job_executor
# (see _run_divert_job() below), not inline in the request that triggers it.
#
def _divert_to_gas_station(
    vehicle_id, current_trip_id, lat, lng,
    partial_miles_driven, current_fuel_gallons,
    gas_station_place_id, resume_destination_place_id
):

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute("UPDATE trips SET cancelled_at = NOW() WHERE id = %s", (current_trip_id,))

        cur.execute(
            "UPDATE vehicles SET starting_mileage = starting_mileage + %s, fuel_gallons = %s WHERE id = %s",
            (partial_miles_driven, current_fuel_gallons, vehicle_id)
        )

        origin_place_id = find_or_create_place_by_coords(cur, lat, lng)

        station = fetch_places_by_id(cur, [gas_station_place_id])[gas_station_place_id]

        trip_id = start_diversion_trip(
            conn, cur, vehicle_id,
            origin_place_id, lat, lng,
            gas_station_place_id, station["lat"], station["lng"],
            current_fuel_gallons, resume_destination_place_id, True
        )

        conn.commit()

        return {"vehicle_id": vehicle_id, "trip_id": trip_id}

    finally:
        cur.close()
        conn.close()


def _run_divert_job(
    job_id, vehicle_id, current_trip_id, lat, lng,
    partial_miles_driven, current_fuel_gallons,
    gas_station_place_id, resume_destination_place_id
):

    update_job(job_id, status="running")

    try:
        result = _divert_to_gas_station(
            vehicle_id, current_trip_id, lat, lng,
            partial_miles_driven, current_fuel_gallons,
            gas_station_place_id, resume_destination_place_id
        )
    except Exception as e:
        update_job(job_id, status="error", error=getattr(e, "detail", str(e)))
        return

    update_job(job_id, status="done", result=result)


#
# Starts a fresh trip from origin_place_id to destination_place_id with no
# resume_destination_place_id of its own - used two ways: triggered from
# settle_arrived_vehicles() the moment a gas-station detour actually
# arrives (already auto-refueled by then), to route onward to wherever the
# vehicle was really trying to get to (auto_refuel=False - that
# destination is whatever the vehicle was originally headed to, not
# necessarily a gas station at all); and directly from POST
# /api/vehicles/{id}/refuel when a READY vehicle isn't already at a gas
# station, to drive it to the closest one and simply park there
# (auto_refuel=True - see settle_arrived_vehicles()).
#
def _resume_trip_after_refuel(vehicle_id, origin_place_id, destination_place_id, auto_refuel):

    conn = db()
    cur = conn.cursor()

    try:

        places_by_id = fetch_places_by_id(cur, [origin_place_id, destination_place_id])
        origin = places_by_id[origin_place_id]
        destination = places_by_id[destination_place_id]

        cur.execute("SELECT fuel_gallons FROM vehicles WHERE id = %s", (vehicle_id,))
        fuel_gallons = cur.fetchone()[0]

        trip_id = start_diversion_trip(
            conn, cur, vehicle_id,
            origin_place_id, origin["lat"], origin["lng"],
            destination_place_id, destination["lat"], destination["lng"],
            fuel_gallons, None, auto_refuel
        )

        conn.commit()

        return {"vehicle_id": vehicle_id, "trip_id": trip_id}

    finally:
        cur.close()
        conn.close()


def _run_resume_trip_job(job_id, vehicle_id, origin_place_id, destination_place_id, auto_refuel):

    update_job(job_id, status="running")

    try:
        result = _resume_trip_after_refuel(vehicle_id, origin_place_id, destination_place_id, auto_refuel)
    except Exception as e:
        update_job(job_id, status="error", error=getattr(e, "detail", str(e)))
        return

    update_job(job_id, status="done", result=result)


def _run_create_path_job(job_id, origin, destination, origin_place_id=None):

    update_job(job_id, status="running")

    try:
        result = _build_path_result(origin, destination, origin_place_id)
    except Exception as e:
        update_job(job_id, status="error", error=getattr(e, "detail", str(e)))
        return

    update_job(job_id, status="done", result=result)


@app.post("/api/paths", status_code=202)
def create_path(req: CreatePathRequest):

    job_id = create_job("create_path")

    job_executor.submit(_run_create_path_job, job_id, req.origin, req.destination, req.origin_place_id)

    return {"job_id": job_id}



@app.get("/api/paths")
def list_paths():

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT id, origin_place_id, destination_place_id,
            route, distances_miles, max_speeds_mph, road_names, road_name_boundary_miles
        FROM paths
        ORDER BY id
        """
    )

    rows = cur.fetchall()

    zones_by_path = fetch_zones_for_paths(cur, [row[0] for row in rows])
    places_by_id = fetch_places_by_id(cur, [row[1] for row in rows] + [row[2] for row in rows])

    cur.close()
    conn.close()

    return [
        {

            "id": row[0],

            "origin": places_by_id[row[1]]["description"],

            "origin_lat": places_by_id[row[1]]["lat"],

            "origin_lng": places_by_id[row[1]]["lng"],

            "destination": places_by_id[row[2]]["description"],

            "destination_lat": places_by_id[row[2]]["lat"],

            "destination_lng": places_by_id[row[2]]["lng"],

            "route": row[3],

            "distances_miles": row[4],

            "max_speeds_mph": row[5],

            "road_names": row[6],

            "road_name_boundary_miles": row[7],

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
    # Settle before reading place_id below - otherwise a vehicle whose
    # previous trip just arrived (but hasn't been read since, e.g. GET
    # /api/vehicles hasn't been polled yet) would still show its old,
    # pre-arrival location here.
    #
    settle_arrived_vehicles(conn, cur, time_multiplier)

    cur.execute("SELECT sold, place_id, fuel_gallons FROM vehicles WHERE id=%s", (req.vehicle_id,))

    vehicle_row = cur.fetchone()

    if vehicle_row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle not found")

    sold, vehicle_place_id, vehicle_fuel_gallons = vehicle_row

    if sold:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle has been sold")

    cur.execute(
        "SELECT route, distances_miles, max_speeds_mph, origin_place_id FROM paths WHERE id=%s",
        (req.path_id,)
    )

    path_row = cur.fetchone()

    if path_row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Path not found")

    route, distances_miles, max_speeds_mph, origin_place_id = path_row

    if vehicle_place_id != origin_place_id:

        places_by_id = fetch_places_by_id(cur, [vehicle_place_id, origin_place_id])
        vehicle_location = places_by_id[vehicle_place_id]["description"]
        origin_location = places_by_id[origin_place_id]["description"]

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
        AND t.cancelled_at IS NULL
        AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * %s - t.paused_seconds) < t.realized_duration_seconds
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

    #
    # Fuel isn't checked against the path's distance here - a vehicle is
    # allowed to depart without enough of it (see resolve_trip_progress()),
    # and simply runs dry (STRANDED) partway down the route instead of
    # being blocked from leaving at all.
    #
    cur.execute(
        """
        INSERT INTO trips (vehicle_id, path_id, traffic_base_datetime, traffic_bias, zones_snapshot, starting_fuel_gallons)
        VALUES (%s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (req.vehicle_id, req.path_id, traffic_base_datetime, req.traffic_bias, json.dumps(zones), vehicle_fuel_gallons)
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
            vs.mpg,
            vs.fuel_tank_gallons,
            t.starting_fuel_gallons,
            t.roadside_refuel_count,
            t.paused_seconds,
            t.resume_destination_place_id,
            EXTRACT(EPOCH FROM (NOW() - t.started_at))
        FROM trips t
        JOIN vehicles v ON v.id = t.vehicle_id
        JOIN paths p ON p.id = t.path_id
        JOIN vehicle_models vs ON vs.id = v.vehicle_model_id
        WHERE t.cancelled_at IS NULL
        AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * %s - t.paused_seconds) < t.realized_duration_seconds + %s * %s
        """,
        (time_multiplier, ARRIVAL_GRACE_SECONDS, time_multiplier)
    )

    rows = cur.fetchall()

    #
    # Resolved once, in bulk, rather than per-row - only a divert-to-gas-
    # station leg ever has a resume_destination_place_id at all, so this is
    # usually empty.
    #
    resume_places_by_id = fetch_places_by_id(cur, [row[-2] for row in rows if row[-2] is not None])

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
        mpg,
        fuel_tank_gallons,
        starting_fuel_gallons,
        roadside_refuel_count,
        paused_seconds,
        resume_destination_place_id,
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
            mpg,
            fuel_tank_gallons,
            starting_fuel_gallons,
            roadside_refuel_count,
            paused_seconds,
            float(elapsed_real_seconds),
            time_multiplier
        )

        trips.append({

            "trip_id": trip_id,

            "vehicle_id": vehicle_id,

            "vehicle_name": vehicle_name,

            "path_id": path_id,

            "route": route,

            #
            # Set only while this trip is a gas-station detour - the
            # frontend uses this to show that a vehicle mid-route is
            # actually en route to refuel, not off-course or stuck, and
            # what it'll automatically resume to once it gets there (see
            # settle_arrived_vehicles()).
            #
            "resume_destination": (
                resume_places_by_id[resume_destination_place_id]["description"]
                if resume_destination_place_id is not None else None
            ),

            **derived
        })

    return {"trips": trips}
