// src/gateway.ts
// DCS Games CW4 Netcode — Connection Gateway + Auth Handshake
// Validates CW1 token on join, routes frames to the right session.
// Transport-agnostic: a real WS server or the headless bot harness both drive this.

import crypto from 'node:crypto';
import {
  JoinFrame,
  InboundFrame,
  OutboundFrame,
  PartyCreateFrame,
  PartyJoinFrame,
  PartyLaunchFrame,
  PartyLeaveFrame,
} from './types.js';
import { Session, SessionManager, ClientConn } from './session.js';

/**
 * CW1 token verifier. In production this calls CW1's identity service.
 * For P0/headless test, inject a mock that accepts well-formed tokens.
 */
export type TokenVerifier = (token: string) => { valid: boolean; user_id?: string };

/**
 * A raw transport connection (before it's bound to a session entity).
 * send() pushes a frame to the client; the gateway wires this into ClientConn.
 */
export interface Transport {
  send(frame: OutboundFrame): void;
  close(): void;
}

export class Gateway {
  private sessionManager: SessionManager;
  private verifyToken: TokenVerifier;
  // Map transport → its bound session + entity (post-join)
  private bound: Map<Transport, { session: Session; entity_id: string; user_id: string }> = new Map();
  // Optional M-P1 services (backward-compatible: may be undefined for P0 tests)
  private presence?: import('./presence.js').PresenceService;
  private party?: import('./party.js').PartyManager;

  constructor(
    sessionManager: SessionManager,
    verifyToken: TokenVerifier,
    opts?: {
      presence?: import('./presence.js').PresenceService;
      party?: import('./party.js').PartyManager;
    }
  ) {
    this.sessionManager = sessionManager;
    this.verifyToken = verifyToken;
    this.presence = opts?.presence;
    this.party = opts?.party;
  }

  /**
   * Handle an inbound frame from a transport.
   * The first frame MUST be a join (auth handshake). Subsequent frames route to the session.
   */
  handleFrame(transport: Transport, frame: InboundFrame): void {
    // Party control frames are pre-session — handle them regardless of bound state.
    if (
      frame.type === 'party_create' ||
      frame.type === 'party_join' ||
      frame.type === 'party_launch' ||
      frame.type === 'party_leave'
    ) {
      this.handlePartyFrame(transport, frame);
      return;
    }

    const binding = this.bound.get(transport);

    if (!binding) {
      // Not yet joined — only 'join' is allowed
      if (frame.type !== 'join') {
        transport.send({ type: 'error', code: 'forbidden', message: 'must join first' });
        return;
      }
      this.handleJoin(transport, frame);
      return;
    }

    // Already joined — route to session
    binding.session.handleFrame(binding.entity_id, frame);
  }

  private handleJoin(transport: Transport, frame: JoinFrame): void {
    // 1. Auth handshake (CW1 token)
    const auth = this.verifyToken(frame.token);
    if (!auth.valid) {
      transport.send({ type: 'error', code: 'auth', message: 'invalid token' });
      transport.close();
      return;
    }

    // 2. Resolve or create session
    //    M-P1: if the user is in a launched party, route them to the party's session
    //    (group spawn) — overrides any session_id the client sent.
    let session: Session | null;
    const partySessionId = this.party?.resolveSessionForMember(auth.user_id!);
    const targetSessionId = partySessionId || frame.session_id;

    if (targetSessionId) {
      session = this.sessionManager.getSession(targetSessionId);
      if (!session) {
        transport.send({ type: 'error', code: 'not_found', message: 'session not found' });
        return;
      }
    } else {
      session = this.sessionManager.createSession(frame.world_id);
    }

    // 3. Allocate stable entity id (deterministic from user_id + session)
    const entity_id = `e_${crypto
      .createHash('sha256')
      .update(`${auth.user_id}:${session.session_id}`)
      .digest('hex')
      .slice(0, 12)}`;

    // 4. Wire transport into a ClientConn
    const conn: ClientConn = {
      entity_id,
      send: (f) => transport.send(f),
    };

    // 5. Join the session, get the full snapshot
    const snapshot = session.join(conn);
    this.bound.set(transport, { session, entity_id, user_id: auth.user_id! });

    // 5b. M-P1: mark presence (feeds CW6 discovery + CW7 trust)
    this.presence?.setOnline({
      user_id: auth.user_id!,
      entity_id,
      session_id: session.session_id,
      world_id: session.world_id,
      since: new Date().toISOString(),
    });

    // 6. Send joined frame with snapshot
    transport.send({
      type: 'joined',
      session_id: session.session_id,
      your_entity_id: entity_id,
      snapshot,
    });
  }

