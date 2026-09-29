// tests/persistence-client.test.ts
// DCS Games CW4 Netcode — C5 persistence client tests
// Proves the HttpDeltaSink POSTs deltas to a CW5-style ingest endpoint correctly:
// payload shape, retry/backoff on transient failure, no-retry on 4xx, per-session
// ordering, and env-based sink selection. Uses a local http server as a stand-in
// for CW5's live endpoint (the real cutover is env-only — same code path).

import http from 'node:http';
import { HttpDeltaSink, LocalDeltaSink, NoopDeltaSink, deltaSinkFromEnv } from '../src/persistence-client';
import { SessionManager } from '../src/session';
import { Gateway, mockTokenVerifier, Transport } from '../src/gateway';
import type { C3Delta } from '../src/types';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkDelta(seq: number, session = 's1'): C3Delta {
  return {
    op: 'place',
    session_id: session,
    world_id: 'world-zombie-school',
    actor_entity_id: 'e_abc',
    tick: seq,
    payload: { entity_id: `obj_${seq}`, object_type: 'house', position: { x: 1, y: 0, z: 1 } },
    ts: new Date().toISOString(),
  };
}

// Spin up a mock CW5 ingest server with controllable behavior.
function mockCw5(opts: { failFirst?: number; reject4xx?: boolean } = {}) {
  const received: C3Delta[] = [];
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/persistence/delta') {
      hits++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (opts.reject4xx) { res.writeHead(400); res.end('bad'); return; }
        if (opts.failFirst && hits <= opts.failFirst) { res.writeHead(503); res.end('try later'); return; }
        try { received.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
        catch { res.writeHead(400); res.end('bad json'); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, received, get hits() { return hits; } };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, () => {
    const addr = server.address();
    resolve(typeof addr === 'object' && addr ? addr.port : 0);
  }));
}

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — C5 PERSISTENCE CLIENT            ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // ===== Env-based sink selection =====
  console.log('┌─ Sink selection from env ─────────────────────────────┐\n');
  const logs: string[] = [];
  const quiet = (m: string) => { logs.push(m); };
  const noop = deltaSinkFromEnv({}, quiet);
  check('no URL → NoopDeltaSink (mode noop)', noop instanceof NoopDeltaSink && noop.mode === 'noop');
  check('no URL → a warning is logged', logs.some((l) => /NOT persisted/.test(l)));
  noop.emit(mkDelta(1));
  check('no-op sink retains nothing, counts the discard', noop.count === 0 && noop.dropped === 1);
  check('NETCODE_PERSISTENCE_URL → HttpDeltaSink', deltaSinkFromEnv({ NETCODE_PERSISTENCE_URL: 'https://x', NETCODE_PERSISTENCE_TOKEN: 't' }, quiet) instanceof HttpDeltaSink);
  check('CW5_PERSISTENCE_URL alias still honoured', deltaSinkFromEnv({ CW5_PERSISTENCE_URL: 'https://x' }, quiet) instanceof HttpDeltaSink);
  const pathed = deltaSinkFromEnv({ NETCODE_PERSISTENCE_URL: 'https://api.example.test/', NETCODE_PERSISTENCE_PATH: '/internal/netcode/delta' }, quiet) as HttpDeltaSink;
  check('NETCODE_PERSISTENCE_PATH overrides the default /persistence/delta', pathed.url === 'https://api.example.test/internal/netcode/delta');
  check('default path is /persistence/delta', (deltaSinkFromEnv({ NETCODE_PERSISTENCE_URL: 'https://api.example.test' }, quiet) as HttpDeltaSink).url === 'https://api.example.test/persistence/delta');
  check('invalid URL → no-op (not a crash)', deltaSinkFromEnv({ NETCODE_PERSISTENCE_URL: 'not a url' }, quiet).mode === 'noop');
  check('non-http scheme → no-op', deltaSinkFromEnv({ NETCODE_PERSISTENCE_URL: 'ftp://x' }, quiet).mode === 'noop');
  check('credentials in URL → no-op', deltaSinkFromEnv({ NETCODE_PERSISTENCE_URL: 'https://u:p@x' }, quiet).mode === 'noop');
  const local = new LocalDeltaSink();
  local.emit(mkDelta(1));
  check('LocalDeltaSink retains deltas', local.count === 1);
  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Happy path: delta POSTed with correct shape =====
  console.log('┌─ Delta POST (happy path) ─────────────────────────────┐\n');
  const m1 = mockCw5();
  const port1 = await listen(m1.server);
  const sink1 = new HttpDeltaSink({ baseUrl: `http://127.0.0.1:${port1}` });
  sink1.emit(mkDelta(10));
  await sleep(200);
  check('CW5 received exactly 1 delta', m1.received.length === 1);
  check('delta shape preserved (op/session/tick/payload)',
    m1.received[0]?.op === 'place' && m1.received[0]?.tick === 10 && !!m1.received[0]?.payload);
  check('sink count incremented', sink1.count === 1);
  m1.server.close();
  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Retry/backoff on transient 503 =====
  console.log('┌─ Retry/backoff on transient failure ──────────────────┐\n');
  const m2 = mockCw5({ failFirst: 2 }); // first 2 attempts 503, then 200
  const port2 = await listen(m2.server);
  const sink2 = new HttpDeltaSink({ baseUrl: `http://127.0.0.1:${port2}`, maxRetries: 3 });
  sink2.emit(mkDelta(20));
  await sleep(1200); // allow backoff retries (~100+200ms + overhead)
  check('delta eventually persisted after retries', m2.received.length === 1);
  check('server saw multiple attempts (retried)', m2.hits >= 3);
  m2.server.close();
  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== No retry on 4xx (permanent) =====
  console.log('┌─ 4xx = permanent (no retry storm) ────────────────────┐\n');
  const m3 = mockCw5({ reject4xx: true });
  const port3 = await listen(m3.server);
  const sink3 = new HttpDeltaSink({ baseUrl: `http://127.0.0.1:${port3}`, maxRetries: 3 });
  sink3.emit(mkDelta(30));
  await sleep(400);
  check('4xx not retried (exactly 1 hit)', m3.hits === 1);
  check('4xx delta not counted as accepted', sink3.count === 0);
  m3.server.close();
  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Per-session ordering =====
  console.log('┌─ Per-session FIFO ordering ───────────────────────────┐\n');
  const m4 = mockCw5();
  const port4 = await listen(m4.server);
  const sink4 = new HttpDeltaSink({ baseUrl: `http://127.0.0.1:${port4}` });
  for (let i = 1; i <= 5; i++) sink4.emit(mkDelta(i, 'sessionX'));
  await sleep(500);
  const ticks = m4.received.map((d) => d.tick);
  check('all 5 deltas persisted', m4.received.length === 5);
  check('deltas applied in tick order (FIFO per session)', JSON.stringify(ticks) === JSON.stringify([1, 2, 3, 4, 5]));
  m4.server.close();
  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Auth header =====
  console.log('┌─ Bearer token forwarded ──────────────────────────────┐\n');
  let sawAuth: string | undefined;
  const authServer = http.createServer((req, res) => {
    sawAuth = req.headers['authorization'];
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.writeHead(200); res.end('{"ok":true}'); });
  });
  const portA = await listen(authServer);
  const sinkA = new HttpDeltaSink({ baseUrl: `http://127.0.0.1:${portA}`, token: 'secret-token' });
  sinkA.emit(mkDelta(99));
  await sleep(200);
  check('Authorization: Bearer header sent', sawAuth === 'Bearer secret-token');
  authServer.close();
  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Envelope: delta_id + Idempotency-Key, stable across retries =====
  console.log('┌─ Envelope + idempotency across retries ───────────────┐\n');
  const seenKeys: string[] = [];
  const seenIds: string[] = [];
  let hitsI = 0;
  const idem = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      hitsI++;
      seenKeys.push(String(req.headers['idempotency-key']));
      try { seenIds.push(JSON.parse(b).delta_id); } catch { /* */ }
      if (hitsI === 1) { res.writeHead(503, { 'retry-after': '0' }); res.end(); return; }
      res.writeHead(200); res.end('{}');
    });
  });
  const portI = await listen(idem);
  const sinkI = new HttpDeltaSink({ baseUrl: `http://127.0.0.1:${portI}`, backoffBaseMs: 10 });
  sinkI.emit(mkDelta(7));
  await sinkI.drain();
  check('body carries a delta_id (uuid)', /^[0-9a-f-]{36}$/.test(seenIds[0] || ''));
  check('Idempotency-Key header == delta_id', seenKeys[0] === seenIds[0]);
  check('retry re-sends the SAME delta_id (backend can dedupe)', seenIds.length === 2 && seenIds[0] === seenIds[1] && sinkI.count === 1);
  idem.close();
  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Bounded: size + queue =====
  console.log('┌─ Bounded size + bounded queue ────────────────────────┐\n');
  const mB = mockCw5();
  const portB = await listen(mB.server);
  const sinkB = new HttpDeltaSink({ baseUrl: `http://127.0.0.1:${portB}`, maxBodyBytes: 1024, log: () => {} });
  const huge = mkDelta(1); huge.payload = { blob: 'x'.repeat(4096) };
  sinkB.emit(huge);
  sinkB.emit(mkDelta(2));
  await sinkB.drain();
  check('oversize delta dropped, never POSTed', sinkB.dropped === 1 && mB.received.length === 1 && mB.received[0].tick === 2);
  mB.server.close();

  // A backend that never answers: emit must stay synchronous and the queue bounded.
  const hanging = http.createServer(() => { /* never respond */ });
  const portH = await listen(hanging);
  const sinkH = new HttpDeltaSink({ baseUrl: `http://127.0.0.1:${portH}`, maxQueue: 5, timeoutMs: 150, maxRetries: 1, backoffBaseMs: 10, log: () => {} });
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) sinkH.emit(mkDelta(i, `s${i % 3}`));
  const emitMs = performance.now() - t0;
  check(`50 emits against a hung backend return synchronously (${emitMs.toFixed(1)}ms)`, emitMs < 50);
  check('queue bounded: 5 pending, 45 dropped immediately', sinkH.pending === 5 && sinkH.dropped === 45);
  // Tick loop keeps running while persistence is stuck.
  let loopTicks = 0;
  const iv = setInterval(() => loopTicks++, 10);
  await sleep(200);
  clearInterval(iv);
  check('event loop keeps ticking while the backend hangs', loopTicks >= 10, `ticks=${loopTicks}`);
  await sinkH.drain();
  check('per-attempt timeout: hung posts give up (retries exhausted → dropped)', sinkH.pending === 0 && sinkH.dropped === 50 && sinkH.count === 0);
  hanging.closeAllConnections?.();
  hanging.close();
  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== End to end: a validated place over the gateway → backend, with actor_user_id =====
  console.log('┌─ Gateway place → POST with actor_user_id ─────────────┐\n');
  let authSeen: string | undefined;
  const mE = mockCw5();
  mE.server.prependListener('request', (req: http.IncomingMessage) => { authSeen = req.headers['authorization']; });
  const portE = await listen(mE.server);
  const sinkE = new HttpDeltaSink({ baseUrl: `http://127.0.0.1:${portE}`, token: 'svc-token' });
  const sm = new SessionManager((d) => sinkE.emit(d));
  const gw = new Gateway(sm, mockTokenVerifier);
  const session = sm.createSession('world-zombie-school');
  const out: any[] = [];
  const tr: Transport = { send: (f) => out.push(f), close: () => {} };
  gw.handleFrame(tr, { type: 'join', token: 'tok:user-42', world_id: 'world-zombie-school', session_id: session.session_id });
  gw.handleFrame(tr, { type: 'place', object_type: 'house', position: { x: 2, y: 0, z: 2 }, rotation: { yaw: 0 } });
  await sinkE.drain();
  const got = mE.received[0] as any;
  check('place delta reached the backend', got?.op === 'place' && got?.world_id === 'world-zombie-school');
  check('delta carries actor_user_id = token sub', got?.actor_user_id === 'user-42' && typeof got?.actor_entity_id === 'string');
  check('service bearer sent', authSeen === 'Bearer svc-token');
  sm.closeAll();
  mE.server.close();
  console.log('\n└──────────────────────────────────────────────────────┘\n');

  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  PERSISTENCE-CLIENT: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1), (err) => { console.error(err); process.exit(1); });
