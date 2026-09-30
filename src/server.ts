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
import { Session, SessionManager, SessionCapError, SessionQuotaError } from './session.js';
import { Gateway, mockTokenVerifier, Transport, tenantOf } from './gateway.js';
import type { OutboundFrame, InboundFrame, C3Delta } from './types.js';
import { deltaSinkFromEnv } from './persistence-client.js';
import { verifierFromEnv } from './auth.js';
import { isValidWorldId, sanitizeSpawnPoints } from './validation.js';
import { limitsFromEnv, requireWorldTicketFromEnv } from './config.js';
import { multiplayerFlag } from './feature-flag.js';
import { replaySourceFromEnv } from './replay.js';
import { PartyManager } from './party.js';
import { PresenceService } from './presence.js';
import { LiveOwnershipStore } from './inventory.js';

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

type DecodedMessage =
  | { close: true }
  | { text: string }
  | { ping: Buffer }
  // Fatal: the connection must be closed with this RFC6455 status code.
  | { fatal: 1002 | 1009; reason: string };

/** A server→client close frame carrying a status code. */
function encodeCloseFrame(code: number): Buffer {
  const f = Buffer.alloc(4);
  f[0] = 0x88;
  f[1] = 2;
  f.writeUInt16BE(code, 2);
  return f;
}

function encodePongFrame(payload: Buffer): Buffer {
  const p = payload.subarray(0, 125);
  return Buffer.concat([Buffer.from([0x8a, p.length]), p]);
}

/**
 * Incremental RFC6455 decoder with a hard payload cap. The declared length is
 * checked as soon as the header is readable — BEFORE the payload is buffered —
 * so an oversized frame costs at most a header's worth of memory, then the
 * connection is closed with 1009 (message too big). Client frames must be
 * masked (RFC6455 §5.1); an unmasked one is a protocol error (1002).
 */
function createFrameDecoder(maxPayload: number): (chunk: Buffer) => DecodedMessage[] {
  let buffer: Buffer = Buffer.alloc(0);
  let dead = false;
  return function decode(chunk: Buffer): DecodedMessage[] {
    if (dead) return [];
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
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
        const big = buffer.readBigUInt64BE(2);
        len = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
        offset = 10;
      }
      if (len > maxPayload) {
        dead = true;
        buffer = Buffer.alloc(0);
        messages.push({ fatal: 1009, reason: `frame of ${len} bytes exceeds ${maxPayload}` });
        return messages;
      }
      if (!masked) {
        dead = true;
        buffer = Buffer.alloc(0);
        messages.push({ fatal: 1002, reason: 'client frames must be masked' });
        return messages;
      }
      if (buffer.length < offset + 4 + len) break;
      const mask = buffer.subarray(offset, offset + 4);
      const dataStart = offset + 4;
      // Copy out so the (possibly shared) input chunk is never mutated in place.
      const data = Buffer.from(buffer.subarray(dataStart, dataStart + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buffer = buffer.subarray(dataStart + len);
      if (opcode === 0x08) messages.push({ close: true });
      else if (opcode === 0x01 || opcode === 0x00) messages.push({ text: data.toString('utf8') });
      else if (opcode === 0x09) messages.push({ ping: data });
    }
    return messages;
  };
}

/**
 * Close a connection that has just been answered 413 without losing the answer.
 * Destroying the socket while the client is still sending leaves unread bytes in
 * the kernel buffer, so the close goes out as a RST — and a RST that overtakes
 * the 413 wipes it from the client's receive buffer (it sees ECONNRESET, never
 * the status). So: send FIN after the response, discard whatever is still in
 * flight, and destroy after a short, bounded linger.
 */
const LINGER_MS = 500;
const LINGER_MAX_BYTES = 256 * 1024;
function closeAfter413(req: http.IncomingMessage, res: http.ServerResponse) {
  res.on('finish', () => {
    const socket = req.socket;
    // Node's own finish handler (registered first) answers `connection: close`
    // with socket.destroySoon(), which destroys on the socket's 'finish' — the
    // same RST. Take that over; if the internals ever differ this is a no-op and
    // the bounded timer below still closes the socket.
    socket.removeListener('finish', socket.destroy);
    let drained = 0;
    const timer = setTimeout(() => socket.destroy(), LINGER_MS);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    req.removeAllListeners('data');
    req.on('data', (c: Buffer) => { drained += c.length; if (drained > LINGER_MAX_BYTES) socket.destroy(); });
    req.resume();
    socket.end();
  });
}

