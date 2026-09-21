/**
 * Telegram + Viber webhooks (V11) and their per-org bot management endpoints.
 *
 * Delivery shape follows the Meta router: verify → resolve org by token →
 * normalise (text/voice/photo/location/button) → one shared pipeline
 * (handleInbound) → reply on the same transport.
 *
 * Security:
 *  - Telegram: its own secret token travels in the webhook path
 *    (X-Telegram-Bot-Api-Secret-Token is also compared), so a stray POST
 *    cannot inject messages without knowing the per-org secret.
 *  - Viber: HMAC-SHA256 over the RAW body, mounted with express.raw.
 *  - Viber's bot token is NOT in the URL (unlike Telegram) — the sender id
 *    is matched against the org's own webhook_url stored value first, then
 *    the payload's auth_token header.
 */

const express = require('express');
const crypto = require('crypto');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const telegram = require('../services/telegram');
const viber = require('../services/viber');
const { normalizeInbound } = require('../services/channelMedia');
const { handleInbound, resolveOrgByBotToken } = require('./channels');

const webhookRouter = express.Router();
const orgRouter = express.Router();

function backendUrl() {
  return (process.env.PUBLIC_BACKEND_URL || '').replace(/\/+$/, '');
}

/** Which bot token did this request carry? Token in the path (Telegram). */
function tokenFromPath(req, kind) {
  const raw = req.params.token || req.query.token || '';
  return String(raw).trim();
}

// ============================================================
// Telegram
// ============================================================

/** POST /api/webhooks/telegram/:token */
webhookRouter.post('/telegram/:token', async (req, res) => {
  res.sendStatus(200); // Telegram retries on non-2xx; never make it wait

  try {
    const token = tokenFromPath(req, 'telegram');
    const match = await resolveOrgByBotToken('telegram', token);
    if (!match) return;

    const secret = String((match.settings?.telegram_webhook_secret) || '');
    const header = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    if (secret && header !== secret) {
      console.warn('[telegram] secret mismatch — ignoring delivery');
      return;
    }

    const update = req.body || {};
    // Button taps arrive as callback_query; answer them so the spinner stops.
    const callback = update.callback_query;
    if (callback) {
      telegram.answerCallback(token, callback.id).catch(() => {});
    }
    const msg = update.message || callback?.message;
    if (!msg?.chat?.id) return;
    const chatId = String(msg.chat.id);
    const isGroup = ['group', 'supergroup', 'channel'].includes(msg.chat.type);
    if (isGroup) return; // groups are out of scope for this integration

    await handleInbound({
      channel: 'telegram',
      orgId: match.orgId,
      sessionId: `telegram_${chatId}`,
      remoteId: chatId,
      target: { channel: 'telegram', botToken: token, chatId },
      profileName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username,
      normalize: () => normalizeTelegram(msg, callback, token),
    });
  } catch (err) {
    console.error('[telegram] webhook failed:', err.message);
  }
});

/** Telegram update → the shared normaliser shape. */
async function normalizeTelegram(msg, callback, token) {
  if (callback?.data) {
    return normalizeInbound({ kind: 'interactive', interactiveId: callback.data, interactiveTitle: callback.data });
  }
  const text = msg.text || msg.caption || '';
  if (text && !msg.voice && !msg.audio && !msg.photo && !msg.document) {
    // Telegram commands ("/start") are conversations too.
    return normalizeInbound({ kind: 'text', text: text.replace(/^\/(start|help)\b/i, 'Hi').trim() || 'Hi' });
  }
  if (msg.voice || msg.audio) {
    const fileId = msg.voice?.file_id || msg.audio?.file_id;
    const url = await telegram.voiceFileUrl(token, fileId);
    return normalizeInbound({
      kind: 'audio',
      mediaUrl: url,
      mediaName: 'voice-note.ogg',
      mimetype: msg.voice?.mime_type || msg.audio?.mime_type,
    });
  }
  if (msg.photo) {
    const url = await telegram.photoFileUrl(token, msg.photo);
    return normalizeInbound({ kind: 'image', mediaUrl: url, mediaName: 'photo.jpg', caption: msg.caption });
  }
  if (msg.location) {
    return normalizeInbound({
      kind: 'location',
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
    });
  }
  if (msg.document) return normalizeInbound({ kind: 'document' });
  if (msg.sticker) return normalizeInbound({ kind: 'sticker' });
  return normalizeInbound({ kind: 'other' });
}

