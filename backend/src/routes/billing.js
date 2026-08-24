const express = require('express');
const crypto = require('crypto');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');
const {
  PLANS, PLAN_QUOTAS, esewaInitiate, esewaVerify, khaltiInitiate, khaltiVerify,
} = require('../services/payments');

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
