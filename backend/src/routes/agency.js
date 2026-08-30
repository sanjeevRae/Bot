const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** Ensure the caller is an admin OR is on the agency plan and owns a parent org. */
async function requireAgency(req, res) {
  // Platform admins have full access regardless of their own org's plan.
  if (req.role === 'admin') return null;

  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('id, plan, plan_expires_at')
    .eq('id', req.orgId)
    .single();

  const active = org?.plan === 'agency'
    && (!org.plan_expires_at || new Date(org.plan_expires_at) > new Date());

  if (!active) {
    res.status(403).json({ error: 'Agency plan required. Upgrade at /billing.' });
    return null;
  }
  return org;
}

/**
 * GET /api/agency/clients — list client orgs with usage summary.
 */
router.get('/clients', async (req, res) => {
  if (!(await requireAgency(req, res))) return;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // Admins see every client workspace across all agencies;
  // agency users only see their own children.
  let query = supabaseAdmin
    .from('organizations')
    .select('id, name, industry, plan, plan_expires_at, created_at')
    .order('created_at', { ascending: false });

  if (req.role !== 'admin') query = query.eq('parent_org_id', req.orgId);

  const { data: clients, error } = await query;

  if (error) return res.status(500).json({ error: error.message });

  // Usage per client
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
      return { ...c, messagesThisMonth: messages || 0, bookingsThisMonth: bookings || 0, totalLeads: leads || 0 };
    })
  );

  res.json({ clients: enriched });
});

/**
 * POST /api/agency/clients — create a client workspace.
 * Body: { name, industry? }
 */
router.post('/clients', async (req, res) => {
  if (!(await requireAgency(req, res))) return;
  const { name, industry } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Client name is required' });

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .insert({
      name: name.trim(),
      owner_user_id: req.user.id,
      // Admins creating clients get attributed to their own org as parent;
      // regular agency users attribute to theirs.
      parent_org_id: req.orgId,
      plan: 'pro',
      industry: industry || null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Settings row for the new client
  await supabaseAdmin.from('settings').insert({ organization_id: data.id });

  res.json({ client: data });
});

/**
 * DELETE /api/agency/clients/:id — remove a client workspace.
 */
router.delete('/clients/:id', async (req, res) => {
  if (!(await requireAgency(req, res))) return;

  let query = supabaseAdmin
    .from('organizations')
    .delete()
    .eq('id', req.params.id);

  // Admins may delete any client workspace; agencies only their own.
  if (req.role !== 'admin') query = query.eq('parent_org_id', req.orgId);

  const { error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
