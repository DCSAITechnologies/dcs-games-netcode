// tests/lag-comp.test.ts
// DCS Games CW4 Netcode — Lag-comp / Input Sequencing (P1 netcode hardening)
// Server buffers/orders client inputs by seq, drops stale/duplicate inputs, and
// ACKs the last-applied seq (rides state_delta) so clients reconcile prediction.

import { SessionManager, Session } from '../src/session';
import { Gateway, mockTokenVerifier } from '../src/gateway';
import { C3Delta, OutboundFrame } from '../src/types';
import { HeadlessBot } from '../bots/headless-bot';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ackFor(frames: OutboundFrame[], entity_id: string): number | undefined {
  // Walk deltas newest→oldest, find the latest changed entry for this entity carrying an ack
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i] as any;
    if (f.type === 'state_delta') {
      const me = f.changed.find((p: any) => p.entity_id === entity_id);
      if (me && typeof me.last_ack_seq === 'number') return me.last_ack_seq;
    }
  }
  return undefined;
}

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — LAG-COMP / INPUT SEQUENCING      ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const c3deltas: C3Delta[] = [];
  const sm = new SessionManager((d) => c3deltas.push(d));
  const gw = new Gateway(sm, mockTokenVerifier);
  (Session as any).KEYFRAME_EVERY_TICKS = 15;
  const session = sm.createSession('w');

  const bot = new HeadlessBot('alice', gw);
  const raw: OutboundFrame[] = [];
  bot.onMessageRaw = (f) => raw.push(f);
  bot.join('tok:alice', 'w', session.session_id);
  await sleep(60);
  const eid = bot.entity_id!;

  // ===== seq ACK rides state_delta =====
  console.log('┌─ Server ACKs applied input seq ───────────────────────┐\n');
  bot.move({ x: 0.3, y: 0, z: 0 }, 1 / 15, 10);
  await sleep(120);
  check('applied input → last_ack_seq = 10', ackFor(raw, eid) === 10);

  bot.move({ x: 0.3, y: 0, z: 0 }, 1 / 15, 11);
  await sleep(120);
  check('next input → last_ack_seq advances to 11', ackFor(raw, eid) === 11);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== stale / duplicate seq dropped =====
  console.log('┌─ Stale + duplicate inputs dropped ────────────────────┐\n');
  const posBeforeStale = session.snapshot().players.find((p) => p.entity_id === eid)!.position.x;
  // Replay an old seq (5 < 11) — must be ignored, position unchanged
  bot.move({ x: 5, y: 0, z: 0 }, 1 / 15, 5);
  await sleep(80);
  const posAfterStale = session.snapshot().players.find((p) => p.entity_id === eid)!.position.x;
  check('stale seq (5) ignored — position unchanged', Math.abs(posAfterStale - posBeforeStale) < 1e-9);
  check('stale seq does not regress ack', ackFor(raw, eid) === 11);

  // Duplicate of the current seq (11) — also ignored
  bot.move({ x: 0.3, y: 0, z: 0 }, 1 / 15, 11);
  await sleep(80);
  check('duplicate seq (11) ignored — ack stays 11', ackFor(raw, eid) === 11);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== out-of-order: only the newest applies =====
  console.log('┌─ Out-of-order inputs: only forward seq applies ───────┐\n');
  // Send seq 20, then a late 15 — 15 must be dropped (already past 20)
  bot.move({ x: 0.2, y: 0, z: 0 }, 1 / 15, 20);
  await sleep(80);
  check('forward seq 20 applied', ackFor(raw, eid) === 20);
  bot.move({ x: 0.2, y: 0, z: 0 }, 1 / 15, 15);
  await sleep(80);
  check('late seq 15 dropped — ack stays 20', ackFor(raw, eid) === 20);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== rejected move still ACKs (client reconciles to snap-back) =====
  console.log('┌─ Rejected move ACKs seq + snaps back ─────────────────┐\n');
  bot.lastError = null;
  const posBeforeCheat = session.snapshot().players.find((p) => p.entity_id === eid)!.position.x;
  bot.move({ x: 1000, y: 0, z: 0 }, 1 / 15, 30); // gross speedhack → rejected
  await sleep(100);
  check('cheat move rejected (error frame)', bot.lastError !== null);
  check('rejected move still ACKs seq 30 (client reconciles)', ackFor(raw, eid) === 30);
  const posAfterCheat = session.snapshot().players.find((p) => p.entity_id === eid)!.position.x;
  check('cheat move snapped back (no position gain)', Math.abs(posAfterCheat - posBeforeCheat) < 1e-9);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== bad seq rejected =====
  console.log('┌─ Malformed seq rejected ──────────────────────────────┐\n');
  bot.lastError = null;
  bot.move({ x: 0.1, y: 0, z: 0 }, 1 / 15, NaN as any);
  await sleep(60);
  check('NaN seq → error', bot.lastError !== null);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== reconnect preserves ack monotonicity =====
  console.log('┌─ Reconnect keeps seq monotonic ───────────────────────┐\n');
  bot.disconnect();
  await sleep(40);
  const bot2 = new HeadlessBot('alice2', gw);
  const raw2: OutboundFrame[] = [];
  bot2.onMessageRaw = (f) => raw2.push(f);
  bot2.join('tok:alice', 'w', session.session_id); // same entity (reconnect)
  await sleep(60);
  check('reconnected as same entity', bot2.entity_id === eid);
  // A stale seq from before the drop (25 < 30) must still be rejected post-reconnect
  bot2.move({ x: 9, y: 0, z: 0 }, 1 / 15, 25);
  await sleep(80);
  const posR = session.snapshot().players.find((p) => p.entity_id === eid)!.position.x;
  // Forward seq after reconnect applies
  bot2.move({ x: 0.2, y: 0, z: 0 }, 1 / 15, 40);
  await sleep(100);
  check('post-reconnect: forward seq 40 applies', ackFor(raw2, eid) === 40);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  (Session as any).KEYFRAME_EVERY_TICKS = 30;
  sm.closeSession(session.session_id);

  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  LAG-COMP: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1));
