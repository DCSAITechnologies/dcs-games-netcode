// src/config.ts
// DCS Games CW4 Netcode — server limits from env. Pure, so it is unit-testable.
// Every value has a sane default and is clamped to a sane range; a malformed
// value falls back to the default rather than disabling the limit.

export interface ServerLimits {
  /** NETCODE_MAX_PLAYERS — seats per session (server ceiling). */
  maxPlayersPerSession: number;
  /** NETCODE_MAX_SESSIONS — concurrent sessions per process. */
  maxSessions: number;
  /** NETCODE_SESSION_IDLE_MS — an empty session idle this long is closed. */
  sessionIdleMs: number;
  /** NETCODE_SESSION_GC_INTERVAL_MS — how often the GC sweeps. */
  sessionGcIntervalMs: number;
  /** NETCODE_MAX_WS_PAYLOAD — max bytes in one WebSocket frame; larger → close 1009. */
  maxWsPayload: number;
  /** NETCODE_MAX_HTTP_BODY — max HTTP request body bytes; larger → 413 + close. */
  maxHttpBody: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
  maxPlayersPerSession: 16,
  maxSessions: 500,
  sessionIdleMs: 60_000,
  sessionGcIntervalMs: 10_000,
  maxWsPayload: 64 * 1024,
  maxHttpBody: 16 * 1024,
};

/** Parse a positive integer env var, clamped to [min, max]; default on absence/garbage. */
export function intEnv(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function limitsFromEnv(env: Record<string, string | undefined>): ServerLimits {
  return {
    maxPlayersPerSession: intEnv(env.NETCODE_MAX_PLAYERS, DEFAULT_LIMITS.maxPlayersPerSession, 1, 256),
    maxSessions: intEnv(env.NETCODE_MAX_SESSIONS, DEFAULT_LIMITS.maxSessions, 1, 100_000),
    sessionIdleMs: intEnv(env.NETCODE_SESSION_IDLE_MS, DEFAULT_LIMITS.sessionIdleMs, 1_000, 24 * 3600_000),
    sessionGcIntervalMs: intEnv(env.NETCODE_SESSION_GC_INTERVAL_MS, DEFAULT_LIMITS.sessionGcIntervalMs, 100, 3600_000),
    maxWsPayload: intEnv(env.NETCODE_MAX_WS_PAYLOAD, DEFAULT_LIMITS.maxWsPayload, 1024, 16 * 1024 * 1024),
    maxHttpBody: intEnv(env.NETCODE_MAX_HTTP_BODY, DEFAULT_LIMITS.maxHttpBody, 256, 1024 * 1024),
  };
}
