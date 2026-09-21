const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const prefs = require('../services/channelPrefs');
const { sendChannelText } = require('../services/channelSend');
const { invalidateOrgContext } = require('../services/orgCache');

const router = express.Router();
router.use(requireAuth);

/**
 * Inbox & human handoff (V11).
 *
 * The original one-way inbox let the owner *see* a flagged chat but not reply
 * to it, while the bot kept answering the same customer. V11 closes the loop:
 *
 *   - `POST /:sessionId/takeover` → the owner owns this chat. The session id
 *     goes into settings.channel_settings.handoff.activeSessionIds, which the
 *     channel pipelines check BEFORE calling the LLM, so the bot stops
 *     answering over the human. Resolve takes it back out.
 *   - `POST /:sessionId/reply`    → send a human reply on the session's own
 *     transport (WhatsApp Meta / OpenWA / Messenger / Instagram / Telegram /
 *     Viber), and store it in chat_history so the transcript stays truthful.
 *
 * Transport resolution reads channel_contacts (written on every inbound
 * message) rather than guessing from the session-id prefix: the prefix gives
 * the channel, the row gives the native thread id to send to.
 */

/**
 * GET /api/inbox — chat sessions flagged for human follow-up.
 * Returns one entry per session with the full transcript.
 */
router.get('/', async (req, res) => {
  // Distinct sessions with an unresolved handoff request
  const { data: flagged, error } = await supabaseAdmin
    .from('chat_history')
    .select('session_id, channel, created_at')
    .eq('organization_id', req.orgId)
    .eq('handoff_requested', true)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const sessions = [...new Map((flagged || []).map((f) => [f.session_id, f])).values()];

  // Which of these chats is the owner currently handling (bot paused)?
  const { data: settingsRow } = await supabaseAdmin
    .from('settings')
    .select('channel_settings')
    .eq('organization_id', req.orgId)
    .maybeSingle();
  const active = prefs.handoffSessionIds(prefs.prefsOf(settingsRow));

  // Fetch transcripts for each session
  const items = await Promise.all(
    sessions.map(async (s) => {
      const { data: msgs } = await supabaseAdmin
        .from('chat_history')
        .select('role, message, created_at')
        .eq('organization_id', req.orgId)
        .eq('session_id', s.session_id)
        .order('created_at', { ascending: true });

      // Native thread for the reply box (channel_contacts is written on every
      // inbound message, so the row exists by the time a handoff is flagged).
      const { data: contact } = await supabaseAdmin
        .from('channel_contacts')
        .select('channel, remote_id, display_name')
        .eq('organization_id', req.orgId)
        .eq('session_id', s.session_id)
        .maybeSingle();

      return {
        sessionId: s.session_id,
        channel: contact?.channel || s.channel,
        displayName: contact?.display_name || null,
        remoteId: contact?.remote_id || null,
        botPaused: active.includes(s.session_id),
        requestedAt: s.created_at,
        messages: msgs || [],
      };
    })
  );

  res.json({ conversations: items });
});

/** Mark a handoff handled — and let the bot answer again. */
router.patch('/:sessionId/resolve', async (req, res) => {
  const { error } = await supabaseAdmin
    .from('chat_history')
    .update({ handoff_resolved: true })
    .eq('organization_id', req.orgId)
    .eq('session_id', req.params.sessionId)
    .eq('handoff_requested', true);

  if (error) return res.status(500).json({ error: error.message });
  try {
    await setBotPaused(req.orgId, req.params.sessionId, false);
  } catch (err) {
    console.error('[inbox] un-pause failed:', err.message);
  }
  res.json({ ok: true });
});

