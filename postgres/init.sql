CREATE TABLE settings (

    id INTEGER PRIMARY KEY,

    -- How fast game time runs relative to real time (e.g. 60 = one real
    -- second is one game minute). Replaces the old hardcoded
    -- TIME_COMPRESSION constant - this is the single knob for all
    -- time-based behavior (trip playback speed AND the displayed clock).
    time_multiplier DOUBLE PRECISION NOT NULL,

    -- The game clock is derived, not stored directly: it was
    -- anchor_game_time at the real UTC moment anchor_real_utc, and has
    -- advanced at time_multiplier x real speed ever since. Re-anchored
    -- every time time_multiplier changes (PUT /api/settings) so the game
    -- clock stays continuous across a multiplier change instead of
    -- jumping. This row is seeded lazily by the backend (get_settings()
    -- in app.py) using Python's own clock, not NOW() here - that keeps
    -- anchor_real_utc genuinely comparable to Python's datetime.utcnow()
    -- without depending on the Postgres container's configured timezone.
    anchor_real_utc TIMESTAMP NOT NULL,

    anchor_game_time TIMESTAMP NOT NULL,

    CONSTRAINT settings_single_row CHECK (id = 1)
);


CREATE TABLE vehicle_specs (

    id SERIAL PRIMARY KEY,

    year INTEGER NOT NULL,

    brand TEXT NOT NULL,

    model TEXT NOT NULL,

    person_capacity INTEGER NOT NULL,

    cargo_capacity_cuft DOUBLE PRECISION NOT NULL,

    cost DOUBLE PRECISION NOT NULL,

    mpg DOUBLE PRECISION NOT NULL,

    -- Filename under frontend/images/, e.g. "2026-Chevy-Express.png". Nullable
    -- since a spec is still usable without a picture.
    image TEXT,

    created TIMESTAMP DEFAULT NOW()
);


CREATE TABLE vehicles (

    id SERIAL PRIMARY KEY,

    name TEXT NOT NULL,

    -- Where the vehicle currently is, matched (within ROUND_DECIMALS
    -- precision - see app.py) against a path's origin_lat/origin_lng to
    -- restrict which paths a vehicle can start a trip on. Set at creation,
    -- then updated to a trip's destination coordinates once that trip
    -- arrives (settle_arrived_vehicles() in app.py) - not touched while
    -- a trip is in progress, so it reflects the last place the vehicle
    -- was confirmed to be, not a live position (see the `trips` live
    -- position/road-name fields for that).
    current_lat DOUBLE PRECISION NOT NULL,

    current_lng DOUBLE PRECISION NOT NULL,

    -- Odometer reading at the moment this vehicle was added to the fleet
    -- (e.g. a used vehicle bought with miles already on it). The vehicle's
    -- displayed total is this plus every trip it's driven since - see
    -- list_vehicles() in app.py.
    starting_mileage DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- Hauling specs (year/brand/model/capacity/cost/mpg/image) live on the
    -- reusable spec, not duplicated per vehicle - same pattern as paths
    -- being reused across trips instead of storing route data per trip.
    spec_id INTEGER NOT NULL REFERENCES vehicle_specs(id),

    -- Selling a vehicle marks it sold rather than deleting the row, so
    -- "All Vehicles" can show full history while "My Vehicles" (the
    -- current fleet) filters to sold = FALSE.
    sold BOOLEAN NOT NULL DEFAULT FALSE,
    sold_at TIMESTAMP,

    created TIMESTAMP DEFAULT NOW()
);


CREATE TABLE paths (

    id SERIAL PRIMARY KEY,

    origin_lat DOUBLE PRECISION NOT NULL,

    origin_lng DOUBLE PRECISION NOT NULL,

    destination_lat DOUBLE PRECISION NOT NULL,

    destination_lng DOUBLE PRECISION NOT NULL,

    route JSONB NOT NULL,

    distances_miles JSONB NOT NULL,

    max_speeds_mph JSONB NOT NULL,

    road_names JSONB NOT NULL,

    road_name_boundary_miles JSONB NOT NULL,

    created TIMESTAMP DEFAULT NOW()
);


CREATE TABLE road_zones (

    id SERIAL PRIMARY KEY,

    path_id INTEGER NOT NULL REFERENCES paths(id) ON DELETE CASCADE,

    start_miles DOUBLE PRECISION NOT NULL,

    end_miles DOUBLE PRECISION NOT NULL,

    speed_limit_mph DOUBLE PRECISION NOT NULL,

    rush_hour_start DOUBLE PRECISION,

    rush_hour_end DOUBLE PRECISION,

    rush_hour_factor DOUBLE PRECISION NOT NULL DEFAULT 0.6,

    created TIMESTAMP DEFAULT NOW()
);


CREATE TABLE trips (

    id SERIAL PRIMARY KEY,

    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,

    path_id INTEGER NOT NULL REFERENCES paths(id) ON DELETE CASCADE,

    started_at TIMESTAMP DEFAULT NOW(),

    traffic_base_datetime TIMESTAMP NOT NULL DEFAULT NOW(),

    traffic_bias DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    -- Frozen at trip creation: the path's zones as they existed then, and
    -- the resulting drive schedule (cumulative real seconds to reach each
    -- route point, derived from distance / effective speed rather than
    -- OSRM's own duration estimate). See build_trip_schedule() in app.py.
    zones_snapshot JSONB NOT NULL DEFAULT '[]',

    realized_seconds JSONB NOT NULL DEFAULT '[]',

    realized_duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0
);
