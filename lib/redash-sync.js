// Shared Redash -> Postgres sync logic, used by both server.js (setInterval mode)
// and sync-redash.js (standalone / Devtron CronJob mode).

const REFRESH_POLL_INTERVAL_MS = 2000;
// Only hit when there's no cached result at all (see fetchRedashRows) — a
// large query can legitimately take several minutes on Redash's side, so
// this default is generous. Override with REDASH_REFRESH_TIMEOUT_MS.
const REFRESH_TIMEOUT_MS = Number(process.env.REDASH_REFRESH_TIMEOUT_MS || 20 * 60 * 1000);

function withApiKey(url, apiKey) {
  return url.includes('api_key=') ? url : `${url}${url.includes('?') ? '&' : '?'}api_key=${apiKey}`;
}

async function fetchJson(url, context) {
  const res = await fetch(url);
  const contentType = res.headers.get('content-type') || '';
  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`${context} failed: ${res.status} ${res.statusText} — ${bodyText.slice(0, 300)}`);
  }
  if (!contentType.includes('application/json')) {
    throw new Error(
      `${context} returned ${res.status} but content-type was "${contentType}" (expected JSON) — ` +
        `the URL is likely wrong or the api_key is invalid (Redash often redirects to an HTML ` +
        `login page instead of erroring). Body started with: ${bodyText.slice(0, 200)}`
    );
  }
  try {
    return JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`${context} was not valid JSON: ${bodyText.slice(0, 300)}`);
  }
}

function extractRows(json, context) {
  const rows = json?.query_result?.data?.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`${context}: unexpected Redash response shape (no query_result.data.rows)`);
  }
  return rows;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchCachedRows(base, queryId, apiKey) {
  const json = await fetchJson(
    withApiKey(`${base}/api/queries/${queryId}/results.json`, apiKey),
    'Redash cached results fetch'
  );
  return extractRows(json, 'Redash cached results fetch');
}

// Triggers a brand-new execution via Redash's refresh+job-poll flow. Only
// used as a fallback (see fetchRedashRows) — forcing a fresh synchronous
// execution on every sync would be needlessly slow/expensive for a large
// query when a cached result is usually already available.
async function refreshAndFetchRows(base, queryId, apiKey) {
  const refreshUrl = withApiKey(`${base}/api/queries/${queryId}/refresh`, apiKey);
  const refreshRes = await fetch(refreshUrl, { method: 'POST' });
  const refreshBody = await refreshRes.text();
  if (!refreshRes.ok) {
    const err = new Error(`Redash refresh failed: ${refreshRes.status} ${refreshRes.statusText} — ${refreshBody.slice(0, 300)}`);
    // A query-scoped API key (the normal, least-privilege kind — see the
    // "API Key" section on an individual query's page) is only allowed to
    // read that query's cached result, not trigger execution. Only a
    // user-level key (from account profile settings) can hit /refresh.
    err.isKeyScopeForbidden = refreshRes.status === 403 && /user api key/i.test(refreshBody);
    throw err;
  }
  let job;
  try {
    job = JSON.parse(refreshBody).job;
  } catch (e) {
    throw new Error(`Redash refresh response was not valid JSON: ${refreshBody.slice(0, 300)}`);
  }
  if (!job?.id) {
    throw new Error(`Redash refresh response had no job id: ${refreshBody.slice(0, 300)}`);
  }

  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  let queryResultId = job.query_result_id || null;

  while (!queryResultId) {
    if (Date.now() > deadline) {
      throw new Error(`Redash query ${queryId} did not finish executing within ${REFRESH_TIMEOUT_MS}ms`);
    }
    await sleep(REFRESH_POLL_INTERVAL_MS);
    const jobJson = await fetchJson(withApiKey(`${base}/api/jobs/${job.id}`, apiKey), 'Redash job poll');
    const status = jobJson?.job?.status;
    if (status === 4 || status === 5) {
      throw new Error(`Redash query ${queryId} execution failed: ${jobJson?.job?.error || 'unknown error'}`);
    }
    if (status === 3) {
      queryResultId = jobJson.job.query_result_id;
    }
  }

  const resultJson = await fetchJson(
    withApiKey(`${base}/api/query_results/${queryResultId}.json`, apiKey),
    'Redash query_results fetch'
  );
  return extractRows(resultJson, 'Redash query_results fetch');
}

