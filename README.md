# Secure Cloud-Based Mineral Production and Traceability System

Working prototype for the ICT431 capstone proposal *"Secure Cloud for Mineral Production and Traceability"* (Mulungushi University). It tracks a mineral batch from the mine to export. Every handling event is appended to a SHA-256 hash-chained audit trail, and any consignment can be verified from its QR code.

**All organisations, people and batches in the demo data are simulated.** Minerals, destinations and sites are modelled on the figures in the proposal (copper to Switzerland/China/Singapore/UAE, Copperbelt and North-Western mines). The system connects to no live production system.

## Stack (proposal Table 3.1)

| Category | Used |
|---|---|
| Backend | Node.js + Express REST API |
| Database | PostgreSQL (`db/schema.sql`: users, batches, events) |
| Frontend | HTML / CSS / JavaScript dashboards (no build step) |
| QR codes | `qrcode` (generation) and `html5-qrcode` (browser camera scanning) |
| Security | JWT (signature, issuer, audience, expiry, algorithm checked), RBAC, SHA-256 hash chain, HTTPS/TLS at the host, Helmet, rate limiting, bcrypt |
| Hosting | Render blueprint included (`render.yaml`); works on Railway/AWS too |
| Testing | Jest + Supertest (67 tests), Postman collection |
| Version control | Git / GitHub (`.gitignore` included) |

## Quick start (zero setup)

```bash
npm install
npm start            # http://localhost:3000
```

With no `DATABASE_URL` it runs on an in-memory PostgreSQL-compatible database (pg-mem), loads the simulated data, and enables the tamper demo. Data is lost on restart.

Demo logins, password `Demo@12345`: `admin`, `mine_solwezi`, `mine_mufulira`, `mine_kalumbila`, `trans_copperbelt`, `wb_kitwe`, `insp_ndola`, `reg_zra`, `buyer_alpine`, `buyer_shenzhen`, and the Namibian operators `border_katima`, `wb_katima`, `port_walvis`.

To try sign-up: click **Request access at your stop** on the login page, pick *Walvis Bay Port*, then sign in as `admin` and approve the request under **Users & stops**.

## Run on real PostgreSQL

```bash
createdb mineral_traceability
cp .env.example .env     # set DATABASE_URL, JWT_SECRET, QR_SECRET (openssl rand -hex 32)
npm start
```

The schema is created automatically on start. With a `DATABASE_URL` the demo data is *not* loaded unless `SEED_DEMO=true`. For a clean first administrator, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` (12+ chars) on the first boot.

## Consignment map and navigation

The dashboard shows a **Consignment movement** map (Leaflet, self-hosted in `public/js/vendor/leaflet`; base tiles from CARTO, with a light and a dark style). Each pin is a consignment at its last recorded place, coloured by stage; a red ring marks a weight discrepancy. The solid line is the route recorded so far, the dashed line the remaining leg to the destination hub (schematic, not a road route). The map follows the search/status filters, and obeys the same role-based visibility as the batch list (`GET /api/map/consignments`).

**Basemap provider.** OpenStreetMap's own tile server blocks deployed apps ("Access blocked" tiles), so the default is CARTO, which needs no key. To use another provider (MapTiler, Stadia Maps, your own), set `TILE_URL`, `TILE_URL_DARK` (optional), `TILE_ATTRIBUTION` in the environment (see `.env.example`); the Content Security Policy follows the configured host automatically. CARTO's free tier is for non-commercial use with attribution; for commercial use take a keyed plan.

Event locations are free text inside the hash chain, so they are never changed. They are placed on the map from the coordinates of the matching **stop** (admins can enter latitude/longitude when adding a stop under *Users & stops*), then from a built-in gazetteer (`src/geo.js`). Places that cannot be located are listed under the map instead of being guessed. Existing PostgreSQL databases get the two new `stops` columns automatically on start.

All navigation lives in one dropdown menu (☰ icon in the header): Dashboard, Consignment map, Scan QR, Register batch, Audit, Users & stops and the public portal, with the signed-in user and Sign out in the same menu. It is a single ☰ icon that opens a dropdown with every option; choosing one opens that page. The public verification page uses the same menu. Existing CSS rules and theme variables are unchanged; the new rules are appended to `public/css/style.css`.

## How it maps to the proposal

**Batch digital identity and QR (objective 2, scope 1-2).** A mine registers a batch and gets a code such as `ZM-CU-2026-0001`. The QR encodes `…/verify.html?t=v1.<code>.<HMAC signature>`. Forged or edited codes, and codes for batches that don't exist, are rejected on scan (risk R3: QR cloning).

**Hash-chained audit trail (objective 3).** Each event stores `prev_hash` and `hash = SHA256(prev_hash | canonical JSON of the event)`, starting from a per-batch genesis hash. The batch row also anchors `head_hash` and `event_count`, so editing a record, deleting one, re-ordering, truncating the tail, or even recomputing a forged chain are all detected (`src/hashchain.js`).

**Chain-of-custody rules.** A state machine enforces the order: registered → processed → in transit → inspected → export approved → exported → received. A weighbridge reading more than 2% from the declared weight flags the batch (under-declaration).

**RBAC (scope 4).**

| Role | Can do |
|---|---|
| Mine operator | Register batches; record processing/dispatch; sees own batches |
| Transporter | Dispatch and checkpoint events |
| Weighbridge | Weight readings and checkpoints |
| Inspector | Inspections and checkpoints (approval rights only) |
| Regulator | Inspect, issue export permit, mark exported; audit all chains |
| Buyer | Read-only on own consignments; confirms receipt after export |
| Border / customs officer | Border checkpoints (e.g. Katima Mulilo); sees only consignments that have left the mine |
| Port operator | Port checkpoints and *Loaded on vessel / shipped* (e.g. Walvis Bay); sees only consignments on the move |
| Admin | User and stop management, approves access requests, all of the above |

Object-level checks apply: a mine cannot read or write another mine's batch.

**Stops and sign-up at each stop.** A *stop* is a place where information is recorded: a mine, weighbridge, border post, port, inspection yard or transport depot, in any country. The login page has a **Request access at your stop** button. The applicant picks their stop and fills in their details, and the stop's type decides their account type (sign up at *Walvis Bay Port* and you become a port operator; at *Katima Mulilo Weighbridge*, a weighbridge officer; at a mine, a mine operator). Regulator, buyer and admin accounts can never be self-registered.

- **Approval:** a new account stays *pending* and cannot sign in until an administrator approves it on **Users & stops**. The admin dashboard shows a banner when requests are waiting.
- **Location locked to the stop:** everything a stop's operator records is stamped with that stop's name, and the location field cannot be edited. A mine operator can only register batches at their own mine.
- **Several operators per mine:** every operator at the same mine shares that mine's batches (record processing, declare *ready for export*, dispatch). Other mines cannot see them.
- **Add a stop in one step:** the admin adds a stop (for example *Tunduma Border Post, Tanzania*) and copies its sign-up link (`/#/signup/<id>`), which opens the form with that stop pre-selected.
- **Route example, Zambia → Namibia → Walvis Bay:** mine operator → *Declared ready for export* → dispatch → Kitwe weighbridge → inspector → regulator issues the export permit and marks it exported at Kasumbalesa → Katima Mulilo border officer (checkpoint) → Katima Mulilo weighbridge → Walvis Bay port operator (*Loaded on vessel / shipped*) → buyer confirms receipt.
- **Privacy:** border and port operators only see consignments that have left the mine (in transit or later), so staff abroad cannot browse batches still being produced.

