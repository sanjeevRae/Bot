const config = require('../config');
const diag = require('../lib/openwaDiagnostics');

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
 * @param {string} chatId Recipient JID, e.g. "628123456789@c.us" or "<id>@g.us"
 * @param {string} text Body (OpenWA caps at 4096 chars)
 * @param {object} [opts]
 * @param {string[]} [opts.mentions] WIDs to @mention. WhatsApp also needs the
 *   literal `@<number>` token inside `text`, which channelSend prepends for group
 *   replies (see lib/openwaInbound.js).
 * @param {string} [opts.quotedMessageId] Quote an earlier message. The id is
 *   engine-specific and an unresolvable one fails the send instead of degrading,
 *   so callers leave it unset unless they know the engine.
 */
async function sendText(sessionId, chatId, text, opts = {}) {
  const mentions = Array.isArray(opts.mentions) ? opts.mentions.filter(Boolean) : [];
  const isGroup = String(chatId || '').endsWith('@g.us');
  try {
    const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, {
      method: 'POST',
      body: {
        chatId,
        text,
        ...(mentions.length ? { mentions } : {}),
        ...(opts.quotedMessageId ? { quotedMessageId: opts.quotedMessageId } : {}),
      },
    });
    // Group sends are both rare and the most likely thing to break, so the outcome
    // is remembered for GET /api/org/openwa/diagnostics.
    if (isGroup) {
      diag.record({ kind: 'send', chatId, mentions: mentions.length, ok: true, chars: String(text || '').length });
    }
    return result;
  } catch (err) {
    if (isGroup) {
      diag.record({ kind: 'send', chatId, mentions: mentions.length, ok: false, error: err.message });
    }
    throw err;
  }
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
 * Groups this session is a member of, normalised to `{ id, name, participants }`.
 * Gateways differ on the envelope (`[]`, `{ groups: [] }`, `{ data: [] }`) and on
 * the field names, so every known shape is accepted and unknown ones are dropped
 * rather than surfaced as broken rows.
 */
async function listGroups(sessionId) {
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/groups`);
  const rows = Array.isArray(data)
    ? data
    : (data && (data.groups || data.data)) || [];
  return rows.slice(0, 50).map((g) => ({
    id: g.id || g.groupId || g.chatId || null,
    name: g.name || g.subject || g.title || null,
    participants: Array.isArray(g.participants) ? g.participants.length : (g.participantCount ?? null),
  })).filter((g) => g.id);
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

// ------------------------------------------------------------------
// The session's own identity, needed to tell "this bot was @-mentioned in the
// group" from "somebody else was". `GET /sessions/:id` exposes the linked number
// as `phone` and the WhatsApp display name as `pushName` (some builds render a
// mention as "@<name>" instead of "@<number>").
// One lookup is cached because a chatty group would otherwise ask the gateway on
// every message; failures get a short TTL so a down gateway is not hammered.
// Callers treat an empty result as "mentions cannot be verified": group messages
// are then ignored rather than answered on a guess (see lib/openwaInbound.js) —
// which is why routes/openwa.js prefers the org's stored number over this.
// ------------------------------------------------------------------
const ownIdCache = new Map();
const OWN_ID_TTL_MS = 10 * 60 * 1000;
const OWN_ID_FAIL_TTL_MS = 60 * 1000;

async function getOwnIdentity(sessionId) {
  const hit = ownIdCache.get(sessionId);
  if (hit && Date.now() - hit.at < hit.ttl) return { digits: hit.digits, pushName: hit.pushName };

  let digits = null;
  let pushName = null;
  try {
    const session = await getSession(sessionId);
    const phone = session && (session.phone || session.phoneNumber);
    digits = phone ? String(phone).replace(/\D/g, '') || null : null;
    pushName = (session && typeof session.pushName === 'string' && session.pushName.trim()) || null;
  } catch (err) {
    console.warn('[openwa] own-identity lookup failed:', err.message);
  }

  ownIdCache.set(sessionId, {
    digits,
    pushName,
    at: Date.now(),
    ttl: digits || pushName ? OWN_ID_TTL_MS : OWN_ID_FAIL_TTL_MS,
  });
  if (ownIdCache.size > 500) {
    const now = Date.now();
    for (const [key, entry] of ownIdCache) if (now - entry.at >= entry.ttl) ownIdCache.delete(key);
  }
  return { digits, pushName };
}

/** Digits of the session's own number, or null when the gateway does not expose it. */
async function getOwnId(sessionId) {
  return (await getOwnIdentity(sessionId)).digits;
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
  listGroups,
  resolvePhone,
  getOwnId,
  getOwnIdentity,
};