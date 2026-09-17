const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../services/email');
const { computeTotals, nextInvoiceNo, renderInvoiceHtml, amountInWords } = require('../services/invoice');

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

/**
 * Order (plan request) workflow + invoices. Orders arrive from the billing
 * page (routes/billing.js). The team labels them received / pending /
 * completed / cancelled, can correct any detail, activate the plan, and raise
 * an invoice that is emailed to the customer.
 */

const ORDER_STATUSES = ['received', 'pending', 'completed', 'cancelled'];

const COMPANY_KEYS = {
  company_name: 'name', address: 'address', phone: 'phone', email: 'email',
  website: 'website', reg_no: 'regNo', tpin: 'tpin', pan_no: 'panNo',
  logo_url: 'logoUrl', payment_qr_url: 'paymentQrUrl',
  payment_instructions: 'paymentInstructions', bank_details: 'bankDetails',
  signature_url: 'signatureUrl', stamp_url: 'stampUrl',
  footer_note: 'footerNote', thank_you: 'thankYou',
};

/** Issuer details printed on every invoice (single row, id = 1). */
async function loadCompany() {
  const { data } = await supabaseAdmin.from('billing_profile').select('*').eq('id', 1).maybeSingle();
  const out = {};
  for (const [db, key] of Object.entries(COMPANY_KEYS)) out[key] = data ? data[db] : undefined;
  return out;
}

function companyColumns(body) {
  const cols = {};
  for (const [db, key] of Object.entries(COMPANY_KEYS)) {
    if (body[key] !== undefined) cols[db] = body[key] === '' ? null : body[key];
  }
  if (Object.keys(cols).length) cols.updated_at = new Date().toISOString();
  return cols;
}

/** DB row -> shape the invoice renderer understands. */
function toInvoice(row, company) {
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    status: row.status,
    copyStatus: row.copy_status,
    issueDate: row.issue_date,
    transactionDate: row.transaction_date,
    reprintDate: row.reprint_date,
    dueDate: row.due_date,
    company,
    customer: row.customer || {},
    items: row.items || [],
    discount: row.discount, serviceCharge: row.service_charge,
    subtotal: row.subtotal, total: row.total, totalInWords: row.total_in_words,
    paymentMode: row.payment_mode, paymentRef: row.payment_ref,
    notes: row.notes, terms: row.terms,
    organizationId: row.organization_id, planRequestId: row.plan_request_id,
    sentAt: row.sent_at, createdAt: row.created_at,
  };
}

function invoiceColumns(body) {
  const cols = {};
  const set = (key, col) => { if (body[key] !== undefined) cols[col] = body[key]; };
  set('invoiceNo', 'invoice_no'); set('status', 'status');
  set('copyStatus', 'copy_status'); set('issueDate', 'issue_date');
  set('transactionDate', 'transaction_date'); set('reprintDate', 'reprint_date');
  set('dueDate', 'due_date'); set('customer', 'customer');
  set('items', 'items'); set('discount', 'discount');
  set('serviceCharge', 'service_charge');
  set('totalInWords', 'total_in_words');
  set('paymentMode', 'payment_mode'); set('paymentRef', 'payment_ref');
  set('notes', 'notes'); set('terms', 'terms');
  set('organizationId', 'organization_id');
  set('planRequestId', 'plan_request_id');
  // Totals are always derived server-side so the printed figures cannot drift.
  if (cols.items) {
    const totals = computeTotals(cols.items, cols.discount, cols.service_charge);
    cols.items = totals.items;
    cols.subtotal = totals.subtotal;
    cols.total = totals.total;
  }
  cols.updated_at = new Date().toISOString();
  return cols;
}

/** Turn a missing-migration error into something the team can act on. */
function friendlyDbError(error) {
  const msg = (error && error.message) || 'Unknown error';
  if (/plan_requests_status_check|invoices_status_check/.test(msg)) {
    return 'Run backend/supabase/migration_v8_orders_invoices.sql in Supabase to enable these order statuses.';
  }
  if (/could not find the table|does not exist/i.test(msg)) {
    return 'Run backend/supabase/migration_v8_orders_invoices.sql in Supabase: ' + msg;
  }
  return msg;
}