  /**
   * Handle party control frames (create/join/launch/leave) over the wire.
   * Requires the party manager to be wired (opts.party). All ops are auth-gated.
   */
  private handlePartyFrame(
    transport: Transport,
    frame: PartyCreateFrame | PartyJoinFrame | PartyLaunchFrame | PartyLeaveFrame
  ): void {
    if (!this.party) {
      transport.send({ type: 'error', code: 'invalid', message: 'party service not available' });
      return;
    }
    const auth = this.verifyToken(frame.token);
    if (!auth.valid) {
      transport.send({ type: 'error', code: 'auth', message: 'invalid token' });
      return;
    }
    const user_id = auth.user_id!;

    switch (frame.type) {
      case 'party_create': {
        const party = this.party.createParty(user_id, frame.world_id);
        this.pushPartyState(transport, party.party_id);
        break;
      }
      case 'party_join': {
        const res = this.party.joinParty(frame.invite_code, user_id);
        if (!res.ok) {
          transport.send({ type: 'error', code: 'invalid', message: res.error || 'join failed' });
          return;
        }
        this.pushPartyState(transport, res.party!.party_id);
        break;
      }
      case 'party_launch': {
        // Create the session the party will group-spawn into, then launch.
        const party = this.party.getParty(frame.party_id);
        if (!party) {
          transport.send({ type: 'error', code: 'not_found', message: 'party not found' });
          return;
        }
        if (party.leader_user_id !== user_id) {
          transport.send({ type: 'error', code: 'forbidden', message: 'only leader can launch' });
          return;
        }
        const session = this.sessionManager.createSession(party.world_id);
        const res = this.party.launchParty(frame.party_id, session.session_id);
        if (!res.ok) {
          transport.send({ type: 'error', code: 'invalid', message: res.error || 'launch failed' });
          return;
        }
        this.pushPartyState(transport, frame.party_id);
        break;
      }
      case 'party_leave': {
        this.party.leaveParty(frame.party_id, user_id);
        // Party may be disbanded (leader left) — push state if it still exists.
        const party = this.party.getParty(frame.party_id);
        if (party) this.pushPartyState(transport, frame.party_id);
        else transport.send({
          type: 'party_state', party_id: frame.party_id, leader_user_id: '', member_user_ids: [],
          world_id: '', invite_code: '', session_id: null, launched: false,
        });
        break;
      }
    }
  }

  private pushPartyState(transport: Transport, party_id: string): void {
    const party = this.party!.getParty(party_id);
    if (!party) return;
    transport.send({
      type: 'party_state',
      party_id: party.party_id,
      leader_user_id: party.leader_user_id,
      member_user_ids: party.member_user_ids,
      world_id: party.world_id,
      invite_code: party.invite_code,
      session_id: party.session_id,
      launched: party.launched_at !== null,
    });
  }

  /**
   * Handle a transport disconnect.
   */
  handleDisconnect(transport: Transport): void {
    const binding = this.bound.get(transport);
    if (binding) {
      binding.session.leave(binding.entity_id);
      this.presence?.setOffline(binding.user_id);
      this.bound.delete(transport);
    }
  }
}

/**
 * Default mock token verifier for P0/headless testing.
 * Accepts tokens of the form "tok:<user_id>"; rejects everything else.
 * Replace with a real CW1 call when identity service is live.
 */
export const mockTokenVerifier: TokenVerifier = (token: string) => {
  if (typeof token === 'string' && token.startsWith('tok:')) {
    const user_id = token.slice(4);
    if (user_id.length > 0) return { valid: true, user_id };
  }
  return { valid: false };
};
