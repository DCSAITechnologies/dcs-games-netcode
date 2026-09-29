// tests/session-hardening.test.ts
// DCS Games CW4 Netcode — session hardening (in-memory, no sockets):
// world_id format + binding, max players per session, session GC + session cap,
// per-player state cleanup after reconnect grace, config parsing.

import { Gateway, mockTokenVerifier, Transport } from '../src/gateway';
import { Session, SessionManager, SessionFullError, SessionCapError } from '../src/session';
import { isValidWorldId } from '../src/validation';
import { limitsFromEnv, intEnv } from '../src/config';
import type { OutboundFrame } from '../src/types';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (extra ? '  — ' + extra : '')); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkT() {
  const out: OutboundFrame[] = [];
  const t: Transport = { send: (f) => out.push(f), close: () => {} };
  return { t, out, last: () => out[out.length - 1] as any, first: () => out[0] as any };
}

const managers: SessionManager[] = [];
function mgr(opts?: ConstructorParameters<typeof SessionManager>[2]) {
  const sm = new SessionManager(() => {}, undefined, opts);
  managers.push(sm);
  return sm;
}

async function run(): Promise<boolean> {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — SESSION HARDENING                ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // ===== world_id format (aligned with backend worldstore) =====
  console.log('┌─ world_id format ─────────────────────────────────────┐\n');
  for (const ok of ['w', 'world-zombie-school', 'W_1.2:abc-def', 'a'.repeat(200), '3f2b7c1e-9a0d-4b8e-8c1f-0d9e8f7a6b5c']) {
    check(`valid world_id ${JSON.stringify(ok.length > 40 ? ok.slice(0, 12) + '…' : ok)}`, isValidWorldId(ok));
  }
  for (const bad of ['', 'a'.repeat(201), 'world/../etc', 'world id', 'wörld', 'world?x=1', 'a\u0000b', 'x\n']) {
    check(`invalid world_id ${JSON.stringify(bad.length > 40 ? bad.slice(0, 12) + '…' : bad)}`, !isValidWorldId(bad));
  }
  check('non-string world_id invalid', !isValidWorldId(42) && !isValidWorldId(null) && !isValidWorldId({}));
  let threw = false;
  try { mgr().createSession('bad world'); } catch { threw = true; }
  check('SessionManager.createSession refuses an invalid world_id', threw);

  // ===== world_id on join =====
  console.log('\n┌─ world_id on join: format + session binding ──────────┐\n');
  const sm = mgr();
  const gw = new Gateway(sm, mockTokenVerifier);
  const s = sm.createSession('world-a');
  const bad = mkT();
  gw.handleFrame(bad.t, { type: 'join', token: 'tok:x', world_id: '../../etc/passwd', session_id: s.session_id });
  check('join with malformed world_id → error invalid', bad.first()?.type === 'error' && bad.first()?.code === 'invalid');
  const missing = mkT();
  gw.handleFrame(missing.t, { type: 'join', token: 'tok:x', session_id: s.session_id } as any);
  check('join without world_id → error invalid', missing.first()?.code === 'invalid');
  const mis = mkT();
  gw.handleFrame(mis.t, { type: 'join', token: 'tok:mallory', world_id: 'world-b', session_id: s.session_id });
  check('join existing session with a different world_id → error world_mismatch', mis.first()?.code === 'world_mismatch');
  check('mismatched join did not take a seat', s.playerCount === 0);
  const okJ = mkT();
  gw.handleFrame(okJ.t, { type: 'join', token: 'tok:amy', world_id: 'world-a', session_id: s.session_id });
  check('join with matching world_id → joined', okJ.first()?.type === 'joined');
  const sessionless = mkT();
  const before = sm.activeSessionCount;
  gw.handleFrame(sessionless.t, { type: 'join', token: 'tok:z', world_id: 'bad world' });
  check('session-less join with bad world_id creates no session', sm.activeSessionCount === before && sessionless.first()?.code === 'invalid');

  // ===== Max players =====
  console.log('\n┌─ Max players per session ─────────────────────────────┐\n');
  check('default max players is 16', Session.DEFAULT_MAX_PLAYERS === 16 && sm.createSession('w').maxPlayers === 16);
  const sm2 = mgr({ maxPlayersPerSession: 3 });
  const gw2 = new Gateway(sm2, mockTokenVerifier);
  const s2 = sm2.createSession('w');
  check('server ceiling applies to sessions', s2.maxPlayers === 3);
  check('per-session max_players can lower the ceiling', sm2.createSession('w', { maxPlayers: 2 }).maxPlayers === 2);
  check('per-session max_players cannot raise the ceiling', sm2.createSession('w', { maxPlayers: 99 }).maxPlayers === 3);
  const conns = ['p1', 'p2', 'p3'].map((u) => { const c = mkT(); gw2.handleFrame(c.t, { type: 'join', token: `tok:${u}`, world_id: 'w', session_id: s2.session_id }); return c; });
  check('3 of 3 seats filled', conns.every((c) => c.first()?.type === 'joined') && s2.playerCount === 3);
  const fourth = mkT();
  gw2.handleFrame(fourth.t, { type: 'join', token: 'tok:p4', world_id: 'w', session_id: s2.session_id });
  check('4th join → error session_full', fourth.first()?.type === 'error' && fourth.first()?.code === 'session_full');
  check('session still has 3 players', s2.playerCount === 3);
  // A dropped player keeps their seat through the reconnect grace window.
  gw2.handleDisconnect(conns[0].t);
  const fifth = mkT();
  gw2.handleFrame(fifth.t, { type: 'join', token: 'tok:p5', world_id: 'w', session_id: s2.session_id });
  check('seat held for a player in reconnect grace (newcomer still refused)', fifth.first()?.code === 'session_full');
  const back = mkT();
  gw2.handleFrame(back.t, { type: 'join', token: 'tok:p1', world_id: 'w', session_id: s2.session_id });
  check('the dropped player can reclaim their seat', back.first()?.type === 'joined' && s2.playerCount === 3);
  let full = false;
  try { s2.join({ entity_id: 'e_direct', send: () => {} }); } catch (e) { full = e instanceof SessionFullError; }
  check('Session.join itself refuses beyond cap (SessionFullError)', full);

  // ===== Session GC + cap =====
  console.log('\n┌─ Session GC (idle/empty) + session cap ───────────────┐\n');
  const sm3 = mgr({ maxSessions: 3, idleTtlMs: 1000 });
  const gw3 = new Gateway(sm3, mockTokenVerifier);
  const idle = sm3.createSession('w');
  const busy = sm3.createSession('w');
  const bc = mkT();
  gw3.handleFrame(bc.t, { type: 'join', token: 'tok:busy', world_id: 'w', session_id: busy.session_id });
  const t0 = Date.now();
  check('sweep before idle TTL closes nothing', sm3.sweep(t0 + 500).length === 0 && sm3.activeSessionCount === 2);
  const closed = sm3.sweep(t0 + 1500);
  check('sweep after TTL closes the empty session only', closed.length === 1 && closed[0] === idle.session_id && sm3.getSession(busy.session_id) !== null);
  check('closed session is gone and its tick timer stopped', sm3.getSession(idle.session_id) === null && (idle as any).tickTimer === null);
  check('gcClosed counter advanced', sm3.gcClosed === 1);
  // A session with a player in reconnect grace is NOT empty.
  gw3.handleDisconnect(bc.t);
  check('session with a reconnect hold survives sweep', sm3.sweep(Date.now() + 10_000).length === 0 && sm3.getSession(busy.session_id) !== null);

  sm3.createSession('w'); sm3.createSession('w'); // busy + 2 = 3 = cap
  let capErr: unknown = null;
  try { sm3.createSession('w'); } catch (e) { capErr = e; }
  check('createSession beyond maxSessions → SessionCapError', capErr instanceof SessionCapError && sm3.activeSessionCount === 3);
  const capJoin = mkT();
  gw3.handleFrame(capJoin.t, { type: 'join', token: 'tok:newbie', world_id: 'w' });
  check('session-less join at cap → error capacity', capJoin.first()?.code === 'capacity');

  // At cap, createSession first reclaims idle sessions (sweep) instead of refusing.
  const sm4 = mgr({ maxSessions: 1, idleTtlMs: 0 });
  const first = sm4.createSession('w');
  const second = sm4.createSession('w');
  check('at cap, an idle empty session is reclaimed to make room', sm4.getSession(first.session_id) === null && sm4.getSession(second.session_id) !== null);

  // GC timer: runs on its own and is unref'd.
  const sm5 = mgr({ idleTtlMs: 0 });
  sm5.createSession('w');
  sm5.startGc(20);
  check("GC timer is unref'd (never holds the process open)", (sm5 as any).gcTimer?.hasRef?.() === false);
  await sleep(80);
  check('GC timer closes idle sessions without a manual sweep', sm5.activeSessionCount === 0);
  sm5.stopGc();

  // ===== Per-player cleanup after reconnect grace =====
  console.log('\n┌─ Per-player state cleanup after grace ────────────────┐\n');
  const savedGrace = Session.RECONNECT_GRACE_MS;
  Session.RECONNECT_GRACE_MS = 50;
  const sm6 = mgr();
  const gw6 = new Gateway(sm6, mockTokenVerifier);
  const s6 = sm6.createSession('w');
  const pc = mkT();
  gw6.handleFrame(pc.t, { type: 'join', token: 'tok:leaver', world_id: 'w', session_id: s6.session_id });
  const eid = pc.first()?.your_entity_id as string;
  gw6.handleFrame(pc.t, { type: 'input', seq: 1, move: { x: 0.1, y: 0, z: 0 }, look: { yaw: 0, pitch: 0 }, dt: 1 / 15 });
  gw6.handleFrame(pc.t, { type: 'chat', channel: 'session', text: 'hi' });
  const priv = s6 as any;
  const perEntity = () => ({
    seq: priv.lastInputSeq.has(eid), at: priv.lastInputAt.has(eid), held: priv.disconnected.has(eid),
    buckets: Array.from(priv.rateLimiter.buckets.keys() as Iterable<string>).filter((k) => k.startsWith(eid + ':')).length,
  });
  const live = perEntity();
  check('live player has input/rate-limit state', live.seq && live.at && live.buckets >= 2);
  gw6.handleDisconnect(pc.t);
  const during = perEntity();
  check('during grace: held + seq kept (replay guard survives reconnect)', during.held && during.seq);
  await sleep(120);
  const after = perEntity();
  check('after grace: held state, seq, input clock and rate buckets all purged', !after.held && !after.seq && !after.at && after.buckets === 0, JSON.stringify(after));
  check('session is empty after grace → eligible for GC', s6.isEmpty && sm6.sweep(Date.now() + SessionManager.DEFAULT_IDLE_TTL_MS).includes(s6.session_id));
  // Hard leave purges immediately.
  const s7 = sm6.createSession('w');
  s7.join({ entity_id: 'e_hard', send: () => {} });
  s7.handleFrame('e_hard', { type: 'chat', channel: 'session', text: 'x' });
  s7.leave('e_hard', { hard: true });
  const p7 = s7 as any;
  check('hard leave purges rate buckets + input state at once', p7.rateLimiter.size === 0 && !p7.lastInputSeq.has('e_hard') && s7.isEmpty);
  Session.RECONNECT_GRACE_MS = savedGrace;
  // Invite codes are bounded per session.
  for (let i = 0; i < Session.MAX_INVITES + 50; i++) s7.createInvite();
  check('invite codes bounded per session', (s7 as any).inviteCodes.size === Session.MAX_INVITES);

  // ===== Config parsing =====
  console.log('\n┌─ Limits from env ─────────────────────────────────────┐\n');
  check('NETCODE_MAX_PLAYERS default 16', limitsFromEnv({}).maxPlayersPerSession === 16);
  check('NETCODE_MAX_PLAYERS=8 honoured', limitsFromEnv({ NETCODE_MAX_PLAYERS: '8' }).maxPlayersPerSession === 8);
  check('garbage falls back to default, not unlimited', limitsFromEnv({ NETCODE_MAX_PLAYERS: 'lots' }).maxPlayersPerSession === 16);
  const L = limitsFromEnv({});
  check('defaults: 500 sessions, 60s idle, 10s GC interval', L.maxSessions === 500 && L.sessionIdleMs === 60_000 && L.sessionGcIntervalMs === 10_000);
  check('NETCODE_SESSION_IDLE_MS floor is 1s', limitsFromEnv({ NETCODE_SESSION_IDLE_MS: '5' }).sessionIdleMs === 1000);
  check('intEnv clamps to range', intEnv('0', 5, 1, 10) === 1 && intEnv('1000', 5, 1, 10) === 10 && intEnv('2.5', 5, 1, 10) === 5);

  await sleep(0);
  for (const m of managers) m.closeAll();

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  SESSION-HARDENING: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1), (err) => { console.error(err); process.exit(1); });
