// src/persistence-client.ts
// DCS Games CW4 Netcode — C5 Delta Sink → live persistence (CW5)
//
// Per the Big Build Mandate: the netcode server "emits C5 deltas to the live
// persistence." CW5 owns the durable Supabase layer; CW4 forwards every validated
// mutation (place/remove/inventory) as a C5 delta to CW5's ingest endpoint.
//
// Config (env — DK sets on the Railway service):
//   CW5_PERSISTENCE_URL   e.g. https://api.games.dcsai.ai   (base; we POST /persistence/delta)
//   CW5_INGEST_PATH       optional override (default /persistence/delta)
//   CW5_PERSISTENCE_TOKEN optional bearer token for the ingest endpoint
//
// If CW5_PERSISTENCE_URL is unset (e.g. local dev / tests), this falls back to an
// in-memory + console sink so the server still runs standalone. That makes the live
// cutover a pure env change — no code edit.

import type { C3Delta } from './types.js';

export interface DeltaSink {
  emit(delta: C3Delta): void;
  /** For tests/diagnostics: how many deltas have been accepted locally. */
  readonly count: number;
}

/** Local/dev sink: retains + logs. Used when no live URL is configured. */
export class LocalDeltaSink implements DeltaSink {
  private deltas: C3Delta[] = [];
  emit(delta: C3Delta): void {
    this.deltas.push(delta);
    console.log(`[C5→local] ${delta.op} session=${delta.session_id.slice(0, 8)} actor=${delta.actor_entity_id.slice(0, 8)} tick=${delta.tick}`);
  }
  get count(): number { return this.deltas.length; }
  get all(): C3Delta[] { return this.deltas; }
}

/**
 * Live sink: POSTs deltas to CW5's persistence ingest with retry/backoff.
 * Fire-and-forget from the tick path (never blocks the game loop); failures are
 * retried on a backoff and logged. Ordering within a session is preserved by a
 * per-session serial queue (deltas for one world apply in tick order).
 */
export class HttpDeltaSink implements DeltaSink {
  private baseUrl: string;
  private ingestPath: string;
  private token?: string;
  private accepted = 0;
  // Per-session FIFO queues so deltas for a given world persist in order.
  private queues: Map<string, Promise<void>> = new Map();
  private maxRetries: number;
  private fetchImpl: typeof fetch;

  constructor(opts: {
    baseUrl: string;
    ingestPath?: string;
    token?: string;
    maxRetries?: number;
    fetchImpl?: typeof fetch; // injectable for tests
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.ingestPath = opts.ingestPath || '/persistence/delta';
    this.token = opts.token;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl || fetch;
  }

  get count(): number { return this.accepted; }

  emit(delta: C3Delta): void {
    // Chain onto this session's queue to preserve order; don't block the caller.
    const key = delta.session_id;
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(() => this.post(delta)).catch((err) => {
      console.error(`[C5→live] gave up on ${delta.op} tick=${delta.tick}: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.queues.set(key, next);
    // Best-effort queue cleanup once settled.
    next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
  }

  private async post(delta: C3Delta): Promise<void> {
    const url = `${this.baseUrl}${this.ingestPath}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;

    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.maxRetries) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(delta),
        });
        if (res.ok) { this.accepted++; return; }
        // 4xx (except 429) = permanent; do NOT retry a bad payload.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new PermanentPersistenceError(`persistence rejected delta: HTTP ${res.status}`);
        }
        lastErr = new Error(`HTTP ${res.status}`); // transient (5xx / 429) → retry
      } catch (err) {
        // A permanent error must bubble out immediately (no retry storm).
        if (err instanceof PermanentPersistenceError) throw err;
        lastErr = err; // network/transient → retry
      }
      attempt++;
      if (attempt <= this.maxRetries) {
        await sleep(backoffMs(attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('persistence post failed');
  }
}

/** A non-retryable persistence failure (e.g. a 4xx bad payload). */
class PermanentPersistenceError extends Error {}

function backoffMs(attempt: number): number {
  // Exponential backoff with jitter: ~100ms, 200ms, 400ms (+/- 25%)
  const base = 100 * Math.pow(2, attempt - 1);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the right sink from env. Live when CW5_PERSISTENCE_URL is set, else local.
 * This is the single decision point for the live cutover (env, not code).
 */
export function deltaSinkFromEnv(env: Record<string, string | undefined> = process.env): DeltaSink {
  const url = env.CW5_PERSISTENCE_URL;
  if (url && url.trim().length > 0) {
    console.log(`[C5] live persistence sink → ${url}${env.CW5_INGEST_PATH || '/persistence/delta'}`);
    return new HttpDeltaSink({
      baseUrl: url,
      ingestPath: env.CW5_INGEST_PATH,
      token: env.CW5_PERSISTENCE_TOKEN,
    });
  }
  console.log('[C5] no CW5_PERSISTENCE_URL set → local delta sink (dev/standalone)');
  return new LocalDeltaSink();
}
