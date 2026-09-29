// tests/closure-e2e.test.ts
// GAMES-C netcode closure — the REAL server entrypoint (src/server.ts, flag ON)
// wired to the REAL backend delta module (backend/persistence-delta), over real
// sockets on ephemeral localhost ports. Offline: nothing leaves 127.0.0.1.
//
// Proves, end to end: HTTP auth on /sessions routes; max players; world_id
// validation; spawn assignment; place → delta persisted by the backend;
// pickup → inventory grant; inventory move; speedhack snap-back; reconnect
// resume inside grace; presence view; invite ownership; tenant isolation on
// join and party; party over the wire; per-user session quota; persistence
// replay into a NEW session (objects, ownership, inventory); a backend
// permission refusal is dropped, not retried forever; world-ticket enforcement.

import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { signHs256Jwt } from '../src/auth';
import { Gateway, mockTokenVerifier, Transport } from '../src/gateway';
import { SessionManager, Session, entityIdFor } from '../src/session';
import { LiveOwnershipStore } from '../src/inventory';
import { foldDeltas } from '../src/replay';
import { PartyManager } from '../src/party';
// @ts-ignore — plain ESM module, no types
import { registerPersistenceDelta } from '../backend/persistence-delta/index.mjs';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (extra ? '  — ' + extra : '')); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SECRET = 'closure-test-secret-0123456789abcdef0123456789';
const INGEST = 'closure-ingest-token-0123456789abcdef012345';
const WORLD = 'world-closure';
const PRIVATE_WORLD = 'world-private';
const tok = (sub: string, extra: Record<string, unknown> = {}) =>
  signHs256Jwt(SECRET, { sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...extra });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

// ---- backend host: the module mounted exactly as the server.mts patch mounts it ----
const backendCalls: { status: number; world: string }[] = [];
async function bootBackend(): Promise<{ base: string; close: () => Promise<void> }> {
  const handler = registerPersistenceDelta({
    env: { DCS_MULTIPLAYER_ENABLED: '1', DCS_NETCODE_INGEST_TOKEN: INGEST },
    accessWorld: async (w: string) => (w === WORLD ? 'ok' : w === PRIVATE_WORLD ? 'forbidden' : 'not_found'),
    log: { warn() {}, error() {} },
  });
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    res.on('finish', () => { if (url === '/persistence/delta') backendCalls.push({ status: res.statusCode, world: '' }); });
    if (await handler(req, res, url, req.method || 'GET')) return;
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) };
}

const children: ChildProcess[] = [];
async function bootNetcode(backendBase: string, extra: Record<string, string> = {}): Promise<number> {
  const port = await freePort();
  const env: Record<string, string | undefined> = {
    ...process.env, PORT: String(port),
    NETCODE_MULTIPLAYER_ENABLED: '1', NETCODE_JWT_SECRET: SECRET,
    NETCODE_PERSISTENCE_URL: backendBase, NETCODE_PERSISTENCE_TOKEN: INGEST,
    NETCODE_MAX_PLAYERS: '2', NETCODE_MAX_SESSIONS_PER_USER: '3',
    ...extra,
  };
  for (const k of ['NETCODE_ALLOW_MOCK_AUTH', 'CW5_PERSISTENCE_URL', 'CW5_PERSISTENCE_TOKEN', 'NODE_ENV', 'NETCODE_REQUIRE_WORLD_TICKET']) if (!(k in extra)) delete env[k];
  const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, ['src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('netcode did not start: ' + out)), 15000);
    child.stdout!.on('data', (d) => { out += d.toString(); if (out.includes('WS gateway up')) { clearTimeout(t); resolve(); } });
    child.stderr!.on('data', (d) => { out += d.toString(); });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`netcode exited ${c}: ${out}`)); });
  });
  return port;
}

async function http_(url: string, init: RequestInit = {}, user?: string, claims: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (user) headers.authorization = `Bearer ${tok(user, claims)}`;
  const r = await fetch(url, { ...init, headers });
  let body: any = null;
  try { body = await r.json(); } catch { /* */ }
  return { status: r.status, body };
}

