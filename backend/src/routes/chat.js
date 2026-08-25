const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { retrieveContext, trackUsage } = require('../services/rag');
const { buildSystemPrompt, getToolSchemas, runChatTurn } = require('../services/groq');
const { createToolExecutor } = require('../services/tools');
const config = require('../config');

const router = express.Router();

/**
 * POST /api/chat
 * Public endpoint used by the embeddable widget & test chat.
 * Body: { orgId, sessionId, message, channel? }
 */
router.post('/', async (req, res) => {
  try {
    const { orgId, sessionId, message, channel = 'web' } = req.body;
    if (!orgId || !sessionId || !message) {
      return res.status(400).json({ error: 'orgId, sessionId and message are required' });
    }

    // Load org + settings (public info only)
    const { data: org, error: orgErr } = await supabaseAdmin
      .from('organizations')
      .select('id, name, industry')
      .eq('id', orgId)
      .single();
    if (orgErr || !org) return res.status(404).json({ error: 'Business not found' });

    const { data: settings } = await supabaseAdmin
      .from('settings')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle();

    // ---- Free-tier quota check (messages/month) ----
    // Plan quota (free/pro/agency) takes priority; falls back to platform default.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const { count: msgCount } = await supabaseAdmin
      .from('usage_events')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('event_type', 'message')
      .gte('created_at', monthStart.toISOString());

    const { data: orgPlan } = await supabaseAdmin
      .from('organizations')
      .select('monthly_message_quota, plan, plan_expires_at')
      .eq('id', orgId)
      .single();

    // Paid plan expired? Downgrade to free quotas.
    const planActive = orgPlan?.plan && orgPlan.plan !== 'free'
      && (!orgPlan.plan_expires_at || new Date(orgPlan.plan_expires_at) > new Date());

    let messageQuota;
    if (planActive) {
      messageQuota = orgPlan.monthly_message_quota
        ?? require('../services/payments').PLAN_QUOTAS[orgPlan.plan].messagesPerMonth;
    } else {
      messageQuota = orgPlan?.monthly_message_quota ?? config.freeTierQuotas.messagesPerMonth;
    }

    if (msgCount >= messageQuota) {
      return res.status(429).json({
        error: 'This business has reached its monthly message limit. Please try again later.',
        quota_exceeded: true,
        limit: messageQuota,
      });
    }

    // ---- RAG retrieval ----
    const contextChunks = await retrieveContext(orgId, message);

    // ---- Conversation history (last 10 turns) ----
    const { data: history } = await supabaseAdmin
      .from('chat_history')
      .select('role, message')
      .eq('organization_id', orgId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(10);

    const priorMessages = (history || []).reverse().map((h) => ({
      role: h.role,
      content: h.message,
    }));

    // ---- LLM turn with tools ----
    const messages = [
      { role: 'system', content: buildSystemPrompt(org, settings, contextChunks, channel) },
      ...priorMessages,
      { role: 'user', content: message },
    ];

    const executeTool = createToolExecutor(orgId, org, settings, { sessionId });

    let result;
    try {
      result = await runChatTurn({
        messages,
        tools: getToolSchemas(),
        executeTool,
      });
    } catch (llmErr) {
      console.error('Groq error:', llmErr.message);
      return res.status(502).json({ error: 'AI service temporarily unavailable. Please try again.' });
    }

    // ---- Persist history ----
    await supabaseAdmin.from('chat_history').insert([
      { organization_id: orgId, session_id: sessionId, role: 'user', message, channel },
      { organization_id: orgId, session_id: sessionId, role: 'assistant', message: result.reply, channel },
    ]);

    await trackUsage(orgId, 'message');

    res.json({
      reply: result.reply,
      actions: result.toolCallsExecuted,
      sources: contextChunks.map((c) => c.id),
      provider: result.provider,
    });
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
