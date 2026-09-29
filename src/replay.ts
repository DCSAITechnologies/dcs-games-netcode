// src/replay.ts
// DCS Games CW4 Netcode — persistence replay.
//
// The backend keeps every delta this server emitted (POST /persistence/delta).
// When a session for a world is created, its persisted state is replayed:
//
//   GET <base><path>/replay?world_id=<id>&since=<seq>&limit=<n>
//   Authorization: Bearer <service token>
//   → 200 { ok, world_id, deltas: [{ seq, delta_id, op, actor_user_id?, payload, ... }], next_since, complete }
//
// Pages are followed until `complete`, a page cap or the delta cap. The deltas
// are folded into a ReplayState (objects still standing + per-user
// inventories) that Session.applyReplay() installs without re-emitting them.
//
// Config (env): the same base/path/token as the delta sink —
//   NETCODE_PERSISTENCE_URL / _PATH / _TOKEN, plus
//   NETCODE_REPLAY_MAX_DELTAS (default 20000), NETCODE_REPLAY_TIMEOUT_MS (default 5000).
// With no URL, replay is a no-op: sessions start empty.

import type { Vec3 } from './types.js';
import type { InventoryItem } from './inventory.js';
import { INVENTORY_MAX_SLOTS } from './inventory.js';
import { intEnv } from './config.js';
import { isValidWorldId } from './validation.js';

export interface ReplayObject {
  entity_id: string;
  object_type: string;
  position: Vec3;
  rotation: { yaw: number };
  owner_user_id: string | null;
}

export interface ReplayState {
  objects: ReplayObject[];
  /** Ids removed by the log that were not placed by it (objects from the base world). */
  removed: string[];
  inventories: Map<string, InventoryItem[]>;
  /** Deltas read and folded. */
  applied: number;
  /** Deltas skipped as malformed. */
  skipped: number;
}

export interface PersistedDelta {
  seq?: number;
  delta_id?: string;
  op?: string;
  actor_user_id?: string;
  payload?: Record<string, unknown>;
}

export const MAX_REPLAY_OBJECTS = 10_000;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isVec3 = (v: unknown): v is Vec3 =>
  isObj(v) && ['x', 'y', 'z'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k] as number));
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** Fold an ordered delta log into the state it describes. Pure; never throws. */
export function foldDeltas(deltas: PersistedDelta[]): ReplayState {
  const objects = new Map<string, ReplayObject>();
  const removed = new Set<string>();
  const inv = new Map<string, Map<string, InventoryItem>>();
  let applied = 0, skipped = 0;
  for (const d of deltas) {
    const p = isObj(d?.payload) ? d.payload : null;
    if (!p) { skipped++; continue; }
    const user = isId(d.actor_user_id) ? d.actor_user_id : null;
    if (d.op === 'place') {
      if (!isId(p.entity_id) || !isId(p.object_type) || !isVec3(p.position) || !isObj(p.rotation) || typeof p.rotation.yaw !== 'number') { skipped++; continue; }
      if (objects.size >= MAX_REPLAY_OBJECTS && !objects.has(p.entity_id)) { skipped++; continue; }
      objects.set(p.entity_id, {
        entity_id: p.entity_id,
        object_type: p.object_type,
        position: { x: p.position.x, y: p.position.y, z: p.position.z },
        rotation: { yaw: p.rotation.yaw as number },
        owner_user_id: user,
      });
      removed.delete(p.entity_id);
    } else if (d.op === 'remove') {
      if (!isId(p.entity_id)) { skipped++; continue; }
      if (!objects.delete(p.entity_id)) removed.add(p.entity_id);
    } else if (d.op === 'inventory') {
      if (!user || !isId(p.item_id)) { skipped++; continue; }
      let items = inv.get(user);
      if (!items) { items = new Map(); inv.set(user, items); }
      const slot = p.slot;
      const okSlot = Number.isInteger(slot) && (slot as number) >= 0 && (slot as number) < INVENTORY_MAX_SLOTS;
      if (p.action === 'grant') {
        if (!okSlot) { skipped++; continue; }
        items.set(p.item_id, { item_id: p.item_id, slot: slot as number, qty: 1 });
      } else if (p.action === 'equip' || p.action === 'move') {
        const it = items.get(p.item_id);
        if (!it || !okSlot) { skipped++; continue; }
        it.slot = slot as number;
      } else if (p.action === 'drop') {
        items.delete(p.item_id);
      } else { skipped++; continue; }
    } else { skipped++; continue; }
    applied++;
  }
  const inventories = new Map<string, InventoryItem[]>();
  for (const [u, m] of inv) if (m.size > 0) inventories.set(u, Array.from(m.values()));
  return { objects: Array.from(objects.values()), removed: Array.from(removed), inventories, applied, skipped };
}

