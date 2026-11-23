const rateLimit = require('express-rate-limit');

/**
 * Rate limiters (2026-11-23 hardening).
 *
 * Before this change `apiLimiter` existed but was never mounted — only the
 * chat limiter actually ran, leaving every dashboard/admin/ingest endpoint
 * unthrottled in production. The limiters below are mounted in server.js:
 *
 *   - apiLimiter    — all authenticated dashboard/API routers (org, knowledge,
 *                     bookings, leads, analytics, inbox, broadcasts, agency,
 *                     admin). NOT applied to: /api/chat (own limiter),
 *                     /api/billing (payment project owns that surface),
 *                     webhooks (provider IPs are shared; they are protected
 *                     by signatures, not IP limits).
 *   - ingestLimiter — the expensive knowledge-ingest POSTs (crawl, upload,
 *                     refresh, youtube, drive, notion, text, structured):
 *                     each can trigger crawling/OCR/transcription/embedding.
 *   - chatLimiter   — public chat (per IP).
 *
 * Storage is in-memory (express-rate-limit default): correct for the current
 * single-instance deployment. Before running more than one backend instance,
 * move these to a shared store (e.g. rate-limit-redis) or limits will be
 * per-instance and trivially bypassed by load-balancer round-robin.
 *
 * IP source: Express `trust proxy` is set to 1 hop in server.js, so req.ip
 * is the client IP as reported by the single Render proxy hop — arbitrary
 * forwarded headers beyond that hop are not trusted.
 */

// Global API limiter — protects free-tier resources from abuse.
const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: parseInt(process.env.RATE_LIMIT_PER_HOUR || '1000', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// Expensive knowledge-ingest operations (crawl / upload / imports).
const ingestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: parseInt(process.env.INGEST_RATE_LIMIT_PER_HOUR || '60', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many knowledge imports. Please try again later.' },
});

// Stricter limiter for public chat endpoint (widget visitors)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN || '20', 10),
  message: { error: 'Chat rate limit reached. Please slow down.' },
});

module.exports = { apiLimiter, ingestLimiter, chatLimiter };
