// tests/delta-compression.test.ts
// DCS Games CW4 Netcode — State Delta Compression (mobile-first bandwidth)
// Proves: idle players cost ~0 bandwidth; movement emits a delta with only the
// changed player; keyframes land periodically for resync; departures emit removed[].

import { SessionManager, Session } from '../src/session';
import { Gateway, mockTokenVerifier } from '../src/gateway';
import { OutboundFrame, C3Delta } from '../src/types';
import { HeadlessBot } from '../bots/headless-bot';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — STATE DELTA COMPRESSION          ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const c3deltas: C3Delta[] = [];
  const sm = new SessionManager((d) => c3deltas.push(d));
  const gw = new Gateway(sm, mockTokenVerifier);
  // Short keyframe interval for a fast test
  const origKf = Session.KEYFRAME_EVERY_TICKS;
  (Session as any).KEYFRAME_EVERY_TICKS = 15; // ~1s at 15Hz

  const session = sm.createSession('world-zombie-school');

  const bot = new HeadlessBot('alice', gw);
  // Record raw frames
  const stateDeltas: any[] = [];
  bot.onMessageRaw = (f: OutboundFrame) => { if (f.type === 'state_delta') stateDeltas.push(f); };
  bot.join('tok:alice', 'world-zombie-school', session.session_id);
  await sleep(60);
  check('joined', bot.entity_id !== null);

  // ===== Idle = near-zero bandwidth =====
  console.log('\n┌─ Idle player → near-zero frames (only keyframes) ─────┐\n');
  // Wait past the first keyframe so the player is fully seeded into lastSent.
  await sleep(1100);
  stateDeltas.length = 0;
  await sleep(1300); // > 1 keyframe cycle; bot idle throughout.
  const idleNonKeyframes = stateDeltas.filter((f) => !f.keyframe);
  // Once seeded, a continuously-idle player emits ZERO non-keyframe frames.
  check('idle: no non-keyframe state frames (bandwidth saved)', idleNonKeyframes.length === 0);
  const idleKeyframes = stateDeltas.filter((f) => f.keyframe);
  check('idle: keyframes still arrive (resync guarantee)', idleKeyframes.length >= 1);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Movement → delta with only the moved player =====
  console.log('┌─ Movement → delta carries only changed player ────────┐\n');
  stateDeltas.length = 0;
  bot.move({ x: 0.3, y: 0, z: 0.2 }, 1 / 15, 1);
  await sleep(120); // a couple ticks
  const moveDeltas = stateDeltas.filter((f) => !f.keyframe && f.changed.length > 0);
  check('movement emits a non-keyframe delta', moveDeltas.length >= 1);
  check('delta carries the moved player', moveDeltas[0]?.changed.some((p: any) => p.entity_id === bot.entity_id));
  check('delta is small (1 changed player)', moveDeltas[0]?.changed.length === 1);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Two players: only the mover is in the delta =====
  console.log('┌─ Two players → only the mover appears in delta ───────┐\n');
  const bob = new HeadlessBot('bob', gw);
  bob.join('tok:bob', 'world-zombie-school', session.session_id);
  await sleep(80);
  // Let a keyframe pass so both are seeded
  await sleep(1100);
  stateDeltas.length = 0;
  // Only alice moves
  bot.move({ x: 0.25, y: 0, z: 0 }, 1 / 15, 2);
  await sleep(120);
  const twoPlayerDelta = stateDeltas.filter((f) => !f.keyframe && f.changed.length > 0)[0];
  check('only-mover delta excludes the idle player',
    !!twoPlayerDelta &&
    twoPlayerDelta.changed.some((p: any) => p.entity_id === bot.entity_id) &&
    !twoPlayerDelta.changed.some((p: any) => p.entity_id === bob.entity_id));

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Departure → removed[] =====
  console.log('┌─ Departure → removed[] in next delta ─────────────────┐\n');
  stateDeltas.length = 0;
  session.leave(bob.entity_id!, { hard: true }); // hard leave so it's gone (not held)
  // Force a distinct-position move so a non-keyframe delta is emitted next tick,
  // which carries bob in removed[] (runTick detects he left players[]).
  bot.move({ x: 0.3, y: 0, z: 0.1 }, 1 / 15, 100);
  await sleep(200);
  const removalDelta = stateDeltas.find((f) => f.removed && f.removed.includes(bob.entity_id));
  check('departed player appears in removed[]', !!removalDelta);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Keyframe carries full state =====
  console.log('┌─ Keyframe carries full state ─────────────────────────┐\n');
  stateDeltas.length = 0;
  await sleep(1100); // wait for a keyframe
  const kf = stateDeltas.find((f) => f.keyframe);
  check('keyframe present', !!kf);
  check('keyframe includes alice (full state)', kf?.changed.some((p: any) => p.entity_id === bot.entity_id));

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  (Session as any).KEYFRAME_EVERY_TICKS = origKf;
  sm.closeSession(session.session_id);

  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  DELTA-COMPRESSION: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1));