/** GET /api/admin/orders - every upgrade request, newest first. */
router.get('/orders', async (req, res) => {
  let data, error;
  ({ data, error } = await supabaseAdmin
    .from('plan_requests')
    .select('*, organizations(name), invoices(id, invoice_no, status, total)')
    .order('created_at', { ascending: false })
    .limit(500));

  // Invoices arrive with migration v8 - keep the order list working without it.
  if (error && /invoices/i.test(error.message)) {
    ({ data, error } = await supabaseAdmin
      .from('plan_requests')
      .select('*, organizations(name)')
      .order('created_at', { ascending: false })
      .limit(500));
  }
  if (error) return res.status(500).json({ error: error.message });
  const orders = (data || []).map((row) => ({
    id: row.id,
    orderId: row.order_id,
    plan: row.plan,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    status: row.status,
    amountNpr: row.amount_npr,
    adminNotes: row.admin_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    organizationId: row.organization_id,
    business: row.organizations ? row.organizations.name : null,
    invoices: row.invoices || [],
  }));
  res.json({ orders, statuses: ORDER_STATUSES });
});

/** PATCH /api/admin/orders/:id - correct details or move the status on. */
router.patch('/orders/:id', async (req, res) => {
  const b = req.body || {};
  const cols = {};
  if (b.name !== undefined) cols.full_name = String(b.name).slice(0, 120);
  if (b.email !== undefined) cols.email = String(b.email).trim().toLowerCase().slice(0, 160);
  if (b.phone !== undefined) cols.phone = String(b.phone).slice(0, 40);
  if (b.message !== undefined) cols.message = String(b.message).slice(0, 1000);
  if (b.adminNotes !== undefined) cols.admin_notes = String(b.adminNotes).slice(0, 2000);
  if (b.plan !== undefined) {
    if (!['pro', 'agency'].includes(b.plan)) return res.status(400).json({ error: 'plan must be pro or agency' });
    cols.plan = b.plan;
  }
  if (b.status !== undefined) {
    if (!ORDER_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status' });
    cols.status = b.status;
  }
  if (b.amountNpr !== undefined) {
    const amount = Number(b.amountNpr);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amountNpr must be a positive number' });
    cols.amount_npr = Math.round(amount);
  }
  if (!Object.keys(cols).length) return res.status(400).json({ error: 'Nothing to update' });
  cols.updated_at = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('plan_requests').update(cols).eq('id', req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: friendlyDbError(error) });
  if (!data) return res.status(404).json({ error: 'Order not found' });
  res.json({ order: data });
});

/**
 * POST /api/admin/orders/:id/activate
 * Switch the business onto the requested plan for 30 days, once payment is
 * confirmed. Also labels the order completed.
 */
router.post('/orders/:id/activate', async (req, res) => {
  const { data: order, error } = await supabaseAdmin
    .from('plan_requests').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const expires = new Date();
  expires.setDate(expires.getDate() + 30);
  const { error: orgErr } = await supabaseAdmin.from('organizations').update({
    plan: order.plan, plan_expires_at: expires.toISOString(), payment_reference: order.order_id,
  }).eq('id', order.organization_id);
  if (orgErr) return res.status(500).json({ error: orgErr.message });

  await supabaseAdmin.from('settings').update({ white_label: true }).eq('organization_id', order.organization_id);
  const { error: labelErr } = await supabaseAdmin.from('plan_requests')
    .update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', order.id);
  if (labelErr) console.warn('[admin] could not label order completed:', labelErr.message);

  res.json({ ok: true, plan: order.plan, planExpiresAt: expires.toISOString() });
});

/** GET /api/admin/billing-profile - the company details printed on invoices. */
router.get('/billing-profile', async (req, res) => {
  res.json({ company: await loadCompany() });
});

