from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Header, Depends
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from geopy.geocoders import Nominatim
from geopy.extra.rate_limiter import RateLimiter
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Optional
from concurrent.futures import ThreadPoolExecutor
from psycopg2.extras import Json
from PIL import Image, ImageOps, UnidentifiedImageError
import numpy as np
from urllib.parse import quote, urlparse
import psycopg2
import requests
import json
import asyncio
import bisect
import csv
import hashlib
import hmac
import io
import ipaddress
import logging
import math
import os
import random
import re
import socket
import threading
import time
import uuid


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
# Auto-refuel is an opt-in perk, not default behavior - settings.auto_refuel_level
# is an integer (not a boolean) so it can grow into an upgradeable level later
# without another schema change. Today only two levels exist:
#
#   0 - off: a vehicle runs dry (STRANDED) unless the user diverts it manually
#   1 - on: once a DRIVING vehicle's tank drops to AUTO_REFUEL_FUEL_FRACTION
#       and it can't finish the trip on what's left, it diverts itself to the
#       nearest reachable gas station (the same divert the "Divert to gas
#       station" button does) and resumes to its destination afterward
#
# Future levels slot in here (e.g. a higher threshold, picking the cheapest
# station instead of the nearest, planning stops at trip start) - see
# maybe_auto_divert_to_gas_station().
#
AUTO_REFUEL_LEVEL_OFF = 0
AUTO_REFUEL_LEVEL_BASIC = 1
AUTO_REFUEL_MAX_LEVEL = AUTO_REFUEL_LEVEL_BASIC

AUTO_REFUEL_FUEL_FRACTION = 0.25

#
# The "last chance" half of the level 1 trigger (see needs_auto_refuel()):
# don't refuel at a station with this much of the tank or more still left -
# that's never the last chance (and it's what keeps a vehicle that just
# refueled from immediately diverting back to the same station).
#
AUTO_REFUEL_LAST_CHANCE_MAX_FRACTION = 0.75

#
# How far past the vehicle a station has to be to still count as "coming
# up" for the last-chance check - a station closer than this is about to be
# passed (or already effectively is by the time a divert job runs), so if
# it's the only one in range, now is the moment to take it. Scaled up with
# the time multiplier (AUTO_REFUEL_LOOKAHEAD_REAL_SECONDS of driving at
# AUTO_REFUEL_LOOKAHEAD_ASSUMED_MPH) so a fast game clock can't carry a
# vehicle clean past its last station between two polls.
#
AUTO_REFUEL_MIN_LOOKAHEAD_MILES = 5.0
AUTO_REFUEL_LOOKAHEAD_REAL_SECONDS = 3.0
AUTO_REFUEL_LOOKAHEAD_ASSUMED_MPH = 70.0

#
# find_gas_station_options() only knows straight-line distance, and the
# real road there can be nearly twice that (a 10-mile hop that's 19 miles
# by road stranded a vehicle 1.3 miles short). An auto-divert routes up to
# this many of the nearest candidates and takes the first whose actual road
# distance fits the fuel left - each one is an OSRM call, hence the cap.
#
AUTO_DIVERT_MAX_ROUTED_CANDIDATES = 3

#
# How often the backend settles trips on its own (_settle_ticker()), in
# real seconds. Settling - arrivals, and the auto-refuel check - used to
# happen only when a request came in, so a backgrounded browser tab
# (Chrome throttles its timers to once a minute) let a vehicle drive an
# hour of game time at 60x between checks, straight past its refuel point.
#
SETTLE_TICK_SECONDS = 1.0


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


#
# The shared console-style save files - see the `save_slots` table. Every
# request that touches a file's own world (vehicles, trips, settings, its
# jobs) names the file in an X-Save-Slot header (see current_slot()).
#
SAVE_SLOT_COUNT = 4
SAVE_SLOT_NAME_MAX_LENGTH = 16

#
# Money is Gold Doubloons, written like dollars ($14,328.45). Each file
# starts with this much; gas is charged as it's bought and refunded at the
# price paid as a finished trip burns it (see settle_arrived_vehicles()), so
# a successful trip costs nothing in the end.
#
STARTING_BALANCE = 10000

#
# Charged on top of the gas itself for a roadside refuel (POST
# /api/vehicles/{id}/roadside-refuel). Not refunded - only gas is.
#
ROADSIDE_ASSIST_FEE = 75

#
# Every new file starts with grandpa's van (the intro splash's story): this
# vehicle model is re-created at startup and on every new file if it's gone
# missing, and can't be deleted. Matched by year/brand/model like a vehicle
# model CSV upload, so an upload can still change its stats - only these
# defaults are used when it has to be re-created.
#
STARTER_VEHICLE_MODEL = {
    "year": 1978,
    "brand": "Ford",
    "model": "Econoline",
    "person_capacity": 2,
    "cargo_capacity_cuft": 329,
    "cost": 3000,
    "mpg": 8,
    "fuel_tank_gallons": 38,
    "image": "1978-Ford-Econoline.png",
    # The 351 cu in V8 Ford sold as a 5.8L - stored from cubic inches so it
    # reads back as 351, not the 354 a flat 5.8 L would convert to.
    "engine_liters": round(351 / 61.0237, 4),
    "engine_cylinders": 8,
    "engine_turbo": False,
    "fuel_type": "gasoline",
    "transmission": "automatic",
    "tire_count": 4
}

#
# It's been around the block a few times.
#
STARTER_VEHICLE_MILEAGE = 187342

#
# Where the van starts, saved as a place directly (no geocode) so starting
# a file never waits on Nominatim or the proxy.
#
STARTER_PLACE = {
    "description": "Minneapolis",
    "address": "Minneapolis, Hennepin County, Minnesota, United States",
    "lat": 44.9773,
    "lng": -93.2655,
    "continent": "North America",
    "country": "United States",
    "state": "Minnesota",
    "city": "Minneapolis"
}


def is_starter_vehicle_model(year, brand, model):

    return (
        year == STARTER_VEHICLE_MODEL["year"]
        and brand.strip().lower() == STARTER_VEHICLE_MODEL["brand"].lower()
        and model.strip().lower() == STARTER_VEHICLE_MODEL["model"].lower()
    )


#
# The starter van's vehicle model id, inserting it from
# STARTER_VEHICLE_MODEL first if it's missing. Doesn't commit.
#
def ensure_starter_vehicle_model(cur):

    starter = STARTER_VEHICLE_MODEL

    cur.execute(
        """
        SELECT id FROM vehicle_models
        WHERE year = %s AND LOWER(brand) = LOWER(%s) AND LOWER(model) = LOWER(%s)
        ORDER BY id
        LIMIT 1
        """,
        (starter["year"], starter["brand"], starter["model"])
    )

    existing = cur.fetchone()

    if existing is not None:
        return existing[0]

    cur.execute(
        """
        INSERT INTO vehicle_models
        (year, brand, model, person_capacity, cargo_capacity_cuft, cost, mpg, fuel_tank_gallons, image,
         engine_liters, engine_cylinders, engine_turbo, fuel_type, transmission, tire_count)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            starter["year"], starter["brand"], starter["model"], starter["person_capacity"],
            starter["cargo_capacity_cuft"], starter["cost"], starter["mpg"], starter["fuel_tank_gallons"],
            starter["image"], starter["engine_liters"], starter["engine_cylinders"], starter["engine_turbo"],
            starter["fuel_type"], starter["transmission"], starter["tire_count"]
        )
    )

    return cur.fetchone()[0]


#
# STARTER_PLACE's id - an already-saved "Minneapolis" (or one at the same
# spot) is reused rather than duplicated. Doesn't commit.
#
def ensure_starter_place(cur):

    saved = find_saved_place(cur, STARTER_PLACE["description"])

    if saved is not None:
        return saved[0]

    place = STARTER_PLACE
    lat = round_coord(place["lat"])
    lng = round_coord(place["lng"])

    cur.execute("SELECT id FROM places WHERE lat = %s AND lng = %s", (lat, lng))

    existing = cur.fetchone()

    if existing is not None:
        return existing[0]

    cur.execute(
        """
        INSERT INTO places (description, address, lat, lng, continent, country, state, city)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            place["description"], place["address"], lat, lng,
            place["continent"], place["country"], place["state"], place["city"]
        )
    )

    return cur.fetchone()[0]


#
# A new file's first vehicle: the starter van, free (it was inherited -
# purchase_price 0, so selling it refunds nothing), parked at STARTER_PLACE
# with a full tank. Doesn't commit.
#
def give_starter_vehicle(cur, slot_id):

    vehicle_model_id = ensure_starter_vehicle_model(cur)
    place_id = ensure_starter_place(cur)

    cur.execute(
        "SELECT year, brand, model, fuel_tank_gallons FROM vehicle_models WHERE id = %s",
        (vehicle_model_id,)
    )

    year, brand, model, fuel_tank_gallons = cur.fetchone()

    cur.execute(
        """
        INSERT INTO vehicles (
            slot_id, name, vehicle_model_id, place_id, starting_mileage, fuel_gallons, purchase_price, list_price
        )
        VALUES (%s, %s, %s, %s, %s, %s, 0, (SELECT cost FROM vehicle_models WHERE id = %s))
        """,
        (
            slot_id, f"{year} {brand} {model} 1", vehicle_model_id, place_id, STARTER_VEHICLE_MILEAGE,
            fuel_tank_gallons, vehicle_model_id
        )
    )


#
# The one way a file's balance changes: a signed amount (negative = spent),
# rounded to the cent, applied to save_slots.balance and written to the
# ledger with the balance it left behind - in the caller's transaction, so it
# commits (or rolls back) together with whatever it paid for.
#
# vehicle_name, location and trip are stored as text, as they read at the
# time, for the Budget page: the vehicle can be deleted, and the places and
# path behind a trip are forgotten once nothing uses them.
#
def record_money(
    cur, slot_id, amount, kind, description, vehicle_id=None, vehicle_name=None, location=None, trip=None,
    journey_id=None
):

    amount = round(amount, 2)

    if amount == 0:
        return

    cur.execute("UPDATE save_slots SET balance = balance + %s WHERE id = %s RETURNING balance", (amount, slot_id))

    balance_after = cur.fetchone()[0]

    cur.execute(
        """
        INSERT INTO ledger
        (slot_id, amount, kind, description, vehicle_id, vehicle_name, location, trip, journey_id, balance_after)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (slot_id, amount, kind, description, vehicle_id, vehicle_name, location, trip, journey_id, balance_after)
    )


#
# Ledger rows written before the Budget page's location/trip columns
# existed only have the old one-line description, e.g.
#   "1978 Ford Econoline 1: 15.17 gal at $4.74/gal (Rb'S One Stop, Kaysville)"
#   "1978 Ford Econoline 1: gas refund for the trip to Chicago"
#   "1978 Ford Econoline 1: roadside assistance fee"
# The location is recoverable from that text, and the description is
# rewritten to today's style (no vehicle prefix - it has its own column).
# The trip itself was never recorded and its path is long forgotten, so that
# stays empty. Only touches rows with no location yet, so it runs once.
#
OLD_LEDGER_PURCHASE_PATTERN = re.compile(r"^(?:.*?: )?(?P<what>[0-9.]+ gal at \$[0-9.]+/gal) \((?P<where>.*)\)$")
OLD_LEDGER_ROADSIDE_PATTERN = re.compile(r"^(?:.*?: )?roadside fuel, (?P<what>[0-9.]+ gal at \$[0-9.]+/gal)", re.IGNORECASE)
OLD_LEDGER_REFUND_PATTERN = re.compile(r"^(?:.*?: )?gas refund for the trip to (?P<where>.+)$", re.IGNORECASE)
OLD_LEDGER_FEE_PATTERN = re.compile(r"^(?:.*?: )?roadside assistance fee$", re.IGNORECASE)


def backfill_old_ledger_locations(cur):

    cur.execute("SELECT id, description FROM ledger WHERE location IS NULL AND trip IS NULL")

    for ledger_id, description in cur.fetchall():

        location = None
        new_description = None

        if match := OLD_LEDGER_PURCHASE_PATTERN.match(description):
            location, new_description = match["where"], f"Gas: {match['what']}"
        elif match := OLD_LEDGER_ROADSIDE_PATTERN.match(description):
            location, new_description = "Roadside", f"Roadside gas: {match['what']} (nearest station's price)"
        elif match := OLD_LEDGER_REFUND_PATTERN.match(description):
            location, new_description = match["where"], "Gas refund: trip finished"
        elif OLD_LEDGER_FEE_PATTERN.match(description):
            location, new_description = "Roadside", "Roadside assistance fee"

        if location is not None:
            cur.execute(
                "UPDATE ledger SET location = %s, description = %s WHERE id = %s",
                (location, new_description, ledger_id)
            )


#
# "Minneapolis → Chicago" - how a trip reads on the Budget page: where the
# whole journey started (trips.journey_origin, which carries through a
# gas-station detour and the resumed leg after it) to where it was going.
#
def journey_label(journey_origin, destination):

    return f"{journey_origin or '?'} → {destination}"


def get_balance(cur, slot_id):

    cur.execute("SELECT balance FROM save_slots WHERE id = %s", (slot_id,))

    row = cur.fetchone()

    return float(row[0]) if row else 0.0


#
# The per-gallon price at a priced place, or None if it has no gas price.
#
def gas_price_at(cur, place_id):

    cur.execute("SELECT price_per_gallon FROM gas_prices WHERE place_id = %s", (place_id,))

    row = cur.fetchone()

    return row[0] if row else None


#
# A trip leg's whole fuel pool - what it set out with plus any roadside
# fills - and what that pool cost per gallon on average, which is the price
# its burned gas is refunded at and what's left in the tank is worth.
#
def trip_fuel_pool(starting_fuel_gallons, roadside_refuel_count, fuel_tank_gallons, fuel_value_dollars):

    total_gallons = starting_fuel_gallons + roadside_refuel_count * (fuel_tank_gallons or 0)
    cost_per_gallon = fuel_value_dollars / total_gallons if total_gallons > 0 else 0.0

    return total_gallons, cost_per_gallon


#
# Tops a vehicle's tank up to full at price_per_gallon, charging the file
# and blending the purchase into the tank's average cost per gallon.
# Returns (gallons bought, cost). The caller sets fuel_gallons itself.
#
#
# Settings shared by every save file (global_settings), as opposed to each
# file's own clock and auto-refuel (settings). Read with get_global_setting(),
# changed by admins (PUT /api/global-settings).
#
# diesel_markup_percent: how much more diesel costs than a station's (gas)
# price - stations only have the one price, so a diesel vehicle (its model's
# fuel_type) pays that plus this at every fill-up, roadside refuel included.
#
GLOBAL_SETTING_DEFAULTS = {
    "diesel_markup_percent": 18.0,
}

DIESEL_MARKUP_RANGE = (0.0, 200.0)


def get_global_setting(cur, key):

    cur.execute("SELECT value FROM global_settings WHERE key = %s", (key,))

    row = cur.fetchone()

    return float(row[0]) if row is not None else GLOBAL_SETTING_DEFAULTS[key]


#
# What a vehicle pays per gallon where a station charges station_price:
# the same for gasoline (or a model with no fuel type set), plus the diesel
# markup for diesel. Returns (price, markup_percent or None).
#
def fuel_price_for_vehicle(cur, vehicle_id, station_price):

    cur.execute(
        """
        SELECT vm.fuel_type
        FROM vehicles v JOIN vehicle_models vm ON vm.id = v.vehicle_model_id
        WHERE v.id = %s
        """,
        (vehicle_id,)
    )

    row = cur.fetchone()

    if row is None or row[0] != "diesel":
        return station_price, None

    markup_percent = get_global_setting(cur, "diesel_markup_percent")

    return station_price * (1 + markup_percent / 100), markup_percent


def fuel_purchase_label(gallons, price_per_gallon, markup_percent):

    if markup_percent is None:
        return f"Gas: {gallons:.2f} gal at ${price_per_gallon:.2f}/gal"

    return f"Diesel: {gallons:.2f} gal at ${price_per_gallon:.2f}/gal (gas +{markup_percent:g}%)"


#
# price_per_gallon is the station's price; a diesel vehicle pays the
# diesel markup on top (fuel_price_for_vehicle()).
#
def buy_fuel_to_full(
    cur, slot_id, vehicle_id, vehicle_name, gallons_in_tank, tank_cost_per_gallon,
    fuel_tank_gallons, price_per_gallon, where, trip=None, journey_id=None
):

    price_per_gallon, markup_percent = fuel_price_for_vehicle(cur, vehicle_id, price_per_gallon)

    gallons_bought = max(0.0, fuel_tank_gallons - gallons_in_tank)
    cost = gallons_bought * price_per_gallon

    blended_cost_per_gallon = (
        (gallons_in_tank * tank_cost_per_gallon + cost) / fuel_tank_gallons
        if fuel_tank_gallons > 0 else 0.0
    )

    cur.execute("UPDATE vehicles SET fuel_cost_per_gallon = %s WHERE id = %s", (blended_cost_per_gallon, vehicle_id))

    record_money(
        cur, slot_id, -cost, "gas_purchase",
        fuel_purchase_label(gallons_bought, price_per_gallon, markup_percent),
        vehicle_id, vehicle_name, where, trip, journey_id
    )

    return gallons_bought, cost


def ensure_settings_row(conn, cur, slot_id):

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
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (id) DO NOTHING
        """,
        (slot_id, DEFAULT_TIME_MULTIPLIER, datetime.utcnow(), local_now_naive())
    )

    conn.commit()


def get_settings(conn, cur, slot_id):

    #
    # The game clock is derived on every read from an anchor pair, not
    # stored directly - it was anchor_game_time at the real UTC moment
    # anchor_real_utc, and has advanced at time_multiplier x real speed
    # ever since. Comparing against datetime.utcnow() (not local_now_naive())
    # here since anchor_real_utc is always written from datetime.utcnow().
    #
    ensure_settings_row(conn, cur, slot_id)

    cur.execute("SELECT time_multiplier, anchor_real_utc, anchor_game_time FROM settings WHERE id = %s", (slot_id,))

    multiplier, anchor_real_utc, anchor_game_time = cur.fetchone()

    elapsed_real_seconds = (datetime.utcnow() - anchor_real_utc).total_seconds()

    game_time = anchor_game_time + timedelta(seconds=elapsed_real_seconds * multiplier)

    return multiplier, game_time


#
# Kept separate from get_settings() rather than widening its return tuple -
# that's called from a dozen places that only care about the clock.
#
def get_auto_refuel_level(conn, cur, slot_id):

    ensure_settings_row(conn, cur, slot_id)

    cur.execute("SELECT auto_refuel_level FROM settings WHERE id = %s", (slot_id,))

    return cur.fetchone()[0]


#
# Which save file a vehicle belongs to - what every vehicle-scoped job
# (drive, divert, refuel, resume) uses to pick that file's own game clock
# and time multiplier, since those run with no request (and so no
# X-Save-Slot header) behind them.
#
def vehicle_slot_id(cur, vehicle_id):

    cur.execute("SELECT slot_id FROM vehicles WHERE id = %s", (vehicle_id,))

    row = cur.fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    return row[0]


#
# Every /api/vehicles/{id}/... endpoint checks the vehicle is in the file
# the request is playing - a vehicle in another file is simply "not found",
# never acted on from here.
#
def require_vehicle_in_slot(cur, vehicle_id, slot_id):

    if vehicle_slot_id(cur, vehicle_id) != slot_id:
        raise HTTPException(status_code=404, detail="Vehicle not found")


#
# The same check on its own connection - for the top of an endpoint, before
# it opens its own, so a refusal never leaves a connection half-used.
#
def assert_vehicle_in_slot(vehicle_id, slot_id):

    conn = db()
    cur = conn.cursor()

    try:
        require_vehicle_in_slot(cur, vehicle_id, slot_id)
    finally:
        cur.close()
        conn.close()


#
# The file a request is playing, from the X-Save-Slot header the frontend
# sends on every call once a file is picked on its file-select screen. Used
# as a FastAPI dependency on every endpoint that touches one file's world.
#
def current_slot(x_save_slot: Optional[str] = Header(None)):

    try:
        slot_id = int(x_save_slot)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Pick a save file first")

    if not 1 <= slot_id <= SAVE_SLOT_COUNT:
        raise HTTPException(status_code=400, detail=f"Save file must be 1-{SAVE_SLOT_COUNT}")

    conn = db()
    cur = conn.cursor()

    try:
        cur.execute("SELECT 1 FROM save_slots WHERE id = %s", (slot_id,))
        started = cur.fetchone() is not None
    finally:
        cur.close()
        conn.close()

    if not started:
        raise HTTPException(status_code=409, detail=f"File {slot_id} has no game - start one from the file select screen")

    return slot_id


#
# Two roles: everyone is a "user" (save files, their vehicles, the budget),
# and anyone who knows ADMIN_PASSWORD (.env, per instance) can elevate to
# "admin" for the global configuration every file shares - gas stations,
# vehicle models, background jobs, erasing files. Not a login: elevating
# hands back a signed token (expiry + HMAC keyed by the password, so
# changing the password revokes every token) that the browser sends as
# X-Admin-Token - or ?admin_token= on a plain download link.
#
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ADMIN_TOKEN_TTL_SECONDS = 12 * 60 * 60

#
# A wrong password waits this long before answering, so guessing is slow.
#
ADMIN_WRONG_PASSWORD_DELAY_SECONDS = 1


def admin_token_signature(expires):

    key = hashlib.sha256(("logisim-admin:" + ADMIN_PASSWORD).encode()).digest()

    return hmac.new(key, str(expires).encode(), hashlib.sha256).hexdigest()


def is_valid_admin_token(token):

    if not ADMIN_PASSWORD or not token:
        return False

    expires, _, signature = token.partition(".")

    try:
        expires = int(expires)
    except ValueError:
        return False

    return expires > time.time() and hmac.compare_digest(signature, admin_token_signature(expires))


#
# The FastAPI dependency on every admin-only endpoint. 403 is used for
# nothing else, so the frontend reads it as "admin mode has lapsed".
#
def require_admin(x_admin_token: Optional[str] = Header(None), admin_token: Optional[str] = None):

    if not is_valid_admin_token(x_admin_token or admin_token):
        raise HTTPException(status_code=403, detail="Admin only - elevate to admin first")


