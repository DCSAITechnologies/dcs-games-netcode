// tests/aoi.test.ts
// DCS Games CW4 Netcode — Interest Management / Area-of-Interest (AOI)
// With a finite AOI radius, a recipient receives state ONLY for entities within
// range. Entities entering AOI appear in changed[]; leaving AOI appear in removed[].
// AOI off (Infinity, default) preserves global behavior.

import { SessionManager, Session } from '../src/session';
import { Gateway, mockTokenVerifier } from '../src/gateway';
import { OutboundFrame, C3Delta } from '../src/types';
import { HeadlessBot } from '../bots/headless-bot';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — INTEREST MANAGEMENT (AOI)        ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const c3deltas: C3Delta[] = [];
  const sm = new SessionManager((d) => c3deltas.push(d));
  const gw = new Gateway(sm, mockTokenVerifier);
  (Session as any).KEYFRAME_EVERY_TICKS = 12;
  const origAoi = Session.AOI_RADIUS;
  (Session as any).AOI_RADIUS = 5; // tight radius for the test

  const session = sm.createSession('w');

  // alice at origin; bob will start far away (out of AOI), then walk in.
  const alice = new HeadlessBot('alice', gw);
  const aliceRaw: OutboundFrame[] = [];
  alice.onMessageRaw = (f) => aliceRaw.push(f);
  alice.join('tok:alice', 'w', session.session_id);
  await sleep(60);

  const bob = new HeadlessBot('bob', gw);
  bob.join('tok:bob', 'w', session.session_id);
  await sleep(60);

  // Move bob far away (out of AOI radius 5). Walk +x in legal steps to ~x=10.
  let bseq = 1;
  for (let i = 0; i < 30; i++) { bob.move({ x: 0.5, y: 0, z: 0 }, 1 / 15, bseq++); await sleep(15); }
  await sleep(200);

  const bobPos = session.snapshot().players.find((p) => p.entity_id === bob.entity_id)!.position;
  check('bob walked out of AOI (x > 5)', bobPos.x > 5);

  // ===== Distant entity culled from alice's view =====
  console.log('\n┌─ Distant entity culled ───────────────────────────────┐\n');
  // alice should NOT currently observe bob (he's beyond radius 5)
  check('alice does not observe distant bob', !alice.observedPlayers.has(bob.entity_id!));

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Entity entering AOI appears =====
  console.log('┌─ Entity entering AOI becomes visible ─────────────────┐\n');
  // bob walks back toward origin (into AOI)
  for (let i = 0; i < 30; i++) { bob.move({ x: -0.5, y: 0, z: 0 }, 1 / 15, bseq++); await sleep(15); }
  await sleep(200);
  const bobPos2 = session.snapshot().players.find((p) => p.entity_id === bob.entity_id)!.position;
  check('bob walked back into AOI (x <= 5)', bobPos2.x <= 5);
  check('alice now observes bob (entered AOI)', alice.observedPlayers.has(bob.entity_id!));

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Entity leaving AOI → removed[] =====
  console.log('┌─ Entity leaving AOI → removed[] ──────────────────────┐\n');
  aliceRaw.length = 0;
  // bob walks far away again
  for (let i = 0; i < 30; i++) { bob.move({ x: 0.5, y: 0, z: 0 }, 1 / 15, bseq++); await sleep(15); }
  await sleep(200);
  const sawBobRemoved = aliceRaw.some((f: any) => f.type === 'state_delta' && f.removed.includes(bob.entity_id));
  check('alice received bob in removed[] when he left AOI', sawBobRemoved);
  check('alice no longer observes bob', !alice.observedPlayers.has(bob.entity_id!));

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Self is always visible =====
  console.log('┌─ Self always visible ─────────────────────────────────┐\n');
  check('alice always observes herself', alice.observedPlayers.has(alice.entity_id!));

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== AOI off → global behavior restored =====
  console.log('┌─ AOI off (Infinity) → everyone visible ───────────────┐\n');
  (Session as any).AOI_RADIUS = Infinity;
  const s2 = sm.createSession('w');
  const c1 = new HeadlessBot('c1', gw);
  c1.join('tok:c1', 'w', s2.session_id);
  await sleep(50);
  const c2 = new HeadlessBot('c2', gw);
  c2.join('tok:c2', 'w', s2.session_id);
  await sleep(50);
  // move c2 far — with AOI off, c1 still sees it
  let cseq = 1;
  for (let i = 0; i < 20; i++) { c2.move({ x: 0.5, y: 0, z: 0 }, 1 / 15, cseq++); await sleep(15); }
  await sleep(150);
  check('AOI off: c1 sees distant c2 (no culling)', c1.observedPlayers.has(c2.entity_id!));

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  (Session as any).AOI_RADIUS = origAoi;
  (Session as any).KEYFRAME_EVERY_TICKS = 30;
  sm.closeSession(session.session_id);
  sm.closeSession(s2.session_id);

  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  AOI: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1));
