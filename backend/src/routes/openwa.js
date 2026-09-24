const express = require('express');
const crypto = require('crypto');
const supabaseAdmin = require('../lib/supabase');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const openwa = require('../services/openwa');
const { normalizeInbound } = require('../services/channelMedia');
const { handleInbound, runChatForChannel } = require('./channels');
const { planInbound, describeInbound, digitsOf } = require('../lib/openwaInbound');
const diag = require('../lib/openwaDiagnostics');

// ============================================================
// OpenWA ⇄ Chitra integration
//  - Inbound: signed OpenWA webhook → existing RAG/Groq pipeline → reply via OpenWA
//  - Management: org-scoped endpoints for the Channels page (status/connect/disconnect/reconnect/test)
// Tenant isolation: the org for an inbound message is resolved from the stored
// `whatsapp_connections` row by session id — NEVER trusted from the webhook payload.
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
webhookRouter.post('/openwa', (req, res) => {
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

  // Accept immediately so OpenWA does not retry; process in the background.
  res.status(200).json({ ok: true });

  handleOpenwaEvent(payload).catch((err) => {
    console.error('[OpenWA] Webhook processing error:', err.message);
  });
});

async function handleOpenwaEvent(payload) {
  const { event, sessionId, idempotencyKey } = (payload && typeof payload === 'object') ? payload : {};
  if (!event || !sessionId) return;
  if (event !== 'message.received') {
    // Ignore lifecycle / other event types safely (no processing, no error)
    return;
  }
  if (isDuplicate(idempotencyKey)) {
    console.log('[OpenWA] Duplicate message skipped', { sessionId, idempotencyKey });
    return;
  }
  markProcessed(idempotencyKey);

  const data = payload.data;
  if (!data || typeof data !== 'object') return;
  if (data.fromMe) return; // ignore our own outbound echoes (no DB call needed)

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

  const plan = planInbound({
    data,
    ownDigits,
    ownWid,
    ownName,
    groupRepliesEnabled: conn.group_replies_enabled !== false,
    senderPhone,
  });
  const facts = describeInbound({ data, ownDigits, ownWid, ownName });

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
  res.json({
    openwa: {
      baseUrlConfigured: !!config.openwa.baseUrl,
      connected: !!conn?.openwa_session_id,
      sessionId: conn?.openwa_session_id || '',
      phoneNumber: conn?.phone_number || '',
      // V12: group chats are only answered after an @-mention (see lib/openwaInbound.js).
      groupRepliesEnabled: conn ? conn.group_replies_enabled !== false : false,
      status: (conn?.status === 'disconnected' || conn?.status === 'error')
        ? conn.status                                   // respect the soft disconnect switch
        : (live?.status || conn?.status || 'disconnected'),
      webhookUrl: `${backendUrl.replace(/\/+$/, '')}/api/webhooks/openwa`,
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

  // Best-effort webhook registration so the session forwards message.received events.
  try {
    await openwa.registerWebhook(sessionId, webhookUrl, config.openwa.webhookSecret);
  } catch (e) {
    console.warn('[OpenWA] Webhook registration failed (session may already be wired):', e.message);
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
  res.json({ ok: true, connection: result.data, webhookUrl });
});

// POST /api/org/openwa/settings — group-reply behaviour (V12)
orgRouter.post('/settings', requireAuth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};
  if (typeof body.groupRepliesEnabled === 'boolean') patch.group_replies_enabled = body.groupRepliesEnabled;
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'groupRepliesEnabled (boolean) is required' });
  }

  const { data: conn, error: readErr } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('id')
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
    // The column ships with migration_v12 — name it instead of a raw Postgres error.
    if (/group_replies_enabled/.test(error.message)) {
      return res.status(500).json({
        error: 'Database is missing migration_v12_openwa_groups.sql — run it in the Supabase SQL editor.',
      });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true, groupRepliesEnabled: patch.group_replies_enabled !== false });
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

// POST /api/org/openwa/disconnect — mark the org's connection disconnected (keep audit row)
orgRouter.post('/disconnect', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('whatsapp_connections')
    .update({ status: 'disconnected', updated_at: new Date().toISOString() })
    .eq('organization_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/org/openwa/reconnect — ask OpenWA to start (reconnect) the org's session
orgRouter.post('/reconnect', requireAuth, async (req, res) => {
  const { data: conn, error } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('*')
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!conn?.openwa_session_id) return res.status(400).json({ error: 'No OpenWA session connected' });

  let result;
  try {
    result = await openwa.startSession(conn.openwa_session_id);
  } catch (e) {
    return res.status(502).json({ error: `Failed to start OpenWA session: ${e.message}` });
  }
  await supabaseAdmin
    .from('whatsapp_connections')
    .update({ status: 'connected', updated_at: new Date().toISOString() })
    .eq('organization_id', req.orgId);
  res.json({ ok: true, result });
});

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