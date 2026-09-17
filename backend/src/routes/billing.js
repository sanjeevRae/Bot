const express = require('express');
const crypto = require('crypto');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');
const {
  PLANS, PLAN_QUOTAS, esewaInitiate, esewaVerify, khaltiInitiate, khaltiVerify,
} = require('../services/payments');
const { sendEmail, brandedEmail, escapeHtml } = require('../services/email');

const router = express.Router();

/** GET /api/billing/plans — public plan catalog */
router.get('/plans', (req, res) => {
  res.json({
    plans: [
      { id: 'free', name: 'Free', priceNpr: 0, ...PLAN_QUOTAS.free },
      { id: 'pro', name: 'Pro', priceNpr: PLANS.pro.amountNpr, ...PLAN_QUOTAS.pro, whiteLabel: true },
      { id: 'agency', name: 'Agency', priceNpr: PLANS.agency.amountNpr, ...PLAN_QUOTAS.agency, whiteLabel: true },
    ],
    gateways: ['esewa', 'khalti'],
  });
});

/**
 * POST /api/billing/checkout
 * Body: { plan: 'pro'|'agency', gateway: 'esewa'|'khalti' }
 * Returns either eSewa form fields (auto-submit from client) or a Khalti URL.
 */
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { plan, gateway } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'plan must be "pro" or "agency"' });
    if (!['esewa', 'khalti'].includes(gateway)) return res.status(400).json({ error: 'gateway must be "esewa" or "khalti"' });

    const amount = PLANS[plan].amountNpr;
    const transactionUuid = `CH-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    // Record pending payment
    await supabaseAdmin.from('payments').insert({
      organization_id: req.orgId,
      provider: gateway,
      amount_npr: amount,
      plan,
      months: 1,
      status: 'pending',
      transaction_uuid: transactionUuid,
    });

    if (gateway === 'esewa') {
      const form = esewaInitiate({ amount, transactionUuid });
      return res.json({ gateway: 'esewa', ...form });
    }

    // Khalti
    const returnUrl = `${config.payments.esewa.successUrl.replace('/esewa/verify', '/khalti/verify')}?pidx=`;
    const { pidx, paymentUrl } = await khaltiInitiate({
      amount,
      transactionUuid,
      returnUrl: `${config.payments.frontendUrl}/billing?gateway=khalti&pidx=${pidxPlaceholder()}`,
    });
    // Store pidx for verification on return
    await supabaseAdmin
      .from('payments')
      .update({ gateway_ref: pidx })
      .eq('transaction_uuid', transactionUuid);

    return res.json({ gateway: 'khalti', paymentUrl });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
/**
 * POST /api/billing/request
 * Body: { plan: 'pro'|'agency', name, email, phone, message? }
 *
 * A customer asking to move to a paid plan. We answer with an order id
 * straight away and do the storage + emails in the background, so whoever
 * filled in the form never waits on an email provider.
 */
router.post('/request', requireAuth, async (req, res) => {
  const body = req.body || {};
  const plan = String(body.plan || '').trim();
  if (!PLANS[plan]) return res.status(400).json({ error: 'Please choose the Pro or Agency plan' });

  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const message = String(body.message || '').trim().slice(0, 1000);

  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (phone.replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'Please enter a valid phone number' });
  }

  const orderId = makeOrderId();
  const planInfo = PLANS[plan];

  // Reply first: persisting the request and sending the two emails must not
  // add any latency to the customer's request.
  res.json({
    ok: true,
    orderId,
    plan,
    planName: planInfo.label,
    amountNpr: planInfo.amountNpr,
  });

  handlePlanRequest({
    orgId: req.orgId,
    requestedBy: (req.user && req.user.email) || '',
    orderId,
    plan,
    name,
    email,
    phone,
    message,
  }).catch((e) => console.warn('[billing] plan request handling failed:', e.message));
});

/** Readable, unique order reference: ORD-20260917-A1B2C3 */
function makeOrderId() {
  const d = new Date();
  const ymd = String(d.getFullYear())
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
  return `ORD-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Two-column detail table for the email bodies. */
function detailTable(rows) {
  return '<table style="border-collapse:collapse;width:100%;margin:4px 0 0">'
    + rows
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([label, value]) =>
        '<tr>'
        + `<td style="padding:5px 14px 5px 0;font-size:13px;color:#6b7280;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>`
        + `<td style="padding:5px 0;font-size:13px;color:#111827;font-weight:600">${escapeHtml(String(value))}</td>`
        + '</tr>')
      .join('')
    + '</table>';
}

/**
 * Store a plan request and email both sides:
 *   - the Chitra team gets the full order details (BILLING_ADMIN_EMAIL)
 *   - the customer gets a thank-you carrying their order id
 * Never throws: a notification problem must not surface to the customer.
 */
