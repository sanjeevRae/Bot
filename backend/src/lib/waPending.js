/**
 * Pending-message tracker for the OpenWA gateway — the "Muse mode" half of the
 * `WHATSAPP_AUTO_REPLY` switch (see routes/openwa.js).
 *
 * With the switch OFF the backend never answers WhatsApp itself. Instead it
 * counts every incoming message per chat here, and clears a chat the moment one
 * of our own outbound messages to that chat is observed (the gateway echoes our
 * sends back on the same `message.received` event with `fromMe: true`). That is
 * the whole acknowledgement protocol: no ack API, no tokens spent while quiet.
 * Muse's event hook then only has to ask `GET /wa-pending` whether anything
 * happened, reads the real messages from the OpenWA API when it did, and replies
 * there — so the gateway stays the single source of truth for message content.
 *
 * Deliberately:
 *   - content-free — chatId + count + timestamps only, never body text, which is
 *     what lets the status endpoint stay unauthenticated; and
 *   - bounded — old chats are dropped once the map hits its cap, so a busy
 *     month cannot grow the process; and
 *   - in memory — a restart drops the counts. That is safe because the count is
 *     only a wake-up signal (OpenWA still holds the messages); in practice the
 *     hook's frequent polls are also what keeps the Render free tier awake.
 *
 * Session readiness ("is the WhatsApp link up?") is answered from the cheapest
 * evidence available, in order:
 *   1. lifecycle webhook events (`session.connected` / `session.disconnected`),
 *   2. an incoming message, which proves the link works,
 *   3. a cached `GET /sessions/{id}` probe, refreshed at most once per TTL and
 *      only from a status poll — never on the hot path of a webhook.
 * `session_ready` is only reported `false` on real evidence: an authoritative
 * "down" status, or a run of consecutive probe failures. Unknown reads as up, so
 * a cold process never makes Muse send Meena a false outage alert.
 */

const config = require('../config');


/** Cap on tracked chats — oldest (least recently active) are dropped first. */
const PENDING_MAX_CHATS = Math.max(1, parseInt(process.env.WA_PENDING_MAX_CHATS || '1000', 10) || 1000);
/** How long a session probe result is trusted before the next poll re-checks. */
const READY_TTL_MS = Math.max(1000, parseInt(process.env.WA_SESSION_REFRESH_MS || '20000', 10) || 20000);
/** On a cold process, how long a status poll waits for a first real answer. */
const READY_WAIT_MS = Math.max(0, parseInt(process.env.WA_SESSION_WAIT_MS || '1500', 10) || 0);
/** Consecutive failed probes before the link is called down (blip tolerance). */
const READY_DOWN_AFTER_FAILURES = Math.max(1, parseInt(process.env.WA_SESSION_DOWN_AFTER || '2', 10) || 2);
/** How long a `whatsapp_connections` → session id lookup is reused. */
const SESSION_LOOKUP_TTL_MS = 5 * 60 * 1000;

/** Gateway statuses that mean the session can send and receive. */
const UP_STATUS = /^(connected|ready|open|authenticated|online|working|live|active)$/;
/** Gateway statuses that mean it cannot (QR = not scanned, unpaired = logged out). */
const DOWN_STATUS = /^(disconnected|stopped|closed|logout|logged_out|unpaired|qr|qr_code|qrcode|scan_qr|error|failed|timeout|offline)$/;
const UP_EVENT = /(connect|ready|authenticat|online|resume|start)/i;
const DOWN_EVENT = /(disconnect|logout|unpaired|qr|error|fail|stop|close|timeout)/i;

/** `${sessionId}|${chatId}` → { sessionId, chatId, count, firstAt, lastAt } */
const pending = new Map();

const readiness = { ready: null, status: null, at: 0, failures: 0, sessionId: null };
const sessionLookup = { value: null, at: 0 };

let inflightRefresh = null;

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

/** A JID ("97798…@c.us", "123…@g.us") or null for anything malformed/bare. */
function normalizeJid(value) {
  const s = String(value == null ? '' : value).trim();
  return s.includes('@') ? s : null;
}

/** Digits of a JID/phone — used to match the same chat across JID forms. */
function digitsOf(value) {
  return String(value == null ? '' : value).split('@')[0].replace(/\D/g, '');
}

