// Minimal static server for the app (tests and local development). Read-only, no directory listing.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
};

export function serve(port = Number(process.env.PORT) || 8765) {
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, `.${rel}`);
    // Stay inside the app folder; never serve tests, git data or dotfiles.
    if (!file.startsWith(ROOT + path.sep) || /(^|\/)\.|^\/(tests|node_modules)\//.test(rel)) {
      res.writeHead(404).end();
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const s = await serve();
  console.log(`Serving ${ROOT} on http://localhost:${s.address().port}/`);
}
