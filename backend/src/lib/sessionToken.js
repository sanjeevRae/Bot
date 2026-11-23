'use strict';

/**
 * Server-issued chat session credentials.
 *
 * Every chat session is created BY THE SERVER and bound to its organization
 * with an HMAC token. The widget cannot invent a session id, and it cannot
 * use a session id it was not issued for — the timing-safe token check fails.
 * This is what isolates visitor A's conversation from visitor B's, even when
 * both chat with the same business's bot.
 *
 * Stateless: no DB row, no memory — the token authenticates the
 * (orgId, sessionId) pair anywhere until the secret rotates.
 *
 * Token format (v2, 2026-11-23 hardening): `<issuedAtSeconds>.<hmac>` where
 * the HMAC covers `orgId.sessionId.issuedAtSeconds`. The embedded issued-at
 * gives the token a REAL server-side expiry (24 h, matching the advertised
 * `expiresIn`): before this change the token carried no timestamp, so a
 * leaked (orgId, sessionId, token) triple stayed valid forever. Legacy v1
 * tokens (bare HMAC, no dot) are rejected as `token_mismatch`, which the
 * widget already handles by minting a fresh session and retrying once — so
 * upgrading invalidates live visitor sessions exactly once, self-healing.
 */

const crypto = require('crypto');
const config = require('../config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-side session lifetime: 24 hours from issuance. */
const SESSION_TTL_SECONDS = 24 * 60 * 60;
/** Small allowance for clock skew between issuer and verifier (same process today). */
const CLOCK_SKEW_SECONDS = 60;

function hmac(orgId, sessionId, issuedAt) {
  return crypto
    .createHmac('sha256', config.session.secret)
    .update(`${orgId}.${sessionId}.${issuedAt}`)
    .digest('base64url');
}

/** Issue a fresh, unguessable session bound to an org. */
function issueSession(orgId) {
  const sessionId = crypto.randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    sessionId,
    sessionToken: `${issuedAt}.${hmac(orgId, sessionId, issuedAt)}`,
    expiresIn: SESSION_TTL_SECONDS,
  };
}

/**
 * Verify a token was issued by us for exactly this (orgId, sessionId) pair
 * and has not expired. Returns { ok, reason } — never throws.
 * Reasons: invalid_session_id | missing_token | token_mismatch | session_expired
 */
function verifySession(orgId, sessionId, token) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    return { ok: false, reason: 'invalid_session_id' };
  }
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    return { ok: false, reason: 'missing_token' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0) {
    // Legacy v1 token (no issued-at) or malformed — reject; clients remint.
    return { ok: false, reason: 'token_mismatch' };
  }
  const issuedAt = Number(token.slice(0, dot));
  const given = token.slice(dot + 1);
  if (!Number.isInteger(issuedAt) || issuedAt <= 0 || !given) {
    return { ok: false, reason: 'token_mismatch' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (issuedAt > now + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'token_mismatch' };
  }
  if (now - issuedAt > SESSION_TTL_SECONDS) {
    return { ok: false, reason: 'session_expired' };
  }
  const expected = Buffer.from(hmac(orgId, sessionId, issuedAt));
  const givenBuf = Buffer.from(given);
  if (expected.length !== givenBuf.length || !crypto.timingSafeEqual(expected, givenBuf)) {
    return { ok: false, reason: 'token_mismatch' };
  }
  return { ok: true };
}

module.exports = { issueSession, verifySession, UUID_RE, SESSION_TTL_SECONDS };
