// mock-server.mjs
// DCS Games CW4 Netcode — Local Mock WS Server (zero external deps)
// Wraps the transport-agnostic Gateway over a REAL WebSocket endpoint so CW3
// can dial wss://localhost:8090/play and integrate at M2 without waiting on us.
//
// Run: node mock-server.mjs   (after building src to JS, or via tsx loader)
// This is the JS sibling of the TS gateway — minimal RFC6455 handshake + frame codec.
//
// NOTE: This intentionally re-implements a tiny WS layer (no `ws` dep) to keep the
// lane zero-dependency. The game logic (Gateway/Session/validation) is imported from src.

import http from 'node:http';
import crypto from 'node:crypto';

// ---- Minimal RFC6455 WebSocket (server side, text frames only) ----

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(secWebSocketKey) {
  return crypto
    .createHash('sha1')
    .update(secWebSocketKey + WS_MAGIC)
    .digest('base64');
}

/** Encode a text payload into a single WS text frame (server→client, unmasked). */
function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
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

/** Decode incoming client frames (masked). Returns array of decoded text messages. */
function createFrameDecoder() {
  let buffer = Buffer.alloc(0);
  return function decode(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    const messages = [];
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
      if (buffer.length < offset + maskLen + len) break; // wait for more

      const mask = masked ? buffer.slice(offset, offset + 4) : null;
      const dataStart = offset + maskLen;
      const data = buffer.slice(dataStart, dataStart + len);

      if (masked && mask) {
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      }

      buffer = buffer.slice(dataStart + len);

      if (opcode === 0x08) {
        messages.push({ close: true });
      } else if (opcode === 0x01 || opcode === 0x00) {
        messages.push({ text: data.toString('utf8') });
      } else if (opcode === 0x09) {
        messages.push({ ping: true });
      }
      // ignore pong/binary for this mock
    }
    return messages;
  };
}

// ---- Load the game logic from src (via dynamic import of compiled or tsx) ----
// For the mock, we inline a thin re-export shim so this file runs standalone with tsx.
// In CI, run:  npx tsx mock-server.mjs  (tsx resolves the .ts imports)

const { SessionManager } = await import('./src/session.ts');
const { Gateway, mockTokenVerifier } = await import('./src/gateway.ts');

// ---- HTTP + WS server ----

const PORT = process.env.CW4_MOCK_PORT ? Number(process.env.CW4_MOCK_PORT) : 8090;

const c3deltas = [];
const c3Sink = (d) => {
  c3deltas.push(d);
  // In production this POSTs to CW5; here we just log + retain for inspection.
  console.log(`[C3→CW5] ${d.op} session=${d.session_id.slice(0, 8)} actor=${d.actor_entity_id.slice(0, 8)} tick=${d.tick}`);
};

const sessionManager = new SessionManager(c3Sink);
const gateway = new Gateway(sessionManager, mockTokenVerifier);

const server = http.createServer((req, res) => {
  // Thin C4 HTTP routes (POST /sessions, POST /sessions/:id/invite)
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
    res.end(JSON.stringify({ ok: true, active_sessions: sessionManager.activeSessionCount }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// WS upgrade on /play
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/play') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );

  // Build a Transport that the gateway can drive
  const transport = {
    send: (frame) => {
      try {
        socket.write(encodeTextFrame(JSON.stringify(frame)));
      } catch {
        /* socket closed */
      }
    },
    close: () => socket.end(),
  };

  const decode = createFrameDecoder();
  const pump = (chunk) => {
    for (const msg of decode(chunk)) {
      if (msg.close) {
        gateway.handleDisconnect(transport);
        socket.end();
        return;
      }
      if (msg.text) {
        try {
          const frame = JSON.parse(msg.text);
          gateway.handleFrame(transport, frame);
        } catch {
          transport.send({ type: 'error', code: 'invalid', message: 'bad json frame' });
        }
      }
    }
  };

  socket.on('data', pump);
  // Feed any bytes already buffered during the upgrade (race-safe)
  if (head && head.length > 0) pump(head);

  socket.on('close', () => gateway.handleDisconnect(transport));
  socket.on('error', () => gateway.handleDisconnect(transport));
});

server.listen(PORT, () => {
  console.log(`[CW4 mock] WS gateway up on ws://localhost:${PORT}/play`);
  console.log(`[CW4 mock] HTTP: POST /sessions, POST /sessions/:id/invite, GET /health`);
  console.log(`[CW4 mock] CW3 can dial ws://localhost:${PORT}/play and send a {type:'join',token:'tok:<id>',world_id} frame.`);
});

// Graceful shutdown for CI
process.on('SIGINT', () => {
  console.log('\n[CW4 mock] shutting down');
  server.close(() => process.exit(0));
});
