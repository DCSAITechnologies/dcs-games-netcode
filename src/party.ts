// src/party.ts
// DCS Games CW4 Netcode — Party Manager (M-P1)
// A party is a group of users who spawn into the SAME session together.
// Flow: leader creates party -> invites friends -> party "launches" -> all members
// are routed to one freshly-created session (group spawn).

import crypto from 'node:crypto';

export interface Party {
  party_id: string;
  leader_user_id: string;
  member_user_ids: string[]; // includes leader
  world_id: string;
  invite_code: string;
  session_id: string | null; // set when launched
  created_at: string;
  launched_at: string | null;
  max_size: number;
}

export class PartyManager {
  private parties: Map<string, Party> = new Map();
  private byInvite: Map<string, string> = new Map(); // invite_code -> party_id
  private readonly maxPartySize: number;

  constructor(maxPartySize = 4) {
    // Horror co-op genre norm = 4 (matches the UGC CW5 crew-cap ruling spirit;
    // for DCS Games P1 we cap parties at 4, scale later with load tests).
    this.maxPartySize = maxPartySize;
  }

  /** Leader creates a party for a world. */
  createParty(leader_user_id: string, world_id: string): Party {
    const party_id = crypto.randomUUID();
    const invite_code = crypto.randomBytes(4).toString('hex');
    const party: Party = {
      party_id,
      leader_user_id,
      member_user_ids: [leader_user_id],
      world_id,
      invite_code,
      session_id: null,
      created_at: new Date().toISOString(),
      launched_at: null,
      max_size: this.maxPartySize,
    };
    this.parties.set(party_id, party);
    this.byInvite.set(invite_code, party_id);
    return party;
  }

  /** A user joins a party via invite code. */
  joinParty(invite_code: string, user_id: string): { ok: boolean; party?: Party; error?: string } {
    const party_id = this.byInvite.get(invite_code);
    if (!party_id) return { ok: false, error: 'invalid invite code' };
    const party = this.parties.get(party_id);
    if (!party) return { ok: false, error: 'party not found' };
    if (party.launched_at) return { ok: false, error: 'party already launched' };
    if (party.member_user_ids.includes(user_id)) return { ok: true, party }; // idempotent
    if (party.member_user_ids.length >= party.max_size) {
      return { ok: false, error: 'party full' };
    }
    party.member_user_ids.push(user_id);
    return { ok: true, party };
  }

  /** Leave a party (pre-launch). If leader leaves, party disbands. */
  leaveParty(party_id: string, user_id: string): void {
    const party = this.parties.get(party_id);
    if (!party) return;
    if (user_id === party.leader_user_id) {
      // disband
      this.byInvite.delete(party.invite_code);
      this.parties.delete(party_id);
      return;
    }
    party.member_user_ids = party.member_user_ids.filter((u) => u !== user_id);
  }

  /**
   * Launch the party: bind it to a session_id. All members will group-spawn there.
   * The caller (gateway/session manager) creates the session and passes its id.
   */
  launchParty(party_id: string, session_id: string): { ok: boolean; party?: Party; error?: string } {
    const party = this.parties.get(party_id);
    if (!party) return { ok: false, error: 'party not found' };
    if (party.launched_at) return { ok: false, error: 'already launched' };
    party.session_id = session_id;
    party.launched_at = new Date().toISOString();
    return { ok: true, party };
  }

  getParty(party_id: string): Party | null {
    return this.parties.get(party_id) || null;
  }

  getPartyByInvite(invite_code: string): Party | null {
    const pid = this.byInvite.get(invite_code);
    return pid ? this.parties.get(pid) || null : null;
  }

  /** The session a launched party is bound to (so members route to it on join). */
  resolveSessionForMember(user_id: string): string | null {
    for (const party of this.parties.values()) {
      if (party.launched_at && party.session_id && party.member_user_ids.includes(user_id)) {
        return party.session_id;
      }
    }
    return null;
  }

  get activePartyCount(): number {
    return this.parties.size;
  }
}
