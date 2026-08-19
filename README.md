# LogiSim

LogiSim is a vehicle route simulator. It geocodes real origin/destination
addresses, routes them over real roads via OSRM, and plays the drive back on
a live map — compressed so a multi-hour drive finishes in minutes — with a
synthetic traffic model that varies speed by road type, time of day, and
some randomness. It's a visualization/demo tool, not a real logistics or
ETA product.

## Stack

| Service    | What it is                              | Port |
|------------|------------------------------------------|------|
| `frontend` | Static HTML/JS map UI, served by nginx   | 8700 |
| `backend`  | FastAPI app                              | 5000 |
| `postgres` | PostgreSQL 16                            | 5432 |

All three run via Docker Compose. The frontend is plain JavaScript
(Leaflet for the map, no build step) and calls the backend directly from
the browser.

## Running it

```bash
docker compose up -d --build
```

Then open `http://localhost:8700`. The backend API is directly reachable
at `http://localhost:5000` (CORS is wide open — see
[Security notes](#security-notes)).

### Outbound network access

The backend needs to reach two public services over the internet:

- **Nominatim** (`nominatim.openstreetmap.org`) — geocoding place names to
  coordinates, and reverse-geocoding a vehicle's current position to a
  city name.
- **OSRM's public demo server** (`router.project-osrm.org`) — turning two
  coordinates into an actual driving route.

On networks that intercept outbound TLS (e.g. a corporate Zscaler proxy),
requests to these hosts can fail with `CERTIFICATE_VERIFY_FAILED`. Rather
than trusting a machine-specific TLS-inspection root CA (fragile, and ends
up committed to source control), the backend routes outbound traffic
through an internal proxy that isn't subject to that interception. This is
configured via `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`, both as Docker
build args (needed at build time, since `pip install` also goes out over
the network) and as runtime environment variables (`requests` and geopy's
requests-based adapter both honor these automatically).

`docker-compose.yml` defaults these to a working internal proxy address,
but they're fully overridable per machine:

```bash
export HTTP_PROXY=http://your-proxy:port
export HTTPS_PROXY=http://your-proxy:port
docker compose build backend
docker compose up -d backend
```

or via a `.env` file next to `docker-compose.yml`. Leave them unset (or set
to an empty value) on a machine with unrestricted direct internet access.

## Data model

Three tables, defined in `postgres/init.sql`. **There is no migration
tooling** — `init.sql` only runs the first time a Postgres container starts
against an empty volume. Changing the schema after that (adding a column,
etc.) requires either:

- wiping the volume so `init.sql` reruns fresh:
  ```bash
  docker compose down
  docker volume rm logisim_postgres_data   # confirm the name: docker volume ls
  docker compose up -d
  ```
  (destroys all vehicles/paths/trips — fine for this simulator's throwaway
  data), or
- manually patching the live schema:
  ```bash
  docker compose exec postgres psql -U simulator -d vehicle_sim \
    -c "ALTER TABLE ... ADD COLUMN ..."
  ```

### `vehicles`

| Column         | Type    | Notes                          |
|----------------|---------|----------------------------------|
| `id`           | serial  | primary key                     |
| `name`         | text    |                                  |
| `vehicle_type` | text    | default `'truck'`               |
| `created`      | timestamp | default `NOW()`                |

A vehicle's `status` (`READY` / `DRIVING`) is computed on read from
whether it has an active trip — it isn't a stored column.

### `paths`

A path is a specific origin → destination route, geocoded and routed once
and reused for any number of trips. Looking up an existing path is
case-insensitive on `origin`/`destination` — creating "minneapolis" →
"Chicago" twice returns the same row rather than re-geocoding/re-routing.

| Column                  | Type              | Notes |
|-------------------------|-------------------|-------|
| `id`                    | serial            | primary key |
| `origin` / `destination`| text              | as typed by the user |
| `route`                 | jsonb             | `[[lat, lon], ...]` — full-resolution polyline from OSRM |
| `durations`             | jsonb             | cumulative **real** seconds elapsed at each `route` point (rescaled to match `duration_seconds` exactly — see [Position and speed](#position-and-speed)) |
| `duration_seconds`      | double precision  | total real drive time, from OSRM |
| `max_speeds_mph`        | jsonb             | OSRM's own per-segment speed (real distance ÷ duration), converted to mph — the free-flow input to the traffic model |
| `road_names`            | jsonb             | one label per OSRM turn-by-turn step (`ref` like `"I-94"`, else `name`, else `"Unnamed road"`) |
| `road_name_boundaries`  | jsonb             | cumulative real seconds at each step boundary, same domain as `durations` |
| `created`               | timestamp         | default `NOW()` |

### `road_zones`

A user-defined override for one stretch of a path's route — "this chunk of
road has a 25 mph limit with rush hour 7-9am" — instead of relying purely
on the synthetic tier-based model for that stretch.

| Column              | Type              | Notes |
|----------------------|-------------------|-------|
| `id`                 | serial            | primary key |
| `path_id`            | integer           | FK `paths(id)`, `ON DELETE CASCADE` |
| `start_seconds` / `end_seconds` | double precision | position range within the path, in the same "cumulative real seconds" domain as `paths.durations` |
| `speed_limit_mph`    | double precision  | free-flow speed for this stretch — replaces both OSRM's reported speed and the tier default entirely |
| `rush_hour_start` / `rush_hour_end` | double precision | hour of day (0-24, local time), both nullable together. `NULL`/`NULL` means this zone never slows down for rush hour |
| `rush_hour_factor`   | double precision  | multiplier applied to `speed_limit_mph` during the rush window, default `0.6` |
| `created`            | timestamp         | default `NOW()` |

### `trips`

One trip = one vehicle driving one path, starting now (or at a
user-specified simulated time).

| Column                   | Type              | Notes |
|--------------------------|-------------------|-------|
| `id`                     | serial            | primary key |
| `vehicle_id` / `path_id` | integer           | FKs, `ON DELETE CASCADE` |
| `started_at`             | timestamp         | real wall-clock moment the trip was created — drives the compressed elapsed-time math, never overridden by the user |
| `traffic_base_datetime`  | timestamp         | wall-clock moment congestion is anchored to; either `started_at`'s value or a user-supplied `simulated_datetime` (see [Traffic model](#traffic-model)) |
| `traffic_bias`           | double precision  | user multiplier on computed congestion, default `1.0` |

A vehicle can only have one trip active at a time (enforced at the
application level in `POST /api/trips`, not a DB constraint).

## How the simulation works

### Time compression

`TIME_COMPRESSION = 60` in `app.py`. A trip's real drive duration (from
OSRM) is divided by this factor to get how long it plays out on screen —
e.g. a 6-hour drive finishes in 6 minutes. All position/speed math is done
in *real* seconds and only converted to *sim* seconds at the boundary
(`remaining_sim_seconds` in API responses), so the underlying model always
reasons in true drive time.

An arrived trip keeps showing up in `/api/trips/active` for
`ARRIVAL_GRACE_SECONDS` (30) real seconds afterward, so a vehicle doesn't
just vanish from the map the instant it arrives.

### Position and speed

`derive_position()` in `app.py` is the core of the simulation. Given a
trip's elapsed real time, it:

1. Converts elapsed real seconds → sim seconds via `TIME_COMPRESSION`.
2. Finds which point-to-point segment of the route the vehicle is
   currently between (binary search over the cumulative `durations`
   array) and linearly interpolates lat/lon within it.
3. Looks up the current road name the same way, using the independent
   `road_name_boundaries` array (steps are coarser than the fine-grained
   position segments).
4. Computes the current speed via the [traffic model](#traffic-model)
   below.

`durations` is rescaled at path-creation time so its last value matches
OSRM's total `duration_seconds` exactly — OSRM's per-segment annotations
don't include turn penalties, which are only reflected in the route
total, so without rescaling, cumulative segment durations would fall
short of the real total drive time.

### Traffic model

There's no external traffic API — OSRM's free-flow speed data is
adjusted with a synthetic congestion model so trips still look
realistic, without needing an API key or worrying about rate limits.

**Road tier.** Each segment's OSRM-reported speed classifies it into a
tier (`road_tier()`):

| Tier | OSRM-reported speed | Realistic default (`TIER_DEFAULT_MPH`) |
|------|----------------------|------------------------------------------|
| `interstate` | ≥ 55 mph | 70 mph |
| `arterial`   | 35–54 mph | 50 mph |
| `local`      | < 35 mph | 30 mph |

OSRM's public demo profile frequently under-reports real highway speeds
for stretches of road that aren't tagged with an explicit `maxspeed` in
OSM — observed as high-tier segments capping around 55–64 mph on a route
that's actually signed 70. To compensate, once a segment is classified
into a tier, its free-flow speed is `max(osrm_reported_speed,
tier_default)` — the tier default only ever raises an implausibly low
number, never lowers a segment OSRM already reports accurately.

**Congestion.** `congestion_factor()` multiplies that free-flow speed by:

- A **baseline** from `CONGESTION_BASELINE`, keyed by tier and whether
  it's weekday rush hour (7–9am or 4–6pm) at the segment's *effective*
  time — see below. Higher-tier roads see more slowdown during rush hour
  (interstate: 0.90 normal → 0.55 rush) since that's where commuter
  volume concentrates.
- Small random **jitter** (±8%) and an occasional (~3% chance) localized
  **incident** (0.4× speed), both seeded deterministically by
  `(trip_id, segment_index)` — repeated polls of the same trip agree on
  the same value instead of flickering every second, but different
  trips over the same path get different variance.
- The trip's **`traffic_bias`** multiplier.

The result is clamped to `[MIN_REALISTIC_SPEED_MPH, MAX_REALISTIC_SPEED_MPH]`
(5–85 mph).

**Effective time.** Congestion is evaluated at
`traffic_base_datetime + segment's cumulative real duration` — not a
single snapshot frozen at departure. A long trip can drive into a
different rush-hour window partway through, the same way a real multi-hour
drive would. `traffic_base_datetime` (and therefore all congestion math)
is anchored to `SIMULATION_TIMEZONE` (`America/Chicago`), not the
container's system clock (which is UTC) — otherwise "rush hour" would be
keyed to whatever the UTC offset happens to be rather than a real local
clock.

**User-injected variance.** `POST /api/trips` accepts two optional
fields to deliberately override the model instead of using real
conditions:

- `simulated_datetime` — pretend the trip departed at a different moment,
  to preview rush-hour behavior on demand rather than waiting for it.
- `traffic_bias` — a direct multiplier (e.g. `0.5` for a much worse
  traffic day, `1.0` for normal).

### Road zones

A road zone lets a user manually override the traffic model for one
specific stretch of a path — its own speed limit, and optionally its own
rush-hour window and severity — rather than the road-tier-based model
above. In `derive_position()`, if the vehicle's current route segment
falls inside a zone (`find_zone()`, matched by `start_seconds`/
`end_seconds` against the same cumulative-duration domain used for
position/road-name lookups), the zone's `speed_limit_mph` replaces the
OSRM-derived free-flow speed entirely, and `zone_is_rush_hour()` (checked
against the zone's own `rush_hour_start`/`rush_hour_end`, not the app-wide
7-9am/4-6pm windows) decides whether `rush_hour_factor` or a flat `1.0`
baseline applies. The same per-`(trip_id, segment_index)` jitter and
incident chance still layers on top, so a zone still looks like real
traffic rather than a perfectly flat speed.

Zones are created via the frontend by picking two points along a
previewed path's route on the map (each click snaps to the nearest route
vertex); see [Frontend](#frontend) below.

### Nearby city lookup

`GET /api/vehicles/{id}/city` reverse-geocodes the vehicle's current
position via Nominatim. This is deliberately **not** part of the 1-second
`/api/trips/active` poll — the frontend fetches it on its own slower
7-second timer for just the currently-selected vehicle, and the backend
additionally rate-limits it to 1 request/second (`RateLimiter`) since
Nominatim's public instance enforces that limit itself.

## API reference

All endpoints are on the `backend` service, default `http://localhost:5000`.

| Method & path                  | Description |
|---------------------------------|-------------|
| `POST /api/vehicles`            | Create a vehicle. Body: `{name, vehicle_type?}` |
| `GET /api/vehicles`             | List vehicles with computed `status` (`READY`/`DRIVING`) |
| `DELETE /api/vehicles/{id}`     | Delete a vehicle (cascades its trips) |
| `GET /api/vehicles/{id}/city`   | Nearest place name to the vehicle's current position, if driving |
| `POST /api/paths`               | Geocode + route an origin/destination (or return the existing match). Body: `{origin, destination}`. Response includes `zones` |
| `GET /api/paths`                | List all created paths, each with its `zones` |
| `DELETE /api/paths/{id}`        | Delete a path (cascades its trips and zones) |
| `POST /api/paths/{id}/zones`    | Add a road zone to a path. Body: `{start_seconds, end_seconds, speed_limit_mph, rush_hour_start?, rush_hour_end?, rush_hour_factor?}` |
| `DELETE /api/zones/{id}`        | Delete a road zone |
| `POST /api/trips`               | Start a trip. Body: `{vehicle_id, path_id, simulated_datetime?, traffic_bias?}`. 409 if the vehicle is already driving |
| `GET /api/trips/active`         | Poll all currently-active trips, each with live position/speed/road name |

Every response is JSON. Any unhandled backend exception returns a generic
`500 {"detail": "Internal server error"}` — the real traceback is only in
the container logs (`docker compose logs backend`), by design (see the
comment on `catch_unhandled_exceptions` in `app.py` for why this can't be
a normal FastAPI exception handler and still carry CORS headers).

## Frontend

Plain JS + Leaflet, no build step (`frontend/app.js`, `frontend/index.html`).
Three tabs in the side panel:

- **Vehicles** — add/sell vehicles, pick a path and start a trip for a
  `READY` vehicle.
- **Paths** — create a path from an origin/destination, preview it on the
  map, remove existing paths. Previewing a path also opens its zone
  editor: "Draw a zone", then click a start point and an end point along
  the (dashed gray) route on the map to pick a chunk — each click snaps to
  the nearest route vertex. A form then asks for the zone's speed limit,
  optional rush-hour start/end (0-24, local time), and rush-hour severity
  (a 0-1 multiplier applied to the speed limit during that window). Saved
  zones are drawn as a thick orange overlay on the chunk they cover and
  listed below the map, each with its own delete button.
- **In Route** — list of currently-driving vehicles; selecting one follows
  it on the map and shows status, nearest city, position, current road,
  speed, and time remaining.

The map polls `GET /api/trips/active` every second and updates markers/
tooltips in place (`pollActiveTrips()`), rather than re-rendering
everything, so the drive animates smoothly.

nginx serves the frontend with caching fully disabled
(`Cache-Control: no-cache, no-store, must-revalidate`) — under active
development, a stale cached `app.js` against a fresh `index.html` (or vice
versa) has caused real bugs, so this trades a bit of load time for never
hitting that class of issue.

## Security notes

This is a local demo/simulation tool, not a production service:

- CORS allows any origin (`allow_origins=["*"]`) — acceptable because
  there's no auth or cookies anywhere in the app.
- Postgres credentials are hardcoded in `docker-compose.yml` and `app.py`
  (`simulator` / `simulator_password`).
- There's no authentication on any endpoint.

None of this should be carried into anything beyond local use.

## Troubleshooting

**A path/trip endpoint 500s after pulling new code.** Almost always
schema drift — `postgres/init.sql` changed but the running Postgres
volume predates it (`init.sql` only runs once, on an empty volume). Check
`docker compose logs backend` for `psycopg2.errors.UndefinedColumn` or
`NotNullViolation`, then either wipe the volume or manually `ALTER TABLE`
per the [Data model](#data-model) section above.

**`CERTIFICATE_VERIFY_FAILED` reaching Nominatim/OSRM.** See
[Outbound network access](#outbound-network-access) — the backend needs
`HTTP_PROXY`/`HTTPS_PROXY` configured for networks that intercept TLS.
Confirm the container actually picked them up:
```bash
docker compose exec backend env | grep -i proxy
```
If empty, the image needs rebuilding (`docker compose build backend`) —
`docker compose up -d` alone does not rebuild an existing image.

**Speeds look flat/unrealistic.** OSRM's public demo server's per-segment
`speed` annotation can be a poor proxy for real posted limits (see
[Traffic model](#traffic-model)); the tier-default flooring exists
specifically to compensate for this. If something still looks off, checking
the time-weighted distribution of `max_speeds_mph` for the path in question
(rather than eyeballing the raw array) is the fastest way to tell whether
it's a data issue or a logic bug.
