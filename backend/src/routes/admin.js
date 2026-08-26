const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/** Admin guard — only platform admins pass */
async function requireAdmin(req, res, next) {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

router.use(requireAuth, requireAdmin);

/**
 * GET /api/admin/tenants
 * Overview of every organization: owner email, usage this month,
 * quota (custom or platform default), docs & leads counts.
 */
router.get('/tenants', async (req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // monthly_message_quota requires the admin migration; fall back gracefully
  let orgs, error;
  ({ data: orgs, error } = await supabaseAdmin
    .from('organizations')
    .select('id, name, industry, monthly_message_quota, plan, plan_expires_at, created_at')
    .order('created_at', { ascending: false }));

  if (error && /monthly_message_quota/.test(error.message)) {
    ({ data: orgs, error } = await supabaseAdmin
      .from('organizations')
      .select('id, name, industry, plan, plan_expires_at, created_at')
      .order('created_at', { ascending: false }));
  }

  if (error) return res.status(500).json({ error: error.message });

  const tenants = await Promise.all(
    (orgs || []).map(async (org) => {
      const [profile, messages, bookings, leads, docs] = await Promise.all([
        supabaseAdmin.from('profiles').select('email').eq('organization_id', org.id).limit(1).maybeSingle(),
        supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true })
          .eq('organization_id', org.id).eq('event_type', 'message')
          .gte('created_at', monthStart.toISOString()),
        supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true })
          .eq('organization_id', org.id).eq('event_type', 'booking'),
        supabaseAdmin.from('leads').select('id', { count: 'exact', head: true })
          .eq('organization_id', org.id),
        supabaseAdmin.from('documents').select('id', { count: 'exact', head: true })
          .eq('organization_id', org.id),
      ]);

      return {
        id: org.id,
        name: org.name,
        industry: org.industry,
        ownerEmail: profile?.email || null,
        createdAt: org.created_at,
        quota: org.monthly_message_quota ?? null, // null = platform default
        plan: org.plan || 'free',
        planExpiresAt: org.plan_expires_at || null,
        messagesThisMonth: messages.count || 0,
        totalBookings: bookings.count || 0,
        totalLeads: leads.count || 0,
        documents: docs.count || 0,
      };
    })
  );

  res.json({ tenants });
});

/**
 * PATCH /api/admin/tenants/:id/quota
 * Extend (or reset) a client's AI usage.
 * Body: { quota: number | null }  — null resets to platform default.
 */
router.patch('/tenants/:id/quota', async (req, res) => {
  const { quota } = req.body;
  if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
    return res.status(400).json({ error: 'quota must be a non-negative integer or null' });
  }

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .update({ monthly_message_quota: quota })
    .eq('id', req.params.id)
    .select('id, name, monthly_message_quota')
    .single();

  if (error) {
    if (/monthly_message_quota/.test(error.message)) {
      return res.status(400).json({
        error: 'Quota column missing. Run backend/supabase/migration_admin.sql in the Supabase SQL Editor first.',
      });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ tenant: data });
});

/**
 * GET /api/admin/agency-clients
 * All client workspaces (orgs that have a parent agency), with usage summary.
 */
router.get('/agency-clients', async (req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { data: clients, error } = await supabaseAdmin
    .from('organizations')
    .select('id, name, industry, plan, plan_expires_at, parent_org_id, created_at, organizations:parent_org_id(name)')
    .not('parent_org_id', 'is', null)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const enriched = await Promise.all(
    (clients || []).map(async (c) => {
      const [{ count: messages }, { count: bookings }, { count: leads }] = await Promise.all([
        supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true })
          .eq('organization_id', c.id).eq('event_type', 'message').gte('created_at', monthStart.toISOString()),
        supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true })
          .eq('organization_id', c.id).eq('event_type', 'booking').gte('created_at', monthStart.toISOString()),
        supabaseAdmin.from('leads').select('id', { count: 'exact', head: true })
          .eq('organization_id', c.id),
      ]);
      return {
        ...c,
        agencyName: c.organizations?.name || null,
        messagesThisMonth: messages || 0,
        bookingsThisMonth: bookings || 0,
        totalLeads: leads || 0,
      };
    })
  );

  res.json({ clients: enriched });
});

/**
 * POST /api/admin/tenants/:id/grant-agency
 * Grant the Agency plan to any organization.
 * Body: { months?: number } — defaults to 12 months.
 */
router.post('/tenants/:id/grant-agency', async (req, res) => {
  const months = Number.isInteger(req.body.months) && req.body.months > 0 ? req.body.months : 12;
  const expires = new Date();
  expires.setMonth(expires.getMonth() + months);

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .update({ plan: 'agency', plan_expires_at: expires.toISOString() })
    .eq('id', req.params.id)
    .select('id, name, plan, plan_expires_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ tenant: data });
});

/**
 * POST /api/admin/tenants/:id/revoke-agency
 * Revoke the Agency plan — downgrades the org back to free.
 */
router.post('/tenants/:id/revoke-agency', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .update({ plan: 'free', plan_expires_at: null })
    .eq('id', req.params.id)
    .select('id, name, plan, plan_expires_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ tenant: data });
});

/**
 * GET /api/admin/export
 * CSV export of all tenants + usage. ?type=messages for per-message log.
 */
router.get('/export', async (req, res) => {
  const type = req.query.type || 'tenants';

  if (type === 'messages') {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { data, error } = await supabaseAdmin
      .from('usage_events')
      .select('created_at, event_type, tokens, organization_id, organizations(name)')
      .gte('created_at', monthStart.toISOString())
      .order('created_at', { ascending: false })
      .limit(10000);

    if (error) return res.status(500).json({ error: error.message });

    const rows = [['timestamp', 'event_type', 'tokens', 'org_id', 'org_name']];
    (data || []).forEach((e) =>
      rows.push([e.created_at, e.event_type, e.tokens, e.organization_id, e.organizations?.name || ''])
    );
    return sendCsv(res, `chitra-usage-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  }

  // Default: tenants summary
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  let orgs, error;
  ({ data: orgs, error } = await supabaseAdmin
    .from('organizations')
    .select('id, name, industry, monthly_message_quota, created_at'));

  if (error && /monthly_message_quota/.test(error.message)) {
    ({ data: orgs, error } = await supabaseAdmin
      .from('organizations')
      .select('id, name, industry, created_at'));
  }
  if (error) return res.status(500).json({ error: error.message });

  const rows = [['name', 'industry', 'owner_email', 'signup_date', 'monthly_quota', 'messages_this_month']];
  for (const org of orgs || []) {
    const [profile, messages] = await Promise.all([
      supabaseAdmin.from('profiles').select('email').eq('organization_id', org.id).limit(1).maybeSingle(),
      supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true })
        .eq('organization_id', org.id).eq('event_type', 'message')
        .gte('created_at', monthStart.toISOString()),
    ]);
    rows.push([
      org.name,
      org.industry || '',
      profile?.email || '',
      org.created_at?.slice(0, 10) || '',
      org.monthly_message_quota ?? 'default',
      messages.count || 0,
    ]);
  }
  sendCsv(res, `chitra-tenants-${new Date().toISOString().slice(0, 10)}.csv`, rows);
});

function sendCsv(res, filename, rows) {
  const csv = rows
    .map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

module.exports = router;
