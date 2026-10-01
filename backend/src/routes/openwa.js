const express = require('express');
const crypto = require('crypto');
const supabaseAdmin = require('../lib/supabase');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const openwa = require('../services/openwa');
const { normalizeInbound } = require('../services/channelMedia');
const { handleInbound, runChatForChannel } = require('./channels');
const { matchedBy, mentionedOwnId, unownedLidMentions, normalizeWid, digitsOf, stripOwnMention, planInbound, describeInbound } = require('../lib/openwaInbound');
const waPending = require('../lib/waPending');
const waMode = require('../lib/waMode');
const diag = require('../lib/openwaDiagnostics');

// ============================================================
// OpenWA ⇄ Chitra integration
//  - Inbound: signed OpenWA webhook → existing RAG/Groq pipeline → reply via OpenWA
//  - Management: org-scoped endpoints for the Channels page (status/connect/disconnect/reconnect/test)
// Tenant isolation: the org for an inbound message is resolved from the stored
// `whatsapp_connections` row by session id — NEVER trusted from the webhook payload.
//
// V13 reply modes — who answers inbound WhatsApp. Two layers, so the owner gets a
// dashboard switch and ops keeps a single-flag rollback:
//  - `WHATSAPP_AUTO_REPLY=on` (config.openwa.autoReply) forces bot mode for every
//    org, whatever the dashboard says.
//  - otherwise the org's own `auto_reply_enabled` (the "Answer WhatsApp from
//    Chitra" toggle on the Channels page, migration_v13) decides; off — the
//    default — is "Muse mode": this backend NEVER replies, it only counts incoming
//    messages (lib/waPending.js) and clears a chat as soon as one of our own
//    outbound messages to it is observed. GET /wa-pending then tells Muse's event
//    hook when to wake up and answer through OpenWA herself.
// Bot mode is the original self-replying pipeline below, untouched.
// Resolution + caching live in lib/waMode.js.
// ============================================================

const webhookRouter = express.Router();
const orgRouter = express.Router();

// ------------------------------------------------------------------
// Dedup: idempotency keys (X-OpenWA-Idempotency-Key / body idempotencyKey).
// OpenWA retries reuse the same key, so a retry after our async accept would
// reprocess — keep a short TTL in-memory map to guard.
// ------------------------------------------------------------------
const processedKeys = new Map();
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_MAX = 20000;

// How long the pre-ack durable write may take before the webhook answers anyway
// (the write then finishes in the background). A webhook that hangs is worse than
// a slow one: OpenWA would retry and pile deliveries up.
const ACK_TIMEOUT_MS = Math.max(0, parseInt(process.env.WA_ACK_TIMEOUT_MS || '4000', 10) || 0);

function isDuplicate(key) {
  const t = processedKeys.get(key);
  if (t && Date.now() - t < DEDUPE_TTL_MS) return true;
  if (t) processedKeys.delete(key);
  return false;
}
function markProcessed(key) {
  processedKeys.set(key, Date.now());
  if (processedKeys.size > DEDUPE_MAX) {
    const now = Date.now();
    for (const [k, t] of processedKeys) if (now - t > DEDUPE_TTL_MS) processedKeys.delete(k);
  }
}

// ------------------------------------------------------------------
// HMAC signature verification over the RAW body (matching OpenWA's contract)
// ------------------------------------------------------------------
function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Mention gate for the pending feed (V15). Answered BEFORE the ack, so the
 * decision itself is durable: what is counted stays counted, and what is not
 * counted is explained in the diagnostics instead of silently vanishing.
 *
 *   - direct message → always Muse's business (counted, with details)
 *   - group message  → only when this session's own identity is @-mentioned.
 *     A busy team group that is not talking to the bot must not wake Muse —
 *     its chatter is never written here at all.
 *
 * Recognising our own mention reuses the bot path's machinery
 * (lib/openwaInbound.js), with the stored number first and the gateway's
 * display name as fallback. A mention of us can arrive as our number, our
 * privacy id (`@248065197879524@lid` — learned deterministically from the group
 * roster, or by resolving the offered mention), or our display name on builds
 * that render that form. Unresolvable `@lid` mentions get one roster/resolver
 * lookup each (both cached); after that the message stays out.
 */
async function mentionGate({ sessionId, data, chatId, ownDigits, ownName }) {
  const isGroup = String(chatId || '').endsWith('@g.us');
  if (!isGroup) {
    return { counted: true, reason: 'direct', chatId, isGroup: false, mention: null };
  }

  const ownWid = ownDigits ? `${ownDigits}@c.us` : null;
  let ownLids = openwa.getOwnLids(sessionId);

  const attempt = () => {
    const match = matchedBy(data, ownDigits, ownWid, ownName, ownLids);
    if (!match) return null;
    const mentionedIds = [data?.mentionedIds, data?.mentions]
      .filter(Array.isArray)
      .flat()
      .map((m) => String(m))
      .slice(0, 8);
    return {
      counted: true,
      reason: match,
      chatId,
      isGroup: true,
      // `isGroupDetail` arms the reply-hint columns in the pending row — the
      // consumer needs them only for groups, where the group JID alone does not
      // say who asked or what exactly they said.
      mention: { matchedBy: match, mentionedIds, ownLids: ownLids.slice(0, 8), isGroupDetail: true },
    };
  };

  const first = attempt();
  if (first) return first;

  // A mention of us can arrive as our privacy id, and the only way to recognise
  // that is to learn our own LID first: the group roster pairs our number with
  // our id deterministically, and the contacts lookup resolves an offered
  // mention. Both are cached; both only run when the cheap checks missed, so a
  // normal message costs nothing extra here.
  if (ownDigits) {
    await openwa.learnOwnLidFromGroup(sessionId, chatId, ownDigits);
    ownLids = openwa.getOwnLids(sessionId);
    const second = attempt();
    if (second) return second;
    for (const lid of unownedLidMentions(data, ownDigits, ownWid, ownLids)) {
      const phone = await openwa.resolvePhone(sessionId, lid);
      if (phone && digitsOf(phone) === ownDigits) {
        ownLids = openwa.learnOwnLid(sessionId, lid);
        break;
      }
    }
    const third = attempt();
    if (third) return third;
  }

  return { counted: false, reason: 'group-not-mentioned', chatId, isGroup: true, mention: null };
}

