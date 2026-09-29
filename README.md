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

The Redash saved query is expected to return rows shaped like:
`{ user_id, recent_astro_name, astro_cpm }` (see `lib/redash-sync.js` for the
exact field-name fallbacks it accepts — adjust there if your query's column
names differ).

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

- Exact Redash column names if they differ from `user_id` /
  `recent_astro_name` / `astro_cpm` (adjust `lib/redash-sync.js`).
- Whether this shares the `pooja-fakedoor` Postgres DB or gets its own.
- Sync freshness requirement (hourly vs daily) — controls
  `REDASH_SYNC_INTERVAL_MINUTES` / the CronJob schedule.
