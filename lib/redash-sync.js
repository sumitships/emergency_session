// Shared Redash -> Postgres sync logic, used by both server.js (setInterval mode)
// and sync-redash.js (standalone / Devtron CronJob mode).

const REFRESH_POLL_INTERVAL_MS = 2000;
const REFRESH_TIMEOUT_MS = Number(process.env.REDASH_REFRESH_TIMEOUT_MS || 60000);

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

// Executes the query fresh via Redash's refresh+job-poll flow, rather than
// relying on a cached result. /api/queries/<id>/results.json 404s with
// "No cached result found" if the query has never been run or has no
// refresh schedule configured in Redash — so we can't just GET it directly.
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
  // host + query id so we can trigger a fresh execution instead of relying
  // on a cached result that may not exist.
  const match = queryUrl.match(/^(https?:\/\/[^/]+)\/api\/queries\/(\d+)/);
  if (match) {
    const [, base, queryId] = match;
    try {
      return await refreshAndFetchRows(base, queryId, apiKey);
    } catch (err) {
      if (!err.isKeyScopeForbidden) throw err;

      // Fall back to reading whatever result is already cached. This only
      // works if the query has a Refresh Schedule configured in the Redash
      // UI (query page → schedule icon) — otherwise this 404s with "No
      // cached result found" and someone needs to set that schedule (or
      // switch REDASH_API_KEY to a user-level key) before this can sync.
      console.warn(
        '[redash-sync] REDASH_API_KEY is query-scoped and cannot trigger /refresh ' +
          '("Please use a user API key"). Falling back to the cached result at ' +
          '/results.json — make sure this query has a Refresh Schedule set in the ' +
          'Redash UI so a cached result always exists.'
      );
      const json = await fetchJson(
        withApiKey(`${base}/api/queries/${queryId}/results.json`, apiKey),
        'Redash cached results fetch'
      );
      return extractRows(json, 'Redash cached results fetch');
    }
  }

  // Fallback: treat REDASH_QUERY_URL as a direct results endpoint to GET
  // (e.g. an already-resolved /api/query_results/<id>.json URL).
  const json = await fetchJson(withApiKey(queryUrl, apiKey), 'Redash request');
  return extractRows(json, 'Redash request');
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

  if (rows.length && !rows.some((r) => (r.user_id ?? r.userid ?? r.userId) != null)) {
    console.warn(
      '[redash-sync] none of the fetched rows matched the expected column names — ' +
        'adjust the field mapping in lib/redash-sync.js. Sample row: ' +
        JSON.stringify(rows[0])
    );
  }

  const fallbackCpm = Number(process.env.DEFAULT_ASTRO_CPM || 20);

  let synced = 0;
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

    if (!userId || !astroName) continue;

    await pool.query(
      `INSERT INTO astro_user_lookup (user_id, astro_name, astro_cpm, astro_image_url, synced_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE
       SET astro_name = EXCLUDED.astro_name,
           astro_cpm = EXCLUDED.astro_cpm,
           astro_image_url = EXCLUDED.astro_image_url,
           synced_at = now()`,
      [String(userId), String(astroName), astroCpm, astroImageUrl]
    );
    synced++;
  }

  console.log(`[redash-sync] synced ${synced}/${rows.length} rows`);
  return { synced, total: rows.length };
}

module.exports = { syncOnce, fetchRedashRows };