/**
 * Read a request body up to `max` bytes. Resolves the body, or null after it has
 * already answered 413 and arranged for the connection to close. Never buffers
 * more than `max` bytes: a declared Content-Length over the cap is refused
 * before reading, and a streamed (chunked) body is cut off the moment it passes.
 */
function readBody(req: http.IncomingMessage, res: http.ServerResponse, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const tooLarge = () => {
      if (!res.headersSent) {
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: 'body too large', max_bytes: max }));
      }
      closeAfter413(req, res);
      resolve(null);
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) { tooLarge(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        chunks.length = 0;
        req.pause();
        tooLarge();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

// ---- Wiring ----

// Railway injects PORT; honor it. Fall back to CW4_MOCK_PORT (tests) then 8090.
const PORT = process.env.PORT
  ? Number(process.env.PORT)
  : process.env.CW4_MOCK_PORT
    ? Number(process.env.CW4_MOCK_PORT)
    : 8090;

const limits = limitsFromEnv(process.env);

// Multiplayer feature flag — default OFF (NETCODE_MULTIPLAYER_ENABLED=1 turns it on).
// OFF builds nothing: no session manager, no auth, no persistence sink, no
// replay. Every route but a minimal /health answers 404 and /play is refused.
const flag = multiplayerFlag(process.env);

interface Multiplayer {
  sessionManager: SessionManager;
  gateway: Gateway;
  auth: ReturnType<typeof verifierFromEnv>;
  persistence: ReturnType<typeof deltaSinkFromEnv>;
  replay: ReturnType<typeof replaySourceFromEnv>;
  party: PartyManager;
  presence: PresenceService;
  requireWorldTicket: boolean;
}

function buildMultiplayer(): Multiplayer {
  // Delta sink → backend persistence when NETCODE_PERSISTENCE_URL (alias CW5_PERSISTENCE_URL)
  // is set; otherwise a no-op with a logged warning. emit() never blocks the tick.
  const persistence = deltaSinkFromEnv();
  const c3Sink = (d: C3Delta) => persistence.emit(d);
  // Persistence replay from the same backend; no URL → sessions start empty.
  const replay = replaySourceFromEnv(process.env);
  const party = new PartyManager(limits.maxPartySize);
  // No friend-graph source is wired on this service yet: friendsPlaying() is empty.
  const presence = new PresenceService(() => []);
  const sessionManager: SessionManager = new SessionManager(c3Sink, new LiveOwnershipStore(), {
    maxPlayersPerSession: limits.maxPlayersPerSession,
    maxSessions: limits.maxSessions,
    idleTtlMs: limits.sessionIdleMs,
    maxSessionsPerUser: limits.maxSessionsPerUser,
    hydrate: async (session) => {
      const r = await replay.load(session.world_id);
      if (r.ok) session.applyReplay(r.state);
      else console.error(`[replay] ${session.world_id}: ${r.error} — session starts without persisted state`);
    },
    onClose: (id) => party.forgetSession(id),
  });
  sessionManager.startGc(limits.sessionGcIntervalMs); // unref'd
  const partyGc = setInterval(() => party.sweep(Date.now(), (id) => !!sessionManager.getSession(id)), Math.max(100, limits.sessionGcIntervalMs));
  partyGc.unref();
  // Auth: HS256 JWT (NETCODE_JWT_SECRET) or fail closed. The mock verifier is
  // reachable only with NETCODE_ALLOW_MOCK_AUTH=1 outside production.
  const auth = verifierFromEnv(process.env, mockTokenVerifier);
  if (auth.mode === 'deny-all') console.error(`[auth] ${auth.warning}`);
  else if (auth.warning) console.warn(`[auth] ${auth.warning}`);
  else console.log('[auth] HS256 JWT verification enabled');
  const requireWorldTicket = requireWorldTicketFromEnv(process.env);
  const gateway = new Gateway(sessionManager, auth.verifier, { party, presence, requireWorldTicket });
  return { sessionManager, gateway, auth, persistence, replay, party, presence, requireWorldTicket };
}

const mp: Multiplayer | null = flag.enabled ? buildMultiplayer() : null;

function json(res: http.ServerResponse, status: number, obj: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(obj));
}

/** The verified caller of an HTTP route (Authorization: Bearer <JWT>), or null. */
function httpCaller(m: Multiplayer, req: http.IncomingMessage): { user_id: string; tenant: string | null; claims: Record<string, unknown> } | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  const v = m.auth.verifier(h.slice(7).trim());
  if (!v.valid || !v.user_id) return null;
  const t = tenantOf(v.claims);
  if (!t.ok) return null;
  return { user_id: v.user_id, tenant: t.tenant, claims: v.claims || {} };
}