/** PATCH /api/admin/billing-profile - edit those details. */
router.patch('/billing-profile', async (req, res) => {
  const cols = companyColumns(req.body || {});
  if (!Object.keys(cols).length) return res.status(400).json({ error: 'Nothing to update' });
  const { error } = await supabaseAdmin
    .from('billing_profile').upsert({ id: 1, ...cols }, { onConflict: 'id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ company: await loadCompany() });
});

/** POST /api/admin/invoices/preview - render a draft without saving it. */
router.post('/invoices/preview', async (req, res) => {
  const b = req.body || {};
  const company = { ...(await loadCompany()), ...(b.company || {}) };
  const totals = computeTotals(b.items || [], b.discount, b.serviceCharge);
  const inv = {
    ...b,
    items: totals.items,
    subtotal: totals.subtotal,
    total: totals.total,
    totalInWords: b.totalInWords || amountInWords(totals.total),
    company,
  };
  res.type('html').send(renderInvoiceHtml(inv));
});

/** GET /api/admin/invoices - all invoices, newest first. */
router.get('/invoices', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('invoices')
    .select('id, invoice_no, status, total, customer, organization_id, plan_request_id, sent_at, created_at, organizations(name)')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    invoices: (data || []).map((r) => ({
      id: r.id, invoiceNo: r.invoice_no, status: r.status, total: r.total,
      customerName: (r.customer || {}).name || null,
      customerEmail: (r.customer || {}).email || null,
      business: r.organizations ? r.organizations.name : null,
      planRequestId: r.plan_request_id, sentAt: r.sent_at, createdAt: r.created_at,
    })),
  });
});

/** GET /api/admin/invoices/:id - full editable invoice. */
router.get('/invoices/:id', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('invoices').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Invoice not found' });
  res.json({ invoice: toInvoice(data, await loadCompany()) });
});

/** GET /api/admin/invoices/:id/print - same HTML the customer receives. */
router.get('/invoices/:id/print', async (req, res) => {
  const { data } = await supabaseAdmin.from('invoices').select('*').eq('id', req.params.id).maybeSingle();
  if (!data) return res.status(404).send('Invoice not found');
  res.type('html').send(renderInvoiceHtml(toInvoice(data, await loadCompany())));
});

/** POST /api/admin/invoices - raise an invoice, optionally from an order. */
router.post('/invoices', async (req, res) => {
  const b = req.body || {};
  const company = await loadCompany();
  const today = new Date().toISOString().slice(0, 10);
  const plus30 = (from) => {
    const d = new Date(from + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 30);
    return d.toISOString().slice(0, 10);
  };

  let organizationId = b.organizationId || null;
  let planRequestId = b.planRequestId || null;
  let customer = b.customer;
  let items = Array.isArray(b.items) ? b.items : [];
  let notes = b.notes;
  let terms = b.terms;

  // Prefill from the order so the team only has to check the numbers.
  if (planRequestId) {
    const { data: order } = await supabaseAdmin.from('plan_requests').select('*').eq('id', planRequestId).maybeSingle();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    organizationId = order.organization_id;
    const label = order.plan === 'agency' ? 'Agency' : 'Pro';
    const amount = order.amount_npr || (order.plan === 'agency' ? 4500 : 1500);
    const { data: org } = await supabaseAdmin.from('organizations').select('name').eq('id', order.organization_id).maybeSingle();
    if (!items.length) {
      items = [{
        panNo: company.panNo || '',
        particulars: 'Chitra AI ' + label + ' Plan',
        description: 'AI assistant subscription - ' + label + ' plan, 1 month',
        qty: 1, rate: amount,
        packageName: label + ' Plan',
        plan: label,
        billingPeriod: today + ' to ' + plus30(today),
        effectiveDate: today,
      }];
    }
    if (!customer || !Object.keys(customer).length) {
      customer = {
        name: order.full_name || '',
        customerId: order.order_id,
        business: org ? org.name : '',
        address: '',
        phone: order.phone || '',
        tpin: '',
        panNo: '',
        email: order.email || '',
      };
    }
    if (notes === undefined) notes = 'Service is activated within 24 hours of confirmed payment.';
    if (terms === undefined) terms = 'Subscription lasts 30 days per payment. Please quote the invoice number with your payment.';
  }

  const totals = computeTotals(items, b.discount, b.serviceCharge);
  const row = {
    organization_id: organizationId,
    plan_request_id: planRequestId,
    invoice_no: b.invoiceNo || (await nextInvoiceNo()),
    status: 'draft',
    copy_status: b.copyStatus || 'Original',
    issue_date: b.issueDate || today,
    transaction_date: b.transactionDate || today,
    reprint_date: b.reprintDate || null,
    due_date: b.dueDate || null,
    customer: customer || {},
    items: totals.items,
    subtotal: totals.subtotal,
    discount: Number(b.discount) || 0,
    service_charge: Number(b.serviceCharge) || 0,
    total: totals.total,
    total_in_words: b.totalInWords || amountInWords(totals.total),
    payment_mode: b.paymentMode || null,
    payment_ref: b.paymentRef || null,
    notes: notes === undefined ? null : notes,
    terms: terms === undefined ? null : terms,
  };

  const { data, error } = await supabaseAdmin.from('invoices').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ invoice: toInvoice(data, company) });
});

