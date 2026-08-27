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

    origin TEXT NOT NULL,

    destination TEXT NOT NULL,

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