/** Hand the conversation to a human (bot stops answering until resolved). */
router.post('/:sessionId/takeover', async (req, res) => {
  try {
    await setBotPaused(req.orgId, req.params.sessionId, true);
    res.json({ ok: true, botPaused: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Owner reply into a live conversation.
 * Body: { text, resumeBot? } — `resumeBot: true` flips the bot back on after
 * sending, which is the "I handled it" shortcut.
 */
router.post('/:sessionId/reply', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    const sessionId = req.params.sessionId;
    const { data: contact, error: contactErr } = await supabaseAdmin
      .from('channel_contacts')
      .select('channel, remote_id')
      .eq('organization_id', req.orgId)
      .eq('session_id', sessionId)
      .maybeSingle();
    if (contactErr) return res.status(500).json({ error: contactErr.message });
    if (!contact) {
      return res.status(400).json({
        error: 'No native thread recorded for this conversation yet — the customer must message you first on the channel.',
      });
    }

    const target = await buildTarget(req.orgId, contact.channel, contact.remote_id);
    if (!target) {
      return res.status(400).json({
        error: `${contact.channel} is not connected any more. Reconnect it on the Channels page and try again.`,
      });
    }

    await sendChannelText(target, text);

    await supabaseAdmin.from('chat_history').insert({
      organization_id: req.orgId,
      session_id: sessionId,
      role: 'assistant',
      message: text,
      channel: contact.channel,
    });

    if (req.body?.resumeBot) {
      await setBotPaused(req.orgId, sessionId, false);
      await supabaseAdmin
        .from('chat_history')
        .update({ handoff_resolved: true })
        .eq('organization_id', req.orgId)
        .eq('session_id', sessionId)
        .eq('handoff_requested', true);
    }

    res.json({ ok: true, channel: contact.channel, botPaused: !req.body?.resumeBot });
  } catch (err) {
    res.status(502).json({ error: `Send failed: ${err.message}` });
  }
});

/** Add/remove a session from the bot-pause list in channel_settings. */
async function setBotPaused(orgId, sessionId, paused) {
  const { data: current } = await supabaseAdmin
    .from('settings')
    .select('channel_settings')
    .eq('organization_id', orgId)
    .maybeSingle();
  const settings = prefs.prefsOf(current);
  const list = new Set(prefs.handoffSessionIds(settings));
  if (paused) list.add(sessionId);
  else list.delete(sessionId);
  settings.handoff = { ...(settings.handoff || {}), activeSessionIds: [...list] };

  const { error } = await supabaseAdmin
    .from('settings')
    .update({ channel_settings: settings, updated_at: new Date().toISOString() })
    .eq('organization_id', orgId);
  if (error) throw error;
  invalidateOrgContext(orgId);
}

/**
 * Resolve the transport address for a channel + native id, using the org's
 * own connection settings. Returns null when that channel isn't connected.
 */
async function buildTarget(orgId, channel, remoteId) {
  const { data: settings } = await supabaseAdmin
    .from('settings')
    .select('channel_settings, whatsapp_phone_number_id, messenger_page_id')
    .eq('organization_id', orgId)
    .maybeSingle();
  const stored = prefs.prefsOf(settings);

  if (channel === 'whatsapp') {
    if (!settings?.whatsapp_phone_number_id) return null;
    return { channel: 'whatsapp', phoneNumberId: settings.whatsapp_phone_number_id, chatId: remoteId };
  }
  if (channel === 'messenger' || channel === 'instagram') {
    if (!settings?.messenger_page_id) return null;
    return { channel, pageId: settings.messenger_page_id, recipientId: remoteId };
  }
  if (channel === 'telegram') {
    const botToken = prefs.orgBotToken(stored, 'telegram');
    return botToken ? { channel: 'telegram', botToken, chatId: remoteId } : null;
  }
  if (channel === 'viber') {
    const botToken = prefs.orgBotToken(stored, 'viber');
    return botToken ? { channel: 'viber', botToken, chatId: remoteId } : null;
  }
  if (channel === 'openwa') {
    const { data: conn } = await supabaseAdmin
      .from('whatsapp_connections')
      .select('openwa_session_id, status')
      .eq('organization_id', orgId)
      .maybeSingle();
    if (!conn?.openwa_session_id || conn.status === 'disconnected') return null;
    const jid = String(remoteId).includes('@') ? String(remoteId) : `${String(remoteId).replace(/\D/g, '')}@c.us`;
    return { channel: 'openwa', sessionId: conn.openwa_session_id, chatId: jid };
  }
  return null;
}

module.exports = router;
