// src/presence.ts
// DCS Games CW4 Netcode — Presence Service (M-P1)
// Tracks who's online + which session they're in. Feeds CW6 (discovery) + CW7 (trust/social).
// "Friends playing" = intersection of a user's friend list with currently-online users.

export interface PresenceEntry {
  user_id: string;
  entity_id: string;
  session_id: string;
  world_id: string;
  since: string; // ISO timestamp of join
}

export interface FriendPlaying {
  user_id: string;
  session_id: string;
  world_id: string;
}

/**
 * Friend-list provider. In production this calls CW1 (Identity owns the social graph).
 * For P1/headless test, inject a mock that returns a static friend map.
 */
export type FriendListProvider = (user_id: string) => string[];

export class PresenceService {
  // user_id -> presence
  private online: Map<string, PresenceEntry> = new Map();
  // session_id -> set of user_ids (reverse index for fast "who's in this session")
  private bySession: Map<string, Set<string>> = new Map();
  private getFriends: FriendListProvider;

  constructor(getFriends: FriendListProvider) {
    this.getFriends = getFriends;
  }

  /** Mark a user online in a session. */
  setOnline(entry: PresenceEntry): void {
    // If already online elsewhere, clear the old session index first
    const prev = this.online.get(entry.user_id);
    if (prev) {
      this.bySession.get(prev.session_id)?.delete(entry.user_id);
    }
    this.online.set(entry.user_id, entry);
    if (!this.bySession.has(entry.session_id)) {
      this.bySession.set(entry.session_id, new Set());
    }
    this.bySession.get(entry.session_id)!.add(entry.user_id);
  }

  /** Mark a user offline. */
  setOffline(user_id: string): void {
    const entry = this.online.get(user_id);
    if (entry) {
      this.bySession.get(entry.session_id)?.delete(user_id);
      if (this.bySession.get(entry.session_id)?.size === 0) {
        this.bySession.delete(entry.session_id);
      }
    }
    this.online.delete(user_id);
  }

  isOnline(user_id: string): boolean {
    return this.online.has(user_id);
  }

  getPresence(user_id: string): PresenceEntry | null {
    return this.online.get(user_id) || null;
  }

  /** Users currently in a given session. */
  usersInSession(session_id: string): string[] {
    return Array.from(this.bySession.get(session_id) || []);
  }

  /** Total online count (feeds CW6 trending at P4). */
  get onlineCount(): number {
    return this.online.size;
  }

  /** Live player count for a session (feeds CW6 trending). */
  sessionPlayerCount(session_id: string): number {
    return this.bySession.get(session_id)?.size || 0;
  }

  /**
   * "Friends playing" for a user — which of their friends are currently online,
   * and where. Feeds CW6 (the social discovery surface) + CW7 (social trust).
   */
  friendsPlaying(user_id: string): FriendPlaying[] {
    const friends = this.getFriends(user_id);
    const result: FriendPlaying[] = [];
    for (const friend_id of friends) {
      const presence = this.online.get(friend_id);
      if (presence) {
        result.push({
          user_id: friend_id,
          session_id: presence.session_id,
          world_id: presence.world_id,
        });
      }
    }
    return result;
  }
}

/**
 * Default mock friend-list provider for P1/headless testing.
 * Replace with a real CW1 social-graph call when identity is live.
 */
export function mockFriendList(graph: Record<string, string[]>): FriendListProvider {
  return (user_id: string) => graph[user_id] || [];
}
