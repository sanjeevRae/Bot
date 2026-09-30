/**
 * Pending-message tracker for the OpenWA gateway — the "Muse mode" half of the
 * `WHATSAPP_AUTO_REPLY` switch (see routes/openwa.js).
 *
 * With the switch OFF the backend never answers WhatsApp itself. Instead every
 * incoming message is counted per chat here, and a chat is cleared the moment one
 * of our own outbound messages to it is observed (the gateway echoes our sends
 * back on the same `message.received` event with `fromMe: true`). That is the
 * whole acknowledgement protocol: no ack API, no tokens spent while quiet.
 * Muse's event hook then only has to ask `GET /wa-pending` whether anything
 * happened, reads the real messages from the OpenWA API when it did, and replies
 * there — so the gateway stays the single source of truth for message content.
 *
 * DURABILITY (V14) — why this is not just a Map any more:
 * a count that only lives in memory is lost the moment Render restarts, and the
 * message is lost with it (the webhook was already acknowledged, so OpenWA never
 * retries). A prospect's message must never vanish from the feed, so each
 * inbound message becomes a row in `wa_pending_messages` (migration_v14) and the
 * webhook is acknowledged only *after* that row is stored. Consequences:
 *   - a restart cannot lose a delivery that was acknowledged;
 *   - `event_key` is unique, so OpenWA retries are idempotent across restarts
 *     (the in-memory dedupe in routes/openwa.js could not do that);
 *   - a DB outage degrades to the in-memory mirror (single-instance) instead of
 *     reporting 0 — the feed never reports silence it does not believe.
 * Rows are content-free (chat id, message id, timestamps — never a body), which
 * is what lets the status endpoint stay unauthenticated. They age out: pending
 * rows expire after WA_PENDING_EXPIRE_DAYS, handled/expired rows are deleted
 * after WA_HANDLED_KEEP_DAYS.
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

const { randomUUID } = require('crypto');
const config = require('../config');
const waMode = require('./waMode');

/** Per-message rows behind the feed (migration_v14). */
const TABLE = 'wa_pending_messages';

/** Cap on chats reported by one poll (the newest win); the total stays exact. */
const PENDING_MAX_CHATS = Math.max(1, parseInt(process.env.WA_PENDING_MAX_CHATS || '1000', 10) || 1000);
/** Cap on rows pulled in one poll — a fuse, not a limit anyone should reach. */
const PENDING_ROW_LIMIT = Math.max(100, parseInt(process.env.WA_PENDING_ROW_LIMIT || '5000', 10) || 5000);
/** Unanswered messages older than this stop counting as work for Muse. */
const PENDING_EXPIRE_DAYS = Math.max(1, parseInt(process.env.WA_PENDING_EXPIRE_DAYS || '30', 10) || 30);
/** How long handled/expired rows are kept for audit before deletion. */
const HANDLED_KEEP_DAYS = Math.max(1, parseInt(process.env.WA_HANDLED_KEEP_DAYS || '7', 10) || 7);
/** Lazy housekeeping cadence (runs off a status poll, never a timer). */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** How long a session probe result is trusted before the next poll re-checks. */
const READY_TTL_MS = Math.max(1000, parseInt(process.env.WA_SESSION_REFRESH_MS || '20000', 10) || 20000);
/** On a cold process, how long a status poll waits for a first real answer. */
const READY_WAIT_MS = Math.max(0, parseInt(process.env.WA_SESSION_WAIT_MS || '1500', 10) || 0);
/** Consecutive failed probes before the link is called down (blip tolerance). */
const READY_DOWN_AFTER_FAILURES = Math.max(1, parseInt(process.env.WA_SESSION_DOWN_AFTER || '2', 10) || 2);
/** How long a session → org lookup is reused (one query, not one per message). */
const SESSION_LOOKUP_TTL_MS = 5 * 60 * 1000;

/** Gateway statuses that mean the session can send and receive. */
const UP_STATUS = /^(connected|ready|open|authenticated|online|working|live|active)$/;
/** Gateway statuses that mean it cannot (QR = not scanned, unpaired = logged out). */
const DOWN_STATUS = /^(disconnected|stopped|closed|logout|logged_out|unpaired|qr|qr_code|qrcode|scan_qr|error|failed|timeout|offline)$/;
const UP_EVENT = /(connect|ready|authenticat|online|resume|start)/i;
const DOWN_EVENT = /(disconnect|logout|unpaired|qr|error|fail|stop|close|timeout)/i;