function entryKey(sessionId, chatId) {
  return `${sessionId}|${chatId}`;
}

/** The chat an inbound message belongs to: `chatId` wins, `from` is the fallback. */
function inboundChatIdOf(data) {
  return normalizeJid(data && (data.chatId || data.from));
}

/**
 * Where an outbound (our own) message could be addressed. `from` is skipped on
 * purpose: on an echo it is this session's own JID, never a conversation.
 */
function outboundChatIdsOf(data) {
  const seen = new Set();
  const out = [];
  [data && data.chatId, data && data.to, data && data.recipient].forEach((c) => {
    const jid = normalizeJid(c);
    if (jid && !seen.has(jid)) {
      seen.add(jid);
      out.push(jid);
    }
  });
  return out;
}

/** Map a gateway status string to true / false / null (null = not modelled). */
function statusIsReady(status) {
  const s = String(status == null ? '' : status).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (DOWN_STATUS.test(s)) return false;
  if (UP_STATUS.test(s)) return true;
  return null;
}

/** Bounded: drop the least recently active chats when the cap is exceeded. */
function prunePending() {
  if (pending.size <= PENDING_MAX_CHATS) return;
  const byAge = Array.from(pending.entries()).sort((a, b) => a[1].lastAt - b[1].lastAt);
  const excess = pending.size - PENDING_MAX_CHATS;
  for (let i = 0; i < excess; i += 1) pending.delete(byAge[i][0]);
}

function setReady(sessionId, ready, status) {
  readiness.ready = ready;
  readiness.status = status || null;
  readiness.at = Date.now();
  readiness.failures = 0;
  if (sessionId) readiness.sessionId = sessionId;
}

// ------------------------------------------------------------------
// pending tracking (called from routes/openwa.js)
// ------------------------------------------------------------------

/**
 * Count one incoming message against its chat. Also the strongest possible proof
 * the WhatsApp link is up, so it marks the session ready.
 * @returns {{chatId: string, count: number}|null} null when the payload has no chat
 */
function markIncoming(sessionId, data) {
  if (!sessionId) return null;
  const chatId = inboundChatIdOf(data);
  if (!chatId) return null;

  const now = Date.now();
  const key = entryKey(sessionId, chatId);
  const hit = pending.get(key);
  const entry = hit
    ? { ...hit, count: hit.count + 1, lastAt: now }
    : { sessionId, chatId, count: 1, firstAt: now, lastAt: now };
  pending.set(key, entry);
  prunePending();

  setReady(sessionId, true, 'message.received');
  return { chatId, count: entry.count };
}

/**
 * A message of ours went out to a chat → Muse handled it, so that chat leaves the
 * pending list. Matching is exact first, then by the digits of the JID (the same
 * conversation can be addressed as `@lid` on one side and `@c.us` on the other).
 * @returns {number} how many chats were cleared
 */