/** PATCH /api/admin/invoices/:id - edit any part of the invoice. */
router.patch('/invoices/:id', async (req, res) => {
  const b = req.body || {};
  const { data: existing } = await supabaseAdmin.from('invoices').select('*').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Invoice not found' });

  const cols = invoiceColumns(b);
  if (cols.invoice_no && cols.invoice_no !== existing.invoice_no) {
    const { data: clash } = await supabaseAdmin.from('invoices').select('id').eq('invoice_no', cols.invoice_no).maybeSingle();
    if (clash) return res.status(409).json({ error: 'That invoice number is already in use' });
  }

  // Money is recalculated here; the words follow unless the team typed their own.
  const totals = computeTotals(
    cols.items || existing.items || [],
    cols.discount !== undefined ? cols.discount : existing.discount,
    cols.service_charge !== undefined ? cols.service_charge : existing.service_charge
  );
  cols.subtotal = totals.subtotal;
  cols.total = totals.total;
  if (cols.items) cols.items = totals.items;
  if (b.totalInWords === undefined) cols.total_in_words = amountInWords(totals.total);

  const { data, error } = await supabaseAdmin.from('invoices').update(cols).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Marking an invoice paid also closes the order it was raised for.
  if (cols.status === 'paid' && data.plan_request_id) {
    await supabaseAdmin.from('plan_requests')
      .update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', data.plan_request_id);
  }
  res.json({ invoice: toInvoice(data, await loadCompany()) });
});

/** DELETE /api/admin/invoices/:id */
router.delete('/invoices/:id', async (req, res) => {
  const { error } = await supabaseAdmin.from('invoices').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/** POST /api/admin/invoices/:id/send - email the invoice to the customer. */
router.post('/invoices/:id/send', async (req, res) => {
  const company = await loadCompany();
  const { data: row, error } = await supabaseAdmin.from('invoices').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: 'Invoice not found' });
  const inv = toInvoice(row, company);
  const to = String((req.body && req.body.to) || inv.customer.email || '').trim();
  if (!to) return res.status(400).json({ error: 'This invoice has no customer email. Add one, or pass a specific address.' });
  const subject = 'Invoice ' + inv.invoiceNo + (company.name ? ' from ' + company.name : '');
  const sent = await sendEmail(to, subject, renderInvoiceHtml(inv));
  if (!sent) return res.status(502).json({ error: 'Could not send the email. Check the email provider settings (BREVO_API_KEY, EMAIL_FROM).' });
  const { data } = await supabaseAdmin.from('invoices')
    .update({ status: row.status === 'draft' ? 'sent' : row.status, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', row.id).select().single();
  res.json({ ok: true, to, invoiceNo: inv.invoiceNo, status: data ? data.status : row.status });
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