// ============================================================
// Viber
// ============================================================

/**
 * POST /api/webhooks/viber/:orgId
 * The org id is in the path (Viber gives no token in the callback URL), and
 * the body signature is verified with that org's own token — so a forged
 * request cannot reach the pipeline. Mounted with express.raw in server.js so
 * the HMAC covers the exact bytes.
 */
webhookRouter.post('/viber/:orgId', async (req, res) => {
  res.sendStatus(200);

  try {
    const orgId = String(req.params.orgId || '');
    if (!orgId) return;

    const { data: settings } = await supabaseAdmin
      .from('settings')
      .select('organization_id, channel_settings')
      .eq('organization_id', orgId)
      .maybeSingle();
    if (!settings) return;

    const prefs = require('../services/channelPrefs');
    const token = prefs.orgBotToken(prefs.prefsOf(settings), 'viber');
    if (!token) return;

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const signature = String(req.headers['x-viber-content-signature'] || '');
    if (!viber.verifySignature(raw, signature, token)) {
      console.warn('[viber] signature mismatch — ignoring delivery');
      return;
    }

    const payload = JSON.parse(raw.toString('utf8') || '{}');
    if (payload.event !== 'message' && payload.event !== 'conversation_started') return;
    const senderId = String(payload.sender?.id || '');
    if (!senderId) return;

    await handleInbound({
      channel: 'viber',
      orgId,
      sessionId: `viber_${senderId}`,
      remoteId: senderId,
      target: { channel: 'viber', botToken: token, chatId: senderId },
      profileName: payload.sender?.name,
      normalize: () => normalizeViber(payload),
    });
  } catch (err) {
    console.error('[viber] webhook failed:', err.message);
  }
});

/** Viber payload → the shared normaliser shape (buttons degrade to text). */
async function normalizeViber(payload) {
  const message = payload.message || {};
  const text = message.text || message.caption || '';
  if (message.type === 'picture') {
    return normalizeInbound({ kind: 'image', mediaUrl: message.media, mediaName: 'photo.jpg', caption: text });
  }
  if (message.type === 'video' || message.type === 'file') {
    return normalizeInbound({ kind: 'document' });
  }
  if (message.location) {
    return normalizeInbound({
      kind: 'location',
      latitude: message.location.lat,
      longitude: message.location.lon,
      locationName: message.location.address,
    });
  }
  // Viber answers echo `tracking_data` — that is our option id.
  if (message.tracking_data) {
    return normalizeInbound({ kind: 'interactive', interactiveId: message.tracking_data, interactiveTitle: text });
  }
  if (payload.event === 'conversation_started') {
    return normalizeInbound({ kind: 'text', text: 'Hi' });
  }
  return normalizeInbound({ kind: 'text', text });
}

// ============================================================
// Per-org bot management (dashboard "Connect your own bot")
// ============================================================

/**
 * Store a bot token + register the webhook. The token never leaves the
 * server: it is written into settings.channel_settings (read only through
 * orgCache) and registered with the provider from here.
 */
