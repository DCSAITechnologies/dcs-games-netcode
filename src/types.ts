// src/types.ts
// DCS Games CW4 Netcode — Core Types
// Reconcile against _SHARED_Day0/contracts/netcode-protocol.json when bundle lands

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Look {
  yaw: number;
  pitch: number;
}

// ===== INBOUND FRAMES (client → server intents) =====

export interface JoinFrame {
  type: 'join';
  token: string; // CW1 auth token
  world_id: string;
  session_id?: string; // optional: join existing
}

export interface InputFrame {
  type: 'input';
  seq: number; // client sequence for reconciliation
  move: Vec3;
  look: Look;
  dt: number; // client frame delta
}

export interface InteractFrame {
  type: 'interact';
  target_entity_id: string;
  action: string; // use|open|pickup
}

export interface PlaceFrame {
  type: 'place';
  object_type: string;
  position: Vec3;
  rotation: { yaw: number };
}

export interface InventoryFrame {
  type: 'inventory';
  action: 'equip' | 'drop' | 'move';
  item_id: string;
  slot?: number;
}

export interface ChatFrame {
  type: 'chat';
  channel: 'session' | 'party';
  text: string;
}

export interface PingFrame {
  type: 'ping';
  t: number;
}

// Party frames (M-P1 over the wire). These are pre-session control frames:
// a client may send them before joining a game session.
export interface PartyCreateFrame {
  type: 'party_create';
  token: string; // CW1 auth (party ops need identity)
  world_id: string;
}

export interface PartyJoinFrame {
  type: 'party_join';
  token: string;
  invite_code: string;
}

export interface PartyLaunchFrame {
  type: 'party_launch';
  token: string;
  party_id: string;
}

export interface PartyLeaveFrame {
  type: 'party_leave';
  token: string;
  party_id: string;
}

export type PartyFrame =
  | PartyCreateFrame
  | PartyJoinFrame
  | PartyLaunchFrame
  | PartyLeaveFrame;

export type InboundFrame =
  | JoinFrame
  | InputFrame
  | InteractFrame
  | PlaceFrame
  | InventoryFrame
  | ChatFrame
  | PingFrame
  | PartyFrame;

// ===== OUTBOUND FRAMES (server → client) =====

export interface PlayerState {
  entity_id: string;
  position: Vec3;
  look: Look;
  vel: Vec3;
  health: number;
  // Reconciliation: the last client input `seq` the server has applied for THIS
  // player. The owning client replays any inputs after this seq on top of the
  // authoritative position (client-side prediction + reconciliation).
  last_ack_seq?: number;
}

export interface JoinedFrame {
  type: 'joined';
  session_id: string;
  your_entity_id: string;
  snapshot: WorldSnapshot;
}

export interface StateFrame {
  type: 'state';
  tick: number;
  players: PlayerState[];
}

// Bandwidth-optimized state delta: only players whose state changed since the
// last broadcast, plus ids that left. `keyframe:true` means full state (sent
// periodically + on join) so clients can resync. Mobile-first: a still player
// costs ~0 bytes/tick instead of a full PlayerState 15x/sec.
export interface StateDeltaFrame {
  type: 'state_delta';
  tick: number;
  keyframe: boolean;
  changed: PlayerState[]; // players whose state changed (or all, if keyframe)
  removed: string[];      // entity_ids no longer present
}

export interface SpawnFrame {
  type: 'spawn';
  entity_id: string;
  entity_type: string;
  position: Vec3;
  owner?: string;
}

export interface DespawnFrame {
  type: 'despawn';
  entity_id: string;
}

export interface ObjectFrame {
  type: 'object';
  op: 'place' | 'remove' | 'mutate';
  entity_id: string;
  object_type?: string;
  position?: Vec3;
  rotation?: { yaw: number };
}

export interface InventoryOutFrame {
  type: 'inventory';
  entity_id: string;
  items: { item_id: string; slot: number; qty: number }[];
}

export interface ChatOutFrame {
  type: 'chat';
  from_entity_id: string;
  channel: string;
  text: string;
  t: number;
}

export interface ErrorFrame {
  type: 'error';
  // session_full: join beyond the session's max_players.
  // world_mismatch: join names a world_id other than the session's.
  // capacity: the server is at its session cap and cannot create another.
  code: 'auth' | 'invalid' | 'rate_limit' | 'not_found' | 'forbidden' | 'session_full' | 'world_mismatch' | 'capacity';
  message: string;
  ref_seq?: number;
}

export interface PongFrame {
  type: 'pong';
  t: number;
  server_t: number;
}

// Party state pushed to clients after any party op (create/join/launch/leave).
export interface PartyStateFrame {
  type: 'party_state';
  party_id: string;
  leader_user_id: string;
  member_user_ids: string[];
  world_id: string;
  invite_code: string;
  session_id: string | null; // set once launched (clients then `join` it)
  launched: boolean;
}

export type OutboundFrame =
  | JoinedFrame
  | StateFrame
  | StateDeltaFrame
  | SpawnFrame
  | DespawnFrame
  | ObjectFrame
  | InventoryOutFrame
  | ChatOutFrame
  | ErrorFrame
  | PongFrame
  | PartyStateFrame;

// ===== WORLD STATE =====

export interface WorldObject {
  entity_id: string;
  object_type: string;
  position: Vec3;
  rotation: { yaw: number };
  owner: string;
  placed_tick: number;
}

export interface WorldSnapshot {
  world_id: string;
  session_id: string;
  tick: number;
  players: PlayerState[];
  objects: WorldObject[];
}

// ===== C3 SAVE-DELTA (emitted to CW5 on every validated mutation) =====

export interface C3Delta {
  op: 'place' | 'remove' | 'mutate' | 'inventory';
  session_id: string;
  world_id: string;
  actor_entity_id: string;
  /** Verified user id (token `sub`) of the actor — what the backend keys ownership on. */
  actor_user_id?: string;
  tick: number;
  payload: Record<string, unknown>;
  ts: string; // ISO
}
