# CW4 → CW MANAGER — Big Build Round: Status + Query
**19 June 2026 · DCS Games CW4 (Netcode) · bundled with the lane repo**

---

## ✅ DONE THIS ROUND (Big Build Mandate — full lane, one pass)

CW4 order was: deploy the WS server as a standalone Railway service
(`npm run build` → `node dist/server.js`), provide the `wss://…/play` URL, and emit
C5 deltas to live persistence.

Shipped + verified:

1. **C5 delta emission → live persistence** (`src/persistence-client.ts`)
   - `HttpDeltaSink` POSTs every validated mutation (place/remove/inventory) to CW5's ingest endpoint.
   - Per-session FIFO ordering (deltas for a world persist in tick order).
   - Retry/backoff on transient 5xx/429; **no-retry on 4xx** (caught + fixed a real retry-storm bug mid-build).
   - `LocalDeltaSink` fallback when no URL set → **live cutover is env-only, zero code change.**
   - Bearer-token auth support.
2. **Railway deploy config** — `railway.json` (`npm ci && npm run build` → `node dist/server.js`,
   healthcheck `/health`) + `Procfile`. Server honors Railway's injected `PORT`.
3. **`/health` upgraded** for CW8 monitoring — reports `persistence.mode` (live/local) + `deltas_emitted`.

### Verification (clean extract, mandate's `npm ci` entrypoint)
```
npm ci         → OK
npm run build  → 9 JS modules in dist/  (clean tsc, zero errors)
npm test       → 12 suites / 186 checks / 0 failed
railway.json + Procfile present
```
**E2E proven (6/6)** against compiled `dist/server.js`: WS place → C5 delta POSTed to a
CW5-style endpoint → `/health` reports `mode=live, deltas_emitted≥1`. That is the exact live path.

Suites: M-P0(27) · M-P1(29) · M-P2(19) · inventory(14) · party-wire(23) · reconnect(16) ·
delta(10) · lag-comp(13) · aoi(8) · persistence-client(13) · movement(7) · smoke(7) = **186**.

---

## ⚠️ HONEST BLOCKER — why I can't "build next" without faking

I could NOT reach `api.games.dcsai.ai` from the build sandbox (egress is allowlisted to
npm/github/etc; the live host is blocked here). Per the mandate's own rule —
*"CWs build + prepare CI, DK deploys"* and *"if a real module's shape differs, flag the
owning lane — don't fake it"* — I built the real live-wire and proved it against a local
CW5 stand-in. The production difference is **one env value**.

The remaining acceptance criteria are NOT CW4 build tasks — they are cross-lane / live:

| To close the loop | Owner |
|---|---|
| Deploy this zip to Railway + set `CW5_PERSISTENCE_URL` | **DK** (network-blocked here; "DK deploys" is the rule) |
| Confirm CW5 ingest path/shape (mine: `POST /persistence/delta` + C5 envelope) | **CW5** — one-line swap if it differs; I won't guess it |
| Ship `dcsgames_ownership` for the inventory wire | **CW5** |
| `certify-all` REAL across M-P0→M-P4 (stands up my server for M-P1) | **CW8** |

---

## ▶️ WHAT I NEED TO DO REAL NEXT WORK — pick any

1. **CW5's actual ingest contract** (path + delta shape) → I wire + retest the persistence
   client to match (~10 min, concrete).
2. **CW5's `dcsgames_ownership` export** → I do the inventory one-adapter swap + test.
3. **A CW8 ping during wiring** → I support standing up my server for the M-P1 cert.
4. **Redirect to another lane** with build-without-infra work left.

Until one of those lands I'm **holding at the ceiling** — not manufacturing filler or guessing
another lane's contract. That's the correct move per the mandate's honest-data / don't-fake-it rules.

---

## DEPLOY QUICK-REF (for DK)
```bash
# Railway service (config in railway.json):
#   build:  npm ci && npm run build
#   start:  node dist/server.js
#   health: /health
# Env to set on the service:
CW5_PERSISTENCE_URL=https://api.games.dcsai.ai   # ← flips C5 deltas to live; without it, local sink
CW5_INGEST_PATH=/persistence/delta               # override if CW5's path differs
CW5_PERSISTENCE_TOKEN=<optional bearer>
# PORT is injected by Railway automatically.
# After deploy, the wss://<service>.railway.app/play URL goes to CW3 + CW6.
```

— CW4 (Netcode)
