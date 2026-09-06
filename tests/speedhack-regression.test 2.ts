// B9 — regression test for the exploit Round-2 executed against this service.
//
// Finding N-6: a 7.5x movement speedhack passed every anti-cheat check with zero
// rejections, because the movement budget came from the CLIENT'S `dt`. Clamping
// it to MAX_DT did not help — a cheater sent dt=0.25 on every frame and, at the
// 30 inputs/sec rate limit, bought 8.0 * 0.25 * 30 = 60 units/sec against an
// intended 8. The same line penalised an honest 60fps client down to 4 units/sec.
//
// This test reproduces the exploit exactly as the audit ran it, and asserts it is
// closed while honest clients now reach their intended speed.
import assert from 'node:assert/strict';
import { validateMovement, serverDt, LIMITS, RateLimiter } from '../src/validation.js';
import type { Vec3, InputFrame } from '../src/types.js';

let passed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${(e as Error).message}`); process.exitCode = 1; }
};

const at = (x: number): Vec3 => ({ x, y: 0, z: 0 });
const frame = (seq: number, dx: number, dt: number): InputFrame =>
  ({ seq, dt, move: { x: dx, y: 0, z: 0 }, look: { yaw: 0, pitch: 0 } } as InputFrame);

/**
 * Run one second of wall-clock time at `inputsPerSec`, with the client claiming
 * `claimedDt` per frame and asking for `claimedDt * MAX_MOVE_SPEED` of movement.
 * Returns how far the server actually let them travel.
 */
function simulateOneSecond({ inputsPerSec, claimedDt, requestPerFrame }: { inputsPerSec: number; claimedDt: number; requestPerFrame: number }) {
  const limiter = new RateLimiter();
  let pos = at(0);
  let lastAcceptedAt: number | null = null;
  let applied = 0, rejected = 0, rateLimited = 0;
  const t0 = 1_000_000;
  const stepMs = 1000 / inputsPerSec;

  for (let i = 0; i < inputsPerSec; i++) {
    const now = t0 + i * stepMs;
    if (!limiter.allow('e1:input', LIMITS.INPUT_RATE_PER_SEC, now)) { rateLimited++; continue; }
    const r = validateMovement(pos, frame(i, requestPerFrame, claimedDt), { lastAcceptedAt, now });
    if (!r.valid) { rejected++; continue; }
    if (r.corrected) pos = r.corrected;
    applied++;
    lastAcceptedAt = now;      // only an accepted input advances the budget
  }
  return { distance: pos.x, applied, rejected, rateLimited };
}

console.log('B9 speedhack regression\n');

check('the exact Round-2 exploit is closed: inflated dt no longer buys distance', () => {
  // The audit's cheat: claim dt = MAX_DT every frame, at the full input rate.
  const cheat = simulateOneSecond({ inputsPerSec: 30, claimedDt: LIMITS.MAX_DT, requestPerFrame: LIMITS.MAX_MOVE_SPEED * LIMITS.MAX_DT });
  assert.ok(
    cheat.distance <= LIMITS.MAX_MOVE_SPEED * 1.05,
    `cheater travelled ${cheat.distance.toFixed(2)} units/sec against a limit of ${LIMITS.MAX_MOVE_SPEED} (audit measured 60.00)`
  );
});

check('an honest 60fps client is no longer penalised to half speed', () => {
  // The audit measured an honest 60fps client reaching only 4.00 units/sec.
  const honest = simulateOneSecond({ inputsPerSec: 30, claimedDt: 1 / 60, requestPerFrame: LIMITS.MAX_MOVE_SPEED / 30 });
  assert.ok(
    honest.distance > LIMITS.MAX_MOVE_SPEED * 0.85,
    `honest client reached only ${honest.distance.toFixed(2)} units/sec of an intended ${LIMITS.MAX_MOVE_SPEED} (audit measured 4.00)`
  );
});

check('an honest 30fps client and an honest 60fps client travel the same distance', () => {
  const a = simulateOneSecond({ inputsPerSec: 30, claimedDt: 1 / 30, requestPerFrame: LIMITS.MAX_MOVE_SPEED / 30 });
  const b = simulateOneSecond({ inputsPerSec: 30, claimedDt: 1 / 60, requestPerFrame: LIMITS.MAX_MOVE_SPEED / 30 });
  assert.ok(Math.abs(a.distance - b.distance) < 0.2, `frame rate should not change speed: ${a.distance} vs ${b.distance}`);
});

check('a slower client is not penalised either — the budget integrates real time', () => {
  const slow = simulateOneSecond({ inputsPerSec: 10, claimedDt: 1 / 10, requestPerFrame: LIMITS.MAX_MOVE_SPEED / 10 });
  assert.ok(slow.distance > LIMITS.MAX_MOVE_SPEED * 0.8, `a 10Hz client reached ${slow.distance.toFixed(2)} units/sec`);
});

check('a gross overreach is still rejected outright', () => {
  const r = validateMovement(at(0), frame(1, 500, 1 / 30), { lastAcceptedAt: 1_000_000, now: 1_000_033 });
  assert.equal(r.valid, false);
  assert.match(String(r.reason), /speedhack/);
  assert.deepEqual(r.corrected, at(0), 'the player is snapped back to their authoritative position');
});

check('a rejected input does NOT advance the movement budget', () => {
  // Otherwise a cheater could spam rejected frames to bank time and then move far.
  const limiter = new RateLimiter();
  let pos = at(0);
  let lastAcceptedAt: number | null = 1_000_000;
  for (let i = 0; i < 20; i++) {
    const now = 1_000_000 + i * 10;
    if (!limiter.allow('e:input', LIMITS.INPUT_RATE_PER_SEC, now)) continue;
    const r = validateMovement(pos, frame(i, 900, 1 / 60), { lastAcceptedAt, now });
    assert.equal(r.valid, false, 'each of these should be rejected');
    // lastAcceptedAt deliberately NOT advanced, mirroring session.ts
  }
  const after = validateMovement(pos, frame(99, 5, 1 / 60), { lastAcceptedAt, now: 1_000_200 });
  const travelled = after.corrected ? after.corrected.x : 0;
  assert.ok(travelled <= LIMITS.MAX_MOVE_SPEED * LIMITS.MAX_DT + 0.01,
    `after 20 rejections the next move bought ${travelled.toFixed(2)} units, more than one clamped tick`);
});

check('a long gap does not bank unlimited distance', () => {
  // A client that goes quiet for a minute must not return with 60s of movement.
  const r = validateMovement(at(0), frame(1, LIMITS.MAX_MOVE_SPEED * 60, 1 / 30), { lastAcceptedAt: 1_000_000, now: 1_060_000 });
  const moved = r.corrected ? r.corrected.x : 0;
  assert.ok(moved <= LIMITS.MAX_MOVE_SPEED * LIMITS.MAX_DT + 0.01,
    `a 60s gap credited ${moved.toFixed(2)} units; MAX_DT should cap it at ${(LIMITS.MAX_MOVE_SPEED * LIMITS.MAX_DT).toFixed(2)}`);
});

check('the client dt is still validated for malformed frames', () => {
  const ctx = { lastAcceptedAt: 1_000_000, now: 1_000_033 };
  assert.equal(validateMovement(at(0), frame(1, 0.1, NaN), ctx).valid, false);
  assert.equal(validateMovement(at(0), frame(1, 0.1, -1), ctx).valid, false);
  assert.equal(validateMovement(at(0), { seq: 1, move: { x: 0.1, y: 0, z: 0 }, look: { yaw: 0, pitch: 0 } } as any, ctx).valid, false);
});

check('serverDt is bounded and ignores the client entirely', () => {
  assert.equal(serverDt({ lastAcceptedAt: null, now: 1000 }), LIMITS.DEFAULT_DT, 'first input gets one tick');
  assert.equal(serverDt({ lastAcceptedAt: 1000, now: 1_000_000 }), LIMITS.MAX_DT, 'a long gap clamps to MAX_DT');
  assert.equal(serverDt({ lastAcceptedAt: 1000, now: 1000 }), LIMITS.MIN_DT, 'no elapsed time buys no distance');
  assert.equal(serverDt({ lastAcceptedAt: 2000, now: 1000 }), LIMITS.MIN_DT, 'a clock that goes backwards buys no distance');
  assert.ok(Math.abs(serverDt({ lastAcceptedAt: 1000, now: 1033 }) - 0.033) < 0.001);
});

check('a NaN or Infinity move vector is still rejected', () => {
  const ctx = { lastAcceptedAt: 1_000_000, now: 1_000_033 };
  assert.equal(validateMovement(at(0), frame(1, NaN, 1 / 30), ctx).valid, false);
  assert.equal(validateMovement(at(0), frame(1, Infinity, 1 / 30), ctx).valid, false);
});

check('interact limits are declared, so the handler can enforce them', () => {
  assert.ok(LIMITS.MAX_INTERACT_DISTANCE > 0, 'interact had no distance check at all');
  assert.ok(LIMITS.INTERACT_RATE_PER_SEC > 0, 'interact had no rate limit at all');
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error('SPEEDHACK REGRESSION FAILED');
