// tests/inventory.test.ts
// DCS Games CW4 Netcode — Inventory Handler tests
// Validates the CW5 ownership-store SEAM: own-to-act, slot rules, C3 delta emission.

import { SessionManager } from '../src/session';
import { Gateway, mockTokenVerifier } from '../src/gateway';
import { MockOwnershipStore, handleInventoryIntent } from '../src/inventory';
import { C3Delta } from '../src/types';
import { HeadlessBot } from '../bots/headless-bot';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — INVENTORY (CW5 seam)             ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // ===== Unit: handler against the ownership seam =====
  console.log('┌─ Unit: ownership-gated validation ────────────────────┐\n');
  const store = new MockOwnershipStore();
  store.grant('e_alice', { item_id: 'lantern', slot: 0, qty: 1 });

  const ctx = { store, entity_id: 'e_alice', session_id: 's1', world_id: 'w1', tick: 5 };

  // owns → equip to free slot OK
  const equip = handleInventoryIntent({ ...ctx, intent: { action: 'equip', item_id: 'lantern', slot: 3 } });
  check('owns + free slot → valid equip', equip.valid === true);
  check('equip emits C3 inventory delta', equip.delta?.op === 'inventory');
  check('C3 delta well-formed', !!equip.delta && equip.delta.actor_entity_id === 'e_alice' && equip.delta.tick === 5);

  // does NOT own → forbidden
  const notOwned = handleInventoryIntent({ ...ctx, intent: { action: 'drop', item_id: 'sword' } });
  check('not owned → forbidden', notOwned.valid === false && notOwned.code === 'forbidden');
  check('forbidden emits NO C3 delta', notOwned.delta === null);

  // occupied slot → invalid
  const occupied = handleInventoryIntent({ ...ctx, intent: { action: 'equip', item_id: 'lantern', slot: 0 } });
  check('occupied slot → invalid', occupied.valid === false && occupied.code === 'invalid');

  // bad slot → invalid
  const badSlot = handleInventoryIntent({ ...ctx, intent: { action: 'move', item_id: 'lantern', slot: 999 } });
  check('out-of-range slot → invalid', badSlot.valid === false);

  // drop (no slot) → valid
  const drop = handleInventoryIntent({ ...ctx, intent: { action: 'drop', item_id: 'lantern' } });
  check('owns + drop (no slot) → valid', drop.valid === true);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Integration: over the session/gateway with ownership wired =====
  console.log('┌─ Integration: inventory frame through gateway ────────┐\n');
  const c3deltas: C3Delta[] = [];
  const ownership = new MockOwnershipStore();
  const sm = new SessionManager((d) => c3deltas.push(d), ownership);
  const gw = new Gateway(sm, mockTokenVerifier);

  const session = sm.createSession('world-zombie-school');
  // entity id is deterministic: e_<sha256(user:session)[:12]>
  const bot = new HeadlessBot('alice', gw);
  bot.join('tok:alice', 'world-zombie-school', session.session_id);
  await sleep(60);
  check('bot joined (ownership-wired session)', bot.entity_id !== null);

  // grant the bot an item, then equip
  ownership.grant(bot.entity_id!, { item_id: 'medkit', slot: 0, qty: 2 });
  const c3Before = c3deltas.filter((d) => d.op === 'inventory').length;
  bot.inventory('equip', 'medkit', 5);
  await sleep(60);
  const invFrame = bot.received.find((f) => f.type === 'inventory');
  check('equip → inventory out-frame to actor', !!invFrame);
  check('equip persisted a C3 inventory delta', c3deltas.filter((d) => d.op === 'inventory').length === c3Before + 1);

  // act on unowned item → error, no delta
  bot.lastError = null;
  const before2 = c3deltas.filter((d) => d.op === 'inventory').length;
  bot.inventory('drop', 'item-i-dont-own', undefined);
  await sleep(60);
  check('unowned item → error frame', bot.lastError !== null);
  check('unowned action → no C3 delta', c3deltas.filter((d) => d.op === 'inventory').length === before2);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Graceful: no ownership store wired → reject cleanly =====
  console.log('┌─ Graceful: no ownership store (pre-CW5) ──────────────┐\n');
  const sm2 = new SessionManager((d) => c3deltas.push(d)); // no ownership
  const gw2 = new Gateway(sm2, mockTokenVerifier);
  const s2 = sm2.createSession('w');
  const bot2 = new HeadlessBot('bob', gw2);
  bot2.join('tok:bob', 'w', s2.session_id);
  await sleep(60);
  bot2.lastError = null;
  bot2.inventory('equip', 'x', 1);
  await sleep(60);
  check('no ownership store → graceful error (not crash)', bot2.lastError !== null);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  sm.closeSession(session.session_id);
  sm2.closeSession(s2.session_id);

  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  INVENTORY: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1));
