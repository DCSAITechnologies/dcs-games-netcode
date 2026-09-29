// src/session.ts
// DCS Games CW4 Netcode — Authoritative Session
// Tick loop @ 15Hz · validates intents · applies · broadcasts · emits C3 deltas to CW5

import crypto from 'node:crypto';
import {
  Vec3,
  PlayerState,
  WorldObject,
  WorldSnapshot,
  InboundFrame,
  OutboundFrame,
  StateDeltaFrame,
  InputFrame,
  PlaceFrame,
  InteractFrame,
  ChatFrame,
  InventoryFrame,
  C3Delta,
  SpawnPoint,
} from './types.js';
import {
  validateMovement,
  validatePlacement,
  RateLimiter,
  LIMITS,
  isValidWorldId,
  sanitizeSpawnPoints,
} from './validation.js';
import {
  OwnershipStore,
  handleInventoryIntent,
} from './inventory.js';

export const TICK_HZ = 15;
export const TICK_MS = 1000 / TICK_HZ;

/** Stable serialization of a player's broadcastable state, for delta change-detection.
 *  Rounds floats to 3 decimals so sub-millimeter jitter doesn't force a resend. */
function serializePlayer(p: PlayerState): string {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return JSON.stringify({
    e: p.entity_id,
    p: [r(p.position.x), r(p.position.y), r(p.position.z)],
    l: [r(p.look.yaw), r(p.look.pitch)],
    h: p.health,
    a: p.last_ack_seq ?? -1,
  });
}

/**
 * A connected client (transport-agnostic: real WS or headless bot).
 * The session calls send() to push frames; it doesn't care what's behind it.
 */
export interface ClientConn {
  entity_id: string;
  /** Verified user id (token `sub`) behind this entity, when known. Stamped on C3 deltas. */
  user_id?: string;
  send(frame: OutboundFrame): void;
}

/**
 * C3 delta sink — CW5 persistence consumes these.
 * In production this is an async emit to CW5's save pipeline.
 */
export type C3Sink = (delta: C3Delta) => void;

/** Per-session options (set at creation, fixed for the session's life). */
export interface SessionOptions {
  /** Seats in this session. Reconnect-grace holds keep their seat. Default Session.DEFAULT_MAX_PLAYERS. */
  maxPlayers?: number;
  /** The world's spawn points (validated by sanitizeSpawnPoints). Empty → origin. */
  spawnPoints?: SpawnPoint[];
  /** Seed for spawn selection. Default: the session id. */
  spawnSeed?: string;
}

/** Where a fresh player spawns when the world provides no spawn points. */
export const DEFAULT_SPAWN: SpawnPoint = Object.freeze({ id: 'origin', position: Object.freeze({ x: 0, y: 0, z: 0 }) }) as SpawnPoint;

/** Thrown by Session.join when the session has no free seat. */
export class SessionFullError extends Error {}

/** Thrown by SessionManager.createSession when the server is at its session cap. */
export class SessionCapError extends Error {}

/**
 * Authoritative game session. One per active world instance.
 */
export class Session {
  readonly session_id: string;
  readonly world_id: string;
  private players: Map<string, PlayerState> = new Map();
  private objects: Map<string, WorldObject> = new Map();
  private conns: Map<string, ClientConn> = new Map();
  private tick = 0;
  private rateLimiter = new RateLimiter();
  private c3Sink: C3Sink;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private inviteCodes: Set<string> = new Set();
  private ownership?: OwnershipStore;
  // Reconnect/resume: entity_id -> preserved state during the grace window
  private disconnected: Map<string, { player: PlayerState; timer: ReturnType<typeof setTimeout> }> = new Map();
  // Grace window before a disconnected player is permanently removed (default 30s).
  static RECONNECT_GRACE_MS = 30_000;
  // Delta compression: last-broadcast serialized state per entity (for change detection)
  private lastSent: Map<string, string> = new Map();
  // Lag-comp / reconciliation: last applied input seq per entity (monotonic).
  private lastInputSeq: Map<string, number> = new Map();
  /** ms timestamp of the last ACCEPTED input per entity — the server-side movement budget. */
  private lastInputAt: Map<string, number> = new Map();
  // Interest management (AOI): radius within which a player receives others' state.
  // Infinity (default) = no culling — everyone sees everyone (preserves P0/M-P1 behavior).
  // Set finite (e.g. 50) to cull distant entities for bandwidth + scale.
  static AOI_RADIUS = Infinity;
  // Per-recipient visibility: recipient_eid -> (subject_eid -> last serialized state seen).
  // Lets us send per-player deltas + emit removed[] when a subject leaves AOI.
  private aoiSeen: Map<string, Map<string, string>> = new Map();
  // Keyframe (full state) every N ticks to let clients resync (guards drift).
  static KEYFRAME_EVERY_TICKS = 30; // 2s at 15Hz

