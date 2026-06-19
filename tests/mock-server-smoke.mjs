// tests/mock-server-smoke.mjs
// Boots the real mock WS server, connects TWO raw WS clients over actual sockets,
// runs join → place → see-within-1-tick, asserts C3 deltas. Proves CW3 can integrate.

import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = 8099;

// --- minimal raw WS client (browser-style masked frames) ---
function wsConnect(port, path = '/play') {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: localhost:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    const listeners = [];
    const pending = [];
    const deliver = (frame) => {
      if (listeners.length === 0) pending.push(frame);
      else for (const fn of listeners) fn(frame);
    };
    const client = {
      socket,
      onMessage: (fn) => {
        listeners.push(fn);
        while (pending.length) fn(pending.shift());
      },
      send: (obj) => socket.write(encodeMaskedTextFrame(JSON.stringify(obj))),
      close: () => socket.end(),
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        const header = buf.slice(0, i).toString();
        if (!header.includes('101')) {
          reject(new Error('handshake failed: ' + header.split('\r\n')[0]));
          return;
        }
        handshakeDone = true;
        buf = buf.slice(i + 4);
        resolve(client);
      }
      // decode any complete frames now in buf
      while (buf.length >= 2) {
        const len0 = buf[1] & 0x7f;
        let len = len0;
        let offset = 2;
        if (len0 === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len0 === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        if (buf.length < offset + len) break;
        const data = buf.slice(offset, offset + len).toString('utf8');
        buf = buf.slice(offset + len);
        try {
          deliver(JSON.parse(data));
        } catch {
          /* ignore non-JSON */
        }
      }
    });
    socket.on('error', reject);
  });
}

function encodeMaskedTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  header[0] = 0x81;
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeServerFrames(buffer, deliver) {
  while (buffer.length >= 2) {
    const len0 = buffer[1] & 0x7f;
    let len = len0;
    let offset = 2;
    if (len0 === 126) {
      if (buffer.length < 4) break;
      len = buffer.readUInt16BE(2);
      offset = 4;
    } else if (len0 === 127) {
      if (buffer.length < 10) break;
      len = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    if (buffer.length < offset + len) break;
    const data = buffer.slice(offset, offset + len).toString('utf8');
    buffer = buffer.slice(offset + len);
    try {
      const frame = JSON.parse(data);
      deliver(frame);
    } catch {
      /* ignore */
    }
  }
  return buffer;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { port, host: '127.0.0.1', path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(JSON.parse(b)));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

async function main() {
  // Boot the mock server via tsx
  const server = spawn('npx', ['tsx', 'netcode-mock-server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, CW4_MOCK_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverReady = false;
  server.stdout.on('data', (d) => {
    if (d.toString().includes('WS gateway up')) serverReady = true;
  });
  server.stderr.on('data', (d) => process.stderr.write('[server-err] ' + d));

  // Wait for boot
  for (let i = 0; i < 50 && !serverReady; i++) await sleep(100);
  check('mock server booted', serverReady);
  if (!serverReady) { server.kill(); process.exit(1); }

  // HTTP: create a session
  const created = await httpPost(PORT, '/sessions', { world_id: 'world-zombie-school' });
  check('POST /sessions returns session_id', !!created.session_id);
  const sessionId = created.session_id;

  // Two raw WS clients
  const a = await wsConnect(PORT);
  const b = await wsConnect(PORT);

  const aFrames = [], bFrames = [];
  a.onMessage((f) => aFrames.push(f));
  b.onMessage((f) => bFrames.push(f));

  // A joins (creates implicit session) — but we use the one we made via HTTP
  a.send({ type: 'join', token: 'tok:userA', world_id: 'world-zombie-school', session_id: sessionId });
  await sleep(100);
  const aJoined = aFrames.find((f) => f.type === 'joined');
  check('client A joined over real socket', !!aJoined);

  b.send({ type: 'join', token: 'tok:userB', world_id: 'world-zombie-school', session_id: sessionId });
  await sleep(100);
  const bJoined = bFrames.find((f) => f.type === 'joined');
  check('client B joined same session', bJoined?.session_id === sessionId);

  // A places a house
  a.send({ type: 'place', object_type: 'house', position: { x: 4, y: 0, z: 2 }, rotation: { yaw: 0 } });
  await sleep(200);

  // B should receive an object/place frame
  const bSawObject = bFrames.some(
    (f) => f.type === 'object' && f.op === 'place' && f.object_type === 'house'
  );
  check('client B saw A place a house (over real socket, within ticks)', bSawObject);

  // Bad auth rejected
  const c = await wsConnect(PORT);
  const cFrames = [];
  c.onMessage((f) => cFrames.push(f));
  c.send({ type: 'join', token: 'garbage', world_id: 'world-zombie-school' });
  await sleep(100);
  check('bad token rejected over socket', cFrames.some((f) => f.type === 'error' && f.code === 'auth'));

  // health endpoint
  const health = await new Promise((resolve) => {
    http.get({ port: PORT, host: '127.0.0.1', path: '/health' }, (res) => {
      let bd = ''; res.on('data', (x) => (bd += x)); res.on('end', () => resolve(JSON.parse(bd)));
    });
  });
  check('GET /health ok + active sessions', health.ok && health.active_sessions >= 1);

  a.close(); b.close(); c.close();
  await sleep(100);
  server.kill('SIGINT');
  await sleep(200);

  console.log(`\n${pass} passed, ${fail} failed / ${pass + fail} checks`);
  console.log(fail === 0 ? '🎉 MOCK SERVER SMOKE: GREEN' : '⚠️  MOCK SERVER SMOKE: RED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
