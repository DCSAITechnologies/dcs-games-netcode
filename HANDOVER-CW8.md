# CW4 → CW8 HANDOVER — Netcode Mock Server for the real M-P1 WS-join cert

This is CW4's **actual lane repo** (DCS Games Netcode), structure intact. CW8 needs the real
`netcode-mock-server.mjs` in-session to run the REAL M-P1 WS-join certification — this repo is
the delivery mechanism.

## Run the server (what CW8 dials)
```bash
npm install              # typescript + tsx + @types/node
npm run build            # clean tsc → dist/  (zero errors)
npm start                # boots dist/server.js on ws://localhost:8090/play
# Override port: CW4_MOCK_PORT=9000 npm start
# Dev (no build): npm run server:dev   (tsx src/server.ts)
```

Endpoints:
- `ws://localhost:8090/play` — the WS game gateway (C2 protocol)
- `POST /sessions {world_id}` → `{ session_id }`
- `POST /sessions/:id/invite` → `{ invite_code }`
- `GET /health` → `{ ok, active_sessions }`

## The M-P1 WS-join flow (what CW8 certifies)
1. `POST /sessions {world_id:"world-zombie-school"}` → get `session_id`.
2. Open a WS to `/play`. Send a join frame:
   `{ "type":"join", "token":"tok:<user_id>", "world_id":"world-zombie-school", "session_id":"<id>" }`
   - Token format for the mock CW1 verifier: `tok:<user_id>` (e.g. `tok:alice`). Real CW1 swaps in later.
3. Server replies `{ "type":"joined", "session_id", "your_entity_id", "snapshot" }`.
4. Connect a second client the same way with the same `session_id`.
5. Either client sends `{ "type":"place", "object_type":"house", "position":{x,y,z}, "rotation":{yaw} }`.
6. The other client receives `{ "type":"object", "op":"place", ... }` within ~1 tick (15Hz).

That's the M-P0/M-P1 core loop over real sockets. CW4's own `tests/mock-server-smoke.mjs` and
`tests/mp2-conformance.test.ts` already drive this exact flow against `netcode-mock-server.mjs`
(boots it as a child process) — CW8 can reuse them as a reference client.

## Run CW4's own suites (proof, 173 checks / 11 suites)
```bash
npm test                 # runs all 11 suites
# or individually, e.g.: npm run test:mp1 ; npm run test:smoke ; npm run test:mp2
```

## Frames CW8 will see (C2 — full list in contracts/netcode-protocol.json)
- **in:** join, input, interact, place, inventory, chat, ping, party_create, party_join, party_launch, party_leave
- **out:** joined, state_delta (changed[]/removed[]/keyframe), spawn, despawn, object, inventory, chat, error, pong, party_state

Note: the tick loop emits **`state_delta`** (delta-compressed), not full `state`. A `keyframe:true`
delta is a full resync; otherwise apply `changed[]` and drop `removed[]`. Per-player `last_ack_seq`
rides the delta for client reconciliation.

## What's mocked (swap points, not blockers for the cert)
- **CW1 auth** → `mockTokenVerifier` accepts `tok:<user_id>`. Swap real CW1 identity when live.
- **CW5 ownership** → `MockOwnershipStore` for inventory. Swap CW5's `dcsgames_ownership` when shipped.
- **C2/C3 vs canonical** → built against the inline C2 spec; reconcile vs `_SHARED_Day0/` (light verify) when the bundle lands.

— CW4
