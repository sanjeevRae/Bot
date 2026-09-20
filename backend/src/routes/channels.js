const express = require('express');
const crypto = require('crypto');
const supabaseAdmin = require('../lib/supabase');
const config = require('../config');
const { sendWhatsApp, sendMessenger } = require('../services/channels');

const router = express.Router();

/** Prior messages replayed to the model (see routes/chat.js for the rationale). */
const HISTORY_TURNS = parseInt(process.env.CHAT_HISTORY_TURNS || '4', 10);

/**
 * Resolve which tenant org a message belongs to.
 * WhatsApp: by phone_number_id stored in settings.whatsapp_phone_number_id
 * Messenger/IG: by page id stored in settings.messenger_page_id
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
          if (msg.type !== 'text' || !msg.text?.body) continue;

          let orgId = null;
          let channel = 'web';
          let send;

          if (body.object === 'whatsapp_business_account') {
            channel = 'whatsapp';
            orgId = await resolveOrgByChannel('whatsapp', value.metadata?.phone_number_id);
            send = (text) => sendWhatsApp(value.metadata.phone_number_id, msg.from, text);
          } else {
            // page object covers Messenger and Instagram DMs
            const isIG = !!value.postback?.instagram || msg.instagram;
            channel = 'messenger';
            orgId = await resolveOrgByChannel('messenger', String(entry.id));
            send = (text) => sendMessenger(String(entry.id), msg.sender?.id, text);
          }

          if (!orgId) continue; // unknown sender — ignore

          const sessionId = `${channel}_${msg.from}`;

          // Don't block the reply on history bookkeeping — the pipeline only
          // needs prior turns, and this turn's message is passed explicitly.
          saveTurn(orgId, sessionId, 'user', msg.text.body, channel).catch((e) =>
            console.error('saveTurn (user) failed:', e.message)
          );

          // Run the same chat pipeline as the web widget
          const reply = await runChatForChannel(orgId, sessionId, msg.text.body, channel);

          try {
            await send(reply);
          } catch (sendErr) {
            console.error(`[${channel}] send failed:`, sendErr.message);
          }

          await saveTurn(orgId, sessionId, 'assistant', reply, channel);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

/** Shared chat pipeline (mirrors routes/chat.js but without HTTP response). */
async function runChatForChannel(orgId, sessionId, message, channel) {
  const { retrieveContext, trackUsage } = require('../services/rag');
  const { buildSystemPrompt, getToolSchemas, runChatTurn } = require('../services/groq');
  const { createToolExecutor } = require('../services/tools');
  const { getOrgContext } = require('../services/orgCache');
  const { messageQuotaFor, countMessages, usageResult, quotaExceededMessage } = require('../services/quotas');

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
    tools: getToolSchemas(),
    executeTool: createToolExecutor(orgId, org, settings, { sessionId }),
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
