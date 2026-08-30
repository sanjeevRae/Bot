const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/**
 * Ensure the caller is an admin OR is on an active agency plan.
 * Express middleware: calls next() when allowed, otherwise responds 403.
 */
async function requireAgency(req, res, next) {
  // Platform admins have full access regardless of their own org's plan.
  if (req.role === 'admin') return next();

  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('id, plan, plan_expires_at')
    .eq('id', req.orgId)
    .single();

  const active = org?.plan === 'agency'
    && (!org.plan_expires_at || new Date(org.plan_expires_at) > new Date());

  if (!active) {
    return res.status(403).json({ error: 'Agency plan required. Upgrade at /billing.' });
  }
  next();
}

/**
 * GET /api/agency/clients — list client orgs with usage summary.
 */
router.get('/clients', requireAgency, async (req, res) => {
  const trace = (m) => { try { require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'chitra-requests.log'), `[${new Date().toISOString()}] HANDLER /clients: ${m}\n`); } catch {} };
  trace(`start role=${req.role} org=${req.orgId}`);
  trace('requireAgency passed');
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // Admins see every client workspace across all agencies;
  // agency users only see their own children.
  const withEmail = 'id, name, industry, plan, plan_expires_at, contact_email, created_at';
  const withoutEmail = 'id, name, industry, plan, plan_expires_at, created_at';
  const runQuery = (select) => {
    let q = supabaseAdmin
      .from('organizations')
      .select(select)
      .order('created_at', { ascending: false });
    if (req.role !== 'admin') q = q.eq('parent_org_id', req.orgId);
    return q;
  };

  let { data: clients, error } = await runQuery(withEmail);
  if (error && /contact_email/i.test(error.message || '')) {
    // migration_v5_agency_invite.sql not run yet — fall back gracefully
    ({ data: clients, error } = await runQuery(withoutEmail));
  }
  trace(`orgs fetched: ${(clients || []).length}, error=${error ? error.message : 'none'}`);

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

  trace(`responding with ${(enriched || []).length} clients`);
  res.json({ clients: enriched });
});

/**
 * POST /api/agency/clients — create a client workspace.
 * Body: { name, industry?, email? } — email optionally sends the client an
 * invite to their own dashboard.
 */
router.post('/clients', requireAgency, async (req, res) => {
  const { name, industry, email } = req.body;
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
  if (email?.trim()) await setContactEmail(data.id, email.trim());

  // Optionally invite the client to their own dashboard
  let invite = null;
  if (email?.trim()) {
    try {
      invite = await inviteClientUser(email.trim(), data);
    } catch (e) {
      invite = { sent: false, error: e.message };
    }
  }

  res.json({ client: data, invite });
});

/**
 * DELETE /api/agency/clients/:id — remove a client workspace.
 */
router.delete('/clients/:id', requireAgency, async (req, res) => {
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

/**
 * POST /api/agency/clients/:id/invite — invite a client to their dashboard.
 * Body: { email }. Creates the auth user (Supabase invite email) and links
 * their profile to this client workspace.
 */
router.post('/clients/:id/invite', requireAgency, async (req, res) => {
  const { email } = req.body;
  if (!email?.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  // Only the parent agency (or an admin) may invite into this workspace
  const { data: clientOrg, error: orgErr } = await supabaseAdmin
    .from('organizations')
    .select('id, name, parent_org_id')
    .eq('id', req.params.id)
    .single();
  if (orgErr || !clientOrg) return res.status(404).json({ error: 'Client workspace not found' });
  if (req.role !== 'admin' && clientOrg.parent_org_id !== req.orgId) {
    return res.status(403).json({ error: 'Not your client workspace' });
  }

  try {
    const result = await inviteClientUser(email.trim(), clientOrg);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Store the client's contact email (no-op if the column isn't migrated yet).
 */
async function setContactEmail(orgId, email) {
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ contact_email: email })
    .eq('id', orgId);
  if (error && /contact_email/i.test(error.message || '')) {
    console.warn('[agency] contact_email column missing — run migration_v5_agency_invite.sql');
  }
}

/**
 * Invite a user to a client workspace.
 *  - New email      → Supabase invite email (user clicks → session → dashboard)
 *  - Existing user  → branded magic-link email via Resend (or link fallback)
 */
async function inviteClientUser(email, clientOrg) {
  const siteUrl = config.payments.frontendUrl; // PUBLIC_FRONTEND_URL
  const redirectTo = `${siteUrl}/dashboard`;

  const { data: invited, error: inviteErr } = await supabaseAdmin.auth.admin
    .inviteUserByEmail(email, { redirectTo });

  if (invited?.user) {
    const { error: pErr } = await supabaseAdmin
      .from('profiles')
      .insert({ id: invited.user.id, organization_id: clientOrg.id, role: 'owner' });
    if (pErr && !/duplicate|unique/i.test(pErr.message)) throw new Error(pErr.message);
    await setContactEmail(clientOrg.id, email);
    return { sent: true, mode: 'invite' };
  }

  // Supabase rejects invites for existing users — handle that gracefully
  const msg = inviteErr?.message || 'Invite failed';
  if (!/already.*registered|already.*exists|user.*exists/i.test(msg)) throw new Error(msg);

  const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const existing = (list?.users || []).find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
  if (!existing) throw new Error(msg);

  const { data: prof } = await supabaseAdmin
    .from('profiles')
    .select('id, organization_id')
    .eq('id', existing.id)
    .maybeSingle();
  if (prof?.organization_id && prof.organization_id !== clientOrg.id) {
    throw new Error('This email already belongs to another workspace');
  }
  if (!prof) {
    const { error: pErr } = await supabaseAdmin
      .from('profiles')
      .insert({ id: existing.id, organization_id: clientOrg.id, role: 'owner' });
    if (pErr) throw new Error(pErr.message);
  }
  await setContactEmail(clientOrg.id, email);

  // Existing user: send a branded sign-in link (magic link)
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin
    .generateLink({ type: 'magiclink', email, options: { redirectTo } });
  const actionLink = linkData?.properties?.action_link;
  if (linkErr || !actionLink) {
    return { sent: false, mode: 'manual', error: linkErr?.message || 'Could not create sign-in link' };
  }

  const emailSvc = require('../services/email');
  const sent = await emailSvc.sendEmail(
    email,
    `Sign in to ${clientOrg.name} — Chitra AI`,
    emailSvc.notifyTemplate(
      'Your AI assistant workspace is ready',
      `<p>You have been invited to manage <strong>${clientOrg.name}</strong>'s AI assistant.</p>
       <p style="margin:20px 0">
         <a href="${actionLink}" style="background:#059669;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open my dashboard</a>
       </p>
       <p style="font-size:12px;color:#6b7280">Or paste this link into your browser:<br>${actionLink}</p>`
    )
  );
  return sent
    ? { sent: true, mode: 'magiclink' }
    : { sent: false, mode: 'manual', link: actionLink };
}

module.exports = router;