// ------------------------------------------------------------------
// state
// ------------------------------------------------------------------

/**
 * In-memory mirror: `${sessionId}|${chatId}` → { sessionId, chatId, count, firstAt, lastAt }.
 * Not the store — a fallback for when the table is missing or the DB blinks, and
 * the cheap source of the "pending: N" number in the webhook log.
 */
const mirror = new Map();

/** True once a write proved the table is missing: count in memory, warn once. */
let mirrorOnly = false;
let warnedMissingTable = false;
let lastPruneAt = 0;
let lastReadWarnAt = 0;

const readiness = { ready: null, status: null, at: 0, failures: 0, sessionId: null };
const sessionLookup = { value: null, at: 0, resolved: false };
const orgLookup = { value: null, at: 0, resolved: false };

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

function mirrorKey(sessionId, chatId) {
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

function setReady(sessionId, ready, status) {
  readiness.ready = ready;
  readiness.status = status || null;
  readiness.at = Date.now();
  readiness.failures = 0;
  if (sessionId) readiness.sessionId = sessionId;
}

/**
 * Idempotency key for one delivery. The gateway's own message id first (stable
 * across retries and restarts), then its idempotency key, and only as a last
 * resort a random one — a delivery with no identifier at all can not be told
 * apart from a genuine second message, so it is always counted.
 */
function eventKeyFor(sessionId, data, idempotencyKey) {
  // The explicit retry marker wins, then the gateway's message id, and only as a
  // last resort a random one — a delivery with no identifier at all can not be
  // told apart from a genuine second message, so it is always counted.
  const idem = String(idempotencyKey == null ? '' : idempotencyKey).trim();
  if (idem) return `${sessionId}|idem:${idem}`;
  const messageId = data && typeof data.id === 'string' ? data.id.trim() : '';
  if (messageId) return `${sessionId}|msg:${messageId}`;
  return `${sessionId}|anon:${randomUUID()}`;
}

function pruneMirror() {
  if (mirror.size <= PENDING_MAX_CHATS) return;
  const byAge = Array.from(mirror.entries()).sort((a, b) => a[1].lastAt - b[1].lastAt);
  for (let i = 0; i < mirror.size - PENDING_MAX_CHATS; i += 1) mirror.delete(byAge[i][0]);
}

/** Count one message in memory (fallback store + log counter). */
function mirrorBump(sessionId, chatId) {
  const key = mirrorKey(sessionId, chatId);
  const now = Date.now();
  const hit = mirror.get(key);
  const entry = hit
    ? { ...hit, count: hit.count + 1, lastAt: now }
    : { sessionId, chatId, count: 1, firstAt: now, lastAt: now };
  mirror.set(key, entry);
  pruneMirror();
  return entry;
}

/** A chat was answered → drop it from the mirror. */
function mirrorForget(sessionId, chatId) {
  mirror.delete(mirrorKey(sessionId, chatId));
}


// ------------------------------------------------------------------
// durable store (wa_pending_messages)
// ------------------------------------------------------------------

/** The org that owns a session — only ever used to tag pending rows. */
async function lookupOrgId(sessionId) {
  if (!sessionId) return null;
  // `resolved` (not truthiness) so an unmapped session is remembered too: this
  // runs per message, and re-asking on every one would defeat the cache.
  if (orgLookup.resolved && Date.now() - orgLookup.at < SESSION_LOOKUP_TTL_MS) return orgLookup.value;
  let value = null;
  try {
    const supabaseAdmin = require('./supabase');
    const { data } = await supabaseAdmin
      .from('whatsapp_connections')
      .select('organization_id')
      .eq('openwa_session_id', sessionId)
      .limit(1)
      .maybeSingle();
    value = (data && data.organization_id) || null;
  } catch (err) {
    console.warn('[waPending] org lookup failed:', err.message);
  }
  orgLookup.value = value;
  orgLookup.at = Date.now();
  orgLookup.resolved = true;
  return value;
}

/**
 * Store one inbound message. Idempotent on `event_key`, so a retried delivery (or
 * a retry after a restart) can never double-count.
 * @returns {Promise<{inserted: boolean, stored: boolean}>} `stored: false` means
 *   "kept in memory instead" — never "lost".
 */
async function storePending(sessionId, chatId, data, idempotencyKey, organizationId) {
  if (mirrorOnly) return { inserted: true, stored: false };
  const messageId = data && typeof data.id === 'string' ? data.id.trim() : '';
  const row = {
    session_id: sessionId,
    chat_id: chatId,
    message_id: messageId || null,
    event_key: eventKeyFor(sessionId, data, idempotencyKey),
    is_group: String(chatId).endsWith('@g.us'),
    ...(organizationId ? { organization_id: organizationId } : {}),
  };
  try {
    const supabaseAdmin = require('./supabase');
    const { data: rows, error } = await supabaseAdmin
      .from(TABLE)
      .upsert(row, { onConflict: 'event_key', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(error.message);
    return { inserted: Array.isArray(rows) && rows.length > 0, stored: true };
  } catch (err) {
    if (/wa_pending_messages|does not exist|schema cache/i.test(err.message || '')) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.warn(
          '[waPending] wa_pending_messages is missing — run migration_v14_wa_pending.sql (counting in memory only until then, so a restart would lose counts)'
        );
      }
      mirrorOnly = true;
    } else {
      console.warn('[waPending] could not store the pending message:', err.message);
    }
    return { inserted: true, stored: false };
  }
}

/** Every still-unanswered row (newest first, capped by PENDING_ROW_LIMIT). */
async function loadPendingRows() {
  const supabaseAdmin = require('./supabase');
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select('id, session_id, chat_id, received_at')
    .eq('status', 'pending')
    .order('received_at', { ascending: false })
    .limit(PENDING_ROW_LIMIT);
  if (error) throw new Error(error.message);
  return data || [];
}

/** Rows for one session, so the digits fallback can match chats in a second query. */
async function loadPendingChats(sessionId) {
  const supabaseAdmin = require('./supabase');
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select('id, chat_id')
    .eq('session_id', sessionId)
    .eq('status', 'pending')
    .limit(PENDING_ROW_LIMIT);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Mark rows answered. Called only when one of our own messages is seen going out
 * to that chat — the gateway's echo is the acknowledgement.
 */
async function storeHandled(sessionId, chatIds) {
  if (!chatIds.length) return 0;
  const supabaseAdmin = require('./supabase');
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update({ status: 'handled', handled_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('status', 'pending')
    .in('chat_id', chatIds)
    .select('id, chat_id');
  if (error) {
    console.warn('[waPending] could not clear the pending chat:', error.message);
    return 0;
  }
  return data || [];
}

/** Mark specific rows answered (the digits fallback path). */
async function storeHandledIds(ids) {
  if (!ids.length) return 0;
  const supabaseAdmin = require('./supabase');
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update({ status: 'handled', handled_at: new Date().toISOString() })
    .in('id', ids)
    .select('id');
  if (error) {
    console.warn('[waPending] could not clear the pending rows:', error.message);
    return 0;
  }
  return (data || []).length;
}

/**
 * Housekeeping, hung off a status poll (no timer of its own): expire messages
 * nobody answered for PENDING_EXPIRE_DAYS so they stop waking Muse, then delete
 * rows that have been settled for HANDLED_KEEP_DAYS. It also retries the table
 * once per cycle after a "table missing" warning, so running the migration
 * starts working without a redeploy.
 */
async function pruneStore() {
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = Date.now();
  if (mirrorOnly && warnedMissingTable) {
    // Maybe the migration has been run since — try the table again.
    mirrorOnly = false;
    warnedMissingTable = false;
  }
  try {
    const supabaseAdmin = require('./supabase');
    const expireBefore = new Date(Date.now() - PENDING_EXPIRE_DAYS * 864e5).toISOString();
    const dropBefore = new Date(Date.now() - HANDLED_KEEP_DAYS * 864e5).toISOString();
    await supabaseAdmin
      .from(TABLE)
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('received_at', expireBefore);
    await supabaseAdmin
      .from(TABLE)
      .delete()
      .in('status', ['handled', 'expired'])
      .lt('received_at', dropBefore);
  } catch (err) {
    console.warn('[waPending] housekeeping skipped:', err.message);
  }
}


// ------------------------------------------------------------------
// pending tracking (called from routes/openwa.js)
// ------------------------------------------------------------------

/**
 * Count one incoming message against its chat — durably, before the webhook is
 * acknowledged (routes/openwa.js does the waiting). Also the strongest possible
 * proof the WhatsApp link is up, so it marks the session ready.
 *
 * Deliberately counts even when the session is switched off ("suspended" in the
 * log): the owner disconnecting the session is not a reason to drop a prospect's
 * message, and Muse decides what to do with it.
 *
 * @returns {Promise<{chatId: string, count: number, stored: boolean, duplicate: boolean}|null>}
 */
async function markIncoming(sessionId, data, { idempotencyKey, organizationId } = {}) {
  if (!sessionId) return null;
  const chatId = inboundChatIdOf(data);
  if (!chatId) return null;

  const org = organizationId === undefined ? await lookupOrgId(sessionId) : organizationId;
  const { inserted, stored } = await storePending(sessionId, chatId, data, idempotencyKey, org);
  const entry = inserted
    ? mirrorBump(sessionId, chatId)
    : (mirror.get(mirrorKey(sessionId, chatId)) || { count: 0 });

  setReady(sessionId, true, 'message.received');
  return { chatId, count: entry.count, stored, duplicate: !inserted };
}

/**
 * A message of ours went out to a chat → Muse handled it, so that chat stops
 * being pending. Matching is exact first, then by the digits of the JID (the same
 * conversation can be addressed as `@lid` on one side and `@c.us` on the other).
 *
 * Runs after the webhook was acknowledged, so a crash here only costs a duplicate
 * reply later — never a lost message.
 * @returns {Promise<number>} how many rows were settled
 */
async function markHandled(sessionId, data) {
  if (!sessionId) return 0;
  const targets = outboundChatIdsOf(data);
  if (!targets.length) return 0;

  let settled = 0;
  try {
    const rows = await storeHandled(sessionId, targets);
    settled = rows.length;
    rows.forEach((r) => mirrorForget(sessionId, r.chat_id));
  } catch (err) {
    console.warn('[waPending] clear failed:', err.message);
  }

  if (settled) {
    targets.forEach((chatId) => mirrorForget(sessionId, chatId));
    return settled;
  }

  // Nothing matched by name: the echo may address the chat in another JID form.
  const wanted = new Set(targets.map(digitsOf).filter(Boolean));
  if (!wanted.size) return 0;
  try {
    const rows = await loadPendingChats(sessionId);
    const ids = rows.filter((r) => wanted.has(digitsOf(r.chat_id))).map((r) => r.id);
    if (!ids.length) return 0;
    settled = await storeHandledIds(ids);
    rows.filter((r) => ids.includes(r.id)).forEach((r) => mirrorForget(sessionId, r.chat_id));
  } catch (err) {
    console.warn('[waPending] clear (digits fallback) failed:', err.message);
  }
  targets.forEach((chatId) => mirrorForget(sessionId, chatId));
  return settled;
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
    markHandled(sessionId, data).catch(() => {});
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
  if (sessionLookup.resolved && Date.now() - sessionLookup.at < SESSION_LOOKUP_TTL_MS) return sessionLookup.value;
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
  sessionLookup.resolved = true;
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


// ------------------------------------------------------------------
// the feed
// ------------------------------------------------------------------

/** Group rows into the shape the feed reports: one entry per chat. */
function aggregateRows(rows) {
  const byChat = new Map();
  rows.forEach((r) => {
    const key = `${r.session_id}|${r.chat_id}`;
    const at = Date.parse(r.received_at) || 0;
    const hit = byChat.get(key);
    if (hit) {
      hit.count += 1;
      hit.lastAt = Math.max(hit.lastAt, at);
    } else {
      byChat.set(key, { sessionId: r.session_id, chatId: r.chat_id, count: 1, lastAt: at });
    }
  });
  const chats = Array.from(byChat.values()).sort((a, b) => b.lastAt - a.lastAt);
  return {
    // The total stays exact even when the reported chat list is capped.
    total: chats.reduce((sum, c) => sum + c.count, 0),
    chats: chats.slice(0, PENDING_MAX_CHATS),
  };
}

/** The mirror, in the same shape (used when the store is unavailable). */
function aggregateMirror() {
  const all = Array.from(mirror.values());
  const chats = all.slice().sort((a, b) => b.lastAt - a.lastAt).slice(0, PENDING_MAX_CHATS);
  return { total: all.reduce((sum, e) => sum + e.count, 0), chats };
}

/**
 * The public contract with Muse: counts, chat ids, and whether the link is up.
 * One indexed read over a small table (plus a cached mode/session lookup); a
 * stale readiness value just schedules a background probe for the next poll.
 * @returns {Promise<{new_messages:number, pending_chats:string[], session_ready:boolean, mode:'muse'|'bot'}>}
 */
async function snapshot() {
  // Housekeeping hangs off the poll so nothing has to own a timer; it is
  // fire-and-forget and self-throttled to once an hour.
  pruneStore().catch(() => {});

  let view;
  if (mirrorOnly) {
    view = aggregateMirror();
  } else {
    try {
      view = aggregateRows(await loadPendingRows());
    } catch (err) {
      // NEVER report 0 because the store blinked: Muse would go back to sleep on
      // messages we already know about. The mirror is single-instance, which is
      // exactly what this deployment is.
      if (Date.now() - lastReadWarnAt > 60000) {
        lastReadWarnAt = Date.now();
        console.warn('[waPending] pending read failed, falling back to the in-memory mirror:', err.message);
      }
      view = aggregateMirror();
    }
  }

  if (Date.now() - readiness.at > READY_TTL_MS) {
    const probe = runRefresh();
    // Nothing known yet (fresh process): a short wait buys an accurate answer on
    // the very first poll instead of a guess — and cannot hang the request.
    if (readiness.ready === null && READY_WAIT_MS > 0) await Promise.race([probe, delay(READY_WAIT_MS)]);
  }

  // Who replies right now (V13). Cached for WA_MODE_TTL_MS, so a poll normally
  // costs nothing beyond memory — it exists because reporting the wrong mode
  // would either silence Muse while the bot is off, or have her answer alongside
  // it. A read failure resolves to Muse mode, the quiet direction.
  let mode = config.openwa.autoReply ? 'bot' : 'muse';
  try {
    const known = view.chats[0] ? view.chats[0].sessionId : null;
    const sessionId = readiness.sessionId || known || (await lookupSessionId());
    if (sessionId) ({ mode } = await waMode.statusFor(sessionId));
  } catch (err) {
    console.warn('[waPending] mode lookup failed:', err.message);
  }

  return {
    new_messages: view.total,
    pending_chats: view.chats.map((c) => c.chatId),
    // Unknown reads as up: Muse alerts Meena on `false`, and a cold process must
    // not raise a false outage. A real outage is confirmed by the probe above or
    // by a lifecycle event, and shows up on the next poll.
    session_ready: readiness.ready !== false,
    // `bot` = the backend is answering WhatsApp itself, so Muse must stand down
    // (both replying at once is the race this mode exists to remove).
    mode,
  };
}


/**
 * Settle every outstanding message. Ops/test escape hatch only — production
 * never drops a pending message except by observing our own reply going out
 * (markHandled), because a silently dropped prospect is a lost client.
 */
async function clearPending() {
  mirror.clear();
  if (mirrorOnly) return;
  try {
    const supabaseAdmin = require('./supabase');
    await supabaseAdmin
      .from(TABLE)
      .update({ status: 'handled', handled_at: new Date().toISOString() })
      .eq('status', 'pending');
  } catch (err) {
    console.warn('[waPending] could not settle the pending rows:', err.message);
  }
}

/** Test hook: forget everything this process holds (a restart, simulated). */
function reset() {
  mirror.clear();
  mirrorOnly = false;
  warnedMissingTable = false;
  lastPruneAt = 0;
  lastReadWarnAt = 0;
  readiness.ready = null;
  readiness.status = null;
  readiness.at = 0;
  readiness.failures = 0;
  readiness.sessionId = null;
  sessionLookup.value = null;
  sessionLookup.at = 0;
  sessionLookup.resolved = false;
  orgLookup.value = null;
  orgLookup.at = 0;
  orgLookup.resolved = false;
}

module.exports = {
  TABLE,
  PENDING_MAX_CHATS,
  READY_TTL_MS,
  markIncoming,
  markHandled,
  noteSessionEvent,
  snapshot,
  statusIsReady,
  clearPending,
  reset,
};

