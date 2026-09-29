// src/auth.ts
// DCS Games CW4 Netcode — real token verification for the join handshake.
//
// The backend authenticates players with Supabase JWTs: HS256, signed with the
// project's shared JWT secret. This module verifies those tokens LOCALLY with
// node:crypto — the gateway's TokenVerifier seam is synchronous, so a network
// round-trip per join is not an option (and would couple every join to backend
// latency).
//
// What a token must satisfy to be accepted:
//   - exactly three base64url segments, <= MAX_TOKEN_LEN chars
//   - header.alg === "HS256" (never "none", never an asymmetric alg — no alg
//     confusion; the header is not allowed to choose the algorithm)
//   - HMAC-SHA256 signature matches, compared in constant time
//   - payload.sub is a non-empty string (it becomes the user_id)
//   - payload.exp is REQUIRED, and exp > now - skew
//   - payload.nbf, if present, <= now + skew
//   - payload.iat, if present, <= now + skew (a token "issued in the future" is forged or from a broken clock)
//   - payload.iss / payload.aud must match when an issuer / audience is configured
//
// Fail CLOSED: verifierFromEnv() returns a deny-all verifier when no secret is
// configured. The mock verifier ("tok:<user_id>") is only ever returned when
// NETCODE_ALLOW_MOCK_AUTH=1 AND NODE_ENV !== "production".

import crypto from 'node:crypto';
import type { TokenVerifier } from './gateway.js';

export const MAX_TOKEN_LEN = 8192;
export const DEFAULT_CLOCK_SKEW_SEC = 30;
/** Shorter secrets are refused outright — an HS256 key must not be guessable. */
export const MIN_SECRET_LEN = 32;

export interface Hs256VerifierOptions {
  secret: string;
  /** Required `iss` when set (Supabase: `https://<ref>.supabase.co/auth/v1`). */
  issuer?: string;
  /** Required `aud` when set (Supabase: `authenticated`). String or array-contains. */
  audience?: string;
  /** Allowed clock skew in seconds for exp/nbf/iat. Default 30. */
  clockSkewSec?: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

export type JwtFailure =
  | 'malformed'
  | 'too_long'
  | 'bad_alg'
  | 'bad_signature'
  | 'no_subject'
  | 'no_expiry'
  | 'expired'
  | 'not_yet_valid'
  | 'issued_in_future'
  | 'bad_issuer'
  | 'bad_audience';

export type JwtResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: JwtFailure };

function b64urlJson(seg: string): unknown {
  if (!/^[A-Za-z0-9_-]*$/.test(seg)) throw new Error('not base64url');
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Verify an HS256 JWT. Pure; never throws. */
export function verifyHs256Jwt(token: unknown, opts: Hs256VerifierOptions): JwtResult {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'malformed' };
  if (token.length > MAX_TOKEN_LEN) return { ok: false, reason: 'too_long' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, sig] = parts;

  let header: unknown;
  try { header = b64urlJson(h); } catch { return { ok: false, reason: 'malformed' }; }
  if (!isObj(header)) return { ok: false, reason: 'malformed' };
  // The server decides the algorithm, not the token.
  if (header.alg !== 'HS256') return { ok: false, reason: 'bad_alg' };

  const expected = crypto.createHmac('sha256', opts.secret).update(`${h}.${p}`).digest();
  let given: Buffer;
  if (!/^[A-Za-z0-9_-]+$/.test(sig)) return { ok: false, reason: 'bad_signature' };
  try { given = Buffer.from(sig, 'base64url'); } catch { return { ok: false, reason: 'bad_signature' }; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims: unknown;
  try { claims = b64urlJson(p); } catch { return { ok: false, reason: 'malformed' }; }
  if (!isObj(claims)) return { ok: false, reason: 'malformed' };

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return { ok: false, reason: 'no_subject' };

  const skew = Number.isFinite(opts.clockSkewSec) ? Math.max(0, opts.clockSkewSec as number) : DEFAULT_CLOCK_SKEW_SEC;
  const nowSec = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const exp = claims.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, reason: 'no_expiry' };
  if (exp <= nowSec - skew) return { ok: false, reason: 'expired' };
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf)) return { ok: false, reason: 'malformed' };
    if (claims.nbf > nowSec + skew) return { ok: false, reason: 'not_yet_valid' };
  }
  if (claims.iat !== undefined) {
    if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) return { ok: false, reason: 'malformed' };
    if (claims.iat > nowSec + skew) return { ok: false, reason: 'issued_in_future' };
  }
  if (opts.issuer !== undefined && claims.iss !== opts.issuer) return { ok: false, reason: 'bad_issuer' };
  if (opts.audience !== undefined) {
    const aud = claims.aud;
    const okAud = typeof aud === 'string' ? aud === opts.audience : Array.isArray(aud) && aud.includes(opts.audience);
    if (!okAud) return { ok: false, reason: 'bad_audience' };
  }
  return { ok: true, claims };
}

