// src/persistence-client.ts
// DCS Games CW4 Netcode — C3/C5 delta sink → backend persistence.
//
// Every validated mutation (place/remove/inventory) is forwarded to the backend
// as one JSON delta. The backend route does not exist yet; the contract this
// client speaks is documented on HttpDeltaSink below and in README.md.
//
// Config (env):
//   NETCODE_PERSISTENCE_URL        backend base URL (alias: CW5_PERSISTENCE_URL)
//   NETCODE_PERSISTENCE_PATH       ingest path, default /persistence/delta (alias: CW5_INGEST_PATH)
//   NETCODE_PERSISTENCE_TOKEN      service bearer token (alias: CW5_PERSISTENCE_TOKEN)
//   NETCODE_PERSISTENCE_MAX_BYTES  max serialized delta size, default 16384 (larger → dropped)
//   NETCODE_PERSISTENCE_MAX_QUEUE  max deltas pending (queued + in flight), default 1000 (beyond → dropped)
//   NETCODE_PERSISTENCE_TIMEOUT_MS per-attempt timeout, default 5000
//   NETCODE_PERSISTENCE_MAX_RETRIES retries after the first attempt, default 3
//
// With no URL configured the sink is a NO-OP (one logged warning at boot, then
// deltas are counted and discarded). It never retains deltas in memory.

import crypto from 'node:crypto';
import type { C3Delta } from './types.js';
import { intEnv } from './config.js';

export type SinkMode = 'live' | 'noop' | 'local';

export interface DeltaSink {
  /** MUST return synchronously and never throw: it is called from the tick path. */
  emit(delta: C3Delta): void;
  /** Deltas accepted (live: 2xx from the backend; local: retained). */
  readonly count: number;
  readonly mode: SinkMode;
  /** Deltas discarded (no-op sink, oversize, queue full, permanent 4xx, retries exhausted). */
  readonly dropped: number;
}

/** What is POSTed: the C3 delta plus a stable id for idempotent ingest. */
export interface DeltaEnvelope extends C3Delta {
  delta_id: string;
}

/** Used when no persistence URL is configured: counts and discards. */
export class NoopDeltaSink implements DeltaSink {
  readonly mode: SinkMode = 'noop';
  private _dropped = 0;
  constructor(log: (msg: string) => void = console.warn) {
    log('[persistence] no NETCODE_PERSISTENCE_URL configured — deltas are NOT persisted (no-op sink)');
  }
  emit(_delta: C3Delta): void { this._dropped++; }
  get count(): number { return 0; }
  get dropped(): number { return this._dropped; }
}

/** In-memory sink for tests. Bounded: keeps the most recent `max` deltas. */
export class LocalDeltaSink implements DeltaSink {
  readonly mode: SinkMode = 'local';
  private deltas: C3Delta[] = [];
  private total = 0;
  constructor(private max = 10_000) {}
  emit(delta: C3Delta): void {
    this.total++;
    this.deltas.push(delta);
    if (this.deltas.length > this.max) this.deltas.shift();
  }
  get count(): number { return this.total; }
  get dropped(): number { return 0; }
  get all(): C3Delta[] { return this.deltas; }
}

export interface HttpDeltaSinkOptions {
  baseUrl: string;
  ingestPath?: string;
  token?: string;
  maxRetries?: number;
  maxBodyBytes?: number;
  maxQueue?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  fetchImpl?: typeof fetch; // injectable for tests
  log?: (msg: string) => void;
}

/**
 * Live sink. Contract (what the backend must implement):
 *
 *   POST {baseUrl}{ingestPath}            (default path /persistence/delta)
 *   Content-Type: application/json
 *   Authorization: Bearer <NETCODE_PERSISTENCE_TOKEN>   (omitted if no token configured)
 *   Idempotency-Key: <delta_id>
 *   body: DeltaEnvelope — { delta_id, op, session_id, world_id, actor_entity_id,
 *                           actor_user_id?, tick, payload, ts }   (<= maxBodyBytes)
 *
 *   2xx           → accepted (backend should treat a repeated delta_id as success)
 *   408/429/5xx   → transient: retried with exponential backoff + jitter
 *                   (Retry-After seconds honoured, capped at backoffMaxMs)
 *   other 4xx     → permanent: logged, dropped, never retried
 *   network error / timeout → transient
 *
 * Never blocks the caller: emit() serializes, size-checks and enqueues
 * synchronously; all I/O happens on promise chains. Deltas for one session are
 * POSTed strictly in order (per-session FIFO), so a world's mutations apply in
 * tick order. Total pending work is bounded by maxQueue.
 */
export class HttpDeltaSink implements DeltaSink {
  readonly mode: SinkMode = 'live';
  readonly url: string;
  private token?: string;
  private accepted = 0;
  private _dropped = 0;
  private _pending = 0;
  private queues: Map<string, Promise<void>> = new Map();
  private maxRetries: number;
  private maxBodyBytes: number;
  private maxQueue: number;
  private timeoutMs: number;
  private backoffBaseMs: number;
  private backoffMaxMs: number;
  private fetchImpl: typeof fetch;
  private log: (msg: string) => void;
  private lastDropLog = 0;

  constructor(opts: HttpDeltaSinkOptions) {
    const base = opts.baseUrl.replace(/\/+$/, '');
    const p = opts.ingestPath || '/persistence/delta';
    this.url = `${base}${p.startsWith('/') ? p : '/' + p}`;
    this.token = opts.token || undefined;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxBodyBytes = opts.maxBodyBytes ?? 16 * 1024;
    this.maxQueue = opts.maxQueue ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 100;
    this.backoffMaxMs = opts.backoffMaxMs ?? 5000;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.log = opts.log || ((m) => console.error(m));
  }

