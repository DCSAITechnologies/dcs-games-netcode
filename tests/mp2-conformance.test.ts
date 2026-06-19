// tests/mp2-conformance.test.ts
// DCS Games CW4 Netcode — M-P2 Integration / Conformance Harness
//
// M-P2 = CW3 (or any client) dials the bundled WS mock and conforms to C2.
// This harness boots the REAL mock-server.mjs and drives it as CW3 would,
// asserting every C2 frame contract holds over real sockets. It doubles as:
//   (a) CW4's M-P2 acceptance proof, and
//   (b) the conformance suite CW3 runs its client against ("implement, don't invent").
//
// Run: npx tsx tests/mp2-conformance.test.ts  (boots mock-server.mjs as a child)

import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = 8077;

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Minimal raw WS client (the shape CW3 must implement) ----
interface WsClient {
  send: (obj: any) => void;
  close: () => void;
  onMessage: (fn: (f: any) => void) => void;
}

function wsConnect(port: number, path = '/play'): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let hs = false;
    let buf = Buffer.alloc(0);
    const listeners: ((f: any) => void)[] = [];
    const pending: any[] = [];
    const deliver = (f: any) => { if (!listeners.length) pending.push(f); else for (const fn of listeners) fn(f); };
    const client: WsClient = {
      send: (obj) => socket.write(encodeMasked(JSON.stringify(obj))),
      close: () => socket.end(),
      onMessage: (fn) => { listeners.push(fn); while (pending.length) fn(pending.shift()); },
    };
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!hs) {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        if (!buf.slice(0, i).toString().includes('101')) { reject(new Error('handshake failed')); return; }
        hs = true; buf = buf.slice(i + 4); resolve(client);
      }
      while (buf.length >= 2) {
        const l0 = buf[1] & 0x7f; let len = l0, off = 2;
        if (l0 === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (l0 === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const data = buf.slice(off, off + len).toString('utf8'); buf = buf.slice(off + len);
        try { deliver(JSON.parse(data)); } catch { /* ignore */ }
      }
    });
    socket.on('error', reject);
  });
}

