// src/feature-flag.ts
// DCS Games CW4 Netcode — the multiplayer feature flag. Default OFF.
//
// Multiplayer is off for internal preview. With the flag off the real server
// (src/server.ts) serves nothing but a minimal /health: POST /sessions, the
// invite route and the /play upgrade all answer 404, no session manager is
// built and no persistence sink or replay source is created. Turning it on is
// an explicit, env-only act: NETCODE_MULTIPLAYER_ENABLED=1.

const TRUE_FLAGS = new Set(['1', 'true', 'yes', 'on']);

export interface MultiplayerFlag {
  enabled: boolean;
  reason: 'enabled' | 'flag_off';
}

export function multiplayerFlag(env: Record<string, string | undefined>): MultiplayerFlag {
  const raw = String(env.NETCODE_MULTIPLAYER_ENABLED ?? '').trim().toLowerCase();
  return TRUE_FLAGS.has(raw) ? { enabled: true, reason: 'enabled' } : { enabled: false, reason: 'flag_off' };
}