def settle_arrived_vehicles(conn, cur):

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
            vm.mpg, vm.fuel_tank_gallons, EXTRACT(EPOCH FROM (NOW() - t.started_at)),
            t.auto_divert_claimed_at, t.trip_meter_offset_miles, t.path_id,
            s.time_multiplier, s.auto_refuel_level, v.slot_id,
            t.fuel_value_dollars, t.carried_fuel_cost, v.name, t.journey_origin, COALESCE(t.journey_id, t.id)
        FROM vehicles v
        JOIN settings s ON s.id = v.slot_id
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
    pending_load_legs = []
    refueling_vehicle_ids = []
    auto_divert_candidates = []
    arrived_path_ids = []

    #
    # Every save file runs all the time, each at its own time multiplier and
    # auto-refuel level - so both come per row, from the vehicle's file's
    # settings, rather than once for the whole call.
    #
    for (
        vehicle_id, trip_id, destination_place_id, resume_destination_place_id, auto_refuel,
        distances_miles, realized_seconds, realized_duration_seconds,
        starting_fuel_gallons, roadside_refuel_count, paused_seconds,
        mpg, fuel_tank_gallons, elapsed_real_seconds, auto_divert_claimed_at, trip_meter_offset_miles, path_id,
        time_multiplier, auto_refuel_level, slot_id,
        fuel_value_dollars, carried_fuel_cost, vehicle_name, journey_origin, journey_id
    ) in rows:

        progress = resolve_trip_progress(
            distances_miles, realized_seconds, realized_duration_seconds,
            mpg, fuel_tank_gallons, starting_fuel_gallons, roadside_refuel_count, paused_seconds,
            float(elapsed_real_seconds), time_multiplier
        )

        #
        # Every caller of this function is already a poll of some kind, so
        # this is also where a DRIVING vehicle gets checked for auto-refuel -
        # progress here is the same live fuel level the UI is showing. A trip
        # that's itself headed to a gas station (auto_refuel) is already
        # refueling, and one that's been claimed is already being diverted.
        #
        if (
            progress["status"] == "DRIVING"
            and auto_refuel_level >= AUTO_REFUEL_LEVEL_BASIC
            and not auto_refuel
            and auto_divert_claimed_at is None
            and needs_auto_refuel(
                cur, path_id, progress, distances_miles, mpg, fuel_tank_gallons, time_multiplier
            )
        ):
            auto_divert_candidates.append((vehicle_id, trip_id, progress))

        if progress["status"] != "ARRIVED":
            continue

        fuel_gallons_remaining = progress["fuel_gallons_remaining"]

        #
        # Conditional on the vehicle not already being there, so when two
        # settles race (the background ticker and a request poll - see
        # _settle_ticker()), only the one whose UPDATE actually lands goes
        # on to refuel and queue the resume leg. The loser blocks on the
        # row lock, re-checks the WHERE after the winner commits, and
        # matches nothing.
        #
        cur.execute(
            """
            UPDATE vehicles SET place_id = %s, fuel_gallons = %s
            WHERE id = %s AND place_id IS DISTINCT FROM %s
            RETURNING id
            """,
            (
                destination_place_id, fuel_gallons_remaining if fuel_gallons_remaining is not None else 0.0,
                vehicle_id, destination_place_id
            )
        )

        if cur.fetchone() is None:
            continue

        arrived_path_ids.append(path_id)

        #
        # Fuel bookkeeping: what the gas this leg burned cost (its fuel pool's
        # average per gallon), carried along the journey's legs. Gas isn't
        # refunded any more - it's a real cost, paid for by delivering loads -
        # but the tank's cost per gallon still matters for the next fill-up.
        #
        total_fuel_gallons, pool_cost_per_gallon = trip_fuel_pool(
            starting_fuel_gallons, roadside_refuel_count, fuel_tank_gallons, fuel_value_dollars
        )

        remaining_fuel_gallons = fuel_gallons_remaining if fuel_gallons_remaining is not None else 0.0
        burned_cost = max(0.0, total_fuel_gallons - remaining_fuel_gallons) * pool_cost_per_gallon
        journey_fuel_cost = carried_fuel_cost + burned_cost

        cur.execute(
            "UPDATE vehicles SET fuel_cost_per_gallon = %s WHERE id = %s",
            (pool_cost_per_gallon, vehicle_id)
        )

        destination = fetch_places_by_id(cur, [destination_place_id])[destination_place_id]

        #
        # A detour's journey is still headed for its resume destination, not
        # the gas station it just reached.
        #
        journey_destination = (
            fetch_places_by_id(cur, [resume_destination_place_id])[resume_destination_place_id]["description"]
            if resume_destination_place_id is not None else destination["description"]
        )

        trip_label = journey_label(journey_origin, journey_destination)

        if auto_refuel:

            refueling_vehicle_ids.append(vehicle_id)

            #
            # A gas-station stop always has a price (it was picked from
            # priced stations); the nearest one's price is only a fallback
            # if that price was deleted meanwhile.
            #
            price = gas_price_at(cur, destination_place_id)

            if price is None:
                nearest = find_closest_gas_station(cur, destination["lat"], destination["lng"])
                price = nearest["price_per_gallon"] if nearest else 0.0

            buy_fuel_to_full(
                cur, slot_id, vehicle_id, vehicle_name, remaining_fuel_gallons, pool_cost_per_gallon,
                fuel_tank_gallons or 0.0, price, destination["description"], trip_label, journey_id
            )

        if resume_destination_place_id is not None:

            #
            # Likewise the route the journey has driven: everything before the
            # detour plus the whole detour, read now - only on this arrival,
            # not every settle - before the detour's path is forgotten below.
            #
            cur.execute(
                """
                SELECT t.journey_route_before, p.route
                FROM trips t JOIN paths p ON p.id = t.path_id
                WHERE t.id = %s
                """,
                (trip_id,)
            )

            route_before, detour_route = cur.fetchone()

            #
            # The resumed leg's trip meter picks up where this detour's
            # ended - everything before the detour plus the detour itself.
            #
            pending_resumes.append((
                vehicle_id, destination_place_id, resume_destination_place_id,
                trip_meter_offset_miles + distances_miles[-1], journey_fuel_cost, journey_origin, journey_id,
                (route_before or []) + detour_route, slot_id
            ))

        else:

            #
            # The end of a trip, not a stop on the way: picks up or delivers
            # the vehicle's load, if it has one (handle_load_arrival()). Its
            # next leg's job row goes in this same commit, like a resume's.
            #
            load_leg = handle_load_arrival(cur, slot_id, vehicle_id, vehicle_name, destination_place_id)

            if load_leg is not None:
                pending_load_legs.append(load_leg)

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

    #
    # An arrived trip's path has done its job - forgotten in the same
    # commit as the arrival itself (see forget_unused_paths()).
    #
    forget_unused_paths(cur, arrived_path_ids)

    #
    # Each resume job's row goes in this same commit as the arrival. A
    # separate commit right after left a gap where the vehicle read as
    # parked at the gas station with no trip and no pending job - and a
    # concurrent GET /api/trips/active is likely to land in exactly that
    # gap, since its own settle blocks on this one's row lock until this
    # commits. It then told the frontend nothing was coming
    # (next_refresh_seconds), so the resumed leg never showed up and the
    # vehicle looked READY while actually driving.
    #
    resume_job_ids = [
        create_job("resume_trip_after_refuel", cur=cur, slot_id=resume[-1], vehicle_id=resume[0])
        for resume in pending_resumes
    ]

    conn.commit()

    for job_id, (
        vehicle_id, gas_station_place_id, resume_destination_place_id, trip_meter_offset_miles, journey_fuel_cost,
        journey_origin, journey_id, journey_route_before, _
    ) in zip(resume_job_ids, pending_resumes):

        job_executor.submit(
            _run_resume_trip_job, job_id, vehicle_id, gas_station_place_id, resume_destination_place_id, False,
            trip_meter_offset_miles, journey_fuel_cost, journey_origin, journey_id, journey_route_before
        )

    for load_leg in pending_load_legs:
        job_executor.submit(_run_load_leg_job, *load_leg)

    for vehicle_id, trip_id, progress in auto_divert_candidates:
        maybe_auto_divert_to_gas_station(conn, cur, vehicle_id, trip_id, progress)


#
# Level 1 auto-refuel trigger. Never fires if what's in the tank already
# covers the rest of the trip. Otherwise it fires on either:
#
#   - low: at or under AUTO_REFUEL_FUEL_FRACTION of a full tank, or
#   - last chance: no other station along the route between just ahead of
#     the vehicle and the edge of its current range - i.e. it's about to
#     pass the last station it could reach before running dry.
#
# "Low" alone used to be the whole trigger, which strands a vehicle
# whenever the last station before a long empty stretch comes up while the
# tank is still above the low mark: by the time it's low, every station in
# range is already behind it (e.g. I-40 west of El Reno, OK, where the
# station data has nothing for ~200 miles).
#
def needs_auto_refuel(cur, path_id, progress, distances_miles, mpg, fuel_tank_gallons, time_multiplier):

    fuel_gallons_remaining = progress["fuel_gallons_remaining"]

    if fuel_gallons_remaining is None or not mpg or not fuel_tank_gallons:
        return False

    current_miles = progress["distance_miles"]
    range_miles = fuel_gallons_remaining * mpg

    if range_miles >= distances_miles[-1] - current_miles:
        return False

    if fuel_gallons_remaining <= fuel_tank_gallons * AUTO_REFUEL_FUEL_FRACTION:
        return True

    if fuel_gallons_remaining >= fuel_tank_gallons * AUTO_REFUEL_LAST_CHANCE_MAX_FRACTION:
        return False

    lookahead_miles = max(
        AUTO_REFUEL_MIN_LOOKAHEAD_MILES,
        AUTO_REFUEL_LOOKAHEAD_ASSUMED_MPH * time_multiplier * AUTO_REFUEL_LOOKAHEAD_REAL_SECONDS / 3600
    )

    #
    # Same 0.8 safety margin find_gas_station_options() applies to
    # reachability - a station it would refuse to offer can't count as
    # "still coming up" here either.
    #
    station_miles = stations_along_path_miles(cur, path_id, distances_miles)

    next_index = bisect.bisect_right(station_miles, current_miles + lookahead_miles)

    return not (next_index < len(station_miles) and station_miles[next_index] <= current_miles + range_miles * 0.8)


#
# Sorted miles-along-the-route of every gas station within
# MAX_GAS_STATION_DETOUR_MILES of a path, for needs_auto_refuel()'s
# last-chance check. A path's geometry never changes, so this is computed
# once per path and reused on every poll, until the station set itself
# changes (keyed on the gas station cache version - see
# get_cached_gas_stations()). Only the route geometry is fetched, and only
# on a miss, since it's the one large column involved.
#
# The route is sampled at roughly one point per mile and bucketed into a
# coarse lat/lng grid, so each station is only compared against route
# points in its own and neighboring cells instead of the whole route - a
# cross-country path is ~15k points against tens of thousands of stations.
# A 0.5-degree cell is at least 15 miles wide below ~64 degrees latitude
# (the same assumption _bounding_box_with_pad() makes), so the 3x3
# neighborhood always covers the full detour radius.
#
_STATION_GRID_DEGREES = 0.5
_STATIONS_ALONG_PATH_CACHE_MAX = 200

_stations_along_path_lock = threading.Lock()
_stations_along_path_cache = {}


def stations_along_path_miles(cur, path_id, distances_miles):

    with _gas_station_cache_lock:
        version = _gas_station_cache_version[0]

    cache_key = (path_id, version)

    with _stations_along_path_lock:
        cached = _stations_along_path_cache.get(cache_key)

    if cached is not None:
        return cached

    cur.execute("SELECT route FROM paths WHERE id = %s", (path_id,))
    route = cur.fetchone()[0]

    grid = {}
    last_sampled_miles = None

    for index, (lat, lng) in enumerate(route):

        is_last = index == len(route) - 1

        if last_sampled_miles is not None and distances_miles[index] - last_sampled_miles < 1.0 and not is_last:
            continue

        last_sampled_miles = distances_miles[index]

        cell = (math.floor(lat / _STATION_GRID_DEGREES), math.floor(lng / _STATION_GRID_DEGREES))
        grid.setdefault(cell, []).append((lat, lng, distances_miles[index]))

    station_miles = []

    for station in get_cached_gas_stations(cur):

        cell_lat = math.floor(station["lat"] / _STATION_GRID_DEGREES)
        cell_lng = math.floor(station["lng"] / _STATION_GRID_DEGREES)

        best_gap = None
        best_miles = None

        for d_lat in (-1, 0, 1):
            for d_lng in (-1, 0, 1):
                for lat, lng, miles in grid.get((cell_lat + d_lat, cell_lng + d_lng), ()):

                    gap = haversine_miles(station["lat"], station["lng"], lat, lng)

                    if best_gap is None or gap < best_gap:
                        best_gap, best_miles = gap, miles

        if best_gap is not None and best_gap <= MAX_GAS_STATION_DETOUR_MILES:
            station_miles.append(best_miles)

    station_miles.sort()

    with _stations_along_path_lock:

        if len(_stations_along_path_cache) >= _STATIONS_ALONG_PATH_CACHE_MAX:
            _stations_along_path_cache.clear()

        _stations_along_path_cache[cache_key] = station_miles

    return station_miles


#
# The automatic version of POST /api/vehicles/{id}/divert-to-gas-station -
# same station search (find_gas_station_options(), nearest first, limited to
# what's reachable on the fuel left) and the same _divert_to_gas_station()
# job, so an auto-refuel detour behaves exactly like a manual one: refuels
# on arrival and resumes to wherever the vehicle was headed.
#
# No station in range just means "try again next poll" - the vehicle keeps
# moving and a station further along the route may come into range. Once one
# is found, the trip is claimed (auto_divert_claimed_at) with a conditional
# UPDATE before the job is submitted, so concurrent polls - every endpoint
# calls settle_arrived_vehicles() - can't each kick off their own divert.
#
def maybe_auto_divert_to_gas_station(conn, cur, vehicle_id, trip_id, progress):

    cur.execute(
        """
        SELECT p.route, p.distances_miles, p.destination_place_id, t.resume_destination_place_id, vm.mpg
        FROM trips t
        JOIN paths p ON p.id = t.path_id
        JOIN vehicles v ON v.id = t.vehicle_id
        JOIN vehicle_models vm ON vm.id = v.vehicle_model_id
        WHERE t.id = %s
        """,
        (trip_id,)
    )

    route, distances_miles, destination_place_id, resume_destination_place_id, mpg = cur.fetchone()

    fuel_gallons_remaining = progress["fuel_gallons_remaining"]

    stations = find_gas_station_options(
        cur, route, distances_miles, progress["distance_miles"], fuel_gallons_remaining * mpg
    )

    if not stations:
        return

    #
    # Prefer a station on the way over one behind the vehicle - both
    # qualify in find_gas_station_options() (it serves the manual list
    # too), but backtracking is only worth it when nothing ahead is in
    # range. Stable sort, so each group stays nearest-first.
    #
    stations = sorted(stations, key=lambda station: not station["ahead"])

    cur.execute(
        """
        UPDATE trips SET auto_divert_claimed_at = NOW()
        WHERE id = %s AND auto_divert_claimed_at IS NULL AND cancelled_at IS NULL
        RETURNING id
        """,
        (trip_id,)
    )

    claimed = cur.fetchone() is not None

    conn.commit()

    if not claimed:
        return

    lat, lng = interpolate_position_at_distance(route, distances_miles, progress["distance_miles"])

    job_id = create_job("auto_divert_to_gas_station", slot_id=vehicle_slot_id(cur, vehicle_id), vehicle_id=vehicle_id)

    job_executor.submit(
        _run_auto_divert_job, job_id, vehicle_id, trip_id, lat, lng,
        progress["distance_miles"], fuel_gallons_remaining,
        [station["place_id"] for station in stations[:AUTO_DIVERT_MAX_ROUTED_CANDIDATES]],
        resume_destination_place_id or destination_place_id,
        fuel_gallons_remaining * mpg
    )


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
# drive/gas-price-upload job that forward-geocodes - two independent
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

    #
    # The full raw result rides along last - its OSM class/type is what
    # tells a real fuel station apart from, say, the town a "gas station
    # near X" search fell back to (see is_fuel_station_match()).
    #
    return (location.latitude, location.longitude, location.address, location.raw.get("address", {}), location.raw)


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
# since callers like _drive_vehicle_to() need real coordinates for road_route()
# regardless of the id.
#
def find_or_create_place(cur, description):

    saved = find_saved_place(cur, description)

    if saved is not None:
        return saved

    return create_place_from_geocode(cur, description, geocode_full(description))


#
# A description (or Nominatim address) that's already been saved needs no
# fresh geocode at all - checked first, before geocode_full(), since each
# Nominatim call costs at least a second behind geocode_throttle_gate() and
# the dedup-by-coordinates check in create_place_from_geocode() can only
# run after paying that cost. Returns (place_id, lat, lng) or None.
#
def find_saved_place(cur, description):

    cur.execute(
        """
        SELECT id, lat, lng FROM places
        WHERE LOWER(TRIM(description)) = LOWER(TRIM(%s))
        OR LOWER(TRIM(address)) = LOWER(TRIM(%s))
        ORDER BY id
        LIMIT 1
        """,
        (description, description)
    )

    saved = cur.fetchone()

    return (saved[0], saved[1], saved[2]) if saved is not None else None


#
# The second half of find_or_create_place(), taking an already-made
# geocode_full() result - split out so upsert_gas_price() can inspect that
# result before deciding to save it, without geocoding twice.
#
def create_place_from_geocode(cur, description, geocoded):

    lat, lng, address, raw_address, _ = geocoded

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
# The city-search-upload equivalent of find_or_create_place_by_coords() - a
# station found via find_gas_stations_in_city() already has real coordinates
# and OSM tags (name/brand/address), so this skips the forward-geocode step
# too, but unlike a plain road-diversion point it builds a proper
# human-readable description from those tags (falling back to the reverse
# geocode's address only when OSM tagged nothing useful) instead of the
# generic "En route near X" label.
#
def find_or_create_place_from_osm_station(cur, lat, lng, tags):

    lat = round_coord(lat)
    lng = round_coord(lng)

    cur.execute("SELECT id FROM places WHERE lat = %s AND lng = %s", (lat, lng))

    existing = cur.fetchone()

    if existing is not None:
        return existing[0]

    geocode_throttle_gate()
    location = reverse_geocode_limited((lat, lng), zoom=18, language="en")

    raw_address = location.raw.get("address", {}) if location is not None else {}
    continent, country, state, city = extract_address_components(raw_address)

    name = tags.get("name") or tags.get("brand")
    housenumber = tags.get("addr:housenumber")
    street = tags.get("addr:street")
    street_address = f"{housenumber} {street}".strip() if street else None
    tag_city = tags.get("addr:city") or city

    label_parts = [part for part in (name, street_address or street, tag_city) if part]
    description = ", ".join(dict.fromkeys(label_parts)) if label_parts else (
        location.address if location is not None else "Fuel station"
    )
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
# Nominatim (geocode_full()/find_or_create_place()) is a geocoder, not a POI
# search engine - a free-text query like "gas station in Minneapolis, MN"
# mostly only matches OSM entries whose indexed name literally contains
# those words, so real brand-named stations ("Kwik Trip", "Shell") rarely
# surface. Overpass is OSM's actual POI query service: given a bounding
# box, it returns every node/way tagged amenity=fuel inside it, tags
# (brand/name/addr:*) included - the only way to reliably find "the gas
# stations in this city" rather than "the one thing indexed as literally
# matching this text". A separate, lower-traffic throttle gate (rather than
# reusing geocode_throttle_gate()) keeps this polite to the public Overpass
# instance without slowing down unrelated Nominatim calls that happen to
# run in the same job.
#
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

_overpass_throttle_lock = threading.Lock()
_last_overpass_call_monotonic = [0.0]


def _overpass_throttle_gate():

    with _overpass_throttle_lock:

        wait_seconds = 2.0 - (time.monotonic() - _last_overpass_call_monotonic[0])

        if wait_seconds > 0:
            time.sleep(wait_seconds)

        _last_overpass_call_monotonic[0] = time.monotonic()


#
# The public Overpass instance is shared/free and intermittently returns a
# 502/503/504 or just times out under load, with no relation to whether the
# query itself was fine - retrying after a short wait usually goes through.
# A bulk city-search upload can be hundreds of rows, so without this, one
# transient blip costs a whole row (and, worse, is easy to mistake for a
# real "no stations here" or a bug rather than "try again"). Uses the same
# max_retries=3 shape as geocode_limited's own RateLimiter for consistency,
# with the throttle gate re-armed before every attempt (including retries)
# so a retry burst can't itself look like the kind of hammering that got
# the 503/504 in the first place.
#
def _query_overpass(query):

    last_error = None

    for attempt in range(3):

        _overpass_throttle_gate()

        try:
            response = requests.post(
                OVERPASS_URL,
                data={"data": query},
                headers={"User-Agent": "logisim-vehicle-sim"},
                timeout=30
            )
            response.raise_for_status()
            return response.json()

        except requests.exceptions.Timeout as e:
            last_error = e

        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code in (429, 502, 503, 504):
                last_error = e
            else:
                raise

        if attempt < 2:
            time.sleep(2.0 * (attempt + 1))

    raise HTTPException(
        status_code=502,
        detail=f"Overpass API unavailable after retries: {last_error}"
    )


def find_gas_stations_in_city(city_text):

    geocode_throttle_gate()
    location = geocode_limited(city_text, addressdetails=True)

    if location is None:
        raise HTTPException(status_code=400, detail=f"Could not geocode city: {city_text}")

    bbox = location.raw.get("boundingbox")

    if not bbox:
        raise HTTPException(status_code=400, detail=f"No bounding box available for city: {city_text}")

    south, north, west, east = (float(value) for value in bbox)

    query = (
        "[out:json][timeout:25];"
        "("
        f'node["amenity"="fuel"]({south},{west},{north},{east});'
        f'way["amenity"="fuel"]({south},{west},{north},{east});'
        ");"
        "out center tags;"
    )

    data = _query_overpass(query)

    stations = []

    for element in data.get("elements", []):

        if "lat" in element and "lon" in element:
            station_lat, station_lng = element["lat"], element["lon"]
        elif "center" in element:
            station_lat, station_lng = element["center"]["lat"], element["center"]["lon"]
        else:
            continue

        stations.append({"lat": station_lat, "lng": station_lng, "tags": element.get("tags", {})})

    return stations


#
# Reverse-geocoding nearby coordinates at city zoom always means the
# same city, so caching by (coarsely rounded lat, lng) avoids
# re-hitting Nominatim's rate-limited endpoint on every poll of the same
# driving vehicle's live position (vehicle_city() below is the only
# remaining caller - a settled vehicle/path's location comes from its
# saved place row instead, see find_or_create_place()).
#
#
# Keyed far coarser than ROUND_DECIMALS (~1km instead of ~1m) - a driving
# vehicle's position is new on every 7s poll, so a ~1m key almost never
# hit and every poll cost a Nominatim call through the same
# geocode_throttle_gate() a drive job's forward geocodes wait on.
# reverse_geocode() only asks for a city (zoom=10), which a ~1km cell
# can't meaningfully change.
#
REVERSE_GEOCODE_CACHE_DECIMALS = 2

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

#
# How long a stretch of route a vehicle's map heading is taken across
# (derive_position()).
#
HEADING_SPAN_MILES = 0.6


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
#
# The widest either qualifying distance goes, used to pad the bounding box
# below - a station further than this from every candidate point can't
# possibly qualify either way, so there's no need to even fetch it from the
# DB or run it through the (much more expensive) per-point route scan.
#
GAS_STATION_CANDIDATE_PAD_MILES = max(MAX_GAS_STATION_DETOUR_MILES, NEARBY_GAS_STATION_MILES)

#
# Degrees-per-mile for latitude is constant (~69); longitude shrinks toward
# the poles (69 * cos(latitude)), so a fixed, deliberately conservative
# divisor (~30, valid up to roughly 64 degrees of latitude) over-pads
# rather than under-pads at high latitudes - this box only needs to be a
# cheap, inclusive pre-filter, not an exact one, since the real haversine
# checks below still apply on top of it.
#
def _bounding_box_with_pad(points, pad_miles):

    lats = [lat for lat, _ in points]
    lngs = [lng for _, lng in points]

    return (
        min(lats) - pad_miles / 69.0, max(lats) + pad_miles / 69.0,
        min(lngs) - pad_miles / 30.0, max(lngs) + pad_miles / 30.0
    )


#
# Downsamples to an even stride rather than truncating, so a long route's
# far end still gets some coverage instead of only ever checking its first
# max_points miles.
#
def _downsample_points(points, max_points):

    if len(points) <= max_points:
        return points

    step = len(points) / max_points

    return [points[int(i * step)] for i in range(max_points)]


