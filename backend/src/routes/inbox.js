const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

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

  // Fetch transcripts for each session
  const items = await Promise.all(
    sessions.map(async (s) => {
      const { data: msgs } = await supabaseAdmin
        .from('chat_history')
        .select('role, message, created_at')
        .eq('organization_id', req.orgId)
        .eq('session_id', s.session_id)
        .order('created_at', { ascending: true });

      return {
        sessionId: s.session_id,
        channel: s.channel,
        requestedAt: s.created_at,
        messages: msgs || [],
      };
    })
  );

  res.json({ conversations: items });
});

/**
 * PATCH /api/inbox/:sessionId/resolve — mark a handoff as handled.
 */
router.patch('/:sessionId/resolve', async (req, res) => {
  const { error } = await supabaseAdmin
    .from('chat_history')
    .update({ handoff_resolved: true })
    .eq('organization_id', req.orgId)
    .eq('session_id', req.params.sessionId)
    .eq('handoff_requested', true);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