class Client {
  ws: WebSocket;
  frames: any[] = [];
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
    this.ws.addEventListener('message', (ev: MessageEvent) => { try { this.frames.push(JSON.parse(String(ev.data))); } catch { /* */ } });
  }
  open() {
    return new Promise<void>((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    });
  }
  send(f: unknown) { this.ws.send(JSON.stringify(f)); }
  async waitFor(pred: (f: any) => boolean, ms = 3000): Promise<any | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = this.frames.find(pred);
      if (f) { this.frames.splice(this.frames.indexOf(f), 1); return f; }
      await sleep(20);
    }
    return null;
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

async function joinAs(port: number, user: string, world: string, session_id?: string, claims: Record<string, unknown> = {}) {
  const c = new Client(port);
  await c.open();
  c.send({ type: 'join', token: tok(user, claims), world_id: world, ...(session_id ? { session_id } : {}) });
  const first = await c.waitFor((f) => f.type === 'joined' || f.type === 'error');
  return { c, first };
}

async function replayLog(base: string, world: string) {
  const r = await fetch(`${base}/persistence/delta/replay?world_id=${world}`, { headers: { authorization: `Bearer ${INGEST}` } });
  return (await r.json()) as { deltas: any[] };
}

async function waitLog(base: string, world: string, n: number, ms = 5000) {
  const end = Date.now() + ms;
  let log = await replayLog(base, world);
  while (log.deltas.length < n && Date.now() < end) { await sleep(50); log = await replayLog(base, world); }
  return log;
}