/** May this caller see / act on this session? Same tenant AND (owner or current member). */
function canSeeSession(session: Session, caller: { user_id: string; tenant: string | null }): boolean {
  if ((session.tenant_id || null) !== caller.tenant) return false;
  return session.owner_user_id === caller.user_id || session.hasMember(caller.user_id);
}

function notFound(res: http.ServerResponse) {
  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  // No route accepts a large body; refuse an over-cap declared length up front.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limits.maxHttpBody) {
    res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: 'body too large', max_bytes: limits.maxHttpBody }));
    closeAfter413(req, res);
    return;
  }

  if (!mp) {
    // Feature flag OFF: nothing but a liveness probe exists.
    if (req.method === 'GET' && req.url === '/health') { json(res, 200, { ok: true, multiplayer: 'off' }); return; }
    notFound(res);
    return;
  }
  const { sessionManager, auth, persistence, replay, party } = mp;

  if (req.method === 'POST' && req.url === '/sessions') {
    const caller = httpCaller(mp, req);
    if (!caller) { json(res, 401, { error: 'authentication required' }); req.resume(); return; }
    void readBody(req, res, limits.maxHttpBody).then(async (body) => {
      if (body === null) return; // 413 already sent
      let parsed: any;
      try { parsed = JSON.parse(body || '{}'); } catch { json(res, 400, { error: 'bad json' }); return; }
      const world_id = parsed?.world_id;
      const max_players = parsed?.max_players;
      if (!world_id) { json(res, 400, { error: 'world_id required' }); return; }
      if (!isValidWorldId(world_id)) { json(res, 400, { error: 'invalid world_id (expected /^[A-Za-z0-9._:-]{1,200}$/)' }); return; }
      const claimWorld = caller.claims.world_id;
      if ((mp.requireWorldTicket && typeof claimWorld !== 'string') || (typeof claimWorld === 'string' && claimWorld !== world_id)) {
        json(res, 403, { error: 'token is not valid for this world' });
        return;
      }
      if (max_players !== undefined && !(Number.isInteger(max_players) && max_players >= 1)) {
        json(res, 400, { error: 'max_players must be a positive integer' });
        return;
      }
      const spawns = sanitizeSpawnPoints(parsed?.spawn_points);
      if (!spawns.ok) { json(res, 400, { error: spawns.error }); return; }
      const spawn_seed = parsed?.spawn_seed;
      if (spawn_seed !== undefined && !(typeof spawn_seed === 'string' && spawn_seed.length > 0 && spawn_seed.length <= 128)) {
        json(res, 400, { error: 'spawn_seed must be a string of 1..128 chars' });
        return;
      }
      let session;
      try {
        session = sessionManager.createSession(world_id, {
          maxPlayers: max_players, spawnPoints: spawns.points, spawnSeed: spawn_seed,
          ownerUserId: caller.user_id, tenantId: caller.tenant,
        });
      } catch (err) {
        if (err instanceof SessionCapError) { json(res, 503, { error: 'session cap reached', code: 'capacity' }, { 'retry-after': '30' }); return; }
        if (err instanceof SessionQuotaError) { json(res, 429, { error: err.message, code: 'quota' }); return; }
        json(res, 500, { error: 'could not create session' });
        return;
      }
      // The id is handed out only once persisted state has been replayed into it.
      await sessionManager.whenHydrated(session.session_id);
      json(res, 200, {
        session_id: session.session_id, world_id, max_players: session.maxPlayers,
        spawn_points: spawns.points.length, hydrated: session.hydrated, objects: session.objectCount,
      });
    });
    return;
  }

  const sessionMatch = req.url && req.url.match(/^\/sessions\/([^/]+)(\/invite)?$/);
  if (sessionMatch && ((req.method === 'POST' && sessionMatch[2]) || (req.method === 'GET' && !sessionMatch[2]))) {
    const caller = httpCaller(mp, req);
    if (!caller) { json(res, 401, { error: 'authentication required' }); req.resume(); return; }
    const session = sessionManager.getSession(sessionMatch[1]);
    // Another tenant's (or a stranger's) session is indistinguishable from none.
    if (!session || !canSeeSession(session, caller)) { json(res, 404, { error: 'session not found' }); req.resume(); return; }
    if (sessionMatch[2]) {
      const code = session.createInvite();
      json(res, 200, { invite_code: code, session_id: session.session_id });
      return;
    }
    // Presence view of one session.
    json(res, 200, {
      session_id: session.session_id,
      world_id: session.world_id,
      max_players: session.maxPlayers,
      players_online: mp.presence.sessionPlayerCount(session.session_id),
      players_held_for_reconnect: session.disconnectedCount,
      hydrated: session.hydrated,
    });
    return;
  }

  if (req.url === '/health') {
    json(res, 200, {
      ok: true,
      multiplayer: 'on',
      active_sessions: sessionManager.activeSessionCount,
      max_sessions: sessionManager.maxSessions,
      sessions_gc_closed: sessionManager.gcClosed,
      parties: party.activePartyCount,
      auth: auth.mode,
      world_ticket_required: mp.requireWorldTicket,
      persistence: { mode: persistence.mode, deltas_emitted: persistence.count, deltas_dropped: persistence.dropped, replay: replay.mode },
    });
    return;
  }

  notFound(res);
});