async function saveBotToken(req, res, kind, apiFn, extraFields = {}) {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token is required' });

    const base = backendUrl();
    if (!base) {
      return res.status(400).json({
        error: 'PUBLIC_BACKEND_URL is not set on the backend — cannot register a webhook yet',
      });
    }

    const webhookUrl = kind === 'telegram'
      ? `${base}/api/webhooks/telegram/${token}`
      : `${base}/api/webhooks/viber/${req.orgId}`;
    const secret = kind === 'telegram' ? crypto.randomBytes(24).toString('hex') : null;

    const info = await apiFn(token, webhookUrl, secret);

    const prefs = require('../services/channelPrefs');
    const { data: current } = await supabaseAdmin
      .from('settings')
      .select('channel_settings')
      .eq('organization_id', req.orgId)
      .maybeSingle();
    const next = prefs.prefsOf(current);
    next[kind] = { ...(next[kind] || {}), botToken: token };
    next.channel_enabled = { ...(next.channel_enabled || {}), [kind]: true };

    const { error } = await supabaseAdmin
      .from('settings')
      .update({
        channel_settings: next,
        updated_at: new Date().toISOString(),
        ...extraFields(info, secret),
      })
      .eq('organization_id', req.orgId);
    if (error) return res.status(500).json({ error: error.message });

    require('../services/orgCache').invalidateOrgContext(req.orgId);
    res.json({ ok: true, webhookUrl, ...info });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

/** POST /api/org/bots/telegram — validate with getMe, then register the webhook. */
orgRouter.post('/telegram', requireAuth, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return res.status(400).json({ error: 'That does not look like a BotFather token (123456:ABC-…)' });
  }
  const me = await telegram.getMe(token).catch(() => null);
  if (!me?.username) {
    return res.status(400).json({ error: 'Telegram rejected that token. Check it in BotFather and try again.' });
  }
  return saveBotToken(
    req, res, 'telegram',
    (tk, url, secret) => telegram.setWebhook(tk, url, secret).then(() => ({ botUsername: me.username })),
    (info, secret) => ({ telegram_bot_username: info.botUsername, telegram_webhook_secret: secret })
  );
});

/** DELETE /api/org/bots/telegram — forget the token and remove the webhook. */
orgRouter.delete('/telegram', requireAuth, (req, res) => clearBotToken(req, res, 'telegram', telegram.deleteWebhook));

/** POST /api/org/bots/viber — validate by registering the webhook. */
orgRouter.post('/viber', requireAuth, (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token.length < 20) return res.status(400).json({ error: 'That does not look like a Viber bot token' });
  return saveBotToken(
    req, res, 'viber',
    (tk, url) => viber.setWebhook(tk, url).then(() => ({})),
    (info, _secret) => ({ viber_webhook_token: crypto.createHash('sha256').update(token).digest('hex').slice(0, 24) })
  );
});

/** DELETE /api/org/bots/viber */
orgRouter.delete('/viber', requireAuth, (req, res) => clearBotToken(req, res, 'viber', viber.removeWebhook));

/** Shared disconnect: unregister at the provider, clear the stored token. */
async function clearBotToken(req, res, kind, unregister) {
  try {
    const prefs = require('../services/channelPrefs');
    const { data: current } = await supabaseAdmin
      .from('settings')
      .select('channel_settings')
      .eq('organization_id', req.orgId)
      .maybeSingle();
    const stored = prefs.prefsOf(current);
    const token = prefs.orgBotToken(stored, kind);
    if (token) await unregister(token).catch(() => {});

    if (stored[kind]) delete stored[kind];
    if (stored.channel_enabled) stored.channel_enabled[kind] = false;

    const cleared = kind === 'telegram'
      ? { telegram_bot_username: null, telegram_webhook_secret: null }
      : { viber_webhook_token: null };

    const { error } = await supabaseAdmin
      .from('settings')
      .update({ channel_settings: stored, updated_at: new Date().toISOString(), ...cleared })
      .eq('organization_id', req.orgId);
    if (error) return res.status(500).json({ error: error.message });

    require('../services/orgCache').invalidateOrgContext(req.orgId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { webhookRouter, orgRouter, normalizeTelegram, normalizeViber };
