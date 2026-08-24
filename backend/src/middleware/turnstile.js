const config = require('../config');

/**
 * Cloudflare Turnstile verification middleware (V3).
 *
 * Free, unlimited, privacy-friendly CAPTCHA. When TURNSTILE_SECRET_KEY is
 * not set, the check is skipped entirely so local dev works out of the box.
 *
 * Client sends: { "cf-turnstile-response": "<token>" } in the JSON body.
 */
async function verifyTurnstile(req, res, next) {
  const secret = config.turnstile.secretKey;
  if (!secret) return next(); // not configured — skip

  try {
    // Widget sends the token under `cfTurnstile`; standard forms use the
    // default `cf-turnstile-response` field name.
    const token = req.body?.['cf-turnstile-response'] || req.body?.cfTurnstile;
    if (!token) {
      return res.status(400).json({ error: 'Captcha missing. Please complete the verification.', captcha_required: true });
    }

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
    next();
  } catch (e) {
    // Fail open on network errors so a Turnstile outage never blocks signups
    console.warn('[turnstile] verify error:', e.message);
    next();
  }
}

module.exports = { verifyTurnstile };
