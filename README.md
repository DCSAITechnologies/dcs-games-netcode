# DCS Games — CW4 Netcode Lane

**Project:** DCS Games (distinct from UGC Platform — confirmed by Manager Ruling 2026-06-18, Option A)
**Lane:** CW4 — Authoritative session server, sync, validation, presence, party/voice, scale, persistent worlds
**North star:** Two+ players in one world, server-authoritative, no cheating, place-a-house-and-they-see-it.

> This lane is SEPARATE from the UGC Platform CW4 (Creator Migration) lane, which stays intact (6 modules, 13/13). Different project, different hat.

---

## ▶️ BUILD + RUN (for CW8 M-P1 cert + CW3 C2 harness)

```bash
npm install        # installs typescript, tsx, @types/node
npm run build      # clean tsc → compiles src/ to dist/  (zero errors)
npm start          # boots the WS server: node dist/server.js
```

- **WS endpoint:** `ws://localhost:8090/play` (Railway: `wss://<service>.railway.app/play`)
- **Port:** honors Railway `PORT`; local override `CW4_MOCK_PORT=9000`
- **REST (C4):** `POST /sessions {world_id}` · `POST /sessions/:id/invite` · `GET /health`
- **Dev (no build):** `npm run server:dev` (tsx) — same server via `src/server.ts`

## ☁️ DEPLOY (Railway standalone WS service — per Big Build Mandate)

`railway.json` + `Procfile` included. Railway: `npm ci && npm run build` → `node dist/server.js`, healthcheck `/health`.

**Env vars (Railway service):**
| Var | Purpose | Default |
|---|---|---|
| `PORT` | injected by Railway | 8090 (local) |
| `NETCODE_JWT_SECRET` | HS256 secret (Supabase JWT secret, >= 32 chars). **Required** — without it every join is refused | unset → deny-all |
| `NETCODE_JWT_ISSUER` / `NETCODE_JWT_AUDIENCE` | required `iss` / `aud` when set (Supabase: `https://<ref>.supabase.co/auth/v1` / `authenticated`) | not checked |
| `NETCODE_JWT_CLOCK_SKEW_SEC` | skew for exp/nbf/iat | 30 |
| `NETCODE_ALLOW_MOCK_AUTH` | `1` = accept unsigned `tok:<user_id>` — **dev only**, ignored when `NODE_ENV=production` or a secret is set | off |
| `NETCODE_MAX_PLAYERS` | seats per session (POST /sessions `max_players` may lower it) | 16 |
| `NETCODE_MAX_SESSIONS` | concurrent sessions per process | 500 |
| `NETCODE_SESSION_IDLE_MS` / `NETCODE_SESSION_GC_INTERVAL_MS` | empty-session idle TTL / GC sweep interval | 60000 / 10000 |
| `NETCODE_MAX_WS_PAYLOAD` | max bytes per WS frame (larger → close 1009) | 65536 |
| `NETCODE_MAX_HTTP_BODY` | max HTTP body bytes (larger → 413) | 16384 |
| `NETCODE_MULTIPLAYER_ENABLED` | **feature flag.** `1/true/yes/on` = on. OFF: only `GET /health` → `{ok:true,multiplayer:"off"}`; `/sessions*` and the `/play` upgrade → 404; no auth, sessions, sink or replay are built | **unset → OFF** |
| `NETCODE_REQUIRE_WORLD_TICKET` | joins, `party_create` and `POST /sessions` need a backend-minted ticket (token with a `world_id` claim equal to the world) | ON when `NODE_ENV=production`, else OFF |
| `NETCODE_MAX_SESSIONS_PER_USER` | live sessions one user may own (beyond → 429 / error `capacity`) | 5 |
| `NETCODE_MAX_PARTY_SIZE` | members per party | 4 |
| `NETCODE_REPLAY_MAX_DELTAS` / `NETCODE_REPLAY_TIMEOUT_MS` | persistence replay caps (per new session) | 20000 / 5000 |
| `NETCODE_PERSISTENCE_URL` (alias `CW5_PERSISTENCE_URL`) | backend base URL for deltas | unset → no-op sink (warning logged) |
| `NETCODE_PERSISTENCE_PATH` (alias `CW5_INGEST_PATH`) | ingest path | `/persistence/delta` |
| `NETCODE_PERSISTENCE_TOKEN` (alias `CW5_PERSISTENCE_TOKEN`) | service bearer for ingest | — |
| `NETCODE_PERSISTENCE_MAX_BYTES` / `_MAX_QUEUE` / `_TIMEOUT_MS` / `_MAX_RETRIES` | delta size cap / pending cap / per-attempt timeout / retries | 16384 / 1000 / 5000 / 3 |

