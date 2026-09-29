// Standalone entrypoint for the Devtron CronJob sync option (Option A in the
// build brief). Run with: node sync-redash.js
// Requires DATABASE_URL, REDASH_QUERY_URL, REDASH_API_KEY as env vars.
const { Pool } = require('pg');
const { syncOnce } = require('./lib/redash-sync');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[sync-redash] DATABASE_URL is required');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS astro_user_lookup (
        user_id TEXT PRIMARY KEY,
        astro_name TEXT NOT NULL,
        astro_cpm INTEGER NOT NULL,
        astro_image_url TEXT,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE astro_user_lookup ADD COLUMN IF NOT EXISTS astro_image_url TEXT;
    `);
    const result = await syncOnce(pool);
    console.log('[sync-redash] done', result);
    process.exit(0);
  } catch (err) {
    console.error('[sync-redash] failed', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