function markHandled(sessionId, data) {
  if (!sessionId) return 0;
  const targets = outboundChatIdsOf(data);
  if (!targets.length) return 0;

  let cleared = 0;
  targets.forEach((chatId) => {
    if (pending.delete(entryKey(sessionId, chatId))) cleared += 1;
  });
  if (cleared) return cleared;

  const wanted = new Set(targets.map(digitsOf).filter(Boolean));
  if (!wanted.size) return 0;
  for (const [key, entry] of pending) {
    if (entry.sessionId === sessionId && wanted.has(digitsOf(entry.chatId))) {
      pending.delete(key);
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * Non-`message.received` webhook events. Only two things matter here: our own
 * outbound echoes (whichever event they arrive on — `fromMe` is unambiguous) and
 * session lifecycle, which is how readiness learns the link went down without
 * costing a gateway call.
 */
function noteSessionEvent(event, sessionId, data) {
  const name = String(event || '');
  if (!name) return;

  if (data && data.fromMe === true) {
    markHandled(sessionId, data);
    return;
  }
  if (!name.startsWith('session.')) return;

  const raw = data && (data.status || data.state);
  const fromStatus = statusIsReady(raw);
  if (fromStatus !== null) {
    setReady(sessionId, fromStatus, String(raw));
    return;
  }
  if (DOWN_EVENT.test(name)) {
    setReady(sessionId, false, name);
    return;
  }
  if (UP_EVENT.test(name)) setReady(sessionId, true, name);
}


// ------------------------------------------------------------------
// readiness
// ------------------------------------------------------------------

/** The org mapping is the only trusted place a session id comes from. */
async function lookupSessionId() {
  if (sessionLookup.value && Date.now() - sessionLookup.at < SESSION_LOOKUP_TTL_MS) return sessionLookup.value;
  let value = null;
  try {
    const supabaseAdmin = require('./supabase');
    const { data } = await supabaseAdmin
      .from('whatsapp_connections')
      .select('openwa_session_id')
      .eq('provider', 'openwa')
      .limit(1)
      .maybeSingle();
    value = (data && data.openwa_session_id) || null;
  } catch (err) {
    console.warn('[waPending] session lookup failed:', err.message);
  }
  sessionLookup.value = value;
  sessionLookup.at = Date.now();
  return value;
}

/**
 * Ask the gateway whether the session is up. Single-flight (a poll storm cannot
 * pile up probes) and never throws — the result lands in `readiness`, which the
 * next poll reads.
 */
function runRefresh() {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    // OpenWA not wired on this deployment: nothing to verify, and certainly not
    // an outage worth alerting about.
    if (!config.openwa.baseUrl) return;

    const sessionId = readiness.sessionId || (await lookupSessionId());
    if (!sessionId) return;

    try {
      const openwa = require('../services/openwa');
      const live = await openwa.getSession(sessionId);
      const status = (live && (live.status || live.state)) || null;
      const ready = statusIsReady(status);
      // Reachable but with a status this build does not model: reachable wins,
      // because an unreachable gateway throws instead of answering.
      setReady(sessionId, ready === null ? true : ready, status || 'reachable');
    } catch (err) {
      readiness.failures += 1;
      readiness.at = Date.now(); // throttle: do not retry on every single poll
      if (readiness.failures >= READY_DOWN_AFTER_FAILURES) {
        readiness.ready = false;
        readiness.status = `unreachable: ${err.message}`;
      }
      console.warn('[waPending] session check failed:', err.message);
    }
  })().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The public contract with Muse: counts, chat ids, and whether the link is up.
 * Reads memory only (no DB, no LLM, no gateway call on the hot path); a stale
 * readiness value schedules a background probe for the next poll.
 * @returns {Promise<{new_messages:number, pending_chats:string[], session_ready:boolean, mode:'muse'|'bot'}>}
 */
async function snapshot() {
  const entries = Array.from(pending.values()).sort((a, b) => b.lastAt - a.lastAt);
  const newMessages = entries.reduce((sum, e) => sum + e.count, 0);

  if (Date.now() - readiness.at > READY_TTL_MS) {
    const probe = runRefresh();
    // Nothing known yet (fresh process): a short wait buys an accurate answer on
    // the very first poll instead of a guess — and cannot hang the request.
    if (readiness.ready === null && READY_WAIT_MS > 0) await Promise.race([probe, delay(READY_WAIT_MS)]);
  }

  return {
    new_messages: newMessages,
    pending_chats: entries.map((e) => e.chatId),
    // Unknown reads as up: Muse alerts Meena on `false`, and a cold process must
    // not raise a false outage. A real outage is confirmed by the probe above or
    // by a lifecycle event, and shows up on the next poll.
    session_ready: readiness.ready !== false,
    // Lets Muse stand down if the backend was switched back to self-replying
    // (`WHATSAPP_AUTO_REPLY=on`) — both replying at once is the race this mode
    // exists to remove.
    mode: config.openwa.autoReply ? 'bot' : 'muse',
  };
}

/** Test hook: forget everything (counts, readiness, lookup cache). */
function reset() {
  pending.clear();
  readiness.ready = null;
  readiness.status = null;
  readiness.at = 0;
  readiness.failures = 0;
  readiness.sessionId = null;
  sessionLookup.value = null;
  sessionLookup.at = 0;
}

module.exports = {
  PENDING_MAX_CHATS,
  READY_TTL_MS,
  markIncoming,
  markHandled,
  noteSessionEvent,
  snapshot,
  statusIsReady,
  reset,
};