def find_gas_station_options(cur, route, distances_miles, current_distance_miles, max_reachable_miles=None):

    current_lat, current_lng = interpolate_position_at_distance(route, distances_miles, current_distance_miles)

    ahead_start_index = bisect.bisect_left(distances_miles, current_distance_miles)
    ahead_route = route[ahead_start_index:]

    #
    # A bulk-uploaded gas_prices table can be tens of thousands of rows
    # nationwide - fetching all of them and running every one through the
    # per-point nearest-gap scan below (O(stations x route points)) is what
    # actually made this endpoint slow enough to block the 3-second poll
    # that calls it. Filtering in SQL to a bounding box around the
    # remaining route (or just the current point, if there's no route left)
    # cuts the candidate set down to stations that could plausibly qualify
    # before any of that per-point work happens.
    #
    min_lat, max_lat, min_lng, max_lng = _bounding_box_with_pad(
        ahead_route if ahead_route else [(current_lat, current_lng)],
        GAS_STATION_CANDIDATE_PAD_MILES
    )

    #
    # Filtered against the in-memory station cache (get_cached_gas_stations())
    # rather than a per-call SQL query - this runs on every poll for a low
    # vehicle once auto-refuel is on, and the bbox check is a cheap linear
    # pass compared to a DB round-trip each time.
    #
    stations = [
        (row["place_id"], row["description"], row["lat"], row["lng"], row["price_per_gallon"], row["brand"])
        for row in get_cached_gas_stations(cur)
        if min_lat <= row["lat"] <= max_lat and min_lng <= row["lng"] <= max_lng
    ]

    if not stations:
        return []

    #
    # Bounds the remaining worst case too - a long-haul route can still
    # have thousands of geometry points even after the bbox filter thins
    # the station side down, so this caps the other half of the product.
    # 500 points is more than enough resolution for a 15-mile detour
    # threshold; this only decides "is some station roughly on the way",
    # not turn-by-turn navigation.
    #
    nearest_gap_route = _downsample_points(ahead_route, 500) if ahead_route else []

    options = []

    for place_id, description, lat, lng, price_per_gallon, brand in stations:

        distance_from_vehicle_miles = haversine_miles(current_lat, current_lng, lat, lng)

        #
        # A station "ahead on the remaining route" can still be arbitrarily
        # far *along* that route - MAX_GAS_STATION_DETOUR_MILES only bounds
        # how far it is from the road, not how many miles of driving away it
        # is. Without this, a vehicle could be offered (and could pick) a
        # station beyond its own current range and run dry trying to reach
        # the very station meant to rescue it - which is exactly what
        # happened before this check existed. distance_from_vehicle_miles is
        # straight-line, not the real road distance (which is always >=
        # it), so a margin here errs toward excluding a station that's only
        # marginally reachable rather than accepting one that isn't.
        #
        if max_reachable_miles is not None and distance_from_vehicle_miles > max_reachable_miles * 0.8:
            continue

        ahead = False

        if nearest_gap_route:

            nearest_gap_miles = min(
                haversine_miles(lat, lng, point_lat, point_lng)
                for point_lat, point_lng in nearest_gap_route
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

    stations = [
        (row["place_id"], row["description"], row["lat"], row["lng"], row["price_per_gallon"], row["brand"])
        for row in get_cached_gas_stations(cur)
    ]

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

    #
    # Which way it's going: the route a little behind and ahead of it
    # (HEADING_SPAN_MILES across), so the map can turn its icon - spanning a
    # stretch rather than the one segment it's on smooths out tiny zigzags
    # in the road geometry.
    #
    heading_from_miles = max(0.0, progress["distance_miles"] - HEADING_SPAN_MILES / 2)
    heading_to_miles = min(distances_miles[-1], heading_from_miles + HEADING_SPAN_MILES)

    heading = [
        interpolate_position_at_distance(route, distances_miles, heading_from_miles),
        interpolate_position_at_distance(route, distances_miles, heading_to_miles)
    ]

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

        "heading": heading,

        "status": progress["status"],

        "remaining_sim_seconds": progress["remaining_sim_seconds"],

        "speed_mph": speed_mph,

        "road_name": road_name,

        "distance_miles": progress["distance_miles"],

        "fuel_gallons_remaining": progress["fuel_gallons_remaining"],

        #
        # distances_miles[-1] is the path's total length (cumulative miles
        # at its last point - see the `paths` table comment), fixed
        # regardless of status; subtracting how far progress["distance_miles"]
        # says the trip has actually gotten gives "how much road is left",
        # whether that's still closing (DRIVING), frozen wherever the tank
        # ran dry (STRANDED - useful context for how close it was), or 0
        # (ARRIVED).
        #
        "remaining_miles": max(0.0, distances_miles[-1] - progress["distance_miles"])
    }


def reverse_geocode(position):

    cache_key = (
        round(position[0], REVERSE_GEOCODE_CACHE_DECIMALS),
        round(position[1], REVERSE_GEOCODE_CACHE_DECIMALS)
    )

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
# Every unhandled exception becomes a generic JSON 500 - the real traceback
# goes only to the container logs, never to the browser.
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
# No CORS: the page and the API share one origin (nginx passes /api/ on to
# this container), so other websites a browser visits can't read the API.
#


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

    #
    # The per-vehicle opt-in toggle for gas-station-ahead polling didn't
    # last - replaced by a single "divert to nearest" button that looks up
    # a station on demand instead of continuously polling for one, so
    # there's no "watching" state left to opt in or out of.
    #
    cur.execute("ALTER TABLE vehicles DROP COLUMN IF EXISTS gas_station_watch_enabled")

    #
    # Auto-refuel support - additive, safe against both a pre-existing DB and
    # a fresh one (where init.sql already created them). See
    # maybe_auto_divert_to_gas_station().
    #
    cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_refuel_level INTEGER NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS auto_divert_claimed_at TIMESTAMP")

    #
    # Trip meter continuity across gas-station detours - see
    # start_diversion_trip().
    #
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_meter_offset_miles DOUBLE PRECISION NOT NULL DEFAULT 0")

    #
    # Save files (see the `save_slots` table). Whatever world already exists
    # - its settings row and every vehicle - becomes File 1, so nothing in
    # play is lost; Files 2-4 start empty. settings goes from one fixed row
    # (id = 1) to one row per file, keyed by the file's id.
    #
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS save_slots (
            id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 4),
            name TEXT NOT NULL,
            created TIMESTAMP DEFAULT NOW()
        )
        """
    )

    cur.execute(
        """
        INSERT INTO save_slots (id, name)
        SELECT 1, 'Player 1'
        WHERE EXISTS (SELECT 1 FROM settings) OR EXISTS (SELECT 1 FROM vehicles)
        ON CONFLICT (id) DO NOTHING
        """
    )

    #
    # Every started file needs its settings row - settle_arrived_vehicles()
    # joins on it, so a vehicle in a file without one would never settle.
    #
    cur.execute(
        """
        INSERT INTO settings (id, time_multiplier, anchor_real_utc, anchor_game_time)
        SELECT ss.id, %s, %s, %s FROM save_slots ss
        ON CONFLICT (id) DO NOTHING
        """,
        (DEFAULT_TIME_MULTIPLIER, datetime.utcnow(), local_now_naive())
    )

    cur.execute("ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_single_row")
    cur.execute("ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_id_fkey")
    cur.execute(
        "ALTER TABLE settings ADD CONSTRAINT settings_id_fkey "
        "FOREIGN KEY (id) REFERENCES save_slots(id) ON DELETE CASCADE"
    )

    cur.execute("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS slot_id INTEGER")
    cur.execute("UPDATE vehicles SET slot_id = 1 WHERE slot_id IS NULL")
    cur.execute("ALTER TABLE vehicles ALTER COLUMN slot_id SET NOT NULL")
    cur.execute("ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_slot_id_fkey")
    cur.execute(
        "ALTER TABLE vehicles ADD CONSTRAINT vehicles_slot_id_fkey "
        "FOREIGN KEY (slot_id) REFERENCES save_slots(id) ON DELETE CASCADE"
    )

    #
    # Money (Gold Doubloons) - see record_money(). Every file, existing ones
    # included, starts with STARTING_BALANCE; vehicles' current tanks count
    # as free (cost 0/gal), like a brand-new vehicle's.
    #
    cur.execute(f"ALTER TABLE save_slots ADD COLUMN IF NOT EXISTS balance NUMERIC(14, 2) NOT NULL DEFAULT {STARTING_BALANCE}")
    cur.execute("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_cost_per_gallon DOUBLE PRECISION NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS fuel_value_dollars DOUBLE PRECISION NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS carried_fuel_cost DOUBLE PRECISION NOT NULL DEFAULT 0")

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS ledger (
            id SERIAL PRIMARY KEY,
            slot_id INTEGER NOT NULL REFERENCES save_slots(id) ON DELETE CASCADE,
            amount NUMERIC(14, 2) NOT NULL,
            kind TEXT NOT NULL,
            description TEXT NOT NULL,
            vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
            created TIMESTAMP DEFAULT NOW()
        )
        """
    )

    #
    # Budget page columns (see record_money()). Rows written before these
    # existed get their running balance rebuilt from the amounts - every
    # file started at STARTING_BALANCE and only ever changed through the
    # ledger - and their vehicle's current name where it still exists.
    #
    for column, column_type in (
        ("vehicle_name", "TEXT"), ("location", "TEXT"), ("trip", "TEXT"), ("balance_after", "NUMERIC(14, 2)")
    ):
        cur.execute(f"ALTER TABLE ledger ADD COLUMN IF NOT EXISTS {column} {column_type}")

    cur.execute(
        f"""
        UPDATE ledger l
        SET balance_after = running.balance_after
        FROM (
            SELECT id, {STARTING_BALANCE} + SUM(amount) OVER (PARTITION BY slot_id ORDER BY id) AS balance_after
            FROM ledger
        ) running
        WHERE running.id = l.id AND l.balance_after IS NULL
        """
    )

    cur.execute(
        """
        UPDATE ledger l SET vehicle_name = v.name
        FROM vehicles v
        WHERE v.id = l.vehicle_id AND l.vehicle_name IS NULL
        """
    )

    backfill_old_ledger_locations(cur)

    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS journey_origin TEXT")

    #
    # The Budget page's trip filter - see trips.journey_id. Existing trips
    # each count as their own journey.
    #
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS journey_id INTEGER")
    cur.execute("UPDATE trips SET journey_id = id WHERE journey_id IS NULL")
    cur.execute("ALTER TABLE ledger ADD COLUMN IF NOT EXISTS journey_id INTEGER")

    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS journey_route_before JSONB NOT NULL DEFAULT '[]'")

    #
    # Engine specs (see ENGINE_COLUMNS) - nullable, so existing models just
    # have none until someone fills them in. The starter van gets its own.
    #
    cur.execute("ALTER TABLE vehicle_models ADD COLUMN IF NOT EXISTS engine_liters DOUBLE PRECISION")
    cur.execute("ALTER TABLE vehicle_models ADD COLUMN IF NOT EXISTS engine_cylinders INTEGER")
    cur.execute("ALTER TABLE vehicle_models ADD COLUMN IF NOT EXISTS engine_turbo BOOLEAN")
    cur.execute("ALTER TABLE vehicle_models ADD COLUMN IF NOT EXISTS fuel_type TEXT")
    cur.execute("ALTER TABLE vehicle_models ADD COLUMN IF NOT EXISTS transmission TEXT")
    cur.execute("ALTER TABLE vehicle_models ADD COLUMN IF NOT EXISTS tire_count INTEGER")
    cur.execute("ALTER TABLE vehicle_models ADD COLUMN IF NOT EXISTS icon_front TEXT NOT NULL DEFAULT 'left'")

    #
    # Buying and selling (create_vehicle(), sell_vehicle()). Vehicles from
    # before were free, so they refund nothing; their list price is their
    # model's price now. Jobs learn their vehicle (create_job()).
    #
    cur.execute("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(14,2) NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS list_price NUMERIC(14,2)")
    cur.execute(
        """
        UPDATE vehicles v SET list_price = vm.cost
        FROM vehicle_models vm
        WHERE vm.id = v.vehicle_model_id AND v.list_price IS NULL
        """
    )
    cur.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS vehicle_id INTEGER")

    #
    # The load board (see LOAD_CARGO and generate_loads()).
    #
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS loads (
            id SERIAL PRIMARY KEY,
            slot_id INTEGER NOT NULL REFERENCES save_slots(id) ON DELETE CASCADE,
            cargo TEXT NOT NULL,
            kind TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            origin_name TEXT NOT NULL,
            origin_state TEXT NOT NULL,
            origin_lat DOUBLE PRECISION NOT NULL,
            origin_lng DOUBLE PRECISION NOT NULL,
            destination_name TEXT NOT NULL,
            destination_state TEXT NOT NULL,
            destination_lat DOUBLE PRECISION NOT NULL,
            destination_lng DOUBLE PRECISION NOT NULL,
            estimated_miles DOUBLE PRECISION NOT NULL,
            pay NUMERIC(14,2) NOT NULL,
            posted_game_time TIMESTAMP NOT NULL,
            expires_game_time TIMESTAMP NOT NULL,
            status TEXT NOT NULL DEFAULT 'available',
            vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
            accepted_game_time TIMESTAMP,
            deliver_by_game_time TIMESTAMP,
            picked_up_game_time TIMESTAMP,
            delivered_game_time TIMESTAMP,
            pickup_place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
            dropoff_place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
            paid NUMERIC(14,2),
            created TIMESTAMP DEFAULT NOW()
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS loads_slot_status ON loads (slot_id, status)")
    cur.execute("CREATE INDEX IF NOT EXISTS loads_vehicle ON loads (vehicle_id)")

    cur.execute(
        """
        UPDATE vehicle_models SET tire_count = %s
        WHERE year = %s AND LOWER(brand) = LOWER(%s) AND LOWER(model) = LOWER(%s) AND tire_count IS NULL
        """,
        (
            STARTER_VEHICLE_MODEL["tire_count"],
            STARTER_VEHICLE_MODEL["year"], STARTER_VEHICLE_MODEL["brand"], STARTER_VEHICLE_MODEL["model"]
        )
    )

    cur.execute(
        """
        UPDATE vehicle_models
        SET engine_liters = %s, engine_cylinders = %s, engine_turbo = %s, fuel_type = %s, transmission = %s
        WHERE year = %s AND LOWER(brand) = LOWER(%s) AND LOWER(model) = LOWER(%s)
        AND engine_liters IS NULL AND engine_cylinders IS NULL AND engine_turbo IS NULL
        AND fuel_type IS NULL AND transmission IS NULL
        """,
        (
            STARTER_VEHICLE_MODEL["engine_liters"], STARTER_VEHICLE_MODEL["engine_cylinders"],
            STARTER_VEHICLE_MODEL["engine_turbo"], STARTER_VEHICLE_MODEL["fuel_type"],
            STARTER_VEHICLE_MODEL["transmission"],
            STARTER_VEHICLE_MODEL["year"], STARTER_VEHICLE_MODEL["brand"], STARTER_VEHICLE_MODEL["model"]
        )
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS vehicle_model_images (
            vehicle_model_id INTEGER PRIMARY KEY REFERENCES vehicle_models(id) ON DELETE CASCADE,
            content_type TEXT NOT NULL,
            data BYTEA NOT NULL,
            sha256 TEXT NOT NULL,
            updated TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS global_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS vehicle_model_icons (
            vehicle_model_id INTEGER PRIMARY KEY REFERENCES vehicle_models(id) ON DELETE CASCADE,
            content_type TEXT NOT NULL,
            data BYTEA NOT NULL,
            sha256 TEXT NOT NULL,
            updated TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """
    )

    cur.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS slot_id INTEGER")
    cur.execute("ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_slot_id_fkey")
    cur.execute(
        "ALTER TABLE jobs ADD CONSTRAINT jobs_slot_id_fkey "
        "FOREIGN KEY (slot_id) REFERENCES save_slots(id) ON DELETE CASCADE"
    )

    #
    # Paths are ephemeral now - one only exists while a trip is driving it
    # (see forget_unused_paths()). A trip keeps its own copy of the path's
    # length so the odometer outlives the path, and deleting a path nulls
    # out a settled trip's path_id instead of cascading the trip (and its
    # mileage) away with it.
    #
    cur.execute("ALTER TABLE trips ADD COLUMN IF NOT EXISTS distance_miles DOUBLE PRECISION")

    cur.execute(
        """
        UPDATE trips t
        SET distance_miles = (p.distances_miles ->> -1)::double precision
        FROM paths p
        WHERE p.id = t.path_id
        AND t.distance_miles IS NULL
        """
    )

    cur.execute("ALTER TABLE trips ALTER COLUMN path_id DROP NOT NULL")
    cur.execute("ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_path_id_fkey")
    cur.execute(
        "ALTER TABLE trips ADD CONSTRAINT trips_path_id_fkey "
        "FOREIGN KEY (path_id) REFERENCES paths(id) ON DELETE SET NULL"
    )

    #
    # Startup is the one moment nothing can be mid-way through creating a
    # path for a trip (job_executor is brand new), so it's safe to sweep
    # every path here - including all the saved ones from before paths
    # became ephemeral.
    #
    forget_unused_paths(cur)

    #
    # Same for places (see forget_unused_places()) - a finished detour
    # trip's resume_destination_place_id is history, not a live reference,
    # so it's nulled out like a settled trip's path_id instead of blocking
    # the place from ever being forgotten.
    #
    cur.execute("ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_resume_destination_place_id_fkey")
    cur.execute(
        "ALTER TABLE trips ADD CONSTRAINT trips_resume_destination_place_id_fkey "
        "FOREIGN KEY (resume_destination_place_id) REFERENCES places(id) ON DELETE SET NULL"
    )

    forget_unused_places(cur)

    #
    # The starter van's vehicle model is always in the database (see
    # STARTER_VEHICLE_MODEL).
    #
    ensure_starter_vehicle_model(cur)

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
# even a single drive to a new destination can take well past what a client is willing
# to wait on one HTTP request. Both run their real work in this pool
# instead, tracked via the jobs table, and hand the request back a job id
# to poll (GET /api/jobs/{id}) rather than blocking on the result.
#
JOB_EXECUTOR_MAX_WORKERS = 4

job_executor = ThreadPoolExecutor(max_workers=JOB_EXECUTOR_MAX_WORKERS)


#
# Settles trips every SETTLE_TICK_SECONDS whether or not anyone's polling,
# so arrivals and the auto-refuel check keep pace with the game clock even
# with the UI closed or throttled in a background tab. Request handlers
# still settle too (they need an up-to-date view before answering); the
# claim on auto_divert_claimed_at and the conditional arrival UPDATE in
# settle_arrived_vehicles() make the overlap harmless.
#
def _settle_ticker():

    while True:

        time.sleep(SETTLE_TICK_SECONDS)

        try:

            conn = db()

            try:
                cur = conn.cursor()
                settle_arrived_vehicles(conn, cur)
                cur.close()
            finally:
                conn.close()

        except Exception:
            logger.exception("Background settle failed")


@app.on_event("startup")
def start_settle_ticker():

    threading.Thread(target=_settle_ticker, name="settle-ticker", daemon=True).start()


#
# With cur, the job row is inserted on the caller's own transaction instead
# of committed on its own - so it becomes visible in the very same commit as
# whatever made it necessary (see settle_arrived_vehicles()). The caller
# commits, then submits to job_executor.
#
#
# slot_id ties a vehicle job to its save file (see jobs.slot_id); None for a
# shared-world job every file's Background Jobs tab shows.
#
#
# vehicle_id: the vehicle a trip-starting job is about to put on the road,
# so it reads as busy (vehicle_is_busy()) before its trip row exists.
#
def create_job(job_type, total=0, cur=None, slot_id=None, vehicle_id=None):

    if cur is not None:

        cur.execute(
            "INSERT INTO jobs (job_type, progress_total, slot_id, vehicle_id) VALUES (%s, %s, %s, %s) RETURNING id",
            (job_type, total, slot_id, vehicle_id)
        )

        return cur.fetchone()[0]

    conn = db()
    cur = conn.cursor()

    cur.execute(
        "INSERT INTO jobs (job_type, progress_total, slot_id, vehicle_id) VALUES (%s, %s, %s, %s) RETURNING id",
        (job_type, total, slot_id, vehicle_id)
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
def list_jobs(slot: int = Depends(current_slot), _admin: None = Depends(require_admin)):

    conn = db()
    cur = conn.cursor()

    #
    # The counts stay pool-wide - every save file shares job_executor's
    # workers, so "running"/"queued" describe the whole pool - but the list
    # is this file's own jobs plus shared-world ones (slot_id NULL: gas
    # price uploads, place backfill).
    #
    cur.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status")
    counts = dict(cur.fetchall())

    cur.execute(
        """
        SELECT id, job_type, status, progress_current, progress_total, error, created, updated
        FROM jobs
        WHERE slot_id = %s OR slot_id IS NULL
        ORDER BY created DESC
        LIMIT 50
        """,
        (slot,)
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

        "fuel_tank_gallons": row[9],

        #
        # Where the picture is: an uploaded one (vehicle_model_images, see
        # normalize_vehicle_image()) wins, versioned by its hash so browsers
        # can cache it forever; otherwise a built-in file under
        # frontend/images/ - a path relative to the page either way.
        #
        "image_url": (
            f"api/vehicle-models/{row[0]}/image?v={row[10][:12]}" if row[10]
            else f"images/{quote(row[8])}" if row[8]
            else None
        ),

        "has_uploaded_image": row[10] is not None,

        "engine_liters": row[11],

        "engine_cylinders": row[12],

        "engine_turbo": row[13],

        "fuel_type": row[14],

        "transmission": row[15],

        #
        # The map marker for this model's driving vehicles (made with the
        # Vehicle Models editor's Create icon), versioned like image_url.
        # None means the view's normal marker.
        #
        "icon_url": f"api/vehicle-models/{row[0]}/icon?v={row[16][:12]}" if row[16] else None,

        "tire_count": row[17],

        #
        # Which way the vehicle's front points in its map icon ("left" or
        # "right") - so the map can face it the way it's driving (flipped
        # for the other way, tilted for north/south).
        #
        "icon_front": row[18]
    }


VEHICLE_MODEL_COLUMNS = """
    id, year, brand, model, person_capacity, cargo_capacity_cuft, cost, mpg, image, fuel_tank_gallons,
    (SELECT i.sha256 FROM vehicle_model_images i WHERE i.vehicle_model_id = vehicle_models.id),
    engine_liters, engine_cylinders, engine_turbo, fuel_type, transmission,
    (SELECT c.sha256 FROM vehicle_model_icons c WHERE c.vehicle_model_id = vehicle_models.id),
    tire_count, icon_front
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


#
# In-memory cache of every priced gas station (gas_prices joined to its
# place), shared by GET /api/gas-prices, find_gas_station_options() and
# find_closest_gas_station(). The station set only changes when a price is
# added/updated/deleted or a place is deleted, but it's read far more often
# than that - find_gas_station_options() runs on every poll for each low
# vehicle once auto-refuel is on, and a page load pulls the whole list -
# so re-querying it each time was pure repeated work.
#
# Invalidation is explicit: every write path calls
# invalidate_gas_station_cache() *after* its commit, which bumps
# _gas_station_cache_version. A load records the version it started under
# and is only stored if nothing invalidated it mid-load, so a read racing a
# write can never cache the pre-write rows under the post-write version.
# This is a single uvicorn process (see backend/Dockerfile), so in-process
# state is shared by every request and job_executor thread. If it ever runs
# multiple workers, each keeps its own cache and only sees its own
# invalidations - GAS_STATION_CACHE_TTL_SECONDS bounds how stale another
# worker's (or a manual psql edit's) change can look.
#
GAS_STATION_CACHE_TTL_SECONDS = 300

_gas_station_cache_lock = threading.Lock()
_gas_station_cache_version = [0]
_gas_station_cache = {"version": None, "loaded_monotonic": 0.0, "rows": None}

#
# Part of every ETag so a backend restart (version counter back to 0) can't
# match an ETag a browser cached from the previous process.
#
_gas_station_cache_instance = uuid.uuid4().hex[:8]


def invalidate_gas_station_cache():

    with _gas_station_cache_lock:
        _gas_station_cache_version[0] += 1


def gas_station_cache_etag():

    with _gas_station_cache_lock:
        return f'"gas-{_gas_station_cache_instance}-{_gas_station_cache_version[0]}"'


#
# Returns gas_price_dict()-shaped rows, newest update first (the order GET
# /api/gas-prices has always returned). Callers must treat them as
# read-only - they're shared with every other caller until invalidated.
#
def get_cached_gas_stations(cur):

    with _gas_station_cache_lock:

        version = _gas_station_cache_version[0]

        fresh = (
            _gas_station_cache["version"] == version
            and time.monotonic() - _gas_station_cache["loaded_monotonic"] < GAS_STATION_CACHE_TTL_SECONDS
        )

        if fresh:
            return _gas_station_cache["rows"]

    cur.execute(
        f"SELECT {GAS_PRICE_COLUMNS} FROM gas_prices g JOIN places p ON p.id = g.place_id ORDER BY g.updated DESC"
    )

    rows = [gas_price_dict(row) for row in cur.fetchall()]

    with _gas_station_cache_lock:

        if _gas_station_cache_version[0] == version:
            _gas_station_cache.update(version=version, loaded_monotonic=time.monotonic(), rows=rows)

    return rows


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
    # user happens to type (e.g. "1978 Ford Econoline 1").
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

    #
    # Both optional so either can be changed on its own - only
    # time_multiplier is locked while vehicles are in route (see
    # update_settings()); auto_refuel_level can be flipped any time.
    #
    time_multiplier: Optional[float] = None
    auto_refuel_level: Optional[int] = None



#
# A vehicle model's engine: displacement (kept in liters - the editor
# converts to and from cubic inches), cylinder count, turbo, fuel type and
# transmission. All optional, so models from before these existed (and CSVs
# without the columns) still work. Fuel type is recorded only for now; it's
# kept to these exact values so it can drive refueling (diesel prices)
# later.
#
ENGINE_CYLINDER_COUNTS = (3, 4, 5, 6, 8, 10, 12)
ENGINE_LITERS_RANGE = (0.5, 20.0)
FUEL_TYPES = ("gasoline", "diesel")
TRANSMISSIONS = ("manual", "automatic")

ENGINE_COLUMNS = ("engine_liters", "engine_cylinders", "engine_turbo", "fuel_type", "transmission")

#
# How many tires a model rides on - a van or car, a dually or box truck, up
# to a semi. Optional like the engine specs; together they're SPEC_COLUMNS,
# the optional columns a vehicle model CSV can carry.
#
TIRE_COUNTS = (4, 6, 8, 10, 18)

ICON_FRONTS = ("left", "right")

SPEC_COLUMNS = (*ENGINE_COLUMNS, "tire_count")


def validate_engine(req):

    if req.engine_liters is not None and not ENGINE_LITERS_RANGE[0] <= req.engine_liters <= ENGINE_LITERS_RANGE[1]:
        raise HTTPException(
            status_code=400, detail=f"Engine size must be {ENGINE_LITERS_RANGE[0]}-{ENGINE_LITERS_RANGE[1]} L"
        )

    if req.engine_cylinders is not None and req.engine_cylinders not in ENGINE_CYLINDER_COUNTS:
        raise HTTPException(
            status_code=400, detail=f"Cylinders must be one of {', '.join(map(str, ENGINE_CYLINDER_COUNTS))}"
        )

    if req.fuel_type is not None and req.fuel_type not in FUEL_TYPES:
        raise HTTPException(status_code=400, detail=f"Fuel type must be {' or '.join(FUEL_TYPES)}")

    if req.transmission is not None and req.transmission not in TRANSMISSIONS:
        raise HTTPException(status_code=400, detail=f"Transmission must be {' or '.join(TRANSMISSIONS)}")

    if req.icon_front is not None and req.icon_front not in ICON_FRONTS:
        raise HTTPException(status_code=400, detail="The icon's front must face left or right")

    if req.tire_count is not None and req.tire_count not in TIRE_COUNTS:
        raise HTTPException(status_code=400, detail=f"Tires must be one of {', '.join(map(str, TIRE_COUNTS))}")


#
# A CSV cell for one of SPEC_COLUMNS -> its value (blank -> None).
#
def parse_engine_csv_value(column, text):

    text = text.strip().lower()

    if not text:
        return None

    if column == "engine_liters":
        return float(text)

    if column in ("engine_cylinders", "tire_count"):
        return int(float(text))

    if column == "engine_turbo":
        if text in ("yes", "y", "true", "1"):
            return True
        if text in ("no", "n", "false", "0"):
            return False
        raise ValueError(f"engine_turbo must be yes or no, not {text!r}")

    return text


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
    # Filename under frontend/images/ (e.g. "1978-Ford-Econoline.png"), not a
    # full URL - the frontend is what knows it's serving that directory at
    # its own origin.
    #
    image: Optional[str] = None

    engine_liters: Optional[float] = None
    engine_cylinders: Optional[int] = None
    engine_turbo: Optional[bool] = None
    fuel_type: Optional[str] = None
    transmission: Optional[str] = None
    tire_count: Optional[int] = None
    icon_front: Optional[str] = None



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

    #
    # Set once the user has confirmed a location that isn't recognizably
    # a gas station (see resolve_gas_station_place()) - save the price
    # there anyway.
    #
    confirm_location: bool = False



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



def settings_dict(time_multiplier, game_time, auto_refuel_level, balance):

    return {

        #
        # The file's Gold Doubloons, re-read with every settings refresh so
        # the clock box's balance follows gas bought and refunded.
        #
        "balance": balance,

        "time_multiplier": time_multiplier,

        "auto_refuel_level": auto_refuel_level,

        "auto_refuel_max_level": AUTO_REFUEL_MAX_LEVEL,

        #
        # Naive local wall-clock value (no tzinfo, no UTC offset) - the
        # frontend treats these digits as literal calendar/clock values
        # (parsing/formatting both as UTC) rather than converting through
        # the browser's own timezone. See updateSimClock() in app.js.
        #
        "game_time": game_time.isoformat()
    }



class StartSaveSlotRequest(BaseModel):

    name: str


#
# The file-select screen: all four save files, started or not, with enough
# of each one's state for its file card (name, fleet size, how many are on
# the road, total miles, and where its own game clock is). Not slot-scoped
# itself - it's what a slot gets picked from.
#
class ElevateAdminRequest(BaseModel):
    password: str


@app.post("/api/admin/elevate")
def elevate_admin(req: ElevateAdminRequest):

    if not ADMIN_PASSWORD:
        raise HTTPException(status_code=503, detail="Admin isn't set up here - set ADMIN_PASSWORD in .env")

    if not hmac.compare_digest(req.password.encode(), ADMIN_PASSWORD.encode()):
        time.sleep(ADMIN_WRONG_PASSWORD_DELAY_SECONDS)
        raise HTTPException(status_code=401, detail="Wrong password")

    expires = int(time.time()) + ADMIN_TOKEN_TTL_SECONDS

    return {"token": f"{expires}.{admin_token_signature(expires)}", "expires": expires}


@app.get("/api/admin/status")
def admin_status(x_admin_token: Optional[str] = Header(None)):

    return {"configured": bool(ADMIN_PASSWORD), "admin": is_valid_admin_token(x_admin_token)}


class GlobalSettingsRequest(BaseModel):
    diesel_markup_percent: float


#
# Readable by everyone (it's part of what a fill-up costs); only admins
# change it - from the Gas Prices tab.
#
@app.get("/api/global-settings")
def read_global_settings():

    conn = db()
    cur = conn.cursor()

    try:
        return {key: get_global_setting(cur, key) for key in GLOBAL_SETTING_DEFAULTS}
    finally:
        cur.close()
        conn.close()


@app.put("/api/global-settings")
def update_global_settings(req: GlobalSettingsRequest, _admin: None = Depends(require_admin)):

    low, high = DIESEL_MARKUP_RANGE

    if not low <= req.diesel_markup_percent <= high:
        raise HTTPException(status_code=400, detail=f"The diesel markup must be {low:g}-{high:g}%")

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute(
            """
            INSERT INTO global_settings (key, value) VALUES ('diesel_markup_percent', %s)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            """,
            (str(req.diesel_markup_percent),)
        )

        conn.commit()

        return {key: get_global_setting(cur, key) for key in GLOBAL_SETTING_DEFAULTS}

    finally:
        cur.close()
        conn.close()


@app.get("/api/slots")
def list_save_slots():

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            ss.id, ss.name, ss.created, s.time_multiplier, ss.balance,
            (SELECT COUNT(*) FROM vehicles v WHERE v.slot_id = ss.id AND NOT v.sold),
            (
                SELECT COUNT(DISTINCT t.vehicle_id)
                FROM trips t
                JOIN vehicles v ON v.id = t.vehicle_id
                WHERE v.slot_id = ss.id
                AND t.cancelled_at IS NULL
                AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * s.time_multiplier - t.paused_seconds)
                    < t.realized_duration_seconds
            ),
            (
                SELECT COALESCE(SUM(v.starting_mileage), 0)
                    + COALESCE((
                        SELECT SUM(COALESCE(t.distance_miles, 0))
                        FROM trips t
                        JOIN vehicles v2 ON v2.id = t.vehicle_id
                        WHERE v2.slot_id = ss.id
                        AND NOT v2.sold
                        AND t.cancelled_at IS NULL
                        AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * s.time_multiplier - t.paused_seconds)
                            >= t.realized_duration_seconds
                    ), 0)
                FROM vehicles v
                WHERE v.slot_id = ss.id AND NOT v.sold
            )
        FROM save_slots ss
        JOIN settings s ON s.id = ss.id
        """
    )

    started = {row[0]: row for row in cur.fetchall()}

    slots = []

    for slot_id in range(1, SAVE_SLOT_COUNT + 1):

        row = started.get(slot_id)

        if row is None:
            slots.append({"id": slot_id, "started": False})
            continue

        _, game_time = get_settings(conn, cur, slot_id)

        slots.append({
            "id": slot_id,
            "started": True,
            "name": row[1],
            "created": row[2].replace(tzinfo=ZoneInfo("UTC")) if row[2] else None,
            "time_multiplier": row[3],
            "balance": float(row[4]),
            "vehicles": row[5],
            "driving": row[6],
            "total_miles": float(row[7]),
            "game_time": game_time.isoformat()
        })

    cur.close()
    conn.close()

    return slots


@app.post("/api/slots/{slot_id}")
def start_save_slot(slot_id: int, req: StartSaveSlotRequest, x_admin_token: Optional[str] = Header(None)):

    if not 1 <= slot_id <= SAVE_SLOT_COUNT:
        raise HTTPException(status_code=404, detail="No such save file")

    #
    # Admin is for managing what the files share, not for playing - not 403,
    # which the frontend reads as admin having lapsed (see require_admin()).
    #
    if is_valid_admin_token(x_admin_token):
        raise HTTPException(status_code=409, detail="New games can't be started in admin mode - leave admin first")

    name = req.name.strip()

    if not name:
        raise HTTPException(status_code=400, detail="Enter a name for the file")

    if len(name) > SAVE_SLOT_NAME_MAX_LENGTH:
        raise HTTPException(status_code=400, detail=f"Names can be at most {SAVE_SLOT_NAME_MAX_LENGTH} characters")

    conn = db()
    cur = conn.cursor()

    cur.execute(
        "INSERT INTO save_slots (id, name) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING RETURNING id",
        (slot_id, name)
    )

    created = cur.fetchone() is not None

    if not created:
        conn.rollback()
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail=f"File {slot_id} is already in use - erase it first")

    give_starter_vehicle(cur, slot_id)

    #
    # Commits too (the starter van with it) - a fresh file starts at the
    # default multiplier with its own clock beginning now (see
    # ensure_settings_row()).
    #
    ensure_settings_row(conn, cur, slot_id)

    cur.close()
    conn.close()

    return {"id": slot_id, "name": name}


#
# "Erase file": the save_slots row cascades to the file's settings, vehicles
# and (through them) trips and jobs. The paths those trips were driving and
# the places only those vehicles were sitting at are forgotten the same way
# an arrival forgets them (forget_unused_paths()/forget_unused_places()).
#
@app.delete("/api/slots/{slot_id}")
def erase_save_slot(slot_id: int, _admin: None = Depends(require_admin)):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        "SELECT DISTINCT t.path_id FROM trips t JOIN vehicles v ON v.id = t.vehicle_id WHERE v.slot_id = %s",
        (slot_id,)
    )
    path_ids = [row[0] for row in cur.fetchall()]

    cur.execute("SELECT DISTINCT place_id FROM vehicles WHERE slot_id = %s", (slot_id,))
    place_ids = [row[0] for row in cur.fetchall()]

    cur.execute("DELETE FROM save_slots WHERE id = %s RETURNING id", (slot_id,))

    erased = cur.fetchone() is not None

    if erased:
        forget_unused_paths(cur, path_ids)
        forget_unused_places(cur, place_ids)

    conn.commit()

    cur.close()
    conn.close()

    if not erased:
        raise HTTPException(status_code=404, detail=f"File {slot_id} is already empty")

    return {"erased": slot_id}


#
# The file's money history, newest first - every gas purchase, refund and
# fee (see record_money()).
#
#
# The Budget page's dropdown choices: every vehicle with ledger entries,
# and every trip - one journey (ledger.journey_id), or for entries from
# before journeys had an id, one trip label - with the vehicle it belongs
# to, so the page can narrow the trip list to the chosen vehicle. Newest
# trip first.
#
@app.get("/api/ledger/filters")
def list_ledger_filters(slot: int = Depends(current_slot)):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT DISTINCT vehicle_name FROM ledger
        WHERE slot_id = %s AND vehicle_name IS NOT NULL
        ORDER BY vehicle_name
        """,
        (slot,)
    )

    vehicles = [row[0] for row in cur.fetchall()]

    cur.execute(
        """
        SELECT vehicle_name, journey_id, trip, MIN(created) AS first_at
        FROM ledger
        WHERE slot_id = %s AND trip IS NOT NULL
        GROUP BY vehicle_name, journey_id, trip
        ORDER BY first_at DESC
        """,
        (slot,)
    )

    trips = [
        {
            "key": f"j{row[1]}" if row[1] is not None else f"t{row[2]}",
            "vehicle": row[0],
            "trip": row[2],
            "started": row[3].replace(tzinfo=ZoneInfo("UTC")),
        }
        for row in cur.fetchall()
    ]

    cur.close()
    conn.close()

    return {"vehicles": vehicles, "trips": trips}


#
# trip is a key from /api/ledger/filters: "j<journey id>", or "t<label>"
# for entries from before journeys had an id.
#
def ledger_trip_filter(trip):

    if not trip:
        return None, None

    if trip.startswith("j"):
        try:
            return int(trip[1:]), None
        except ValueError:
            raise HTTPException(status_code=400, detail="Unknown trip")

    return None, trip[1:]


LEDGER_DIRECTIONS = ("both", "in", "out")


@app.get("/api/ledger")
def list_ledger(
    limit: int = 50, before_id: Optional[int] = None, vehicle: Optional[str] = None, trip: Optional[str] = None,
    direction: str = "both", slot: int = Depends(current_slot)
):

    limit = max(1, min(limit, 500))

    #
    # The Budget page's Additions / Subtractions / Both toggle: money in
    # (refunds), money out (charges), or everything.
    #
    if direction not in LEDGER_DIRECTIONS:
        raise HTTPException(status_code=400, detail=f"direction must be one of {', '.join(LEDGER_DIRECTIONS)}")

    journey_id, trip_label = ledger_trip_filter(trip)

    conn = db()
    cur = conn.cursor()

    #
    # before_id pages backwards (the Budget page's "Load older"): entries
    # older than the last one already shown. One extra row is fetched just
    # to know whether there's anything left after this page.
    #
    cur.execute(
        """
        SELECT id, amount, kind, description, created, vehicle_name, location, trip, balance_after
        FROM ledger
        WHERE slot_id = %s
        AND (%s::int IS NULL OR id < %s::int)
        AND (%s::text IS NULL OR vehicle_name = %s::text)
        AND (%s::int IS NULL OR journey_id = %s::int)
        AND (%s::text IS NULL OR (journey_id IS NULL AND trip = %s::text))
        AND (%s = 'both' OR (%s = 'in' AND amount > 0) OR (%s = 'out' AND amount < 0))
        ORDER BY id DESC
        LIMIT %s
        """,
        (
            slot, before_id, before_id, vehicle, vehicle, journey_id, journey_id, trip_label, trip_label,
            direction, direction, direction, limit + 1
        )
    )

    rows = cur.fetchall()

    balance = get_balance(cur, slot)

    cur.close()
    conn.close()

    return {
        "balance": balance,
        "has_more": len(rows) > limit,
        "entries": [
            {
                "id": row[0],
                "amount": float(row[1]),
                "kind": row[2],
                "description": row[3],
                "created": row[4].replace(tzinfo=ZoneInfo("UTC")),
                "vehicle": row[5],
                "location": row[6],
                "trip": row[7],
                "balance_after": float(row[8]) if row[8] is not None else None,
            }
            for row in rows[:limit]
        ]
    }


@app.get("/api/settings")
def read_settings(slot: int = Depends(current_slot)):

    conn = db()
    cur = conn.cursor()

    time_multiplier, game_time = get_settings(conn, cur, slot)
    auto_refuel_level = get_auto_refuel_level(conn, cur, slot)
    balance = get_balance(cur, slot)

    cur.close()
    conn.close()

    return settings_dict(time_multiplier, game_time, auto_refuel_level, balance)



@app.put("/api/settings")
def update_settings(req: UpdateSettingsRequest, slot: int = Depends(current_slot)):

    if req.time_multiplier is not None and req.time_multiplier <= 0:
        raise HTTPException(status_code=400, detail="time_multiplier must be positive")

    if req.auto_refuel_level is not None and not (0 <= req.auto_refuel_level <= AUTO_REFUEL_MAX_LEVEL):
        raise HTTPException(
            status_code=400,
            detail=f"auto_refuel_level must be between 0 and {AUTO_REFUEL_MAX_LEVEL}"
        )

    conn = db()
    cur = conn.cursor()

    if req.auto_refuel_level is not None:
        ensure_settings_row(conn, cur, slot)
        cur.execute("UPDATE settings SET auto_refuel_level = %s WHERE id = %s", (req.auto_refuel_level, slot))
        conn.commit()

    if req.time_multiplier is None:

        time_multiplier, game_time = get_settings(conn, cur, slot)
        auto_refuel_level = get_auto_refuel_level(conn, cur, slot)
        balance = get_balance(cur, slot)

        cur.close()
        conn.close()

        return settings_dict(time_multiplier, game_time, auto_refuel_level, balance)

    #
    # Re-anchor at the game time the OLD multiplier had reached, right
    # before switching - so changing the multiplier speeds up/slows down
    # the clock from here, rather than jumping it to a different value.
    #
    time_multiplier, game_time = get_settings(conn, cur, slot)

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
        JOIN vehicles v ON v.id = t.vehicle_id
        WHERE v.slot_id = %s
        AND t.cancelled_at IS NULL
        AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * %s - t.paused_seconds) < t.realized_duration_seconds
        LIMIT 1
        """,
        (slot, time_multiplier)
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
        WHERE id = %s
        """,
        (req.time_multiplier, datetime.utcnow(), game_time, slot)
    )

    conn.commit()

    auto_refuel_level = get_auto_refuel_level(conn, cur, slot)
    balance = get_balance(cur, slot)

    cur.close()
    conn.close()

    return settings_dict(req.time_multiplier, game_time, auto_refuel_level, balance)



