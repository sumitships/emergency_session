// Shared Redash -> Postgres sync logic, used by both server.js (setInterval mode)
// and sync-redash.js (standalone / Devtron CronJob mode).

async function fetchRedashRows() {
  const queryUrl = process.env.REDASH_QUERY_URL;
  const apiKey = process.env.REDASH_API_KEY;

  if (!queryUrl || !apiKey) {
    console.log('[redash-sync] REDASH_QUERY_URL or REDASH_API_KEY not set, skipping sync');
    return null;
  }

  const url = queryUrl.includes('api_key=')
    ? queryUrl
    : `${queryUrl}${queryUrl.includes('?') ? '&' : '?'}api_key=${apiKey}`;

  const res = await fetch(url);
  const contentType = res.headers.get('content-type') || '';
  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`Redash request failed: ${res.status} ${res.statusText} — ${bodyText.slice(0, 300)}`);
  }
  if (!contentType.includes('application/json')) {
    throw new Error(
      `Redash returned ${res.status} but content-type was "${contentType}" (expected JSON) — ` +
        `REDASH_QUERY_URL is likely pointing at the Redash web page instead of the ` +
        `/api/queries/<id>/results.json endpoint, or the api_key is invalid and Redash ` +
        `redirected to a login page. Body started with: ${bodyText.slice(0, 200)}`
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

// Expected row shape from the Redash saved query:
// { user_id, last_astro_talked_to (astrologer's name), astro_image_url }
// astro_cpm is optional in the row — falls back to DEFAULT_ASTRO_CPM when the
// query doesn't return a rate. Adjust the field mapping below if the actual
// column names differ.
async function syncOnce(pool) {
  if (!pool) {
    console.log('[redash-sync] no DB pool configured, skipping sync');
    return { synced: 0 };
  }

  const rows = await fetchRedashRows();
  if (!rows) return { synced: 0 };

  const fallbackCpm = Number(process.env.DEFAULT_ASTRO_CPM || 20);

  let synced = 0;
  for (const row of rows) {
    const userId = row.user_id ?? row.userid ?? row.userId;
    const astroName =
      row.last_astro_talked_to ??
      row.recent_astro_name ??
      row.astro_name ??
      row.last_astro_name;
    const astroImageUrl =
      row.astro_image_url ?? row.astro_photo_url ?? row.image_url ?? row.photo_url ?? null;
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
