// tests/mp0-acceptance.test.ts
// DCS Games CW4 Netcode — Acceptance Gate M-P0 + anti-cheat + C3 delta validity
//
// M-P0: two bot clients join one session; one places an object; the other sees it
//       within 1 tick; each mutation emits a VALID C3 delta.

import { SessionManager } from '../src/session';
import { Gateway, mockTokenVerifier } from '../src/gateway';
import { C3Delta } from '../src/types';
import { HeadlessBot } from '../bots/headless-bot';

// Simple test harness
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// C3 delta validation (reconcile against C3 save-delta.schema.json when Day0 lands)
function isValidC3Delta(d: C3Delta): boolean {
  return (
    typeof d.op === 'string' &&
    ['place', 'remove', 'mutate', 'inventory'].includes(d.op) &&
    typeof d.session_id === 'string' && d.session_id.length > 0 &&
    typeof d.world_id === 'string' && d.world_id.length > 0 &&
    typeof d.actor_entity_id === 'string' && d.actor_entity_id.length > 0 &&
    typeof d.tick === 'number' && d.tick >= 0 &&
    typeof d.payload === 'object' && d.payload !== null &&
    typeof d.ts === 'string' && !isNaN(Date.parse(d.ts))
  );
}

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — M-P0 ACCEPTANCE GATE              ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // Capture all C3 deltas emitted to "CW5"
  const c3deltas: C3Delta[] = [];
  const c3Sink = (d: C3Delta) => c3deltas.push(d);

  const sessionManager = new SessionManager(c3Sink);
  const gateway = new Gateway(sessionManager, mockTokenVerifier);

  // ===== M-P0 CORE =====
  console.log('┌─ M-P0: two bots, place, see-within-1-tick, valid C3 ─┐\n');

  // Bot A creates a session by joining without a session_id
  const botA = new HeadlessBot('A', gateway);
  botA.join('tok:userA', 'world-zombie-school');
  check('M-P0: bot A joined (got entity_id)', botA.entity_id !== null);
  check('M-P0: bot A got session_id', botA.session_id !== null);
  check('M-P0: bot A got snapshot', botA.snapshot !== null);

  const sessionId = botA.session_id!;

  // Bot B joins the SAME session
  const botB = new HeadlessBot('B', gateway);
  botB.join('tok:userB', 'world-zombie-school', sessionId);
  check('M-P0: bot B joined same session', botB.session_id === sessionId);
  check('M-P0: bots have distinct entity ids', botA.entity_id !== botB.entity_id);

  // Bot A sees bot B spawn (B joined after A, so A gets a spawn frame)
  check('M-P0: bot A observes bot B (spawn)', botA.observedPlayers.has(botB.entity_id!));

  // Bot A places an object
  const placePos = { x: 5, y: 0, z: 3 };
  botA.place('house', placePos);

  // Allow one tick to process broadcast (tick = 1000/15 ≈ 66ms; wait 2 ticks for safety)
  await sleep(150);

  // Bot B should see the placed object
  check('M-P0: bot B sees A\'s placed house (within 1 tick)', botB.seesObjectAt('house', placePos));
  check('M-P0: bot A sees own placed house (authoritative id)', botA.seesObjectAt('house', placePos));

  // A C3 delta must have been emitted for the placement
  const placeDeltas = c3deltas.filter((d) => d.op === 'place');
  check('M-P0: placement emitted a C3 delta', placeDeltas.length === 1);
  check('M-P0: C3 place delta is VALID', placeDeltas.length === 1 && isValidC3Delta(placeDeltas[0]));
  check('M-P0: C3 delta has correct world_id', placeDeltas[0]?.world_id === 'world-zombie-school');
  check('M-P0: C3 delta actor = bot A', placeDeltas[0]?.actor_entity_id === botA.entity_id);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== ANTI-CHEAT =====
  console.log('┌─ Anti-cheat: server-authoritative validation ─────────┐\n');

  // Speedhack attempt: huge move in one tick
  const botBeforeError = botB.lastError;
  botB.move({ x: 1000, y: 0, z: 0 }, 1 / 15, 1); // way beyond max speed
  await sleep(20);
  check('anti-cheat: speedhack move rejected (error frame)', botB.lastError !== botBeforeError && botB.lastError !== null);

  // Teleport via NaN injection
  botB.lastError = null;
  botB.move({ x: NaN, y: 0, z: 0 }, 1 / 15, 2);
  await sleep(20);
  check('anti-cheat: NaN move rejected', botB.lastError !== null);

  // Out-of-bounds placement
  botA.lastError = null;
  botA.place('house', { x: 9999, y: 0, z: 0 });
  await sleep(20);
  check('anti-cheat: out-of-bounds placement rejected', botA.lastError !== null);

  // Placement too far from actor (actor at origin, place 100 units away)
  botA.lastError = null;
  botA.place('house', { x: 100, y: 0, z: 0 });
  await sleep(20);
  check('anti-cheat: too-far placement rejected', botA.lastError !== null);

  // No C3 delta should have been emitted for any rejected mutation
  check('anti-cheat: rejected mutations emitted NO C3 delta', c3deltas.filter((d) => d.op === 'place').length === 1);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== INTERACT / PICKUP =====
  console.log('┌─ Interact: pickup removes object + emits C3 ──────────┐\n');

  // Find the placed object's authoritative id (from bot A's observed view)
  const placedId = Array.from(botA.observedObjects.entries()).find(
    ([, o]) => o.object_type === 'house'
  )?.[0];
  check('interact: placed object has authoritative id', !!placedId);

  if (placedId) {
    botA.pickup(placedId);
    await sleep(150);
    check('interact: object removed from bot B view', !botB.observedObjects.has(placedId));
    const removeDeltas = c3deltas.filter((d) => d.op === 'remove');
    check('interact: pickup emitted a C3 remove delta', removeDeltas.length === 1);
    check('interact: C3 remove delta is VALID', removeDeltas.length === 1 && isValidC3Delta(removeDeltas[0]));
  }

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== CHAT + PING =====
  console.log('┌─ Chat + ping ─────────────────────────────────────────┐\n');

  const bChatBefore = botB.received.filter((f) => f.type === 'chat').length;
  botA.chat('hello from A');
  await sleep(20);
  const bChatAfter = botB.received.filter((f) => f.type === 'chat').length;
  check('chat: bot B received A\'s chat', bChatAfter === bChatBefore + 1);

  const pongBefore = botA.received.filter((f) => f.type === 'pong').length;
  botA.ping();
  await sleep(20);
  const pongAfter = botA.received.filter((f) => f.type === 'pong').length;
  check('ping: bot A got pong', pongAfter === pongBefore + 1);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== AUTH =====
  console.log('┌─ Auth handshake ──────────────────────────────────────┐\n');

  const badBot = new HeadlessBot('bad', gateway);
  badBot.join('garbage-token', 'world-zombie-school');
  check('auth: invalid token rejected', badBot.lastError?.startsWith('auth') === true);
  check('auth: rejected bot got no entity_id', badBot.entity_id === null);

  // Frame before join is forbidden
  const earlyBot = new HeadlessBot('early', gateway);
  earlyBot.chat('should fail'); // chat before join
  check('auth: frame-before-join forbidden', earlyBot.lastError?.startsWith('forbidden') === true);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== TICK LOOP =====
  // With delta compression, an idle player produces no frames until the next
  // keyframe — so move a bot to force a delta and prove the tick loop is live.
  console.log('┌─ Tick loop (delta emitted on movement) ───────────────┐\n');
  const tickBefore = botA.lastStateTick;
  botA.move({ x: 0.3, y: 0, z: 0 }, 1 / 15, 99);
  await sleep(250); // ~3-4 ticks at 15Hz
  check('tick: state advances on movement (delta emitted)', botA.lastStateTick > tickBefore);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // Cleanup
  sessionManager.closeSession(sessionId);

  // ===== SUMMARY =====
  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  M-P0 GATE: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1));