@app.post("/api/vehicles")
def create_vehicle(req: CreateVehicleRequest, slot: int = Depends(current_slot)):

    conn = db()
    cur = conn.cursor()

    vehicle_models_by_id = fetch_vehicle_models_by_id(cur, [req.vehicle_model_id])
    vehicle_model = vehicle_models_by_id.get(req.vehicle_model_id)

    if vehicle_model is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle model not found")

    #
    # Geocoded/resolved up front (same as _drive_vehicle_to()'s
    # destination) so a bad location name fails fast, before the vehicle
    # row is inserted.
    #
    place_id, current_lat, current_lng = find_or_create_place(cur, req.current_location)

    #
    # "<year> <brand> <model> <n>" instead of a user-typed name, e.g.
    # "1978 Ford Econoline 1" then "... 2" for the next one on that same
    # vehicle model. Counts every vehicle ever created on this vehicle model (sold ones
    # included) so numbers stay unique across "My Vehicles" and "All
    # Vehicles" rather than getting reused after a sale - within this save
    # file, so each file's fleet numbers from 1 on its own.
    #
    cur.execute(
        "SELECT COUNT(*) FROM vehicles WHERE vehicle_model_id=%s AND slot_id=%s",
        (req.vehicle_model_id, slot)
    )

    vehicle_number = cur.fetchone()[0] + 1

    name = f"{vehicle_model['year']} {vehicle_model['brand']} {vehicle_model['model']} {vehicle_number}"

    #
    # A brand-new vehicle always starts with a full tank of its vehicle model's
    # capacity - there's no "starting fuel level" input the way
    # starting_mileage has one, since a fresh vehicle joining the fleet is
    # assumed fueled up and ready to go.
    #
    fuel_gallons = vehicle_model["fuel_tank_gallons"]

    #
    # Bought at the model's price, charged now and recorded on the vehicle
    # (purchase_price) - that's what selling it refunds. list_price is the
    # model's price at the time, kept for depreciation later.
    #
    price = float(vehicle_model["cost"])

    cur.execute(
        """
        INSERT INTO vehicles (
            slot_id, name, vehicle_model_id, place_id, starting_mileage, fuel_gallons, purchase_price, list_price
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (slot, name, req.vehicle_model_id, place_id, req.starting_mileage, fuel_gallons, price, price)
    )

    vehicle_id = cur.fetchone()[0]

    record_money(
        cur, slot, -price, "vehicle_purchase", f"Bought {name}",
        vehicle_id, name, fetch_places_by_id(cur, [place_id])[place_id]["description"]
    )

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



def validate_vehicle_model(req):

    if not req.brand.strip() or not req.model.strip():
        raise HTTPException(status_code=400, detail="Brand and model can't be empty")

    if req.mpg <= 0:
        raise HTTPException(status_code=400, detail="mpg must be positive")

    if req.fuel_tank_gallons <= 0:
        raise HTTPException(status_code=400, detail="fuel_tank_gallons must be positive")

    if req.person_capacity < 0 or req.cargo_capacity_cuft < 0 or req.cost < 0:
        raise HTTPException(status_code=400, detail="Capacity and cost can't be negative")

    validate_engine(req)


@app.post("/api/vehicle-models")
def create_vehicle_model(req: CreateVehicleModelRequest, _admin: None = Depends(require_admin)):

    validate_vehicle_model(req)

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        INSERT INTO vehicle_models
        (year, brand, model, person_capacity, cargo_capacity_cuft, cost, mpg, image, fuel_tank_gallons,
         engine_liters, engine_cylinders, engine_turbo, fuel_type, transmission, tire_count, icon_front)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            req.year,
            req.brand.strip(),
            req.model.strip(),
            req.person_capacity,
            req.cargo_capacity_cuft,
            req.cost,
            req.mpg,
            req.image,
            req.fuel_tank_gallons,
            req.engine_liters,
            req.engine_cylinders,
            req.engine_turbo,
            req.fuel_type,
            req.transmission,
            req.tire_count,
            req.icon_front or "left"
        )
    )

    vehicle_model_id = cur.fetchone()[0]

    conn.commit()

    vehicle_model = fetch_vehicle_models_by_id(cur, [vehicle_model_id])[vehicle_model_id]

    cur.close()
    conn.close()

    return vehicle_model


#
# Edits every field of a vehicle model in place (the Vehicle Models page's
# editor). Vehicles already built on it pick the change up straight away -
# they look their model up by id. The starter van keeps its year, brand and
# model, since that's how it's recognized (see STARTER_VEHICLE_MODEL).
#
@app.put("/api/vehicle-models/{id}")
def update_vehicle_model(id: int, req: CreateVehicleModelRequest, _admin: None = Depends(require_admin)):

    validate_vehicle_model(req)

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute("SELECT year, brand, model FROM vehicle_models WHERE id = %s", (id,))

        row = cur.fetchone()

        if row is None:
            raise HTTPException(status_code=404, detail="Vehicle model not found")

        if is_starter_vehicle_model(*row) and not is_starter_vehicle_model(req.year, req.brand, req.model):
            raise HTTPException(
                status_code=409,
                detail="The starter van's year, brand and model can't change - every new file starts with one"
            )

        cur.execute(
            """
            UPDATE vehicle_models
            SET year = %s, brand = %s, model = %s, person_capacity = %s, cargo_capacity_cuft = %s,
                cost = %s, mpg = %s, image = %s, fuel_tank_gallons = %s,
                engine_liters = %s, engine_cylinders = %s, engine_turbo = %s, fuel_type = %s, transmission = %s,
                tire_count = %s, icon_front = COALESCE(%s, icon_front)
            WHERE id = %s
            """,
            (
                req.year, req.brand.strip(), req.model.strip(), req.person_capacity, req.cargo_capacity_cuft,
                req.cost, req.mpg, req.image or None, req.fuel_tank_gallons,
                req.engine_liters, req.engine_cylinders, req.engine_turbo, req.fuel_type, req.transmission,
                req.tire_count, req.icon_front, id
            )
        )

        conn.commit()

        return fetch_vehicle_models_by_id(cur, [id])[id]

    finally:
        cur.close()
        conn.close()


#
# Uploaded and URL-fetched vehicle pictures live in Postgres
# (vehicle_model_images), not on disk: the frontend's nginx serves only
# what was baked into its image, the backend has no volume of its own, and
# this way they're in every database backup and go when their model does.
# Each one is re-encoded here before it's stored - checked to really be an
# image, turned upright, shrunk to fit VEHICLE_IMAGE_MAX_SIDE and saved as
# WebP - so whatever comes in, what's stored is small and safe to serve.
#
VEHICLE_IMAGE_MAX_BYTES = 10 * 1024 * 1024
VEHICLE_IMAGE_MAX_SIDE = 800
VEHICLE_IMAGE_FETCH_TIMEOUT_SECONDS = (5, 20)

#
# Refuses images that would decode to more pixels than this (a tiny file
# can claim to be enormous) instead of Pillow's default warning.
#
Image.MAX_IMAGE_PIXELS = 40_000_000


def normalize_vehicle_image(data, max_side=None):

    max_side = max_side or VEHICLE_IMAGE_MAX_SIDE

    if len(data) > VEHICLE_IMAGE_MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"Images can be at most {VEHICLE_IMAGE_MAX_BYTES // (1024 * 1024)} MB")

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        raise HTTPException(status_code=400, detail="That isn't an image Logisim can read - try a PNG, JPEG, WebP or GIF")

    image = ImageOps.exif_transpose(image)

    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA")

    image.thumbnail((max_side, max_side), Image.LANCZOS)

    out = io.BytesIO()
    image.save(out, "WEBP", quality=85, method=6)

    return out.getvalue()


#
# Only http(s), and never a private, loopback or link-local address - the
# backend makes this request from inside the server's network, so a URL
# mustn't be a way to reach things there. When the host can't be resolved
# here but a proxy is configured, the proxy does the resolving (and its
# own policing), so that's let through.
#
def fetch_vehicle_image_url(url):

    parsed = urlparse(url.strip())

    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Enter an http:// or https:// image URL")

    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(parsed.hostname, None)}
    except socket.gaierror:
        if not (os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")):
            raise HTTPException(status_code=400, detail=f"Couldn't find {parsed.hostname}")
        addresses = set()

    for address in addresses:

        ip = ipaddress.ip_address(address.split("%")[0])

        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise HTTPException(status_code=400, detail="That URL points inside the server's network")

    try:

        with requests.get(
            url.strip(),
            stream=True,
            timeout=VEHICLE_IMAGE_FETCH_TIMEOUT_SECONDS,
            headers={"User-Agent": "Logisim vehicle image fetch"}
        ) as response:

            if response.status_code != 200:
                raise HTTPException(status_code=400, detail=f"That URL answered {response.status_code}, not an image")

            data = b""

            for chunk in response.iter_content(64 * 1024):

                data += chunk

                if len(data) > VEHICLE_IMAGE_MAX_BYTES:
                    raise HTTPException(
                        status_code=413, detail=f"Images can be at most {VEHICLE_IMAGE_MAX_BYTES // (1024 * 1024)} MB"
                    )

    except requests.RequestException:
        raise HTTPException(status_code=400, detail="Couldn't download that URL")

    return data


class VehicleImageUrlRequest(BaseModel):
    url: str


#
# Detect vehicle (the Vehicle Models editor): an AI cutout of the picture's
# main subject - IS-Net "general use", the open-source salient-object model
# rembg ships, run on the CPU with onnxruntime. The model file is baked into
# the backend image at build time (see the Dockerfile), so this works fully
# offline. It finds the vehicle wherever it is in a photo - street,
# buildings, shadows, background seen through the windows - rather than
# just clearing the color around the edge like Remove background does.
#
# Loaded on first use, not at startup, so the backend doesn't hold its
# ~1 GB of working memory until someone actually asks. One cutout at a time,
# for the same reason.
#
CUTOUT_MODEL_PATH = os.environ.get("CUTOUT_MODEL_PATH", "/models/isnet-general-use.onnx")
CUTOUT_INPUT_SIDE = 1024
CUTOUT_MAX_SIDE = 1600

#
# Mask values (0-255) at or below CUTOUT_ALPHA_FLOOR are cleared outright -
# the model's faint "maybe" haze, like a ghost of a building behind the
# roof. The trim goes round only what it's confident about (at least
# CUTOUT_CONFIDENT_ALPHA), plus CUTOUT_TRIM_PADDING pixels, and anything
# left outside that box is cleared too.
#
CUTOUT_ALPHA_FLOOR = 40
CUTOUT_CONFIDENT_ALPHA = 128
CUTOUT_TRIM_PADDING = 8

cutout_session = None
cutout_lock = threading.Lock()


def get_cutout_session():

    global cutout_session

    if cutout_session is None:

        if not os.path.exists(CUTOUT_MODEL_PATH):
            raise HTTPException(
                status_code=503,
                detail="Vehicle detection isn't installed here - rebuild the backend image to download its model"
            )

        import onnxruntime

        cutout_session = onnxruntime.InferenceSession(CUTOUT_MODEL_PATH, providers=["CPUExecutionProvider"])

    return cutout_session


def cut_out_vehicle(data, trim=True):

    if len(data) > VEHICLE_IMAGE_MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"Images can be at most {VEHICLE_IMAGE_MAX_BYTES // (1024 * 1024)} MB")

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        raise HTTPException(status_code=400, detail="That isn't an image Logisim can read - try a PNG, JPEG, WebP or GIF")

    image = ImageOps.exif_transpose(image).convert("RGBA")
    image.thumbnail((CUTOUT_MAX_SIDE, CUTOUT_MAX_SIDE), Image.LANCZOS)

    #
    # The model's own preprocessing (as rembg does it): RGB at 1024x1024,
    # scaled to 0-1, mean-centred, channels first.
    #
    rgb = np.asarray(
        image.convert("RGB").resize((CUTOUT_INPUT_SIDE, CUTOUT_INPUT_SIDE), Image.LANCZOS), dtype=np.float32
    )
    rgb = rgb / max(float(rgb.max()), 1e-6)
    rgb = (rgb - np.array([0.485, 0.456, 0.406], dtype=np.float32)).transpose(2, 0, 1)[np.newaxis]

    with cutout_lock:
        session = get_cutout_session()
        prediction = session.run(None, {session.get_inputs()[0].name: rgb.astype(np.float32)})[0][0, 0]

    low, high = float(prediction.min()), float(prediction.max())
    prediction = (prediction - low) / max(high - low, 1e-6)

    mask = Image.fromarray((prediction * 255).astype(np.uint8), mode="L").resize(image.size, Image.LANCZOS)
    mask = np.asarray(mask).copy()
    mask[mask <= CUTOUT_ALPHA_FLOOR] = 0

    #
    # Keeps whatever transparency the picture already had (an earlier
    # eraser pass, say) as well as the model's cut.
    #
    pixels = np.asarray(image).copy()
    pixels[:, :, 3] = np.minimum(pixels[:, :, 3], mask)

    confident_rows = np.flatnonzero((pixels[:, :, 3] >= CUTOUT_CONFIDENT_ALPHA).any(axis=1))
    confident_columns = np.flatnonzero((pixels[:, :, 3] >= CUTOUT_CONFIDENT_ALPHA).any(axis=0))

    if not len(confident_rows):
        raise HTTPException(status_code=422, detail="Couldn't find a vehicle in that picture")

    height, width = pixels.shape[:2]
    top = max(0, confident_rows[0] - CUTOUT_TRIM_PADDING)
    bottom = min(height, confident_rows[-1] + 1 + CUTOUT_TRIM_PADDING)
    left = max(0, confident_columns[0] - CUTOUT_TRIM_PADDING)
    right = min(width, confident_columns[-1] + 1 + CUTOUT_TRIM_PADDING)

    inside = np.zeros((height, width), dtype=bool)
    inside[top:bottom, left:right] = True
    pixels[~inside, 3] = 0

    result = Image.fromarray(pixels, mode="RGBA")

    if trim:
        result = result.crop((left, top, right, bottom))

    out = io.BytesIO()
    result.save(out, "PNG", optimize=True)

    return out.getvalue()


#
# Returns the cutout as a PNG without storing anything - the editor loads
# it as the picture being edited, for touching up and saving like any
# other change. trim crops it to just the vehicle.
#
@app.post("/api/vehicle-models/cutout")
async def cutout_vehicle_image(
    file: UploadFile = File(...), trim: bool = True, _admin: None = Depends(require_admin)
):

    data = await file.read(VEHICLE_IMAGE_MAX_BYTES + 1)

    return Response(await asyncio.to_thread(cut_out_vehicle, data, trim), media_type="image/png")


#
# The editor's "From URL" preview: fetches and normalizes the image without
# storing it, so the admin sees exactly what would be saved. Saving then
# uploads those same bytes (PUT .../image), so the URL is only fetched once.
#
@app.post("/api/vehicle-models/image-preview")
def preview_vehicle_image_url(req: VehicleImageUrlRequest, _admin: None = Depends(require_admin)):

    return Response(normalize_vehicle_image(fetch_vehicle_image_url(req.url)), media_type="image/webp")


@app.put("/api/vehicle-models/{id}/image")
async def upload_vehicle_model_image(id: int, file: UploadFile = File(...), _admin: None = Depends(require_admin)):

    data = normalize_vehicle_image(await file.read(VEHICLE_IMAGE_MAX_BYTES + 1))

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute("SELECT 1 FROM vehicle_models WHERE id = %s", (id,))

        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="Vehicle model not found")

        cur.execute(
            """
            INSERT INTO vehicle_model_images (vehicle_model_id, content_type, data, sha256)
            VALUES (%s, 'image/webp', %s, %s)
            ON CONFLICT (vehicle_model_id) DO UPDATE
            SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, sha256 = EXCLUDED.sha256, updated = NOW()
            """,
            (id, psycopg2.Binary(data), hashlib.sha256(data).hexdigest())
        )

        conn.commit()

        return fetch_vehicle_models_by_id(cur, [id])[id]

    finally:
        cur.close()
        conn.close()


#
# Back to the built-in picture (the image filename), if it has one.
#
@app.delete("/api/vehicle-models/{id}/image")
def delete_vehicle_model_image(id: int, _admin: None = Depends(require_admin)):

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute("DELETE FROM vehicle_model_images WHERE vehicle_model_id = %s", (id,))

        conn.commit()

        vehicle_model = fetch_vehicle_models_by_id(cur, [id]).get(id)

        if vehicle_model is None:
            raise HTTPException(status_code=404, detail="Vehicle model not found")

        return vehicle_model

    finally:
        cur.close()
        conn.close()


#
# For everyone - every vehicle card shows its model's picture. image_url
# carries the hash (?v=), so a new picture is a new URL and this one can be
# cached for good.
#
@app.get("/api/vehicle-models/{id}/image")
def get_vehicle_model_image(id: int):

    conn = db()
    cur = conn.cursor()

    try:
        cur.execute("SELECT content_type, data FROM vehicle_model_images WHERE vehicle_model_id = %s", (id,))
        row = cur.fetchone()
    finally:
        cur.close()
        conn.close()

    if row is None:
        raise HTTPException(status_code=404, detail="No uploaded image for that vehicle model")

    return Response(
        bytes(row[1]),
        media_type=row[0],
        headers={"Cache-Control": "public, max-age=31536000, immutable"}
    )


#
# A model's map icon - a small transparent square the editor makes from
# its picture (Create icon). Stored like the picture, in its own table, and
# kept to VEHICLE_ICON_MAX_SIDE whatever comes in.
#
VEHICLE_ICON_MAX_SIDE = 128


@app.put("/api/vehicle-models/{id}/icon")
async def upload_vehicle_model_icon(id: int, file: UploadFile = File(...), _admin: None = Depends(require_admin)):

    data = normalize_vehicle_image(await file.read(VEHICLE_IMAGE_MAX_BYTES + 1), VEHICLE_ICON_MAX_SIDE)

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute("SELECT 1 FROM vehicle_models WHERE id = %s", (id,))

        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="Vehicle model not found")

        cur.execute(
            """
            INSERT INTO vehicle_model_icons (vehicle_model_id, content_type, data, sha256)
            VALUES (%s, 'image/webp', %s, %s)
            ON CONFLICT (vehicle_model_id) DO UPDATE
            SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, sha256 = EXCLUDED.sha256, updated = NOW()
            """,
            (id, psycopg2.Binary(data), hashlib.sha256(data).hexdigest())
        )

        conn.commit()

        return fetch_vehicle_models_by_id(cur, [id])[id]

    finally:
        cur.close()
        conn.close()


@app.delete("/api/vehicle-models/{id}/icon")
def delete_vehicle_model_icon(id: int, _admin: None = Depends(require_admin)):

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute("DELETE FROM vehicle_model_icons WHERE vehicle_model_id = %s", (id,))

        conn.commit()

        vehicle_model = fetch_vehicle_models_by_id(cur, [id]).get(id)

        if vehicle_model is None:
            raise HTTPException(status_code=404, detail="Vehicle model not found")

        return vehicle_model

    finally:
        cur.close()
        conn.close()


@app.get("/api/vehicle-models/{id}/icon")
def get_vehicle_model_icon(id: int):

    conn = db()
    cur = conn.cursor()

    try:
        cur.execute("SELECT content_type, data FROM vehicle_model_icons WHERE vehicle_model_id = %s", (id,))
        row = cur.fetchone()
    finally:
        cur.close()
        conn.close()

    if row is None:
        raise HTTPException(status_code=404, detail="No icon for that vehicle model")

    return Response(
        bytes(row[1]),
        media_type=row[0],
        headers={"Cache-Control": "public, max-age=31536000, immutable"}
    )



#
# Vehicle models as a flat CSV, in the same column order POST
# /api/vehicle-models/upload reads back - the catalog's backup, shared by
# every save file. Only the image's filename travels with it: the picture
# itself lives in frontend/images/.
#
VEHICLE_MODEL_EXPORT_COLUMNS = [
    "year", "brand", "model", "person_capacity", "cargo_capacity_cuft",
    "cost", "mpg", "fuel_tank_gallons", "image", *SPEC_COLUMNS,
]


@app.get("/api/vehicle-models/export")
def export_vehicle_models(_admin: None = Depends(require_admin)):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        f"SELECT {', '.join(VEHICLE_MODEL_EXPORT_COLUMNS)} FROM vehicle_models ORDER BY brand, model, year"
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    out = io.StringIO()
    writer = csv.writer(out)

    writer.writerow(VEHICLE_MODEL_EXPORT_COLUMNS)

    turbo_index = VEHICLE_MODEL_EXPORT_COLUMNS.index("engine_turbo")

    for row in rows:
        writer.writerow([
            "" if value is None
            else ("yes" if value else "no") if index == turbo_index
            else value
            for index, value in enumerate(row)
        ])

    filename = f"logisim-vehicle-models-{local_now_naive():%Y-%m-%d}.csv"

    return Response(
        content=out.getvalue().encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


#
# Restores a vehicle model export (or any CSV with those columns). A row
# matching an existing model's year + brand + model (case-insensitively)
# updates that model in place instead of adding a duplicate, so restoring
# on top of a catalog that already has some of them is safe - and existing
# vehicles keep pointing at the same model row. Small enough (no geocoding)
# to run inline rather than as a background job; each row commits on its
# own so one bad row doesn't cost the rest.
#
@app.post("/api/vehicle-models/upload")
async def upload_vehicle_models(file: UploadFile = File(...), _admin: None = Depends(require_admin)):

    raw = await file.read()

    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 CSV text")

    rows = list(csv.reader(io.StringIO(text)))

    if not rows:
        raise HTTPException(status_code=400, detail="File is empty")

    header = [normalize_csv_header_cell(cell) for cell in rows[0]]
    wanted = {normalize_csv_header_cell(column): column for column in VEHICLE_MODEL_EXPORT_COLUMNS}

    #
    # image and the spec columns are optional - an older export has no
    # spec (engine and tire) columns, and restoring it leaves those specs as
    # they are rather than blanking them.
    #
    optional_columns = ("image", *SPEC_COLUMNS)

    missing = [column for key, column in wanted.items() if key not in header and column not in optional_columns]

    spec_columns_present = [
        column for column in SPEC_COLUMNS if normalize_csv_header_cell(column) in header
    ]

    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Missing column(s): {', '.join(missing)} - expected a header row like a vehicle model export's"
        )

    conn = db()
    cur = conn.cursor()

    created = 0
    updated = 0
    errors = []

    for index, row in enumerate(rows[1:], start=2):

        entry = {wanted[key]: value.strip() for key, value in zip(header, row) if key in wanted}

        if not any(entry.values()):
            continue

        try:

            model = CreateVehicleModelRequest(
                year=int(entry["year"]),
                brand=entry["brand"],
                model=entry["model"],
                person_capacity=int(float(entry["person_capacity"])),
                cargo_capacity_cuft=float(entry["cargo_capacity_cuft"]),
                cost=float(entry["cost"]),
                mpg=float(entry["mpg"]),
                fuel_tank_gallons=float(entry["fuel_tank_gallons"]),
                image=entry.get("image") or None,
                **{
                    column: parse_engine_csv_value(column, entry.get(column, ""))
                    for column in spec_columns_present
                }
            )

            if not model.brand or not model.model:
                raise ValueError("brand and model can't be empty")

            if model.mpg <= 0 or model.fuel_tank_gallons <= 0:
                raise ValueError("mpg and fuel_tank_gallons must be positive")

            try:
                validate_engine(model)
            except HTTPException as e:
                raise ValueError(e.detail)

            spec_set_sql = "".join(f", {column} = %s" for column in spec_columns_present)
            spec_values = tuple(getattr(model, column) for column in spec_columns_present)

            values = (
                model.person_capacity, model.cargo_capacity_cuft, model.cost,
                model.mpg, model.fuel_tank_gallons, model.image
            )

            cur.execute(
                """
                UPDATE vehicle_models
                SET person_capacity = %s, cargo_capacity_cuft = %s, cost = %s,
                    mpg = %s, fuel_tank_gallons = %s, image = %s""" + spec_set_sql + """
                WHERE id = (
                    SELECT id FROM vehicle_models
                    WHERE year = %s AND LOWER(brand) = LOWER(%s) AND LOWER(model) = LOWER(%s)
                    ORDER BY id
                    LIMIT 1
                )
                RETURNING id
                """,
                (*values, *spec_values, model.year, model.brand, model.model)
            )

            if cur.fetchone() is not None:
                updated += 1
            else:
                cur.execute(
                    """
                    INSERT INTO vehicle_models
                    (year, brand, model, person_capacity, cargo_capacity_cuft, cost, mpg, fuel_tank_gallons, image,
                     engine_liters, engine_cylinders, engine_turbo, fuel_type, transmission, tire_count)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        model.year, model.brand, model.model, *values,
                        *(getattr(model, column) for column in SPEC_COLUMNS)
                    )
                )
                created += 1

            conn.commit()

        except Exception as e:

            conn.rollback()

            errors.append({"row": index, "error": str(e).splitlines()[0]})

    cur.close()
    conn.close()

    return {"created": created, "updated": updated, "errors": errors}


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
def delete_vehicle_model(id: int, _admin: None = Depends(require_admin)):

    conn = db()
    cur = conn.cursor()

    cur.execute("SELECT year, brand, model FROM vehicle_models WHERE id = %s", (id,))

    row = cur.fetchone()

    if row is not None and is_starter_vehicle_model(*row):
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="The starter van can't be deleted - every new file starts with one")

    #
    # Only vehicles still in someone's fleet hold a model back - named by
    # save file, since the model is shared by all four and the admin may
    # be looking at a different one.
    #
    cur.execute(
        """
        SELECT s.id, s.name, COUNT(*)
        FROM vehicles v
        JOIN save_slots s ON s.id = v.slot_id
        WHERE v.vehicle_model_id = %s AND NOT v.sold
        GROUP BY s.id, s.name
        ORDER BY s.id
        """,
        (id,)
    )

    in_use = cur.fetchall()

    if in_use:
        cur.close()
        conn.close()
        raise HTTPException(
            status_code=409,
            detail="Still in use by " + ", ".join(
                f"{count} vehicle{'' if count == 1 else 's'} in File {slot_id} ({name})"
                for slot_id, name, count in in_use
            ) + " - sell them first"
        )

    try:

        #
        # Selling keeps a vehicle's row (sold = TRUE) as history, and that
        # row still points at its model - so a model whose vehicles have all
        # been sold couldn't be deleted. Those rows go with it: nothing shows
        # sold vehicles, and the Budget keeps each vehicle's name on its own
        # ledger rows (ledger.vehicle_id just goes NULL). Their trips cascade,
        # and the paths and places only they used are forgotten.
        #
        cur.execute(
            "SELECT DISTINCT t.path_id FROM trips t JOIN vehicles v ON v.id = t.vehicle_id WHERE v.vehicle_model_id = %s",
            (id,)
        )
        sold_path_ids = [path_row[0] for path_row in cur.fetchall()]

        cur.execute(
            "DELETE FROM vehicles WHERE vehicle_model_id = %s AND sold RETURNING place_id",
            (id,)
        )
        sold_place_ids = [place_row[0] for place_row in cur.fetchall()]

        forget_unused_paths(cur, sold_path_ids)
        forget_unused_places(cur, sold_place_ids)

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
def list_vehicles(include_sold: bool = False, slot: int = Depends(current_slot)):

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur, slot)

    settle_arrived_vehicles(conn, cur)

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
    #
    # The trailing boolean (from latest_trip below) is true only while the
    # vehicle's latest uncancelled trip hasn't actually settled yet (same
    # test settle_arrived_vehicles() uses to decide "still needs
    # settling") - resolve_trip_progress() on an already-settled trip is a
    # pure function of that trip's own fixed fields plus ever-increasing
    # elapsed time, so it reads "ARRIVED" forever, not just at the moment
    # it happened. Without this, fetch_live_trip_progress() below would
    # permanently override a settled vehicle's real READY status with that
    # stale ARRIVED verdict from whatever trip it last drove.
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
            COALESCE(ctm.miles, 0),
            latest_trip.destination_place_id IS NOT NULL
                AND v.place_id IS DISTINCT FROM latest_trip.destination_place_id,
            v.purchase_price
        FROM vehicles v
        LEFT JOIN (
            SELECT t.vehicle_id, SUM(COALESCE(t.distance_miles, 0)) AS miles
            FROM trips t
            WHERE t.cancelled_at IS NULL
            AND (EXTRACT(EPOCH FROM (NOW() - t.started_at)) * %s - t.paused_seconds) >= t.realized_duration_seconds
            GROUP BY t.vehicle_id
        ) ctm ON ctm.vehicle_id = v.id
        LEFT JOIN LATERAL (
            SELECT p.destination_place_id
            FROM trips t
            LEFT JOIN paths p ON p.id = t.path_id
            WHERE t.vehicle_id = v.id
            AND t.cancelled_at IS NULL
            ORDER BY t.started_at DESC
            LIMIT 1
        ) latest_trip ON true
        WHERE v.slot_id = %s
        {"" if include_sold else "AND v.sold = FALSE"}
        ORDER BY v.id
        """,
        (time_multiplier, time_multiplier, slot)
    )

    rows = cur.fetchall()

    vehicle_models_by_id = fetch_vehicle_models_by_id(cur, [row[2] for row in rows])
    places_by_id = fetch_places_by_id(cur, [row[3] for row in rows])

    #
    # Every vehicle with an unsettled trip (row[10]), not just the ones the
    # naive elapsed-time CASE above flagged "DRIVING" - that check has no
    # idea about fuel, so a vehicle that ran dry (STRANDED, frozen
    # mid-route) but whose *scheduled* time has long since elapsed reads
    # exactly like an old finished trip to it, and got silently skipped
    # here, defaulting all the way down to row[8]'s "READY" below - hiding
    # a real STRANDED vehicle (no badge, no roadside-refuel option) as if
    # it were simply idle. row[10] (not the naive CASE) is what actually
    # decides this now - see its own comment above for why a settled
    # vehicle has to be excluded rather than just "every vehicle".
    #
    progress_by_vehicle = fetch_live_trip_progress(
        cur, [row[0] for row in rows if row[10]], time_multiplier
    )

    loads_by_vehicle = fetch_active_loads(cur, [row[0] for row in rows])

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

            #
            # What it was bought for - what selling it refunds.
            #
            "purchase_price": float(row[11]),

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

            "status": progress["status"] if progress else row[8],

            #
            # The load it's carrying or on its way to pick up, if any.
            #
            "load": loads_by_vehicle.get(row[0])
        })

    return result



#
# On a trip in any sense, so it can't be sold out from under it: its latest
# trip still has its route (a trip's path is only forgotten once it
# arrives - see forget_unused_paths()), which covers driving, stranded and
# mid-detour alike; it has a load it hasn't delivered; or a job is about to
# start one (a drive, a refuel run,
# a divert, the leg after a refuel) and its trip doesn't exist yet. Settle
# first, so a trip that's just arrived counts as over.
#
def vehicle_is_busy(cur, vehicle_id):

    cur.execute(
        """
        SELECT t.path_id IS NOT NULL
        FROM trips t
        WHERE t.vehicle_id = %s AND t.cancelled_at IS NULL
        ORDER BY t.started_at DESC
        LIMIT 1
        """,
        (vehicle_id,)
    )

    latest = cur.fetchone()

    if latest is not None and latest[0]:
        return True

    cur.execute(
        "SELECT 1 FROM loads WHERE vehicle_id = %s AND status IN ('accepted', 'loaded') LIMIT 1",
        (vehicle_id,)
    )

    if cur.fetchone() is not None:
        return True

    cur.execute(
        """
        SELECT 1 FROM jobs
        WHERE vehicle_id = %s AND status IN ('pending', 'running') AND job_type = ANY(%s)
        LIMIT 1
        """,
        (vehicle_id, list(TRIP_STARTING_JOB_TYPES))
    )

    return cur.fetchone() is not None


#
# Refunds what was paid for it (purchase_price - nothing for the inherited
# starter van). Depreciation can come later, from list_price and the
# vehicle's age and miles.
#
@app.post("/api/vehicles/{id}/sell")
def sell_vehicle(id: int, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(id, slot)

    conn = db()
    cur = conn.cursor()

    settle_arrived_vehicles(conn, cur)

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

    if vehicle_is_busy(cur, id):
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle is on a trip - it can be sold once it's parked")

    cur.execute(
        "UPDATE vehicles SET sold = TRUE, sold_at = NOW() WHERE id=%s RETURNING name, purchase_price, place_id",
        (id,)
    )

    name, purchase_price, place_id = cur.fetchone()
    refund = float(purchase_price)

    record_money(
        cur, slot, refund, "vehicle_sale", f"Sold {name}",
        id, name, fetch_places_by_id(cur, [place_id])[place_id]["description"]
    )

    conn.commit()

    cur.close()
    conn.close()

    return {"id": id, "sold": True, "refund": refund}



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
def refuel_vehicle(id: int, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(id, slot)

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur, slot)

    settle_arrived_vehicles(conn, cur)

    cur.execute(
        "SELECT sold, place_id, vehicle_model_id, name, fuel_gallons, fuel_cost_per_gallon FROM vehicles WHERE id=%s",
        (id,)
    )

    row = cur.fetchone()

    if row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle not found")

    sold, place_id, vehicle_model_id, vehicle_name, fuel_gallons, fuel_cost_per_gallon = row

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

    price_here = gas_price_at(cur, place_id)

    if price_here is not None:

        fuel_tank_gallons = fetch_vehicle_models_by_id(cur, [vehicle_model_id])[vehicle_model_id]["fuel_tank_gallons"]

        gallons_bought, cost = buy_fuel_to_full(
            cur, slot, id, vehicle_name, fuel_gallons, fuel_cost_per_gallon, fuel_tank_gallons, price_here,
            fetch_places_by_id(cur, [place_id])[place_id]["description"]
        )

        cur.execute("UPDATE vehicles SET fuel_gallons = %s WHERE id = %s", (fuel_tank_gallons, id))

        conn.commit()

        cur.close()
        conn.close()

        return {"id": id, "fuel_gallons": fuel_tank_gallons, "gallons_bought": gallons_bought, "cost": round(cost, 2)}

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

    job_id = create_job("drive_to_refuel", slot_id=slot, vehicle_id=id)

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
def roadside_refuel_vehicle(id: int, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(id, slot)

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur, slot)

    settle_arrived_vehicles(conn, cur)

    cur.execute("SELECT sold, name FROM vehicles WHERE id=%s", (id,))

    row = cur.fetchone()

    if row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle not found")

    if row[0]:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle has been sold")

    vehicle_name = row[1]

    cur.execute(
        """
        SELECT
            t.id, t.paused_seconds, t.roadside_refuel_count, t.starting_fuel_gallons,
            t.realized_seconds, t.realized_duration_seconds, p.distances_miles,
            vs.mpg, vs.fuel_tank_gallons, EXTRACT(EPOCH FROM (NOW() - t.started_at)), p.route,
            t.journey_origin, COALESCE(t.resume_destination_place_id, p.destination_place_id),
            COALESCE(t.journey_id, t.id)
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
        mpg, fuel_tank_gallons, elapsed_real_seconds, route,
        journey_origin, journey_destination_place_id, journey_id
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

    #
    # A full tank's worth of gas at the price of the gas station nearest
    # where it ran dry, plus the assistance fee. The gas joins this leg's fuel
    # pool (trips.fuel_value_dollars), so it's refunded like any other gas
    # once the trip finishes; the fee isn't.
    #
    lat, lng = interpolate_position_at_distance(route, distances_miles, progress["distance_miles"])
    nearest = find_closest_gas_station(cur, lat, lng)
    price_per_gallon, markup_percent = fuel_price_for_vehicle(
        cur, id, nearest["price_per_gallon"] if nearest else 0.0
    )
    gas_cost = fuel_tank_gallons * price_per_gallon

    cur.execute(
        """
        UPDATE trips
        SET paused_seconds = %s, roadside_refuel_count = %s, fuel_value_dollars = fuel_value_dollars + %s
        WHERE id = %s
        """,
        (new_paused_seconds, new_roadside_refuel_count, gas_cost, trip_id)
    )

    trip_label = journey_label(
        journey_origin,
        fetch_places_by_id(cur, [journey_destination_place_id])[journey_destination_place_id]["description"]
    )

    location = f"Roadside, near {nearest['description']}" if nearest else "Roadside"

    record_money(
        cur, slot, -gas_cost, "gas_purchase",
        "Roadside " + fuel_purchase_label(fuel_tank_gallons, price_per_gallon, markup_percent).lower()
        + " (nearest station's price)",
        id, vehicle_name, location, trip_label, journey_id
    )

    record_money(
        cur, slot, -ROADSIDE_ASSIST_FEE, "roadside_fee", "Roadside assistance fee",
        id, vehicle_name, location, trip_label, journey_id
    )

    conn.commit()

    cur.close()
    conn.close()

    return {

        "id": id,

        "trip_id": trip_id,

        "roadside_refuel_count": new_roadside_refuel_count,

        "gas_cost": round(gas_cost, 2),

        "fee": ROADSIDE_ASSIST_FEE,

        "price_per_gallon": price_per_gallon
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
        "progress": progress,
        "mpg": mpg
    }


