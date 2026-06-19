// src/inventory.ts
// DCS Games CW4 Netcode — Inventory Handler (M-P2/M-P3)
//
// Per Round-3 order: "coordinate the inventory handler with CW5's ownership store."
// The Day0 bundle (with CW5's canonical ownership shape) did NOT arrive in-session,
// so — same pattern as TokenVerifier (CW1) and FriendListProvider (CW1 social graph) —
// CW4 defines the SEAM it needs from CW5 and implements against it. When CW5's real
// ownership-store contract lands, this is a one-adapter swap, not a rewrite.
//
// CW4 owns: the netcode validation + broadcast of inventory INTENTS.
// CW5 owns: the authoritative ownership/persistence (who owns what, durably).
// Boundary: CW4 validates the move is legal + broadcasts; CW5 is the source of truth
// for ownership and receives a C3 delta to persist.

import { C3Delta } from './types.js';

/**
 * The ownership-store seam CW4 needs from CW5.
 * CW5 implements this (or an adapter to its real store). CW4 only consumes it.
 *
 * RECONCILE: when _SHARED_Day0/_frozen_lane_contracts/CW5 ownership contract lands,
 * map these methods onto CW5's canonical shape. The method *contract* (does the actor
 * own this item? what's in their inventory?) is the stable part.
 */
export interface OwnershipStore {
  /** Does this entity currently own this item? (authoritative read) */
  owns(entity_id: string, item_id: string): boolean;
  /** Current inventory for an entity: items + slots. */
  getInventory(entity_id: string): InventoryItem[];
  /** Is the target slot free for an equip/move? */
  slotFree(entity_id: string, slot: number): boolean;
}

export interface InventoryItem {
  item_id: string;
  slot: number;
  qty: number;
}

export type InventoryAction = 'equip' | 'drop' | 'move';

export interface InventoryIntent {
  action: InventoryAction;
  item_id: string;
  slot?: number;
}

export interface InventoryResult {
  valid: boolean;
  code?: 'invalid' | 'forbidden' | 'not_found';
  reason?: string;
  // The resulting inventory snapshot to broadcast back (out frame: inventory)
  items?: InventoryItem[];
  // The C3 delta to persist via CW5 (null if rejected)
  delta?: C3Delta | null;
}

const MAX_SLOTS = 36; // P0 inventory size; tune later

/**
 * Validate + resolve an inventory intent against CW5's ownership store.
 * CW4 does NOT mutate ownership itself — it validates, emits a C3 delta for CW5
 * to persist, and returns the snapshot to broadcast. CW5 remains authoritative.
 */
export function handleInventoryIntent(params: {
  store: OwnershipStore;
  entity_id: string;
  session_id: string;
  world_id: string;
  tick: number;
  intent: InventoryIntent;
}): InventoryResult {
  const { store, entity_id, session_id, world_id, tick, intent } = params;

  // 1. Ownership check — you can only act on items you own (anti-cheat day one)
  if (!store.owns(entity_id, intent.item_id)) {
    return { valid: false, code: 'forbidden', reason: 'actor does not own item', delta: null };
  }

  // 2. Action-specific validation
  if (intent.action === 'equip' || intent.action === 'move') {
    if (typeof intent.slot !== 'number' || intent.slot < 0 || intent.slot >= MAX_SLOTS) {
      return { valid: false, code: 'invalid', reason: 'bad slot', delta: null };
    }
    if (!store.slotFree(entity_id, intent.slot)) {
      return { valid: false, code: 'invalid', reason: 'slot occupied', delta: null };
    }
  }
  // 'drop' has no slot requirement

  // 3. Build the C3 delta for CW5 to persist (CW5 = source of truth)
  const delta: C3Delta = {
    op: 'inventory',
    session_id,
    world_id,
    actor_entity_id: entity_id,
    tick,
    payload: {
      action: intent.action,
      item_id: intent.item_id,
      slot: intent.slot ?? null,
    },
    ts: new Date().toISOString(),
  };

  // 4. Resulting snapshot to broadcast (read post-intent view from store).
  //    NOTE: CW5 applies the authoritative mutation from the C3 delta; the snapshot
  //    here is CW4's optimistic view for the immediate broadcast. CW5's persisted
  //    state is canonical and reconciles on next read.
  const items = store.getInventory(entity_id);

  return { valid: true, items, delta };
}

/**
 * In-memory ownership store for P0/headless tests + the mock server.
 * SWAP for CW5's real store when the ownership contract lands.
 */
export class MockOwnershipStore implements OwnershipStore {
  // entity_id -> item_id -> InventoryItem
  private inv: Map<string, Map<string, InventoryItem>> = new Map();

  grant(entity_id: string, item: InventoryItem) {
    if (!this.inv.has(entity_id)) this.inv.set(entity_id, new Map());
    this.inv.get(entity_id)!.set(item.item_id, item);
  }

  owns(entity_id: string, item_id: string): boolean {
    return this.inv.get(entity_id)?.has(item_id) ?? false;
  }

  getInventory(entity_id: string): InventoryItem[] {
    return Array.from(this.inv.get(entity_id)?.values() ?? []);
  }

  slotFree(entity_id: string, slot: number): boolean {
    const items = this.getInventory(entity_id);
    return !items.some((i) => i.slot === slot);
  }
}
