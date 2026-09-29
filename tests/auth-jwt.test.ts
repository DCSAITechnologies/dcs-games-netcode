// tests/auth-jwt.test.ts
// DCS Games CW4 Netcode — real auth seam (HS256 JWT) + fail-closed env selection.
// Pure/in-memory: no sockets, no network.

import crypto from 'node:crypto';
import {
  verifyHs256Jwt,
  createHs256Verifier,
  signHs256Jwt,
  verifierFromEnv,
  denyAllVerifier,
  MAX_TOKEN_LEN,
} from '../src/auth';
import { Gateway, mockTokenVerifier, Transport } from '../src/gateway';
import { SessionManager } from '../src/session';
import type { OutboundFrame } from '../src/types';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (extra ? '  — ' + extra : '')); }
};

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const NOW_MS = 1_800_000_000_000;
const now = Math.floor(NOW_MS / 1000);
const opts = { secret: SECRET, now: () => NOW_MS };
const good = (extra: Record<string, unknown> = {}) => signHs256Jwt(SECRET, { sub: 'user-1', iat: now, exp: now + 300, ...extra });
const reason = (t: unknown, o: any = opts) => { const r = verifyHs256Jwt(t, o); return r.ok ? 'ok' : r.reason; };

function run(): boolean {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  DCS GAMES CW4 — AUTH (HS256 JWT) + FAIL-CLOSED   ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // ===== Signature + algorithm =====
  check('valid HS256 token accepted', reason(good()) === 'ok');
  const r = verifyHs256Jwt(good(), opts);
  check('sub surfaces as claim', r.ok && r.claims.sub === 'user-1');
  check('wrong secret → bad_signature', reason(signHs256Jwt('another-secret-0123456789abcdef0123456789', { sub: 'u', exp: now + 60 })) === 'bad_signature');
  const [h, p] = good().split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'admin', iat: now, exp: now + 300 })).toString('base64url');
  check('payload swapped under original signature → bad_signature', reason(`${h}.${tamperedPayload}.${good().split('.')[2]}`) === 'bad_signature');
  const noneTok = signHs256Jwt(SECRET, { sub: 'u', exp: now + 60 }, { alg: 'none', typ: 'JWT' });
  check('alg "none" rejected (even with a valid-looking signature)', reason(noneTok) === 'bad_alg');
  check('alg "none" with empty signature rejected', reason(noneTok.split('.').slice(0, 2).join('.') + '.') === 'bad_alg');
  check('alg HS512 rejected', reason(signHs256Jwt(SECRET, { sub: 'u', exp: now + 60 }, { alg: 'HS512' })) === 'bad_alg');
  check('alg RS256 rejected', reason(signHs256Jwt(SECRET, { sub: 'u', exp: now + 60 }, { alg: 'RS256' })) === 'bad_alg');
  check('header without alg rejected', reason(signHs256Jwt(SECRET, { sub: 'u', exp: now + 60 }, { typ: 'JWT' })) === 'bad_alg');
  check('truncated signature rejected', reason(good().slice(0, -3)) === 'bad_signature');
  check('two-segment token → malformed', reason(`${h}.${p}`) === 'malformed');
  check('garbage → malformed', reason('tok:alice') === 'malformed');
  check('non-string → malformed', reason(12345) === 'malformed' && reason(undefined) === 'malformed');
  check('oversized token → too_long', reason('a'.repeat(MAX_TOKEN_LEN + 1)) === 'too_long');
  check('non-JSON payload (validly signed) → malformed', (() => {
    const hh = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const pp = Buffer.from('not json').toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(`${hh}.${pp}`).digest('base64url');
    return reason(`${hh}.${pp}.${sig}`) === 'malformed';
  })());

  // ===== Claims =====
  check('missing sub → no_subject', reason(signHs256Jwt(SECRET, { exp: now + 60 })) === 'no_subject');
  check('numeric sub → no_subject', reason(signHs256Jwt(SECRET, { sub: 12345, exp: now + 60 })) === 'no_subject');
  check('empty sub → no_subject', reason(signHs256Jwt(SECRET, { sub: '', exp: now + 60 })) === 'no_subject');
  check('missing exp → no_expiry (a token that cannot expire is refused)', reason(signHs256Jwt(SECRET, { sub: 'u' })) === 'no_expiry');
  check('string exp → no_expiry', reason(signHs256Jwt(SECRET, { sub: 'u', exp: String(now + 60) })) === 'no_expiry');
  check('expired beyond skew → expired', reason(good({ exp: now - 31 })) === 'expired');
  check('expired within 30s skew → accepted', reason(good({ exp: now - 10 })) === 'ok');
  check('skew 0: exp == now → expired', reason(good({ exp: now }), { ...opts, clockSkewSec: 0 }) === 'expired');
  check('nbf in the future beyond skew → not_yet_valid', reason(good({ nbf: now + 120 })) === 'not_yet_valid');
  check('nbf within skew → accepted', reason(good({ nbf: now + 5 })) === 'ok');
  check('iat in the future beyond skew → issued_in_future', reason(good({ iat: now + 120 })) === 'issued_in_future');
  check('non-numeric iat → malformed', reason(good({ iat: 'yesterday' })) === 'malformed');
  check('issuer enforced when configured', reason(good({ iss: 'evil' }), { ...opts, issuer: 'https://x.supabase.co/auth/v1' }) === 'bad_issuer');
  check('issuer match accepted', reason(good({ iss: 'https://x.supabase.co/auth/v1' }), { ...opts, issuer: 'https://x.supabase.co/auth/v1' }) === 'ok');
  check('missing iss rejected when issuer configured', reason(good(), { ...opts, issuer: 'https://x.supabase.co/auth/v1' }) === 'bad_issuer');
  check('audience enforced (string)', reason(good({ aud: 'anon' }), { ...opts, audience: 'authenticated' }) === 'bad_audience');
  check('audience array containing expected accepted', reason(good({ aud: ['x', 'authenticated'] }), { ...opts, audience: 'authenticated' }) === 'ok');

  // ===== TokenVerifier seam =====
  const v = createHs256Verifier(opts);
  const vr = v(good());
  check('verifier → {valid, user_id=sub}', vr.valid === true && vr.user_id === 'user-1');
  check('verifier rejects mock-style token', v('tok:alice').valid === false);
  let threw = false;
  try { createHs256Verifier({ secret: 'short' }); } catch { threw = true; }
  check('secret < 32 chars refused at construction', threw);

  // ===== Env selection (fail closed) =====
  const e1 = verifierFromEnv({}, mockTokenVerifier);
  check('no secret, no flag → deny-all', e1.mode === 'deny-all' && e1.verifier('tok:alice').valid === false);
  const e2 = verifierFromEnv({ NETCODE_ALLOW_MOCK_AUTH: '1' }, mockTokenVerifier);
  check('mock flag outside production → mock (dev only)', e2.mode === 'mock' && e2.verifier('tok:alice').valid === true);
  const e3 = verifierFromEnv({ NETCODE_ALLOW_MOCK_AUTH: '1', NODE_ENV: 'production' }, mockTokenVerifier);
  check('mock flag with NODE_ENV=production → deny-all', e3.mode === 'deny-all' && e3.verifier('tok:alice').valid === false);
  const e4 = verifierFromEnv({ NETCODE_ALLOW_MOCK_AUTH: 'true' }, mockTokenVerifier);
  check('mock flag must be exactly "1"', e4.mode === 'deny-all');
  const e5 = verifierFromEnv({ NETCODE_JWT_SECRET: SECRET, NETCODE_ALLOW_MOCK_AUTH: '1' }, mockTokenVerifier);
  check('secret set → hs256 (wins over mock flag; mock tokens refused)', e5.mode === 'hs256' && e5.verifier('tok:alice').valid === false);
  check('secret set → real token accepted (wall clock)', e5.verifier(signHs256Jwt(SECRET, { sub: 'u', exp: Math.floor(Date.now() / 1000) + 60 })).valid === true);
  const e6 = verifierFromEnv({ NETCODE_JWT_SECRET: 'too-short', NETCODE_ALLOW_MOCK_AUTH: '1' }, mockTokenVerifier);
  check('short secret → deny-all (never falls back to mock)', e6.mode === 'deny-all' && e6.verifier('tok:alice').valid === false);
  const e7 = verifierFromEnv({ NETCODE_JWT_SECRET: SECRET, NETCODE_JWT_AUDIENCE: 'authenticated' }, mockTokenVerifier);
  check('NETCODE_JWT_AUDIENCE enforced', e7.verifier(signHs256Jwt(SECRET, { sub: 'u', exp: Math.floor(Date.now() / 1000) + 60 })).valid === false);
  check('denyAllVerifier rejects everything', denyAllVerifier('anything').valid === false);

  // ===== Gateway binds ticket claims (world_id / session_id) =====
  const sm = new SessionManager(() => {});
  const gw = new Gateway(sm, createHs256Verifier({ secret: SECRET }));
  const s = sm.createSession('world-a');
  const mkT = () => { const out: OutboundFrame[] = []; let closed = false; const t: Transport = { send: (f) => out.push(f), close: () => { closed = true; } }; return { t, out, get closed() { return closed; } }; };
  const wall = Math.floor(Date.now() / 1000);
  const c1 = mkT();
  gw.handleFrame(c1.t, { type: 'join', token: signHs256Jwt(SECRET, { sub: 'amy', exp: wall + 60, world_id: 'world-b' }), world_id: 'world-a', session_id: s.session_id });
  check('ticket for another world_id → auth error + close', c1.out[0]?.type === 'error' && (c1.out[0] as any).code === 'auth' && c1.closed);
  const c2 = mkT();
  gw.handleFrame(c2.t, { type: 'join', token: signHs256Jwt(SECRET, { sub: 'amy', exp: wall + 60, world_id: 'world-a', session_id: s.session_id }), world_id: 'world-a', session_id: s.session_id });
  check('ticket matching world_id + session_id → joined', c2.out[0]?.type === 'joined');
  const c3 = mkT();
  gw.handleFrame(c3.t, { type: 'join', token: signHs256Jwt(SECRET, { sub: 'bo', exp: wall + 60 }), world_id: 'world-a', session_id: s.session_id });
  check('plain access token (no world claim) → joined', c3.out[0]?.type === 'joined');
  const c4 = mkT();
  gw.handleFrame(c4.t, { type: 'join', token: signHs256Jwt(SECRET, { sub: 'cy', exp: wall - 3600 }), world_id: 'world-a', session_id: s.session_id });
  check('expired token over the gateway → auth error', c4.out[0]?.type === 'error' && (c4.out[0] as any).code === 'auth');
  sm.closeSession(s.session_id);

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log(`║  ${pass} passed, ${fail} failed / ${pass + fail} checks`.padEnd(52) + '║');
  console.log(`║  AUTH-JWT: ${fail === 0 ? '🎉 GREEN (PASS)' : '⚠️  RED (FAIL)'}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  return fail === 0;
}

process.exit(run() ? 0 : 1);
