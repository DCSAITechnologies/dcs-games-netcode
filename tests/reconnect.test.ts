// tests/reconnect.test.ts
// DCS Games CW4 Netcode — Reconnect / Resume
// A dropped client rejoins its session and REATTACHES to its existing entity
// (preserved position/health), rather than respawning at origin.

import { SessionManager, Session } from '../src/session';
import { Gateway, mockTokenVerifier } from '../src/gateway';
import { C3Delta } from '../src/types';
import { HeadlessBot } from '../bots/headless-bot';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — RECONNECT / RESUME               ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const c3deltas: C3Delta[] = [];
  const sm = new SessionManager((d) => c3deltas.push(d));
  const gw = new Gateway(sm, mockTokenVerifier);
  const session = sm.createSession('world-zombie-school');

  // ===== Move, drop, reconnect → state preserved =====
  console.log('┌─ Drop + reconnect preserves entity state ─────────────┐\n');

  const bot = new HeadlessBot('alice', gw);
  bot.join('tok:alice', 'world-zombie-school', session.session_id);
  await sleep(50);
  const entityId = bot.entity_id!;
  check('initial join ok', !!entityId);

  // Move a few legal steps so position != origin
  bot.move({ x: 0.4, y: 0, z: 0.3 }, 1 / 15, 1);
  await sleep(30);
  bot.move({ x: 0.4, y: 0, z: 0.3 }, 1 / 15, 2);
  await sleep(80); // let a state frame land
  const posBefore = session.snapshot().players.find((p) => p.entity_id === entityId)?.position;
  check('player moved off origin', !!posBefore && (posBefore.x !== 0 || posBefore.z !== 0));

  // Drop (soft disconnect → grace window)
  bot.disconnect();
  await sleep(40);
  check('after drop: entity awaiting reconnect', session.isAwaitingReconnect(entityId));
  check('after drop: not in active players', !session.snapshot().players.some((p) => p.entity_id === entityId));
  check('after drop: disconnectedCount = 1', session.disconnectedCount === 1);

  // Reconnect — SAME user + SAME session ⇒ SAME deterministic entity_id ⇒ reattach
  const bot2 = new HeadlessBot('alice-again', gw);
  bot2.join('tok:alice', 'world-zombie-school', session.session_id);
  await sleep(60);
  check('reconnect: same entity_id reattached', bot2.entity_id === entityId);
  check('reconnect: no longer awaiting reconnect', !session.isAwaitingReconnect(entityId));
  check('reconnect: back in active players', session.snapshot().players.some((p) => p.entity_id === entityId));

  // Position preserved (NOT reset to origin)
  const posAfter = session.snapshot().players.find((p) => p.entity_id === entityId)?.position;
  check('reconnect: position PRESERVED (not origin)',
    !!posAfter && posAfter.x === posBefore!.x && posAfter.z === posBefore!.z);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Reconnect snapshot is current =====
  console.log('┌─ Reconnect snapshot reflects world ───────────────────┐\n');
  check('reconnect: snapshot carries the world', bot2.snapshot?.world_id === 'world-zombie-school');
  check('reconnect: snapshot has the player', bot2.snapshot?.players.some((p) => p.entity_id === entityId) === true);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Grace expiry → permanent removal =====
  console.log('┌─ Grace window expiry ─────────────────────────────────┐\n');

  // Use a short grace for the test
  const origGrace = Session.RECONNECT_GRACE_MS;
  (Session as any).RECONNECT_GRACE_MS = 120; // 120ms

  const s2 = sm.createSession('w');
  const b = new HeadlessBot('bob', gw);
  b.join('tok:bob', 'w', s2.session_id);
  await sleep(40);
  const bid = b.entity_id!;
  b.disconnect();
  await sleep(40);
  check('bob awaiting reconnect (within grace)', s2.isAwaitingReconnect(bid));
  await sleep(160); // exceed 120ms grace
  check('after grace expiry: no longer awaiting', !s2.isAwaitingReconnect(bid));

  // Reconnect after grace → fresh spawn at origin (state gone)
  const b2 = new HeadlessBot('bob-late', gw);
  b2.join('tok:bob', 'w', s2.session_id);
  await sleep(50);
  const bobPos = s2.snapshot().players.find((p) => p.entity_id === bid)?.position;
  check('late reconnect: fresh spawn at origin', !!bobPos && bobPos.x === 0 && bobPos.z === 0);

  (Session as any).RECONNECT_GRACE_MS = origGrace; // restore

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Hard leave skips grace =====
  console.log('┌─ Hard leave (explicit quit) skips grace ──────────────┐\n');
  const s3 = sm.createSession('w');
  const q = new HeadlessBot('quit', gw);
  q.join('tok:quit', 'w', s3.session_id);
  await sleep(40);
  const qid = q.entity_id!;
  s3.leave(qid, { hard: true }); // explicit quit
  await sleep(20);
  check('hard leave: NOT awaiting reconnect', !s3.isAwaitingReconnect(qid));
  check('hard leave: removed from players', !s3.snapshot().players.some((p) => p.entity_id === qid));

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  sm.closeSession(session.session_id);
  sm.closeSession(s2.session_id);
  sm.closeSession(s3.session_id);

  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  RECONNECT: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1));