  get count(): number { return this.accepted; }
  get dropped(): number { return this._dropped; }
  /** Deltas queued or in flight. */
  get pending(): number { return this._pending; }

  /** Resolves once every delta emitted so far has settled (tests / shutdown). */
  async drain(): Promise<void> {
    while (this.queues.size > 0) await Promise.allSettled(Array.from(this.queues.values()));
  }

  private drop(why: string) {
    this._dropped++;
    const now = Date.now();
    if (now - this.lastDropLog > 1000) { // rate-limit the log, never the counter
      this.lastDropLog = now;
      this.log(`[persistence] dropped delta: ${why} (dropped total ${this._dropped})`);
    }
  }

  emit(delta: C3Delta): void {
    try {
      const envelope: DeltaEnvelope = { ...delta, delta_id: crypto.randomUUID() };
      const body = JSON.stringify(envelope);
      const bytes = Buffer.byteLength(body);
      if (bytes > this.maxBodyBytes) { this.drop(`${delta.op} is ${bytes} bytes > ${this.maxBodyBytes}`); return; }
      if (this._pending >= this.maxQueue) { this.drop(`queue full (${this.maxQueue} pending)`); return; }
      this._pending++;
      const key = delta.session_id;
      const prev = this.queues.get(key) || Promise.resolve();
      const next = prev
        .then(() => this.post(envelope.delta_id, body))
        .then(
          () => { this.accepted++; },
          (err) => { this.drop(`${delta.op} tick=${delta.tick}: ${err instanceof Error ? err.message : String(err)}`); }
        )
        .finally(() => { this._pending--; });
      this.queues.set(key, next);
      void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
    } catch (err) {
      // Unserializable payload or similar — never let it reach the tick loop.
      this.drop(`emit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async post(deltaId: string, body: string): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': deltaId };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let retryAfterMs: number | null = null;
      try {
        const res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        // Always consume the body so the connection can be reused.
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw new PermanentPersistenceError(`backend rejected delta: HTTP ${res.status}`);
        }
        const ra = Number(res.headers.get('retry-after'));
        if (res.headers.has('retry-after') && Number.isFinite(ra) && ra >= 0) retryAfterMs = ra * 1000;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        if (err instanceof PermanentPersistenceError) throw err;
        lastErr = err; // network error / timeout → transient
      }
      if (attempt < this.maxRetries) {
        await sleep(Math.min(this.backoffMaxMs, retryAfterMs ?? backoffMs(attempt + 1, this.backoffBaseMs)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('persistence post failed');
  }
}

/** A non-retryable persistence failure (e.g. a 4xx bad payload). */
class PermanentPersistenceError extends Error {}

function backoffMs(attempt: number, base: number): number {
  // Exponential backoff with ±25% jitter: base, 2·base, 4·base, …
  const b = base * Math.pow(2, attempt - 1);
  return Math.max(0, Math.round(b + b * 0.25 * (Math.random() * 2 - 1)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the sink from env. Live when a URL is configured, else a no-op with a
 * logged warning. This is the single decision point for the live cutover.
 */
export function deltaSinkFromEnv(env: Record<string, string | undefined> = process.env, log: (msg: string) => void = console.warn): DeltaSink {
  const raw = (env.NETCODE_PERSISTENCE_URL || env.CW5_PERSISTENCE_URL || '').trim();
  if (!raw) return new NoopDeltaSink(log);
  let u: URL;
  try { u = new URL(raw); } catch {
    log('[persistence] NETCODE_PERSISTENCE_URL is not a valid URL — falling back to no-op sink');
    return new NoopDeltaSink(log);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    log('[persistence] NETCODE_PERSISTENCE_URL must be http(s) — falling back to no-op sink');
    return new NoopDeltaSink(log);
  }
  if (u.username || u.password) {
    log('[persistence] NETCODE_PERSISTENCE_URL must not embed credentials — use NETCODE_PERSISTENCE_TOKEN; falling back to no-op sink');
    return new NoopDeltaSink(log);
  }
  const token = env.NETCODE_PERSISTENCE_TOKEN || env.CW5_PERSISTENCE_TOKEN;
  if (!token) log('[persistence] no NETCODE_PERSISTENCE_TOKEN — deltas will be sent unauthenticated');
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    log('[persistence] plaintext http to a non-local host — the bearer token is exposed in transit');
  }
  const sink = new HttpDeltaSink({
    baseUrl: `${u.origin}${u.pathname === '/' ? '' : u.pathname}`,
    ingestPath: env.NETCODE_PERSISTENCE_PATH || env.CW5_INGEST_PATH,
    token,
    maxBodyBytes: intEnv(env.NETCODE_PERSISTENCE_MAX_BYTES, 16 * 1024, 1024, 1024 * 1024),
    maxQueue: intEnv(env.NETCODE_PERSISTENCE_MAX_QUEUE, 1000, 1, 100_000),
    timeoutMs: intEnv(env.NETCODE_PERSISTENCE_TIMEOUT_MS, 5000, 100, 60_000),
    maxRetries: intEnv(env.NETCODE_PERSISTENCE_MAX_RETRIES, 3, 0, 10),
  });
  console.log(`[persistence] live sink → ${sink.url}`);
  return sink;
}
