// tests/server-limits.test.ts
// DCS Games CW4 Netcode — limits on the REAL entrypoint (src/server.ts), over
// real sockets on ephemeral localhost ports. Offline: persistence env stripped.
//
// Proves: WS frame cap (oversized → close 1009, never buffered), unmasked client
// frame → close 1002, WS ping → pong, HTTP body cap (declared + streamed → 413),
// session GC + session cap over HTTP, and fail-closed auth selection at boot
// (no secret → deny-all; mock flag refused in production; mock only in dev).

import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { signHs256Jwt } from '../src/auth';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (extra ? '  — ' + extra : '')); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SECRET = 'limits-test-secret-0123456789abcdef0123456789';
const tok = (sub: string) => signHs256Jwt(SECRET, { sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 });
const WORLD = 'world-limits';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const children: ChildProcess[] = [];
async function boot(extraEnv: Record<string, string>): Promise<{ port: number; out: () => string }> {
  const port = await freePort();
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), ...extraEnv };
  for (const k of ['CW5_PERSISTENCE_URL', 'CW5_PERSISTENCE_TOKEN', 'NETCODE_PERSISTENCE_URL', 'NETCODE_PERSISTENCE_TOKEN']) delete env[k];
  if (!('NETCODE_JWT_SECRET' in extraEnv)) delete env.NETCODE_JWT_SECRET;
  if (!('NETCODE_ALLOW_MOCK_AUTH' in extraEnv)) delete env.NETCODE_ALLOW_MOCK_AUTH;
  if (!('NODE_ENV' in extraEnv)) delete env.NODE_ENV;
  const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, ['src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
    child.stdout!.on('data', (d) => { out += d.toString(); if (out.includes('WS gateway up')) { clearTimeout(timer); resolve(); } });
    child.stderr!.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${out}`)); });
  });
  return { port, out: () => out };
}

async function httpJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
}

/** Open a WS, send a join, resolve with the first reply + a handle. */
async function wsJoin(port: number, token: string, world = WORLD) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  const frames: any[] = [];
  let closeCode: number | null = null;
  ws.addEventListener('message', (ev: MessageEvent) => { try { frames.push(JSON.parse(String(ev.data))); } catch { /* */ } });
  ws.addEventListener('close', (ev: CloseEvent) => { closeCode = ev.code; });
  await new Promise<void>((res, rej) => { ws.addEventListener('open', () => res(), { once: true }); ws.addEventListener('error', () => rej(new Error('ws error')), { once: true }); });
  ws.send(JSON.stringify({ type: 'join', token, world_id: world }));
  const end = Date.now() + 2000;
  while (Date.now() < end && frames.length === 0) await sleep(10);
  return { ws, frames, first: frames[0], closeCode: () => closeCode };
}

/** Raw TCP WebSocket handshake, for frames a browser-grade client will not send. */
function rawWs(port: number): Promise<{ socket: net.Socket; data: () => Buffer; ended: () => boolean }> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /play HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    let hs = false;
    let ended = false;
    socket.on('close', () => { ended = true; });
    socket.on('error', () => { ended = true; });
    socket.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (!hs) {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        if (!buf.subarray(0, i).toString().includes('101')) { reject(new Error('handshake failed')); return; }
        hs = true;
        buf = buf.subarray(i + 4);
        resolve({ socket, data: () => buf, ended: () => ended });
      }
    });
  });
}

function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = crypto.randomBytes(4);
  const data = Buffer.from(payload);
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  if (payload.length >= 126) throw new Error('keep raw frames small');
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, data]);
}

async function run(): Promise<boolean> {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — SERVER LIMITS (real entrypoint)  ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // ===== Server A: tight limits =====
  const A = await boot({
    NETCODE_JWT_SECRET: SECRET,
    NETCODE_MAX_WS_PAYLOAD: '4096',
    NETCODE_MAX_HTTP_BODY: '1024',
    NETCODE_MAX_SESSIONS: '4',
    NETCODE_SESSION_IDLE_MS: '1000',
    NETCODE_SESSION_GC_INTERVAL_MS: '100',
  });
  const base = `http://127.0.0.1:${A.port}`;

  console.log('┌─ WebSocket frame cap ─────────────────────────────────┐\n');
  const c1 = await wsJoin(A.port, tok('alice'));
  check('join with a real token on the limits server', c1.first?.type === 'joined');
  const before = c1.frames.length;
  c1.ws.send(JSON.stringify({ type: 'chat', channel: 'session', text: 'y'.repeat(600) }));
  await sleep(200);
  check('under-cap frame (≈0.6 KiB) is processed normally', c1.frames.slice(before).some((f) => f.type === 'error' && f.code === 'invalid') && c1.closeCode() === null);
  c1.ws.send('{' + 'a'.repeat(8 * 1024));
  await sleep(300);
  check('8 KiB frame over a 4 KiB cap → socket closed with 1009', c1.closeCode() === 1009, `code=${c1.closeCode()}`);
  const c2 = await wsJoin(A.port, tok('bob'));
  c2.ws.send('x'.repeat(256 * 1024));
  await sleep(300);
  check('256 KiB frame → closed 1009 (not buffered + parsed)', c2.closeCode() === 1009, `code=${c2.closeCode()}`);
  const hA = await httpJson(`${base}/health`);
  check('server healthy after oversized frames', hA.body?.ok === true);

  const raw = await rawWs(A.port);
  raw.socket.write(maskedFrame(0x9, Buffer.from('hi')));
  await sleep(150);
  const d = raw.data();
  check('WS ping → pong with the same payload', d[0] === 0x8a && d.subarray(2, 2 + d[1]).toString() === 'hi');
  const raw2 = await rawWs(A.port);
  const payload = Buffer.from(JSON.stringify({ type: 'ping', t: 1 }));
  raw2.socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload])); // UNMASKED
  await sleep(200);
  const d2 = raw2.data();
  check('unmasked client frame → close 1002 and connection ended', d2[0] === 0x88 && d2.readUInt16BE(2) === 1002 && raw2.ended());
  raw.socket.destroy();

  console.log('\n┌─ HTTP body cap ───────────────────────────────────────┐\n');
  const small = await httpJson(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) });
  check('small POST /sessions → 200', small.status === 200);
  const big = await httpJson(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD, pad: 'p'.repeat(4000) }) });
  check('declared body over 1 KiB → 413', big.status === 413 && big.body?.max_bytes === 1024);
  const streamed = await new Promise<{ status: number; closed: boolean }>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: A.port, method: 'POST', path: '/sessions', headers: { 'transfer-encoding': 'chunked' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode || 0, closed: res.headers.connection === 'close' }));
    });
    req.on('error', () => resolve({ status: -1, closed: true }));
    let sent = 0;
    const pump = () => {
      if (sent > 64 * 1024 || req.destroyed) { req.end(); return; }
      sent += 512;
      req.write('z'.repeat(512), () => setTimeout(pump, 1));
    };
    pump();
  });
  check('streamed (chunked, no length) body over cap → 413 + connection: close', streamed.status === 413 && streamed.closed, JSON.stringify(streamed));
  const hA2 = await httpJson(`${base}/health`);
  check('server healthy after oversized bodies', hA2.body?.ok === true);

  console.log('\n┌─ Session cap + GC over HTTP ──────────────────────────┐\n');
  // Sessions so far: `small` (never joined → empty) + the two session-less joins
  // of alice/bob, whose sockets were closed → players held in the 30s grace.
  await sleep(1500); // idle TTL 1s, GC every 100ms
  const hGc = await httpJson(`${base}/health`);
  check('empty session reclaimed by GC; sessions holding reconnects kept', hGc.body?.active_sessions === 2, JSON.stringify(hGc.body));
  check('/health reports sessions_gc_closed >= 1 and max_sessions', hGc.body?.sessions_gc_closed >= 1 && hGc.body?.max_sessions === 4);
  const s1 = await httpJson(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) });
  const s2 = await httpJson(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) });
  const s4 = await httpJson(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) });
  check('sessions created up to cap 4', [s1, s2].every((r) => r.status === 200));
  check('POST /sessions beyond cap → 503 capacity', s4.status === 503 && s4.body?.code === 'capacity');
  const cCap = await wsJoin(A.port, tok('carol'));
  check('session-less join at cap → error capacity', cCap.first?.type === 'error' && cCap.first?.code === 'capacity');
  cCap.ws.close();
  await sleep(1500);
  const s5 = await httpJson(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) });
  check('after idle GC, capacity frees up again', s5.status === 200);

  // ===== Auth selection at boot =====
  console.log('\n┌─ Auth fails closed at boot ───────────────────────────┐\n');
  const B = await boot({});
  const hB = await httpJson(`http://127.0.0.1:${B.port}/health`);
  check('no secret → /health auth: deny-all', hB.body?.auth === 'deny-all');
  check('no secret → loud boot error logged', /refusing all joins/.test(B.out()));
  const bj = await wsJoin(B.port, 'tok:alice');
  check('no secret → mock token refused', bj.first?.code === 'auth');
  const bj2 = await wsJoin(B.port, tok('alice'));
  check('no secret → even a well-formed JWT is refused', bj2.first?.code === 'auth');

  const C = await boot({ NETCODE_ALLOW_MOCK_AUTH: '1', NODE_ENV: 'production' });
  const hC = await httpJson(`http://127.0.0.1:${C.port}/health`);
  const cj = await wsJoin(C.port, 'tok:alice');
  check('mock flag with NODE_ENV=production → deny-all, mock token refused', hC.body?.auth === 'deny-all' && cj.first?.code === 'auth');

  const D = await boot({ NETCODE_ALLOW_MOCK_AUTH: '1', NODE_ENV: 'development' });
  const hD = await httpJson(`http://127.0.0.1:${D.port}/health`);
  const dj = await wsJoin(D.port, 'tok:alice');
  check('mock flag in development → mock auth (dev only), tok:alice joins', hD.body?.auth === 'mock' && dj.first?.type === 'joined');
  check('mock mode logs a warning', /UNSIGNED/.test(D.out()));
  for (const c of [bj, bj2, cj, dj]) try { c.ws.close(); } catch { /* */ }

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  SERVER-LIMITS: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  return fail === 0;
}

async function cleanup() {
  for (const c of children) { c.removeAllListeners('exit'); c.kill('SIGTERM'); }
  await sleep(100);
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
}

run().then(async (ok) => { await cleanup(); process.exit(ok ? 0 : 1); }, async (err) => { console.error(err); await cleanup(); process.exit(1); });