/** Build a TokenVerifier (the gateway seam) around verifyHs256Jwt. */
export function createHs256Verifier(opts: Hs256VerifierOptions): TokenVerifier {
  if (typeof opts.secret !== 'string' || opts.secret.length < MIN_SECRET_LEN) {
    throw new Error(`HS256 secret must be at least ${MIN_SECRET_LEN} characters`);
  }
  return (token: string) => {
    const r = verifyHs256Jwt(token, opts);
    if (!r.ok) return { valid: false, reason: r.reason };
    return { valid: true, user_id: r.claims.sub as string, claims: r.claims };
  };
}

/** Rejects every token. What the server runs with when auth is not configured. */
export const denyAllVerifier: TokenVerifier = () => ({ valid: false, reason: 'auth_unconfigured' });

/**
 * Sign an HS256 JWT. Used by tests and local tooling to mint tokens the
 * verifier accepts; production tokens are minted by the backend / Supabase.
 */
export function signHs256Jwt(secret: string, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}

export type AuthMode = 'hs256' | 'mock' | 'deny-all';

/**
 * The single decision point for which verifier the real server runs.
 *   NETCODE_JWT_SECRET set (>= 32 chars) → HS256 (NETCODE_JWT_ISSUER / NETCODE_JWT_AUDIENCE /
 *                                           NETCODE_JWT_CLOCK_SKEW_SEC optional)
 *   else NETCODE_ALLOW_MOCK_AUTH=1 and NODE_ENV != production → mock ("tok:<user_id>"), dev only
 *   else → deny-all (fail closed)
 * A secret that is set but too short is a misconfiguration → deny-all, never mock.
 */
export function verifierFromEnv(
  env: Record<string, string | undefined>,
  mock: TokenVerifier
): { verifier: TokenVerifier; mode: AuthMode; warning?: string } {
  const secret = env.NETCODE_JWT_SECRET;
  if (secret !== undefined && secret !== '') {
    if (secret.length < MIN_SECRET_LEN) {
      return { verifier: denyAllVerifier, mode: 'deny-all', warning: `NETCODE_JWT_SECRET is shorter than ${MIN_SECRET_LEN} chars — refusing all joins` };
    }
    const skewRaw = env.NETCODE_JWT_CLOCK_SKEW_SEC;
    const skew = skewRaw !== undefined && skewRaw !== '' && Number.isFinite(Number(skewRaw)) ? Math.min(300, Math.max(0, Number(skewRaw))) : DEFAULT_CLOCK_SKEW_SEC;
    return {
      verifier: createHs256Verifier({
        secret,
        issuer: env.NETCODE_JWT_ISSUER || undefined,
        audience: env.NETCODE_JWT_AUDIENCE || undefined,
        clockSkewSec: skew,
      }),
      mode: 'hs256',
    };
  }
  const allowMock = env.NETCODE_ALLOW_MOCK_AUTH === '1';
  if (allowMock && env.NODE_ENV !== 'production') {
    return { verifier: mock, mode: 'mock', warning: 'NETCODE_ALLOW_MOCK_AUTH=1 — accepting UNSIGNED "tok:<user_id>" tokens (dev only)' };
  }
  const warning = allowMock
    ? 'NETCODE_ALLOW_MOCK_AUTH=1 ignored because NODE_ENV=production; no NETCODE_JWT_SECRET → refusing all joins'
    : 'no NETCODE_JWT_SECRET configured → refusing all joins (fail closed)';
  return { verifier: denyAllVerifier, mode: 'deny-all', warning };
}
