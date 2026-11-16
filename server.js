'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { handleApi, tvFileFor } = require('./src/api');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, url) {
  let rel = url.pathname;
  if (rel === '/') rel = '/index.html';
  if (rel === '/tv' || rel === '/tv/') rel = '/' + tvFileFor(url.searchParams.get('theme'));
  let file;
  try {
    file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel)));
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  // Sensible defaults for a site reachable from the internet.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // only our own Shop TV preview may frame these pages
  res.setHeader('Referrer-Policy', 'same-origin');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url);
  } else {
    res.writeHead(405).end('Method not allowed');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close the other copy of this program, or start with a different port:`);
    console.error('  set PORT=3001 && npm start');
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) lan.push(a.address);
    }
  }
  console.log('');
  console.log('  Nusky Jewellers POS is running.');
  console.log('');
  console.log(`  On this computer:      http://localhost:${PORT}`);
  for (const a of lan) {
    console.log(`  Other counters:        http://${a}:${PORT}`);
    console.log(`  Shop TV rate board:    http://${a}:${PORT}/tv`);
  }
  console.log('');
  console.log('  Keep this window open while the shop is trading. Press Ctrl+C to stop.');
  console.log('');
});