/**
 * The session's own number for mention matching. The stored row is the reliable
 * source — gateway builds only fill `phone` on some sessions — so the DB wins,
 * with the gateway as fallback. Cached for the same reason as everywhere else.
 */
const identityCache = new Map(); // sessionId -> { value, at }
const IDENTITY_TTL_MS = 10 * 60 * 1000;

async function ownNumberFor(sessionId) {
  const hit = identityCache.get(sessionId);
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.value;
  let value = { ownDigits: null, ownName: null };
  try {
    const supabaseAdmin = require('../lib/supabase');
    const { data: conn } = await supabaseAdmin
      .from('whatsapp_connections')
      .select('phone_number')
      .eq('openwa_session_id', sessionId)
      .limit(1)
      .maybeSingle();
    const identity = await openwa.getOwnIdentity(sessionId);
    value = {
      ownDigits: digitsOf(conn && conn.phone_number) || identity.digits || null,
      ownName: identity.pushName || null,
    };
  } catch (err) {
    console.warn('[OpenWA] own-number lookup failed:', err.message);
  }
  identityCache.set(sessionId, { value, at: Date.now() });
  return value;
}

/**
 * Does this hook exclude group traffic? `{ isGroup: false }` (or any false-y
 * group gate) drops group messages at the gateway, which is invisible from the
 * phone and from our logs — the single most confusing failure this integration
 * has, so it is detected in one place and used by both the repair and /status.
 */
function hasGroupFilter(hook) {
  const f = hook && hook.filters;
  if (!f || typeof f !== 'object') return false;
  return Object.entries(f).some(([k, v]) => /group/i.test(String(k)) && !v);
}

/** What the gateway says about this session's hooks — for /status, best effort. */
async function webhookFilterState(sessionId) {
  if (!sessionId) return null;
  try {
    const res = await openwa.listWebhooks(sessionId);
    const hooks = Array.isArray(res) ? res : (res && (res.webhooks || res.data)) || [];
    return hooks.some(hasGroupFilter);
  } catch {
    return null; // unknown — never claim a problem we could not verify
  }
}

/**
 * Make sure this session forwards `message.received` to our backend — with NO
 * `filters`. A stale registration carrying e.g. `{ "isGroup": false }` would
 * silently drop every group message at the gateway: nothing to count, nothing
 * to answer, and nothing in our logs to explain the silence.
 *
 * Idempotent and safe to call from /connect, /reconnect and the repair button:
 * a correctly wired hook is returned untouched; anything else (missing hook,
 * missing event, or an excluding filter) is repaired. Filtered hooks are
 * deleted where the build allows, then re-registered clean so the gateway does
 * not fan out two deliveries of the same message.
 */
async function ensureWebhook(sessionId, url) {
  const empty = (hooks = []) => ({ repaired: false, reason: 'unreachable', hook: null, hooks });
  let hooks = [];
  try {
    const res = await openwa.listWebhooks(sessionId);
    hooks = Array.isArray(res) ? res : (res && (res.webhooks || res.data)) || [];
  } catch (err) {
    console.warn('[OpenWA] webhook inspection failed:', err.message);
    return empty();
  }

  const hookUrl = (h) => String((h && (h.url || h.target)) || '');
  const hookId = (h) => h && (h.id || h._id || h.uuid || h.name);
  const hookEvents = (h) => h && (h.events || h.event);

  const hasEvent = (h, event) => {
    const events = hookEvents(h);
    if (Array.isArray(events)) return events.includes(event);
    if (typeof events === 'string') return events === event;
    // No event list on the hook: assume it fires everything (do not fight it).
    return true;
  };

  const ours = hooks.find((h) => hookUrl(h) === String(url || '')) || null;

  // A wrong-URL hook with a group filter would still eat group messages: delete
  // it where the build allows so it stops dropping them.
  for (const h of hooks) {
    if (h !== ours && hasGroupFilter(h)) await openwa.deleteWebhook(sessionId, hookId(h));
  }

  const needsRepair = !ours || !hasEvent(ours, 'message.received') || hasGroupFilter(ours);
  if (!needsRepair) return { repaired: false, reason: 'already-clean', hook: ours, hooks };

  // Delete our own stale hook first where the build allows, so the gateway does
  // not end up fanning out two deliveries of the same message.
  if (ours && (hasGroupFilter(ours) || !hasEvent(ours, 'message.received'))) {
    await openwa.deleteWebhook(sessionId, hookId(ours));
  }

  try {
    await openwa.registerWebhook(sessionId, url, config.openwa.webhookSecret);
  } catch (err) {
    console.warn('[OpenWA] webhook (re)registration failed:', err.message);
    return { repaired: false, reason: 'register-failed', hook: ours, hooks };
  }
  return { repaired: true, reason: ours ? 'fixed' : 'created', hook: ours, hooks };
}