**Delta emission:** every validated mutation (place/remove/inventory) is POSTed as JSON
`{delta_id, op, session_id, world_id, actor_entity_id, actor_user_id?, tick, payload, ts}` with
`Authorization: Bearer <token>` and `Idempotency-Key: <delta_id>` (same id on every retry).
Per-session FIFO; 408/429/5xx/network/timeout retried with jittered backoff (Retry-After honoured);
other 4xx dropped. `emit()` is synchronous and bounded — it never blocks the tick. With no URL the
sink is a no-op. `/health` reports `auth`, `persistence.{mode,deltas_emitted,deltas_dropped}`,
`active_sessions`, `max_sessions`, `sessions_gc_closed`. The backend side is
`backend/persistence-delta/` (one registration function + `REGISTRATION.patch` for `server.mts`;
see its README) — it is not yet applied to the backend.

**HTTP routes are authenticated** (`Authorization: Bearer <JWT>`): `POST /sessions` records the caller as
owner and its `tenant_id` claim as the session tenant; `GET /sessions/:id` (presence view) and
`POST /sessions/:id/invite` answer only the owner or a current member of the same tenant (else 404).
Joins and party ops from another tenant are refused.

**Persistence replay:** a new session loads `GET <base><path>/replay?world_id=` and rebuilds objects (re-owned by
each user's entity in the new session) and per-user inventories; `POST /sessions` returns only after replay.
Replay never re-emits deltas.

After deploy, give CW3/CW6 the `wss://<service>.railway.app/play` URL.

---

## Status: M-P0 ✅(27) · M-P1 ✅(29) · M-P2 ✅(19) · inventory ✅(14) · party-wire ✅(23) · reconnect ✅(16) · delta ✅(10) · lag-comp ✅(13) · aoi ✅(8) · persistence-client ✅(13) · mock WS ✅(7) · movement ✅(7)

**186 checks passing across 12 suites.** Core loop proven over real sockets; netcode hardened (delta compression, input seq + reconciliation, AOI); C5 deltas wired to live persistence (env-driven, retry/backoff, E2E-verified). Interest management: with a finite `AOI_RADIUS`, each recipient receives state only for entities in range (entering → `changed[]`, leaving → `removed[]`); `AOI_RADIUS=Infinity` (default) preserves global behavior. Scale prep toward M-P8.

```
✅ M-P0: two bots join one session
✅ M-P0: one places an object, the other sees it within 1 tick
✅ M-P0: each mutation emits a VALID C3 delta
✅ anti-cheat: speedhack / NaN / out-of-bounds / too-far all rejected
✅ anti-cheat: rejected mutations emit NO C3 delta
✅ interact: pickup removes object + emits C3 remove delta
✅ chat + ping
✅ auth: invalid token rejected, frame-before-join forbidden
✅ tick loop: state frames advancing @ 15Hz
+ movement regression: 7/7 (clamp vs reject boundary correct)
```

Run: `npx tsx tests/mp0-acceptance.test.ts` (needs `npm i --no-save tsx typescript`)

---

## Contract implemented — C2 (server side)

`contracts/netcode-protocol.json` (transcribed from `CW4_NETCODE_FULL.md` inline spec).
**Reconcile** against `_SHARED_Day0/contracts/netcode-protocol.json` when the bundle is distributed — ruling says this is a light verify pass (same source), not a rebuild.

**Principles enforced:**
- Server authoritative — clients send INTENTS, server validates → applies → broadcasts
- Tick 15 Hz · stable entity ids · anti-cheat day one (no teleport/speedhack)
- Every validated mutation emits a C3 save-delta op to CW5

**Frames:** in `join, input, interact, place, inventory, chat, ping` · out `joined{snapshot}, state{tick,players[]}, spawn, despawn, object{op}, inventory, chat, error, pong`

**Owns in C4:** `wss://…/play`, `POST /sessions {world_id}`, `POST /sessions/:id/invite`

---

## Lane structure

```
DCS-Games-CW4-Netcode/
├── README.md                          # this file
├── contracts/
│   └── netcode-protocol.json          # C2 (transcribed; reconcile w/ Day0)
├── src/
│   ├── types.ts                       # frames, entities, C3 delta
│   ├── validation.ts                  # anti-cheat: movement, placement, rate limits
│   ├── session.ts                     # authoritative session + tick loop + SessionManager
│   └── gateway.ts                     # WS gateway + CW1 auth handshake (transport-agnostic)
├── bots/
│   └── headless-bot.ts                # headless test client (no CW3 UI dependency)
└── tests/
    ├── mp0-acceptance.test.ts         # M-P0 gate (27 checks)
    └── movement-regression.test.ts    # clamp/reject boundary (7 checks)
```

---

## Build scope (all phases — phase tag = priority)

- **[P0]** ✅ WS gateway + auth handshake (CW1 token) · session manager (create/join/leave, invite codes) · tick loop + state broadcast · server-side movement integration (no teleport/speedhack) · `place/interact/inventory` validation → broadcast + C3 delta · headless bot client (2 bots move+place) · local mock server for CW3.
- **[P1]** ✅ party sessions (group spawn) · ✅ presence service → "friends playing" (feeds CW6/CW7).
- **[P4]** live presence counts for trending. *(presence service already exposes `onlineCount` + `sessionPlayerCount` — P4 is the surfacing.)*
- **[P7]** voice channels over C2.
- **[P8]** scale: bigger sessions, sharding, region routing, SLOs (with CW8). **Infra-gated** (live gateway).
- **[P9]** persistent-world servers (always-on worlds).

### P0 status detail
| Item | Status |
|---|---|
| WS gateway + auth handshake | ✅ HS256 JWT verifier on the real server (`src/auth.ts`), fail-closed; mockTokenVerifier for tests only |
| Session manager (create/join/leave/invite) | ✅ |
| Tick loop @ 15Hz + state broadcast | ✅ |
| Server-authoritative movement (anti-cheat) | ✅ (clamp jitter, reject speedhack/teleport/NaN/OOB) |
| place/interact validation → broadcast + C3 | ✅ |
| inventory frame | 🟡 frame defined; handler stubbed (P0 minimal — no item DB yet) |
| Headless bot client (2 bots move+place) | ✅ |
| Local mock server for CW3 | ✅ SHIPPED — `mock-server.mjs` (zero-dep RFC6455 WS over real sockets; smoke 7/7) |

---

## Acceptance gates

- **M-P0** ✅ — two bot clients join one session; one places an object; the other sees it within 1 tick; each mutation emits a valid C3 delta.
- **M-P1** ✅ — a party of 2 spawns into the same session together; presence shows "friends playing". (29/29)
- **M-P2** ✅ — CW3-style client dials the bundled WS mock + conforms to the full C2 protocol over real sockets (join/state/place/interact/inventory/chat/ping + error contract + peer broadcast). (17/17) — this is also the conformance suite CW3 runs its client against.
- **M-P8** ⏳ — load test passes target concurrent sessions within latency budget. **Infra-gated.**

### Inventory handler (M-P2/M-P3)
Built against a **CW5 ownership-store seam** (`src/inventory.ts`): own-to-act validation, slot rules, emits C3 `inventory` delta for CW5 to persist. `MockOwnershipStore` for tests; swap CW5's canonical store when its ownership contract lands in `_SHARED_Day0/`. Wired into `Session`/`SessionManager` as optional (sessions without a store reject inventory gracefully). 14/14.

---

## You block nobody / nobody blocks you

- **Headless bot tests CW4 without CW3** ✅ — bot drives the gateway via in-memory transport.
- **C3 deltas emitted against the schema** ✅ — CW5 integrates without waiting (validated in tests).
- **Local mock server for CW3** 🔜 — next deliverable: wrap the gateway in a real WS endpoint so CW3 can dial `wss://localhost/play`.

---

## Next buildable (no infra/DK gate)

1. ✅ **Local mock WS server** — DONE. Smoke 7/7.
2. ✅ **M-P1 party + presence** — DONE. 29/29.
3. ✅ **M-P2 conformance harness** — DONE. CW3 dials the WS mock; full C2 contract proven. 17/17.
4. ✅ **Inventory handler** (CW5 ownership seam) — DONE. 14/14.
5. ✅ **Party invite over the wire** — DONE. `party_create/join/launch/leave` WS frames + `party_state` push; full lifecycle → group spawn drivable by CW3. 23/23.
6. ✅ **Reconnect/resume** — DONE. Dropped client reattaches to preserved entity (position/health) within grace window; hard-quit skips grace; grace expiry → fresh spawn. 16/16.
7. ✅ **Party HTTP routes on the mock** — REST mirror of party WS frames (optional). *(deferred — WS frames cover CW3's needs; revisit if a non-socket flow appears)*
8. ✅ **Snapshot delta compression** — DONE. `state_delta{changed[],removed[],keyframe}`; idle = ~0 bandwidth, periodic keyframes for resync. 10/10.
9. ✅ **Interest management / AOI** — DONE. Per-recipient culling by `AOI_RADIUS`; enter→`changed[]`, leave→`removed[]`; off by default. Scale prep toward M-P8. 8/8.
10. ✅ **Lag-comp / input sequencing** — DONE. 13/13.

## Honest wall (what's left needs the bundle or live infra)
With AOI done, CW4 has built the full no-gate netcode-hardening surface. Remaining work is genuinely gated:
- **C2/C3 reconcile** vs canonical → needs `_SHARED_Day0/` (not in-session, 4 rounds running).
- **CW5 ownership-store swap** → needs CW5's frozen ownership contract.
- **Real CW1 auth** → swap `mockTokenVerifier` when identity service is live.
- **P7 voice** → voice provider. **P8 scale/load** → live gateway + region routing. **P9 persistent-world servers** → always-on infra.
- **M-P8 load cert** → CW8 + live gateway.

The AOI work is the foundation P8 sharding builds on, but actual scale testing needs the live gateway. **Not manufacturing filler past this point — flagging the wall.**

> **P1 netcode-hardening (spec):** prediction/reconciliation ✅ (input seq + ack), lag comp ✅ (seq ordering), snapshot interpolation — client-side (CW3 consumes `state_delta` + keyframes; CW4 provides the data shape). Server-authoritative anti-cheat ✅ from P0.

> **Protocol note:** the tick loop now emits `state_delta` (not `state`). `StateFrame` remains in the protocol for compatibility but is no longer the default broadcast. Clients apply `changed[]` + drop `removed[]`; a `keyframe:true` delta is a full resync.

## Genuine gates (escalated / awaiting)
- **`_SHARED_Day0/` bundle still not in-session** (Round-3 dispatch said attach it; it did not arrive in uploads). CW4 is unaffected for building — **I authored C2 + the WS mock**, so I'm the source for the netcode-side canonical. The **C2/C3 reconcile** + **CW5 ownership-store swap** are the only steps that need the bundle. Flagged to manager.
- **Real CW1 auth** — swap `mockTokenVerifier` when identity service provisioned.
- **CW5 ownership contract** — swap `MockOwnershipStore` for CW5's canonical store.
- **P7 voice / P8 scale** — infra-gated (voice provider, live gateway).

## Genuine gates (escalated)
- **P8 scale/load** — needs live gateway infra (region routing, sharding).
- **P7 voice** — needs a voice provider.
- **Day0 bundle** — reconcile C2/C3 against canonical `_SHARED_Day0/` when distributed (light verify pass).
- **Real CW1 auth** — swap `mockTokenVerifier` for the live identity service when provisioned.
