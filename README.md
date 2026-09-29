# Astro Emergency Connect

Fake-door click-intent test for AstroLokal's "Emergency Astro Connect" feature.
User lands on `?user_id=XXXX`, sees their last-talked astrologer with a
1.5x emergency rate, taps **Try Emergency Session**, and is dropped straight
onto a "you're on the waitlist, ₹0 charged" screen. No real payment or live
chat — this only measures intent.

## Architecture

Same pattern as the sibling `pooja-fakedoor` project: plain Node `http`
server, no Express, Postgres is optional (`getPool()` only connects if
`DATABASE_URL` is set — the app never crashes just because the DB isn't
configured yet).

```
server.js          - http server, static file serving, API routes, schema init
sync-redash.js      - standalone Redash -> Postgres sync (Devtron CronJob)
lib/redash-sync.js  - shared sync logic used by both server.js and sync-redash.js
public/             - index.html (both screens), styles.css, app.js
```

## Data model

```sql
CREATE TABLE astro_user_lookup (
  user_id TEXT PRIMARY KEY,
  astro_name TEXT NOT NULL,
  astro_cpm INTEGER NOT NULL,     -- regular rate, rupees/min
  astro_image_url TEXT,           -- profile photo shown on the avatar; falls back to the AstroLokal sun icon when null
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE waitlist (
  user_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  user_id TEXT,
  event_name TEXT NOT NULL,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Emergency rate = `astro_cpm * EMERGENCY_MULTIPLIER` (default 1.5x), computed
server-side in `/api/lookup`.

Tables auto-create on startup (`CREATE TABLE IF NOT EXISTS`) — no migration
step needed for this fake-door project.

## Redash sync

The Redash saved query (id 20556) returns rows shaped like:
`{ user_id, last_expert_name, last_expert_profile_picture_url }` (see
`lib/redash-sync.js` for the exact field-name fallbacks it accepts).
`astro_cpm` is optional in the row — if the query
doesn't return a rate, `DEFAULT_ASTRO_CPM` is used instead.

Set `REDASH_QUERY_URL` to `https://<redash-host>/api/queries/<id>` (the
`/results.json` suffix is optional — it's stripped off either way).

The sync tries to trigger a fresh execution rather than trust a stale cache:
it POSTs `/api/queries/<id>/refresh`, polls `/api/jobs/<job_id>` until it
finishes (up to `REDASH_REFRESH_TIMEOUT_MS`, default 60s), then fetches
`/api/query_results/<id>.json`.

**Key scope matters here.** A **query-scoped** API key (the one shown on an
individual query's page — this is what the brief expects, since it's
least-privilege) is only allowed to read that query's *cached* result, not
trigger `/refresh` — Redash returns `403 "Please use a user API key"`. When
that happens, the sync automatically falls back to GETting
`/api/queries/<id>/results.json` (the cached result) instead. That only
works if the query has a **Refresh Schedule** configured in the Redash UI
(open the query → schedule/clock icon → set an interval matching how fresh
you need the data) — otherwise even the fallback 404s with "No cached result
found" because nothing has ever populated the cache. A **user-level** API
key (from account profile settings) can skip needing a schedule since it's
allowed to trigger `/refresh` itself, but it's a broader-permission key than
this project needs.

Two ways to run the sync, per the KT brief:

- **Option A (recommended): Devtron CronJob** running `node sync-redash.js`
  on a schedule. Needs `DATABASE_URL`, `REDASH_QUERY_URL`, `REDASH_API_KEY`.
- **Option B (simpler, less robust):** leave `REDASH_QUERY_URL` /
  `REDASH_API_KEY` set on the main app — `server.js` runs the same sync via
  `setInterval` every `REDASH_SYNC_INTERVAL_MINUTES` (default 10).

Never hardcode `REDASH_API_KEY` or `DATABASE_URL` — both go into a Devtron
Secret and get injected as env vars.

## Events tracked

- `astro_emergency_view` — page loaded, user found in lookup table
- `astro_emergency_view_fallback` — page loaded, user not found (generic astrologer shown)
- `start_chat_click` — CTA tapped
- `waitlist_view` — waitlist confirmation screen shown

## Local dev

```bash
npm install
node server.js
# open http://localhost:3000/?user_id=demo123
```

Without `DATABASE_URL` set, the app runs entirely in fail-open mode: lookup
always returns the generic fallback astrologer, and events/waitlist writes
just log to console instead of failing.

## Verifying the DB after deploy

`psql` isn't installed in the container. Open a Devtron pod terminal and run
raw queries from `/app` using the already-installed `pg` package:

```bash
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('SELECT COUNT(*) FROM astro_user_lookup')
  .then((r) => { console.log(r.rows); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
"
```

## Devtron deployment checklist

1. Repo must have a `Dockerfile` at root (done).
2. Create the Devtron app: name pattern `{project_name}-{app_name}`, connect
   your GitHub repo, branch `main`.
3. Container repo pattern: `dev/{project_name}-{app_name}`. Target platform:
   `arm64`.
4. Base chart: **Lokal Deployment custom chart**. Port `3000` in container /
   liveness / readiness blocks (this app listens on `PORT` env, default
   `3000`, and responds `200 ok` at `/healthz`).
5. Public URL pattern: `dev-{project_name}-{app_name}.{app_existing_domain}`.
   Internal tool pattern: `dev-{project_name}-{app_name}.internal.getlokalapp.com`.
6. Secrets: create one secret named `{project_name}-{app_name}` via the GUI
   with `DATABASE_URL`, `REDASH_QUERY_URL`, `REDASH_API_KEY`.
7. Workflow: Build & Deploy from source, trigger set to manual.
8. After deploy, ping C2S/DevOps to create host routing (public or internal +
   Pomerium role), using the message templates from the internal Devtron
   runbook (strip hyphens from db_name/username, e.g.
   `astro_emergency_connect`).

## Open questions carried over from the brief

- Whether this shares the `pooja-fakedoor` Postgres DB or gets its own.
- Sync freshness requirement (hourly vs daily) — controls
  `REDASH_SYNC_INTERVAL_MINUTES` / the CronJob schedule.