function normalizeChatId(v) {
  const s = String(v).trim();
  if (!s) return null;
  return s.includes('@') ? s : `${s}@c.us`;
}

// Resolve the org owning a session from the DB — the only trusted source.
// The V12 column is optional on purpose: a deploy that lands before
// migration_v12_openwa_groups.sql has been run must not stop direct messages
// from being answered, so the lookup falls back to the pre-V12 column set
// (where `group_replies_enabled` is undefined and therefore treated as enabled).
const CONNECTION_COLUMNS =
  'id, organization_id, openwa_session_id, phone_number, status, provider, group_replies_enabled';
const CONNECTION_COLUMNS_LEGACY = 'id, organization_id, openwa_session_id, phone_number, status, provider';

async function getConnectionBySession(sessionId) {
  const fetchRow = (columns) =>
    supabaseAdmin
      .from('whatsapp_connections')
      .select(columns)
      .eq('openwa_session_id', sessionId)
      .maybeSingle();

  let { data, error } = await fetchRow(CONNECTION_COLUMNS);
  if (error && /group_replies_enabled/.test(error.message || '')) {
    console.warn(
      '[OpenWA] whatsapp_connections.group_replies_enabled is missing — run migration_v12_openwa_groups.sql'
    );
    ({ data } = await fetchRow(CONNECTION_COLUMNS_LEGACY));
  }
  return data || null;
}

// ============================================================
// POST /api/webhooks/openwa  (mounted with express.raw in server.js)
// ============================================================
webhookRouter.post('/openwa', async (req, res) => {
  const raw = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

  const signature = req.headers['x-openwa-signature'];
  if (!verifySignature(raw, signature, config.openwa.webhookSecret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  // DURABLE BEFORE THE ACKNOWLEDGE (V14). My Muse-mode count used to be taken
  // after this 200, so a restart in between (every deploy) silently lost the
  // message: OpenWA was told "received" and never retried, while the new process
  // started with an empty count. Recording first means an acknowledged delivery
  // is on disk, and the unique event_key makes OpenWA's own retries idempotent
  // even across restarts. Bounded so a slow database cannot stall the webhook.
  //
  // The envelope matters: `ok: true` with a `null` value is itself an answer
  // ("this delivery is not countable"), while no envelope at all means the step
  // timed out or threw — hence the background handler re-runs it. Without that
  // distinction, the mention gate ran twice per group message (extra gateway
  // lookups) and the log claimed a phantom skip.
  let preAck = null;
  try {
    preAck = { ok: true, value: await withTimeout(recordPendingInbound(payload), ACK_TIMEOUT_MS) };
  } catch (err) {
    console.error('[OpenWA] Could not record the pending message before ack:', err.message);
  }

  res.status(200).json({ ok: true });

  handleOpenwaEvent(payload, preAck).catch((err) => {
    console.error('[OpenWA] Webhook processing error:', err.message);
  });
});

/**
 * Durable half of an inbound delivery: in Muse mode the message becomes a pending
 * row before the webhook is acknowledged (see the route above).
 *
 * Note what it does NOT do: it does not care that the session is switched off
 * ("suspended" in the log). The owner disconnecting the session is not a reason to
 * drop a prospect's message — Muse decides what to do with it, and the feed is the
 * only place she can learn about it.
 *
 * Group messages pass the mention gate first: a message that does not @-mention
 * this bot is not Muse's business in a busy team group, and it is never written —
 * but the decision is logged to diagnostics, never silent.
 *
 * @returns {Promise<object|null>} what was recorded, or null when this delivery is
 *   not Muse's business (history/lifecycle events, our own echoes, bot mode, or
 *   group chatter without a mention of the bot).
 */
async function recordPendingInbound(payload) {
  if (!payload || payload.event !== 'message.received') return null;
  const { sessionId, data, idempotencyKey } = payload;
  if (!sessionId || !data || typeof data !== 'object' || data.fromMe) return null;

  const { bot, softOff } = await waMode.modeFor(sessionId);
  if (bot && !softOff) return null; // the backend answers this one itself

  const chatId = normalizeChatId(data.chatId || data.from);
  if (!chatId) return null;

  const { ownDigits, ownName } = await ownNumberFor(sessionId);
  const gate = await mentionGate({ sessionId, data, chatId, ownDigits, ownName });
  if (!gate.counted) {
    const author = normalizeWid(data.author || null);
    diag.record({
      kind: 'inbound',
      action: 'skip',
      reason: gate.reason,
      sessionId,
      chatId,
      isGroup: true,
      author: author || data.author || null,
      profileName: data.senderName || data.pushName || null,
    });
    console.log('[OpenWA] Group message not counted for Muse (bot not mentioned)', {
      sessionId,
      chatId,
      reason: gate.reason,
    });
    return null;
  }

  return waPending.markIncoming(sessionId, data, {
    idempotencyKey,
    mention: gate.mention,
    facts: { isGroup: gate.isGroup, reason: gate.reason },
  });
}

/** Bound a promise so the webhook ack can never hang on it. */
function withTimeout(promise, ms) {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref()),
  ]);
}