function encodeMasked(str: string): Buffer {
  const p = Buffer.from(str, 'utf8');
  const mask = crypto.randomBytes(4);
  const len = p.length;
  let h: Buffer;
  if (len < 126) { h = Buffer.alloc(2); h[1] = 0x80 | len; }
  else { h = Buffer.alloc(4); h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
  h[0] = 0x81;
  const m = Buffer.alloc(len);
  for (let i = 0; i < len; i++) m[i] = p[i] ^ mask[i % 4];
  return Buffer.concat([h, mask, m]);
}

function httpPost(port: number, path: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { port, host: '127.0.0.1', path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — M-P2 CONFORMANCE HARNESS         ║');
  console.log('║  (CW3 dials the bundled WS mock; full C2 contract) ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // Boot the REAL mock server (the bundled netcode-mock-server)
  const server = spawn('npx', ['tsx', 'netcode-mock-server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, CW4_MOCK_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  server.stdout.on('data', (d) => { if (d.toString().includes('WS gateway up')) ready = true; });
  server.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));
  for (let i = 0; i < 50 && !ready; i++) await sleep(100);
  check('mock server boots (CW3 has something to dial)', ready);
  if (!ready) { server.kill(); process.exit(1); }

  // ===== C4 REST: session lifecycle =====
  console.log('\n┌─ C4 REST surface ─────────────────────────────────────┐\n');
  const created = await httpPost(PORT, '/sessions', { world_id: 'world-zombie-school' });
  check('POST /sessions → session_id', typeof created.session_id === 'string');
  const invite = await httpPost(PORT, `/sessions/${created.session_id}/invite`, {});
  check('POST /sessions/:id/invite → invite_code', typeof invite.invite_code === 'string');
  const sessionId = created.session_id;
  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== C2 INBOUND/OUTBOUND frame conformance =====
  console.log('┌─ C2 frame conformance (the contract CW3 implements) ──┐\n');

  // join → joined{snapshot}
  const cw3 = await wsConnect(PORT);
  const frames: any[] = [];
  cw3.onMessage((f) => frames.push(f));
  cw3.send({ type: 'join', token: 'tok:cw3user', world_id: 'world-zombie-school', session_id: sessionId });
  await sleep(120);

  const joined = frames.find((f) => f.type === 'joined');
  check('join → joined frame', !!joined);
  check('joined carries session_id', joined?.session_id === sessionId);
  check('joined carries your_entity_id', typeof joined?.your_entity_id === 'string');
  check('joined carries snapshot{world_id,tick,players[],objects[]}',
    !!joined?.snapshot &&
    typeof joined.snapshot.world_id === 'string' &&
    typeof joined.snapshot.tick === 'number' &&
    Array.isArray(joined.snapshot.players) &&
    Array.isArray(joined.snapshot.objects));

  // state_delta{tick,changed[],removed[]} arrives on the tick loop;
  // a keyframe (full state) lands within KEYFRAME_EVERY_TICKS (~2s).
  await sleep(2200);
  const deltas = frames.filter((f) => f.type === 'state_delta');
  check('server emits state_delta frames', deltas.length > 0);
  const keyframe = deltas.find((f) => f.keyframe === true);
  check('server emits a keyframe (full resync)', !!keyframe);
  check('keyframe carries changed players w/ position+health',
    !!keyframe && keyframe.changed.length > 0 && 'position' in keyframe.changed[0] && 'health' in keyframe.changed[0]);
  check('state_delta carries tick + removed[]',
    deltas.every((f) => typeof f.tick === 'number' && Array.isArray(f.removed)));

  // place → object{op:'place'}
  const objBefore = frames.filter((f) => f.type === 'object').length;
  cw3.send({ type: 'place', object_type: 'barricade', position: { x: 3, y: 0, z: 1 }, rotation: { yaw: 0 } });
  await sleep(120);
  const objFrame = frames.filter((f) => f.type === 'object').find((f) => f.op === 'place' && f.object_type === 'barricade');
  check('place → object{op:place} broadcast', !!objFrame);
  check('object frame carries entity_id + position', !!objFrame?.entity_id && !!objFrame?.position);

  // interact pickup → object{op:'remove'}
  cw3.send({ type: 'interact', target_entity_id: objFrame.entity_id, action: 'pickup' });
  await sleep(120);
  const removeFrame = frames.filter((f) => f.type === 'object').find((f) => f.op === 'remove' && f.entity_id === objFrame.entity_id);
  check('interact pickup → object{op:remove}', !!removeFrame);

  // chat → chat broadcast
  const chatBefore = frames.filter((f) => f.type === 'chat').length;
  cw3.send({ type: 'chat', channel: 'session', text: 'conformance check' });
  await sleep(80);
  check('chat → chat frame echoed', frames.filter((f) => f.type === 'chat').length > chatBefore);

  // ping → pong{t,server_t}
  cw3.send({ type: 'ping', t: 123456 });
  await sleep(60);
  const pong = frames.find((f) => f.type === 'pong');
  check('ping → pong{t,server_t}', !!pong && pong.t === 123456 && typeof pong.server_t === 'number');

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== C2 error contract =====
  console.log('┌─ C2 error contract ───────────────────────────────────┐\n');

  // bad json → error{invalid}
  // (send raw garbage through a fresh socket)
  const badSock = net.connect(PORT, '127.0.0.1', () => {
    const key = crypto.randomBytes(16).toString('base64');
    badSock.write(`GET /play HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  let badHs = false, badBuf = Buffer.alloc(0); let badErr: any = null;
  badSock.on('data', (c) => {
    badBuf = Buffer.concat([badBuf, c]);
    if (!badHs) { const i = badBuf.indexOf('\r\n\r\n'); if (i === -1) return; badHs = true; badBuf = badBuf.slice(i + 4);
      badSock.write(encodeMasked('this is not json')); }
    while (badBuf.length >= 2) {
      const l0 = badBuf[1] & 0x7f; let len = l0, off = 2;
      if (l0 === 126) { if (badBuf.length < 4) break; len = badBuf.readUInt16BE(2); off = 4; }
      if (badBuf.length < off + len) break;
      try { badErr = JSON.parse(badBuf.slice(off, off + len).toString()); } catch {}
      badBuf = badBuf.slice(off + len);
    }
  });
  await sleep(150);
  check('malformed frame → error{invalid}', badErr?.type === 'error' && badErr?.code === 'invalid');
  badSock.end();

  // frame before join → error{forbidden}
  const earlySock = await wsConnect(PORT);
  const earlyFrames: any[] = [];
  earlySock.onMessage((f) => earlyFrames.push(f));
  earlySock.send({ type: 'chat', channel: 'session', text: 'too early' });
  await sleep(80);
  check('frame-before-join → error{forbidden}', earlyFrames.some((f) => f.type === 'error' && f.code === 'forbidden'));
  earlySock.close();

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Two-client integration (the M-P2 core: CW3-style client sees peer) =====
  console.log('┌─ M-P2 core: two clients, peer visibility ─────────────┐\n');
  const sess2 = (await httpPost(PORT, '/sessions', { world_id: 'world-zombie-school' })).session_id;
  const c1 = await wsConnect(PORT), c2 = await wsConnect(PORT);
  const f1: any[] = [], f2: any[] = [];
  c1.onMessage((f) => f1.push(f)); c2.onMessage((f) => f2.push(f));
  c1.send({ type: 'join', token: 'tok:p1', world_id: 'world-zombie-school', session_id: sess2 });
  await sleep(80);
  c2.send({ type: 'join', token: 'tok:p2', world_id: 'world-zombie-school', session_id: sess2 });
  await sleep(80);
  c1.send({ type: 'place', object_type: 'totem', position: { x: 2, y: 0, z: 2 }, rotation: { yaw: 0 } });
  await sleep(150);
  check('client2 sees client1 placement (peer broadcast over sockets)',
    f2.some((f) => f.type === 'object' && f.op === 'place' && f.object_type === 'totem'));
  c1.close(); c2.close();

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  cw3.close();
  server.kill('SIGINT');
  await sleep(200);

  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  M-P2 CONFORMANCE: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
