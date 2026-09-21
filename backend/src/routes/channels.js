const express = require('express');
const crypto = require('crypto');
const supabaseAdmin = require('../lib/supabase');
const config = require('../config');

const router = express.Router();

/** Prior messages replayed to the model (see routes/chat.js for the rationale). */
const HISTORY_TURNS = parseInt(process.env.CHAT_HISTORY_TURNS || '4', 10);

/**
 * Shared services, required lazily so the channel router stays light on
 * cold start and unit tests can stub the Supabase client first.
 */
function pipeline() {
  return {
    rag: require('../services/rag'),
    groq: require('../services/groq'),
    tools: require('../services/tools'),
    orgCache: require('../services/orgCache'),
    quotas: require('../services/quotas'),
    media: require('../services/channelMedia'),
    prefs: require('../services/channelPrefs'),
    send: require('../services/channelSend'),
    telegram: require('../services/telegram'),
  };
}

/**
 * Resolve which tenant org a message belongs to.
 * WhatsApp: by phone_number_id stored in settings.whatsapp_phone_number_id
 * Messenger/IG: by page id stored in settings.messenger_page_id
 * Telegram/Viber: by per-org bot token stored in settings.channel_settings
 * (matched without fetching secrets in bulk — see resolveOrgByBotToken).
 */
async function resolveOrgByChannel(channel, externalId) {
  const column = channel === 'whatsapp' ? 'whatsapp_phone_number_id' : 'messenger_page_id';
  const { data } = await supabaseAdmin
    .from('settings')
    .select('organization_id')
    .eq(column, externalId)
    .maybeSingle();
  return data?.organization_id || null;
}

/**
 * Find the org owning a Telegram/Viber bot token without selecting every
 * token into memory: hash-compare candidate rows. Tokens are unique per bot,
 * so the first exact match wins. Returns { orgId, settings } or null.
 */
async function resolveOrgByBotToken(kind, token) {
  if (!token) return null;
  const prefsSvc = pipeline().prefs;
  const wanted = crypto.createHash('sha256').update(String(token)).digest('hex');
  // Narrow first: only orgs that have any channel_settings at all.
  const { data } = await supabaseAdmin
    .from('settings')
    .select('organization_id, channel_settings')
    .neq('channel_settings', '{}');
  for (const row of data || []) {
    const prefs = prefsSvc.prefsOf(row);
    const stored = prefsSvc.orgBotToken(prefs, kind);
    if (stored && crypto.createHash('sha256').update(stored).digest('hex') === wanted) {
      return { orgId: row.organization_id, settings: row };
    }
  }
  return null;
}

/**
 * Remember the native thread for a visitor so broadcasts and owner replies
 * can find it later (channel_contacts). Upserts; never throws.
 */
