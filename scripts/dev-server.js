// Local dev server: serves frontend/ and mounts api/tle.js, mimicking Vercel.
// Usage: npm start  →  http://localhost:8000
const http = require('http');
const fs = require('fs');
const path = require('path');
const tle = require('../api/tle.js');

const ROOT = path.join(__dirname, '..', 'frontend');
const PORT = process.env.PORT || 8000;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.md': 'text/markdown', '.json': 'application/json',
};

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/tle') {
    res.status = code => { res.statusCode = code; return res; };
    res.json = obj => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    return tle(req, res);
  }

  let rel = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(rel)) rel += '.html'; // cleanUrls, e.g. /blog
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }

  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, () => console.log(`ISS tracker → http://localhost:${PORT}`));
