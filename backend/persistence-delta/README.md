# persistence-delta — backend module for Games-B to register

The DCS Games API (`server.mts`) half of multiplayer persistence: the netcode
service POSTs every validated mutation here and reads it back to replay a
world into a new session. This directory is the **only** place the module
lives until Games-B applies the patch. Games-C does not edit `server.mts`.

| File | What it is |
|---|---|
| `index.mjs` | The module. Zero dependencies. Exports **one** function: `registerPersistenceDelta()`. Drops in unchanged at `src/v3/gamesc/persistence-delta/index.mjs`. |
| `REGISTRATION.patch` | `git apply`-able against backend `acb8270` (integration/dcs-games-candidate-29sep2026). It adds the module file and 22 lines to `server.mts`: one import, one `registerPersistenceDelta({...})` call next to `repo`, one `if (await persistenceDelta(req, res, url, method)) return;` line placed **before** `whoOrNull`. |
| `patched-backend-proof.mjs` | The driver used to prove the patch on a copy of the backend (see below). |

## For Games-B: applying it

```sh
cd <backend worktree at acb8270 or later>
git apply --check /path/to/REGISTRATION.patch   # verified clean on acb8270
git apply /path/to/REGISTRATION.patch
```

Why the call sits before `whoOrNull`: the netcode authenticates with a
**service token**, not a user JWT. `whoOrNull` would reject it with 401 before
any route ran.

`tests/persistence-delta-backend.test.mjs` fails if `REGISTRATION.patch` and
`index.mjs` drift apart. Regenerate the patch whenever the module changes.

## Enablement (default OFF)

Registered only when **all** of these hold. Otherwise the handler returns
`false` for every request, both paths get the host's own 404, and nothing is
read or written:

| Env | Meaning |
|---|---|
| `DCS_MULTIPLAYER_ENABLED=1` | The multiplayer feature flag (`1/true/yes/on`). Unset for internal preview. |
| `DCS_NETCODE_INGEST_TOKEN` | Shared service bearer, at least 32 chars. The netcode sends the same value as `NETCODE_PERSISTENCE_TOKEN`. |
| `accessWorld` | The host's permission check. The patch passes `repo.get(worldId, { requesterId: userId })`: published worlds and the user's own drafts return `ok`, anything else returns `not_found` (no existence oracle). |

Optional: `DCS_PERSISTENCE_DELTA_DIR` (default `$DCS_DATA_DIR/persistence-delta`),
`DCS_PERSISTENCE_DELTA_MAX_BYTES` (16384), `DCS_PERSISTENCE_DELTA_MAX_PER_WORLD` (50000),
`DCS_PERSISTENCE_DELTA_CACHED_WORLDS` (256).

## Routes (when enabled)

`POST /persistence/delta`: `Authorization: Bearer <token>`, `Idempotency-Key: <delta_id>`
(must equal `delta_id`), and a body of
`{delta_id, op: place|remove|inventory, session_id, world_id, actor_entity_id, actor_user_id, tick, payload, ts}`.

| Status | Meaning (the netcode retries only 408/429/5xx) |
|---|---|
| 200 `{ok, seq, duplicate}` | Stored, or already stored with the same content |
| 400 | Malformed envelope or payload, or a key mismatch |
| 401 | Missing or wrong service token |
| 403 / 404 | The actor may not change the world, or the world does not exist |
| 409 | The same `delta_id` arrived with different content |
| 413 | Body over the cap |
| 422 | The world's log is full |
| 503 | Permission check or storage unavailable |

`GET /persistence/delta/replay?world_id=&since=<seq>&limit=<1..1000>` returns
`{ok, world_id, deltas, next_since, complete}`. It uses the same service token.

Storage is append-only JSONL, one file per world (sha256 of the id), with
appends serialized per world. A torn tail from a crash is skipped and then
terminated before the next append. It runs in memory when no directory is set
(dev and tests only).

## Proof on the real backend (30 Sep 2026)

1. Copied the backend worktree (tracked files match `acb8270`) to scratch.
2. Applied `REGISTRATION.patch`.
3. Seeded a published world and a draft.
4. Booted `server.mts` twice.

`PATCHED-BACKEND: 12 passed, 0 failed`:

- **OFF**: both routes return 404 without a credential. With the service token
  the host answers 401 from `whoOrNull`, so the route is never served and
  nothing is stored.
- **ON**:
  - The service token reaches the module, and a published world returns 200.
  - Another creator's draft returns 404. The owner's own draft returns 200.
    An unknown world returns 404 and a wrong token returns 401.
  - Replay works, including through the `/api/` prefix.
  - The log is written under `DCS_DATA_DIR`.

Known limitation: with the flag OFF, a request that carries an invalid bearer
gets the host's generic 401 rather than 404. That is `server.mts` behavior for
every path, and the route still does not exist.
