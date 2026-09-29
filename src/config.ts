// src/config.ts
// DCS Games CW4 Netcode — server limits from env. Pure, so it is unit-testable.
// Every value has a sane default and is clamped to a sane range; a malformed
// value falls back to the default rather than disabling the limit.

export interface ServerLimits {
  /** NETCODE_MAX_PLAYERS — seats per session (server ceiling). */
  maxPlayersPerSession: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
  maxPlayersPerSession: 16,
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
  };
}
