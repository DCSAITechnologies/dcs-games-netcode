// bots/headless-bot.ts
// DCS Games CW4 Netcode — Headless Bot Client
// Drives the gateway with no UI dependency (per spec: "test with a headless bot client
// so you never wait on CW3"). Uses an in-memory transport — no real socket needed.

import { Gateway, Transport } from '../src/gateway';
import {
  InboundFrame,
  OutboundFrame,
  Vec3,
  WorldSnapshot,
  PlayerState,
} from '../src/types';

/**
 * A headless bot: connects through an in-memory transport, sends intents,
 * and records everything the server sends back so tests can assert on it.
 */
export class HeadlessBot {
  readonly name: string;
  private gateway: Gateway;
  private transport: Transport;
  private closed = false;

  // Recorded server state
  public entity_id: string | null = null;
  public session_id: string | null = null;
  public snapshot: WorldSnapshot | null = null;
  public received: OutboundFrame[] = [];
  public lastError: string | null = null;
  public lastPartyState: any = null;
  /** Optional raw-frame hook for tests that need to inspect every server frame. */
  public onMessageRaw: ((f: OutboundFrame) => void) | null = null;

  // Observed world (built from server frames — the bot's view, not the server's truth)
  public observedObjects: Map<string, { object_type: string; position: Vec3 }> = new Map();
  public observedPlayers: Map<string, PlayerState> = new Map();
  public lastStateTick = 0;

  constructor(name: string, gateway: Gateway) {
    this.name = name;
    this.gateway = gateway;
    this.transport = {
      send: (frame) => this.onServerFrame(frame),
      close: () => {
        this.closed = true;
      },
    };
  }

  /** Server → bot. The bot interprets frames to build its observed view. */
  private onServerFrame(frame: OutboundFrame) {
    this.received.push(frame);
    if (this.onMessageRaw) this.onMessageRaw(frame);
    switch (frame.type) {
      case 'joined':
        this.entity_id = frame.your_entity_id;
        this.session_id = frame.session_id;
        this.snapshot = frame.snapshot;
        // Seed observed world from snapshot
        for (const obj of frame.snapshot.objects) {
          this.observedObjects.set(obj.entity_id, {
            object_type: obj.object_type,
            position: obj.position,
          });
        }
        for (const p of frame.snapshot.players) {
          this.observedPlayers.set(p.entity_id, p);
        }
        break;
      case 'state':
        this.lastStateTick = frame.tick;
        for (const p of frame.players) {
          this.observedPlayers.set(p.entity_id, p);
        }
        break;
      case 'state_delta':
        this.lastStateTick = frame.tick;
        for (const p of frame.changed) {
          this.observedPlayers.set(p.entity_id, p);
        }
        for (const id of frame.removed) {
          this.observedPlayers.delete(id);
        }
        break;
      case 'object':
        if (frame.op === 'place' && frame.position && frame.object_type) {
          this.observedObjects.set(frame.entity_id, {
            object_type: frame.object_type,
            position: frame.position,
          });
        } else if (frame.op === 'remove') {
          this.observedObjects.delete(frame.entity_id);
        }
        break;
      case 'spawn':
        if (frame.entity_type === 'player') {
          this.observedPlayers.set(frame.entity_id, {
            entity_id: frame.entity_id,
            position: frame.position,
            look: { yaw: 0, pitch: 0 },
            vel: { x: 0, y: 0, z: 0 },
            health: 100,
          });
        }
        break;
      case 'despawn':
        this.observedPlayers.delete(frame.entity_id);
        break;
      case 'error':
        this.lastError = `${frame.code}: ${frame.message}`;
        break;
      case 'party_state':
        this.lastPartyState = frame;
        break;
    }
  }

  /** Bot → server (through gateway). */
  private send(frame: InboundFrame) {
    if (this.closed) return;
    this.gateway.handleFrame(this.transport, frame);
  }

  // ===== Bot actions =====

  join(token: string, world_id: string, session_id?: string) {
    this.send({ type: 'join', token, world_id, session_id });
  }

  move(delta: Vec3, dt = 1 / 15, seq = 0) {
    this.send({
      type: 'input',
      seq,
      move: delta,
      look: { yaw: 0, pitch: 0 },
      dt,
    });
  }

  place(object_type: string, position: Vec3, yaw = 0) {
    this.send({ type: 'place', object_type, position, rotation: { yaw } });
  }

  pickup(target_entity_id: string) {
    this.send({ type: 'interact', target_entity_id, action: 'pickup' });
  }

  inventory(action: 'equip' | 'drop' | 'move', item_id: string, slot) {
    this.send({ type: 'inventory', action, item_id, slot });
  }

  chat(text: string, channel: 'session' | 'party' = 'session') {
    this.send({ type: 'chat', channel, text });
  }

  ping() {
    this.send({ type: 'ping', t: Date.now() });
  }

  // Party control (over the wire)
  partyCreate(token: string, world_id: string) {
    this.send({ type: 'party_create', token, world_id });
  }
  partyJoin(token: string, invite_code: string) {
    this.send({ type: 'party_join', token, invite_code });
  }
  partyLaunch(token: string, party_id: string) {
    this.send({ type: 'party_launch', token, party_id });
  }
  partyLeave(token: string, party_id: string) {
    this.send({ type: 'party_leave', token, party_id });
  }

  disconnect() {
    this.gateway.handleDisconnect(this.transport);
    this.closed = true;
  }

  // ===== Assertions helpers =====

  /** Does the bot observe an object of this type near this position? */
  seesObjectAt(object_type: string, position: Vec3, tolerance = 0.01): boolean {
    for (const obj of this.observedObjects.values()) {
      if (obj.object_type !== object_type) continue;
      const d =
        Math.abs(obj.position.x - position.x) +
        Math.abs(obj.position.y - position.y) +
        Math.abs(obj.position.z - position.z);
      if (d <= tolerance) return true;
    }
    return false;
  }
}
