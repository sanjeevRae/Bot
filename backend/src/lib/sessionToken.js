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
 */

const crypto = require('crypto');
const config = require('../config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hmac(orgId, sessionId) {
  return crypto
    .createHmac('sha256', config.session.secret)
    .update(`${orgId}.${sessionId}`)
    .digest('base64url');
}

/** Issue a fresh, unguessable session bound to an org. */
function issueSession(orgId) {
  const sessionId = crypto.randomUUID();
  return { sessionId, sessionToken: hmac(orgId, sessionId), expiresIn: 24 * 60 * 60 };
}

/**
 * Verify a token was issued by us for exactly this (orgId, sessionId) pair.
 * Returns { ok, reason } — never throws.
 */
function verifySession(orgId, sessionId, token) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    return { ok: false, reason: 'invalid_session_id' };
  }
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    return { ok: false, reason: 'missing_token' };
  }
  const expected = Buffer.from(hmac(orgId, sessionId));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'token_mismatch' };
  }
  return { ok: true };
}

module.exports = { issueSession, verifySession, UUID_RE };