#
# Called on demand - once, when "Divert to nearest gas station" is
# clicked - rather than polled, so there's no need to gate this behind a
# per-vehicle opt-in the way a continuously-polled version once was.
# Returns every qualifying candidate sorted by distance (not just one
# auto-picked choice) so the caller can take the nearest; {"stations": []}
# (not a 404) whenever there's nothing to offer - not driving, or nothing
# within MAX_GAS_STATION_DETOUR_MILES of the remaining route or
# NEARBY_GAS_STATION_MILES of the vehicle's current position - since
# that's a perfectly normal thing for this to report, not an error.
#
@app.get("/api/vehicles/{id}/gas-station-ahead")
def gas_station_ahead(id: int, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(id, slot)

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur, slot)

    settle_arrived_vehicles(conn, cur)

    context = fetch_active_trip_for_diversion(cur, id, time_multiplier)

    if context is None or context["progress"]["status"] != "DRIVING":
        cur.close()
        conn.close()
        return {"stations": []}

    fuel_gallons_remaining = context["progress"]["fuel_gallons_remaining"]

    max_reachable_miles = (
        fuel_gallons_remaining * context["mpg"]
        if fuel_gallons_remaining is not None and context["mpg"] else None
    )

    stations = find_gas_station_options(
        cur, context["route"], context["distances_miles"], context["progress"]["distance_miles"],
        max_reachable_miles
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
def divert_to_gas_station(id: int, req: DivertToGasStationRequest, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(id, slot)

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur, slot)

    settle_arrived_vehicles(conn, cur)

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

    job_id = create_job("divert_to_gas_station", slot_id=slot, vehicle_id=id)

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
def delete_vehicle(id: int, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(id, slot)

    #
    # Permanently erases the row (cascades its trips) - distinct from
    # selling, which just marks sold = TRUE so it still shows up in "All
    # Vehicles" history. Not exposed in the UI; kept for cleanup.
    #
    conn = db()
    cur = conn.cursor()

    #
    # Its trips cascade away with it, which can leave the path it was
    # driving (and that path's places) with nothing using them.
    #
    cur.execute("SELECT DISTINCT path_id FROM trips WHERE vehicle_id = %s", (id,))
    trip_path_ids = [row[0] for row in cur.fetchall()]

    cur.execute(
        "DELETE FROM vehicles WHERE id=%s RETURNING id, place_id",
        (id,)
    )

    deleted = cur.fetchone()

    if deleted is not None:
        forget_unused_paths(cur, trip_path_ids)
        forget_unused_places(cur, [deleted[1]])

    conn.commit()

    cur.close()
    conn.close()

    if deleted is None:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    return {"deleted": id}



@app.get("/api/vehicles/{id}/city")
def vehicle_city(id: int, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(id, slot)

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur, slot)

    #
    # Settles any trip that's genuinely arrived first - same as
    # gas_station_ahead()/divert_to_gas_station() - so the ARRIVED check
    # just below almost never actually trips in practice; it's still a
    # trip's true fuel-aware status that decides whether it's "on a trip",
    # not a raw elapsed-time comparison (see active_trips()'s own comment).
    #
    settle_arrived_vehicles(conn, cur)

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
        ORDER BY t.started_at DESC
        LIMIT 1
        """,
        (id,)
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

    #
    # settle_arrived_vehicles() above should already have moved a genuinely
    # arrived trip along (new place, possibly a resume trip) before this
    # query ran, so this is a defensive fallback for the brief window where
    # a resume job hasn't finished yet, not the normal case.
    #
    if derived["status"] == "ARRIVED":
        raise HTTPException(status_code=404, detail="Vehicle is not currently on a trip")

    return {"city": reverse_geocode(derived["position"])}


#
# Unlike vehicle_city() above (a driving vehicle's live mid-trip position),
# this is for a settled vehicle sitting at its place - its disambiguated
# full address (the frontend's old Paths tab used it to prefill Origin; a
# drive now always starts from the vehicle's place id, so nothing in the
# UI calls this anymore). The place's address was already
# resolved once at creation (geocode_full(), via find_or_create_place()),
# so this is a plain join - no fresh geocoding call needed.
#
@app.get("/api/vehicles/{id}/address")
def vehicle_address(id: int, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(id, slot)

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
def create_place(req: CreatePlaceRequest, _admin: None = Depends(require_admin)):

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
def delete_place(id: int, _admin: None = Depends(require_admin)):

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute("DELETE FROM places WHERE id=%s RETURNING id", (id,))

        deleted = cur.fetchone()

        conn.commit()

        #
        # gas_prices.place_id is ON DELETE CASCADE, so this may have
        # removed a station too.
        #
        invalidate_gas_station_cache()

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
def list_gas_prices(request: Request):

    #
    # ETag + "no-cache" (revalidate every time, never serve blind) lets the
    # browser keep the full list in its own HTTP cache across page loads -
    # an unchanged list costs a 304 with no body and no DB query at all,
    # instead of re-sending every station. The ETag is read before the rows
    # so a write landing in between can only make it look older than the
    # body (forcing a harmless re-download next time), never newer.
    #
    etag = gas_station_cache_etag()

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})

    conn = db()
    cur = conn.cursor()

    rows = get_cached_gas_stations(cur)

    cur.close()
    conn.close()

    return JSONResponse(content=jsonable_encoder(rows), headers={"ETag": etag, "Cache-Control": "no-cache"})


#
# Plenty of real stations in OSM aren't tagged amenity=fuel - e.g. a plain
# building=yes that's simply *named* "Gas Station" - so a fuel-ish name
# counts too, not just the tag.
#
FUEL_STATION_NAME_PATTERN = re.compile(
    r"\b(gas(oline)? station|gas bar|fuel|petrol|filling station|service station|gasolinera|gasolina|"
    r"station[- ]service|tankstelle|posto de combust[ií]vel)\b",
    re.IGNORECASE
)


def is_fuel_station_match(raw):

    if raw.get("type") == "fuel":
        return True

    return bool(FUEL_STATION_NAME_PATTERN.search(raw.get("name") or raw.get("display_name", "").split(",")[0]))


#
# "a village", "an amenity" - human wording for what a non-station match
# actually is. OSM's type is often just "yes" (building=yes, i.e. "some
# building"), which reads as nonsense on its own, so the class is used then.
#
def describe_match_kind(raw):

    kind = raw.get("type")

    if not kind or kind == "yes":
        kind = raw.get("class") or "location"

    kind = kind.replace("_", " ")

    return ("an " if kind[0] in "aeiou" else "a ") + kind


#
# Nominatim is a geocoder, not a POI search (see find_gas_stations_in_city()),
# so a description like "gas station near Nisutlin" usually resolves to the
# town itself - and used to be silently saved there, pricing the middle of
# town as if it were a station. Instead, anything that isn't a known
# station already (a place with a gas price) or an OSM amenity=fuel match
# is refused with what *was* matched, so the frontend can say so and let
# the user confirm (confirm_location) that the spot is right anyway - a
# station's plain street address, for one, geocodes as a building, not
# amenity=fuel, and is a perfectly good location to price.
#
def resolve_gas_station_place(cur, description, confirm_location):

    saved = find_saved_place(cur, description)

    if saved is not None:

        if confirm_location:
            return saved[0]

        cur.execute("SELECT 1 FROM gas_prices WHERE place_id = %s", (saved[0],))

        if cur.fetchone() is not None:
            return saved[0]

    try:
        geocoded = geocode_full(description)
    except HTTPException:
        raise HTTPException(
            status_code=400,
            detail=(
                f'Couldn\'t find a location for "{description}". Try the station\'s street address, '
                f'or its name with the city and state (e.g. "Shell, Minneapolis, MN").'
            )
        )

    _, _, address, _, raw = geocoded

    if not confirm_location and not is_fuel_station_match(raw):

        raise HTTPException(
            status_code=409,
            detail={
                "code": "not_a_gas_station",
                "message": (
                    f'No gas station found for "{description}" - the closest match is '
                    f'{address} ({describe_match_kind(raw)}, not a gas station).'
                ),
                "match": address
            }
        )

    if saved is not None:
        return saved[0]

    place_id, _, _ = create_place_from_geocode(cur, description, geocoded)

    return place_id


@app.post("/api/gas-prices")
def upsert_gas_price(req: CreateGasPriceRequest, _admin: None = Depends(require_admin)):

    if req.price_per_gallon <= 0:
        raise HTTPException(status_code=400, detail="price_per_gallon must be positive")

    conn = db()
    cur = conn.cursor()

    try:
        place_id = resolve_gas_station_place(cur, req.description, req.confirm_location)
    except HTTPException:
        cur.close()
        conn.close()
        raise

    upsert_gas_price_row(cur, place_id, req.price_per_gallon, req.brand)

    cur.execute(
        f"SELECT {GAS_PRICE_COLUMNS} FROM gas_prices g JOIN places p ON p.id = g.place_id WHERE g.place_id = %s",
        (place_id,)
    )

    result = gas_price_dict(cur.fetchone())

    #
    # Piggybacks the place's own full row (same shape GET /api/places
    # returns) onto this response so the frontend can patch its local
    # placesById map directly instead of re-fetching the entire places
    # list just to pick up one possibly-new row - at tens of thousands of
    # saved places that full list is multiple megabytes, and re-pulling it
    # after every single price add makes "add one gas price" cost far more
    # than the one row it actually changed.
    #
    cur.execute(f"SELECT {PLACE_COLUMNS} FROM places WHERE id = %s", (place_id,))
    result["place"] = place_dict(cur.fetchone())

    conn.commit()

    invalidate_gas_station_cache()

    cur.close()
    conn.close()

    return result


@app.delete("/api/gas-prices/{place_id}")
def delete_gas_price(place_id: int, _admin: None = Depends(require_admin)):

    conn = db()
    cur = conn.cursor()

    cur.execute("DELETE FROM gas_prices WHERE place_id=%s RETURNING place_id", (place_id,))

    deleted = cur.fetchone()

    #
    # The price may have been the only thing keeping this place around.
    #
    forget_unused_places(cur, [place_id])

    conn.commit()

    invalidate_gas_station_cache()

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
# CSV). Each row/object needs either a description/address (a "description",
# "address", or "location" column/key) or a "city" column/key, plus a price
# ("price_per_gallon" or "price") and optionally a "brand" (or "name")
# column/key. Reuses find_or_create_place()/upsert_gas_price_row() from the
# single-entry endpoint above, so a re-uploaded file just refreshes existing
# prices (and brands) rather than duplicating them.
#
# A "city" row is a different shape of input: rather than one exact place,
# it's "find the real gas stations in this city" - find_gas_stations_in_city()
# (Overpass, not Nominatim - see its own comment) returns every station OSM
# knows about there, and every one of them gets a gas_prices row at that
# row's price, so one input row can create many output rows. An explicit
# "brand"/"name" column is ignored for city rows - each station keeps its
# own real brand from OSM instead.
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

                place_text = entry.get("description") or entry.get("address") or entry.get("location")
                city_text = entry.get("city")
                description = place_text or city_text

                if not description:
                    raise ValueError("missing description/address/location/city")

                price_raw = entry.get("price_per_gallon")
                price_raw = price_raw if price_raw is not None else entry.get("price")

                price = float(price_raw)

                if price <= 0:
                    raise ValueError("price_per_gallon must be positive")

                if place_text:

                    brand = entry.get("brand") or entry.get("name")

                    #
                    # A row that already carries its coordinates (e.g. one
                    # from GET /api/gas-prices/export) is restored as-is -
                    # no geocoding, so a full backup of tens of thousands of
                    # stations reloads in minutes instead of a day of
                    # 1-request-per-second Nominatim calls.
                    #
                    coords = entry_coordinates(entry)

                    if coords is not None:
                        place_id = find_or_create_place_from_export(cur, place_text, entry, *coords)
                    else:
                        place_id, _, _ = find_or_create_place(cur, place_text)

                    upsert_gas_price_row(cur, place_id, price, brand)

                    conn.commit()

                    invalidate_gas_station_cache()

                    created += 1

                else:

                    stations = find_gas_stations_in_city(city_text)

                    if not stations:
                        raise ValueError(f"no gas stations found in {city_text}")

                    for station in stations:

                        station_place_id = find_or_create_place_from_osm_station(
                            cur, station["lat"], station["lng"], station["tags"]
                        )
                        station_brand = station["tags"].get("brand") or station["tags"].get("name")

                        upsert_gas_price_row(cur, station_place_id, price, station_brand)

                    conn.commit()

                    invalidate_gas_station_cache()

                    created += len(stations)

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
# "city" rows (see find_gas_stations_in_city()) always need an explicit
# header, since there's no sensible positional guess for them.
#
CSV_HEADER_ALIASES = {
    "description": "description",
    "address": "description",
    "location": "description",
    "lat": "lat",
    "latitude": "lat",
    "lng": "lng",
    "lon": "lng",
    "longitude": "lng",
    "city": "city",
    "name": "brand",
    "brand": "brand",
    "price": "price_per_gallon",
    "pricepergallon": "price_per_gallon",
}


#
# The columns GET /api/gas-prices/export writes, in order - also exactly
# what the upload reads back (see entry_coordinates() and
# find_or_create_place_from_export()). The place's own fields are prefixed
# place_ so they never collide with the upload's own column meanings:
# "address" is an alias for description there, and "city" means "add every
# station in this city" rather than "this station's city".
#
GAS_PRICE_EXPORT_COLUMNS = [
    "description", "brand", "price_per_gallon", "lat", "lng", "place_address",
    "place_continent", "place_country", "place_state", "place_city", "updated",
]


#
# A CSV header that isn't a known alias arrives normalized (punctuation
# stripped - see parse_gas_price_csv()), so "place_city" reads back as
# "placecity"; a JSON upload keeps the key as written. Accept either.
#
def export_field(entry, name):

    return entry.get(name) or entry.get(name.replace("_", "")) or None


def entry_coordinates(entry):

    try:
        lat = float(entry.get("lat"))
        lng = float(entry.get("lng"))
    except (TypeError, ValueError):
        return None

    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None

    return lat, lng


#
# The restore-from-export equivalent of find_or_create_place(): the row
# already says exactly where the station is and what its place looked like
# (address and location breakdown), so nothing is geocoded - the same
# dedup-by-rounded-coordinates check, then the row's own values as-is.
#
def find_or_create_place_from_export(cur, description, entry, lat, lng):

    lat = round_coord(lat)
    lng = round_coord(lng)

    cur.execute("SELECT id FROM places WHERE lat = %s AND lng = %s", (lat, lng))

    existing = cur.fetchone()

    if existing is not None:
        return existing[0]

    cur.execute(
        """
        INSERT INTO places (description, address, lat, lng, continent, country, state, city)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            description,
            export_field(entry, "place_address") or description,
            lat,
            lng,
            export_field(entry, "place_continent"),
            export_field(entry, "place_country"),
            export_field(entry, "place_state"),
            export_field(entry, "place_city"),
        )
    )

    return cur.fetchone()[0]


