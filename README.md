# LogiSim

LogiSim is a vehicle route simulator. It geocodes real origin/destination
addresses, routes them over real roads via OSRM, and plays the drive back on
a live map — compressed so a multi-hour drive finishes in minutes — with a
synthetic traffic model that varies speed by road type, time of day, and
some randomness. It's a visualization/demo tool, not a real logistics or
ETA product.

## Stack

| Service    | What it is                                                  | Reached by |
|------------|--------------------------------------------------------------|------------|
| `frontend` | nginx: the static HTML/JS map UI, and `/api/` passed on to the backend | Edge's Traefik only (`edge-logisim` network) |
| `backend`  | FastAPI app                                                  | the frontend's nginx (`backend:5000`) |
| `postgres` | PostgreSQL 16                                                | the backend |

No service publishes a port. HTTPS is handled by the machine-wide Edge
stack (`~/Code/Edge`): its Traefik holds the certificate, serves
`https://logisim.kjfries.com`, and forwards to the frontend's nginx, adding
a secret header (`X-Edge-Proof`). nginx refuses any request without it, so
LogiSim can only be loaded through Edge.

All three run via Docker Compose. The frontend is plain JavaScript
(Leaflet for the map, no build step) and calls the backend directly from
the browser.

## Running it

Start the Edge stack first (it creates the `edge-logisim` network and
fetches the certificate). Copy `.env.example` to `.env` next to
`docker-compose.yml` and fill it in: `PROXY_SECRET` is required — the same
value as `LOGISIM_PROXY_SECRET` in Edge's `.env` (generate one with
`openssl rand -hex 32`) — and the HTTP proxy settings are optional (see
[Outbound network access](#outbound-network-access)):

```bash
cp .env.example .env
```

Then:

```bash
docker compose up -d --build
```

and open `https://logisim.kjfries.com` (the hostname must resolve to this
server). The API is at `https://logisim.kjfries.com/api/...`, same origin
as the page. A 403 "only available through its HTTPS address" means the
secret here doesn't match Edge's.

### Roles: user and admin

Everyone plays as a **user**: the file-select screen (start a new game in an
empty file), **My Vehicles**, **Budget**, the clock box settings, Config's
refresh slider and **View**, and the gas station map overlay.

**Config → View** picks the game screen's look for this browser only:
**Black & White**, **Blue & White** (the original look), **80's** (the
default) or **90's** (a Windows 95 desktop). It's saved in `localStorage`, and
each view is a stylesheet (`themebw.css`, `theme80s.css`, `theme90s.css`, or
none for blue & white) plus the
map's route and marker styles (`MAP_STYLES` in `app.js`). The file-select
screen keeps its own look in every view.

**Admin** manages what every save file shares: **Vehicle Models** (add,
edit, delete, pictures, import, export), **Gas Prices** (add, delete, bulk
import, export), **Background Jobs**, and erasing files. It isn't a login.
The admin entries are listed for everyone with a 🔒. Opening one asks for the
instance's `ADMIN_PASSWORD` (set in `.env`). Switching to another tab, or
closing the Vehicle Models page, locks it again. Gas Prices has **Export all
gas stations (CSV)**, which restores through its **Bulk import**. Leave `ADMIN_PASSWORD` empty to turn admin off.

**ERASE SELECTED FILE** on the file-select screen erases the file under the
cursor. It asks for the admin password every time, as the confirmation. The
backend also refuses to start a new game on a request that carries an admin
token.

Unlocking returns a signed token that lasts 12 hours at most. The page keeps
it only in memory, so it's gone on reload, and sends it as an
`X-Admin-Token` header, or as `?admin_token=` on export download links.
Changing the password revokes every token. On the backend, admin-only
endpoints take `Depends(require_admin)` in `app.py`. On the frontend
(`admin.js`), admin-only UI has the `admin-only` class and is hidden while
locked, and admin tabs have the `admin-tab` class and a lock icon.

### Save files

Opening the site shows a console-style **Select File** screen with four
save files that everyone shares. Pick a started file to play it, or an empty
one to start a new game (you name it). **ERASE SELECTED FILE** wipes a file back to empty.
The **FILE n · NAME** chip in the clock box goes back to this screen.

Each file has its own vehicles, trips, game clock, time multiplier and
auto-refuel setting. Vehicle models, gas prices and places are shared by all
four. All four files keep running on the server whether or not anyone has
them open. The browser names the file it's playing in an `X-Save-Slot`
header on every API call (`current_slot()` in `app.py`). An existing
database's world becomes File 1 ("Player 1") on first startup.

Every new file starts with a free 1978 Ford Econoline van, parked in
Minneapolis with a full tank (`STARTER_VEHICLE_MODEL` and `STARTER_PLACE` in
`app.py`). That vehicle model is re-created on startup and on each new file if
it's missing, and it can't be deleted. A vehicle model CSV upload can still
change its stats.

### Gold Doubloons

Each file has a balance in Gold Doubloons, written like dollars
(`$14,328.45`), starting at $10,000.00. Money comes in by delivering loads
(see [Loads](#loads)) and goes out on gas, vehicles and roadside help.
Gas is a real cost: it's charged when it's bought (a Refuel at a station,
the top-up on arriving at one, or a roadside refuel, which costs a full
tank at the nearest station's price plus a $75 fee) and isn't refunded.
Each vehicle tracks what the gas in its tank cost per gallon (a new
vehicle's tank is free). Every charge and payment is on the **Budget**
page (tab menu → Budget, `GET /api/ledger`): vehicle, location, trip, cost
and the balance after it. The balance can go negative; nothing is blocked
yet.

Vehicles cost money too. **Buy Vehicle** charges the model's price, and
**Sell** refunds what was paid (`vehicles.purchase_price`). The inherited
starter van was free, so it sells for nothing, and it can't be bought:
there's only ever one of grandpa's van. The Buy Vehicle list shows it as
not for sale and the backend refuses it, so selling it is for good. Each vehicle also records
its model's price when acquired (`list_price`), for depreciation later. A
vehicle can only be sold while it's parked. It can't be sold while it's
driving, stranded, mid-detour, between a refuel and the next leg, or while
a drive or refuel run for it is still being set up (`vehicle_is_busy()`).

Diesel costs more. Stations have a single price. A vehicle whose model's
fuel type is **diesel** pays that price plus a markup at every fill-up,
roadside refuels included. The markup starts at 18% and is set on the
admin **Gas Prices** tab. It's one setting for all four files
(`global_settings`, `GET`/`PUT /api/global-settings`). Models with no fuel
type set pay the gas price.

### Loads

Vehicles don't go anywhere on their own; they carry loads. Select a parked
vehicle in **My Vehicles** and its **load board** lists real-world
shipments it can carry (office furniture, restaurant produce, a wedding
party, and so on). Each one is picked up within 120 miles of where the
vehicle is parked, nearest first. A row shows the cargo and its size, the
pickup and delivery cities, how far away the pickup is (empty, unpaid
miles), the loaded miles, the pay, the deadline if accepted now, and when
the offer ends. Hover a load to see it on the map; click it to zoom there.

**Accept** sends the vehicle to the pickup, unless it's parked there
already. There it loads up (LOADING) and drives on to the delivery city,
and it's paid on arrival. Refuel detours, auto-refuel, stranding and
roadside fuel all work along the way. Delivering after the deadline pays
75%, and later than the whole time allowed pays 40%. A vehicle with a load
can't be sold, refueled by hand, or given another load until it delivers.

The **Loads** page (tab menu → Loads) lists every load in the save file:
on the board, in progress, delivered (with what it paid, marked if late),
expired and failed. It's newest first, filterable by status and vehicle,
with a summary of counts and total earnings (`GET /api/loads`). An
available load can be accepted from here by any parked vehicle that fits
it, wherever its pickup is. The deadline allows for the drive there.

Money is tagged with its load (`ledger.load_id`). Fuel bought and roadside
fees while a vehicle is hauling a load or heading to pick it up are tagged
with that load, and so is its delivery payment. The Budget page has a
**Load** column and filter. The Loads page shows each load's fuel and fees
so far and, once delivered, what it netted.

- **Cities:** every US city and town of 10,000+ people, except Hawaii and
  Juneau, AK, which no road reaches, bundled in
  `backend/data/us_cities.csv` (4,296 rows). It's from
  [GeoNames](https://www.geonames.org)' `cities5000` list, licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Nothing is
  looked up live. Bigger cities get more loads. A load's cities become
  places only when it's accepted.
- **Board:** made on demand. Opening a vehicle's board
  (`GET /api/vehicles/{id}/loads`) tops it up to 8 loads that fit it.
  Somewhere remote, it widens the search instead of coming up empty: 120
  miles, then 250, then 500, then the 10 nearest cities anywhere
  (`LOAD_SEARCH_RADII`). A note tells you the nearest work is far off, so
  the unpaid drive there is the cost of being out there.
  Offers expire 8–36 game hours after they're posted. Each save file has
  its own board.
- **Fit:** freight fits up to the model's cargo cu ft, and passengers up to
  its seats less the driver.
- **Pay:** per estimated loaded mile, $1.10 plus $0.0045 per cu ft for
  freight, or $0.85 plus $0.15 per passenger, plus a $40 or $30 handling
  fee. Estimated miles are the straight-line distance × 1.25.
- **Deadline:** set when accepted. The estimated miles (to the pickup plus
  loaded) at 45 mph, × 1.5, plus 2 hours.
- **Accepting:** `POST /api/loads/{id}/accept` with `{vehicle_id}` starts
  the first leg as a background job (`load_leg`). `handle_load_arrival()`
  in `settle_arrived_vehicles()` does the pickup, the next leg, and the
  delivery and payment (`load_payment` in the ledger). The constants are
  the `LOAD_*` values in `app.py`.

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
through an internal proxy that isn't subject to that interception.

The proxy is set per machine in `.env` (`HTTP_PROXY` / `HTTPS_PROXY` /
`NO_PROXY`, see `.env.example`). They're used both as Docker build args
(`pip install` goes out over the network too) and as runtime environment
variables (`requests` and geopy honor them automatically). **Leave them
empty for a direct connection** — that's the default, with no proxy
hardcoded anywhere. After changing them, rebuild and recreate the backend:

```bash
docker compose up -d --build backend
```

## Data model

Eight tables, defined in `postgres/init.sql`. **There is no migration
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
| `auto_refuel_level` | integer, default `0` | opt-in auto-refuel perk; `0` = off, `1` = on — see [Auto-refuel](#auto-refuel) |

Seeded lazily by the backend on first use (`get_settings()` in
`app.py`), not by `init.sql` — the anchor has to be comparable to
Python's own `datetime.utcnow()`, which `init.sql` inserting via
Postgres's `NOW()` can't guarantee without depending on the container's
configured timezone.

### `vehicle_models`

A reusable hauling-vehicle-model catalog entry — e.g. "1978 Ford Econoline" — that
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
| `image`                | text    | nullable; a filename under `frontend/images/` (e.g. `"1978-Ford-Econoline.png"`), not a URL — the frontend resolves it against its own origin |
| `created`              | timestamp | default `NOW()`                |

### `places`

The saved-places bank behind the Places tab: every location a vehicle's
starting location or a path's origin/destination has ever resolved to via
`find_or_create_place()` in `app.py`, plus whatever's added directly on
that tab. `vehicles` and `paths` reference a place by id rather than
storing their own copy of its coordinates (see their tables below) — a
place's description/address/lat/lng live in exactly one row no matter how
many vehicles or paths point at it. Deduped by rounded `lat`/`lng` so
typing the same description twice, or two descriptions that resolve to
the same spot, reuses one row rather than creating a near-duplicate place
with a different name.

| Column        | Type    | Notes                          |
|---------------|---------|----------------------------------|
| `id`          | serial  | primary key                     |
| `description` | text    | free text as typed — an address, or a description like "Target near Minneapolis" |
| `address`     | text    | Nominatim's own formatted address for `description`, resolved once at creation |
| `lat` / `lng` | double precision | rounded to `ROUND_DECIMALS`     |
| `continent` / `country` / `state` / `city` | text | nullable — structured breakdown of the same location, derived from Nominatim's `addressdetails` (`extract_address_components()` in `app.py`; `continent` isn't something Nominatim returns at all, so it's derived from the country code via a static lookup, `CONTINENT_BY_COUNTRY_CODE`). Powers the Places tab's filter chips. A place created before these columns existed starts out `NULL` here and gets backfilled — see below |
| `created`     | timestamp | default `NOW()`                |

Most free-text location boxes in the frontend (vehicle starting location,
the Gas Prices tab's add-price box) have a `<datalist>` of these places
wired to it via their `list` attribute, so a saved place can be picked
back up by name without giving up the ability to type a brand-new
description. The Paths tab's origin/destination boxes used to have this
too, but a native `<datalist>` scales with every saved place regardless of
which box is focused — once a
[city search upload](#search-a-city-for-gas-stations) had added tens of
thousands of places, the browser's own autocomplete matching against all
of them made typing in either box noticeably laggy, so `list` was dropped
from just those two.

A place missing `continent`/`country`/`state`/`city` (any pre-existing row
from before those columns existed) is backfilled by re-reverse-geocoding its
own already-known `lat`/`lng` — `_run_backfill_place_locations_job()` in
`app.py`, triggered from `run_migrations()` at every startup but gated on
`WHERE country IS NULL`, so it's a no-op once everything's backfilled and
self-healing (retries) for any place that failed the first time. Like every
other bulk geocoding operation (see `job_executor` in `app.py`) it runs as a
background job, tracked in the `jobs` table and pollable via
`GET /api/jobs/{id}` (or the Background Jobs tab), not inline — backfilling
a lot of pre-existing places could otherwise take a while at Nominatim's 1
request/second limit.

### `gas_prices`

The current price per gallon at a place, powering the Gas Prices map
overlay. One row per place, not a history — `place_id` is the primary key,
so adding a price for a place that already has one (typing it again, or a
re-uploaded CSV/JSON row) updates it in place via upsert
(`upsert_gas_price_row()` in `app.py`) rather than accumulating stale
duplicates.

| Column             | Type    | Notes                          |
|---------------------|---------|----------------------------------|
| `place_id`          | integer | primary key, FK `places(id)`, `ON DELETE CASCADE` |
| `price_per_gallon`  | double precision | must be positive (enforced in the API, not a DB constraint) |
| `brand`             | text, nullable | chain ("Shell", "Costco Gas") or plain name for an unbranded station, distinct from the place's own description/address; shown ahead of the description wherever a station is listed (map tooltip, price list, divert options) |
| `updated`           | timestamp | default `NOW()`, refreshed on every upsert |

**Caching.** The backend keeps every priced station (`gas_prices` joined to
its place) in an in-memory cache (`get_cached_gas_stations()` in `app.py`)
shared by `GET /api/gas-prices`, the divert/auto-refuel station search
(`find_gas_station_options()`) and the drive-to-refuel lookup
(`find_closest_gas_station()`), so those stop re-querying the table on
every call/poll. Every write path — adding/updating a price, a bulk upload
row, deleting a price, deleting a place (which cascades) — calls
`invalidate_gas_station_cache()` after committing. A 5-minute TTL
(`GAS_STATION_CACHE_TTL_SECONDS`) is the backstop for anything that changes
the table outside the API (e.g. manual `psql` edits). `GET /api/gas-prices`
also sends an `ETag` with `Cache-Control: no-cache`, so the browser keeps
the list in its HTTP cache and an unchanged list comes back as an empty
`304` on page reload.

### `vehicles`

| Column         | Type    | Notes                          |
|----------------|---------|----------------------------------|
| `id`           | serial  | primary key                     |
| `name`         | text    | server-generated as `"<year> <brand> <model> <n>"` from the vehicle's vehicle model (see `create_vehicle()` in `app.py`) — not user-typed |
| `place_id`     | integer | FK `places(id)` — where the vehicle currently is, matched against a path's `origin_place_id` to decide which paths it can start a trip on. Set at creation, then repointed at a trip's `destination_place_id` once that trip arrives (`settle_arrived_vehicles()`) — see [Vehicle location](#vehicle-location) below |
| `vehicle_model_id`      | integer | FK `vehicle_models(id)` — hauling vehicle models (including type/brand/model) live on the vehicle model, not duplicated per vehicle |
| `sold`         | boolean | default `false`. Selling a vehicle sets this rather than deleting the row, preserving history (`GET /api/vehicles?include_sold=true`) while "My Vehicles" filters to `sold = false` |
| `sold_at`      | timestamp | nullable                      |
| `created`      | timestamp | default `NOW()`                |

A vehicle's `status` (`READY` / `DRIVING` / `SOLD`) is computed on read
from `sold` and whether it has an active trip — none of that is a stored
column besides `sold` itself.

### `paths`

A path is a specific origin → destination route, geocoded and routed once
and reused for any number of trips. Looking up an existing path is a
plain `origin_place_id`/`destination_place_id` comparison — creating
"minneapolis" → "Chicago" twice resolves both to the same two places and
returns the existing row rather than re-routing.

| Column                  | Type              | Notes |
|-------------------------|-------------------|-------|
| `id`                    | serial            | primary key |
| `origin_place_id` / `destination_place_id` | integer | FK `places(id)` each |
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
| `starting_fuel_gallons`  | double precision  | the vehicle's `fuel_gallons` at the moment this trip started, frozen the same way `traffic_bias`/`zones_snapshot` are — see [Fuel](#fuel) |
| `roadside_refuel_count`  | integer           | how many roadside refuels (`POST /api/vehicles/{id}/roadside-refuel`) have topped this trip back up after running dry mid-route — see [Fuel](#fuel) |
| `paused_seconds`         | double precision  | real schedule-time "refunded" by a roadside refuel, so time spent STRANDED doesn't count as progress — see [Fuel](#fuel) |
| `resume_destination_place_id` | integer FK `places(id)`, nullable | set when this trip is a detour to a gas station — the place the vehicle was actually trying to reach before the detour, so arriving at the station automatically starts a new trip onward to here — see [Divert to gas station](#divert-to-gas-station) |
| `auto_refuel`            | boolean, default `false` | whether arriving at this trip's destination tops the tank back up to full — set explicitly by a diversion or a drive-to-refuel, never inferred from the destination happening to have a `gas_prices` entry — see [Fuel](#fuel) |
| `cancelled_at`           | timestamp, nullable | set when a trip is abandoned mid-route for a diversion instead of ever arriving — excluded from every "is this vehicle currently on a trip" check, the same way an arrived trip is — see [Divert to gas station](#divert-to-gas-station) |
| `trip_meter_offset_miles` | double precision, default `0` | miles already driven on the same journey before this leg — carried forward by a divert (previous offset + miles driven before diverting) and by the resume after refueling (previous offset + the detour's length), so the dashboard trip meter (`trip_meter_miles` in `GET /api/trips/active`) keeps counting through a gas-station stop — see [Divert to gas station](#divert-to-gas-station) |
| `auto_divert_claimed_at` | timestamp, nullable | set when auto-refuel decides to divert this trip, so concurrent polls can't each start their own divert; cleared if that divert job fails — see [Auto-refuel](#auto-refuel) |

A vehicle can only have one trip active at a time (enforced at the
application level in `POST /api/trips`, not a DB constraint) — a cancelled
trip doesn't count as active, so diverting immediately frees the vehicle up
for the replacement trip `POST /api/vehicles/{id}/divert-to-gas-station`
starts in its place.

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
reasons in true drive time.

`PUT /api/settings` rejects the change (409) while any vehicle is
currently in route — changing the multiplier mid-trip would retroactively
rescale a schedule already computed and shown to the user as an ETA, the
same reasoning as `zones_snapshot` freezing a trip's zones at creation
(see [Road zones](#road-zones)). The frontend disables the "Time x"
control the same way (`updateTimeMultiplierControlState()` in `app.js`).

`/api/trips/active` (and `GET /api/vehicles/{id}/city`) used to decide
"is this trip still active" with a plain elapsed-time comparison directly
in SQL: has more (real × `time_multiplier`) time passed than
`realized_duration_seconds`? That's indistinguishable from "arrived" for a
trip that's actually `STRANDED` — frozen partway, real time still passing
normally — so once enough wall-clock time went by, a STRANDED vehicle's
trip silently stopped matching the query entirely: it vanished from the
map, the In Route tab showed no vehicles for it, and its city lookup 404'd,
all while `GET /api/vehicles` (which already used the real,
`resolve_trip_progress()`-based status) still correctly called it
STRANDED — a vehicle "on a trip" by one endpoint and definitely not by
two others. Both endpoints now call `settle_arrived_vehicles()` first
(closing the same gap `gas_station_ahead()`/`divert_to_gas_station()`
already had this for) and pick each vehicle's latest uncancelled trip
(`DISTINCT ON (t.vehicle_id) ... ORDER BY started_at DESC` for the bulk
endpoint, `LIMIT 1` for the single-vehicle one) regardless of elapsed
time, only excluding it once `derive_position()`'s own real progress
says `ARRIVED` - a fallback that rarely fires in practice, since settling
already moved it along by then.

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

### Vehicle location

A vehicle has a persistent `place_id` rather than being usable from
anywhere — set when it's created, and `POST /api/trips` rejects (409)
starting a trip on a path whose `origin_place_id` isn't the same place. A
vehicle can only leave from where it currently is; to send it somewhere
new, create a path whose origin is that location.

`place_id` is **not** updated the moment a trip starts, and not
continuously while driving — it stays at the departure place until the
trip actually arrives, at which point it's repointed at the path's
`destination_place_id`. This happens lazily: `settle_arrived_vehicles()`
in `app.py` runs a single bulk `UPDATE` (all vehicles at once, skipping
any already settled at the right destination) at the top of `GET
/api/vehicles` and `POST /api/trips`, based on the same real-elapsed-vs-
compressed-duration comparison used to decide `DRIVING` status elsewhere
— there's no scheduler/webhook, so it's computed whenever a request
happens to ask. A driving vehicle's actual live position/road is a
separate, already-existing concept (`GET /api/trips/active`,
[Position and speed](#position-and-speed)) — `place_id` only ever points
at a settled place, before or after a trip, never a point mid-route.

Both the vehicle's own `current_location`/`current_lat`/`current_lng` in
API responses and a path's `origin`/`origin_lat`/`origin_lng` (and the
`destination` equivalents) are derived by joining to that place row
rather than stored redundantly anywhere else — so the location text a
vehicle shows in "My Vehicles" and the entry it corresponds to in the
Places tab are guaranteed to read the same, instead of two independently
-resolved labels for the same spot drifting apart (a name here, an
address there, coordinates somewhere else).

Both a vehicle's starting location and a path's origin/destination accept
either a real address or a plain description of a place — e.g. "Target
near Minneapolis" — and both go through `find_or_create_place()`, which
also normalizes " in "/" near " into a comma (`PLACE_IN_PATTERN`) before
handing the text to Nominatim, since its search is a plain token match
rather than a natural-language parser and drops results entirely if either
word is present. Every resolved location is saved to the [`places`](
#places) table so it can be picked back up later from the Places tab or
any location box's autocomplete, instead of being geocoded fresh (and
possibly landing on a different result) each time it's typed again.

The frontend's "Add Vehicle" form requires a starting location, and the
path dropdown for starting a trip (`renderPathSelectForTripVehicle()` in
`app.js`) only offers paths whose origin matches the selected vehicle's
`current_location`, with a hint to create one in the Paths tab if none
exist yet — mirroring the backend's own restriction rather than letting
the user pick an invalid path and only find out on submit. Clicking a
vehicle to select it (in My Vehicles) pans the map to
`current_lat`/`current_lng`; a `DRIVING` vehicle instead pans to its live
trip position (`selectVehicle()`), same as before.

### Fuel

Every vehicle has a tank (`vehicle_models.fuel_tank_gallons`, configured
per template) that drains at `distance / mpg` as it drives and is tracked
per-vehicle (`vehicles.fuel_gallons`). Starting a trip doesn't check
whether there's enough fuel for the whole route — a vehicle is allowed to
depart under-fueled and simply run dry partway there.

**Running out mid-route.** `resolve_trip_progress()` treats a trip's total
fuel budget (`starting_fuel_gallons` plus one more tank per roadside refuel
used, see below) as a fixed distance the vehicle can cover
(`gallons × mpg`). If that's less than the route's full length, the
vehicle's status becomes `STRANDED` at exactly that distance — frozen
there (not still trying to creep forward) until it's refueled one way or
another. Because gallons are consumed by distance, not time, this is
independent of traffic/speed and computed the same way regardless of how
long the vehicle sits there in real time.

`GET /api/vehicles`' own status column is computed two ways that have to
agree: a cheap SQL `CASE` (has the trip's *scheduled* duration elapsed?)
decides DRIVING-or-not up front, and only vehicles it calls DRIVING get
their real, fuel-aware status from `fetch_live_trip_progress()`
(`resolve_trip_progress()` again) to tell STRANDED apart from actually
arrived. Once enough real time passes that the scheduled duration has
"elapsed" — which a STRANDED vehicle, frozen indefinitely, always
eventually does — the cheap `CASE` stops calling it DRIVING at all, so it
never got a live status computed and silently fell back to `READY`: a
real STRANDED vehicle reported as idle, with no badge and no
roadside-refuel button ever offered for it. `fetch_live_trip_progress()`
now runs for every vehicle regardless of what the cheap `CASE` guessed —
it already scopes itself to each vehicle's own latest uncancelled trip, so
this costs nothing extra for a vehicle with no active trip at all.

**Roadside refuel.** `POST /api/vehicles/{id}/roadside-refuel` recovers a
`STRANDED` vehicle in place — no gas station required, since there isn't
one out on the open road — for a flat placeholder fee
(`ROADSIDE_ASSIST_FEE_USD`, not actually charged anywhere; there's no
money/budget system yet). It tops the tank back up (`roadside_refuel_count
+= 1`, extending the trip's total range) and "refunds" the real schedule
time spent stuck (`trips.paused_seconds`) so the trip resumes from where it
stopped instead of jumping ahead by however long the user took to notice.

**Refueling at a real station.** `POST /api/vehicles/{id}/refuel` works for
any `READY` vehicle. If it's already sitting at a place with an entry in
[`gas_prices`](#gas_prices) (a real gas station on the Gas Prices map), it
just tops the tank to full in place. Otherwise it finds the closest gas
station anywhere (`find_closest_gas_station()` — no detour-distance cutoff,
unlike the "ahead" search below, since the vehicle isn't going anywhere yet
to stay ahead *of*) and drives there instead — same background-job
mechanics as [divert to gas station](#divert-to-gas-station), reusing
`_resume_trip_after_refuel()`/`_run_resume_trip_job()` to start the trip.
Arriving refuels and simply parks there (no `resume_destination_place_id`,
so nothing auto-continues afterward — this drive *was* the point, unlike a
mid-route detour).

Whether an arrival tops off the tank is an explicit `trips.auto_refuel`
flag, set only by these two flows — never inferred from whether a
destination happens to have a `gas_prices` entry, since an ordinary trip
ending at a place that's merely priced for gas (e.g. a bulk-uploaded
citywide price dataset) shouldn't silently refuel just because of that
coincidence.

### Divert to gas station

`POST /api/vehicles/{id}/divert-to-gas-station` lets a `DRIVING` vehicle
proactively pull off for gas before it ever runs dry, rather than waiting
to strand and calling roadside assistance.

**Picking a station.** A "Divert to nearest gas station" button on a
`DRIVING` vehicle's own card, clicked on demand (no polling - this used to
be a per-vehicle "watch" toggle plus a pick-one list, but a single button
that just goes to the nearest option is simpler and was what
`divertToNearestGasStation()` in `app.js` actually needed). On click it
calls `GET /api/vehicles/{id}/gas-station-ahead`, which reports every
candidate via `find_gas_station_options()`, sorted by straight-line
distance from the vehicle's live position - the frontend just takes the
first one. A station qualifies either of two ways: it's within
`MAX_GAS_STATION_DETOUR_MILES` (15) of the *remaining* (not-yet-driven)
portion of the route — so a station behind the vehicle never qualifies
through this path, no backtracking — or it's simply within
`NEARBY_GAS_STATION_MILES` (10) of the vehicle's current position, in any
direction, since a short trip to a truly close station is reasonable even
off-route. Sorting by straight-line distance from the vehicle's position
(rather than whichever comes up soonest along the original route) matches
how the diversion itself works: a fresh, direct, OSRM-routed drive from
here to the station, not a continuation of the original one.

Being within `MAX_GAS_STATION_DETOUR_MILES` of the road only means a
station is close to the *route line* - a station near the far end of a
long remaining route qualifies just as easily as one just up ahead, with
nothing tying that to how much fuel is actually left to get there. A
vehicle could otherwise be offered (and pick) a station beyond its own
current range and run dry trying to reach the very station meant to rescue
it. `find_gas_station_options()` takes an optional `max_reachable_miles`
(the vehicle's live `fuel_gallons_remaining × mpg`, computed by
`gas_station_ahead()`) and drops any candidate whose straight-line distance
exceeds 80% of that - a margin because the real road distance is always
`>=` the straight-line one used here, so this errs toward excluding a
marginal station rather than accepting one that turns out not to be
reachable.

Naively checking every station this way is O(stations × route points) -
each candidate's "ahead" check scans every remaining route point looking
for its nearest gap. That's invisible at a handful of hand-entered stations
but became the actual bottleneck once a
[city search upload](#search-a-city-for-gas-stations) could put tens of
thousands of rows in `gas_prices`: at that scale a single call could take
longer than the 3-second poll interval that triggers the next one,
backing up requests and blocking the backend meanwhile. `find_gas_station_options()`
now filters candidates in SQL to a lat/lng bounding box around the
remaining route first (padded by the wider of the two distance
thresholds, so nothing that could actually qualify gets excluded), and
caps the route side of the scan to at most 500 (evenly-strided) points -
more than enough resolution for a 15-mile detour threshold. Together these
cut a worst-case ~16 second call down to about 200ms at 13,000 stations.

**Making the detour.** `POST /api/vehicles/{id}/divert-to-gas-station`,
body `{gas_station_place_id}` (whichever option the user picked — trusted
as-is once it's confirmed to be a real `gas_prices` place, not re-derived
from `find_gas_station_options()` again):

1. Cancels the vehicle's current trip (`trips.cancelled_at`) rather than
   letting it run to completion — a cancelled trip is excluded from every
   "is this vehicle currently on a trip" check the same way an arrived one
   is, and the distance already covered on it is folded directly into
   `vehicles.starting_mileage` (the odometer baseline) since a cancelled
   trip never satisfies the normal completed-trip-miles summing.
2. Turns the vehicle's exact live position into a place
   (`find_or_create_place_by_coords()`) — a reverse geocode, since only
   coordinates are known, not a typed description.
3. Routes there to the chosen gas station (OSRM, same as any other path)
   and starts a new trip, remembering the place the vehicle was *actually*
   trying to reach (`resume_destination_place_id`) — its previous
   destination, or, if it was already mid-detour, whatever that detour was
   itself trying to get back to.

All of this needs live geocoding/routing calls, so — like creating any
other path — it runs as a background job (`job_executor`), and the
frontend polls it the same way `createPath()` does.

**Resuming automatically.** Once that trip actually arrives at the gas
station, `settle_arrived_vehicles()` recognizes `resume_destination_place_id`
is set, tops the tank back up to full (it's a real gas station — that's
why it was chosen), and hands off to `_run_resume_trip_job()` to route
onward from the station to that remembered destination and start a new
trip — automatically continuing the original drive without the user
having to re-plan it.

### Auto-refuel

An opt-in perk, off by default — toggled by the "Auto-refuel" checkbox
under the game clock, stored as `settings.auto_refuel_level`. It's an
integer level rather than a boolean so it can become an upgradeable level
later without a schema change; today `0` is off and `1`
(`AUTO_REFUEL_LEVEL_BASIC`) is the only "on" level. Unlike the time
multiplier, it can be changed while vehicles are in route.

At level 1, a DRIVING vehicle that can't finish its trip on the fuel it
has diverts itself to a gas station when either:

- **low** — its tank is at or under `AUTO_REFUEL_FUEL_FRACTION` (25%) of
  full, or
- **last chance** — it's under `AUTO_REFUEL_LAST_CHANCE_MAX_FRACTION` (75%)
  and there's no other station along the route between just ahead of it
  (`AUTO_REFUEL_MIN_LOOKAHEAD_MILES`, scaled up with the time multiplier)
  and the edge of its range (with the same 0.8 margin the station search
  uses). This is what refuels before a long empty stretch: "low" alone
  stranded a vehicle west of El Reno, OK, where the station data has
  nothing near I-40 for ~200 miles, because by the time it was low every
  reachable station was already behind it.

The last-chance check needs to know where stations sit along the route.
`stations_along_path_miles()` works that out once per path (stations
within `MAX_GAS_STATION_DETOUR_MILES` of the route, matched using a coarse
lat/lng grid) and caches the sorted mileages until the station set changes,
so each poll only does a binary search. When it diverts, it prefers a
station ahead of the vehicle over one behind it.

The check runs inside `settle_arrived_vehicles()`, the pass that already
computes every trip's live fuel level. A background thread
(`_settle_ticker()`) runs that pass every `SETTLE_TICK_SECONDS` (1s), and
requests still run it too. Without the ticker it only ran when the browser
polled, and Chrome throttles a background tab's timers to once a minute.
At 60x that's an hour of driving between checks, so a vehicle could pass
its refuel point and divert too late to make it.

When it fires, `maybe_auto_divert_to_gas_station()` runs the same station
search as the manual button (`find_gas_station_options()`, limited to
what's reachable on the fuel left). That search only measures
straight-line distance, so the job routes up to
`AUTO_DIVERT_MAX_ROUTED_CANDIDATES` (3) of the nearest stations and takes
the first whose road distance fits the remaining range. If none fits, it
takes the shortest by road. It then runs the same
`_divert_to_gas_station()` job, so the detour refuels on arrival and
resumes to the original destination exactly like a manual
[divert](#divert-to-gas-station) does. If no station is in range yet, it
tries again on the next pass as the vehicle keeps moving.

Arrivals are settled with a conditional `UPDATE`, so when the ticker and a
request settle at the same moment only one of them refuels the vehicle and
queues the resume leg.

Auto-refuel can't help where the station data has no stations. The data
covers the US only, with nothing in Canada, so a Lower 48 to Alaska route
crosses a gap of roughly 2,100 miles. That's far beyond any vehicle's
range, so the vehicle fills up at the last US station and runs dry
somewhere in British Columbia.

Trips already headed to a gas station (`auto_refuel = true`) are skipped.
The trip is claimed (`trips.auto_divert_claimed_at`) with a conditional
`UPDATE` before the job is submitted, so concurrent polls can't double-divert;
`_run_auto_divert_job()` clears the claim if the divert fails, so a
transient OSRM/Nominatim error doesn't permanently disable it for that trip.

Because the check is poll-driven, it only fires while something is polling
the backend (i.e. the frontend is open). A vehicle that crosses the
threshold and runs dry with nobody watching ends up STRANDED as usual.

### Search a city for gas stations

The regular bulk gas-price upload (`POST /api/gas-prices/upload`) needs an
exact address per row — it forward-geocodes whatever text you give it
(`find_or_create_place()`), and a plain city name just resolves to that
city's center point, with no real station, brand, or address attached to
it. A `city` column/key is a different kind of row: instead of one exact
place, it means "find the real gas stations in this city and add all of
them", which needs an actual POI search rather than a geocoder.

Nominatim (used everywhere else in the app) is a geocoder, not a business
directory — a free-text query like "gas station in Rochester, MN" mostly
only matches OSM entries whose indexed name literally contains those words,
so real brand-named stations ("Kwik Trip", "Shell", ...) rarely surface.
`find_gas_stations_in_city()` instead:

1. Geocodes the city text via Nominatim to get its bounding box (not just a
   center point).
2. Queries the [Overpass API](https://overpass-api.de) — OSM's actual POI
   query service — for every node/way tagged `amenity=fuel` inside that
   box, tags (`brand`, `name`, `addr:*`) included. A separate, slower
   throttle gate (`_overpass_throttle_gate()`, 1 request/2 seconds) keeps
   this polite to the public Overpass instance independently of the
   1-request/second Nominatim throttle shared by everything else.
   `_query_overpass()` retries a 429/502/503/504 or timeout up to 3 times
   with backoff, since the free public instance intermittently fails that
   way under load regardless of the query itself — without this, one
   transient blip loses a whole city's worth of stations to a row error.

Every station found gets its own place (`find_or_create_place_from_osm_station()`
— same rounded-coordinate dedup as everywhere else, a human-readable
description built from the OSM tags when present, and a reverse geocode
fallback otherwise for its address and continent/country/state/city) and
its own `gas_prices` row at that CSV/JSON row's price, with its real OSM
brand/name — an explicit `brand`/`name` column on a `city` row is ignored,
since each station keeps its own. One `city` row can therefore create many
gas-price rows; `created` in the upload's response counts those, not input
rows.

### Nearby city lookup

`GET /api/vehicles/{id}/city` reverse-geocodes the vehicle's current
position via Nominatim. This is deliberately **not** part of the 1-second
`/api/trips/active` poll — the frontend fetches it on its own slower
7-second timer for just the currently-selected vehicle, and the backend
additionally rate-limits it to 1 request/second (`RateLimiter`) since
Nominatim's public instance enforces that limit itself.

## API reference

All endpoints are on the `backend` service, reached through nginx at
`https://logisim.kjfries.com/api/...` (the backend publishes no port).

| Method & path                  | Description |
|---------------------------------|-------------|
| `GET /api/settings`             | Current game clock and perks: `{time_multiplier, game_time, auto_refuel_level, auto_refuel_max_level}` |
| `PUT /api/settings`             | Change `time_multiplier` and/or `auto_refuel_level`. Body: `{time_multiplier?, auto_refuel_level?}` — a multiplier change re-anchors the game clock at its current value so it speeds up/slows down rather than jumping, and is rejected (409) if any vehicle is currently in route; `auto_refuel_level` (0 to `auto_refuel_max_level`) can be changed any time |
| `POST /api/vehicles`            | Create a vehicle. Body: `{vehicle_model_id, current_location, starting_mileage?}` — `name` is server-generated (`"<year> <brand> <model> <n>"`), not part of the request. Response includes the generated `name`, resolved `vehicle_model`, and resolved `current_lat`/`current_lng`. 400 if `current_location` doesn't resolve |
| `GET /api/vehicles`             | List vehicles with computed `status` (`READY`/`DRIVING`/`STRANDED`/`SOLD`), each vehicle's `vehicle_model`, `fuel_gallons`, `place_id`, and `current_location`/`current_lat`/`current_lng` derived from its place (settled first — see [Vehicle location](#vehicle-location)). `place_id` lets the frontend create a path straight from a vehicle's own place (`POST /api/paths`'s `origin_place_id`) without re-geocoding it. Defaults to the current fleet (`sold = false`, "My Vehicles"); `?include_sold=true` returns full history. No frontend tab currently surfaces the latter — the frontend only ever calls this without the flag |
| `POST /api/vehicles/{id}/sell`  | Mark a vehicle sold (soft-delete). 409 if already sold or currently on a trip |
| `DELETE /api/vehicles/{id}`     | Permanently delete a vehicle (cascades its trips) — distinct from selling; not used by the frontend |
| `POST /api/vehicles/{id}/refuel` | Top off a `READY` vehicle's tank to full if it's already at a gas station, otherwise drives it to the closest one first (202, returns a `job_id` to poll). 409 if it's currently on a trip — see [Fuel](#fuel) |
| `POST /api/vehicles/{id}/roadside-refuel` | Recover a `STRANDED` vehicle in place, no gas station required. Response includes `cost_usd` (a flat placeholder fee, not actually charged anywhere). 409 if the vehicle isn't currently `STRANDED` — see [Fuel](#fuel) |
| `GET /api/vehicles/{id}/gas-station-ahead` | Called on demand (not polled), every gas station near the *remaining* portion of a `DRIVING` vehicle's route or just near its current position, sorted by distance: `{stations: [{place_id, description, brand, lat, lng, price_per_gallon, distance_miles, ahead}, ...]}` (`ahead: false` means it only qualified via proximity, not the route) — see [Divert to gas station](#divert-to-gas-station) |
| `POST /api/vehicles/{id}/divert-to-gas-station` | Detour a `DRIVING` vehicle to a chosen station now. Body: `{gas_station_place_id}`. Automatically resumes to its original destination once refueled there. 202, returns a `job_id` to poll (`GET /api/jobs/{id}`) — see [Divert to gas station](#divert-to-gas-station) |
| `POST /api/vehicle-models`       | Create a hauling-vehicle-model catalog entry. Body: `{year, brand, model, person_capacity, cargo_capacity_cuft, cost, mpg, image?}` |
| `GET /api/vehicle-models`        | List all vehicle models |
| `PUT /api/vehicle-models/{id}`   | Admin. Edit every field of a vehicle model. The starter van keeps its year, brand and model (409) |
| `DELETE /api/vehicle-models/{id}`| Delete a vehicle model. 409 if any vehicle still references it |
| `PUT /api/vehicle-models/{id}/image` | Admin. Upload a picture (multipart `file`, up to 10 MB). It's re-encoded as WebP, fit to 800px and stored in `vehicle_model_images` |
| `DELETE /api/vehicle-models/{id}/image` | Admin. Drop the uploaded picture, falling back to the built-in `image` file if one is set |
| `GET /api/vehicle-models/{id}/image` | The uploaded picture, cached for good (the `image_url` the list returns carries `?v=<hash>`) |
| `POST /api/vehicle-models/image-preview` | Admin. Body: `{url}`. The backend downloads the image (http(s) only, never a private address), normalizes it and returns the WebP without storing it. The page then uploads those bytes |
| `GET /api/vehicles/{id}/city`   | Nearest place name to the vehicle's current position, if driving |
| `GET /api/vehicles/{id}/address`| A settled vehicle's place's saved `address` — used to prefill the Paths tab's Origin field (see [Vehicle location](#vehicle-location)) |
| `POST /api/places`              | Resolve a free-text description or address to a saved place (or return the existing match — see [`places`](#places)). Body: `{description}`. 400 if it doesn't resolve |
| `GET /api/places`               | List all saved places |
| `DELETE /api/places/{id}`       | Delete a saved place. 409 if still referenced by a vehicle or path |
| `POST /api/paths`               | Resolve + route an origin/destination (or return the existing match). Body: `{origin, destination, origin_place_id?}` — when `origin_place_id` is given (the frontend sends the selected vehicle's own `place_id` when Origin was prefilled from it), `origin` is skipped entirely rather than re-geocoded, avoiding a mismatch if Nominatim doesn't return quite the same coordinates for the same address text twice. Response includes `zones` |
| `GET /api/paths`                | List all created paths, each with its `zones` |
| `DELETE /api/paths/{id}`        | Delete a path (cascades its trips and zones) |
| `POST /api/paths/{id}/zones`    | Add a road zone to a path. Body: `{start_miles, end_miles, speed_limit_mph, rush_hour_start?, rush_hour_end?, rush_hour_factor?}` |
| `PUT /api/zones/{id}`           | Update an existing road zone. Same body as create |
| `DELETE /api/zones/{id}`        | Delete a road zone |
| `POST /api/trips`               | Start a trip. Body: `{vehicle_id, path_id, simulated_datetime?, traffic_bias?}`. 409 if the vehicle is already driving, sold, or not at the path's origin |
| `GET /api/trips/active`         | Poll all currently-active trips, each with live position/speed/road name |
| `GET /api/gas-prices`           | List all priced places, each with `price_per_gallon`, `brand`, and the place's `description`/`lat`/`lng` |
| `POST /api/gas-prices`          | Set the price at a place. Body: `{description, price_per_gallon, brand?}` — resolved via `find_or_create_place()` like a vehicle/path location. Upserts: re-submitting for the same place updates its price (and brand) rather than duplicating it. 400 if `price_per_gallon` isn't positive or the location doesn't resolve. Response includes the affected place's full row (`{..., place: {id, description, address, lat, lng, continent, country, state, city}}`) so the frontend can patch its local places state directly instead of re-fetching all of `GET /api/places` (multiple megabytes at tens of thousands of saved places) just to pick up one possibly-new row |
| `DELETE /api/gas-prices/{place_id}` | Remove a place's price. 404 if that place has none |
| `POST /api/gas-prices/upload`   | Bulk-set prices from an uploaded CSV or JSON file (multipart `file` field; `.json` filename parses as JSON, otherwise CSV). Each row/object needs either a description/address (`description`, `address`, or `location`) or a `city` (see [Search a city for gas stations](#search-a-city-for-gas-stations)), plus a price (`price_per_gallon` or `price`) and optionally a brand/name (`brand` or `name` — ignored for `city` rows). A CSV's header row is optional: if row 0 doesn't look like one of those column names (`parse_gas_price_csv()` in `app.py`), every row including row 0 is read positionally as `description, price_per_gallon, brand` — otherwise a whole file with no header would silently fail every row instead of importing anything (`city` rows always need an explicit header). Rows commit independently, so one bad row doesn't roll back the rest — response is `{created, errors: [{row, description, error}, ...]}`, where `created` counts individual gas-price rows written, not input rows (one `city` row can create many) |

Every response is JSON. Any unhandled backend exception returns a generic
`500 {"detail": "Internal server error"}` — the real traceback is only in
the container logs (`docker compose logs backend`), by design (see
`catch_unhandled_exceptions` in `app.py`).

## Frontend

Plain JS + Leaflet, no build step, a single page (`frontend/app.js`,
`frontend/index.html`). Seven tabs, collapsed into a dropdown menu in the
side panel since they don't all fit as a row:

- **Vehicle Models** (admin 🔒) — a full-width page, like Budget, with a
  card per vehicle model. **+ New model** and **Edit** open an editor for
  every field and the picture. A picture can be uploaded (drag and drop or
  browse), fetched from a URL (the server downloads it and keeps its own
  copy), or a built-in file under `frontend/images/`. Uploaded and fetched
  pictures are stored in Postgres (`vehicle_model_images`), re-encoded as
  WebP and fit to 800px, so they're in every database backup and go when
  their model does. An uploaded picture wins over a built-in `image`
  filename. **Export CSV** and **Import CSV** carry the built-in filenames
  only. The starter van can't be deleted or renamed.
  The editor's **Engine** section records size (liters or cubic inches:
  typing in either fills the other), cylinders (3, 4, 5, 6, 8, 10 or 12),
  turbo, fuel type (gasoline or diesel) and transmission (manual or
  automatic). All are optional. They show on each card and as an **Engine:**
  line in the vehicle spotlight, and they travel in the CSV
  (`engine_liters`, `engine_cylinders`, `engine_turbo` as yes or no,
  `fuel_type`, `transmission`). An older CSV without those columns leaves
  existing specs alone. Fuel type affects refueling (see Gold Doubloons).
  **Tires** (4, 6, 8, 10 or 18, optional) sits next to Fuel tank. It shows
  on each card and as a **Tires:** line in the spotlight, and travels in
  the CSV as `tire_count`. New models default to 4.
  The picture has three tools, which run in the browser on a canvas and only
  save with the model:
  - **Crop:** drag a box over what to keep.
  - **Detect vehicle:** an AI cutout. The backend runs IS-Net, the
    open-source salient-object model that rembg ships, on the CPU with
    onnxruntime. It finds the vehicle in a photo and clears everything
    else (street, buildings, shadows, what shows through the windows),
    optionally trimming to just the vehicle. It takes about 3–4 seconds,
    one picture at a time (`POST /api/vehicle-models/cutout`, admin). The
    ~180 MB model is downloaded into the backend image at build time
    (`CUTOUT_MODEL_URL` / `CUTOUT_MODEL_PATH` in `backend/Dockerfile`), so
    it runs offline. It's loaded on first use and holds about 1 GB of
    memory after that.
  - **Remove background:** clears the color around the picture's edge and
    anything joined to it, with a tolerance slider. It's meant for plain
    studio backdrops, not photographed scenes.
  - **Eraser:** a GIMP-style brush for outlining a vehicle by hand, or
    tidying up after Remove background. **Erase** clears and **Restore**
    paints the original back. **Bucket** clears a whole area with one click,
    stopping at what's already erased: trace a closed outline around the
    vehicle, then click the background. **Ctrl+click**, then Ctrl+click
    again, brushes a straight line between the two points (previewed while
    Ctrl is held). Each line's end starts the next, and Esc drops the start
    point. Size and Softness sliders, zoom from
    1× to 4×, and Undo. `[` and `]` change the size, Ctrl+Z undoes, and Alt flips the
    brush while held.
  - **Create icon:** trims to the visible vehicle and squares it to 128px
    with a transparent background, previewed on a light and a dark map.

  That icon becomes the map marker for the model's driving vehicles in
  every view, and it turns to face the way the vehicle is driving. It
  flips so the front leads, east or west, and tilts up to 30° with the road
  heading north or south, so it never ends up upside down. The editor's
  **Front of the vehicle in its icon faces** setting (Left or Right,
  `icon_front`) says which way the picture's front points. Direction comes
  from the trip's `heading`: a 0.6-mile stretch of route around the
  vehicle, computed in `derive_position()`. Models without an icon keep the
  view's own marker. Icons are
  stored in `vehicle_model_icons` and served from
  `GET /api/vehicle-models/{id}/icon` (`PUT` and `DELETE` for admins).
- **Places** — the saved-places bank (see [`places`](#places)). Add one
  directly, or just let it fill in from vehicle/path locations as they're
  typed elsewhere. A row of filter chips above the list — one row per
  continent/country/state/city that's actually present — lets you drill
  down instead of scrolling a flat list once there are a lot of saved
  places; clicking a chip narrows the list and the chip rows below it to
  just what's still reachable, clicking it again clears that level (and
  anything chosen below it). `renderPlaceFilterChips()`/`setPlaceFilter()`
  in `app.js`.
- **My Vehicles** — the current fleet (not sold). Add a vehicle by
  picking a vehicle model from a dropdown (required — vehicle models must exist
  first) and giving it a starting location, pick a path and start a trip
  for a `READY` vehicle (the path dropdown only offers paths departing
  from that vehicle's current location — see [Vehicle
  location](#vehicle-location)), or sell a `READY` vehicle (soft-delete —
  it moves off this list; there's no UI for viewing sold vehicles again,
  though the data and `GET /api/vehicles?include_sold=true` still exist —
  see [`vehicles`](#vehicles)). Selecting a `DRIVING`/`STRANDED` vehicle
  (there used to be a separate "In Route" tab for this — the two were
  merged, since a vehicle's live detail is naturally part of its own card,
  not a second place to go look for it) expands its card in place with a
  speedometer/fuel-dial/odometer instrument cluster, nearest city,
  position, current road, speed, time remaining, and fuel level. A
  `STRANDED` vehicle gets a "Send roadside fuel" button; a `DRIVING` one
  gets a "Divert to nearest gas station" button, which looks one up on
  demand and diverts straight to it (see [Fuel](#fuel) and [Divert to gas
  station](#divert-to-gas-station)).
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
- **Gas Prices** — a persistent map overlay, not a selection-driven marker
  like the Places tab: every priced place gets its own circle marker,
  color-graded green (cheapest currently loaded) to red (priciest)
  relative to each other rather than a fixed dollar scale
  (`gasPriceColor()` in `app.js`). The layer is off by default and toggled
  by the gas pump icon floating over the map; markers are only built while
  it's on, since tens of thousands of them slowed page load badly. Add or update one place's price by description/address
  (reusing the same place resolution as a vehicle/path location), or bulk
  import a CSV/JSON file of `description`/`price_per_gallon` rows — a
  re-uploaded file just refreshes existing prices since they're keyed by
  place (see [`gas_prices`](#gas_prices)).

A clock in the top-right corner of the map (`updateSimClock()`) shows the
current [game time](#game-time) — the same clock the traffic model judges
rush hour against — with a "Rush Hour" badge when it's currently a
weekday 7-9am or 4-6pm, and a "Time x" control next to it to change
`time_multiplier` (`setTimeMultiplier()`, `PUT /api/settings`) — disabled
whenever any vehicle is in route (`updateTimeMultiplierControlState()`,
checked on every `pollActiveTrips()` tick), since the backend rejects
that change anyway. Rather than calling `GET /api/settings` every second,
`loadSettings()` fetches
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

- It's served only over HTTPS, through the Edge reverse proxy: no service
  publishes a port, and nginx refuses requests without Edge's secret.
- No CORS: the page and API share one origin, so other websites a browser
  visits can't read the API.
- Postgres credentials are hardcoded in `docker-compose.yml` and `app.py`
  (`simulator` / `simulator_password`); Postgres is only reachable by the
  backend.
- There's no authentication on any endpoint: anyone who can reach
  `logisim.kjfries.com` can use it.

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
