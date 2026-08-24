const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/analytics — dashboard stats for tenant */
router.get('/', async (req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [messages, bookings, leads, docs, sessions] = await Promise.all([
    supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true })
      .eq('organization_id', req.orgId).eq('event_type', 'message')
      .gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true })
      .eq('organization_id', req.orgId).eq('event_type', 'booking')
      .gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true })
      .eq('organization_id', req.orgId),
    supabaseAdmin.from('documents').select('id', { count: 'exact', head: true })
      .eq('organization_id', req.orgId),
    supabaseAdmin.from('chat_history').select('session_id', { count: 'exact', head: true })
      .eq('organization_id', req.orgId),
  ]);

  // Daily message counts for last 14 days (simple chart data)
  const { data: daily } = await supabaseAdmin
    .from('usage_events')
    .select('created_at')
    .eq('organization_id', req.orgId)
    .eq('event_type', 'message')
    .gte('created_at', new Date(Date.now() - 14 * 86400000).toISOString());

  const dayMap = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    dayMap[d] = 0;
  }
  (daily || []).forEach((e) => {
    const d = e.created_at.slice(0, 10);
    if (d in dayMap) dayMap[d]++;
  });

  res.json({
    messagesThisMonth: messages.count || 0,
    bookingsThisMonth: bookings.count || 0,
    totalLeads: leads.count || 0,
    documents: docs.count || 0,
    totalSessions: sessions.count || 0,
    dailyMessages: Object.entries(dayMap).map(([date, count]) => ({ date, count })),
  });
});

module.exports = router;