async function handleOpenwaEvent(payload, preAck = null) {
  const { event, sessionId, idempotencyKey } = (payload && typeof payload === 'object') ? payload : {};
  if (!event || !sessionId) return;
  if (event !== 'message.received') {
    // Ignore lifecycle / other event types safely (no processing, no error).
    // Muse mode does care about two of them: a session going up/down (readiness
    // for GET /wa-pending) and an outbound echo on any event name (that clears
    // the chat's pending entry). Both are cheap notes, and in bot mode there is
    // simply nothing pending to clear.
    waPending.noteSessionEvent(event, sessionId, payload.data);
    return;
  }
  if (isDuplicate(idempotencyKey)) {
    console.log('[OpenWA] Duplicate message skipped', { sessionId, idempotencyKey });
    return;
  }
  markProcessed(idempotencyKey);

  const data = payload.data;
  if (!data || typeof data !== 'object') return;

  // Who answers this WhatsApp right now (V13): the org's Channels toggle unless
  // the server's WHATSAPP_AUTO_REPLY=on overrides it — and never while the owner
  // has switched the session off with Disconnect (a soft switch: the mapping
  // stays, but nothing may be answered). Cached for a few seconds (lib/waMode.js),
  // so a chatty thread does not query the DB per message.
  const { bot, softOff } = await waMode.modeFor(sessionId);
  const botReplies = bot && !softOff;

  if (data.fromMe) {
    // Our own echo. `from` is this session's own JID there, which is how we learn
    // our `@lid` — WhatsApp reports a mention of us in that form on LID-addressed
    // accounts, so knowing it is what makes "was I mentioned?" answerable later.
    openwa.learnOwnLid(sessionId, data.from);
    openwa.learnOwnLid(sessionId, data.author);
    // Muse mode: our own message going out to a chat means that chat was handled,
    // so it leaves the pending list — the only acknowledgement protocol needed.
    if (!botReplies) await waPending.markHandled(sessionId, data);
    return;
  }

  // Muse mode: the message has been through the mention gate already (see
  // recordPendingInbound, which runs before the acknowledge). `pending` is that
  // decision; when the pre-ack step timed out or threw we get null and re-run it
  // here — the same durable, idempotent write.
  // Muse mode: the message has been through the mention gate already (see
  // recordPendingInbound, which runs before the acknowledge). `preAck.value` is
  // that decision; when the pre-ack step did not answer at all we re-run it here
  // — the same durable, idempotent write.
  if (!botReplies) {
    const outcome = preAck && preAck.ok ? preAck.value : await recordPendingInbound(payload);
    if (outcome && outcome.counted === false) {
      console.log('[OpenWA] Group message not counted for Muse (bot not mentioned)', {
        sessionId,
        chatId: outcome.chatId || (data.chatId || data.from || null),
        reason: outcome.reason,
      });
      return;
    }
    const counted = outcome;
    if (!counted) {
      // Neither the pre-ack recording nor its retry produced a count (a payload
      // without a chat, or the mode flipped between the two): nothing reached the
      // feed, so say so once instead of logging a phantom "counted" line.
      diag.record({
        kind: 'inbound',
        action: 'skip',
        reason: 'not-countable',
        sessionId,
        chatId: data.chatId || data.from || null,
        isGroup: data.isGroup === true || String(data.chatId || data.from || '').endsWith('@g.us'),
      });
      console.log('[OpenWA] Inbound message not counted for Muse (nothing to record)', { sessionId });
      return;
    }
    diag.record({
      kind: 'inbound',
      action: 'pending',
      // `session-disconnected` only means the *bot* is switched off — the message
      // is still pending and still on the feed, because dropping it silently is
      // how a prospect gets lost.
      reason: softOff ? 'session-disconnected' : 'muse-mode',
      sessionId,
      chatId: counted ? counted.chatId : (data.chatId || data.from || null),
      pending: counted ? counted.count : null,
      stored: counted ? counted.stored : null,
      duplicate: counted ? counted.duplicate : null,
      isGroup: data.isGroup === true || String(data.chatId || data.from || '').endsWith('@g.us'),
    });
    console.log('[OpenWA] Message counted for Muse', {
      sessionId,
      chatId: counted ? counted.chatId : null,
      pending: counted ? counted.count : null,
      stored: counted ? counted.stored : null,
      duplicate: counted && counted.duplicate ? true : undefined,
      // True when the owner has the session switched off: not a reason to drop
      // the message, just why the bot will not answer it.
      botOff: softOff || undefined,
    });
    return;
  }

  // Resolve org from stored mapping — never trust payload-supplied org.
  const conn = await getConnectionBySession(sessionId);
  if (!conn) {
    console.warn('[OpenWA] Session identified: none (no whatsapp_connections mapping)', { sessionId });
    return;
  }
  const orgId = conn.organization_id;

  // Privacy ids (`@lid`) are neither valid send targets nor mentionable numbers,
  // so one lookup up front serves both the direct and the group path.
  const senderRaw = String(data.author || data.from || '');
  const senderPhone = senderRaw.endsWith('@lid')
    ? await openwa.resolvePhone(sessionId, senderRaw)
    : null;
  if (senderRaw.endsWith('@lid') && !senderPhone) {
    console.warn('[OpenWA] Could not resolve privacy id to a phone', { from: senderRaw });
  }

  // The session's own identity is what turns "somebody was mentioned" into "THIS
  // bot was mentioned" inside a group. The org's stored number is the reliable
  // source — gateway builds only fill `phone` on some sessions — so the DB wins,
  // and the gateway session (cached) contributes the display name plus a fallback.
  const identity = await openwa.getOwnIdentity(sessionId);
  const ownDigits = digitsOf(conn.phone_number) || identity.digits;
  const ownName = identity.pushName;
  const ownWid = ownDigits ? `${ownDigits}@c.us` : null;
  let ownLids = openwa.getOwnLids(sessionId);

  const planOpts = {
    data,
    ownDigits,
    ownWid,
    ownName,
    ownLids,
    groupRepliesEnabled: conn.group_replies_enabled !== false,
    senderPhone,
  };
  let plan = planInbound(planOpts);

  // A mention of us can arrive as our privacy id (`@248065197879524@lid`) rather
  // than as our number, and the only way to recognise that is to learn our own
  // LID: from the group roster (a participant carries both `number` and `id`) or
  // by resolving the offered mention. Both are cached, and both only run when the
  // cheap checks above missed — a normal message costs nothing extra.
  if (plan.action === 'ignore' && plan.reason === 'group-not-mentioned' && ownDigits) {
    const groupId = String(data.chatId || data.from || '');
    if (!ownLids.length && groupId.endsWith('@g.us')) {
      await openwa.learnOwnLidFromGroup(sessionId, groupId, ownDigits);
      ownLids = openwa.getOwnLids(sessionId);
    }
    if (!ownLids.length) {
      for (const lid of unownedLidMentions(data, ownDigits, ownWid, ownLids)) {
        const phone = await openwa.resolvePhone(sessionId, lid);
        if (phone && digitsOf(phone) === ownDigits) {
          ownLids = openwa.learnOwnLid(sessionId, lid);
          break;
        }
      }
    }
    if (ownLids.length) plan = planInbound({ ...planOpts, ownLids });
  }

  const facts = describeInbound({ data, ownDigits, ownWid, ownName, ownLids });

  if (plan.action === 'ignore') {
    if (facts.isGroup && plan.reason !== 'fromMe' && plan.reason !== 'invalid-chat') {
      // Expected on every group line that is not addressed to us: one log line and
      // one diagnostics record carrying the facts that explain the decision.
      console.log('[OpenWA] Group message ignored', { sessionId, reason: plan.reason, ...facts });
    } else if (plan.reason !== 'fromMe') {
      console.warn('[OpenWA] Inbound ignored', { sessionId, reason: plan.reason });
    }
    diag.record({ kind: 'inbound', action: 'ignore', reason: plan.reason, sessionId, ...facts });
    return;
  }

  diag.record({
    kind: 'inbound',
    action: 'handle',
    sessionId,
    sessionKey: plan.sessionKey,
    replyTo: plan.chatId,
    ...facts,
  });

  console.log('[OpenWA] Incoming message', {
    event, sessionId, from: plan.senderJid, group: plan.isGroup, type: data.type,
  });

  const target = {
    channel: 'openwa',
    sessionId,
    chatId: plan.chatId, // group JID for group replies, the sender otherwise
    // Group replies: the `@<number>` token and the matching WID travel together
    // (channelSend prepends the token to the first part) so the group can see who
    // the answer is for. Both are absent for direct messages.
    ...(plan.mentionPrefix ? { mentionPrefix: plan.mentionPrefix } : {}),
    ...(plan.mentions ? { mentions: plan.mentions } : {}),
  };
  const sessionKey = plan.sessionKey;

  try {
    // V11: voice notes, photos, locations and button taps are decoded into
    // text here (via the shared normaliser) instead of being dropped.
    const normalize = async () => {
      const kind = openwaKindOf(data);
      if (kind === 'audio' || kind === 'image') {
        // Prefer gateway-downloadable bytes; fall back to a URL if the payload
        // carries one. `downloadMedia` returns null on older gateway builds.
        const buffer = data.id ? await openwa.downloadMedia(sessionId, data.id) : null;
        return normalizeInbound({
          kind,
          // Already-downloaded bytes win; otherwise a URL the gateway handed
          // us; otherwise the normaliser reports a readable failure and the
          // customer gets the "please type it" fallback instead of silence.
          buffer,
          mediaUrl: buffer ? null : data.mediaUrl || data.url || null,
          mediaName: kind === 'audio' ? 'voice-note.ogg' : 'photo.jpg',
          mimetype: data.mimetype || undefined,
          caption: data.caption || undefined,
        });
      }
      if (kind === 'location') {
        return normalizeInbound({
          kind: 'location',
          latitude: data.latitude ?? data.lat,
          longitude: data.longitude ?? data.lng,
          locationName: data.name || data.address,
        });
      }
      if (kind === 'interactive') {
        return normalizeInbound({
          kind: 'interactive',
          interactiveId: data.selectedId || data.buttonId || data.payload,
          interactiveTitle: data.selectedTitle || data.buttonText || data.body,
          text: plan.body,
        });
      }
      return normalizeInbound({ kind, text: plan.body, caption: data.caption });
    };

    await handleInbound({
      channel: 'openwa',
      orgId,
      sessionId: sessionKey,
      remoteId: plan.remoteId,
      target,
      profileName: plan.profileName,
      normalize,
    });
    console.log('[OpenWA] Message handled', { sessionId, orgId, chatId: plan.chatId, group: plan.isGroup });
  } catch (err) {
    // Crash the message, never the process.
    console.error('[OpenWA] Message handling failed:', err.message, { sessionId, orgId, chatId: plan.chatId });
  }
}