server.on('upgrade', (req, socket, head) => {
  if (!mp || req.url !== '/play') {
    // Flag OFF (or any other path): the WebSocket endpoint does not exist.
    try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { /* closed */ }
    socket.destroy();
    return;
  }
  const { gateway } = mp;
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

  const decode = createFrameDecoder(limits.maxWsPayload);
  const pump = (chunk: Buffer) => {
    for (const msg of decode(chunk)) {
      if ('fatal' in msg) {
        // Oversized (1009) or unmasked (1002): close, never buffer the rest.
        socket.removeListener('data', pump);
        gateway.handleDisconnect(transport);
        try { socket.write(encodeCloseFrame(msg.fatal)); } catch { /* closed */ }
        socket.end();
        setTimeout(() => socket.destroy(), 1000).unref();
        return;
      }
      if ('ping' in msg) {
        try { socket.write(encodePongFrame(msg.ping)); } catch { /* closed */ }
        continue;
      }
      if ('close' in msg) {
        gateway.handleDisconnect(transport);
        try { socket.write(encodeCloseFrame(1000)); } catch { /* closed */ }
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

// Slow-loris guards on the HTTP side.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;

server.listen(PORT, () => {
  console.log(`[netcode] listening port=${PORT} multiplayer=${mp ? 'on' : 'off'}`);
  if (!mp) {
    console.log('[netcode] multiplayer feature flag OFF (NETCODE_MULTIPLAYER_ENABLED unset): /play, /sessions and invites answer 404');
    return;
  }
  console.log(`[CW4 mock] WS gateway up on ws://localhost:${PORT}/play`);
  console.log(`[CW4 mock] HTTP: POST /sessions, GET /sessions/:id, POST /sessions/:id/invite (Bearer JWT), GET /health`);
  console.log(`[CW4 mock] CW8/CW3 dial ws://localhost:${PORT}/play and send {type:'join',token:'<HS256 JWT>',world_id}. auth=${mp.auth.mode}`);
});

process.on('SIGINT', () => {
  console.log('\n[netcode] shutting down');
  mp?.sessionManager.closeAll();
  server.close(() => process.exit(0));
});
