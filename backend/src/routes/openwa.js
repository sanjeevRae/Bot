const express = require('express');
const crypto = require('crypto');
const supabaseAdmin = require('../lib/supabase');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const openwa = require('../services/openwa');
const { runChatForChannel } = require('./channels');

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

// A JID like "628123456789@c.us" (engine-neutral). Reject anything malformed.
function sanitizeJid(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(s)) return null;
  return s;
}

function normalizeChatId(v) {
  const s = String(v).trim();
  if (!s) return null;
  return s.includes('@') ? s : `${s}@c.us`;
}

// Resolve the org owning a session from the DB — the only trusted source.
async function getConnectionBySession(sessionId) {
  const { data } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('id, organization_id, openwa_session_id, phone_number, status, provider')
    .eq('openwa_session_id', sessionId)
    .maybeSingle();
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

  // Only text messages for now. Other types are safely ignored.
  if (data.type && data.type !== 'text') return;
  const body = String(data.body || '').trim();
  if (!body) return;
  if (data.fromMe) return; // ignore our own outbound echoes

  const isGroup = data.isGroup === true || String(data.chatId || '').endsWith('@g.us');
  if (isGroup) return; // group messages ignored for this integration

  let from = sanitizeJid(data.from || data.chatId);
  if (!from) return;

  console.log('[OpenWA] Incoming message', { event, sessionId, from });

  // WhatsApp privacy ids (`@lid`) cannot be used as send targets — resolve the
  // real phone number first so replies reach the customer.
  let replyTo = from;
  if (from.endsWith('@lid')) {
    const phone = await openwa.resolvePhone(sessionId, from);
    if (phone) {
      replyTo = `${phone.replace(/\D/g, '')}@c.us`;
      console.log('[OpenWA] Resolved privacy id to phone', { from, replyTo });
    } else {
      console.warn('[OpenWA] Could not resolve privacy id to a phone; replying to raw JID', { from });
    }
  }

  // Resolve org from stored mapping — never trust payload-supplied org.
  const conn = await getConnectionBySession(sessionId);
  if (!conn) {
    console.warn('[OpenWA] Session identified: none (no whatsapp_connections mapping)', { sessionId });
    return;
  }
  console.log('[OpenWA] Session identified', { sessionId, orgId: conn.organization_id });

  const orgId = conn.organization_id;
  const sessionKey = `whatsapp_${replyTo.split('@')[0]}`;
  const messageBody = body.slice(0, 4000);

  try {
    // Store the user turn in the EXISTING conversation system.
    await supabaseAdmin.from('chat_history').insert({
      organization_id: orgId,
      session_id: sessionKey,
      role: 'user',
      message: messageBody,
      channel: 'whatsapp',
    });

    console.log('[OpenWA] Processing with Chitra AI', { sessionId, orgId, replyTo });
    // Reuse the existing RAG + Groq + tools + quota pipeline (no duplicate AI logic).
    const reply = await runChatForChannel(orgId, sessionKey, messageBody, 'whatsapp');
    if (!reply || !reply.trim()) {
      console.warn('[OpenWA] Empty AI reply', { sessionId, orgId, replyTo });
      return;
    }

    // Store the assistant turn.
    await supabaseAdmin.from('chat_history').insert({
      organization_id: orgId,
      session_id: sessionKey,
      role: 'assistant',
      message: reply.slice(0, 4000),
      channel: 'whatsapp',
    });

    console.log('[OpenWA] Sending response', { sessionId, orgId, replyTo });
    await openwa.sendText(sessionId, replyTo, reply.slice(0, 4096));
    console.log('[OpenWA] Message sent', { sessionId, orgId, replyTo });
  } catch (err) {
    // Crash the message, never the process.
    console.error('[OpenWA] Message handling failed:', err.message, { sessionId, orgId, replyTo });
  }
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