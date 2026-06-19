// tests/mp1-acceptance.test.ts
// DCS Games CW4 Netcode — Acceptance Gate M-P1
//
// M-P1: a party of 2 spawns into the SAME session together; presence shows "friends playing".

import { SessionManager } from '../src/session';
import { Gateway, mockTokenVerifier } from '../src/gateway';
import { PresenceService, mockFriendList } from '../src/presence';
import { PartyManager } from '../src/party';
import { C3Delta } from '../src/types';
import { HeadlessBot } from '../bots/headless-bot';

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — M-P1 ACCEPTANCE GATE              ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const c3deltas: C3Delta[] = [];
  const sessionManager = new SessionManager((d) => c3deltas.push(d));

  // Social graph: userA and userB are friends; userC is a friend of A too.
  const presence = new PresenceService(
    mockFriendList({
      userA: ['userB', 'userC'],
      userB: ['userA'],
      userC: ['userA'],
    })
  );
  const party = new PartyManager(4);

  const gateway = new Gateway(sessionManager, mockTokenVerifier, { presence, party });

  // ===== PARTY GROUP-SPAWN =====
  console.log('┌─ Party: 2 members group-spawn into ONE session ──────┐\n');

  // Leader A creates a party for a world
  const p = party.createParty('userA', 'world-zombie-school');
  check('party created with leader A', p.leader_user_id === 'userA');
  check('party has invite code', !!p.invite_code);

  // B joins the party via invite
  const joinB = party.joinParty(p.invite_code, 'userB');
  check('B joined party via invite', joinB.ok === true);
  check('party now has 2 members', joinB.party?.member_user_ids.length === 2);

  // Launch the party: create ONE session, bind it
  const partySession = sessionManager.createSession(p.world_id);
  const launch = party.launchParty(p.party_id, partySession.session_id);
  check('party launched + bound to session', launch.ok === true && launch.party?.session_id === partySession.session_id);

  // Both members connect — gateway routes BOTH to the party's session (group spawn)
  const botA = new HeadlessBot('A', gateway);
  botA.join('tok:userA', 'world-zombie-school'); // no session_id — party routing overrides
  await sleep(50);

  const botB = new HeadlessBot('B', gateway);
  botB.join('tok:userB', 'world-zombie-school'); // no session_id — party routing overrides
  await sleep(50);

  check('A routed to party session', botA.session_id === partySession.session_id);
  check('B routed to SAME party session (group spawn)', botB.session_id === partySession.session_id);
  check('A and B are in the same session', botA.session_id === botB.session_id);
  check('both have distinct entity ids', botA.entity_id !== botB.entity_id);

  // They see each other
  await sleep(100);
  check('A observes B in the session', botA.observedPlayers.has(botB.entity_id!));
  check('B observes A in the session', botB.observedPlayers.has(botA.entity_id!));

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== PRESENCE / FRIENDS PLAYING =====
  console.log('┌─ Presence: "friends playing" ─────────────────────────┐\n');

  check('presence: A is online', presence.isOnline('userA'));
  check('presence: B is online', presence.isOnline('userB'));
  check('presence: C is offline', !presence.isOnline('userC'));
  check('presence: online count = 2', presence.onlineCount === 2);
  check('presence: party session has 2 players', presence.sessionPlayerCount(partySession.session_id) === 2);

  // "Friends playing" for A: B is online (friend), C is offline (friend) → only B shows
  const aFriendsPlaying = presence.friendsPlaying('userA');
  check('A sees exactly 1 friend playing (B)', aFriendsPlaying.length === 1);
  check('A\'s friend-playing is B', aFriendsPlaying[0]?.user_id === 'userB');
  check('A sees B\'s session', aFriendsPlaying[0]?.session_id === partySession.session_id);
  check('A sees B\'s world', aFriendsPlaying[0]?.world_id === 'world-zombie-school');

  // "Friends playing" for B: A is online (friend) → A shows
  const bFriendsPlaying = presence.friendsPlaying('userB');
  check('B sees A playing', bFriendsPlaying.length === 1 && bFriendsPlaying[0].user_id === 'userA');

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== PRESENCE UPDATES ON DISCONNECT =====
  console.log('┌─ Presence: updates on disconnect ─────────────────────┐\n');

  botB.disconnect();
  await sleep(50);
  check('after B disconnects: B offline', !presence.isOnline('userB'));
  check('after B disconnects: online count = 1', presence.onlineCount === 1);
  check('after B disconnects: A sees 0 friends playing', presence.friendsPlaying('userA').length === 0);
  check('session player count drops to 1', presence.sessionPlayerCount(partySession.session_id) === 1);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== PARTY EDGE CASES =====
  console.log('┌─ Party: edge cases ───────────────────────────────────┐\n');

  // Full party
  const p2 = party.createParty('u1', 'w');
  party.joinParty(p2.invite_code, 'u2');
  party.joinParty(p2.invite_code, 'u3');
  party.joinParty(p2.invite_code, 'u4');
  const full = party.joinParty(p2.invite_code, 'u5');
  check('party rejects 5th member (cap 4)', full.ok === false && full.error === 'party full');

  // Bad invite
  const badInvite = party.joinParty('nonexistent', 'u6');
  check('bad invite code rejected', badInvite.ok === false);

  // Idempotent join
  const reJoin = party.joinParty(p2.invite_code, 'u2');
  check('re-join is idempotent (still 4 members)', reJoin.ok === true && reJoin.party?.member_user_ids.length === 4);

  // Can't launch twice
  const s2 = sessionManager.createSession('w');
  party.launchParty(p2.party_id, s2.session_id);
  const relaunch = party.launchParty(p2.party_id, s2.session_id);
  check('cannot launch party twice', relaunch.ok === false);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // Cleanup
  botA.disconnect();
  sessionManager.closeSession(partySession.session_id);

  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  M-P1 GATE: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1));
