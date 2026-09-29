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
  if (!res.ok) {
    throw new Error(`Redash request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();

  const rows = json?.query_result?.data?.rows;
  if (!Array.isArray(rows)) {
    throw new Error('Unexpected Redash response shape: no query_result.data.rows');
  }
  return rows;
}

// Expected row shape from the Redash saved query:
// { user_id, recent_astro_name, astro_cpm }
// Adjust the field mapping below if the actual column names differ.
async function syncOnce(pool) {
  if (!pool) {
    console.log('[redash-sync] no DB pool configured, skipping sync');
    return { synced: 0 };
  }

  const rows = await fetchRedashRows();
  if (!rows) return { synced: 0 };

  let synced = 0;
  for (const row of rows) {
    const userId = row.user_id ?? row.userid ?? row.userId;
    const astroName = row.recent_astro_name ?? row.astro_name ?? row.last_astro_name;
    const astroCpm = row.astro_cpm ?? row.cpm ?? row.astro_talk_cpm;

    if (!userId || !astroName || astroCpm == null) continue;

    await pool.query(
      `INSERT INTO astro_user_lookup (user_id, astro_name, astro_cpm, synced_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE
       SET astro_name = EXCLUDED.astro_name,
           astro_cpm = EXCLUDED.astro_cpm,
           synced_at = now()`,
      [String(userId), String(astroName), Number(astroCpm)]
    );
    synced++;
  }

  console.log(`[redash-sync] synced ${synced}/${rows.length} rows`);
  return { synced, total: rows.length };
}

module.exports = { syncOnce, fetchRedashRows };