#
# Every gas station, as a flat CSV that POST /api/gas-prices/upload reads
# straight back (see GAS_PRICE_EXPORT_COLUMNS) - building the station list
# up from city searches and hand entry is slow, so this is its backup.
# Shared world data, not per save file.
#
@app.get("/api/gas-prices/export")
def export_gas_prices(_admin: None = Depends(require_admin)):

    conn = db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT p.description, g.brand, g.price_per_gallon, p.lat, p.lng, p.address,
            p.continent, p.country, p.state, p.city, g.updated
        FROM gas_prices g
        JOIN places p ON p.id = g.place_id
        ORDER BY p.country NULLS LAST, p.state NULLS LAST, p.city NULLS LAST, p.description
        """
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    out = io.StringIO()
    writer = csv.writer(out)

    writer.writerow(GAS_PRICE_EXPORT_COLUMNS)

    for row in rows:
        writer.writerow([
            "" if value is None else (value.isoformat() if isinstance(value, datetime) else value)
            for value in row
        ])

    filename = f"logisim-gas-stations-{local_now_naive():%Y-%m-%d}.csv"

    return Response(
        content=out.getvalue().encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


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
async def upload_gas_prices(file: UploadFile = File(...), _admin: None = Depends(require_admin)):

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
# Shared by _divert_to_gas_station() (current live position -> a chosen gas
# station) and _resume_trip_after_refuel() (that gas station -> wherever
# the vehicle actually still needs to go) - both already have real place
# ids and coordinates for both ends (no free-text geocoding needed, unlike
# _drive_vehicle_to()), so this only ever does the OSRM routing
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

    return insert_routed_path(
        cur, origin_place_id, origin_lat, origin_lng, destination_place_id, destination_lat, destination_lng
    )


#
# Routes origin -> destination via OSRM and saves it as a new path row,
# returning (path_id, route, distances_miles, max_speeds_mph).
#
def insert_routed_path(
    cur, origin_place_id, origin_lat, origin_lng, destination_place_id, destination_lat, destination_lng
):

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
# The part of a leg's route actually driven so far: every route point up to
# driven_miles, ending exactly at the vehicle's position there. A journey's
# earlier legs keep this (trips.journey_route_before) since their paths are
# forgotten once driven, so the map can still draw the whole trip.
#
def driven_route_prefix(route, distances_miles, driven_miles, position):

    index = bisect.bisect_right(distances_miles, driven_miles)

    return [list(point) for point in route[:index]] + [list(position)]


#
# Paths are behind-the-scenes and short-lived: one only exists while some
# vehicle is actually driving it. "Driving it" means a vehicle's latest
# trip is an uncancelled one on this path that hasn't settled yet (the
# vehicle isn't at the path's destination - same test
# settle_arrived_vehicles() uses), which covers STRANDED trips too, since
# those still owe the rest of the route. Anything else is deleted - a
# settled trip just keeps a NULL path_id and its own distance_miles.
#
# Called with the specific path ids that might have just become unused
# (an arrival, a cancelled trip, auto-divert's unchosen candidate routes),
# never a blanket sweep while running - a drive job commits its new path a
# moment before inserting the trip that uses it, and a blanket sweep in
# that gap would delete it. path_ids=None (sweep everything) is only for
# startup, before any job can be running.
#
def forget_unused_paths(cur, path_ids=None):

    if path_ids is not None:

        path_ids = [path_id for path_id in path_ids if path_id is not None]

        if not path_ids:
            return

    cur.execute(
        """
        DELETE FROM paths p
        WHERE (%s::int[] IS NULL OR p.id = ANY(%s::int[]))
        AND NOT EXISTS (
            SELECT 1
            FROM trips t
            JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.path_id = p.id
            AND t.cancelled_at IS NULL
            AND v.place_id IS DISTINCT FROM p.destination_place_id
            AND t.id = (
                SELECT t2.id FROM trips t2
                WHERE t2.vehicle_id = v.id
                ORDER BY t2.started_at DESC
                LIMIT 1
            )
        )
        RETURNING p.origin_place_id, p.destination_place_id
        """,
        (path_ids, path_ids)
    )

    #
    # A forgotten path's two ends may have been the last thing keeping
    # those places around (e.g. the spot a vehicle just drove away from).
    # The startup sweep (path_ids=None) sweeps every place itself instead.
    #
    if path_ids is not None:
        forget_unused_places(cur, [place_id for row in cur.fetchall() for place_id in row])


#
# Places are behind-the-scenes too, now that there's no Places tab - one
# only sticks around while something still points at it: a vehicle
# sitting there (sold ones included, they keep their last location), a
# path that's being driven, a gas price, or a detour still in progress
# that has to resume to it. Anything else is deleted; the next drive to
# the same description just geocodes it fresh. Same targeted-ids-only
# rule as forget_unused_paths() while running, for the same reason - a
# job can resolve a place a moment before inserting whatever row uses it.
#
def forget_unused_places(cur, place_ids=None):

    if place_ids is not None:

        place_ids = list({place_id for place_id in place_ids if place_id is not None})

        if not place_ids:
            return

    cur.execute(
        """
        DELETE FROM places p
        WHERE (%s::int[] IS NULL OR p.id = ANY(%s::int[]))
        AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.place_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM paths x WHERE x.origin_place_id = p.id OR x.destination_place_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM gas_prices g WHERE g.place_id = p.id)
        AND NOT EXISTS (
            SELECT 1 FROM loads l
            WHERE l.status IN ('accepted', 'loaded')
            AND (l.pickup_place_id = p.id OR l.dropoff_place_id = p.id)
        )
        AND NOT EXISTS (
            SELECT 1 FROM trips t
            WHERE t.resume_destination_place_id = p.id
            AND t.path_id IS NOT NULL
        )
        """,
        (place_ids, place_ids)
    )


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
    starting_fuel_gallons, resume_destination_place_id, auto_refuel, trip_meter_offset_miles=0.0,
    carried_fuel_cost=0.0, journey_origin=None, journey_id=None, journey_route_before=None
):

    #
    # trip_meter_offset_miles is how far the vehicle had already driven on
    # this same journey before this leg started - non-zero for both legs of
    # a gas-station detour, so the dashboard's trip meter (offset + this
    # leg's own distance_miles, see active_trips()) keeps running through
    # the stop the way a real one would, instead of resetting to 0 each leg.
    #
    path_id, route, distances_miles, max_speeds_mph = find_or_create_path_between_places(
        cur, origin_place_id, origin_lat, origin_lng, destination_place_id, destination_lat, destination_lng
    )

    cur.execute("UPDATE vehicles SET place_id = %s WHERE id = %s", (origin_place_id, vehicle_id))

    _, game_time = get_settings(conn, cur, vehicle_slot_id(cur, vehicle_id))

    zones = fetch_zones_for_paths(cur, [path_id]).get(path_id, [])

    #
    # The fuel this leg sets out with is worth what the tank cost per gallon
    # (see trips.fuel_value_dollars); carried_fuel_cost is the journey's
    # not-yet-refunded gas from earlier legs.
    #
    cur.execute("SELECT fuel_cost_per_gallon FROM vehicles WHERE id = %s", (vehicle_id,))
    fuel_value_dollars = starting_fuel_gallons * cur.fetchone()[0]

    #
    # A fresh journey (a Refuel drive) starts here; a detour or resumed leg
    # keeps the journey_origin it was handed.
    #
    if journey_origin is None:
        journey_origin = fetch_places_by_id(cur, [origin_place_id])[origin_place_id]["description"]

    cur.execute(
        """
        INSERT INTO trips
        (vehicle_id, path_id, distance_miles, traffic_base_datetime, traffic_bias, zones_snapshot, starting_fuel_gallons, resume_destination_place_id, auto_refuel, trip_meter_offset_miles, fuel_value_dollars, carried_fuel_cost, journey_origin, journey_id, journey_route_before)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (vehicle_id, path_id, distances_miles[-1], game_time, 1.0, json.dumps(zones), starting_fuel_gallons, resume_destination_place_id, auto_refuel, trip_meter_offset_miles, fuel_value_dollars, carried_fuel_cost, journey_origin, journey_id, json.dumps(journey_route_before or []))
    )

    trip_id = cur.fetchone()[0]

    #
    # A fresh journey (a Refuel drive) is identified by its own first leg.
    #
    if journey_id is None:
        cur.execute("UPDATE trips SET journey_id = id WHERE id = %s", (trip_id,))

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
#
# gas_station_place_ids is tried in order. With max_road_miles set (an
# auto-divert), each candidate is actually routed and the first whose road
# distance fits is taken; if none does, the shortest by road is the best
# remaining bet. Without it (a manual divert - the user picked one), the
# first is simply used.
#
def _divert_to_gas_station(
    vehicle_id, current_trip_id, lat, lng,
    partial_miles_driven, current_fuel_gallons,
    gas_station_place_ids, resume_destination_place_id, max_road_miles=None
):

    conn = db()
    cur = conn.cursor()

    try:

        cur.execute(
            """
            UPDATE trips t SET cancelled_at = NOW()
            FROM vehicles v, vehicle_models vm
            WHERE t.id = %s AND v.id = t.vehicle_id AND vm.id = v.vehicle_model_id
            RETURNING t.trip_meter_offset_miles, t.path_id, t.starting_fuel_gallons, t.roadside_refuel_count,
                vm.fuel_tank_gallons, t.fuel_value_dollars, t.carried_fuel_cost,
                COALESCE(t.journey_origin, (
                    SELECT pl.description FROM paths p JOIN places pl ON pl.id = p.origin_place_id WHERE p.id = t.path_id
                )),
                COALESCE(t.journey_id, t.id),
                t.journey_route_before
            """,
            (current_trip_id,)
        )

        (
            previous_trip_meter_offset_miles, cancelled_path_id, starting_fuel_gallons, roadside_refuel_count,
            fuel_tank_gallons, fuel_value_dollars, carried_fuel_cost, journey_origin, journey_id, route_before
        ) = cur.fetchone()

        #
        # The cancelled leg's path is about to be forgotten, so the stretch of
        # it actually driven is kept on the journey for the map.
        #
        cur.execute("SELECT route, distances_miles FROM paths WHERE id = %s", (cancelled_path_id,))

        cancelled_route, cancelled_distances_miles = cur.fetchone()

        journey_route_before = (route_before or []) + driven_route_prefix(
            cancelled_route, cancelled_distances_miles, partial_miles_driven, [lat, lng]
        )

        trip_meter_offset_miles = previous_trip_meter_offset_miles + partial_miles_driven

        #
        # The cancelled leg's burned gas isn't refunded yet - the journey
        # hasn't finished - so its cost rides along into the detour leg
        # (trips.carried_fuel_cost), and what's left in the tank keeps the
        # pool's average price.
        #
        total_fuel_gallons, pool_cost_per_gallon = trip_fuel_pool(
            starting_fuel_gallons, roadside_refuel_count, fuel_tank_gallons, fuel_value_dollars
        )

        journey_fuel_cost = carried_fuel_cost + max(0.0, total_fuel_gallons - current_fuel_gallons) * pool_cost_per_gallon

        cur.execute(
            "UPDATE vehicles SET fuel_cost_per_gallon = %s WHERE id = %s",
            (pool_cost_per_gallon, vehicle_id)
        )

        #
        # The cancelled trip's path, plus every candidate route auto-divert
        # tried below - forgotten before commit unless the new detour trip
        # ends up driving it (see forget_unused_paths()).
        #
        possibly_unused_path_ids = [cancelled_path_id]

        cur.execute(
            "UPDATE vehicles SET starting_mileage = starting_mileage + %s, fuel_gallons = %s WHERE id = %s",
            (partial_miles_driven, current_fuel_gallons, vehicle_id)
        )

        origin_place_id = find_or_create_place_by_coords(cur, lat, lng)

        stations_by_id = fetch_places_by_id(cur, gas_station_place_ids)

        gas_station_place_id = gas_station_place_ids[0]

        if max_road_miles is not None:

            shortest = None

            for candidate_id in gas_station_place_ids:

                candidate = stations_by_id[candidate_id]

                candidate_path_id, _, candidate_distances_miles, _ = find_or_create_path_between_places(
                    cur, origin_place_id, lat, lng, candidate_id, candidate["lat"], candidate["lng"]
                )

                possibly_unused_path_ids.append(candidate_path_id)

                road_miles = candidate_distances_miles[-1]

                if shortest is None or road_miles < shortest[0]:
                    shortest = (road_miles, candidate_id)

                if road_miles <= max_road_miles:
                    break

            gas_station_place_id = candidate_id if road_miles <= max_road_miles else shortest[1]

        station = stations_by_id[gas_station_place_id]

        trip_id = start_diversion_trip(
            conn, cur, vehicle_id,
            origin_place_id, lat, lng,
            gas_station_place_id, station["lat"], station["lng"],
            current_fuel_gallons, resume_destination_place_id, True, trip_meter_offset_miles, journey_fuel_cost,
            journey_origin, journey_id, journey_route_before
        )

        forget_unused_paths(cur, possibly_unused_path_ids)

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
            [gas_station_place_id], resume_destination_place_id
        )
    except Exception as e:
        update_job(job_id, status="error", error=getattr(e, "detail", str(e)))
        return

    update_job(job_id, status="done", result=result)


