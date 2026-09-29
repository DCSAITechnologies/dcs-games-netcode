// tests/session-hardening.test.ts
// DCS Games CW4 Netcode — session hardening (in-memory, no sockets):
// world_id format + binding, max players per session, config parsing.

import { Gateway, mockTokenVerifier, Transport } from '../src/gateway';
import { Session, SessionManager, SessionFullError } from '../src/session';
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

  // ===== Config parsing =====
  console.log('\n┌─ Limits from env ─────────────────────────────────────┐\n');
  check('NETCODE_MAX_PLAYERS default 16', limitsFromEnv({}).maxPlayersPerSession === 16);
  check('NETCODE_MAX_PLAYERS=8 honoured', limitsFromEnv({ NETCODE_MAX_PLAYERS: '8' }).maxPlayersPerSession === 8);
  check('garbage falls back to default, not unlimited', limitsFromEnv({ NETCODE_MAX_PLAYERS: 'lots' }).maxPlayersPerSession === 16);
  check('intEnv clamps to range', intEnv('0', 5, 1, 10) === 1 && intEnv('1000', 5, 1, 10) === 10 && intEnv('2.5', 5, 1, 10) === 5);

  await sleep(0);
  for (const m of managers) for (const id of m.sessionIds()) m.closeSession(id);

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  SESSION-HARDENING: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1), (err) => { console.error(err); process.exit(1); });
