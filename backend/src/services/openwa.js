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
 *
 * V11 additions: media delivery (sendImage/sendDocument/sendLocation), a
 * media download helper for inbound voice notes/photos, and session-targeted
 * helpers used by the handoff "owner reply" path.
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

/**
 * Send an image on a session (menu photo, receipt). `image` accepts a public
 * URL ({ imageUrl }) or base64 ({ imageBase64 }) depending on the gateway
 * build; caption is best-effort.
 */
async function sendImage(sessionId, chatId, imageUrl, caption) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/messages/send-image`, {
    method: 'POST',
    body: {
      chatId,
      ...(imageUrl ? { imageUrl } : {}),
      ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
    },
  });
}

/** Send a document on a session (price-list PDF). */
async function sendDocument(sessionId, chatId, documentUrl, caption) {
  const filename = String(documentUrl || '').split('/').pop().split('?')[0].slice(0, 120) || 'document.pdf';
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/messages/send-document`, {
    method: 'POST',
    body: {
      chatId,
      documentUrl,
      filename,
      ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
    },
  });
}

/** Send a location pin on a session (shop / delivery point). */
async function sendLocation(sessionId, chatId, latitude, longitude, name) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/messages/send-location`, {
    method: 'POST',
    body: {
      chatId,
      latitude: Number(latitude),
      longitude: Number(longitude),
      ...(name ? { name: String(name).slice(0, 200) } : {}),
    },
  });
}

/**
 * Fetch inbound media bytes through the gateway (voice note → Buffer for
 * Whisper, photo → Buffer for OCR). Returns null when the gateway build has
 * no media endpoint — the caller then falls back to the one-line reply.
 */
async function downloadMedia(sessionId, messageId) {
  if (!messageId) return null;
  try {
    const data = await request(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/media`
    );
    // Gateway builds differ: base64 string, { data }, { base64 }, or a URL.
    if (typeof data === 'string' && data.length > 100) return Buffer.from(data, 'base64');
    const b64 = data && (data.base64 || data.data);
    if (typeof b64 === 'string' && b64.length > 100) return Buffer.from(b64, 'base64');
    if (data && data.url) {
      const res = await fetch(data.url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    }
    return null;
  } catch (err) {
    console.warn('[openwa] media download failed:', err.message);
    return null;
  }
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
  sendImage,
  sendDocument,
  sendLocation,
  downloadMedia,
  registerWebhook,
  listWebhooks,
  resolvePhone,
};