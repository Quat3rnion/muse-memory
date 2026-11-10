// Manual test harness. Run: bun test/harness/dev.ts
// It builds the extension, starts the built service against a scratch musemem home, and serves
// a web page that acts as the OpenChamber host for the panel. Open the printed URL in a browser.
//
// Environment:
//   MUSE_HOME      scratch musemem home (default $TMPDIR/musemem-ui-test). Never your real home.
//   MEM0_USER_ID   scratch Mem0 user (default musemem-ui-test).
//   HARNESS_READONLY=1  refuse all changes. Required to point MUSE_HOME at your real home.
//   HARNESS_PORT   web port (default: a free port). Do not use 3000 or 4095.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '../..');
const museHome = process.env.MUSE_HOME ?? path.join(os.tmpdir(), 'musemem-ui-test');
const mem0User = process.env.MEM0_USER_ID ?? 'musemem-ui-test';
// Read-only mode: the proxy refuses every POST, so the panel can show real data without changes.
const readOnly = process.env.HARNESS_READONLY === '1';
if (path.resolve(museHome) === os.homedir() && !readOnly) {
  console.error('MUSE_HOME is your real home. Use a scratch folder, or set HARNESS_READONLY=1.');
  process.exit(1);
}
fs.mkdirSync(museHome, { recursive: true });

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

if (process.env.HARNESS_SKIP_BUILD !== '1') spawnSync('bun', ['run', 'build'], { cwd: root, stdio: 'inherit' });
const servicePort = await freePort();
const token = 'harness-token';
const service = spawn('node', [path.join(root, 'service/main.js')], {
  env: {
    PATH: process.env.PATH ?? '',
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    MUSE_HOME: museHome,
    MEM0_USER_ID: mem0User,
    OPENCHAMBER_SERVICE_PORT: String(servicePort),
    OPENCHAMBER_SERVICE_TOKEN: token,
  },
  stdio: 'inherit',
});
for (let i = 0; i < 100; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${servicePort}/health`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) break;
  } catch {
    // not ready
  }
  await sleep(100);
}

const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const port = Number(process.env.HARNESS_PORT ?? 0);
if (port === 3000 || port === 4095) {
  console.error('Ports 3000 and 4095 are reserved. Use another HARNESS_PORT.');
  process.exit(1);
}
const web = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response(Bun.file(path.join(import.meta.dir, 'host.html')), { headers: { 'content-type': 'text/html' } });
    if (url.pathname.startsWith('/panel/')) {
      const file = path.join(root, 'panel', path.basename(url.pathname));
      if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(Bun.file(file), { headers: { 'content-type': mime[path.extname(file)] ?? 'text/plain' } });
    }
    if (url.pathname === '/svc' && req.method === 'POST') {
      const r = (await req.json()) as { method: string; path: string; query?: Record<string, string>; body?: string };
      if (readOnly && r.method !== 'GET') return Response.json({ status: 403, body: JSON.stringify({ error: 'The harness is read-only.' }) });
      const q = r.query ? `?${new URLSearchParams(r.query).toString()}` : '';
      const res = await fetch(`http://127.0.0.1:${servicePort}${r.path}${q}`, {
        method: r.method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(r.body !== undefined ? { body: r.body } : {}),
      });
      return Response.json({ status: res.status, body: await res.text() });
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`HARNESS_URL http://127.0.0.1:${web.port}/`);
console.log(`MUSE_HOME ${museHome}  MEM0_USER_ID ${mem0User}${readOnly ? '  READ-ONLY' : ''}`);

const stop = (): void => {
  service.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
