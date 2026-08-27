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

Five tables, defined in `postgres/init.sql`. **There is no migration
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

### `settings`

A single row (`id = 1`) holding the game clock's live-adjustable speed.
Replaces the old hardcoded `TIME_COMPRESSION` constant — see
[Game time](#game-time) below.

| Column             | Type      | Notes                          |
|--------------------|-----------|----------------------------------|
| `id`               | integer   | always `1` (`CHECK (id = 1)`)   |
| `time_multiplier`  | double precision | how fast game time runs relative to real time |
| `anchor_real_utc`  | timestamp | a real UTC moment                |
| `anchor_game_time` | timestamp | the game time at that moment; re-anchored on every multiplier change |

Seeded lazily by the backend on first use (`get_settings()` in
`app.py`), not by `init.sql` — the anchor has to be comparable to
Python's own `datetime.utcnow()`, which `init.sql` inserting via
Postgres's `NOW()` can't guarantee without depending on the container's
configured timezone.

### `vehicle_specs`

A reusable hauling-spec catalog entry — e.g. "2026 Chevy Express" — that
any number of vehicles can be created against, the same way a `path` is
geocoded/routed once and reused by any number of trips.

| Column                 | Type    | Notes                          |
|------------------------|---------|----------------------------------|
| `id`                   | serial  | primary key                     |
| `year`                 | integer |                                  |
| `brand` / `model`      | text    |                                  |
| `person_capacity`      | integer |                                  |
| `cargo_capacity_cuft`  | double precision |                         |
| `cost`                 | double precision |                         |
| `mpg`                  | double precision |                         |
| `image`                | text    | nullable; a filename under `frontend/images/` (e.g. `"2026-Chevy-Express.png"`), not a URL — the frontend resolves it against its own origin |
| `created`              | timestamp | default `NOW()`                |

### `vehicles`

| Column         | Type    | Notes                          |
|----------------|---------|----------------------------------|
| `id`           | serial  | primary key                     |
| `name`         | text    |                                  |
| `spec_id`      | integer | FK `vehicle_specs(id)` — hauling specs (including type/brand/model) live on the spec, not duplicated per vehicle |
| `sold`         | boolean | default `false`. Selling a vehicle sets this rather than deleting the row, so "All Vehicles" can show full history while "My Vehicles" filters to `sold = false` |
| `sold_at`      | timestamp | nullable                      |
| `created`      | timestamp | default `NOW()`                |

A vehicle's `status` (`READY` / `DRIVING` / `SOLD`) is computed on read
from `sold` and whether it has an active trip — none of that is a stored
column besides `sold` itself.

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
| `distances_miles`       | jsonb             | cumulative miles from the origin at each `route` point — a fixed geometric property of the path, independent of any traffic model (see [Position and speed](#position-and-speed)) |
| `max_speeds_mph`        | jsonb             | OSRM's own per-segment speed (real distance ÷ duration), converted to mph — the free-flow input to the traffic model |
| `road_names`            | jsonb             | one label per OSRM turn-by-turn step (`ref` like `"I-94"`, else `name`, else `"Unnamed road"`) |
| `road_name_boundary_miles` | jsonb          | cumulative miles at each step boundary, same domain as `distances_miles` |
| `created`               | timestamp         | default `NOW()` |

Note there's no `duration_seconds` here — how long a drive over this path
takes is no longer a fixed property of the path itself. It depends on the
traffic model (speed limits, rush hour, zones, `traffic_bias`) applied at
the moment a specific trip starts, so it's computed and stored per-*trip*
instead (`trips.realized_duration_seconds` below).

### `road_zones`

A user-defined override for one stretch of a path's route — "this chunk of
road has a 25 mph limit with rush hour 7-9am" — instead of relying purely
on the synthetic tier-based model for that stretch.

| Column              | Type              | Notes |
|----------------------|-------------------|-------|
| `id`                 | serial            | primary key |
| `path_id`            | integer           | FK `paths(id)`, `ON DELETE CASCADE` |
| `start_miles` / `end_miles` | double precision | position range within the path, in miles from the origin — same domain as `paths.distances_miles` |
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
| `traffic_base_datetime`  | timestamp         | game-clock moment congestion is anchored to; either the game time at trip creation or a user-supplied `simulated_datetime` (see [Traffic model](#traffic-model)) |
| `traffic_bias`           | double precision  | user multiplier on computed congestion, default `1.0` |
| `zones_snapshot`         | jsonb             | the path's `road_zones` as they existed the moment this trip was created — frozen so a zone added/removed later doesn't retroactively contradict a schedule already computed for a trip in progress |
| `realized_seconds`       | jsonb             | cumulative **real** seconds to reach each `route` point *for this specific trip*, computed once at trip creation from `distances_miles` and the traffic model (`build_trip_schedule()` — see [Position and speed](#position-and-speed)) |
| `realized_duration_seconds` | double precision | `realized_seconds[-1]` — this trip's actual total drive time under the traffic model in effect when it started |

A vehicle can only have one trip active at a time (enforced at the
application level in `POST /api/trips`, not a DB constraint).

## How the simulation works

### Game time

The whole simulation runs on a **game clock** — a virtual date/time,
independent of real wall-clock time, that advances at
`time_multiplier` × real speed (e.g. a 6-hour drive finishes in 6 minutes
on screen at `time_multiplier = 60`). This is the single knob for all
time-based behavior: trip playback speed, the displayed clock, and which
rush-hour window the traffic model judges a trip against.

The game clock is stored as an anchor pair in the `settings` table
(`anchor_real_utc`, `anchor_game_time`) rather than as a value that gets
updated every tick — `get_settings()` in `app.py` derives the current
game time on every read as `anchor_game_time + (now_utc - anchor_real_utc)
× time_multiplier`. `PUT /api/settings` changes `time_multiplier` by
re-anchoring at the game time the *old* multiplier had just reached, so
the clock speeds up/slows down from wherever it currently is instead of
jumping to a different value.

A trip departs at the game clock's current value unless the caller
passes `simulated_datetime` (`POST /api/trips`) to explicitly override
it — see [Traffic model](#traffic-model).

All position/speed math is done in *real* seconds and only converted to
*sim* seconds at the boundary (`remaining_sim_seconds` in API responses,
using the current `time_multiplier`), so the underlying model always
reasons in true drive time — and live changes to `time_multiplier`
immediately speed up or slow down every in-progress trip's displayed ETA.

An arrived trip keeps showing up in `/api/trips/active` for
`ARRIVAL_GRACE_SECONDS` (30) real seconds afterward, so a vehicle doesn't
just vanish from the map the instant it arrives.

### Position and speed

Drive time is *derived*, not trusted from OSRM. A path only stores
`distances_miles` — a fixed geometric property of the route (cumulative
miles from the origin at each point) that never changes. How long it
actually takes to drive is computed from that distance and the traffic
model's speed for each segment, so a higher zone speed limit, a lighter
rush hour, or a `traffic_bias` above `1.0` all genuinely shorten the
trip's ETA — they're not just cosmetic.

**`build_trip_schedule()`** runs once, when a trip is created
(`POST /api/trips`), and produces `trips.realized_seconds` — the
per-*trip* equivalent of the old fixed per-*path* duration array. It walks
the route segment by segment:

1. For the current segment, compute the wall-clock moment it's reached
   (`traffic_base_datetime` + cumulative real seconds so far).
2. Compute that segment's effective speed via [the traffic
   model](#traffic-model) below (zone override, or tier + rush-hour +
   jitter/incident + `traffic_bias`).
3. `segment_time = segment_distance_miles / segment_speed_mph`, added to
   the running total.

This has to be a genuine sequential walk, not a closed-form calculation —
a segment's effective speed depends on the clock time it's reached, which
depends on how long every prior segment took. It only needs to run once
per trip: the schedule (and the zones it used) is frozen into the trip
row at creation, exactly like `traffic_base_datetime`/`traffic_bias`
already were.

**`derive_position()`** then runs on every poll, and is cheap — no need
to re-walk the route:

1. Converts elapsed real seconds → sim seconds via `TIME_COMPRESSION`.
2. Finds which point-to-point segment of the route the vehicle is
   currently between (binary search over the trip's own
   `realized_seconds` array) and linearly interpolates lat/lon within it.
3. Looks up the current road name the same way, but in the *distance*
   domain — interpolating `distances_miles` to get the vehicle's current
   cumulative mileage, then bisecting `road_name_boundary_miles` against
   it (steps are coarser than the fine-grained position segments).
4. Recomputes that one segment's speed (for display) the same way
   `build_trip_schedule()` did when building the schedule.

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
drive would. `traffic_base_datetime` defaults to the current [game
time](#game-time) (not real wall-clock time) and, like the game clock
itself, is anchored to `SIMULATION_TIMEZONE` (`America/Chicago`), not the
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
above. `segment_speed_mph()` is the shared function both
`build_trip_schedule()` and `derive_position()` call to price a single
segment: if the segment falls inside a zone (`find_zone()`, matched by
`start_miles`/`end_miles` against the same cumulative-distance domain used
for position/road-name lookups), the zone's `speed_limit_mph` replaces the
OSRM-derived free-flow speed entirely, and `zone_is_rush_hour()` (checked
against the zone's own `rush_hour_start`/`rush_hour_end`, not the app-wide
7-9am/4-6pm windows) decides whether `rush_hour_factor` or a flat `1.0`
baseline applies. The same per-`(trip_id, segment_index)` jitter and
incident chance still layers on top, so a zone still looks like real
traffic rather than a perfectly flat speed.

Because zones now genuinely affect drive time (not just a displayed
number), a trip freezes its own copy of the path's zones at creation time
(`trips.zones_snapshot`) rather than reading `road_zones` live on every
poll — otherwise adding or deleting a zone mid-trip would silently
invalidate a schedule already computed and shown to the user as an ETA.
Zones added after a trip starts only affect *future* trips over that path.

Zones are created and edited via the frontend by clicking directly on the
route (or drawing a custom stretch by picking two points); see
[Frontend](#frontend) below.

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
| `GET /api/settings`             | Current game clock: `{time_multiplier, game_time}` |
| `PUT /api/settings`             | Change `time_multiplier`. Body: `{time_multiplier}` — re-anchors the game clock at its current value so it speeds up/slows down rather than jumping |
| `POST /api/vehicles`            | Create a vehicle. Body: `{name, spec_id}`. Response includes the resolved `spec` |
| `GET /api/vehicles`             | List vehicles with computed `status` (`READY`/`DRIVING`/`SOLD`) and each vehicle's `spec`. Defaults to the current fleet (`sold = false`, "My Vehicles"); `?include_sold=true` returns full history ("All Vehicles") |
| `POST /api/vehicles/{id}/sell`  | Mark a vehicle sold (soft-delete). 409 if already sold or currently on a trip |
| `DELETE /api/vehicles/{id}`     | Permanently delete a vehicle (cascades its trips) — distinct from selling; not used by the frontend |
| `POST /api/vehicle-specs`       | Create a hauling-spec catalog entry. Body: `{year, brand, model, person_capacity, cargo_capacity_cuft, cost, mpg, image?}` |
| `GET /api/vehicle-specs`        | List all vehicle specs |
| `DELETE /api/vehicle-specs/{id}`| Delete a spec. 409 if any vehicle still references it |
| `GET /api/vehicles/{id}/city`   | Nearest place name to the vehicle's current position, if driving |
| `POST /api/paths`               | Geocode + route an origin/destination (or return the existing match). Body: `{origin, destination}`. Response includes `zones` |
| `GET /api/paths`                | List all created paths, each with its `zones` |
| `DELETE /api/paths/{id}`        | Delete a path (cascades its trips and zones) |
| `POST /api/paths/{id}/zones`    | Add a road zone to a path. Body: `{start_miles, end_miles, speed_limit_mph, rush_hour_start?, rush_hour_end?, rush_hour_factor?}` |
| `PUT /api/zones/{id}`           | Update an existing road zone. Same body as create |
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
Five tabs in the side panel:

- **Templates** — the hauling-spec catalog. Create specs
  (year/brand/model/person capacity/cargo capacity/cost/MPG/image) and
  delete unused ones (409 if any vehicle still references one). A spec's
  `image` is just a filename resolved against `frontend/images/` (e.g.
  dropping in `frontend/images/2026-Chevy-Express.png` and setting
  `image` to `2026-Chevy-Express.png`) — nginx serves that directory
  alongside the rest of the static frontend, no separate upload endpoint.
- **My Vehicles** — the current fleet (not sold). Add a vehicle by
  picking a template from a dropdown (required — templates must exist
  first), pick a path and start a trip for a `READY` vehicle, or sell a
  `READY` vehicle (soft-delete — it moves off this list but stays
  visible in All Vehicles as `SOLD`).
- **All Vehicles** — read-only history of every vehicle ever created,
  sold or not, with its current status badge (`READY`/`DRIVING`/`SOLD`).
- **Paths** — create a path from an origin/destination, preview it on the
  map, remove existing paths. Previewing a path draws the *entire* route
  color-coded by effective speed limit (red &lt;45 mph, orange 45-64,
  green 65+ — `buildRouteSections()` in `app.js`, mirroring the backend's
  own tier logic), whether or not any of it has a zone override; existing
  zones render as a heavier solid line with a dark casing outline behind
  it (so a custom zone is unmistakable even if its speed color happens to
  match the plain tier road right next to it), while everything else is a
  thinner dashed line with no casing. Every section also has an invisible,
  much wider companion line stacked on top purely to make it easier to
  click — the visible line alone is too thin to reliably hit, especially
  for a short zone. **Clicking any point on that route** selects
  the whole section it belongs to (highlighted in red) and opens an edit
  form in the sidebar pre-filled with that section's current speed limit
  (and rush-hour fields, if it's an existing zone) — editing and saving
  either updates that zone in place (`PUT /api/zones/{id}`) or creates a
  new one covering exactly that stretch (`POST /api/paths/{id}/zones`),
  depending on whether the clicked section already had one. "Draw a custom
  zone" is still available for picking an arbitrary sub-range instead of a
  whole displayed section (two clicks on the map, snapping to the nearest
  route vertex). Existing zones are also listed below the map, each
  clickable to select/edit and with its own delete button.
- **In Route** — list of currently-driving vehicles; selecting one follows
  it on the map and shows status, nearest city, position, current road,
  speed, and time remaining.

A clock in the top-right corner of the map (`updateSimClock()`) shows the
current [game time](#game-time) — the same clock the traffic model judges
rush hour against — with a "Rush Hour" badge when it's currently a
weekday 7-9am or 4-6pm, and a "Time x" control next to it to change
`time_multiplier` (`setTimeMultiplier()`, `PUT /api/settings`). Rather
than calling `GET /api/settings` every second, `loadSettings()` fetches
it every 5s and `updateSimClock()` extrapolates forward from that anchor
each second (`gameClockAnchor` in `app.js`) so the clock ticks smoothly
in between; the 5s refresh also re-syncs against a multiplier change made
from another browser/tab. A trip started with a custom
`simulated_datetime` still experiences its own overridden clock
server-side — this display doesn't change to match it, same as before.

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
