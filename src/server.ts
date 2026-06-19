// src/server.ts
// DCS Games CW4 Netcode — Mock WS Server (TypeScript, compiles to dist/server.js)
// Zero external deps: minimal RFC6455 WebSocket over node:http wrapping the Gateway.
//
// Run (compiled):   npm start            → node dist/server.js
// Run (dev, tsx):   npm run server:dev   → tsx src/server.ts
// Port:             CW4_MOCK_PORT env (default 8090). Endpoint: ws://localhost:8090/play
//
// CW8 (M-P1 cert) + CW3 (C2 conformance) dial ws://localhost:<port>/play.

import http from 'node:http';
import crypto from 'node:crypto';
import { SessionManager } from './session.js';
import { Gateway, mockTokenVerifier, Transport } from './gateway.js';
import type { OutboundFrame, InboundFrame, C3Delta } from './types.js';
import { deltaSinkFromEnv } from './persistence-client.js';

// ---- Minimal RFC6455 WebSocket (server side, text frames) ----

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(secWebSocketKey: string): string {
  return crypto.createHash('sha1').update(secWebSocketKey + WS_MAGIC).digest('base64');
}

function encodeTextFrame(str: string): Buffer {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

type DecodedMessage = { close: true } | { text: string } | { ping: true };

function createFrameDecoder(): (chunk: Buffer) => DecodedMessage[] {
  let buffer = Buffer.alloc(0);
  return function decode(chunk: Buffer): DecodedMessage[] {
    buffer = Buffer.concat([buffer, chunk]);
    const messages: DecodedMessage[] = [];
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) break;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) break;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) break;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const dataStart = offset + maskLen;
      const data = buffer.subarray(dataStart, dataStart + len);
      if (masked && mask) {
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(dataStart + len);
      if (opcode === 0x08) messages.push({ close: true });
      else if (opcode === 0x01 || opcode === 0x00) messages.push({ text: data.toString('utf8') });
      else if (opcode === 0x09) messages.push({ ping: true });
    }
    return messages;
  };
}

// ---- Wiring ----

// Railway injects PORT; honor it. Fall back to CW4_MOCK_PORT (tests) then 8090.
const PORT = process.env.PORT
  ? Number(process.env.PORT)
  : process.env.CW4_MOCK_PORT
    ? Number(process.env.CW4_MOCK_PORT)
    : 8090;

// C5 delta sink → live CW5 persistence when CW5_PERSISTENCE_URL is set, else local.
const persistence = deltaSinkFromEnv();
const c3Sink = (d: C3Delta) => persistence.emit(d);

const sessionManager = new SessionManager(c3Sink);
const gateway = new Gateway(sessionManager, mockTokenVerifier);

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/sessions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { world_id } = JSON.parse(body || '{}');
        if (!world_id) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'world_id required' }));
          return;
        }
        const session = sessionManager.createSession(world_id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ session_id: session.session_id, world_id }));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad json' }));
      }
    });
    return;
  }

  const inviteMatch = req.url && req.url.match(/^\/sessions\/([^/]+)\/invite$/);
  if (req.method === 'POST' && inviteMatch) {
    const session = sessionManager.getSession(inviteMatch[1]);
    if (!session) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    const code = session.createInvite();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ invite_code: code, session_id: session.session_id }));
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      active_sessions: sessionManager.activeSessionCount,
      persistence: { mode: process.env.CW5_PERSISTENCE_URL ? 'live' : 'local', deltas_emitted: persistence.count },
    }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/play') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key || Array.isArray(key)) { socket.destroy(); return; }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );

  const transport: Transport = {
    send: (frame: OutboundFrame) => {
      try { socket.write(encodeTextFrame(JSON.stringify(frame))); } catch { /* closed */ }
    },
    close: () => socket.end(),
  };

  const decode = createFrameDecoder();
  const pump = (chunk: Buffer) => {
    for (const msg of decode(chunk)) {
      if ('close' in msg) {
        gateway.handleDisconnect(transport);
        socket.end();
        return;
      }
      if ('text' in msg) {
        try {
          const frame = JSON.parse(msg.text) as InboundFrame;
          gateway.handleFrame(transport, frame);
        } catch {
          transport.send({ type: 'error', code: 'invalid', message: 'bad json frame' });
        }
      }
    }
  };

  socket.on('data', pump);
  if (head && head.length > 0) pump(head);
  socket.on('close', () => gateway.handleDisconnect(transport));
  socket.on('error', () => gateway.handleDisconnect(transport));
});

server.listen(PORT, () => {
  console.log(`[CW4 mock] WS gateway up on ws://localhost:${PORT}/play`);
  console.log(`[CW4 mock] HTTP: POST /sessions, POST /sessions/:id/invite, GET /health`);
  console.log(`[CW4 mock] CW8/CW3 dial ws://localhost:${PORT}/play and send {type:'join',token:'tok:<id>',world_id}.`);
});

process.on('SIGINT', () => {
  console.log('\n[CW4 mock] shutting down');
  server.close(() => process.exit(0));
});