**Public verification portal (scope 5).** `/verify.html` needs no login. It shows origin, status, the custody timeline and chain validity. Weights, buyers and notes are not exposed publicly.

**Offline scanning (risk R1).** If the device is offline, events are queued in the browser and synced on reconnect. The `client_ref` makes sync idempotent, and synced events are labelled "synced offline".

**Web scanner fallback (risk R5).** `html5-qrcode` camera scanning, plus a paste-the-code field if there is no camera.

**Tamper-detection testing (section 4.2).** The admin's Audit page has a demo that edits a weight directly in the database, bypassing the API. Running the audit then shows the batch as TAMPERED, as does the public page. It is enabled automatically only in the zero-setup demo; elsewhere set `ENABLE_TAMPER_DEMO=true` (never in production).

## Tests

```bash
npm test                                   # in-memory DB
TEST_DATABASE_URL=postgres://user:pw@localhost:5432/empty_test_db npm test   # real PostgreSQL (use an empty DB)
```

The 57 tests cover hash-chain tamper cases, JWT attacks (wrong secret, `alg=none`, wrong issuer/audience, expired), RBAC and object-level authorization, the lifecycle state machine, weight flagging, offline sync idempotency, QR forgery, the public portal's data exposure, tamper detection, and user management. `mineral-traceability.postman_collection.json` holds a few Postman requests (set `baseUrl`).

## Deploy (Render)

1. Push to GitHub, then Render → New → Blueprint → select the repo (`render.yaml` creates the web service and a PostgreSQL database).
2. Set `BASE_URL` to the service's `https://` URL so QR codes point to it.
3. For real use set `SEED_DEMO=false` and provide `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Render provides TLS.

## API summary

`POST /api/auth/login` · `POST /api/auth/signup` (public) · `GET /api/public/stops` (public) · `GET /api/public/verify?t=` (public) · `GET|POST /api/batches` · `GET /api/batches/:code` · `GET /api/batches/:code/qr` · `POST /api/batches/:code/events` · `POST /api/events/sync` · `POST /api/scan/resolve` · `GET /api/audit/verify` · `GET|POST /api/users` · `POST /api/users/:id/approve|reject` · `GET|POST /api/stops` · `PATCH /api/stops/:id/active` · `GET /api/stats`

## Known limits (prototype, per the proposal's scope)

- No integration with ZIMIS/ZRA systems, IoT sensors, or blockchain consensus (declared out of scope).
- The hash chain proves records were not altered after the fact. It cannot prove that the data entered was true when recorded (the "data credibility" gap from section 2.2.3).
- The proposal mentions mutual TLS for partner systems and machine certificates for weighbridges, and notes the Data Protection Act requirement to store data in Zambia. Neither is implemented. Weighbridges use ordinary user tokens, and choosing an in-country host is a deployment decision.
- Sign-up approval relies on the administrator checking that the person really works at the stop they chose. There is no automatic identity check, and the stop's location is not verified by GPS.
- Upgrading an existing PostgreSQL database from the earlier version is automatic on start (new `stops` table and `users.stop_id/status/contact` columns).
- JWTs live in `sessionStorage` and expire after 8 hours. There is no refresh or revocation beyond disabling the account.
- Usability testing with real users and performance benchmarking are evaluation activities still to be done.
