const config = require('../config');

/**
 * Cloudflare Turnstile verification middleware.
 *
 * Free, unlimited, privacy-friendly CAPTCHA for the public chat endpoints.
 * Clients send the token as `cfTurnstile` (widget/bot page) or
 * `cf-turnstile-response` (standard forms) in the JSON body.
 *
 * Enforcement policy (2026-11-23 hardening — previously this middleware
 * silently skipped when unconfigured and failed OPEN on network errors, and
 * production was in fact issuing chat sessions with no verification at all):
 *   - Production + TURNSTILE_SECRET_KEY set: token is REQUIRED. Missing ->
 *     400, invalid/expired -> 403, verification-service error -> 503.
 *     Nothing fails open.
 *   - Production + secret NOT set: fail closed (503) — public chat stays
 *     disabled until the operator configures Turnstile, rather than running
 *     unprotected. Set TURNSTILE_SECRET_KEY (Render) + the site key
 *     (TURNSTILE_SITE_KEY on the backend for the widget/bot page,
 *     NEXT_PUBLIC_TURNSTILE_SITE_KEY on the frontend) to enable chat.
 *   - Non-production: skipped when unconfigured (local dev); when a secret
 *     IS configured it verifies normally but network errors fail open so a
 *     sandbox without internet still works.
 */

const TOKEN_MAX_AGE_MS = 5 * 60 * 1000; // Turnstile tokens live 5 minutes
let lastConfigWarnAt = 0;

async function verifyTurnstile(req, res, next) {
  const secret = config.turnstile.secretKey;
  const isProd = config.env === 'production';

  if (!secret) {
    if (isProd) {
      if (Date.now() - lastConfigWarnAt > 60_000) {
        lastConfigWarnAt = Date.now();
        console.warn('[turnstile] TURNSTILE_SECRET_KEY is not set — public chat is disabled (fail closed) until it is configured.');
      }
      return res.status(503).json({
        error: 'Chat is temporarily unavailable.',
        captcha_required: true,
      });
    }
    return next(); // local development only
  }

  // Widget sends the token under `cfTurnstile`; standard forms use the
  // default `cf-turnstile-response` field name.
  const token = req.body?.['cf-turnstile-response'] || req.body?.cfTurnstile;
  if (!token) {
    return res.status(400).json({ error: 'Captcha missing. Please complete the verification.', captcha_required: true });
  }

  try {
    const body = new URLSearchParams({
      secret,
      response: token,
      ...(req.ip ? { remoteip: req.ip } : {}),
    });

    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();

    if (!data.success) {
      return res.status(403).json({ error: 'Captcha verification failed. Please try again.', captcha_required: true });
    }
    // Reject stale tokens even if Cloudflare still calls them valid.
    if (data.challenge_ts) {
      const age = Date.now() - Date.parse(data.challenge_ts);
      if (Number.isFinite(age) && age > TOKEN_MAX_AGE_MS) {
        return res.status(403).json({ error: 'Captcha expired. Please try again.', captcha_required: true });
      }
    }
    next();
  } catch (e) {
    console.warn('[turnstile] verify error:', e.message);
    if (isProd) {
      // Fail closed: an unreachable verification service must not silently
      // disable bot protection in production.
      return res.status(503).json({ error: 'Verification unavailable. Please try again shortly.', captcha_required: true });
    }
    next();
  }
}

module.exports = { verifyTurnstile };
