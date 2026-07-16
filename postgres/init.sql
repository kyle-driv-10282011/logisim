CREATE TABLE vehicles (

    id SERIAL PRIMARY KEY,

    origin TEXT NOT NULL,

    destination TEXT NOT NULL,

    route JSONB NOT NULL,

    durations JSONB NOT NULL,

    duration_seconds DOUBLE PRECISION NOT NULL,

    status VARCHAR(20) DEFAULT 'READY',

    created TIMESTAMP DEFAULT NOW()
);