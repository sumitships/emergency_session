// Shared Redash -> Postgres sync logic, used by both server.js (optional
// setInterval mode) and sync-redash.js (standalone / Devtron CronJob /
// manual pod-terminal run).
//
// This follows the same pattern as the sibling daily-cast project's
// src/redash-sync.js (github.com/nitink-wq/daily-cast, branch
// redash-booking-sync): a plain GET against Redash's already-cached
// /results.json with a short timeout — no refresh/job-poll dance — plus an
// advisory-locked full-table replace. That earlier attempt at
// trigger-and-poll kept timing out against a 1.6M-row query; this is
// simpler and proven. It does mean Redash needs to have run the query at
// least once (open it in the Redash UI and let it execute, or click
// Refresh — a one-time action, not a recurring schedule) before this can
// read anything.

const REDASH_LOCK_KEY = 'astro-emergency-connect-redash-sync';
const FETCH_TIMEOUT_MS = Number(process.env.REDASH_FETCH_TIMEOUT_MS || 20000);

// Accepts either REDASH_QUERY_URL as a full /api/queries/<id>[/results.json]
// URL (what's already configured), or the sibling project's convention of a
// separate REDASH_HOST + REDASH_QUERY_ID — whichever is set.
function redashResultsUrl() {
  const apiKey = process.env.REDASH_API_KEY;
  if (!apiKey) return null;

  const host = process.env.REDASH_HOST;
  const queryId = process.env.REDASH_QUERY_ID;
  if (host && queryId) {
    return `${host.replace(/\/$/, '')}/api/queries/${queryId}/results.json?api_key=${apiKey}`;
  }

  const queryUrl = process.env.REDASH_QUERY_URL;
  if (!queryUrl) return null;
  const match = queryUrl.match(/^(https?:\/\/[^/]+)\/api\/queries\/(\d+)/);
  if (!match) return null;
  const [, base, id] = match;
  return `${base}/api/queries/${id}/results.json?api_key=${apiKey}`;
}

async function fetchRows() {
  const url = redashResultsUrl();
  if (!url) {
    console.log('[redash-sync] Redash env vars not set, skipping sync');
    return null;
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const contentType = res.headers.get('content-type') || '';
  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`Redash request failed: ${res.status} ${res.statusText} — ${bodyText.slice(0, 300)}`);
  }
  if (!contentType.includes('application/json')) {
    throw new Error(
      `Redash returned ${res.status} but content-type was "${contentType}" (expected JSON) — ` +
        'check the URL/api_key, or that this query has ever been run in the Redash UI ' +
        `(no run yet = no cached result to read). Body started with: ${bodyText.slice(0, 200)}`
    );
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`Redash response was not valid JSON: ${bodyText.slice(0, 300)}`);
  }

  const rows = json?.query_result?.data?.rows;
  if (!Array.isArray(rows)) {
    throw new Error('Unexpected Redash response shape: no query_result.data.rows');
  }
  return rows;
}

// Confirmed row shape from the Redash saved query:
// { user_id, last_expert_name, last_expert_profile_picture_url }
// astro_cpm is optional in the row — falls back to DEFAULT_ASTRO_CPM when
// the query doesn't return a rate.
function normalizeRow(row, fallbackCpm) {
  const userId = row.user_id ?? row.userid ?? row.userId;
  const astroName =
    row.last_expert_name ??
    row.last_astro_talked_to ??
    row.recent_astro_name ??
    row.astro_name ??
    row.last_astro_name;
  const astroImageUrl =
    row.last_expert_profile_picture_url ??
    row.astro_image_url ??
    row.astro_photo_url ??
    row.image_url ??
    row.photo_url ??
    null;
  const astroCpmRaw = row.astro_cpm ?? row.cpm ?? row.astro_talk_cpm;
  const astroCpm = astroCpmRaw == null ? fallbackCpm : Number(astroCpmRaw);

  if (userId == null || !astroName) return null;
  return { userId: String(userId), astroName: String(astroName), astroCpm, astroImageUrl };
}

// Full-table replace inside one transaction, serialized across pods via a
// Postgres advisory lock — mirrors the sibling daily-cast project's
// redash-wallet-sync. Since this table is entirely derived from Redash with
// no other writer, a clean replace (rather than perpetual upsert) also
// keeps it free of stale rows for users the query no longer returns.
async function syncOnce(pool) {
  if (!pool) {
    console.log('[redash-sync] no DB pool configured, skipping sync');
    return { synced: 0 };
  }

  const rawRows = await fetchRows();
  if (!rawRows) return { synced: 0 };

  const fallbackCpm = Number(process.env.DEFAULT_ASTRO_CPM || 20);
  const skippedSamples = [];
  const rows = [];
  for (const raw of rawRows) {
    const normalized = normalizeRow(raw, fallbackCpm);
    if (normalized) {
      rows.push(normalized);
    } else if (skippedSamples.length < 3) {
      skippedSamples.push(raw);
    }
  }

  if (skippedSamples.length) {
    console.warn(
      `[redash-sync] skipped ${rawRows.length - rows.length} row(s) missing user_id/astro name — ` +
        'raw sample(s) (check exact key names/casing against lib/redash-sync.js): ' +
        JSON.stringify(skippedSamples, null, 2)
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [REDASH_LOCK_KEY]);
    await client.query('DELETE FROM astro_user_lookup');
    if (rows.length) {
      await client.query(
        `INSERT INTO astro_user_lookup (user_id, astro_name, astro_cpm, astro_image_url)
         SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[], $4::text[])`,
        [
          rows.map((r) => r.userId),
          rows.map((r) => r.astroName),
          rows.map((r) => r.astroCpm),
          rows.map((r) => r.astroImageUrl),
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  console.log(`[redash-sync] replaced table with ${rows.length}/${rawRows.length} row(s)`);
  return { synced: rows.length, total: rawRows.length };
}

module.exports = { syncOnce, fetchRows };
