// tests/feature-flag-off.test.ts
// Multiplayer is FEATURE FLAG OFF for internal preview. This proves what OFF means:
//
//   1. netcode server (src/server.ts) with NETCODE_MULTIPLAYER_ENABLED unset / "0" /
//      "false": /health is a bare liveness probe; POST /sessions, GET /sessions/:id,
//      POST /sessions/:id/invite answer 404 even to a valid token; the /play
//      WebSocket upgrade is refused with 404; the persistence backend is never
//      contacted (no replay, no deltas) even when a URL is configured.
//   2. backend module (backend/persistence-delta) with DCS_MULTIPLAYER_ENABLED unset:
//      /persistence/delta and /persistence/delta/replay are the host's 404.
//   3. frontend (DCS_SITE_DIR, default the frontend integration worktree): no file
//      opens a WebSocket, names a ws:// or wss:// URL, the netcode, multiplayer or a
//      party/session protocol frame — there is no multiplayer entrypoint to reach.
//      DCS_SITE_SCAN=skip skips (CI, where no frontend checkout exists) and says so.

import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signHs256Jwt } from '../src/auth';
import { multiplayerFlag } from '../src/feature-flag';
// @ts-ignore — plain ESM module, no types
import { registerPersistenceDelta } from '../backend/persistence-delta/index.mjs';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (extra ? '  — ' + extra : '')); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'flag-off-secret-0123456789abcdef0123456789';
const tok = (sub: string) => signHs256Jwt(SECRET, { sub, exp: Math.floor(Date.now() / 1000) + 600 });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

const children: ChildProcess[] = [];
async function boot(flag: string | undefined, backendBase: string): Promise<{ port: number; out: () => string }> {
  const port = await freePort();
  const env: Record<string, string | undefined> = {
    ...process.env, PORT: String(port), NETCODE_JWT_SECRET: SECRET,
    NETCODE_PERSISTENCE_URL: backendBase, NETCODE_PERSISTENCE_TOKEN: 'x'.repeat(40),
  };
  delete env.NETCODE_MULTIPLAYER_ENABLED;
  if (flag !== undefined) env.NETCODE_MULTIPLAYER_ENABLED = flag;
  const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, ['src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
    child.stdout!.on('data', (d) => { out += d.toString(); if (out.includes('[netcode] listening')) { clearTimeout(t); resolve(); } });
    child.stderr!.on('data', (d) => { out += d.toString(); });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`server exited ${c}: ${out}`)); });
  });
  return { port, out: () => out };
}

/** Raw upgrade request: returns the status line the server answered with. */
function rawUpgrade(port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET /play HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => { buf += d.toString(); });
    s.on('close', () => resolve(buf.split('\r\n')[0] || ''));
    s.on('error', () => resolve(buf.split('\r\n')[0] || ''));
    setTimeout(() => { s.destroy(); }, 3000);
  });
}

