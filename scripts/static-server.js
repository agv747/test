#!/usr/bin/env node
/**
 * Minimal static file server for local development and automated smoke tests.
 *
 * `npm run dev` uses wrangler (the real Worker runtime). This server exists so the app can
 * be exercised without the Cloudflare toolchain — same SPA fallback behaviour as
 * wrangler's `not_found_handling = "single-page-application"`.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[3] ?? 'public');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

async function readIfFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(ROOT, safePath);
  if (safePath === '/' || safePath === '\\') filePath = join(ROOT, 'index.html');

  let body = await readIfFile(filePath);
  let path = filePath;
  if (!body) {
    // SPA fallback
    path = join(ROOT, 'index.html');
    body = await readIfFile(path);
  }
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
});

server.listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}`);
});
