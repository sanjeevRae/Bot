const config = require('../config');

/**
 * OpenWA client — thin wrapper over the self-hosted OpenWA WhatsApp gateway REST API.
 *
 * Kept as a separate external service: OpenWA runs on the user's machine/Docker and is
 * reached from Render through a Cloudflare Tunnel. All calls authenticate with the
 * `X-API-Key` header (server-side only — never sent to the browser).
 *
 * Endpoint contracts follow the CURRENT OpenWA API (openapi.json / Swagger):
 *   POST /api/sessions/{sessionId}/messages/send-text  { chatId, text }
 *   POST /api/sessions/{sessionId}/webhooks            { url, events, secret }
 *   GET  /api/sessions, GET /api/sessions/{id}
 *   POST /api/sessions/{id}/start | /stop | /logout, GET /api/sessions/{id}/qr
 */

function baseUrl() {
  return (config.openwa.baseUrl || '').replace(/\/+$/, '');
}

function requireConfigured() {
  if (!baseUrl()) throw new Error('OpenWA base URL not configured (OPENWA_BASE_URL)');
  if (!config.openwa.apiKey) throw new Error('OpenWA API key not configured (OPENWA_API_KEY)');
}

/** Core request helper. Returns parsed JSON (or raw text when the body is not JSON). */
async function request(path, { method = 'GET', body } = {}) {
  requireConfigured();
  const headers = { 'X-API-Key': config.openwa.apiKey };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw Object.assign(new Error(`OpenWA unavailable: ${err.message}`), { status: 502 });
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg =
      (data && (data.message || data.error)) ||
      `OpenWA request failed (${res.status})`;
    throw Object.assign(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)), {
      status: res.status,
      raw: data,
    });
  }
  return data;
}

async function listSessions() {
  return request('/api/sessions');
}

async function getSession(sessionId) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

async function startSession(sessionId) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/start`, { method: 'POST' });
}

async function stopSession(sessionId) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
}

async function logoutSession(sessionId) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/logout`, { method: 'POST' });
}

async function getQr(sessionId) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/qr`);
}

/**
 * Send a text message on a session.
 * @param {string} sessionId OpenWA session id
 * @param {string} chatId Recipient JID, e.g. "628123456789@c.us"
 * @param {string} text Body (OpenWA caps at 4096 chars)
 */
async function sendText(sessionId, chatId, text) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, {
    method: 'POST',
    body: { chatId, text },
  });
}

/** Register a webhook (or rely on an existing one). events defaults to message.received. */
async function registerWebhook(sessionId, url, secret, events = ['message.received']) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/webhooks`, {
    method: 'POST',
    body: { url, events, secret },
  });
}

async function listWebhooks(sessionId) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/webhooks`);
}

/**
 * Resolve a privacy-id sender (`@lid`) to its real phone digits.
 * Returns the phone digits (e.g. "9779810135468") or null when unmappable.
 * Used because WhatsApp increasingly delivers senders as `@lid` JIDs that
 * cannot be used as send targets directly.
 */
async function resolvePhone(sessionId, contactId) {
  try {
    const data = await request(
      `/api/sessions/${encodeURIComponent(sessionId)}/contacts/${encodeURIComponent(contactId)}/phone`
    );
    const phone = data && (data.phone || data.phoneNumber || data.number);
    return typeof phone === 'string' && phone.trim() ? phone.trim() : null;
  } catch {
    return null; // best-effort: callers fall back to the raw JID
  }
}

module.exports = {
  listSessions,
  getSession,
  startSession,
  stopSession,
  logoutSession,
  getQr,
  sendText,
  registerWebhook,
  listWebhooks,
  resolvePhone,
};