/** Files under dir (no .git / node_modules), text-like extensions only. */
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(html?|m?js|cjs|ts|json|css|svg|txt)$|^_redirects$|^_headers$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** What a multiplayer entrypoint in the frontend would have to contain. */
const ENTRYPOINT_PATTERNS: [string, RegExp][] = [
  ['WebSocket constructor', /\bnew\s+WebSocket\s*\(/],
  ['WebSocket global reference', /\bWebSocket\b/],
  ['ws:// or wss:// URL', /\bwss?:\/\//i],
  ['netcode reference', /netcode/i],
  ['multiplayer reference', /multi-?player/i],
  ['party protocol frame', /party_(create|join|launch|leave)/],
  ['session invite route', /\/sessions\/[^'"`\s]*\/invite/],
  ['netcode env/config key', /DCS_NETCODE|NETCODE_|play_url/],
];

async function run(): Promise<boolean> {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES — MULTIPLAYER FEATURE FLAG OFF PROOF    ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  console.log('┌─ flag parsing ────────────────────────────────────────┐');
  check('unset → OFF', multiplayerFlag({}).enabled === false);
  for (const v of ['0', 'false', 'off', 'no', '', ' ', 'enabled', 'TRUE-ish']) check(`"${v}" → OFF`, multiplayerFlag({ NETCODE_MULTIPLAYER_ENABLED: v }).enabled === false);
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) check(`"${v}" → ON`, multiplayerFlag({ NETCODE_MULTIPLAYER_ENABLED: v }).enabled === true);

  // A backend that records every request: with the flag OFF it must see none.
  const hits: string[] = [];
  const backend = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"deltas":[],"complete":true}'); });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
  const backendBase = `http://127.0.0.1:${(backend.address() as net.AddressInfo).port}`;

  for (const flag of [undefined, '0', 'false']) {
    console.log(`┌─ netcode server, NETCODE_MULTIPLAYER_ENABLED=${flag === undefined ? '(unset)' : JSON.stringify(flag)} ─┐`);
    const S = await boot(flag, backendBase);
    const base = `http://127.0.0.1:${S.port}`;
    const auth = { authorization: `Bearer ${tok('alice')}` };
    const health = await fetch(`${base}/health`);
    const hb = await health.json();
    check('/health → 200 {ok:true, multiplayer:"off"} and nothing else', health.status === 200 && JSON.stringify(hb) === '{"ok":true,"multiplayer":"off"}', JSON.stringify(hb));
    const r1 = await fetch(`${base}/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ world_id: 'world-a' }) });
    check('POST /sessions with a VALID token → 404', r1.status === 404);
    check('GET /sessions/:id → 404', (await fetch(`${base}/sessions/abc`, { headers: auth })).status === 404);
    check('POST /sessions/:id/invite → 404', (await fetch(`${base}/sessions/abc/invite`, { method: 'POST', headers: auth })).status === 404);
    check('any other path → 404', (await fetch(`${base}/play`)).status === 404);
    check('/play WebSocket upgrade → HTTP 404 (never 101)', /^HTTP\/1\.1 404/.test(await rawUpgrade(S.port)));
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${S.port}/play`);
      ws.addEventListener('open', () => { ws.close(); resolve(true); });
      ws.addEventListener('error', () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
    check('a real WebSocket client cannot open /play', opened === false);
    check('boot log states the flag is OFF', /multiplayer feature flag OFF/.test(S.out()) && !/WS gateway up/.test(S.out()));
    check('no auth / persistence subsystem was built (no auth or persistence boot lines)', !/\[auth\]|\[persistence\]/.test(S.out()), S.out());
  }
  await sleep(200);
  check('the persistence backend received ZERO requests from OFF servers (no replay, no deltas)', hits.length === 0, hits.join(', '));
  await new Promise<void>((r) => backend.close(() => r()));

  console.log('┌─ backend module /persistence/delta, flag OFF ─────────┐');
  const handler = registerPersistenceDelta({ env: { DCS_NETCODE_INGEST_TOKEN: 'y'.repeat(40) }, accessWorld: async () => 'ok', log: { warn() {}, error() {} } });
  const host = http.createServer(async (req, res) => {
    if (await handler(req, res, (req.url || '').split('?')[0], req.method || 'GET')) return;
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => host.listen(0, '127.0.0.1', () => r()));
  const hb2 = `http://127.0.0.1:${(host.address() as net.AddressInfo).port}`;
  check('registerPersistenceDelta reports disabled: flag_off', handler.status?.enabled === false && handler.status?.reason === 'flag_off');
  check('POST /persistence/delta → host 404', (await fetch(`${hb2}/persistence/delta`, { method: 'POST', headers: { authorization: `Bearer ${'y'.repeat(40)}` }, body: '{}' })).status === 404);
  check('GET /persistence/delta/replay → host 404', (await fetch(`${hb2}/persistence/delta/replay?world_id=w`, { headers: { authorization: `Bearer ${'y'.repeat(40)}` } })).status === 404);
  await new Promise<void>((r) => host.close(() => r()));

  console.log('┌─ frontend: no multiplayer entrypoint ─────────────────┐');
  // Negative control: the scanner must catch a real entrypoint, or a clean scan proves nothing.
  const probe = `const ws = new WebSocket("wss://netcode.example/play"); ws.send(JSON.stringify({type:"party_create"})); // multiplayer`;
  const caught = ENTRYPOINT_PATTERNS.filter(([, re]) => re.test(probe)).length;
  check('scanner control: a synthetic multiplayer entrypoint trips the patterns', caught >= 6, `${caught} patterns matched`);
  const siteDir = process.env.DCS_SITE_DIR || path.join(os.homedir(), 'Developer', 'dcs-games-frontend-integration-29sep2026');
  if (process.env.DCS_SITE_SCAN === 'skip') {
    console.log('⚠️  SKIPPED: DCS_SITE_SCAN=skip — the frontend proof did NOT run');
  } else if (!fs.existsSync(siteDir)) {
    check(`frontend checkout present at ${siteDir} (set DCS_SITE_DIR, or DCS_SITE_SCAN=skip)`, false);
  } else {
    let rev = 'unknown';
    try { rev = execFileSync('git', ['-C', siteDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a repo */ }
    const files = walk(siteDir);
    console.log(`   scanning ${files.length} files in ${siteDir} (HEAD ${rev}, working tree)`);
    check('frontend has pages to scan', files.some((f) => f.endsWith('.html')) && files.length > 10);
    for (const [label, re] of ENTRYPOINT_PATTERNS) {
      const hitsF = files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(siteDir, f));
      check(`frontend: no ${label}`, hitsF.length === 0, hitsF.slice(0, 5).join(', '));
    }
  }

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  FEATURE-FLAG-OFF: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  return fail === 0;
}

async function cleanup() {
  for (const c of children) { c.removeAllListeners('exit'); c.kill('SIGTERM'); }
  await sleep(100);
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
}

run().then(async (ok) => { await cleanup(); process.exit(ok ? 0 : 1); }, async (err) => { console.error(err); await cleanup(); process.exit(1); });