export interface ReplaySource {
  readonly mode: 'live' | 'noop';
  /** Resolves the folded state for a world. Never rejects: a failure resolves ok:false. */
  load(world_id: string): Promise<{ ok: true; state: ReplayState } | { ok: false; error: string }>;
}

export class NoopReplaySource implements ReplaySource {
  readonly mode = 'noop' as const;
  async load(): Promise<{ ok: true; state: ReplayState }> {
    return { ok: true, state: foldDeltas([]) };
  }
}

export interface HttpReplaySourceOptions {
  baseUrl: string;
  path?: string;
  token?: string;
  maxDeltas?: number;
  pageLimit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpReplaySource implements ReplaySource {
  readonly mode = 'live' as const;
  private url: string;
  private token?: string;
  private maxDeltas: number;
  private pageLimit: number;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(o: HttpReplaySourceOptions) {
    this.url = o.baseUrl.replace(/\/+$/, '') + (o.path || '/persistence/delta') + '/replay';
    this.token = o.token;
    this.maxDeltas = o.maxDeltas ?? 20_000;
    this.pageLimit = o.pageLimit ?? 1000;
    this.timeoutMs = o.timeoutMs ?? 5000;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async load(world_id: string): Promise<{ ok: true; state: ReplayState } | { ok: false; error: string }> {
    if (!isValidWorldId(world_id)) return { ok: false, error: 'invalid world_id' };
    const all: PersistedDelta[] = [];
    let since = 0;
    const deadline = Date.now() + this.timeoutMs;
    for (let page = 0; page < 1000; page++) {
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, error: 'replay timed out' };
      const q = new URLSearchParams({ world_id, since: String(since), limit: String(this.pageLimit) });
      let body: any;
      try {
        const res = await this.fetchImpl(`${this.url}?${q}`, {
          headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
          signal: AbortSignal.timeout(left),
        });
        if (!res.ok) return { ok: false, error: `replay HTTP ${res.status}` };
        body = await res.json();
      } catch (err) {
        return { ok: false, error: `replay failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const deltas = Array.isArray(body?.deltas) ? body.deltas : null;
      if (!deltas) return { ok: false, error: 'replay response has no deltas[]' };
      for (const d of deltas) {
        if (all.length >= this.maxDeltas) return { ok: false, error: `replay log exceeds ${this.maxDeltas} deltas` };
        all.push(d);
      }
      const next = Number(body?.next_since);
      if (body?.complete === true || deltas.length === 0) return { ok: true, state: foldDeltas(all) };
      if (!Number.isInteger(next) || next <= since) return { ok: false, error: 'replay cursor did not advance' };
      since = next;
    }
    return { ok: false, error: 'replay page cap reached' };
  }
}

export function replaySourceFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): ReplaySource {
  const baseUrl = (env.NETCODE_PERSISTENCE_URL || env.CW5_PERSISTENCE_URL || '').trim();
  if (!baseUrl) return new NoopReplaySource();
  return new HttpReplaySource({
    baseUrl,
    path: env.NETCODE_PERSISTENCE_PATH || env.CW5_INGEST_PATH || '/persistence/delta',
    token: env.NETCODE_PERSISTENCE_TOKEN || env.CW5_PERSISTENCE_TOKEN || undefined,
    maxDeltas: intEnv(env.NETCODE_REPLAY_MAX_DELTAS, 20_000, 1, 1_000_000),
    timeoutMs: intEnv(env.NETCODE_REPLAY_TIMEOUT_MS, 5000, 100, 60_000),
    fetchImpl,
  });
}