#
# Same as _run_divert_job(), except a failure (e.g. OSRM/Nominatim briefly
# unreachable) releases the trip's auto-divert claim instead of leaving it
# set - otherwise one transient error would stop auto-refuel from ever
# retrying for the rest of this trip, and the vehicle would just run dry.
#
def _run_auto_divert_job(
    job_id, vehicle_id, current_trip_id, lat, lng,
    partial_miles_driven, current_fuel_gallons,
    gas_station_place_ids, resume_destination_place_id, max_road_miles
):

    update_job(job_id, status="running")

    try:
        result = _divert_to_gas_station(
            vehicle_id, current_trip_id, lat, lng,
            partial_miles_driven, current_fuel_gallons,
            gas_station_place_ids, resume_destination_place_id, max_road_miles
        )
    except Exception as e:

        conn = db()
        cur = conn.cursor()
        cur.execute("UPDATE trips SET auto_divert_claimed_at = NULL WHERE id = %s", (current_trip_id,))
        conn.commit()
        cur.close()
        conn.close()

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
def _resume_trip_after_refuel(
    vehicle_id, origin_place_id, destination_place_id, auto_refuel, trip_meter_offset_miles=0.0, carried_fuel_cost=0.0,
    journey_origin=None, journey_id=None, journey_route_before=None
):

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
            fuel_gallons, None, auto_refuel, trip_meter_offset_miles, carried_fuel_cost, journey_origin, journey_id,
            journey_route_before
        )

        conn.commit()

        return {"vehicle_id": vehicle_id, "trip_id": trip_id}

    finally:
        cur.close()
        conn.close()


def _run_resume_trip_job(
    job_id, vehicle_id, origin_place_id, destination_place_id, auto_refuel, trip_meter_offset_miles=0.0,
    carried_fuel_cost=0.0, journey_origin=None, journey_id=None, journey_route_before=None
):

    update_job(job_id, status="running")

    try:
        result = _resume_trip_after_refuel(
            vehicle_id, origin_place_id, destination_place_id, auto_refuel, trip_meter_offset_miles, carried_fuel_cost,
            journey_origin, journey_id, journey_route_before
        )
    except Exception as e:
        update_job(job_id, status="error", error=getattr(e, "detail", str(e)))
        return

    update_job(job_id, status="done", result=result)


#
# ---------- Loads: the work ----------
#
# Real-world shipments for each save file's vehicles to carry: something
# concrete (office furniture, a wedding party...) from one real US city to
# another, for pay. Vehicles don't go anywhere on their own any more - a
# load is picked off the load board for a parked vehicle, the vehicle
# drives to the pickup (empty miles, if it isn't there already), loads up,
# drives to the delivery city and is paid on arrival, less if it's late.
#
# Cities come from data/us_cities.csv: every US city and town of 10,000+
# people (Hawaii aside - no road there) from GeoNames' cities5000 list
# (CC BY 4.0, https://www.geonames.org), bundled so nothing is looked up
# live. A load's pickup and delivery become places only once it's accepted
# (ensure_city_place()), and the legs drive between them like any other
# trip - refuel detours, stranding and roadside fuel included.
#
# Loads are made on demand: a vehicle's board (GET /api/vehicles/{id}/loads)
# tops itself up to LOAD_BOARD_TARGET that fit it within
# LOAD_BOARD_RADIUS_MILES, and anything left unclaimed past its expiry (game
# time) drops off. Each file has its own board.
#
US_CITIES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "us_cities.csv")


def read_us_cities():

    with open(US_CITIES_PATH, encoding="utf-8", newline="") as f:
        cities = [
            {
                "name": row["name"], "state": row["state"],
                "lat": float(row["lat"]), "lng": float(row["lng"]), "population": int(row["population"])
            }
            for row in csv.DictReader(f)
        ]

    return (
        cities,
        np.radians(np.array([city["lat"] for city in cities])),
        np.radians(np.array([city["lng"] for city in cities])),
        np.array([city["population"] for city in cities], dtype=float)
    )


US_CITIES, US_CITY_LAT_RADIANS, US_CITY_LNG_RADIANS, US_CITY_POPULATIONS = read_us_cities()


def miles_to_us_cities(lat, lng):

    lat = math.radians(lat)
    lng = math.radians(lng)

    a = (
        np.sin((US_CITY_LAT_RADIANS - lat) / 2) ** 2
        + math.cos(lat) * np.cos(US_CITY_LAT_RADIANS) * np.sin((US_CITY_LNG_RADIANS - lng) / 2) ** 2
    )

    return 2 * EARTH_RADIUS_MILES * np.arcsin(np.sqrt(np.minimum(a, 1.0)))


LOAD_BOARD_RADIUS_MILES = 120
LOAD_BOARD_TARGET = 8

#
# Roads aren't straight: the board's mileage estimates are the straight-line
# distance times this. The real route is only worked out once a load's
# accepted.
#
LOAD_ROAD_FACTOR = 1.25

LOAD_DESTINATION_MILES = (30, 700)
LOAD_EXPIRY_GAME_HOURS = (8, 36)

#
# Time allowed to deliver, from accepting: the estimated miles (to the
# pickup and on to the delivery) at LOAD_PLANNING_MPH, times
# LOAD_DEADLINE_SLACK, plus LOAD_DEADLINE_EXTRA_HOURS for loading, fuel and
# the unexpected.
#
LOAD_PLANNING_MPH = 45
LOAD_DEADLINE_SLACK = 1.5
LOAD_DEADLINE_EXTRA_HOURS = 2

#
# Late pays LOAD_LATE_PAY of the price; more than the whole allowed time
# late pays LOAD_VERY_LATE_PAY.
#
LOAD_LATE_PAY = 0.75
LOAD_VERY_LATE_PAY = 0.4

#
# Parked this close to a load's pickup city counts as there already.
#
LOAD_AT_PICKUP_MILES = 3

#
# What gets moved: (cargo, kind, smallest, largest) - freight in cubic feet,
# passengers in people. A vehicle carries freight up to its cargo capacity
# and passengers up to its seats less the driver's.
#
LOAD_CARGO = [
    ("Office furniture", "freight", 80, 320),
    ("Restaurant produce", "freight", 40, 200),
    ("Boxed electronics", "freight", 30, 160),
    ("Medical supplies", "freight", 20, 100),
    ("Kitchen appliances", "freight", 60, 260),
    ("Moving boxes", "freight", 50, 320),
    ("Auto parts", "freight", 20, 180),
    ("Bakery goods", "freight", 20, 90),
    ("Trade show displays", "freight", 40, 220),
    ("Fresh flowers", "freight", 20, 120),
    ("Craft beer kegs", "freight", 40, 160),
    ("Hardware store restock", "freight", 60, 280),
    ("Library books", "freight", 30, 140),
    ("Bicycles", "freight", 40, 200),
    ("Wedding party", "passengers", 3, 12),
    ("Sports team", "passengers", 6, 15),
    ("Airport shuttle group", "passengers", 1, 8),
    ("Tour group", "passengers", 4, 14),
    ("Church choir", "passengers", 4, 12),
]

#
# Pay: per estimated loaded mile, a base plus more for a bigger load, plus a
# flat handling fee. Freight pays $1.10 + $0.0045 per cu ft per mile, so a
# full 300 cu ft van earns about $2.45 a mile against roughly $0.50 of gas -
# but the trip to the pickup is unpaid.
#
LOAD_PAY = {
    "freight": {"per_mile": 1.10, "per_unit_mile": 0.0045, "fee": 40},
    "passengers": {"per_mile": 0.85, "per_unit_mile": 0.15, "fee": 30},
}


def load_pay(kind, quantity, miles):

    rate = LOAD_PAY[kind]

    return round(miles * (rate["per_mile"] + rate["per_unit_mile"] * quantity) + rate["fee"])


def load_capacity(vehicle_model):

    return {
        "freight": vehicle_model["cargo_capacity_cuft"] or 0,
        "passengers": max(0, (vehicle_model["person_capacity"] or 0) - 1),
    }


def city_label(name, state):

    return f"{name}, {state}"


def slot_game_time(cur, slot_id):

    #
    # get_settings()'s clock without its first-use insert (and commit), so
    # it's safe mid-transaction - settle_arrived_vehicles() uses it.
    #
    cur.execute("SELECT time_multiplier, anchor_real_utc, anchor_game_time FROM settings WHERE id = %s", (slot_id,))

    multiplier, anchor_real_utc, anchor_game_time = cur.fetchone()

    return anchor_game_time + timedelta(seconds=(datetime.utcnow() - anchor_real_utc).total_seconds() * multiplier)


