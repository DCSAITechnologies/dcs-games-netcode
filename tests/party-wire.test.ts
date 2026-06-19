// tests/party-wire.test.ts
// DCS Games CW4 Netcode — Party-over-the-wire
// Drives the full party lifecycle through WS frames (as CW3 will):
//   party_create → party_join → party_launch → both clients `join` → group-spawn.

import { SessionManager } from '../src/session';
import { Gateway, mockTokenVerifier } from '../src/gateway';
import { PresenceService, mockFriendList } from '../src/presence';
import { PartyManager } from '../src/party';
import { C3Delta } from '../src/types';
import { HeadlessBot } from '../bots/headless-bot';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — PARTY OVER THE WIRE              ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const c3deltas: C3Delta[] = [];
  const sessionManager = new SessionManager((d) => c3deltas.push(d));
  const presence = new PresenceService(mockFriendList({ userA: ['userB'], userB: ['userA'] }));
  const party = new PartyManager(4);
  const gateway = new Gateway(sessionManager, mockTokenVerifier, { presence, party });

  // ===== Party lifecycle via frames =====
  console.log('┌─ Party lifecycle via WS frames ───────────────────────┐\n');

  const leader = new HeadlessBot('A', gateway);
  leader.partyCreate('tok:userA', 'world-zombie-school');
  await sleep(40);
  check('party_create → party_state pushed', leader.lastPartyState !== null);
  check('leader is party leader', leader.lastPartyState?.leader_user_id === 'userA');
  check('party has invite_code', !!leader.lastPartyState?.invite_code);
  check('party not yet launched', leader.lastPartyState?.launched === false);

  const inviteCode = leader.lastPartyState.invite_code;
  const partyId = leader.lastPartyState.party_id;

  // Member B joins via invite
  const member = new HeadlessBot('B', gateway);
  member.partyJoin('tok:userB', inviteCode);
  await sleep(40);
  check('party_join → party_state pushed to joiner', member.lastPartyState !== null);
  check('party now has 2 members', member.lastPartyState?.member_user_ids.length === 2);
  check('B sees A as leader', member.lastPartyState?.leader_user_id === 'userA');

  // Non-leader tries to launch → forbidden
  member.lastError = null;
  member.partyLaunch('tok:userB', partyId);
  await sleep(40);
  check('non-leader launch → forbidden', member.lastError?.includes('forbidden') === true);

  // Leader launches → session bound
  leader.partyLaunch('tok:userA', partyId);
  await sleep(40);
  check('leader launch → launched=true', leader.lastPartyState?.launched === true);
  check('launch → session_id assigned', typeof leader.lastPartyState?.session_id === 'string');

  const partySessionId = leader.lastPartyState.session_id;

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Group spawn: both members join → routed to same session =====
  console.log('┌─ Group spawn: both members join the game ─────────────┐\n');

  leader.join('tok:userA', 'world-zombie-school'); // party routing sends to party session
  await sleep(50);
  member.join('tok:userB', 'world-zombie-school');
  await sleep(80);

  check('leader routed to party session', leader.session_id === partySessionId);
  check('member routed to SAME session (group spawn)', member.session_id === partySessionId);
  check('both in same session', leader.session_id === member.session_id);
  check('leader observes member', leader.observedPlayers.has(member.entity_id!));
  check('member observes leader', member.observedPlayers.has(leader.entity_id!));

  // presence reflects both playing
  check('presence: both online', presence.onlineCount === 2);
  check('presence: friends-playing works post-wire-launch', presence.friendsPlaying('userA').length === 1);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Leave / disband =====
  console.log('┌─ Party leave / disband ───────────────────────────────┐\n');

  // Fresh party for leave test
  const c = new HeadlessBot('C', gateway);
  c.partyCreate('tok:userC', 'w');
  await sleep(40);
  const cPartyId = c.lastPartyState.party_id;
  const cInvite = c.lastPartyState.invite_code;

  const d = new HeadlessBot('D', gateway);
  d.partyJoin('tok:userD', cInvite);
  await sleep(40);
  check('D joined C\'s party', d.lastPartyState?.member_user_ids.length === 2);

  // D leaves (non-leader) → party persists with 1
  d.partyLeave('tok:userD', cPartyId);
  await sleep(40);
  check('D left → party persists', d.lastPartyState?.member_user_ids.length === 1);

  // Leader C leaves → disband (empty party_state)
  c.partyLeave('tok:userC', cPartyId);
  await sleep(40);
  check('leader left → party disbanded', c.lastPartyState?.member_user_ids.length === 0);
  check('disbanded party not resolvable', party.getParty(cPartyId) === null);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  // ===== Error contract =====
  console.log('┌─ Party error contract ────────────────────────────────┐\n');

  const e = new HeadlessBot('E', gateway);
  e.partyJoin('tok:userE', 'bogus-invite');
  await sleep(40);
  check('bad invite → error', e.lastError !== null);

  e.lastError = null;
  e.send({ type: 'party_create', token: 'garbage', world_id: 'w' } as any);
  await sleep(40);
  check('party op with bad token → auth error', e.lastError?.includes('auth') === true);

  console.log('\n└──────────────────────────────────────────────────────┘\n');

  leader.disconnect();
  member.disconnect();
  sessionManager.closeSession(partySessionId);

  console.log('╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  PARTY-WIRE: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1));
