// Minimal static server for hosting LectureListen (Railway, Render, a VPS, or
// `npm start` locally). No dependencies. Serves only the app's own files.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const PRIVATE = new Set(['server.js']); // served nothing but the page and its assets

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
};

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...HEADERS }).end();
    return;
  }

  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, HEADERS).end();
    return;
  }

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...HEADERS }).end('ok');
    return;
  }

  if (path === '/') path = '/index.html';
  const file = normalize(join(ROOT, path));
  const name = path.slice(1);
  const type = TYPES[extname(file).toLowerCase()];
  const allowed = file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)
    && type && !PRIVATE.has(name) && !name.split('/').some((p) => p.startsWith('.') || p.startsWith('_') || p === 'node_modules');

  if (!allowed) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...HEADERS }).end('Not found');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      // HTML is always revalidated so a redeploy shows up immediately.
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
      ...HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...HEADERS }).end('Not found');
  }
});

server.listen(PORT, () => console.log(`LectureListen running on http://localhost:${PORT}`));

// Railway sends SIGTERM on redeploy; finish in-flight requests, then exit.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
