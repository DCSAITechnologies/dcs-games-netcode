// src/validation.ts
// DCS Games CW4 Netcode — Server-Authoritative Validation
// Anti-cheat day one: no teleport, no speedhack, bounds-checked placement.
// Clients send intents; server validates BEFORE applying.

import { Vec3, InputFrame, PlaceFrame, SpawnPoint } from './types.js';

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
  MAX_DT: 0.25, // max SERVER-DERIVED delta credited (250ms); a longer gap does not bank distance
  MIN_DT: 0.001,
  DEFAULT_DT: 1 / 15, // one server tick, credited for an entity's first input
  MAX_INTERACT_DISTANCE: 6, // must be within reach to interact with an object
  INTERACT_RATE_PER_SEC: 10,
  WORLD_BOUNDS: { min: -500, max: 500 }, // placement + movement bounds (per axis)
  MAX_PLACE_DISTANCE: 20, // can't place objects farther than this from the actor
  INPUT_RATE_PER_SEC: 30, // max input frames/sec per client (tick is 15Hz; allow 2x headroom)
  PLACE_RATE_PER_SEC: 10,
  CHAT_RATE_PER_SEC: 3,
};

/**
 * World id format — IDENTICAL to the backend's world store
 * (dcs-games backend src/core/worldstore.mjs: /^[A-Za-z0-9._:-]{1,200}$/).
 * A world the backend cannot address cannot have a netcode session either.
 */
export const WORLD_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export function isValidWorldId(world_id: unknown): world_id is string {
  return typeof world_id === 'string' && WORLD_ID_RE.test(world_id);
}

export const MAX_SPAWN_POINTS = 64;
const SPAWN_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function isVec3(v: unknown): v is Vec3 {
  const o = v as Vec3;
  return !!o && typeof o === 'object' && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z);
}

/**
 * Validate a world's spawn list (as sent to POST /sessions — the shape the
 * backend shim's sessionConfigFromManifest emits: [{id?, position:{x,y,z}}]).
 * Every point must be finite and inside WORLD_BOUNDS, or every first move from
 * it would be rejected. Ids default to spawn_<i>. Positions are copied.
 */
export function sanitizeSpawnPoints(raw: unknown): { ok: true; points: SpawnPoint[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, points: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'spawn_points must be an array' };
  if (raw.length > MAX_SPAWN_POINTS) return { ok: false, error: `at most ${MAX_SPAWN_POINTS} spawn_points` };
  const points: SpawnPoint[] = [];
  for (let i = 0; i < raw.length; i++) {
    const sp = raw[i] as { id?: unknown; position?: unknown };
    if (!sp || typeof sp !== 'object') return { ok: false, error: `spawn_points[${i}] must be an object` };
    if (!isVec3(sp.position)) return { ok: false, error: `spawn_points[${i}].position must be finite {x,y,z}` };
    if (!inBounds(sp.position)) return { ok: false, error: `spawn_points[${i}].position is outside world bounds` };
    const id = sp.id === undefined ? `spawn_${i}` : sp.id;
    if (typeof id !== 'string' || !SPAWN_ID_RE.test(id)) return { ok: false, error: `spawn_points[${i}].id is invalid` };
    points.push({ id, position: { x: sp.position.x, y: sp.position.y, z: sp.position.z } });
  }
  return { ok: true, points };
}

/** Does a client-claimed initial position equal the assigned one (1mm tolerance)? */
export function samePosition(a: unknown, b: Vec3, eps = 1e-3): boolean {
  if (!isVec3(a)) return false;
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps;
}

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

/** Server-side timing context for one entity's movement budget. */
export interface MovementContext {
  /** ms timestamp of the previous ACCEPTED input for this entity, or null for the first. */
  lastAcceptedAt: number | null;
  /** ms timestamp now. Injected so the check is testable. */
  now: number;
}

/**
 * Derive the movement time budget SERVER-SIDE.
 *
 * Round-2 executed a 7.5x speedhack with zero rejections, and this is the line
 * that allowed it. The budget used to come from `input.dt`, which the client
 * sends. Clamping it to MAX_DT (0.25s) did not help: a cheater simply sent
 * dt=0.25 on every frame and, at the 30 inputs/sec rate limit, bought
 * 8.0 * 0.25 * 30 = 60 units/sec against an intended 8.
 *
 * The same line penalised honest players. A 60fps client sending dt=1/60 was
 * still capped at 30 inputs/sec, so it could only reach 4 units/sec — half the
 * intended speed. The design conflated a per-input budget with a per-second one.
 *
 * Deriving dt from real elapsed time fixes both: the budget is now integrated
 * over the wall clock, so 30 honest inputs and 30 forged ones buy exactly the
 * same distance.
 */
export function serverDt(ctx: MovementContext): number {
  if (!ctx || typeof ctx.now !== 'number') return LIMITS.DEFAULT_DT;
  if (ctx.lastAcceptedAt == null) return LIMITS.DEFAULT_DT;   // first input: one tick's worth
  const elapsed = (ctx.now - ctx.lastAcceptedAt) / 1000;
  if (!isFinite(elapsed) || elapsed <= 0) return LIMITS.MIN_DT;
  return Math.min(LIMITS.MAX_DT, Math.max(LIMITS.MIN_DT, elapsed));
}

/**
 * Validate a movement input against the player's last authoritative position.
 * Rejects teleport/speedhack; clamps overreach to max-speed sphere.
 *
 * `ctx` is required for a real budget. It is optional in the signature only so
 * that existing callers keep compiling; without it the check falls back to a
 * single tick's worth of movement, which is conservative rather than exploitable.
 */
export function validateMovement(
  currentPos: Vec3,
  input: InputFrame,
  ctx?: MovementContext
): ValidationResult {
  // The client's own dt is no longer trusted for the budget. It is still
  // rejected when malformed, because a malformed frame is a bad frame.
  const clientDt = input.dt;
  if (typeof clientDt !== 'number' || isNaN(clientDt) || clientDt < LIMITS.MIN_DT) {
    return { valid: false, code: 'invalid', reason: 'bad dt' };
  }
  // SERVER-AUTHORITATIVE budget. This is the fix for the 7.5x speedhack.
  const dt = ctx ? serverDt(ctx) : LIMITS.DEFAULT_DT;

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

  /** Drop every bucket whose key starts with `prefix` (per-entity cleanup). */
  resetPrefix(prefix: string) {
    for (const k of this.buckets.keys()) if (k.startsWith(prefix)) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }

  reset(key?: string) {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }
}
