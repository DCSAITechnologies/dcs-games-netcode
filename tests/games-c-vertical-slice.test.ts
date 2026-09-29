// tests/games-c-vertical-slice.test.ts
// DCS GAMES-C — Multiplayer vertical slice against the REAL deploy entrypoint.
//
// Every other socket suite (mp2-conformance, mock-server-smoke) boots
// netcode-mock-server.mjs. This one boots src/server.ts — the file that compiles
// to dist/server.js, which railway.json/Procfile actually start — on an ephemeral
// localhost port, and drives it with two real WebSocket clients (Node's global
// WebSocket; zero new deps). Offline: CW5_PERSISTENCE_URL is stripped so the
// server uses the local delta sink.
//
// Proves: health, session create, auth-before-join, two clients in one session,
// authoritative movement seen by the peer, speedhack + dt-forgery rejection,
// placement broadcast, chat/input rate limits, oversize chat, junk-frame
// survival, disconnect → soft-leave → reconnect with preserved state.
//
// Also RECORDS (as NOTE lines, not checks) the gaps this slice observed, so they
// are visible in CI output without pinning a bug as "passing".

import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { signHs256Jwt } from '../src/auth';

let pass = 0, fail = 0;
const notes: string[] = [];
const check = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (extra ? '  — ' + extra : '')); }
};
const note = (n: string) => { notes.push(n); console.log('📝 NOTE: ' + n); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WORLD = 'world-gamesc-slice';
// The real server now fails closed without a secret; the slice runs it with a
// test secret and mints real HS256 tokens (sub = user id), as the backend would.
const JWT_SECRET = 'slice-test-secret-0123456789abcdef0123456789';
const tok = (sub: string) => signHs256Jwt(JWT_SECRET, { sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 });

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

function bootServer(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), NETCODE_JWT_SECRET: JWT_SECRET };
    delete env.NETCODE_ALLOW_MOCK_AUTH;
    delete env.CW5_PERSISTENCE_URL;
    delete env.CW5_PERSISTENCE_TOKEN;
    delete env.NETCODE_PERSISTENCE_URL;
    delete env.NETCODE_PERSISTENCE_TOKEN;
    const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const child = spawn(tsx, ['src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
    child.stdout!.on('data', (d) => {
      out += d.toString();
      if (out.includes('WS gateway up')) { clearTimeout(timer); resolve(child); }
    });
    child.stderr!.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${out}`)); });
  });
}

type Frame = Record<string, any>;

class Client {
  ws: WebSocket;
  frames: Frame[] = [];
  closed = false;
  entity_id: string | null = null;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      try { this.frames.push(JSON.parse(String(ev.data))); } catch { /* ignore */ }
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === 1) return resolve();
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    });
  }
  send(f: Frame) { this.ws.send(JSON.stringify(f)); }
  sendRaw(s: string) { this.ws.send(s); }
  mark() { return this.frames.length; }
  async waitFor(pred: (f: Frame) => boolean, from = 0, timeoutMs = 2000): Promise<Frame | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      for (let i = from; i < this.frames.length; i++) if (pred(this.frames[i])) return this.frames[i];
      await sleep(10);
    }
    return null;
  }
  since(from: number) { return this.frames.slice(from); }
  close() { try { this.ws.close(); } catch { /* */ } }
}

async function httpJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
}

/** Latest authoritative position of `eid` as this client has observed it. */
function observedPos(c: Client, eid: string): { x: number; y: number; z: number } | null {
  let pos: any = null;
  for (const f of c.frames) {
    if (f.type === 'joined') for (const p of f.snapshot.players) if (p.entity_id === eid) pos = p.position;
    if (f.type === 'spawn' && f.entity_id === eid) pos = f.position;
    if (f.type === 'state_delta') for (const p of f.changed) if (p.entity_id === eid) pos = p.position;
  }
  return pos;
}

async function run(): Promise<boolean> {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES-C — MULTIPLAYER VERTICAL SLICE (real)  ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  if (typeof (globalThis as any).WebSocket !== 'function') {
    console.log('❌ global WebSocket unavailable in this Node — need Node >= 22');
    return false;
  }

  const port = await freePort();
  const server = await bootServer(port);
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/play`;
  const clients: Client[] = [];
  const mk = async () => { const c = new Client(wsUrl); clients.push(c); await c.open(); return c; };

  try {
    // ===== HTTP surface =====
    console.log('┌─ HTTP: health + session issuance ───────────────────┐\n');
    const h = await httpJson(`${base}/health`);
    check('GET /health → ok:true', h.status === 200 && h.body?.ok === true);
    check('health reports auth mode hs256', h.body?.auth === 'hs256');
    check('health reports no-op persistence (offline, no URL)', h.body?.persistence?.mode === 'noop');
    const bad = await httpJson(`${base}/sessions`, { method: 'POST', body: '{}' });
    check('POST /sessions without world_id → 400', bad.status === 400);
    const cs = await httpJson(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) });
    const sessionId: string = cs.body?.session_id;
    check('POST /sessions {world_id} → session_id', cs.status === 200 && typeof sessionId === 'string' && cs.body.world_id === WORLD);
    const inv = await httpJson(`${base}/sessions/${sessionId}/invite`, { method: 'POST' });
    check('POST /sessions/:id/invite → invite_code', inv.status === 200 && typeof inv.body?.invite_code === 'string');

    // ===== Auth =====
    console.log('\n┌─ Auth: join required, token required ───────────────┐\n');
    const anon = await mk();
    let m = anon.mark();
    anon.send({ type: 'input', seq: 1, move: { x: 0.1, y: 0, z: 0 }, look: { yaw: 0, pitch: 0 }, dt: 1 / 15 });
    const forb = await anon.waitFor((f) => f.type === 'error', m);
    check('frame before join → error forbidden', forb?.code === 'forbidden');
    m = anon.mark();
    anon.send({ type: 'join', token: 'not-a-token', world_id: WORLD, session_id: sessionId });
    const authErr = await anon.waitFor((f) => f.type === 'error', m);
    check('join with invalid token → error auth', authErr?.code === 'auth');
    await sleep(100);
    check('server closes socket after auth failure', anon.closed);

    const mocky = await mk();
    m = mocky.mark();
    mocky.send({ type: 'join', token: 'tok:alice', world_id: WORLD, session_id: sessionId });
    const mockErr = await mocky.waitFor((f) => f.type === 'error', m);
    check('unsigned mock token "tok:alice" rejected on the real server', mockErr?.code === 'auth');

    const ghost = await mk();
    m = ghost.mark();
    ghost.send({ type: 'join', token: tok('ghost'), world_id: WORLD, session_id: 'no-such-session' });
    const nf = await ghost.waitFor((f) => f.type === 'error', m);
    check('join unknown session_id → error not_found', nf?.code === 'not_found');
    ghost.close();

    // ===== Two clients, one session =====
    console.log('\n┌─ Two clients join the same session ─────────────────┐\n');
    const alice = await mk();
    alice.send({ type: 'join', token: tok('alice'), world_id: WORLD, session_id: sessionId });
    const aj = await alice.waitFor((f) => f.type === 'joined');
    alice.entity_id = aj?.your_entity_id ?? null;
    check('alice joined (joined frame + entity id)', !!alice.entity_id && aj?.session_id === sessionId);
    check('alice snapshot carries world_id', aj?.snapshot?.world_id === WORLD);

    const bob = await mk();
    const aMark = alice.mark();
    bob.send({ type: 'join', token: tok('bob'), world_id: WORLD, session_id: sessionId });
    const bj = await bob.waitFor((f) => f.type === 'joined');
    bob.entity_id = bj?.your_entity_id ?? null;
    check('bob joined same session', !!bob.entity_id && bj?.session_id === sessionId);
    check('bob snapshot contains alice', !!bj?.snapshot?.players?.some((p: any) => p.entity_id === alice.entity_id));
    const bobSpawn = await alice.waitFor((f) => f.type === 'spawn' && f.entity_id === bob.entity_id, aMark);
    check('alice receives spawn for bob', !!bobSpawn);
    const hh = await httpJson(`${base}/health`);
    check('health: active_sessions >= 1', (hh.body?.active_sessions ?? 0) >= 1);

    const spawnPos = bj?.snapshot?.players?.find((p: any) => p.entity_id === bob.entity_id)?.position;
    if (spawnPos && spawnPos.x === 0 && spawnPos.y === 0 && spawnPos.z === 0) {
      note('fresh join always spawns at {0,0,0} (session.ts:163); join frame has no spawn-point field → world-manifest spawn points NOT supported by protocol');
    }

    // ===== Authoritative movement seen by the peer =====
    console.log('\n┌─ Authoritative movement replicated to peer ────────┐\n');
    let bMark = bob.mark();
    alice.send({ type: 'input', seq: 1, move: { x: 0.5, y: 0, z: 0 }, look: { yaw: 1, pitch: 0 }, dt: 1 / 15 });
    const seen = await bob.waitFor(
      (f) => f.type === 'state_delta' && f.changed.some((p: any) => p.entity_id === alice.entity_id && Math.abs(p.position.x - 0.5) < 1e-6),
      bMark
    );
    check('bob sees alice at x=0.5 via state_delta (server-authoritative)', !!seen);
    const ackd = seen?.changed.find((p: any) => p.entity_id === alice.entity_id);
    check('state_delta carries last_ack_seq=1 for reconciliation', ackd?.last_ack_seq === 1);

    // ===== Speedhack / teleport / dt forgery =====
    console.log('\n┌─ Anti-cheat over the wire ──────────────────────────┐\n');
    let am = alice.mark();
    alice.send({ type: 'input', seq: 2, move: { x: 50, y: 0, z: 0 }, look: { yaw: 1, pitch: 0 }, dt: 1 / 15 });
    const tele = await alice.waitFor((f) => f.type === 'error' && f.ref_seq === 2, am);
    check('teleport (50 units) rejected with ref_seq', !!tele && /speedhack/.test(tele.message));

    // The b5aa816 fix: client-sent dt no longer buys distance. At 49f1035 this
    // exact frame (dt=0.25 → 2.0 units budget) was ACCEPTED.
    am = alice.mark();
    alice.send({ type: 'input', seq: 3, move: { x: 2.0, y: 0, z: 0 }, look: { yaw: 1, pitch: 0 }, dt: 0.25 });
    const forged = await alice.waitFor((f) => f.type === 'error' && f.ref_seq === 3, am);
    check('forged dt=0.25 immediately after an accepted input → rejected', !!forged);

    // Sustained speedhack: 20 frames x 1.0 unit, 10ms apart = ~100 u/s vs 8 u/s limit.
    am = alice.mark();
    for (let i = 0; i < 20; i++) {
      alice.send({ type: 'input', seq: 10 + i, move: { x: 1.0, y: 0, z: 0 }, look: { yaw: 1, pitch: 0 }, dt: 0.25 });
      await sleep(10);
    }
    await sleep(300);
    const posAfter = observedPos(bob, alice.entity_id!);
    // Honest ceiling over ~0.5s wall clock is ~8*0.5 = 4 units (+ first 0.5).
    check('sustained 100u/s speedhack: peer-visible x stays under honest ceiling (<5)', !!posAfter && posAfter.x < 5, JSON.stringify(posAfter));
    const rejected = alice.since(am).filter((f) => f.type === 'error' && f.code === 'invalid').length;
    check('sustained speedhack produced rejections', rejected > 0, `rejected=${rejected}`);
    const alicePosNow = posAfter!;

    // ===== Placement broadcast =====
    console.log('\n┌─ Placement: authoritative object to peer ─────────┐\n');
    bMark = bob.mark();
    alice.send({ type: 'place', object_type: 'house', position: { x: alicePosNow.x + 1, y: 0, z: 0 }, rotation: { yaw: 0 } });
    const placed = await bob.waitFor((f) => f.type === 'object' && f.op === 'place', bMark);
    check('bob receives object place (house) with server id', placed?.object_type === 'house' && typeof placed?.entity_id === 'string');
    am = alice.mark();
    alice.send({ type: 'place', object_type: 'house', position: { x: 400, y: 0, z: 0 }, rotation: { yaw: 0 } });
    const far = await alice.waitFor((f) => f.type === 'error', am);
    check('placement beyond reach rejected (forbidden)', far?.code === 'forbidden');

    // B1 (fixed in games-c): a player cannot pick up an object another player owns.
    if (placed) {
      bMark = bob.mark();
      const aSeeMark = alice.mark();
      bob.send({ type: 'interact', target_entity_id: placed.entity_id, action: 'pickup' });
      const bobErr = await bob.waitFor((f) => f.type === 'error', bMark, 400);
      const removed = await alice.waitFor((f) => f.type === 'object' && f.op === 'remove' && f.entity_id === placed.entity_id, aSeeMark, 400);
      check("bob cannot pick up alice's house (ownership enforced)", bobErr?.code === 'forbidden' && !removed);
    } else {
      check("bob cannot pick up alice's house (ownership enforced)", false);
    }

    // ===== Ping / pong =====
    am = alice.mark();
    alice.send({ type: 'ping', t: 12345 });
    const pong = await alice.waitFor((f) => f.type === 'pong', am);
    check('ping → pong echoes t + server_t', pong?.t === 12345 && typeof pong?.server_t === 'number');

    // ===== Keyframe resync =====
    bMark = bob.mark();
    const kf = await bob.waitFor((f) => f.type === 'state_delta' && f.keyframe === true, bMark, 3000);
    check('keyframe state_delta arrives (<= 2s cadence)', !!kf && kf.changed.length >= 2);

    // ===== Abuse controls =====
    console.log('\n┌─ Abuse controls ─────────────────────────────────────┐\n');
    bMark = bob.mark();
    for (let i = 0; i < 8; i++) bob.send({ type: 'chat', channel: 'session', text: 'spam ' + i });
    await sleep(200);
    check('chat flood → rate_limit (3/s bucket)', bob.since(bMark).some((f) => f.type === 'error' && f.code === 'rate_limit'));
    await sleep(1100);
    bMark = bob.mark();
    bob.send({ type: 'chat', channel: 'session', text: 'x'.repeat(501) });
    const longChat = await bob.waitFor((f) => f.type === 'error', bMark);
    check('chat > 500 chars rejected', longChat?.code === 'invalid');
    bMark = bob.mark();
    for (let i = 0; i < 45; i++) bob.send({ type: 'input', seq: 100 + i, move: { x: 0, y: 0, z: 0 }, look: { yaw: 0, pitch: 0 }, dt: 1 / 15 });
    await sleep(200);
    check('input flood (45 burst) → rate_limit (30/s bucket)', bob.since(bMark).some((f) => f.type === 'error' && f.code === 'rate_limit'));

    bMark = bob.mark();
    bob.sendRaw('{' + 'a'.repeat(1024));
    const junk = await bob.waitFor((f) => f.type === 'error' && f.code === 'invalid', bMark);
    check('1 KiB malformed frame → error invalid, connection survives', !!junk && !bob.closed);
    const h2 = await httpJson(`${base}/health`);
    check('server still healthy after junk frame', h2.body?.ok === true);
    // Oversized frames are covered in tests/server-limits.test.ts (a 256 KiB
    // frame now closes the socket with 1009 instead of being buffered + parsed).

    // Party / inventory on the DEPLOYED entrypoint.
    bMark = bob.mark();
    bob.send({ type: 'party_create', token: tok('bob'), world_id: WORLD });
    const party = await bob.waitFor((f) => f.type === 'error' || f.type === 'party_state', bMark);
    if (party?.type === 'error') note(`party frames on src/server.ts: "${party.message}" — server.ts:100 builds Gateway without presence/party`);
    bMark = bob.mark();
    bob.send({ type: 'inventory', action: 'equip', item_id: 'sword' });
    const invErr = await bob.waitFor((f) => f.type === 'error', bMark);
    if (invErr) note(`inventory on src/server.ts: "${invErr.message}" — SessionManager built without OwnershipStore (server.ts:99)`);

    // World-id mismatch probe.
    const mis = await mk();
    mis.send({ type: 'join', token: tok('mallory'), world_id: 'some-other-world', session_id: sessionId });
    const mj = await mis.waitFor((f) => f.type === 'joined' || f.type === 'error');
    check('join with world_id != session.world_id → error world_mismatch', mj?.type === 'error' && mj?.code === 'world_mismatch');
    mis.close();
    const badWorld = await httpJson(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: '../etc/passwd' }) });
    check('POST /sessions with malformed world_id → 400', badWorld.status === 400);

    // Max players over the wire: a 1-seat session refuses the second player.
    const tiny = await httpJson(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD, max_players: 1 }) });
    check('POST /sessions {max_players:1} → echoes max_players', tiny.body?.max_players === 1);
    const t1 = await mk();
    t1.send({ type: 'join', token: tok('tina'), world_id: WORLD, session_id: tiny.body?.session_id });
    const t1j = await t1.waitFor((f) => f.type === 'joined' || f.type === 'error');
    const t2 = await mk();
    t2.send({ type: 'join', token: tok('tom'), world_id: WORLD, session_id: tiny.body?.session_id });
    const t2j = await t2.waitFor((f) => f.type === 'joined' || f.type === 'error');
    check('second join into a 1-seat session → error session_full', t1j?.type === 'joined' && t2j?.code === 'session_full');
    t1.close(); t2.close();
    await sleep(100);

    // ===== Disconnect / reconnect with state resume =====
    console.log('\n┌─ Disconnect → reconnect resumes preserved state ──┐\n');
    const preserved = observedPos(bob, alice.entity_id!);
    bMark = bob.mark();
    alice.close();
    const desp = await bob.waitFor((f) => f.type === 'despawn' && f.entity_id === alice.entity_id, bMark);
    check('bob receives despawn when alice drops', !!desp);

    const alice2 = await mk();
    bMark = bob.mark();
    alice2.send({ type: 'join', token: tok('alice'), world_id: WORLD, session_id: sessionId });
    const rj = await alice2.waitFor((f) => f.type === 'joined');
    check('reconnect → SAME entity id (deterministic sha256(user:session))', rj?.your_entity_id === alice.entity_id);
    const rpos = rj?.snapshot?.players?.find((p: any) => p.entity_id === alice.entity_id)?.position;
    check('reconnect snapshot restores preserved position (not origin)',
      !!rpos && !!preserved && Math.abs(rpos.x - preserved.x) < 1e-3 && rpos.x > 0, `rpos=${JSON.stringify(rpos)} preserved=${JSON.stringify(preserved)}`);
    const respawn = await bob.waitFor((f) => f.type === 'spawn' && f.entity_id === alice.entity_id, bMark);
    check('bob receives re-spawn at preserved position', !!respawn && Math.abs(respawn.position.x - preserved!.x) < 1e-3);

    // Post-resume input: seq stays monotonic (lastInputSeq kept through the grace window).
    let a2 = alice2.mark();
    alice2.send({ type: 'input', seq: 5, move: { x: 0.1, y: 0, z: 0 }, look: { yaw: 0, pitch: 0 }, dt: 1 / 15 });
    await sleep(250);
    const staleApplied = alice2.since(a2).some((f) => f.type === 'state_delta' && f.changed.some((p: any) => p.entity_id === alice.entity_id && p.last_ack_seq === 5));
    check('stale seq after resume is ignored (replay guard survives reconnect)', !staleApplied);
    a2 = alice2.mark();
    bMark = bob.mark();
    await sleep(200); // let the movement budget accrue
    alice2.send({ type: 'input', seq: 1000, move: { x: 0.2, y: 0, z: 0 }, look: { yaw: 0, pitch: 0 }, dt: 1 / 15 });
    const moved = await bob.waitFor((f) => f.type === 'state_delta' && f.changed.some((p: any) => p.entity_id === alice.entity_id && p.last_ack_seq === 1000), bMark);
    check('resumed client can move again; peer sees ack 1000', !!moved);
  } finally {
    for (const c of clients) c.close();
    server.removeAllListeners('exit');
    server.kill('SIGTERM');
    await sleep(100);
    if (server.exitCode === null) server.kill('SIGKILL');
  }

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  notes (observed gaps): ${notes.length}`.padEnd(52) + '║');
  console.log(`║  GAMES-C SLICE: ${fail === 0 ? 'GREEN (PASS)' : 'RED (FAIL)'}`.padEnd(52) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1), (err) => { console.error(err); process.exit(1); });
