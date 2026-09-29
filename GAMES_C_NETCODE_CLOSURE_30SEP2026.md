# GAMES-C — multiplayer / netcode closure (30 Sep 2026)

- **Branch:** `fix/games-c-netcode-closure`. It is off netcode `4f51915`
  (integration/dcs-games-netcode-hardening-29sep2026). Local only, not pushed.
- **Preserved base:** `~/Developer/dcs-games-c-netcode-closure-bundles-30sep2026/netcode-4f51915-full.bundle`,
  sha256 `52913aa7e9ca8afdddaa06090c28540b2ca515b1e5e55eb42600088cf276b013`.
- **Multiplayer stays FEATURE FLAG OFF for internal preview.** `NETCODE_MULTIPLAYER_ENABLED` is unset
  on the netcode side and `DCS_MULTIPLAYER_ENABLED` is unset on the backend.

## What was already done at 4f51915 (verified, not rebuilt)

- HS256 JWT verifier that fails closed.
- Max players, session cap, idle GC and grace cleanup.
- WS frame cap, HTTP body cap, strict `world_id`, spawn points.
- Bounded, idempotent delta client.
- Speedhack budget (b5aa816).

This branch adds tests over the real wire for each of these.

## What this branch adds

| # | Item | Where | Proof |
|---|---|---|---|
| 1 | `/persistence/delta` backend module: ingest and replay, **one** export `registerPersistenceDelta()`, flag-gated, service token, repo permission check, idempotent JSONL log | `backend/persistence-delta/index.mjs`. Registration patch for Games-B: `backend/persistence-delta/REGISTRATION.patch` (applies cleanly to backend acb8270; `server.mts` **not** edited by Games-C) | `tests/persistence-delta-backend.test.mjs` (7). The patched backend booted on a copy: 12/12 (`patched-backend-proof.mjs`) |
| 2 | Token verifier seam: the same verifier now also guards HTTP routes; `tenant_id` claim; optional backend **world ticket** (`NETCODE_REQUIRE_WORLD_TICKET`, default ON in production) | `src/gateway.ts`, `src/server.ts`, `src/config.ts` | e2e: forged → 401, no token → 401, ticket for another world → refused |
| 3 | Max players (existing) plus a **per-user session quota** (`NETCODE_MAX_SESSIONS_PER_USER`, default 5) | `src/session.ts` | e2e: `session_full`; 4th session → 429 |
| 4 | Body/frame limits (existing); placements now validate `object_type` and `rotation` to the backend's rules and copy fields (no client extras) | `src/validation.ts`, `src/session.ts` | e2e: a bad `object_type` never reaches persistence |
| 5 | Session cleanup: parties are capped and swept (unlaunched TTL, dead session), a session close forgets its party, inventory is freed on purge and close. **Bug fixed:** a launched party whose session closed stranded every member on `not_found` forever | `src/party.ts`, `src/gateway.ts` | e2e (in-process) |
| 6 | `world_id` validation (existing), plus `world_mismatch` and ticket binding | `src/gateway.ts` | e2e |
| 7 | Spawn points (existing) | — | e2e: assigned spawn `gate` |
| 8 | Party: **now wired on the real server** (it was not before); tenant-isolated invites; single-party rule; a non-member cannot leave or learn state; leader-only launch | `src/server.ts`, `src/party.ts`, `src/gateway.ts` | e2e over WS |
| 9 | Presence: **now wired**; `GET /sessions/:id` presence view for the owner or members of the same tenant only | `src/server.ts` | e2e |
| 10 | Inventory: **now live on the real server** (it used to answer "ownership store not wired"). A server-authoritative `LiveOwnershipStore`: pickup grants, move/equip/drop apply, the inventory is pushed on join, and it survives grace expiry | `src/inventory.ts`, `src/session.ts` | e2e plus in-process |
| 11 | Reconnect/resume (existing grace), proven over real sockets | — | e2e: `spawn.id === "resume"`, same entity |
| 12 | Persistence replay: a new session folds the backend log (objects re-owned per user, inventories); `POST /sessions` returns after replay; a late replay merges and pushes; nothing is echoed | `src/replay.ts`, `src/session.ts` | e2e across a real backend |
| 13 | Speedhack (existing budget), proven over the wire | — | e2e: 60-unit jump rejected, snap-back |
| 14 | Tenant/ownership: session tenant from the creator's token; joins, party, invite and presence are tenant-isolated; the object ownership check covers replayed objects; the backend refuses deltas for worlds the actor cannot use (403/404 → dropped) | `src/gateway.ts`, `src/server.ts`, backend module | e2e |

## Feature flag OFF proof (`tests/feature-flag-off.test.ts`, 55 checks)

- **Netcode, flag unset, `"0"` or `"false"`:**
  - `/health` returns exactly `{ok:true,multiplayer:"off"}`.
  - `POST /sessions`, `GET /sessions/:id` and invite return 404, even with a valid JWT.
  - The `/play` upgrade gets HTTP 404, and a real WebSocket client cannot open it.
  - No auth or persistence subsystem is built.
  - The configured backend received **0** requests.
- **Backend module, flag unset:** both routes return the host's 404.
- **Frontend** (`~/Developer/dcs-games-frontend-integration-29sep2026`, HEAD 3c2e092 working tree, 208 files):
  - None of it contains a WebSocket, a `ws://`/`wss://` URL, `netcode`, `multiplayer`, a party frame, an invite route or a netcode config key.
  - A negative control confirms the scanner catches a synthetic entrypoint.
  - CI sets `DCS_SITE_SCAN=skip`, because the frontend is not checked out in this repo.

## Tests

The focused netcode suite (`npm test`) has 20 suites and 0 failures.

- Existing: mp0, mp1, mp2, inventory, party, reconnect, delta, lagcomp, aoi, persistence, movement, smoke,
  speedhack, gamesc-slice, auth, hardening, limits.
- New: backend-delta, closure (59), flag-off (55).

## Residual / not done

- **Registration patch not applied.** Games-B applies `REGISTRATION.patch` to the backend. Its
  `src/v3/gamesc/multiplayer/index.mjs` `NETCODE_PROTOCOL` capability flags (`supports_spawn_points`,
  `enforces_max_players` and `real_auth`) are stale and should flip to true when it does.
- **Backend must mint tickets.** No backend route mints world tickets yet, so `NETCODE_REQUIRE_WORLD_TICKET`
  in production refuses plain Supabase tokens until one exists.
- **In-flight deltas can be missed on replay.** Replay reads what the backend has stored. Deltas still in
  flight (queued or retrying in the sink) when a new session starts are not included.
- **Duplicate sockets.** A second socket for the same user and session re-seats the same entity (behavior
  that predates this branch). The first socket's binding is left dangling until it closes.
- **Host 401 with the flag OFF.** On the backend, a request carrying an invalid bearer gets the host's
  generic 401 from `whoOrNull` rather than 404. The route still does not exist.
- **No friend graph.** Presence has no friend-graph source on the service, so `friendsPlaying` is empty.
- **Mock server not updated.** `netcode-mock-server.mjs` (the dev mock) is unchanged and still has no flag or HTTP auth.