async function fetchRedashRows() {
  const queryUrl = process.env.REDASH_QUERY_URL;
  const apiKey = process.env.REDASH_API_KEY;

  if (!queryUrl || !apiKey) {
    console.log('[redash-sync] REDASH_QUERY_URL or REDASH_API_KEY not set, skipping sync');
    return null;
  }

  // REDASH_QUERY_URL is expected to look like
  // https://<redash-host>/api/queries/<id>[/results.json] — extract the
  // host + query id.
  const match = queryUrl.match(/^(https?:\/\/[^/]+)\/api\/queries\/(\d+)/);
  if (match) {
    const [, base, queryId] = match;

    // Prefer whatever's already cached — fast, no waiting on execution.
    // This is what the query's own Refresh Schedule (set in the Redash UI)
    // keeps warm. Only fall back to triggering a brand-new synchronous
    // execution when there's no cache yet at all (first run before the
    // schedule has fired, or no schedule configured), since forcing a
    // fresh execution on every sync would be needlessly slow for a large
    // query.
    try {
      return await fetchCachedRows(base, queryId, apiKey);
    } catch (cacheErr) {
      console.warn(
        `[redash-sync] no usable cached result yet (${cacheErr.message.slice(0, 150)}), ` +
          'triggering a fresh execution instead — this can take a while for a large query'
      );
    }

    try {
      return await refreshAndFetchRows(base, queryId, apiKey);
    } catch (err) {
      if (!err.isKeyScopeForbidden) throw err;
      // A query-scoped API key can't trigger /refresh, and there's no
      // cache to fall back to either — nothing left to try.
      throw new Error(
        'No cached result exists for this query yet, and REDASH_API_KEY is ' +
          'query-scoped so it cannot trigger /refresh ("Please use a user API key"). ' +
          'Set a Refresh Schedule on this query in the Redash UI (so a cached result ' +
          'exists for next time), or use a user-level API key instead.'
      );
    }
  }

  // Fallback: treat REDASH_QUERY_URL as a direct results endpoint to GET
  // (e.g. an already-resolved /api/query_results/<id>.json URL).
  const json = await fetchJson(withApiKey(queryUrl, apiKey), 'Redash request');
  return extractRows(json, 'Redash request');
}

const UPSERT_BATCH_SIZE = 500;

async function upsertBatch(pool, batch) {
  const values = [];
  const placeholders = batch.map((r, i) => {
    const base = i * 4;
    values.push(r.userId, r.astroName, r.astroCpm, r.astroImageUrl);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, now())`;
  });

  await pool.query(
    `INSERT INTO astro_user_lookup (user_id, astro_name, astro_cpm, astro_image_url, synced_at)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (user_id) DO UPDATE
     SET astro_name = EXCLUDED.astro_name,
         astro_cpm = EXCLUDED.astro_cpm,
         astro_image_url = EXCLUDED.astro_image_url,
         synced_at = now()`,
    values
  );
}

// Confirmed row shape from the Redash saved query:
// { user_id, last_expert_name, last_expert_profile_picture_url }
// astro_cpm is optional in the row — falls back to DEFAULT_ASTRO_CPM when the
// query doesn't return a rate.
async function syncOnce(pool) {
  if (!pool) {
    console.log('[redash-sync] no DB pool configured, skipping sync');
    return { synced: 0 };
  }

  const rows = await fetchRedashRows();
  if (!rows) return { synced: 0 };

  const fallbackCpm = Number(process.env.DEFAULT_ASTRO_CPM || 20);
  const skippedSamples = [];
  const toUpsert = [];

  for (const row of rows) {
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

    if (!userId || !astroName) {
      if (skippedSamples.length < 3) skippedSamples.push(row);
      continue;
    }

    toUpsert.push({ userId: String(userId), astroName: String(astroName), astroCpm, astroImageUrl });
  }

  // Batched, sequential upserts — 1.6M individual awaited INSERTs would take
  // far too long and hammer the connection pool. Sequential (not parallel)
  // batches keep memory/connection use bounded regardless of row count.
  let synced = 0;
  for (let i = 0; i < toUpsert.length; i += UPSERT_BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + UPSERT_BATCH_SIZE);
    await upsertBatch(pool, batch);
    synced += batch.length;
    if (synced % (UPSERT_BATCH_SIZE * 20) === 0 || synced === toUpsert.length) {
      console.log(`[redash-sync] progress: ${synced}/${toUpsert.length} upserted`);
    }
  }

  if (skippedSamples.length) {
    console.warn(
      `[redash-sync] skipped ${rows.length - synced} row(s) missing user_id/astro name — ` +
        'raw sample(s) (check exact key names/casing against lib/redash-sync.js): ' +
        JSON.stringify(skippedSamples, null, 2)
    );
  }

  console.log(`[redash-sync] synced ${synced}/${rows.length} rows`);
  return { synced, total: rows.length };
}

module.exports = { syncOnce, fetchRedashRows };
