// tests/persistence-client.test.ts
// DCS Games CW4 Netcode — C5 persistence client tests
// Proves the HttpDeltaSink POSTs deltas to a CW5-style ingest endpoint correctly:
// payload shape, retry/backoff on transient failure, no-retry on 4xx, per-session
// ordering, and env-based sink selection. Uses a local http server as a stand-in
// for CW5's live endpoint (the real cutover is env-only — same code path).

import http from 'node:http';
import { HttpDeltaSink, LocalDeltaSink, deltaSinkFromEnv } from '../src/persistence-client';
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
  check('no URL → LocalDeltaSink', deltaSinkFromEnv({}) instanceof LocalDeltaSink);
  check('URL set → HttpDeltaSink', deltaSinkFromEnv({ CW5_PERSISTENCE_URL: 'https://x' }) instanceof HttpDeltaSink);
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

  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  PERSISTENCE-CLIENT: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1));