/**
 * Map an OpenWA payload type to the shared normaliser's `kind`.
 * OpenWA is engine-neutral, so builds differ: WhatsApp Web-style `ptt`/`voice`,
 * Baileys-style `audio`, or a generic `media` with a mimetype.
 */
function openwaKindOf(data) {
  const type = String(data.type || '').toLowerCase();
  const mime = String(data.mimetype || '').toLowerCase();
  if (['ptt', 'voice', 'audio'].includes(type) || mime.startsWith('audio/')) return 'audio';
  if (['image', 'photo', 'sticker'].includes(type) || mime.startsWith('image/')) return type === 'sticker' ? 'sticker' : 'image';
  if (type === 'location') return 'location';
  if (['buttons_response', 'list_response', 'interactive', 'button'].includes(type)) return 'interactive';
  if (type === 'document') return 'document';
  if (type === 'video') return 'video';
  return type === 'text' || !type ? 'text' : 'other';
}

// ============================================================
// Org-scoped management endpoints (JWT auth)
// ============================================================

// GET /api/org/openwa/status — OpenWA connection status for the calling org
orgRouter.get('/status', requireAuth, async (req, res) => {
  const { data: conn, error } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('*')
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  let live = null;
  if (conn?.openwa_session_id) {
    try {
      live = await openwa.getSession(conn.openwa_session_id);
    } catch (e) {
      live = { status: 'error', error: e.message };
    }
  }

  const backendUrl = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  const base = backendUrl.replace(/\/+$/, '');
  // Who answers WhatsApp right now (V13): the org's toggle, unless the server is
  // forcing bot mode. Cheap — lib/waMode.js caches the row.
  const mode = await waMode.statusFor(conn?.openwa_session_id || '');
  // "Disconnect" is a soft switch: the row keeps `openwa_session_id` (and the
  // audit trail), so `linked` says a session is saved and `connected` says the
  // owner has not switched it off. The card must follow the owner's switch, not
  // the mere presence of a mapping — otherwise Disconnect looks like it did
  // nothing. Suspended replies are reported too (toggle saved on + disconnected).
  const softOff = conn?.status === 'disconnected' || conn?.status === 'error';
  const linked = !!conn?.openwa_session_id;
  res.json({
    openwa: {
      baseUrlConfigured: !!config.openwa.baseUrl,
      linked,
      connected: linked && !softOff,
      disconnectedByOwner: linked && softOff,
      sessionId: conn?.openwa_session_id || '',
      phoneNumber: conn?.phone_number || '',
      // V12: group chats are only answered after an @-mention (see lib/openwaInbound.js).
      groupRepliesEnabled: conn ? conn.group_replies_enabled !== false : false,
      status: softOff
        ? conn.status                                   // respect the soft disconnect switch
        : (live?.status || conn?.status || 'disconnected'),
      webhookUrl: `${base}/api/webhooks/openwa`,
      // V13: `autoReply` drives the "Answer WhatsApp from Chitra" toggle.
      //  true  = this backend replies itself (original behaviour)
      //  false = Muse mode: count only, and the pending feed below is what wakes
      //          her up (see lib/waPending.js)
      autoReply: mode.autoReply,
      mode: mode.mode,
      autoReplySource: mode.autoReplySource,             // 'env' | 'org' | 'default'
      autoReplyForcedByEnv: mode.autoReplyForcedByEnv,   // true → the toggle is ignored
      autoReplySuspended: mode.autoReplySuspended,       // saved on, but the session is disconnected
      // false while migration_v13 has not been run: the toggle cannot be saved yet.
      migrationV13Applied: !!conn && Object.prototype.hasOwnProperty.call(conn, 'auto_reply_enabled'),
      // true when a gateway hook is dropping group traffic before it reaches us —
      // the UI offers a one-click repair for exactly this (V15).
      webhookFiltered: await webhookFilterState(conn?.openwa_session_id || ''),
      pendingUrl: `${base}/wa-pending`,
    },
  });
});