async function run(): Promise<boolean> {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES — GAMES-C NETCODE CLOSURE (E2E)         ║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  const backend = await bootBackend();
  const port = await bootNetcode(backend.base);
  const base = `http://127.0.0.1:${port}`;

  console.log('┌─ HTTP auth, session create ───────────────────────────┐');
  const h = await http_(`${base}/health`);
  check('/health: multiplayer on, persistence live, replay live', h.body?.multiplayer === 'on' && h.body?.persistence?.mode === 'live' && h.body?.persistence?.replay === 'live');
  check('POST /sessions without a token → 401', (await http_(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) })).status === 401);
  const forged = await fetch(`${base}/sessions`, { method: 'POST', headers: { authorization: `Bearer ${signHs256Jwt('another-secret-0123456789abcdef0123456789', { sub: 'alice', exp: Math.floor(Date.now() / 1000) + 60 })}` }, body: JSON.stringify({ world_id: WORLD }) });
  check('POST /sessions with a forged token → 401', forged.status === 401);
  check('POST /sessions with a malformed world_id → 400', (await http_(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: '../etc/passwd' }) }, 'alice')).status === 400);
  const SPAWNS = [{ id: 'gate', position: { x: 1, y: 0, z: 1 } }];
  const s1 = await http_(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD, spawn_points: SPAWNS }) }, 'alice');
  const S1 = s1.body?.session_id;
  check('POST /sessions (alice) → 200, hydrated before the id is returned', s1.status === 200 && typeof S1 === 'string' && s1.body?.hydrated === true);

  console.log('┌─ join, spawn, max players, world_id ───────────────────┐');
  const A = await joinAs(port, 'alice', WORLD, S1);
  check('alice joins S1 at the assigned spawn', A.first?.type === 'joined' && A.first?.spawn?.id === 'gate');
  const B = await joinAs(port, 'bob', WORLD, S1);
  check('bob joins S1', B.first?.type === 'joined');
  const C = await joinAs(port, 'carol', WORLD, S1);
  check('carol refused: session_full (NETCODE_MAX_PLAYERS=2)', C.first?.code === 'session_full');
  C.c.close();
  const W = await joinAs(port, 'carol', 'bad world');
  check('join with a malformed world_id → invalid', W.first?.code === 'invalid');
  W.c.close();
  const M = await joinAs(port, 'carol', 'world-other', S1);
  check('join naming another world for S1 → world_mismatch', M.first?.code === 'world_mismatch');
  M.c.close();

  console.log('┌─ place → persisted; pickup → inventory ────────────────┐');
  A.c.send({ type: 'place', object_type: 'house', position: { x: 2, y: 0, z: 2 }, rotation: { yaw: 0.5 } });
  const seen = await B.c.waitFor((f) => f.type === 'object' && f.op === 'place' && f.object_type === 'house');
  check('bob sees alice\'s house', !!seen);
  A.c.send({ type: 'place', object_type: 'bad type!', position: { x: 2, y: 0, z: 2 }, rotation: { yaw: 0 } });
  check('placement with a malformed object_type → invalid (never reaches persistence)', !!(await A.c.waitFor((f) => f.type === 'error' && /object_type/.test(f.message))));
  A.c.send({ type: 'place', object_type: 'crate', position: { x: 1, y: 0, z: 2 }, rotation: { yaw: 0 } });
  const crate = await A.c.waitFor((f) => f.type === 'object' && f.op === 'place' && f.object_type === 'crate');
  B.c.send({ type: 'interact', target_entity_id: crate?.entity_id, action: 'pickup' });
  check('bob cannot pick up alice\'s crate (ownership)', !!(await B.c.waitFor((f) => f.type === 'error' && /belongs to another player/.test(f.message))));
  A.c.send({ type: 'interact', target_entity_id: crate?.entity_id, action: 'pickup' });
  const inv1 = await A.c.waitFor((f) => f.type === 'inventory');
  check('alice picks up her crate → inventory holds it in slot 0', inv1?.items?.length === 1 && inv1.items[0].item_id === crate?.entity_id && inv1.items[0].slot === 0);
  A.c.send({ type: 'inventory', action: 'move', item_id: crate?.entity_id, slot: 5 });
  const inv2 = await A.c.waitFor((f) => f.type === 'inventory');
  check('inventory move is applied server-side (slot 5)', inv2?.items?.[0]?.slot === 5);
  A.c.send({ type: 'inventory', action: 'equip', item_id: 'not-mine', slot: 1 });
  check('inventory action on an item you do not own → forbidden', !!(await A.c.waitFor((f) => f.type === 'error' && f.code === 'forbidden')));
  const log = await waitLog(backend.base, WORLD, 5);
  const ops = log.deltas.map((d) => d.op + (d.payload?.action ? ':' + d.payload.action : ''));
  check('backend stored place, place, remove, inventory:grant, inventory:move in order', JSON.stringify(ops) === JSON.stringify(['place', 'place', 'remove', 'inventory:grant', 'inventory:move']), JSON.stringify(ops));
  check('every stored delta carries the verified actor_user_id', log.deltas.every((d) => d.actor_user_id === 'alice'));

  console.log('┌─ speedhack ───────────────────────────────────────────┐');
  A.c.send({ type: 'input', seq: 1, move: { x: 60, y: 0, z: 0 }, look: { yaw: 0, pitch: 0 }, dt: 0.016 });
  check('a 60-unit move in one input → speedhack rejected', !!(await A.c.waitFor((f) => f.type === 'error' && /speedhack/.test(f.message))));
  A.c.send({ type: 'input', seq: 2, move: { x: 0.1, y: 0, z: 0 }, look: { yaw: 0, pitch: 0 }, dt: 0.016 });
  const st = await B.c.waitFor((f) => (f.type === 'state_delta' || f.type === 'state') && (f.changed || f.players || []).some((p: any) => p.entity_id === A.first.your_entity_id && p.last_ack_seq === 2), 3000);
  const ap = st && (st.changed || st.players).find((p: any) => p.entity_id === A.first.your_entity_id);
  check('alice stays where the server put her (x < 2 after the rejected jump)', !!ap && ap.position.x < 2, JSON.stringify(ap?.position));

  console.log('┌─ reconnect / resume, presence, invites ────────────────┐');
  B.c.close();
  await sleep(200);
  const pres1 = await http_(`${base}/sessions/${S1}`, {}, 'alice');
  check('presence: 1 online, 1 held for reconnect after bob drops', pres1.body?.players_online === 1 && pres1.body?.players_held_for_reconnect === 1, JSON.stringify(pres1.body));
  const B2 = await joinAs(port, 'bob', WORLD, S1);
  check('bob reconnects inside grace → spawn {id:"resume"}, same entity', B2.first?.spawn?.id === 'resume' && B2.first?.your_entity_id === B.first.your_entity_id);
  const pres2 = await http_(`${base}/sessions/${S1}`, {}, 'bob');
  check('presence after resume: 2 online (member bob can read it)', pres2.body?.players_online === 2);
  check('presence of S1 for a stranger → 404', (await http_(`${base}/sessions/${S1}`, {}, 'dave')).status === 404);
  check('invite for S1 by a stranger → 404', (await http_(`${base}/sessions/${S1}/invite`, { method: 'POST' }, 'dave')).status === 404);
  check('invite for S1 without a token → 401', (await http_(`${base}/sessions/${S1}/invite`, { method: 'POST' })).status === 401);
  check('invite for S1 by its owner → 200', (await http_(`${base}/sessions/${S1}/invite`, { method: 'POST' }, 'alice')).status === 200);

  console.log('┌─ tenant isolation ────────────────────────────────────┐');
  const s2 = await http_(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) }, 'acme-1', { tenant_id: 'acme' });
  const S2 = s2.body?.session_id;
  const T1 = await joinAs(port, 'globex-1', WORLD, S2, { tenant_id: 'globex' });
  check('a globex user cannot join an acme session', T1.first?.code === 'forbidden');
  const T2 = await joinAs(port, 'plain-1', WORLD, S2);
  check('a tenantless user cannot join an acme session', T2.first?.code === 'forbidden');
  const T3 = await joinAs(port, 'acme-2', WORLD, S2, { tenant_id: 'acme' });
  check('an acme user joins the acme session', T3.first?.type === 'joined');
  check('acme session presence is invisible to a globex caller → 404', (await http_(`${base}/sessions/${S2}`, {}, 'acme-1', { tenant_id: 'globex' })).status === 404);
  const T4 = await joinAs(port, 'x', WORLD, S2, { tenant_id: 'bad tenant!' });
  check('a malformed tenant claim → auth', T4.first?.code === 'auth');
  for (const t of [T1, T2, T3, T4]) t.c.close();

  console.log('┌─ party over the wire ─────────────────────────────────┐');
  const P1 = new Client(port); await P1.open();
  const P2 = new Client(port); await P2.open();
  const P3 = new Client(port); await P3.open();
  P1.send({ type: 'party_create', token: tok('pat'), world_id: WORLD });
  const ps1 = await P1.waitFor((f) => f.type === 'party_state');
  check('party_create → party_state with an invite code', typeof ps1?.invite_code === 'string' && ps1.leader_user_id === 'pat');
  P3.send({ type: 'party_join', token: tok('evil', { tenant_id: 'globex' }), invite_code: ps1?.invite_code });
  check('a user of another tenant cannot join the party (looks like a bad code)', !!(await P3.waitFor((f) => f.type === 'error' && /invalid invite/.test(f.message))));
  P2.send({ type: 'party_join', token: tok('quinn'), invite_code: ps1?.invite_code });
  const ps2 = await P2.waitFor((f) => f.type === 'party_state');
  check('quinn joins the party', ps2?.member_user_ids?.includes('quinn'));
  P3.send({ type: 'party_leave', token: tok('evil'), party_id: ps1?.party_id });
  check('a non-member cannot party_leave (and learns nothing)', !!(await P3.waitFor((f) => f.type === 'error' && f.code === 'not_found')));
  P2.send({ type: 'party_launch', token: tok('quinn'), party_id: ps1?.party_id });
  check('only the leader can launch', !!(await P2.waitFor((f) => f.type === 'error' && f.code === 'forbidden')));
  P1.send({ type: 'party_launch', token: tok('pat'), party_id: ps1?.party_id });
  const ps3 = await P1.waitFor((f) => f.type === 'party_state' && f.launched);
  check('leader launches → session bound', typeof ps3?.session_id === 'string');
  P2.send({ type: 'join', token: tok('quinn'), world_id: WORLD });
  const pj = await P2.waitFor((f) => f.type === 'joined' || f.type === 'error');
  check('a member\'s join is routed to the party session (group spawn)', pj?.session_id === ps3?.session_id);
  P1.close(); P2.close(); P3.close();

  console.log('┌─ per-user session quota ──────────────────────────────┐');
  const q = [];
  for (let i = 0; i < 3; i++) q.push(await http_(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) }, 'hoarder'));
  check('NETCODE_MAX_SESSIONS_PER_USER=3: 3 created, the 4th is 429', q.every((r) => r.status === 200) && (await http_(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) }, 'hoarder')).status === 429);

  console.log('┌─ persistence replay into a NEW session ───────────────┐');
  const s3 = await http_(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) }, 'alice');
  check('new session for the world is hydrated with 1 object (house; crate was picked up)', s3.body?.hydrated === true && s3.body?.objects === 1, JSON.stringify(s3.body));
  const A3 = await joinAs(port, 'alice', WORLD, s3.body?.session_id);
  const house = A3.first?.snapshot?.objects?.find((o: any) => o.object_type === 'house');
  check('the replayed house is in the join snapshot at its persisted position', !!house && house.position.x === 2 && house.position.z === 2 && house.rotation.yaw === 0.5);
  check('the replayed house is owned by alice\'s entity in the NEW session', house?.owner === A3.first?.your_entity_id);
  const inv3 = await A3.c.waitFor((f) => f.type === 'inventory');
  check('alice\'s inventory is restored after join (crate in slot 5)', inv3?.items?.length === 1 && inv3.items[0].item_id === crate?.entity_id && inv3.items[0].slot === 5);
  const logBefore = (await replayLog(backend.base, WORLD)).deltas.length;
  await sleep(300);
  check('replay does not echo deltas back to the backend', (await replayLog(backend.base, WORLD)).deltas.length === logBefore);
  A3.c.close();

  console.log('┌─ backend ownership refusal ───────────────────────────┐');
  const PV = await joinAs(port, 'mallory', PRIVATE_WORLD);
  PV.c.send({ type: 'place', object_type: 'house', position: { x: 1, y: 0, z: 1 }, rotation: { yaw: 0 } });
  await PV.c.waitFor((f) => f.type === 'object');
  const end = Date.now() + 3000;
  let dropped = 0;
  while (Date.now() < end) { dropped = (await http_(`${base}/health`)).body?.persistence?.deltas_dropped ?? 0; if (dropped > 0) break; await sleep(50); }
  check('a delta for a world the actor may not change → backend 403 → dropped (not retried)', dropped === 1 && backendCalls.some((c) => c.status === 403));
  check('nothing was stored for the private world', (await replayLog(backend.base, PRIVATE_WORLD)).deltas.length === 0);
  PV.c.close();
  A.c.close(); B2.c.close();

  console.log('┌─ world ticket (NETCODE_REQUIRE_WORLD_TICKET) ─────────┐');
  const port2 = await bootNetcode(backend.base, { NETCODE_REQUIRE_WORLD_TICKET: '1' });
  const k1 = await joinAs(port2, 'alice', WORLD);
  check('ticket required: a plain access token is refused', k1.first?.code === 'auth');
  const k2 = await joinAs(port2, 'alice', WORLD, undefined, { world_id: 'world-other' });
  check('ticket required: a ticket for another world is refused', k2.first?.code === 'auth');
  const k3 = await joinAs(port2, 'alice', WORLD, undefined, { world_id: WORLD });
  check('ticket required: a ticket for this world joins', k3.first?.type === 'joined');
  check('ticket required: POST /sessions with a plain token → 403', (await http_(`http://127.0.0.1:${port2}/sessions`, { method: 'POST', body: JSON.stringify({ world_id: WORLD }) }, 'alice')).status === 403);
  for (const k of [k1, k2, k3]) k.c.close();

  console.log('┌─ stale party session (in-process) ────────────────────┐');
  const sm = new SessionManager(() => {}, undefined, {});
  const party = new PartyManager(4);
  const gw = new Gateway(sm, mockTokenVerifier, { party });
  const out: any[] = [];
  const tr: Transport = { send: (f) => out.push(f), close: () => {} };
  const p = party.createParty('lee', WORLD);
  const ss = sm.createSession(WORLD);
  party.launchParty(p.party_id, ss.session_id);
  sm.closeSession(ss.session_id); // no onClose hook here: simulates a party left pointing at a dead session
  gw.handleFrame(tr, { type: 'join', token: 'tok:lee', world_id: WORLD });
  check('a member of a party whose session closed can still join (not stranded on not_found)', out[0]?.type === 'joined' && party.getParty(p.party_id) === null);
  sm.closeAll();

  console.log('┌─ late replay, inventory merge, grace expiry (in-process) ┐');
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const persisted = foldDeltas([
    { op: 'inventory', actor_user_id: 'lee', payload: { action: 'grant', item_id: 'old-a', slot: 0 } },
    { op: 'inventory', actor_user_id: 'lee', payload: { action: 'grant', item_id: 'old-b', slot: 3 } },
    { op: 'place', actor_user_id: 'lee', payload: { entity_id: 'obj-1', object_type: 'lamp', position: { x: 1, y: 0, z: 1 }, rotation: { yaw: 0 } } },
  ]);
  const store = new LiveOwnershipStore();
  const sm2 = new SessionManager(() => {}, store, { hydrate: async (sess) => { await gate; sess.applyReplay(persisted); } });
  const gw2 = new Gateway(sm2, mockTokenVerifier);
  const out2: any[] = [];
  gw2.handleFrame({ send: (f) => out2.push(f), close: () => {} }, { type: 'join', token: 'tok:lee', world_id: WORLD });
  const joined2 = out2.find((f) => f.type === 'joined');
  const sess2 = sm2.getSession(joined2.session_id)!;
  check('a session created by a join is not hydrated yet (replay still in flight)', sess2.hydrated === false && joined2.snapshot.objects.length === 0);
  const eid = joined2.your_entity_id;
  store.grantNext(eid, 'fresh-pick'); // picked up before replay landed → slot 0
  release();
  await sm2.whenHydrated(sess2.session_id);
  const late = out2.filter((f) => f.type === 'inventory').pop();
  const ids = (late?.items || []).map((i: any) => `${i.item_id}@${i.slot}`).sort();
  check('late replay pushes the inventory to the joined player', !!late);
  check('merge keeps the live item and its slot, adds non-conflicting replayed items', JSON.stringify(ids) === JSON.stringify(['fresh-pick@0', 'old-b@3']), JSON.stringify(ids));
  check('late replay broadcasts the persisted object to the joined player', out2.some((f) => f.type === 'object' && f.op === 'place' && f.entity_id === 'obj-1'));
  const prevGrace = Session.RECONNECT_GRACE_MS;
  Session.RECONNECT_GRACE_MS = 50;
  const tr3: Transport = { send: () => {}, close: () => {} };
  gw2.handleFrame(tr3, { type: 'join', token: 'tok:lee', world_id: WORLD, session_id: sess2.session_id }); // second socket, same entity (resume)
  gw2.handleDisconnect(tr3);
  await sleep(150); // grace expires → entity purged
  check('grace expiry purges the entity (no held seat, no store entry)', !sess2.isAwaitingReconnect(eid) && store.getInventory(eid).length === 0);
  const out3: any[] = [];
  gw2.handleFrame({ send: (f) => out3.push(f), close: () => {} }, { type: 'join', token: 'tok:lee', world_id: WORLD, session_id: sess2.session_id });
  const back = out3.find((f) => f.type === 'inventory');
  check('rejoining after grace expiry gets the inventory back (stashed per user)', (back?.items || []).length === 2 && entityIdFor('lee', sess2.session_id) === eid);
  Session.RECONNECT_GRACE_MS = prevGrace;
  sm2.closeAll();
  check('closing the session frees every inventory entry', store.entityCount === 0);

  await backend.close();
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  CLOSURE-E2E: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  return fail === 0;
}

async function cleanup() {
  for (const c of children) { c.removeAllListeners('exit'); c.kill('SIGTERM'); }
  await sleep(100);
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
}

run().then(async (ok) => { await cleanup(); process.exit(ok ? 0 : 1); }, async (err) => { console.error(err); await cleanup(); process.exit(1); });
