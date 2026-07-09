CREATE TABLE vehicles (

    id SERIAL PRIMARY KEY,

    origin TEXT NOT NULL,

    destination TEXT NOT NULL,

    route JSONB NOT NULL,

    current_index INTEGER DEFAULT 0,

    status VARCHAR(20) DEFAULT 'READY',

    created TIMESTAMP DEFAULT NOW(),

    updated TIMESTAMP DEFAULT NOW()
);