// POST /api/org/openwa/connect — verify the session in OpenWA and map it to this org
orgRouter.post('/connect', requireAuth, async (req, res) => {
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  let remote;
  try {
    remote = await openwa.getSession(sessionId);
  } catch (e) {
    return res.status(400).json({ error: `OpenWA session lookup failed: ${e.message}` });
  }

  const backendUrl = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  const webhookUrl = `${backendUrl.replace(/\/+$/, '')}/api/webhooks/openwa`;

  // Best-effort webhook (re)registration so the session forwards message.received
  // events — checked first so a stale hook carrying a group-excluding filter is
  // repaired instead of left dropping group messages (see ensureWebhook).
  let webhook = null;
  try {
    webhook = await ensureWebhook(sessionId, webhookUrl);
    if (!webhook.repaired && webhook.reason !== 'already-clean') {
      console.warn('[OpenWA] Webhook registration outcome:', webhook.reason);
    }
  } catch (e) {
    console.warn('[OpenWA] Webhook ensure failed (session may already be wired):', e.message);
  }

  const phoneNumber = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber.trim() : '';
  const existing = await supabaseAdmin
    .from('whatsapp_connections')
    .select('id')
    .eq('organization_id', req.orgId)
    .maybeSingle();

  // The unique index on openwa_session_id means one WhatsApp session can only
  // belong to one organization — surface that as a clear 409, not a 500.
  const { data: sessionOwner } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('organization_id')
    .eq('openwa_session_id', sessionId)
    .neq('organization_id', req.orgId)
    .maybeSingle();
  if (sessionOwner) {
    return res.status(409).json({
      error: 'This OpenWA session is already connected to another organization. Disconnect it there first.',
    });
  }

  const payload = {
    organization_id: req.orgId,
    provider: 'openwa',
    openwa_session_id: sessionId,
    phone_number: phoneNumber || remote?.phone || null,
    status: 'connected',
    updated_at: new Date().toISOString(),
  };

  let result;
  if (existing?.id) {
    result = await supabaseAdmin
      .from('whatsapp_connections')
      .update(payload)
      .eq('id', existing.id)
      .select()
      .single();
  } else {
    payload.created_at = new Date().toISOString();
    result = await supabaseAdmin
      .from('whatsapp_connections')
      .insert(payload)
      .select()
      .single();
  }

  if (result.error) return res.status(500).json({ error: result.error.message });
  // New mapping and a fresh 'connected' status: drop any cached mode for it.
  waMode.invalidate(sessionId);
  res.json({ ok: true, connection: result.data, webhookUrl, webhook });
});

