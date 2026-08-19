CREATE TABLE vehicles (

    id SERIAL PRIMARY KEY,

    name TEXT NOT NULL,

    vehicle_type TEXT NOT NULL DEFAULT 'truck',

    created TIMESTAMP DEFAULT NOW()
);


CREATE TABLE paths (

    id SERIAL PRIMARY KEY,

    origin TEXT NOT NULL,

    destination TEXT NOT NULL,

    route JSONB NOT NULL,

    durations JSONB NOT NULL,

    duration_seconds DOUBLE PRECISION NOT NULL,

    max_speeds_mph JSONB NOT NULL,

    road_names JSONB NOT NULL,

    road_name_boundaries JSONB NOT NULL,

    created TIMESTAMP DEFAULT NOW()
);


CREATE TABLE road_zones (

    id SERIAL PRIMARY KEY,

    path_id INTEGER NOT NULL REFERENCES paths(id) ON DELETE CASCADE,

    start_seconds DOUBLE PRECISION NOT NULL,

    end_seconds DOUBLE PRECISION NOT NULL,

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

    traffic_bias DOUBLE PRECISION NOT NULL DEFAULT 1.0
);