  /** ms timestamp of the last join/leave/frame/grace-expiry — drives idle GC. */
  lastActivityAt = Date.now();
  // Max invite codes a session retains (oldest evicted) — POST /invite cannot grow memory without bound.
  static MAX_INVITES = 256;
  // Max players per session when not specified at creation.
  static DEFAULT_MAX_PLAYERS = 16;
  readonly maxPlayers: number;
  private spawnPoints: SpawnPoint[];
  private spawnSeed: string;

  constructor(world_id: string, c3Sink: C3Sink, session_id?: string, ownership?: OwnershipStore, opts?: SessionOptions) {
    this.world_id = world_id;
    this.session_id = session_id || crypto.randomUUID();
    this.c3Sink = c3Sink;
    this.ownership = ownership;
    const mp = opts?.maxPlayers;
    this.maxPlayers = Number.isInteger(mp) && (mp as number) >= 1 ? (mp as number) : Session.DEFAULT_MAX_PLAYERS;
    this.spawnPoints = (opts?.spawnPoints || []).map((p) => ({ id: p.id, position: { ...p.position } }));
    this.spawnSeed = opts?.spawnSeed || this.session_id;
  }

  // ===== Lifecycle =====

  start() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.runTick(), TICK_MS);
  }

  stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    // Clear any pending reconnect grace timers
    for (const { timer } of this.disconnected.values()) clearTimeout(timer);
    this.disconnected.clear();
    this.aoiSeen.clear();
    this.lastSent.clear();
    this.lastInputSeq.clear();
    this.lastInputAt.clear();
    this.rateLimiter.reset();
    this.inviteCodes.clear();
  }

  /** No connected players and nobody held in the reconnect grace window. */
  get isEmpty(): boolean {
    return this.players.size === 0 && this.disconnected.size === 0;
  }

  /**
   * Forget every per-entity record except lastSent (runTick turns that into a
   * removed[] entry and clears it). Called when a player is gone for good:
   * hard quit, or reconnect grace expired.
   */
  private purgeEntity(entity_id: string) {
    const held = this.disconnected.get(entity_id);
    if (held) { clearTimeout(held.timer); this.disconnected.delete(entity_id); }
    this.lastInputSeq.delete(entity_id);
    this.lastInputAt.delete(entity_id);
    this.aoiSeen.delete(entity_id); // this player's own visibility map
    this.rateLimiter.resetPrefix(`${entity_id}:`);
  }

  get currentTick() {
    return this.tick;
  }

  get playerCount() {
    return this.players.size;
  }

  get objectCount() {
    return this.objects.size;
  }

  // ===== Join / Leave =====

  /**
   * Can this entity take (or retake) a seat? An entity already present, or held
   * in the reconnect grace window, always can — its seat is reserved. A new
   * entity needs a free seat: connected + held < maxPlayers.
   */
  canAdmit(entity_id: string): boolean {
    if (this.players.has(entity_id) || this.disconnected.has(entity_id)) return true;
    return this.players.size + this.disconnected.size < this.maxPlayers;
  }

  /**
   * Seeded, deterministic spawn selection: the same (seed, entity) always gets
   * the same point, so a client can be told its spawn before it moves and the
   * server can hold it to it. No spawn points → DEFAULT_SPAWN (origin).
   */
  spawnFor(entity_id: string): SpawnPoint {
    if (this.spawnPoints.length === 0) return { id: DEFAULT_SPAWN.id, position: { ...DEFAULT_SPAWN.position } };
    const h = crypto.createHash('sha256').update(`${this.spawnSeed}:${entity_id}`).digest();
    const sp = this.spawnPoints[h.readUInt32BE(0) % this.spawnPoints.length];
    return { id: sp.id, position: { ...sp.position } };
  }

  /**
   * Where join() will place this entity: its preserved position when it is
   * reattaching within the grace window, else its spawn point.
   */
  assignedSpawn(entity_id: string): SpawnPoint {
    const held = this.disconnected.get(entity_id)?.player;
    if (held) return { id: 'resume', position: { ...held.position } };
    return this.spawnFor(entity_id);
  }

  join(conn: ClientConn): WorldSnapshot {
    if (!this.canAdmit(conn.entity_id)) throw new SessionFullError(`session ${this.session_id} is full (${this.maxPlayers})`);
    this.lastActivityAt = Date.now();
    // Reconnect/resume: if this entity is in the disconnected grace window,
    // reattach to its PRESERVED state (position/health/vel) instead of respawning.
    const held = this.disconnected.get(conn.entity_id);
    if (held) {
      clearTimeout(held.timer);
      this.disconnected.delete(conn.entity_id);
      this.players.set(conn.entity_id, held.player); // restore exact state
      this.conns.set(conn.entity_id, conn);
      // Tell others the player is back (re-spawn at preserved position)
      this.broadcast(
        {
          type: 'spawn',
          entity_id: conn.entity_id,
          entity_type: 'player',
          position: held.player.position,
        },
        conn.entity_id
      );
      return this.snapshot();
    }

    // Fresh join — at the session's assigned spawn point for this entity.
    const spawnPos: Vec3 = this.spawnFor(conn.entity_id).position;
    const player: PlayerState = {
      entity_id: conn.entity_id,
      position: spawnPos,
      look: { yaw: 0, pitch: 0 },
      vel: { x: 0, y: 0, z: 0 },
      health: 100,
    };
    this.players.set(conn.entity_id, player);
    this.conns.set(conn.entity_id, conn);

    // Tell existing players about the newcomer
    this.broadcast(
      {
        type: 'spawn',
        entity_id: conn.entity_id,
        entity_type: 'player',
        position: spawnPos,
      },
      conn.entity_id // exclude the newcomer (they get full snapshot)
    );

    return this.snapshot();
  }

  /**
   * leave() — by default starts the reconnect grace window (preserves state).
   * Pass {hard:true} to remove immediately (explicit quit, not a drop).
   */
  leave(entity_id: string, opts?: { hard?: boolean }) {
    const player = this.players.get(entity_id);
    this.players.delete(entity_id);
    this.conns.delete(entity_id);
    this.broadcast({ type: 'despawn', entity_id });

    this.lastActivityAt = Date.now();
    if (opts?.hard || !player) {
      // Explicit quit (or unknown entity) — drop any held state too.
      this.purgeEntity(entity_id);
      // NOTE: do NOT delete lastSent here — runTick detects the entity is gone
      // from players[] and emits it in removed[], then clears lastSent itself.
      // (Under AOI, other recipients' aoiSeen maps self-clean via removed[].)
      return;
    }

    // Soft disconnect: preserve state for the grace window.
    // (lastInputSeq is intentionally kept so a reconnecting client's seq stays monotonic.)
    const timer = setTimeout(() => {
      // Grace expired → permanent removal of every per-player record.
      this.purgeEntity(entity_id);
      this.lastActivityAt = Date.now();
    }, Session.RECONNECT_GRACE_MS);
    // Don't keep the event loop alive solely for the grace timer (CI-friendly).
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    this.disconnected.set(entity_id, { player, timer });
  }

  /** Is this entity currently in the reconnect grace window? */
  isAwaitingReconnect(entity_id: string): boolean {
    return this.disconnected.has(entity_id);
  }

  get disconnectedCount(): number {
    return this.disconnected.size;
  }

  createInvite(): string {
    const code = crypto.randomBytes(4).toString('hex');
    if (this.inviteCodes.size >= Session.MAX_INVITES) {
      const oldest = this.inviteCodes.values().next().value;
      if (oldest !== undefined) this.inviteCodes.delete(oldest);
    }
    this.inviteCodes.add(code);
    return code;
  }

  validateInvite(code: string): boolean {
    return this.inviteCodes.has(code);
  }

  // ===== Intent handling (client → server) =====

  handleFrame(entity_id: string, frame: InboundFrame): void {
    const conn = this.conns.get(entity_id);
    if (!conn) return;
    this.lastActivityAt = Date.now();

    switch (frame.type) {
      case 'input':
        this.handleInput(entity_id, conn, frame);
        break;
      case 'place':
        this.handlePlace(entity_id, conn, frame);
        break;
      case 'interact':
        this.handleInteract(entity_id, conn, frame);
        break;
      case 'inventory':
        this.handleInventory(entity_id, conn, frame);
        break;
      case 'chat':
        this.handleChat(entity_id, conn, frame);
        break;
      case 'ping':
        conn.send({ type: 'pong', t: frame.t, server_t: Date.now() });
        break;
      // join handled by gateway before session.join()
    }
  }

  private handleInput(entity_id: string, conn: ClientConn, frame: InputFrame) {
    if (!this.rateLimiter.allow(`${entity_id}:input`, LIMITS.INPUT_RATE_PER_SEC)) {
      conn.send({ type: 'error', code: 'rate_limit', message: 'input rate exceeded', ref_seq: frame.seq });
      return;
    }
    const player = this.players.get(entity_id);
    if (!player) return;

    // Input sequencing: drop stale/duplicate inputs (seq <= last applied).
    // Guards against out-of-order delivery and replayed packets. seq must be a
    // monotonic non-negative integer from the client.
    if (typeof frame.seq !== 'number' || !Number.isFinite(frame.seq)) {
      conn.send({ type: 'error', code: 'invalid', message: 'bad seq' });
      return;
    }
    const lastSeq = this.lastInputSeq.get(entity_id) ?? -1;
    if (frame.seq <= lastSeq) {
      // Stale/duplicate — silently ignore (not an error; normal under reordering).
      return;
    }

    const now = Date.now();
    const result = validateMovement(player.position, frame, { lastAcceptedAt: this.lastInputAt.get(entity_id) ?? null, now });
    if (!result.valid) {
      // Reject: snap client back to authoritative position.
      // Still ACK the seq so the client knows we processed it (and reconciles to the snap-back).
      this.lastInputSeq.set(entity_id, frame.seq);
      player.last_ack_seq = frame.seq;
      conn.send({ type: 'error', code: result.code || 'invalid', message: result.reason || 'invalid move', ref_seq: frame.seq });
      if (result.corrected) player.position = result.corrected;
      return;
    }
    // Apply server-authoritative position (possibly clamped)
    if (result.corrected) {
      const prev = player.position;
      player.position = result.corrected;
      player.vel = {
        x: result.corrected.x - prev.x,
        y: result.corrected.y - prev.y,
        z: result.corrected.z - prev.z,
      };
    }
    player.look = frame.look;
    // Ack the applied input seq (rides the next state_delta for reconciliation).
    this.lastInputSeq.set(entity_id, frame.seq);
    // ONLY an accepted input advances the movement budget. Advancing it on a
    // rejection would let a cheater bank distance by spamming rejected frames.
    this.lastInputAt.set(entity_id, now);
    player.last_ack_seq = frame.seq;
    // Movement is broadcast via the tick loop's state_delta (not per-input).
  }

  private handlePlace(entity_id: string, conn: ClientConn, frame: PlaceFrame) {
    if (!this.rateLimiter.allow(`${entity_id}:place`, LIMITS.PLACE_RATE_PER_SEC)) {
      conn.send({ type: 'error', code: 'rate_limit', message: 'place rate exceeded' });
      return;
    }
    const player = this.players.get(entity_id);
    if (!player) return;

    const result = validatePlacement(player.position, frame);
    if (!result.valid) {
      conn.send({ type: 'error', code: result.code || 'invalid', message: result.reason || 'invalid placement' });
      return;
    }

    // Apply: create authoritative object
    const obj: WorldObject = {
      entity_id: crypto.randomUUID(),
      object_type: frame.object_type,
      position: frame.position,
      rotation: frame.rotation,
      owner: entity_id,
      placed_tick: this.tick,
    };
    this.objects.set(obj.entity_id, obj);

    // Broadcast to ALL (including placer, so they see authoritative id)
    this.broadcast({
      type: 'object',
      op: 'place',
      entity_id: obj.entity_id,
      object_type: obj.object_type,
      position: obj.position,
      rotation: obj.rotation,
    });

    // Emit C3 delta to CW5 (every validated mutation persists)
    this.emitC3({
      op: 'place',
      session_id: this.session_id,
      world_id: this.world_id,
      actor_entity_id: entity_id,
      tick: this.tick,
      payload: {
        entity_id: obj.entity_id,
        object_type: obj.object_type,
        position: obj.position,
        rotation: obj.rotation,
      },
      ts: new Date().toISOString(),
    });
  }

  private handleInteract(entity_id: string, conn: ClientConn, frame: InteractFrame) {
    // Round-2: interact had NO rate limit, NO distance check and NO ownership
    // check, while handleInput, handlePlace and handleChat all had at least one.
    // Any client could pick up any object anywhere in the world, as fast as it
    // could send frames.
    if (!this.rateLimiter.allow(`${entity_id}:interact`, LIMITS.INTERACT_RATE_PER_SEC)) {
      conn.send({ type: 'error', code: 'rate_limit', message: 'interact rate limit' });
      return;
    }
    const target = this.objects.get(frame.target_entity_id);
    if (!target) {
      conn.send({ type: 'error', code: 'not_found', message: 'interact target not found' });
      return;
    }
    const actor = this.players.get(entity_id);
    if (!actor) {
      conn.send({ type: 'error', code: 'forbidden', message: 'no such actor in this session' });
      return;
    }
    // Reach check: you cannot interact with something you are not standing near.
    const dx = actor.position.x - target.position.x;
    const dy = actor.position.y - target.position.y;
    const dz = actor.position.z - target.position.z;
    const reach = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (reach > LIMITS.MAX_INTERACT_DISTANCE) {
      conn.send({ type: 'error', code: 'forbidden', message: `interact target is ${reach.toFixed(1)} units away (max ${LIMITS.MAX_INTERACT_DISTANCE})` });
      return;
    }
    // Ownership: a world-owned object (owner null) is free to interact with; an
    // object someone else owns is not.
    // games-c B1: WorldObject stores the owner as `owner` (set at place time);
    // the old owner_entity_id/owner_id reads never matched, so the check never fired.
    const owner = target.owner ?? null;
    if (owner && owner !== entity_id) {
      conn.send({ type: 'error', code: 'forbidden', message: 'that object belongs to another player' });
      return;
    }
    // P0: 'pickup' removes the object; other actions are world-defined (stub)
    if (frame.action === 'pickup') {
      this.objects.delete(target.entity_id);
      this.broadcast({ type: 'object', op: 'remove', entity_id: target.entity_id });
      this.emitC3({
        op: 'remove',
        session_id: this.session_id,
        world_id: this.world_id,
        actor_entity_id: entity_id,
        tick: this.tick,
        payload: { entity_id: target.entity_id },
        ts: new Date().toISOString(),
      });
    }
  }

  private handleInventory(entity_id: string, conn: ClientConn, frame: InventoryFrame) {
    // If no ownership store wired (P0 minimal / pre-CW5), reject gracefully.
    if (!this.ownership) {
      conn.send({ type: 'error', code: 'invalid', message: 'inventory not available (ownership store not wired)' });
      return;
    }
    const result = handleInventoryIntent({
      store: this.ownership,
      entity_id,
      session_id: this.session_id,
      world_id: this.world_id,
      tick: this.tick,
      intent: { action: frame.action, item_id: frame.item_id, slot: frame.slot },
    });
    if (!result.valid) {
      conn.send({ type: 'error', code: result.code || 'invalid', message: result.reason || 'invalid inventory action' });
      return;
    }
    // Broadcast the resulting inventory snapshot to the actor (out frame: inventory)
    conn.send({ type: 'inventory', entity_id, items: result.items || [] });
    // Persist via CW5 (C3 delta)
    if (result.delta) this.emitC3(result.delta);
  }

  private handleChat(entity_id: string, conn: ClientConn, frame: ChatFrame) {
    if (!this.rateLimiter.allow(`${entity_id}:chat`, LIMITS.CHAT_RATE_PER_SEC)) {
      conn.send({ type: 'error', code: 'rate_limit', message: 'chat rate exceeded' });
      return;
    }
    if (typeof frame.text !== 'string' || frame.text.length === 0 || frame.text.length > 500) {
      conn.send({ type: 'error', code: 'invalid', message: 'bad chat text' });
      return;
    }
    this.broadcast({
      type: 'chat',
      from_entity_id: entity_id,
      channel: frame.channel,
      text: frame.text,
      t: Date.now(),
    });
  }

  // ===== Tick loop =====

  private runTick() {
    this.tick++;
    const isKeyframe = this.tick % Session.KEYFRAME_EVERY_TICKS === 0;
    const players = Array.from(this.players.values());

    if (!Number.isFinite(Session.AOI_RADIUS)) {
      this.runTickGlobal(players, isKeyframe);
    } else {
      this.runTickAOI(players, isKeyframe);
    }
  }

  /** Global broadcast path (AOI off): one delta to everyone. */
  private runTickGlobal(players: PlayerState[], isKeyframe: boolean) {
    const currentIds = new Set(players.map((p) => p.entity_id));

    const changed: PlayerState[] = [];
    for (const p of players) {
      const ser = serializePlayer(p);
      if (isKeyframe || this.lastSent.get(p.entity_id) !== ser) changed.push(p);
      this.lastSent.set(p.entity_id, ser);
    }

    const removed: string[] = [];
    for (const id of this.lastSent.keys()) {
      if (!currentIds.has(id)) { removed.push(id); this.lastSent.delete(id); }
    }

    if (!isKeyframe && changed.length === 0 && removed.length === 0) return;

    this.broadcast({ type: 'state_delta', tick: this.tick, keyframe: isKeyframe, changed, removed });
  }

  /** AOI path (finite radius): each recipient gets only nearby entities. */
  private runTickAOI(players: PlayerState[], isKeyframe: boolean) {
    const r2 = Session.AOI_RADIUS * Session.AOI_RADIUS;
    const within = (a: Vec3, b: Vec3) => {
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      return dx * dx + dy * dy + dz * dz <= r2;
    };

    for (const recipient of players) {
      const conn = this.conns.get(recipient.entity_id);
      if (!conn) continue;

      let seen = this.aoiSeen.get(recipient.entity_id);
      if (!seen) { seen = new Map(); this.aoiSeen.set(recipient.entity_id, seen); }

      const changed: PlayerState[] = [];
      const visibleNow = new Set<string>();

      for (const subject of players) {
        // A player always sees themselves; otherwise must be within AOI.
        const visible = subject.entity_id === recipient.entity_id || within(recipient.position, subject.position);
        if (!visible) continue;
        visibleNow.add(subject.entity_id);
        const ser = serializePlayer(subject);
        if (isKeyframe || seen.get(subject.entity_id) !== ser) changed.push(subject);
        seen.set(subject.entity_id, ser);
      }

      // removed[] for this recipient = subjects they used to see but no longer do
      // (left session OR moved out of AOI).
      const removed: string[] = [];
      for (const subjId of seen.keys()) {
        if (!visibleNow.has(subjId)) { removed.push(subjId); seen.delete(subjId); }
      }

      if (!isKeyframe && changed.length === 0 && removed.length === 0) continue;
      conn.send({ type: 'state_delta', tick: this.tick, keyframe: isKeyframe, changed, removed });
    }
  }

  // ===== Helpers =====

  private broadcast(frame: OutboundFrame, excludeEntityId?: string) {
    for (const [eid, conn] of this.conns) {
      if (eid === excludeEntityId) continue;
      conn.send(frame);
    }
  }

  private emitC3(delta: C3Delta) {
    try {
      // Persistence needs the backend identity, not just the netcode entity id.
      const uid = this.conns.get(delta.actor_entity_id)?.user_id;
      this.c3Sink(uid && !delta.actor_user_id ? { ...delta, actor_user_id: uid } : delta);
    } catch (err) {
      // C3 emission failure must not crash the session; log + continue
      console.error(`[C3] emit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  snapshot(): WorldSnapshot {
    return {
      world_id: this.world_id,
      session_id: this.session_id,
      tick: this.tick,
      players: Array.from(this.players.values()),
      objects: Array.from(this.objects.values()),
    };
  }
}

export interface SessionManagerOptions {
  /** Server-wide max players per session (default Session.DEFAULT_MAX_PLAYERS = 16). */
  maxPlayersPerSession?: number;
  /** Max concurrent sessions (default 500). Creation beyond it throws SessionCapError. */
  maxSessions?: number;
  /** An empty session (no players, no reconnect holds) idle this long is closed (default 60s). */
  idleTtlMs?: number;
}

/**
 * Session manager: create/join/leave, invite codes.
 * Owns C4 routes: POST /sessions, POST /sessions/:id/invite
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private c3Sink: C3Sink;
  private ownership?: OwnershipStore;

  /** Server-wide ceiling on seats per session. */
  readonly maxPlayersPerSession: number;
  readonly maxSessions: number;
  readonly idleTtlMs: number;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  /** Sessions closed by GC since boot (diagnostics / /health). */
  gcClosed = 0;

  static DEFAULT_MAX_SESSIONS = 500;
  static DEFAULT_IDLE_TTL_MS = 60_000;

  constructor(c3Sink: C3Sink, ownership?: OwnershipStore, opts?: SessionManagerOptions) {
    this.c3Sink = c3Sink;
    this.ownership = ownership;
    const posInt = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : d);
    this.maxPlayersPerSession = posInt(opts?.maxPlayersPerSession, Session.DEFAULT_MAX_PLAYERS);
    this.maxSessions = posInt(opts?.maxSessions, SessionManager.DEFAULT_MAX_SESSIONS);
    this.idleTtlMs = typeof opts?.idleTtlMs === 'number' && opts.idleTtlMs >= 0 ? opts.idleTtlMs : SessionManager.DEFAULT_IDLE_TTL_MS;
  }

  /**
   * Close every session that is empty (no players, no reconnect holds) and has
   * been idle for idleTtlMs. Returns the closed ids. A freshly POSTed session
   * nobody joins is empty from birth, so it is reclaimed after idleTtlMs too.
   */
  sweep(now: number = Date.now()): string[] {
    const closed: string[] = [];
    for (const [id, s] of this.sessions) {
      if (s.isEmpty && now - s.lastActivityAt >= this.idleTtlMs) {
        this.closeSession(id);
        closed.push(id);
      }
    }
    this.gcClosed += closed.length;
    return closed;
  }

  /** Run sweep() every intervalMs. The timer is unref'd: it never holds the process open. */
  startGc(intervalMs: number) {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.sweep(), Math.max(10, intervalMs));
    if (typeof (this.gcTimer as any).unref === 'function') (this.gcTimer as any).unref();
  }

  stopGc() {
    if (this.gcTimer) { clearInterval(this.gcTimer); this.gcTimer = null; }
  }

  /** Stop GC and close every session (shutdown / tests). */
  closeAll() {
    this.stopGc();
    for (const id of Array.from(this.sessions.keys())) this.closeSession(id);
  }

  createSession(world_id: string, opts?: SessionOptions): Session {
    if (!isValidWorldId(world_id)) throw new Error(`invalid world_id: ${String(world_id).slice(0, 64)}`);
    if (this.sessions.size >= this.maxSessions) {
      this.sweep(); // reclaim idle sessions before refusing
      if (this.sessions.size >= this.maxSessions) throw new SessionCapError(`session cap reached (${this.maxSessions})`);
    }
    // A per-session cap may lower the server's cap, never raise it.
    const cap = this.maxPlayersPerSession;
    const requested = opts?.maxPlayers;
    const maxPlayers = Number.isInteger(requested) && (requested as number) >= 1 ? Math.min(requested as number, cap) : cap;
    const spawns = sanitizeSpawnPoints(opts?.spawnPoints);
    if (!spawns.ok) throw new Error(`invalid spawn points: ${spawns.error}`);
    const session = new Session(world_id, this.c3Sink, undefined, this.ownership, { ...opts, maxPlayers, spawnPoints: spawns.points });
    this.sessions.set(session.session_id, session);
    session.start();
    return session;
  }

  getSession(session_id: string): Session | null {
    return this.sessions.get(session_id) || null;
  }

  closeSession(session_id: string) {
    const session = this.sessions.get(session_id);
    if (session) {
      session.stop();
      this.sessions.delete(session_id);
    }
  }

  get activeSessionCount() {
    return this.sessions.size;
  }

  sessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }
}
