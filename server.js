const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Pool } = require('pg');
const { syncOnce } = require('./lib/redash-sync');

const PORT = process.env.PORT || 3000;
const DEFAULT_ASTRO_NAME = process.env.DEFAULT_ASTRO_NAME || 'Our Astrologer';
const DEFAULT_ASTRO_CPM = Number(process.env.DEFAULT_ASTRO_CPM || 20);
const EMERGENCY_MULTIPLIER = Number(process.env.EMERGENCY_MULTIPLIER || 1.5);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Fail-open DB pattern: only connect if DATABASE_URL is present. The app
// must keep working (with generic fallback data) even if Postgres isn't
// configured yet, e.g. during local dev or before Devtron secrets exist.
let pool = null;
function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) return null;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', (err) => console.error('[db] idle client error', err));
  return pool;
}

async function ensureSchema() {
  const p = getPool();
  if (!p) {
    console.log('[db] DATABASE_URL not set, running in fail-open mode (no persistence)');
    return;
  }
  await p.query(`
    CREATE TABLE IF NOT EXISTS astro_user_lookup (
      user_id TEXT PRIMARY KEY,
      astro_name TEXT NOT NULL,
      astro_cpm INTEGER NOT NULL,
      astro_image_url TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE astro_user_lookup ADD COLUMN IF NOT EXISTS astro_image_url TEXT;
    CREATE TABLE IF NOT EXISTS waitlist (
      user_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      event_name TEXT NOT NULL,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('[db] schema ready');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // 1MB guard
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fall open to index.html for the root route only; everything else 404s.
      if (pathname === '/') {
        res.writeHead(500);
        return res.end('index.html missing');
      }
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

async function handleLookup(req, res, query) {
  const userId = query.get('user_id');
  const p = getPool();

  if (p && userId) {
    try {
      const { rows } = await p.query(
        'SELECT astro_name, astro_cpm, astro_image_url FROM astro_user_lookup WHERE user_id = $1',
        [userId]
      );
      if (rows.length) {
        const cpm = rows[0].astro_cpm;
        return sendJson(res, 200, {
          found: true,
          astro_name: rows[0].astro_name,
          astro_cpm: cpm,
          emergency_cpm: Math.round(cpm * EMERGENCY_MULTIPLIER),
          astro_image_url: rows[0].astro_image_url || null,
        });
      }
    } catch (err) {
      console.error('[api/lookup] db error, falling back', err);
    }
  }

  // Fail open: no DB, no user_id, or no row found -> generic astrologer.
  return sendJson(res, 200, {
    found: false,
    astro_name: DEFAULT_ASTRO_NAME,
    astro_cpm: DEFAULT_ASTRO_CPM,
    emergency_cpm: Math.round(DEFAULT_ASTRO_CPM * EMERGENCY_MULTIPLIER),
    astro_image_url: null,
  });
}

async function handleEvent(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid json' });
  }
  const { user_id, event_name, meta } = body;
  if (!event_name) return sendJson(res, 400, { ok: false, error: 'event_name required' });

  const p = getPool();
  if (p) {
    try {
      await p.query(
        'INSERT INTO events (user_id, event_name, meta) VALUES ($1, $2, $3)',
        [user_id || null, event_name, meta ? JSON.stringify(meta) : null]
      );
    } catch (err) {
      console.error('[api/event] db error', err);
    }
  } else {
    console.log('[event]', event_name, user_id || '(no user_id)', meta || '');
  }
  return sendJson(res, 200, { ok: true });
}

async function handleWaitlist(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid json' });
  }
  const { user_id } = body;
  if (!user_id) return sendJson(res, 400, { ok: false, error: 'user_id required' });

  const p = getPool();
  if (p) {
    try {
      await p.query(
        'INSERT INTO waitlist (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        [user_id]
      );
      await p.query(
        'INSERT INTO events (user_id, event_name) VALUES ($1, $2)',
        [user_id, 'waitlist_joined']
      );
    } catch (err) {
      console.error('[api/waitlist] db error', err);
    }
  } else {
    console.log('[waitlist] joined (no db)', user_id);
  }
  return sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = url;

  try {
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    if (pathname === '/api/lookup' && req.method === 'GET') {
      return await handleLookup(req, res, searchParams);
    }

    if (pathname === '/api/event' && req.method === 'POST') {
      return await handleEvent(req, res);
    }

    if (pathname === '/api/waitlist' && req.method === 'POST') {
      return await handleWaitlist(req, res);
    }

    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error('[server] unhandled error', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'internal error' }));
  }
});

async function startRedashSyncLoop() {
  // Opt-in only. REDASH_QUERY_URL/REDASH_API_KEY are also needed for manual
  // one-off `node sync-redash.js` runs (e.g. from a Devtron pod terminal),
  // and merely having them set must not silently also start a recurring
  // background sync here — that's a separate decision (REDASH_AUTO_SYNC).
  if (process.env.REDASH_AUTO_SYNC !== 'true') {
    console.log('[redash-sync] REDASH_AUTO_SYNC not set to "true", setInterval sync disabled (run node sync-redash.js manually, or as a Devtron CronJob, instead)');
    return;
  }

  const p = getPool();
  if (!p || !process.env.REDASH_QUERY_URL || !process.env.REDASH_API_KEY) return;

  const intervalMinutes = Number(process.env.REDASH_SYNC_INTERVAL_MINUTES || 10);
  const run = () => syncOnce(p).catch((err) => console.error('[redash-sync] failed', err));

  run(); // sync once on boot
  setInterval(run, intervalMinutes * 60 * 1000);
  console.log(`[redash-sync] scheduled every ${intervalMinutes}m (setInterval mode)`);
}

ensureSchema()
  .then(() => startRedashSyncLoop())
  .catch((err) => console.error('[startup] schema init failed, continuing fail-open', err))
  .finally(() => {
    server.listen(PORT, () => console.log(`astro-emergency-connect listening on :${PORT}`));
  });