// POST /api/org/openwa/webhook/repair — re-point this org's session at this
// backend with no excluding filters, so group messages are delivered too.
// Safe to call any time: a correctly wired hook is returned untouched.
orgRouter.post('/webhook/repair', requireAuth, async (req, res) => {
  const { data: conn, error } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('openwa_session_id')
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  const sessionId = conn?.openwa_session_id || (typeof req.body?.sessionId === 'string' ? req.body.sessionId : '');
  if (!sessionId) return res.status(400).json({ error: 'No OpenWA session connected' });

  const backendUrl = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  const webhookUrl = `${backendUrl.replace(/\/+$/, '')}/api/webhooks/openwa`;

  const outcome = await ensureWebhook(sessionId, webhookUrl);
  res.json({ ok: true, sessionId, webhookUrl, ...outcome });
});

// POST /api/org/openwa/settings — per-org WhatsApp behaviour:
//   groupRepliesEnabled (V12) — reply in groups after an @-mention
//   autoReply (V13)           — answer WhatsApp from Chitra instead of Muse
orgRouter.post('/settings', requireAuth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};
  if (typeof body.groupRepliesEnabled === 'boolean') patch.group_replies_enabled = body.groupRepliesEnabled;
  if (typeof body.autoReply === 'boolean') patch.auto_reply_enabled = body.autoReply;
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'groupRepliesEnabled or autoReply (boolean) is required' });
  }

  const { data: conn, error: readErr } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('id, openwa_session_id')
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });
  if (!conn?.id) return res.status(400).json({ error: 'No OpenWA session connected' });

  patch.updated_at = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('whatsapp_connections')
    .update(patch)
    .eq('id', conn.id);
  if (error) {
    // Both columns ship with their own migration — name it instead of a raw
    // Postgres error, so the owner knows exactly what to run.
    if (/auto_reply_enabled/.test(error.message)) {
      return res.status(500).json({
        error: 'Database is missing migration_v13_openwa_auto_reply.sql — run it in the Supabase SQL editor.',
      });
    }
    if (/group_replies_enabled/.test(error.message)) {
      return res.status(500).json({
        error: 'Database is missing migration_v12_openwa_groups.sql — run it in the Supabase SQL editor.',
      });
    }
    return res.status(500).json({ error: error.message });
  }

  // A toggle must bite immediately, not when the mode cache expires.
  waMode.invalidate(conn.openwa_session_id);
  // Deliberately NOT clearing the pending list here. Handing replies back to
  // Chitra means the bot answers *new* messages, so the older unanswered ones stay
  // on the feed until it does (its next reply to that chat settles them) or they
  // age out. Dropping them on a toggle is exactly the silent loss this feed exists
  // to prevent.

  const status = await waMode.statusFor(conn.openwa_session_id);
  // Only what was asked for is echoed back, so a client toggling one switch never
  // sees the other flip. The Channels page reloads GET .../status anyway.
  res.json({
    ok: true,
    ...('group_replies_enabled' in patch
      ? { groupRepliesEnabled: patch.group_replies_enabled !== false }
      : {}),
    ...status,
  });
});

// GET /api/org/openwa/diagnostics — why a message did or did not get a reply.
// Built for the owner, not for logs: it answers the group question directly
// (is the bot mentioned? is the webhook filtered? can we even send to a group?)
// using live gateway state plus the recent in-memory decisions.
orgRouter.get('/diagnostics', requireAuth, async (req, res) => {
  const { data: conn, error } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('*')
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  const sessionId = conn?.openwa_session_id || '';
  const out = {
    configured: { baseUrl: !!config.openwa.baseUrl, apiKey: !!config.openwa.apiKey },
    // The toggle column only exists once migration_v12 has been run.
    migrationV12Applied: !!conn && Object.prototype.hasOwnProperty.call(conn, 'group_replies_enabled'),
    connection: conn
      ? {
        sessionId,
        status: conn.status,
        storedNumber: conn.phone_number || null, // what mention matching trusts
        groupRepliesEnabled: conn.group_replies_enabled !== false,
      }
      : null,
    gatewaySession: null,
    webhooks: null,
    groups: null,
    recentDecisions: diag.list(15),
  };

  if (sessionId) {
    try {
      const live = await openwa.getSession(sessionId);
      out.gatewaySession = {
        status: live?.status || null,
        phone: live?.phone || null,
        pushName: live?.pushName || null,
        engineLoaded: live?.engineLoaded ?? null,
      };
    } catch (e) {
      out.gatewaySession = { error: e.message };
    }
    try {
      const hooks = await openwa.listWebhooks(sessionId);
      const rows = Array.isArray(hooks) ? hooks : (hooks?.webhooks || []);
      // `filters` is the interesting one: a filter like { isGroup: false } would
      // stop group messages before they ever reach this backend.
      out.webhooks = rows.map((h) => ({
        url: h.url || null, events: h.events || null, active: h.active ?? null, filters: h.filters ?? null,
      }));
    } catch (e) {
      out.webhooks = { error: e.message };
    }
    try {
      out.groups = await openwa.listGroups(sessionId);
    } catch (e) {
      out.groups = { error: e.message };
    }
  }

  res.json({ ok: true, diagnostics: out });
});

