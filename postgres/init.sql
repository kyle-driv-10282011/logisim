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

    -- Capacity of this vehicle's fuel tank, in gallons. Every vehicle
    -- created against this spec starts with a full tank (vehicles.fuel_gallons
    -- below) and can hold at most this much at once.
    fuel_tank_gallons DOUBLE PRECISION NOT NULL DEFAULT 20,

    -- Filename under frontend/images/, e.g. "2026-Chevy-Express.png". Nullable
    -- since a spec is still usable without a picture.
    image TEXT,

    created TIMESTAMP DEFAULT NOW()
);


CREATE TABLE places (

    id SERIAL PRIMARY KEY,

    -- Free text as the user typed it - a legit address, or a description
    -- like "Target near Minneapolis" (see PLACE_IN_PATTERN in app.py for
    -- the "in"/"near" normalization applied before geocoding it).
    description TEXT NOT NULL,

    -- Nominatim's own formatted address for that description, resolved
    -- once at creation (geocode_full() in app.py) so the saved place has a
    -- normalized label to show alongside the free-text description.
    address TEXT NOT NULL,

    -- Rounded to ROUND_DECIMALS (app.py) so a place resolving to the same
    -- coordinates as an existing one is reused instead of duplicated
    -- (find_or_create_place() in app.py). The only lat/lng in the schema -
    -- vehicles and paths reference a place by id instead of copying these.
    lat DOUBLE PRECISION NOT NULL,

    lng DOUBLE PRECISION NOT NULL,

    created TIMESTAMP DEFAULT NOW()
);


CREATE TABLE gas_prices (

    -- One row per place, not a price history - place_id doubling as the
    -- primary key means adding a price for a place that already has one
    -- (typing it again, or a re-uploaded CSV/JSON row) updates it in place
    -- via upsert (see POST /api/gas-prices in app.py) instead of piling up
    -- stale duplicates. Mirrors the settings table's single-current-value
    -- pattern rather than trips' append-only history.
    place_id INTEGER PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,

    price_per_gallon DOUBLE PRECISION NOT NULL,

    updated TIMESTAMP NOT NULL DEFAULT NOW()
);


CREATE TABLE vehicles (

    id SERIAL PRIMARY KEY,

    name TEXT NOT NULL,

    -- Where the vehicle currently is - a foreign key rather than its own
    -- copy of lat/lng, so the same place is never described three
    -- different ways (a name here, an address there, coordinates
    -- somewhere else). Matched against a path's origin_place_id to
    -- restrict which paths a vehicle can start a trip on. Set at creation,
    -- then updated to a trip's destination place once that trip arrives
    -- (settle_arrived_vehicles() in app.py) - not touched while a trip is
    -- in progress, so it reflects the last place the vehicle was
    -- confirmed to be, not a live position (see the `trips` live
    -- position/road-name fields for that).
    place_id INTEGER NOT NULL REFERENCES places(id),

    -- Odometer reading at the moment this vehicle was added to the fleet
    -- (e.g. a used vehicle bought with miles already on it). The vehicle's
    -- displayed total is this plus every trip it's driven since - see
    -- list_vehicles() in app.py.
    starting_mileage DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- Gallons currently in the tank. Set to the spec's fuel_tank_gallons
    -- (a full tank) when the vehicle is created, drained as it drives
    -- (distance / spec.mpg) and refilled to full by POST
    -- /api/vehicles/{id}/refuel. Only ever updated once a trip actually
    -- settles (settle_arrived_vehicles() in app.py) - like place_id, this
    -- is the vehicle's last-known-good value, not a live-ticking one; the
    -- live level for a vehicle currently driving/stranded is derived per
    -- poll instead (see trips.starting_fuel_gallons below).
    fuel_gallons DOUBLE PRECISION NOT NULL DEFAULT 0,

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

    -- Same normalization as vehicles.place_id above - a path's origin and
    -- destination are places, referenced by id, not their own lat/lng
    -- copies. Deduping an equivalent path (create_path() in app.py) is
    -- now a plain id comparison instead of a rounded-float one.
    origin_place_id INTEGER NOT NULL REFERENCES places(id),

    destination_place_id INTEGER NOT NULL REFERENCES places(id),

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


CREATE TABLE jobs (

    id SERIAL PRIMARY KEY,

    -- 'gas_prices_upload' or 'create_path' - see app.py's job_executor
    -- submissions. Both involve per-row/per-place geocoding against the
    -- public Nominatim API, which is too slow (and too likely to blow a
    -- proxy/browser timeout) to do inline in the request that kicks it
    -- off, so that work runs in a background thread and the request
    -- returns this row's id immediately for the frontend to poll via
    -- GET /api/jobs/{id}.
    job_type TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending', -- pending, running, done, error

    progress_current INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,

    -- Whatever the job's normal synchronous return value used to be (e.g.
    -- the created path, or {created, errors} for an upload), stashed here
    -- for the frontend to pick up once status = 'done'.
    result JSONB,

    error TEXT,

    created TIMESTAMP DEFAULT NOW(),
    updated TIMESTAMP DEFAULT NOW()
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

    realized_duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- The vehicle's fuel_gallons at the moment this trip started - frozen
    -- here the same way traffic_bias/zones_snapshot are, so a later refuel
    -- of the vehicle (which can't happen while it's driving anyway) could
    -- never retroactively change a schedule already in progress.
    starting_fuel_gallons DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- How many roadside refuels (see POST /api/vehicles/{id}/roadside-refuel)
    -- have topped this trip back up to a full tank after it ran dry
    -- mid-route. Each one adds another spec.fuel_tank_gallons worth of range
    -- from wherever it stranded, so the total fuel available for the whole
    -- trip is starting_fuel_gallons + roadside_refuel_count * fuel_tank_gallons.
    roadside_refuel_count INTEGER NOT NULL DEFAULT 0,

    -- Real seconds' worth of schedule progress "refunded" by a roadside
    -- refuel, so the trip's clock doesn't count time spent stranded as
    -- distance covered. See resolve_trip_progress() in app.py.
    paused_seconds DOUBLE PRECISION NOT NULL DEFAULT 0
);