async function handlePlanRequest(req) {
  const planInfo = PLANS[req.plan];
  const amount = 'Rs. ' + Number(planInfo.amountNpr).toLocaleString('en-IN');
  const received = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Kathmandu', dateStyle: 'medium', timeStyle: 'short',
  });

  // 1) Keep a record (best effort: still works before the v7 migration runs)
  try {
    const { error } = await supabaseAdmin.from('plan_requests').insert({
      organization_id: req.orgId,
      order_id: req.orderId,
      plan: req.plan,
      full_name: req.name,
      email: req.email,
      phone: req.phone,
      message: req.message || null,
    });
    if (error) console.warn('[billing] could not store plan request:', error.message);
  } catch (e) {
    console.warn('[billing] could not store plan request:', e.message);
  }

  // 2) Business name for the emails (optional)
  let org = null;
  try {
    const { data } = await supabaseAdmin
      .from('organizations').select('name, plan').eq('id', req.orgId).maybeSingle();
    org = data;
  } catch { /* the name is not essential */ }

  const summary = planInfo.label + ' | ' + amount + '/mo';

  const adminHtml = brandedEmail(
    'New upgrade request ' + req.orderId,
    '<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#374151">'
    + 'A customer submitted a plan upgrade request from the billing page.'
    + '</p>' + detailTable([
      ['Order ID', req.orderId],
      ['Plan', summary],
      ['Name', req.name],
      ['Email', req.email],
      ['Phone', req.phone],
      ['Business', org && org.name],
      ['Current plan', (org && org.plan) || 'free'],
      ['Account', req.requestedBy],
      ['Organization', req.orgId],
      ['Message', req.message],
      ['Received', received + ' (NPT)'],
    ])
    + '<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280">'
    + 'Reply to this email to reach the customer directly.'
    + '</p>'
  );

  const customerHtml = brandedEmail(
    'Thank you for choosing the ' + planInfo.label + ' plan',
    '<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151">Hi '
    + escapeHtml(req.name) + ',' + '</p>'
    + '<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151">Thank you for your interest in the '
    + '<strong>' + escapeHtml(planInfo.label) + '</strong> plan. We have received your request and our team'
    + ' will get back to you shortly at <strong>' + escapeHtml(req.email) + '</strong> to confirm the details'
    + ' and activate your upgrade.</p>' + detailTable([
      ['Order ID', req.orderId],
      ['Plan', summary],
      ['Name', req.name],
      ['Phone', req.phone],
    ])
    + '<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280">'
    + 'If any of these details look wrong, just reply to this email and we will correct them.'
    + '</p>'
  );

  const adminTo = config.billing.adminEmail;
  const [staff, customer] = await Promise.all([
    adminTo
      ? sendEmail(adminTo, `[Chitra AI] Order request ${req.orderId} - ${(org && org.name) || req.email} (${planInfo.label})`, adminHtml)
      : false,
    sendEmail(
      req.email,
      `Thank you - we received your ${planInfo.label} plan request (${req.orderId})`,
      customerHtml
    ),
  ]);
  console.log(`[billing] plan request ${req.orderId}: staff=${staff} customer=${customer}`);
}

function pidxPlaceholder() { return '__PIDX__'; }

/**
 * GET /api/billing/esewa/verify — eSewa redirects back here with signed data.
 * Verifies, activates the plan, then redirects to the dashboard billing page.
 */
router.get('/esewa/verify', async (req, res) => {
  const dataParam = req.query.data;
  const result = esewaVerify(dataParam);
  if (!result.ok) {
    return res.redirect(`${config.payments.frontendUrl}/billing?status=failed&reason=${encodeURIComponent(result.reason)}`);
  }
  const activated = await activatePayment(result.uuid, result.ref);
  const status = activated ? 'success' : 'failed';
  res.redirect(`${config.payments.frontendUrl}/billing?status=${status}`);
});

/**
 * GET /api/billing/khalti/verify?pidx=... — Khalti returns via return_url.
 */
router.get('/khalti/verify', async (req, res) => {
  const { pidx } = req.query;
  if (!pidx) return res.redirect(`${config.payments.frontendUrl}/billing?status=failed`);
  const result = await khaltiVerify(pidx);
  if (!result.ok) {
    return res.redirect(`${config.payments.frontendUrl}/billing?status=failed&reason=${encodeURIComponent(result.reason)}`);
  }
  const activated = await activatePayment(result.uuid, result.ref);
  const status = activated ? 'success' : 'failed';
  res.redirect(`${config.payments.frontendUrl}/billing?status=${status}`);
});

/** Mark payment completed + upgrade the org's plan for 30 days. */
async function activatePayment(transactionUuid, gatewayRef) {
  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('transaction_uuid', transactionUuid)
    .eq('status', 'pending')
    .maybeSingle();
  if (!payment) return false;

  const expires = new Date();
  expires.setDate(expires.getDate() + 30 * payment.months);

  const [{ error: payErr }, { error: orgErr }] = await Promise.all([
    supabaseAdmin.from('payments').update({
      status: 'completed',
      gateway_ref: gatewayRef || payment.gateway_ref,
    }).eq('id', payment.id),
    supabaseAdmin.from('organizations').update({
      plan: payment.plan,
      plan_expires_at: expires.toISOString(),
      payment_provider: payment.provider,
      payment_reference: gatewayRef || null,
    }).eq('id', payment.organization_id),
  ]);

  if (payErr || orgErr) {
    console.error('Activation failed:', payErr?.message || orgErr?.message);
    return false;
  }

  // Pro+ unlocks white-label automatically
  await supabaseAdmin.from('settings').update({ white_label: true })
    .eq('organization_id', payment.organization_id);

  return true;
}

module.exports = router;