// POST /api/org/openwa/disconnect — soft-off this session: keep the mapping and
// the audit row, but stop replying (and stop the pending feed driving Muse's hook
// through the mode) until Reconnect. Reversible from the same card.
orgRouter.post('/disconnect', requireAuth, async (req, res) => {
  const { data: conn, error: readErr } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('id, openwa_session_id')
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });

  const { error } = await supabaseAdmin
    .from('whatsapp_connections')
    .update({ status: 'disconnected', updated_at: new Date().toISOString() })
    .eq('organization_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });

  // The switch must bite on the next message, not when the mode cache expires.
  waMode.invalidate(conn?.openwa_session_id);
  res.json({ ok: true, ...(await waMode.statusFor(conn?.openwa_session_id || '')) });
});

// POST /api/org/openwa/reconnect — the "make it work again" button. Reconciles
// the session wiring as well as the session itself: the webhook is repaired
// first (a stale hook with a group-excluding filter is exactly how group
// @-mentions stopped arriving), then the session is started when needed. An
// already-started session is success, not an error — the row flips back to
// 'connected' and answering resumes either way.
orgRouter.post('/reconnect', requireAuth, async (req, res) => {
  const { data: conn, error } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('*')
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!conn?.openwa_session_id) return res.status(400).json({ error: 'No OpenWA session connected' });

  // The webhook can only be verified against the URL this backend is reachable
  // at, which is known here — not in the generic helper.
  const backendUrl = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  const webhookUrl = `${backendUrl.replace(/\/+$/, '')}/api/webhooks/openwa`;
  let webhook = { repaired: false, reason: 'skipped' };
  try {
    webhook = await ensureWebhook(conn.openwa_session_id, webhookUrl);
  } catch (e) {
    console.warn('[OpenWA] Webhook ensure on reconnect failed:', e.message);
  }

  let result;
  try {
    result = await ensureSessionLive(conn.openwa_session_id);
  } catch (e) {
    return res.status(502).json({ error: `Failed to start OpenWA session: ${e.message}` });
  }
  await supabaseAdmin
    .from('whatsapp_connections')
    .update({ status: 'connected', updated_at: new Date().toISOString() })
    .eq('organization_id', req.orgId);
  waMode.invalidate(conn.openwa_session_id);
  res.json({ ok: true, result: result.detail, webhook, ...(await waMode.statusFor(conn.openwa_session_id)) });
});

/**
 * Start the gateway session if it needs starting, without failing when it is
 * already up. Asks the gateway first (a live check never disturbs anything),
 * then calls /start only when needed — and treats "already started" as success,
 * because that state is exactly what Reconnect is trying to reach. A session
 * that is genuinely broken (QR needed, unknown id) still throws, so /reconnect
 * answers those with a 502 and a real message as before.
 */
async function ensureSessionLive(sessionId) {
  let live = null;
  try {
    live = await openwa.getSession(sessionId);
  } catch (e) {
    console.warn('[OpenWA] session check before (re)start failed:', e.message);
  }
  if (waPending.statusIsReady(live && (live.status || live.state)) === true) {
    return { live: true, detail: live };
  }

  try {
    const started = await openwa.startSession(sessionId);
    return { live: true, detail: started };
  } catch (e) {
    if (/already[\s_-]?(start|running|connect)|is already/i.test(e.message || '')) {
      let verify = null;
      try { verify = await openwa.getSession(sessionId); } catch { /* the start error is the answer */ }
      return { live: true, detail: verify || 'already-started' };
    }
    throw e;
  }
}

// POST /api/org/openwa/test — send a test WhatsApp message via OpenWA
orgRouter.post('/test', requireAuth, async (req, res) => {
  let chatId = normalizeChatId(req.body?.chatId);
  if (!chatId) return res.status(400).json({ error: 'chatId is required (e.g. 628123456789)' });
  const text = typeof req.body?.text === 'string' && req.body.text.trim() ? req.body.text.trim() : 'Test message from Chitra AI';

  const { data: conn, error } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('*')
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  const sessionId = conn?.openwa_session_id || (typeof req.body?.sessionId === 'string' ? req.body.sessionId : '');
  if (!sessionId) return res.status(400).json({ error: 'No OpenWA session connected' });

  try {
    await openwa.sendText(sessionId, chatId, text);
  } catch (e) {
    return res.status(502).json({ error: `OpenWA send failed: ${e.message}` });
  }
  res.json({ ok: true });
});

module.exports = { webhookRouter, orgRouter };