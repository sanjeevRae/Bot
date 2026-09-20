const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { retrieveContext, trackUsage } = require('../services/rag');
const { buildSystemPrompt, getToolSchemas, runChatTurn } = require('../services/groq');
const { createToolExecutor } = require('../services/tools');
const { messageQuotaFor, countMessages, usageResult, quotaExceededMessage } = require('../services/quotas');
const { getOrgContext } = require('../services/orgCache');
const { issueSession, verifySession } = require('../lib/sessionToken');

const router = express.Router();

/**
 * How many prior messages to replay to the model. Each one is input tokens the
 * model must read before answering, so this trades a little continuity for
 * latency (6 ≈ three back-and-forth exchanges, plenty for booking flows).
 */
const HISTORY_TURNS = parseInt(process.env.CHAT_HISTORY_TURNS || '4', 10);

/**
 * POST /api/chat/session
 * Public. Issues a fresh, unguessable session bound to an org, with an HMAC
 * token the client must present on every message. This is the ONLY way a
 * visitor gets a session id — client-invented ids are rejected by /api/chat.
 * Body: { orgId }
 */
router.post('/session', async (req, res) => {
  try {
    const { orgId } = req.body || {};
    if (!orgId) return res.status(400).json({ error: 'orgId is required' });

    const { data: org, error } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('id', orgId)
      .single();
    if (error || !org) return res.status(404).json({ error: 'Business not found' });

    res.json(issueSession(orgId));
  } catch (err) {
    console.error('Session route error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/chat
 * Public endpoint used by the embeddable widget, the /bot page & test chat.
 * Body: { orgId, sessionId, sessionToken, message, channel? }
 *
 * The (sessionId, sessionToken) pair must have been issued by /api/chat/session
 * for this exact org — this is what prevents visitor B from continuing
 * visitor A's conversation (requirement: strict per-session isolation).
 */
router.post('/', async (req, res) => {
  try {
    const { orgId, sessionId, sessionToken, message, channel = 'web' } = req.body;
    if (!orgId || !sessionId || !message) {
      return res.status(400).json({ error: 'orgId, sessionId and message are required' });
    }

    // ---- Session ownership (server-side verification, never trusted from client) ----
    const session = verifySession(orgId, sessionId, sessionToken);
    if (!session.ok) {
      return res.status(403).json({
        error: 'Invalid or expired chat session. Please reload the chat.',
        code: session.reason, // invalid_session_id | missing_token | token_mismatch
        new_session: true,
      });
    }

    // ---- Everything the turn needs, in ONE parallel wave ------------------
    // Previously these were 7 sequential awaits (~340 ms each against a remote
    // Supabase), so a reply could not start before ~2.4 s. They are independent,
    // so they run together now: wall time is the slowest single call, not the sum.
    // Both usage counts are fetched (lifetime + this month) because which one
    // applies depends on the plan, which is only known once the org resolves.
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

    if (!ctx) return res.status(404).json({ error: 'Business not found' });
    const { org, settings } = ctx;

    // ---- Quota check (free = one-time allowance, paid = monthly) ----
    const quota = messageQuotaFor(org);
    const usage = usageResult(quota, quota.period === 'month' ? usedThisMonth : usedLifetime);

    if (usage.exceeded) {
      return res.status(429).json({
        error: quotaExceededMessage(usage.period),
        quota_exceeded: true,
        limit: usage.limit,
        period: usage.period,
      });
    }

    const priorMessages = (historyRes.data || []).reverse().map((h) => ({
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
        maxTokens: parseInt(process.env.LLM_MAX_TOKENS_WEB || '600', 10),
      });
    } catch (llmErr) {
      console.error('Groq error:', llmErr.message);
      return res.status(502).json({ error: 'AI service temporarily unavailable. Please try again.' });
    }

    // ---- Respond first, persist after ---------------------------------------
    // History + usage inserts are two more Supabase round-trips (~340 ms each).
    // The visitor doesn't need them to read the reply, so they run after the
    // response is flushed. A failure here is logged, never surfaced.
    res.json({
      reply: result.reply,
      actions: result.toolCallsExecuted,
      sources: contextChunks.map((c) => c.id),
      provider: result.provider,
    });

    void Promise.all([
      supabaseAdmin.from('chat_history').insert([
        { organization_id: orgId, session_id: sessionId, role: 'user', message, channel },
        { organization_id: orgId, session_id: sessionId, role: 'assistant', message: result.reply, channel },
      ]),
      trackUsage(orgId, 'message'),
    ]).catch((e) => console.error('Post-reply persistence failed:', e.message));
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
