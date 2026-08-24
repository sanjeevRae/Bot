const rateLimit = require('express-rate-limit');

// Global API limiter — protects free-tier resources from abuse
const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: parseInt(process.env.RATE_LIMIT_PER_HOUR || '300', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// Stricter limiter for public chat endpoint (widget visitors)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN || '20', 10),
  message: { error: 'Chat rate limit reached. Please slow down.' },
});

module.exports = { apiLimiter, chatLimiter };
