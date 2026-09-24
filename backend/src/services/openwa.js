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
const phoneCache = new Map();
const PHONE_TTL_MS = 30 * 60 * 1000;
const PHONE_FAIL_TTL_MS = 2 * 60 * 1000;

async function resolvePhone(sessionId, contactId) {
  if (!contactId) return null;
  // Stable mapping, but a `@lid` sender posts on every message — cache it.
  const key = `${sessionId}|${contactId}`;
  const hit = phoneCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.phone;

  let phone = null;
  try {
    const data = await request(
      `/api/sessions/${encodeURIComponent(sessionId)}/contacts/${encodeURIComponent(contactId)}/phone`
    );
    const value = data && (data.phone || data.phoneNumber || data.number);
    phone = typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    phone = null; // best-effort: callers fall back to the raw JID
  }

  phoneCache.set(key, { phone, at: Date.now(), ttl: phone ? PHONE_TTL_MS : PHONE_FAIL_TTL_MS });
  if (phoneCache.size > 2000) {
    const now = Date.now();
    for (const [k, entry] of phoneCache) if (now - entry.at >= entry.ttl) phoneCache.delete(k);
  }
  return phone;
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

// ------------------------------------------------------------------
// Our own privacy ids (`@lid`). On LID-addressed accounts WhatsApp reports a
// mention of this session as `@<lid>`, not as its phone number, so the number
// alone cannot answer "was I mentioned?" — these are learned, never assumed:
//   - from our own outbound echoes (`from` is our own JID there), and
//   - from a group roster, where a participant carries both `number` and `id`.
// Kept per session in memory; a restart simply relearns on the next mention.
// ------------------------------------------------------------------
const ownLidsBySession = new Map(); // sessionId -> Set(lowercase jid)
const rosterCache = new Map(); // `${sessionId}|${groupId}` -> { lid, at, ttl }

function getOwnLids(sessionId) {
  return Array.from(ownLidsBySession.get(sessionId) || []);
}

/** Remember one of our own `@lid`s (no-op for anything that is not a LID). */
function learnOwnLid(sessionId, jid) {
  const value = String(jid || '').trim().toLowerCase();
  if (!sessionId || !value.endsWith('@lid')) return getOwnLids(sessionId);
  const set = ownLidsBySession.get(sessionId) || new Set();
  set.add(value);
  ownLidsBySession.set(sessionId, set);
  return getOwnLids(sessionId);
}

/**
 * Find this session's own participant entry in a group and remember its privacy
 * id. Deterministic (the roster pairs `number` with `id`) and cached per group,
 * so it runs at most once per group per TTL — only when a mention could not be
 * matched any other way.
 */
async function learnOwnLidFromGroup(sessionId, groupId, ownDigits) {
  if (!sessionId || !groupId || !ownDigits) return null;
  const key = `${sessionId}|${groupId}`;
  const hit = rosterCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.lid;

  let lid = null;
  try {
    const info = await request(
      `/api/sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(groupId)}`
    );
    const participants = Array.isArray(info && info.participants) ? info.participants : [];
    const mine = participants.find(
      (p) => String(p && p.number || '').replace(/\D/g, '') === String(ownDigits)
    );
    const id = (mine && String(mine.id || '')) || '';
    if (id.endsWith('@lid')) lid = id;
  } catch (err) {
    console.warn('[openwa] group roster lookup failed:', err.message);
  }

  rosterCache.set(key, { lid, at: Date.now(), ttl: lid ? OWN_ID_TTL_MS : OWN_ID_FAIL_TTL_MS });
  if (lid) learnOwnLid(sessionId, lid);
  return lid;
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
  getOwnLids,
  learnOwnLid,
  learnOwnLidFromGroup,
};