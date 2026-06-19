// src/validation.ts
// DCS Games CW4 Netcode — Server-Authoritative Validation
// Anti-cheat day one: no teleport, no speedhack, bounds-checked placement.
// Clients send intents; server validates BEFORE applying.

import { Vec3, InputFrame, PlaceFrame } from './types.js';

export interface ValidationResult {
  valid: boolean;
  code?: 'invalid' | 'rate_limit' | 'forbidden';
  reason?: string;
  // For movement: the server-corrected position (clamped if client overreached)
  corrected?: Vec3;
}

// Tunables (server-authoritative limits)
export const LIMITS = {
  MAX_MOVE_SPEED: 8.0, // units/sec (walking+sprint); anything faster = speedhack
  GROSS_OVERREACH_FACTOR: 1.5, // move > 1.5x max-dist = hard reject (cheat); <= 1.5x = clamp (jitter)
  MAX_DT: 0.25, // max client frame delta accepted (250ms); larger = clamped
  MIN_DT: 0.001,
  WORLD_BOUNDS: { min: -500, max: 500 }, // placement + movement bounds (per axis)
  MAX_PLACE_DISTANCE: 20, // can't place objects farther than this from the actor
  INPUT_RATE_PER_SEC: 30, // max input frames/sec per client (tick is 15Hz; allow 2x headroom)
  PLACE_RATE_PER_SEC: 10,
  CHAT_RATE_PER_SEC: 3,
};

function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function inBounds(p: Vec3): boolean {
  const { min, max } = LIMITS.WORLD_BOUNDS;
  return (
    p.x >= min && p.x <= max &&
    p.y >= min && p.y <= max &&
    p.z >= min && p.z <= max
  );
}

/**
 * Validate a movement input against the player's last authoritative position.
 * Rejects teleport/speedhack; clamps overreach to max-speed sphere.
 */
export function validateMovement(
  currentPos: Vec3,
  input: InputFrame
): ValidationResult {
  // Clamp dt to sane range (anti-speedhack via inflated dt)
  let dt = input.dt;
  if (typeof dt !== 'number' || isNaN(dt) || dt < LIMITS.MIN_DT) {
    return { valid: false, code: 'invalid', reason: 'bad dt' };
  }
  if (dt > LIMITS.MAX_DT) {
    dt = LIMITS.MAX_DT; // clamp; don't reject (network hiccup is legit)
  }

  // Movement vector must be sane (no NaN/Infinity injection)
  const m = input.move;
  if (
    !m ||
    !isFinite(m.x) || !isFinite(m.y) || !isFinite(m.z)
  ) {
    return { valid: false, code: 'invalid', reason: 'bad move vector' };
  }

  // Compute proposed new position
  const proposed: Vec3 = {
    x: currentPos.x + m.x,
    y: currentPos.y + m.y,
    z: currentPos.z + m.z,
  };

  // Max distance this tick = speed * dt
  const maxDist = LIMITS.MAX_MOVE_SPEED * dt;
  const moveDist = dist(currentPos, proposed);

  if (moveDist > maxDist) {
    // Two regimes:
    //  - MINOR overreach (<= GROSS_OVERREACH_FACTOR x): network jitter / rounding → clamp silently, accept.
    //  - GROSS overreach (> factor): clear speedhack/teleport → REJECT with error, snap back.
    const overreach = moveDist / maxDist;
    if (overreach > LIMITS.GROSS_OVERREACH_FACTOR) {
      return {
        valid: false,
        code: 'invalid',
        reason: `speedhack: move ${overreach.toFixed(1)}x over limit`,
        corrected: currentPos, // snap back to authoritative
      };
    }
    // Minor overreach: clamp to max-distance sphere along the move direction
    const scale = maxDist / moveDist;
    const corrected: Vec3 = {
      x: currentPos.x + m.x * scale,
      y: currentPos.y + m.y * scale,
      z: currentPos.z + m.z * scale,
    };
    if (!inBounds(corrected)) {
      return { valid: false, code: 'invalid', reason: 'out of bounds', corrected: currentPos };
    }
    return { valid: true, corrected }; // accepted but clamped
  }

  // Bounds check
  if (!inBounds(proposed)) {
    return { valid: false, code: 'invalid', reason: 'out of bounds', corrected: currentPos };
  }

  return { valid: true, corrected: proposed };
}

/**
 * Validate an object placement.
 * Must be in-bounds and within reach of the actor.
 */
export function validatePlacement(
  actorPos: Vec3,
  place: PlaceFrame
): ValidationResult {
  const p = place.position;
  if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
    return { valid: false, code: 'invalid', reason: 'bad position' };
  }
  if (!inBounds(p)) {
    return { valid: false, code: 'invalid', reason: 'placement out of bounds' };
  }
  if (dist(actorPos, p) > LIMITS.MAX_PLACE_DISTANCE) {
    return { valid: false, code: 'forbidden', reason: 'placement too far from actor' };
  }
  if (typeof place.object_type !== 'string' || place.object_type.length === 0) {
    return { valid: false, code: 'invalid', reason: 'missing object_type' };
  }
  return { valid: true };
}

/**
 * Token-bucket rate limiter (per client, per action).
 */
export class RateLimiter {
  private buckets: Map<string, { tokens: number; lastRefill: number }> = new Map();

  /**
   * @param key unique per (client, action)
   * @param ratePerSec max sustained rate
   * @returns true if allowed, false if rate-limited
   */
  allow(key: string, ratePerSec: number, now: number = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: ratePerSec, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(ratePerSec, bucket.tokens + elapsed * ratePerSec);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  reset(key?: string) {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }
}
