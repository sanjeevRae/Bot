const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fileUpload = require('express-fileupload');
const config = require('./config');
const { apiLimiter, chatLimiter } = require('./middleware/rateLimit');
const { verifyTurnstile } = require('./middleware/turnstile');
const { startKeepAlive } = require('./services/keepAlive');

const app = express();

// ---------- Security & parsing ----------
app.use(helmet());
app.use(express.json({ limit: '2mb' }));
app.use(fileUpload({ limits: { fileSize: 6 * 1024 * 1024 } }));

// CORS — allow dashboard frontend + customer sites (widget)
app.use(
  cors({
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: true,
  })
);

// ---------- Routes ----------
app.get('/health', (req, res) => res.json({ ok: true, service: 'chitra-ai-backend', time: new Date().toISOString() }));

// Public chat endpoint — captcha-protected when Turnstile is configured
app.use('/api/chat', chatLimiter, verifyTurnstile, require('./routes/chat'));
app.use('/api/knowledge', require('./routes/knowledge'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/org', require('./routes/org'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/agency', require('./routes/agency'));
app.use('/api/admin', require('./routes/admin'));

// Widget loader + hosted bot page (public)
app.use('/', require('./routes/widget'));

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`Chitra AI backend running on port ${config.port} (${config.env})`);
  startKeepAlive();
});
