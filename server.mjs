// Static file server for five ports: four pass views plus one locator page.
// Each port injects its own /config.js so the same files serve every view.

// ---------------------------------------------------------------------------
//
//
// ---------------------------------------------------------------------------

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST ?? '127.0.0.1';

const SERVERS = [
  { port: Number(process.env.PASS_4_PORT ?? 8771), passIndex: 4, mode: 'locator', label: 'pass-4 camera fragments · lightMVP z (about X)' },
  { port: Number(process.env.PASS_5_PORT ?? 8772), passIndex: 5, mode: 'locator', label: 'pass-5 light fragments · lightMVP z (about X)' },
  { port: Number(process.env.PASS_2_PORT ?? 8773), passIndex: 2, mode: 'locator', label: 'pass-2 camera fragments · lightMVP z (about Y)' },
  { port: Number(process.env.PASS_3_PORT ?? 8774), passIndex: 3, mode: 'locator', label: 'pass-3 light fragments · lightMVP z (about Y)' },
  { port: Number(process.env.LOCATOR_PORT ?? 8775), passIndex: 2, mode: 'locator', label: 'locator · world point -> pixel' },
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function configScript({ passIndex, port, mode = 'pass' }) {
  return `
window.__MESH_NON_MATCHING__ = ${JSON.stringify(
    { passIndex, port, mode, passCount: SERVERS.length - 1 },
    null,
    2,
  )};
`;
}

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded === '/' ? '/index.html' : decoded;
  const absolute = path.join(ROOT, path.normalize(relative));

  if (!absolute.startsWith(ROOT)) return null;

  try {
    const info = await stat(absolute);
    if (info.isDirectory()) return resolveFile(path.join(relative, 'index.html'));
    return absolute;
  } catch {
    return null;
  }
}

function createServer({ port, passIndex, mode, label }) {
  const server = http.createServer(async (request, response) => {
    const url = request.url ?? '/';

    if (url.startsWith('/config.js')) {
      response.writeHead(200, {
        'content-type': MIME_TYPES['.js'],
        'cache-control': 'no-store',
      });
      response.end(configScript({ passIndex, port, mode }));
      return;
    }

    if (url === '/healthz') {
      response.writeHead(200, { 'content-type': MIME_TYPES['.json'], 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, port, passIndex, mode, label }));
      return;
    }

    const filePath = await resolveFile(url);
    if (!filePath) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`404 Not Found: ${url}`);
      return;
    }

    const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, {
      'content-type': mime,
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, HOST, () => {
      console.log(`[mesh_non_matching] ${label.padEnd(24)} http://${HOST}:${port}/  (passIndex=${passIndex})`);
      resolve(server);
    });
  });
}

const servers = await Promise.all(SERVERS.map(createServer));

console.log('');
console.log('one pass per port:');
for (const { port, passIndex, mode, label } of SERVERS) {
  const kind = mode === 'locator' ? `pass ${passIndex} + locator` : `pass ${passIndex}`;
  console.log(`  ${kind.padEnd(18)} ->  http://${HOST}:${port}/   ${label}`);
}
console.log('');
console.log('Ctrl+C to stop');

async function shutdown(signal) {
  console.log(`\nreceived ${signal}, closing every port...`);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