#
# Adds `count` new loads near (lat, lng) sized to fit `capacity` (see
# load_capacity()): pickups in cities within the board's radius (bigger
# cities more often), deliveries 30-700 miles on (bigger cities, and
# medium-length runs, more often).
#
def generate_loads(cur, slot_id, lat, lng, game_now, capacity, count):

    nearby = miles_to_us_cities(lat, lng)
    pickup_candidates = np.flatnonzero(nearby <= LOAD_BOARD_RADIUS_MILES)

    if not len(pickup_candidates):
        pickup_candidates = np.argsort(nearby)[:5]

    cargo_choices = [
        cargo for cargo in LOAD_CARGO
        if capacity[cargo[1]] >= cargo[2]
    ]

    if not cargo_choices:
        return 0

    created = 0

    for _ in range(count):

        weights = US_CITY_POPULATIONS[pickup_candidates] ** 0.6
        pickup = int(random.choices(pickup_candidates, weights=weights)[0])

        onward = miles_to_us_cities(US_CITIES[pickup]["lat"], US_CITIES[pickup]["lng"])
        low, high = LOAD_DESTINATION_MILES
        destination_candidates = np.flatnonzero((onward >= low) & (onward <= high))

        if not len(destination_candidates):
            continue

        distances = onward[destination_candidates]
        weights = (
            US_CITY_POPULATIONS[destination_candidates] ** 0.5
            * (np.exp(-((distances - 250) / 300) ** 2) + 0.2)
        )
        destination = int(random.choices(destination_candidates, weights=weights)[0])

        #
        # Passengers only now and then, and only for a vehicle with seats
        # to spare.
        #
        freight = [cargo for cargo in cargo_choices if cargo[1] == "freight"]
        passengers = [cargo for cargo in cargo_choices if cargo[1] == "passengers"]
        pool = passengers if passengers and (not freight or random.random() < 0.25) else freight

        cargo, kind, smallest, largest = random.choice(pool)
        quantity = random.randint(smallest, int(min(largest, capacity[kind])))

        miles = float(onward[destination]) * LOAD_ROAD_FACTOR
        origin_city = US_CITIES[pickup]
        destination_city = US_CITIES[destination]

        cur.execute(
            """
            INSERT INTO loads (
                slot_id, cargo, kind, quantity,
                origin_name, origin_state, origin_lat, origin_lng,
                destination_name, destination_state, destination_lat, destination_lng,
                estimated_miles, pay, posted_game_time, expires_game_time
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                slot_id, cargo, kind, quantity,
                origin_city["name"], origin_city["state"], origin_city["lat"], origin_city["lng"],
                destination_city["name"], destination_city["state"], destination_city["lat"], destination_city["lng"],
                round(miles, 1), load_pay(kind, quantity, miles), game_now,
                game_now + timedelta(hours=random.uniform(*LOAD_EXPIRY_GAME_HOURS))
            )
        )

        created += 1

    return created


LOAD_COLUMNS = """
    id, cargo, kind, quantity, origin_name, origin_state, origin_lat, origin_lng,
    destination_name, destination_state, destination_lat, destination_lng,
    estimated_miles, pay, expires_game_time, status, vehicle_id, deliver_by_game_time,
    accepted_game_time, pickup_place_id, dropoff_place_id
"""


def load_dict(row):

    return {
        "id": row[0],
        "cargo": row[1],
        "kind": row[2],
        "quantity": row[3],
        "origin": city_label(row[4], row[5]),
        "origin_lat": row[6],
        "origin_lng": row[7],
        "destination": city_label(row[8], row[9]),
        "destination_lat": row[10],
        "destination_lng": row[11],
        "estimated_miles": row[12],
        "pay": float(row[13]),
        "expires_game_time": row[14].isoformat(),
        "status": row[15],
        "vehicle_id": row[16],
        "deliver_by_game_time": row[17].isoformat() if row[17] else None,
        "accepted_game_time": row[18].isoformat() if row[18] else None,
    }


def load_allowed_hours(pickup_miles, load_miles):

    return (pickup_miles + load_miles) / LOAD_PLANNING_MPH * LOAD_DEADLINE_SLACK + LOAD_DEADLINE_EXTRA_HOURS


def vehicle_position(cur, vehicle_id):

    cur.execute(
        """
        SELECT v.slot_id, v.sold, v.place_id, p.lat, p.lng, p.description, v.vehicle_model_id
        FROM vehicles v JOIN places p ON p.id = v.place_id
        WHERE v.id = %s
        """,
        (vehicle_id,)
    )

    return cur.fetchone()


#
# The load board for one vehicle: available loads it can carry, picked up
# within LOAD_BOARD_RADIUS_MILES of where it's parked - nearest pickup
# first - with what each would mean for this vehicle: the empty miles to the
# pickup and the time it would have to deliver if accepted now.
#
@app.get("/api/vehicles/{id}/loads")
def vehicle_load_board(id: int, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(id, slot)

    conn = db()
    cur = conn.cursor()

    try:

        _, game_now = get_settings(conn, cur, slot)

        position = vehicle_position(cur, id)

        if position is None or position[1]:
            raise HTTPException(status_code=404, detail="Vehicle not found")

        _, _, _, lat, lng, location, vehicle_model_id = position
        capacity = load_capacity(fetch_vehicle_models_by_id(cur, [vehicle_model_id])[vehicle_model_id])

        cur.execute(
            "UPDATE loads SET status = 'expired' WHERE slot_id = %s AND status = 'available' AND expires_game_time < %s",
            (slot, game_now)
        )

        def board():

            cur.execute(
                f"SELECT {LOAD_COLUMNS} FROM loads WHERE slot_id = %s AND status = 'available'",
                (slot,)
            )

            entries = []

            for row in cur.fetchall():

                load = load_dict(row)

                if load["quantity"] > capacity[load["kind"]]:
                    continue

                pickup_miles = haversine_miles(lat, lng, load["origin_lat"], load["origin_lng"])

                if pickup_miles > LOAD_BOARD_RADIUS_MILES:
                    continue

                pickup_miles = 0.0 if pickup_miles <= LOAD_AT_PICKUP_MILES else pickup_miles * LOAD_ROAD_FACTOR
                allowed_hours = load_allowed_hours(pickup_miles, load["estimated_miles"])

                entries.append({
                    **load,
                    "pickup_miles": round(pickup_miles, 1),
                    "allowed_hours": round(allowed_hours, 1),
                    "deliver_by_if_accepted": (game_now + timedelta(hours=allowed_hours)).isoformat(),
                })

            return entries

        entries = board()

        if len(entries) < LOAD_BOARD_TARGET:
            generate_loads(cur, slot, lat, lng, game_now, capacity, LOAD_BOARD_TARGET - len(entries))
            entries = board()

        conn.commit()

        entries.sort(key=lambda load: (load["pickup_miles"], -load["pay"]))

        return {"location": location, "game_time": game_now.isoformat(), "loads": entries}

    finally:
        cur.close()
        conn.close()


#
# The Loads page (loads.js): every load in this save file - on the board,
# in progress, delivered, expired, failed - newest first, filtered by
# status (LOAD_STATUS_FILTERS) and/or vehicle, a page at a time
# (before_id, like the ledger). Also each status's count and what
# deliveries have earned in total, for the page's summary line.
#
LOAD_STATUS_FILTERS = {
    "available": ("available",),
    "in_progress": ("accepted", "loaded"),
    "delivered": ("delivered",),
    "expired": ("expired",),
    "failed": ("failed",),
}


@app.get("/api/loads")
def list_loads(
    status: Optional[str] = None, vehicle_id: Optional[int] = None, limit: int = 100,
    before_id: Optional[int] = None, slot: int = Depends(current_slot)
):

    if status is not None and status not in LOAD_STATUS_FILTERS:
        raise HTTPException(status_code=400, detail=f"status must be one of {', '.join(LOAD_STATUS_FILTERS)}")

    limit = max(1, min(limit, 500))

    conn = db()
    cur = conn.cursor()

    try:

        _, game_now = get_settings(conn, cur, slot)

        cur.execute(
            "UPDATE loads SET status = 'expired' WHERE slot_id = %s AND status = 'available' AND expires_game_time < %s",
            (slot, game_now)
        )

        conn.commit()

        statuses = list(LOAD_STATUS_FILTERS[status]) if status else None

        cur.execute(
            f"""
            SELECT {LOAD_COLUMNS}, picked_up_game_time, delivered_game_time, paid,
                (SELECT v.name FROM vehicles v WHERE v.id = loads.vehicle_id)
            FROM loads
            WHERE slot_id = %s
            AND (%s::text[] IS NULL OR status = ANY(%s::text[]))
            AND (%s::int IS NULL OR vehicle_id = %s::int)
            AND (%s::int IS NULL OR id < %s::int)
            ORDER BY id DESC
            LIMIT %s
            """,
            (slot, statuses, statuses, vehicle_id, vehicle_id, before_id, before_id, limit + 1)
        )

        rows = cur.fetchall()

        cur.execute(
            """
            SELECT status, COUNT(*), COALESCE(SUM(paid), 0)
            FROM loads WHERE slot_id = %s
            GROUP BY status
            """,
            (slot,)
        )

        counts = {}
        earned = 0.0

        for row_status, count, paid in cur.fetchall():
            counts[row_status] = count
            earned += float(paid)

    finally:
        cur.close()
        conn.close()

    loads = []

    for row in rows[:limit]:
        loads.append({
            **load_dict(row),
            "picked_up_game_time": row[21].isoformat() if row[21] else None,
            "delivered_game_time": row[22].isoformat() if row[22] else None,
            "paid": float(row[23]) if row[23] is not None else None,
            "vehicle_name": row[24],
        })

    return {
        "game_time": game_now.isoformat(),
        "loads": loads,
        "has_more": len(rows) > limit,
        "counts": {
            "available": counts.get("available", 0),
            "in_progress": counts.get("accepted", 0) + counts.get("loaded", 0),
            "delivered": counts.get("delivered", 0),
            "expired": counts.get("expired", 0),
            "failed": counts.get("failed", 0),
        },
        "earned": round(earned, 2),
    }


#
# A load's city as a place a trip can drive to - saved directly from the
# bundled coordinates (no geocode), and reused if that city's already a
# place.
#
def ensure_city_place(cur, name, state, lat, lng):

    description = city_label(name, state)
    saved = find_saved_place(cur, description)

    if saved is not None:
        return saved[0]

    lat = round_coord(lat)
    lng = round_coord(lng)

    cur.execute("SELECT id FROM places WHERE lat = %s AND lng = %s", (lat, lng))

    existing = cur.fetchone()

    if existing is not None:
        return existing[0]

    cur.execute(
        """
        INSERT INTO places (description, address, lat, lng, continent, country, state, city)
        VALUES (%s, %s, %s, %s, 'North America', 'United States', %s, %s)
        RETURNING id
        """,
        (description, f"{description}, United States", lat, lng, state, name)
    )

    return cur.fetchone()[0]


class AcceptLoadRequest(BaseModel):
    vehicle_id: int


#
# Starts one leg of a load - to the pickup or on to the delivery - as a
# background job (routing takes a moment), the same way a refuel stop's
# next leg starts. If it can't be routed, a load not yet picked up goes back
# on the board; one already aboard is marked failed.
#
def _run_load_leg_job(job_id, vehicle_id, origin_place_id, destination_place_id, load_id):

    update_job(job_id, status="running")

    try:
        result = _resume_trip_after_refuel(vehicle_id, origin_place_id, destination_place_id, False)
    except Exception as e:

        conn = db()
        cur = conn.cursor()

        try:
            cur.execute(
                """
                UPDATE loads SET
                    status = CASE WHEN status = 'accepted' THEN 'available' ELSE 'failed' END,
                    vehicle_id = CASE WHEN status = 'accepted' THEN NULL ELSE vehicle_id END
                WHERE id = %s
                """,
                (load_id,)
            )
            conn.commit()
        finally:
            cur.close()
            conn.close()

        update_job(job_id, status="error", error=getattr(e, "detail", str(e)))
        return

    update_job(job_id, status="done", result=result)


def start_load_leg(cur, slot_id, vehicle_id, origin_place_id, destination_place_id, load_id):

    job_id = create_job("load_leg", cur=cur, slot_id=slot_id, vehicle_id=vehicle_id)

    return job_id, (job_id, vehicle_id, origin_place_id, destination_place_id, load_id)


@app.post("/api/loads/{load_id}/accept", status_code=202)
def accept_load(load_id: int, req: AcceptLoadRequest, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(req.vehicle_id, slot)

    conn = db()
    cur = conn.cursor()

    try:

        settle_arrived_vehicles(conn, cur)

        _, game_now = get_settings(conn, cur, slot)

        position = vehicle_position(cur, req.vehicle_id)

        if position is None or position[1]:
            raise HTTPException(status_code=404, detail="Vehicle not found")

        _, _, vehicle_place_id, lat, lng, _, vehicle_model_id = position

        if vehicle_is_busy(cur, req.vehicle_id):
            raise HTTPException(status_code=409, detail="That vehicle is on a trip - it can take a load once it's parked")

        cur.execute(
            "SELECT 1 FROM loads WHERE vehicle_id = %s AND status IN ('accepted', 'loaded')",
            (req.vehicle_id,)
        )

        if cur.fetchone() is not None:
            raise HTTPException(status_code=409, detail="That vehicle already has a load")

        cur.execute(f"SELECT {LOAD_COLUMNS} FROM loads WHERE id = %s AND slot_id = %s FOR UPDATE", (load_id, slot))

        row = cur.fetchone()

        if row is None:
            raise HTTPException(status_code=404, detail="Load not found")

        load = load_dict(row)

        if load["status"] != "available" or row[14] < game_now:
            raise HTTPException(status_code=409, detail="That load has been taken or has expired")

        capacity = load_capacity(fetch_vehicle_models_by_id(cur, [vehicle_model_id])[vehicle_model_id])

        if load["quantity"] > capacity[load["kind"]]:
            raise HTTPException(status_code=409, detail="That load doesn't fit this vehicle")

        pickup_place_id = ensure_city_place(cur, row[4], row[5], row[6], row[7])
        dropoff_place_id = ensure_city_place(cur, row[8], row[9], row[10], row[11])

        straight_miles = haversine_miles(lat, lng, load["origin_lat"], load["origin_lng"])
        at_pickup = straight_miles <= LOAD_AT_PICKUP_MILES
        pickup_miles = 0.0 if at_pickup else straight_miles * LOAD_ROAD_FACTOR

        deliver_by = game_now + timedelta(hours=load_allowed_hours(pickup_miles, load["estimated_miles"]))

        cur.execute(
            """
            UPDATE loads SET
                status = %s, vehicle_id = %s, accepted_game_time = %s, deliver_by_game_time = %s,
                picked_up_game_time = %s, pickup_place_id = %s, dropoff_place_id = %s
            WHERE id = %s
            """,
            (
                "loaded" if at_pickup else "accepted", req.vehicle_id, game_now, deliver_by,
                game_now if at_pickup else None, pickup_place_id, dropoff_place_id, load_id
            )
        )

        job_id, leg = start_load_leg(
            cur, slot, req.vehicle_id, vehicle_place_id,
            dropoff_place_id if at_pickup else pickup_place_id, load_id
        )

        conn.commit()

    finally:
        cur.close()
        conn.close()

    job_executor.submit(_run_load_leg_job, *leg)

    return {"job_id": job_id, "picked_up": at_pickup, "deliver_by_game_time": deliver_by.isoformat()}


#
# Called by settle_arrived_vehicles() when a vehicle finishes a trip (not
# just a refuel stop on the way): picks up its load at the pickup (and
# queues the leg to the delivery), or delivers it and pays - less if it's
# late. Arriving anywhere else with a load still to move queues the leg it
# still needs. Returns that leg, if any, for the caller to start once its
# transaction commits.
#
def handle_load_arrival(cur, slot_id, vehicle_id, vehicle_name, arrived_place_id):

    cur.execute(
        f"""
        SELECT {LOAD_COLUMNS}
        FROM loads WHERE vehicle_id = %s AND status IN ('accepted', 'loaded')
        FOR UPDATE
        """,
        (vehicle_id,)
    )

    row = cur.fetchone()

    if row is None:
        return None

    load = load_dict(row)
    pickup_place_id, dropoff_place_id = row[19], row[20]
    game_now = slot_game_time(cur, slot_id)

    if load["status"] == "accepted":

        if arrived_place_id != pickup_place_id:
            return start_load_leg(cur, slot_id, vehicle_id, arrived_place_id, pickup_place_id, load["id"])[1]

        cur.execute(
            "UPDATE loads SET status = 'loaded', picked_up_game_time = %s WHERE id = %s",
            (game_now, load["id"])
        )

        return start_load_leg(cur, slot_id, vehicle_id, pickup_place_id, dropoff_place_id, load["id"])[1]

    if arrived_place_id != dropoff_place_id:
        return start_load_leg(cur, slot_id, vehicle_id, arrived_place_id, dropoff_place_id, load["id"])[1]

    #
    # Delivered. On time pays in full; late pays LOAD_LATE_PAY; later than
    # the whole time it was given pays LOAD_VERY_LATE_PAY.
    #
    deliver_by = row[17]
    allowed = deliver_by - row[18]
    late_by = game_now - deliver_by

    if late_by <= timedelta(0):
        share, note = 1.0, "on time"
    elif late_by <= allowed:
        share, note = LOAD_LATE_PAY, f"late - {round(LOAD_LATE_PAY * 100)}% pay"
    else:
        share, note = LOAD_VERY_LATE_PAY, f"very late - {round(LOAD_VERY_LATE_PAY * 100)}% pay"

    paid = round(load["pay"] * share, 2)

    cur.execute(
        "UPDATE loads SET status = 'delivered', delivered_game_time = %s, paid = %s WHERE id = %s",
        (game_now, paid, load["id"])
    )

    record_money(
        cur, slot_id, paid, "load_payment", f"Delivered {load['cargo'].lower()} ({note})",
        vehicle_id, vehicle_name, load["destination"], journey_label(load["origin"], load["destination"])
    )

    return None


#
# Each vehicle's load in progress (accepted or aboard), for its card and
# spotlight - GET /api/vehicles.
#
def fetch_active_loads(cur, vehicle_ids):

    if not vehicle_ids:
        return {}

    cur.execute(
        f"SELECT {LOAD_COLUMNS} FROM loads WHERE vehicle_id = ANY(%s) AND status IN ('accepted', 'loaded')",
        (list(vehicle_ids),)
    )

    return {row[16]: load_dict(row) for row in cur.fetchall()}


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



@app.post("/api/paths/{path_id}/zones")
def create_zone(path_id: int, req: RoadZoneRequest, _admin: None = Depends(require_admin)):

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
def update_zone(id: int, req: RoadZoneRequest, _admin: None = Depends(require_admin)):

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
def delete_zone(id: int, _admin: None = Depends(require_admin)):

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



#
# Shared by POST /api/trips and the drive job (_drive_vehicle_to()) -
# raises HTTPException for anything that keeps the vehicle from leaving.
#
def start_trip_on_path(vehicle_id, path_id, traffic_bias=1.0, simulated_datetime=None):

    conn = db()
    cur = conn.cursor()

    try:
        slot_id = vehicle_slot_id(cur, vehicle_id)
    except HTTPException:
        cur.close()
        conn.close()
        raise

    time_multiplier, game_time = get_settings(conn, cur, slot_id)

    #
    # Settle before reading place_id below - otherwise a vehicle whose
    # previous trip just arrived (but hasn't been read since, e.g. GET
    # /api/vehicles hasn't been polled yet) would still show its old,
    # pre-arrival location here.
    #
    settle_arrived_vehicles(conn, cur)

    cur.execute("SELECT sold, place_id, fuel_gallons, fuel_cost_per_gallon FROM vehicles WHERE id=%s", (vehicle_id,))

    vehicle_row = cur.fetchone()

    if vehicle_row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Vehicle not found")

    sold, vehicle_place_id, vehicle_fuel_gallons, vehicle_fuel_cost_per_gallon = vehicle_row

    if sold:
        cur.close()
        conn.close()
        raise HTTPException(status_code=409, detail="Vehicle has been sold")

    cur.execute(
        "SELECT route, distances_miles, max_speeds_mph, origin_place_id FROM paths WHERE id=%s",
        (path_id,)
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
        (vehicle_id, time_multiplier)
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
        to_local_naive(simulated_datetime) if simulated_datetime else game_time
    )

    #
    # A trip freezes its own snapshot of the path's zones at creation time,
    # same as traffic_base_datetime/traffic_bias - so a zone added or
    # removed later doesn't retroactively contradict a schedule (and
    # displayed speed) already computed for a trip in progress.
    #
    zones = fetch_zones_for_paths(cur, [path_id]).get(path_id, [])

    #
    # Fuel isn't checked against the path's distance here - a vehicle is
    # allowed to depart without enough of it (see resolve_trip_progress()),
    # and simply runs dry (STRANDED) partway down the route instead of
    # being blocked from leaving at all.
    #
    cur.execute(
        """
        INSERT INTO trips (vehicle_id, path_id, distance_miles, traffic_base_datetime, traffic_bias, zones_snapshot, starting_fuel_gallons, fuel_value_dollars, journey_origin)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            vehicle_id, path_id, distances_miles[-1], traffic_base_datetime, traffic_bias, json.dumps(zones),
            vehicle_fuel_gallons, vehicle_fuel_gallons * vehicle_fuel_cost_per_gallon,
            fetch_places_by_id(cur, [vehicle_place_id])[vehicle_place_id]["description"]
        )
    )

    trip_id = cur.fetchone()[0]

    cur.execute("UPDATE trips SET journey_id = id WHERE id = %s", (trip_id,))

    #
    # Needs the trip's own id (for jitter/incident seeding), so this can
    # only run after the row above exists.
    #
    realized_seconds = build_trip_schedule(
        distances_miles, max_speeds_mph, zones, traffic_base_datetime, traffic_bias, trip_id
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

        "vehicle_id": vehicle_id,

        "path_id": path_id,

        "position": route[0],

        "route": route,

        "duration_seconds": realized_duration_seconds,

        "sim_duration_seconds": realized_duration_seconds / time_multiplier,

        "status": "DRIVING"
    }


@app.post("/api/trips")
def start_trip(req: StartTripRequest, slot: int = Depends(current_slot)):

    assert_vehicle_in_slot(req.vehicle_id, slot)

    return start_trip_on_path(req.vehicle_id, req.path_id, req.traffic_bias, req.simulated_datetime)


#
# Event-driven refresh for the frontend's Config tab: rather than polling
# every second, the client asks for its chosen refresh_on mode and gets
# back next_refresh_seconds - how many real seconds until the next moment
# any driving trip hits that kind of event - and doesn't call again until
# then. Every trip's schedule is fixed at departure (realized_seconds), so
# these are exact, not estimates:
#
#   - "arrival": the trip ends - arrives, or the tank runs dry (STRANDED).
#   - "miles": the trip crosses its next multiple of every_miles, plus the
#     end of the trip (no further mile marks can come after it).
#   - "refill": a gas-station leg (auto_refuel) arrives - that's when the
#     tank is topped up. A regular trip that can't finish on what's in the
#     tank also gets checkpoints at the AUTO_REFUEL_FUEL_FRACTION low mark
#     and the dry point: auto-divert starts its detour on the server by
#     then, and the client can only schedule that detour's arrival once a
#     refresh has actually seen it.
#   - "never": no automatic refresh at all.
#
REFRESH_MODES = ("never", "refill", "miles", "arrival")

TRIP_STARTING_JOB_TYPES = (
    "load_leg",
    "drive_to_destination",
    "resume_trip_after_refuel",
    "auto_divert_to_gas_station",
    "drive_to_refuel",
    "divert_to_gas_station",
)

TRIP_JOB_RECHECK_SECONDS = 2.0


def seconds_until_refresh_event(
    refresh_on,
    every_miles,
    distances_miles,
    realized_seconds,
    realized_duration_seconds,
    mpg,
    fuel_tank_gallons,
    starting_fuel_gallons,
    roadside_refuel_count,
    auto_refuel,
    paused_seconds,
    elapsed_real_seconds,
    time_multiplier,
    current_miles
):

    if refresh_on == "never":
        return None

    total_miles = distances_miles[-1]
    schedule_elapsed = elapsed_real_seconds * time_multiplier - paused_seconds

    #
    # Same fuel math as resolve_trip_progress() - where (and when) the trip
    # actually stops, whether at its destination or wherever it runs dry.
    #
    total_fuel_available = None
    end_miles = total_miles
    end_elapsed = realized_duration_seconds

    if mpg and mpg > 0:

        total_fuel_available = starting_fuel_gallons + roadside_refuel_count * fuel_tank_gallons

        if total_fuel_available * mpg < total_miles:
            end_miles = total_fuel_available * mpg
            end_elapsed = interpolate_seconds_at_distance(distances_miles, realized_seconds, end_miles)

    event_miles = []
    event_elapsed = []

    if refresh_on == "arrival":
        event_elapsed.append(end_elapsed)

    elif refresh_on == "miles":

        if every_miles and every_miles > 0:

            next_mark = (math.floor(current_miles / every_miles) + 1) * every_miles

            if next_mark < end_miles:
                event_miles.append(next_mark)

        event_elapsed.append(end_elapsed)

    elif refresh_on == "refill":

        if auto_refuel:
            event_elapsed.append(realized_duration_seconds)

        elif total_fuel_available is not None and end_miles < total_miles:

            if fuel_tank_gallons:

                low_miles = (total_fuel_available - fuel_tank_gallons * AUTO_REFUEL_FUEL_FRACTION) * mpg

                if current_miles < low_miles < end_miles:
                    event_miles.append(low_miles)

            event_elapsed.append(end_elapsed)

    for miles in event_miles:
        event_elapsed.append(interpolate_seconds_at_distance(distances_miles, realized_seconds, miles))

    upcoming = [elapsed for elapsed in event_elapsed if elapsed > schedule_elapsed]

    if not upcoming:
        return None

    return (min(upcoming) - schedule_elapsed) / time_multiplier


@app.get("/api/trips/active")
def active_trips(refresh_on: str = "never", every_miles: Optional[float] = None, slot: int = Depends(current_slot)):

    if refresh_on not in REFRESH_MODES:
        raise HTTPException(status_code=400, detail=f"refresh_on must be one of {', '.join(REFRESH_MODES)}")

    conn = db()
    cur = conn.cursor()

    time_multiplier, _ = get_settings(conn, cur, slot)

    #
    # Settles any trip that's genuinely arrived before this query runs -
    # see this function's own WHERE clause comment below for why the query
    # itself no longer tries to guess "still active" from elapsed time.
    #
    settle_arrived_vehicles(conn, cur)

    #
    # A completed trip keeps cancelled_at NULL too (only a diversion ever
    # sets it) - the old elapsed-time condition below wasn't just a "still
    # active" guess, it was silently doing the real job of this query on
    # its own: excluding a vehicle's entire trip history down to just its
    # current one. DISTINCT ON does that job explicitly instead, so
    # dropping the time condition (see the WHERE clause note above) doesn't
    # flood this with every trip a vehicle has ever completed.
    #
    cur.execute(
        """
        SELECT DISTINCT ON (t.vehicle_id)
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
            t.journey_route_before,
            t.auto_refuel,
            t.resume_destination_place_id,
            t.trip_meter_offset_miles,
            EXTRACT(EPOCH FROM (NOW() - t.started_at))
        FROM trips t
        JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN paths p ON p.id = t.path_id
        JOIN vehicle_models vs ON vs.id = v.vehicle_model_id
        WHERE t.cancelled_at IS NULL
        AND v.slot_id = %s
        ORDER BY t.vehicle_id, t.started_at DESC
        """,
        (slot,)
    )

    rows = cur.fetchall()

    #
    # Resolved once, in bulk, rather than per-row - only a divert-to-gas-
    # station leg ever has a resume_destination_place_id at all, so this is
    # usually empty.
    #
    resume_places_by_id = fetch_places_by_id(cur, [row[-3] for row in rows if row[-3] is not None])

    #
    # A detour/resume leg that's still being routed in job_executor is a
    # trip about to appear that no current row can predict - check back
    # shortly instead of waiting on the next event of whatever's driving.
    #
    cur.execute(
        """
        SELECT EXISTS (
            SELECT 1 FROM jobs
            WHERE status IN ('pending', 'running') AND job_type = ANY(%s) AND slot_id = %s
        )
        """,
        (list(TRIP_STARTING_JOB_TYPES), slot)
    )

    trip_job_in_flight = cur.fetchone()[0]

    cur.close()
    conn.close()

    trips = []

    next_refresh_seconds = None

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
        journey_route_before,
        auto_refuel,
        resume_destination_place_id,
        trip_meter_offset_miles,
        elapsed_real_seconds
    ) in rows:

        #
        # LEFT JOIN, so DISTINCT ON still lands on each vehicle's actual
        # latest trip - an inner join would silently skip a settled one
        # whose path is already forgotten and fall back to some older trip.
        # No path means that latest trip is settled: nothing to show.
        #
        if route is None:
            continue

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

        #
        # settle_arrived_vehicles() above already moves a genuinely arrived
        # trip along, so this is a defensive fallback for the brief window
        # where that hasn't fully landed yet (e.g. its resume job is still
        # running) - not the normal case.
        #
        if derived["status"] == "ARRIVED":
            continue

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

            **derived,

            #
            # The dashboard trip meter - this leg's distance plus every
            # earlier leg of the same journey (see start_diversion_trip()),
            # so it keeps counting through a gas-station detour. Plain
            # distance_miles stays per-leg since fuel/stranding math and the
            # odometer depend on that.
            #
            "trip_meter_miles": trip_meter_offset_miles + derived["distance_miles"],

            #
            # What this journey already drove on earlier legs (before a
            # gas-station detour, and the detour itself) - the map draws it
            # ahead of route so the whole trip stays on screen.
            #
            "journey_route_before": journey_route_before or []
        })

        if derived["status"] == "DRIVING":

            trip_refresh_seconds = seconds_until_refresh_event(
                refresh_on, every_miles, distances_miles, realized_seconds, realized_duration_seconds,
                mpg, fuel_tank_gallons, starting_fuel_gallons, roadside_refuel_count, auto_refuel,
                paused_seconds, float(elapsed_real_seconds), time_multiplier, derived["distance_miles"]
            )

            if trip_refresh_seconds is not None and (
                next_refresh_seconds is None or trip_refresh_seconds < next_refresh_seconds
            ):
                next_refresh_seconds = trip_refresh_seconds

    if trip_job_in_flight and refresh_on != "never":
        next_refresh_seconds = min(next_refresh_seconds or TRIP_JOB_RECHECK_SECONDS, TRIP_JOB_RECHECK_SECONDS)

    #
    # trip_job_in_flight tells the frontend a vehicle missing from trips may
    # just be between legs (a detour's next leg still being routed), so it
    # keeps showing it rather than dropping it (see refuelingPlaceholder()
    # in app.js).
    #
    return {"trips": trips, "next_refresh_seconds": next_refresh_seconds, "trip_job_in_flight": trip_job_in_flight}
