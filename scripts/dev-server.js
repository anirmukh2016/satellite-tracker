// Node server for local dev AND production (Render): serves frontend/ and mounts api/tle.js.
// Usage: npm start  →  http://localhost:8000   (PORT env var overrides)
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tle = require('../api/tle.js');

const ROOT = path.join(__dirname, '..', 'frontend');
const PORT = process.env.PORT || 8000;
const TLE_TTL_MS = 60 * 60 * 1000;     // like Vercel's edge cache: hit upstream ~once an hour
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.md', '.json']);

let tleCache = null; // { at, body }

async function serveTle(req, res) {
  const now = Date.now();
  if (tleCache && now - tleCache.at < TLE_TTL_MS) return send(res, 200, tleCache.body, 'public, max-age=300');
  // Run the handler against a tiny response shim so its output can be cached.
  const out = { code: 200, headers: {}, body: '' };
  const shim = {
    setHeader: (k, v) => { out.headers[k] = v; },
    status(c) { out.code = c; return shim; },
    json(o) { out.body = JSON.stringify(o); },
  };
  await tle(req, shim);
  if (out.code === 200) { tleCache = { at: now, body: out.body }; return send(res, 200, out.body, 'public, max-age=300'); }
  // Upstream down: serve the last good TLE if we have one, however old.
  if (tleCache) return send(res, 200, tleCache.body, 'no-store');
  send(res, out.code, out.body, 'no-store');
}

function send(res, code, body, cache) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', cache);
  res.end(body);
}

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/healthz') { res.statusCode = 200; return res.end('ok'); }
  if (pathname === '/api/tle') return serveTle(req, res).catch(e => send(res, 502, JSON.stringify({ error: e.message }), 'no-store'));

  let rel = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(rel)) rel += '.html'; // cleanUrls, e.g. /blog
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }

  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    const ext = path.extname(file);
    res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      return res.end(zlib.gzipSync(data));
    }
    res.end(data);
  });
}).listen(PORT, () => console.log(`ISS tracker → http://localhost:${PORT}`));