async function rememberContact(orgId, channel, sessionId, remoteId, displayName) {
  if (!orgId || !remoteId) return;
  try {
    await supabaseAdmin.from('channel_contacts').upsert(
      {
        organization_id: orgId,
        channel,
        session_id: sessionId,
        remote_id: String(remoteId),
        display_name: displayName ? String(displayName).slice(0, 120) : null,
        last_inbound_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,channel,remote_id' }
    );
  } catch (err) {
    console.warn('[channels] rememberContact failed:', err.message);
  }
}

/** Persist one turn of conversation history. */
async function saveTurn(orgId, sessionId, role, message, channel) {
  await supabaseAdmin.from('chat_history').insert({
    organization_id: orgId,
    session_id: sessionId,
    role,
    message,
    channel,
  });
}

/**
 * Meta media object id → downloadable bytes. WhatsApp Cloud and Messenger
 * both expose `/{media-id}` returning a temporary `url`; the token rides in
 * the Authorization header. Returns null on any failure.
 */
async function fetchMetaMedia(mediaId, token) {
  if (!mediaId || !token) return null;
  try {
    const meta = await fetch(
      `https://graph.facebook.com/${config.meta.apiVersion}/${mediaId}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
    ).then((r) => (r.ok ? r.json() : null));
    if (!meta?.url) return null;
    const res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn('[channels] Meta media download failed:', err.message);
    return null;
  }
}

// ============================================================
// GET /api/channels/webhook — Meta verification handshake
// ============================================================
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.meta.verifyToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ============================================================
// POST /api/channels/webhook — inbound messages (WA + Messenger + IG)
// ============================================================
router.post('/webhook', async (req, res) => {
  // Respond immediately; process async (Meta retries on timeout)
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account' && body.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages) continue;

        for (const msg of value.messages) {
          // Per-message isolation: one bad message (or a slow transcription)
          // must never abort the rest of the batch — Meta sends several
          // messages in one delivery.
          try {
            const isWa = body.object === 'whatsapp_business_account';
            const channel = isWa ? 'whatsapp' : isInstagram(entry, msg) ? 'instagram' : 'messenger';
            const orgId = await resolveOrgByChannel(
              isWa ? 'whatsapp' : 'messenger',
              isWa ? value.metadata?.phone_number_id : String(entry.id)
            );
            if (!orgId) continue; // unknown sender — ignore

            const remoteId = isWa ? msg.from : msg.sender?.id;
            if (!remoteId) continue;

            const target = isWa
              ? {
                  channel: 'whatsapp',
                  phoneNumberId: value.metadata?.phone_number_id,
                  chatId: remoteId,
                }
              : { channel, pageId: String(entry.id), recipientId: remoteId };

            await handleInbound({
              channel,
              orgId,
              sessionId: `${channel}_${remoteId}`,
              remoteId,
              target,
              profileName: value.contacts?.[0]?.profile?.name,
              // Media/voice/photo/button normalisation lives in one place so
              // Meta and OpenWA behave identically.
              normalize: () => normalizeMetaMessage(msg),
            });
          } catch (msgErr) {
            console.error('[channels] message failed:', msgErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

/**
 * Normalise one Meta message (WhatsApp/Messenger/IG) into the
 * channelMedia.normalizeInbound shape. Text passes through; everything else
 * is downloaded and transcribed/OCRed, or labelled when it can't be — the
 * caller (handleInbound) turns a labelled failure into a short reply.
 */
async function normalizeMetaMessage(msg) {
  const svc = pipeline();
  const text = msg.text?.body || msg.text;
  if (msg.type === 'text' || (typeof text === 'string' && text.trim())) {
    return svc.media.normalizeInbound({ kind: 'text', text: typeof text === 'string' ? text : '' });
  }

  // Button / list / quick-reply taps arrive as their own types — the tap IS
  // the message. WhatsApp: interactive.button_reply / list_reply.
  if (msg.type === 'interactive') {
    const reply = msg.interactive?.button_reply || msg.interactive?.list_reply || {};
    return svc.media.normalizeInbound({ kind: 'interactive', interactiveId: reply.id, interactiveTitle: reply.title });
  }
  if (msg.type === 'button' && msg.button?.payload) {
    return svc.media.normalizeInbound({ kind: 'button', interactiveId: msg.button.payload, interactiveTitle: msg.button.text });
  }
  // Messenger postback / quick_reply payloads.
  if (msg.postback?.payload) {
    return svc.media.normalizeInbound({ kind: 'interactive', interactiveId: msg.postback.payload, interactiveTitle: msg.postback.title });
  }
  if (msg.quick_reply?.payload) {
    return svc.media.normalizeInbound({ kind: 'interactive', interactiveId: msg.quick_reply.payload, interactiveTitle: msg.text });
  }
  // Nested message objects (Messenger delivers { message: {...} }).
  if (msg.message && (msg.message.text || msg.message.attachments)) {
    return normalizeMetaMessage(msg.message);
  }

  if (msg.type === 'location' || msg.attachments?.[0]?.payload?.coordinates) {
    const coords = msg.location || msg.attachments?.[0]?.payload?.coordinates || {};
    return svc.media.normalizeInbound({
      kind: 'location',
      latitude: coords.lat ?? coords.latitude,
      longitude: coords.long ?? coords.longitude,
      locationName: coords.name,
    });
  }

  const token = config.whatsapp.token;
  if ((msg.type === 'audio' || msg.type === 'voice' || msg.type === 'ptt') && msg.audio?.id) {
    const buf = await fetchMetaMedia(msg.audio.id, token);
    if (buf) {
      try {
        return {
          text: `[Voice message] ${await svc.media.voiceToText(buf, { name: 'voice-note.ogg', mimetype: 'audio/ogg' })}`,
          mediaKind: 'audio',
          mediaFailed: false,
        };
      } catch (err) {
        console.warn('[channels] Meta voice failed:', err.message);
      }
    }
    return { text: '', mediaKind: 'audio', mediaFailed: true };
  }

  if (msg.type === 'image' && (msg.image?.id || msg.image?.link)) {
    let buf = null;
    if (msg.image.id) buf = await fetchMetaMedia(msg.image.id, token);
    if (!buf && msg.image.link) {
      try {
        const res = await fetch(msg.image.link, { signal: AbortSignal.timeout(20000) });
        if (res.ok) buf = Buffer.from(await res.arrayBuffer());
      } catch { /* fall through to the failure result */ }
    }
    if (buf) {
      try {
        const text = await svc.media.imageToText(buf, { name: 'photo.jpg' });
        const caption = msg.image.caption ? `\n(Caption: ${msg.image.caption})` : '';
        return { text: `[Photo] ${text}${caption}`.trim(), mediaKind: 'image', mediaFailed: false };
      } catch (err) {
        console.warn('[channels] Meta image failed:', err.message);
      }
    }
    return { text: '', mediaKind: 'image', mediaFailed: true };
  }

  if (msg.type === 'sticker') return svc.media.normalizeInbound({ kind: 'sticker' });
  if (msg.type === 'document' || msg.type === 'video') {
    return svc.media.normalizeInbound({ kind: msg.type });
  }
  return svc.media.normalizeInbound({ kind: 'other' });
}

/**
 * Detect Instagram DM threads (they arrive in the `page` object too, and the
 * old code labelled them "messenger" so IG analytics were wrong).
 */
function isInstagram(entry, msg) {
  return Boolean(
    msg?.instagram ||
    msg?.referral?.source === 'instagram' ||
    entry?.messaging?.[0]?.message?.is_instagram
  );
}

/**
 * Ingest one normalized inbound message and reply on the same channel.
 *
 * Order of operations matters and mirrors routes/chat.js:
 *   1. normalise (voice → text, photo → text, tap → text, location → text)
 *   2. remember the native thread (broadcasts/owner replies need it)
 *   3. handoff / channel toggle / office-hours short-circuits — before the
 *      LLM, so a paused chat never spends tokens
 *   4. LLM turn, then send (split parts, template fallback, buttons, media)
 *   5. bookkeeping after the send
 */
async function handleInbound({ channel, orgId, sessionId, remoteId, target, profileName, normalize }) {
  const svc = pipeline();

  const normalized = await normalize();
  const userText = normalized.text || '';

  rememberContact(orgId, channel, sessionId, remoteId, profileName);

  // Media that could not be read: answer immediately, never silently drop.
  if (normalized.mediaFailed && !userText) {
    const fallback = svc.media.mediaFallbackText();
    try {
      await svc.send.sendChannelText(target, fallback);
    } catch (err) {
      console.error(`[${channel}] fallback send failed:`, err.message);
    }
    saveTurn(orgId, sessionId, 'assistant', fallback, channel).catch(() => {});
    return;
  }

  const ctx = await svc.orgCache.getOrgContext(orgId);
  const prefs = svc.prefs.prefsOf(ctx?.settings);

  // A channel the owner switched off in the dashboard.
  if (!svc.prefs.channelEnabled(prefs, channel)) {
    console.log(`[${channel}] disabled for org ${orgId} — ignoring message`);
    return;
  }

  // Owner has taken over this conversation: record the message for the Inbox,
  // but do not let the bot answer over the human.
  if (svc.prefs.isHandoffActive(prefs, sessionId)) {
    saveTurn(orgId, sessionId, 'user', userText || '[media]', channel).catch(() => {});
    return;
  }

  // Office hours: an auto-reply outside business hours, no LLM spend.
  const closed = svc.prefs.officeClosedMessage(prefs);
  if (closed) {
    saveTurn(orgId, sessionId, 'user', userText || '[media]', channel).catch(() => {});
    try {
      await svc.send.sendChannelText(target, closed);
    } catch (err) {
      console.error(`[${channel}] closed-message send failed:`, err.message);
    }
    saveTurn(orgId, sessionId, 'assistant', closed, channel).catch(() => {});
    return;
  }

  saveTurn(orgId, sessionId, 'user', userText || '[media]', channel).catch((e) =>
    console.error('saveTurn (user) failed:', e.message)
  );

  const reply = await runChatForChannel(orgId, sessionId, userText, channel, { target, prefs });

  try {
    await svc.send.sendChannelText(target, reply, { template: svc.prefs.whatsappTemplate(prefs) });
  } catch (sendErr) {
    console.error(`[${channel}] send failed:`, sendErr.message);
  }

  await saveTurn(orgId, sessionId, 'assistant', reply, channel);
}

/**
 * Outbound helpers the chat pipeline calls when a tool asked for buttons or
 * media. Kept here (not in the tool executor) because only the transport
 * knows how to render them.
 */
async function deliverInteractive(target, _prefs, bodyText, options) {
  const svc = pipeline();
  try {
    return await svc.send.sendInteractive(target, bodyText, options);
  } catch (err) {
    console.error('[channels] interactive delivery failed:', err.message);
    return null;
  }
}

async function deliverMedia(target, media) {
  const svc = pipeline();
  try {
    return await svc.send.sendMedia(target, media);
  } catch (err) {
    console.error('[channels] media delivery failed:', err.message);
    return null;
  }
}

async function runChatForChannel(orgId, sessionId, message, channel, extra = {}) {
  const svc = pipeline();
  const { retrieveContext, trackUsage } = svc.rag;
  const { buildSystemPrompt, getToolSchemas, runChatTurn } = svc.groq;
  const { createToolExecutor } = svc.tools;
  const { getOrgContext } = svc.orgCache;
  const { messageQuotaFor, countMessages, usageResult, quotaExceededMessage } = svc.quotas;

  // One parallel wave (same reasoning as routes/chat.js): org+settings come from
  // the short-lived cache, and the two usage counts are fetched together so the
  // plan can pick whichever period applies without a second round-trip.
  const [ctx, historyRes, contextChunks, usedLifetime, usedThisMonth] = await Promise.all([
    getOrgContext(orgId),
    supabaseAdmin
      .from('chat_history')
      .select('role, message')
      .eq('organization_id', orgId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_TURNS),
    retrieveContext(orgId, message),
    countMessages(orgId, 'lifetime'),
    countMessages(orgId, 'month'),
  ]);

  if (!ctx) return 'Sorry, this business is unavailable.';
  const { org, settings } = ctx;

  // Quota check — free (and expired) plans have a one-time lifetime allowance,
  // paid plans a monthly one. The per-org override lives on `organizations`.
  const quota = messageQuotaFor(org);
  const usage = usageResult(quota, quota.period === 'month' ? usedThisMonth : usedLifetime);
  if (usage.exceeded) return quotaExceededMessage(usage.period);

  const priorMessages = (historyRes.data || []).reverse().map((h) => ({ role: h.role, content: h.message }));

  const result = await runChatTurn({
    messages: [
      { role: 'system', content: buildSystemPrompt(org, settings, contextChunks, channel) },
      ...priorMessages,
      { role: 'user', content: message },
    ],
    // Channel-only tools (buttons/media) are offered on transports that can
    // render them; the web widget keeps the plain tool set. See
    // services/groq.js#getToolSchemas.
    tools: getToolSchemas({ channel }),
    executeTool: createToolExecutor(orgId, org, settings, {
      sessionId,
      channel,
      target: extra.target,
      prefs: extra.prefs,
      deliverInteractive,
      deliverMedia,
    }),
    // WhatsApp/Messenger render plain text and the prompt asks for <150 words,
    // so a tighter cap means the visitor waits less for the same answer.
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS_CHANNEL || '450', 10),
  });

  // Off the critical path: the visitor should not wait on usage bookkeeping
  // before the reply is sent back to WhatsApp / Messenger.
  trackUsage(orgId, 'message').catch((e) => console.error('trackUsage failed:', e.message));
  return result.reply;
}

module.exports = router;
module.exports.runChatForChannel = runChatForChannel;
module.exports.handleInbound = handleInbound;
module.exports.normalizeMetaMessage = normalizeMetaMessage;
module.exports.resolveOrgByBotToken = resolveOrgByBotToken;
module.exports.rememberContact = rememberContact;
module.exports.voiceToText = (...args) => pipeline().media.voiceToText(...args);
module.exports.imageToText = (...args) => pipeline().media.imageToText(...args);
