const crypto = require('crypto');
const config = require('../config');

/**
 * Nepali payment gateways (V4): eSewa + Khalti.
 * Both support NPR, are free to integrate, and charge per-transaction
 * fees (~2-3%) with no monthly cost — ideal for the Nepal market.
 *
 * Plans (NPR/month):
 *   pro    → Rs. 1,500
 *   agency → Rs. 4,500
 */

const PLANS = {
  pro: { amountNpr: 1500, label: 'Pro' },
  agency: { amountNpr: 4500, label: 'Agency' },
};

const PLAN_QUOTAS = {
  free: { messagesPerMonth: 200, documentsMax: 10, bookingsPerMonth: 50 },
  pro: { messagesPerMonth: 2000, documentsMax: 100, bookingsPerMonth: 100000 },
  agency: { messagesPerMonth: 10000, documentsMax: 500, bookingsPerMonth: 1000000 },
};

// ---------- eSewa (ePay v2) ----------

/**
 * Build the eSewa hosted-checkout form payload.
 * Docs: https://developer.esewa.com.np/#/ebank
 */
function esewaInitiate({ amount, transactionUuid }) {
  const cfg = config.payments.esewa;
  const message = `total_amount=${amount},transaction_uuid=${transactionUuid},product_code=${cfg.productCode}`;
  const signature = crypto
    .createHmac('sha256', cfg.secretKey)
    .update(message)
    .digest('base64');

  return {
    action: `${cfg.baseUrl}/epay/main`,
    fields: {
      amount,
      tax_amount: '0',
      total_amount: amount,
      transaction_uuid: transactionUuid,
      product_code: cfg.productCode,
      product_service_charge: '0',
      product_delivery_charge: '0',
      success_url: `${cfg.successUrl}?pid=${transactionUuid}`,
      failure_url: cfg.failureUrl,
      signed_field_names: 'total_amount,transaction_uuid,product_code',
      signature,
    },
  };
}

/** Verify eSewa's signed response (returned as base64 JSON in `data`). */
function esewaVerify(dataParam) {
  try {
    const decoded = JSON.parse(Buffer.from(dataParam, 'base64').toString('utf8'));
    const cfg = config.payments.esewa;
    const message = `transaction_code=${decoded.transaction_code},status=${decoded.status},total_amount=${decoded.total_amount},transaction_uuid=${decoded.transaction_uuid},product_code=${decoded.product_code},signed_field_names=${decoded.signed_field_names}`;
    const expected = crypto
      .createHmac('sha256', cfg.secretKey)
      .update(message)
      .digest('base64');

    if (expected !== decoded.signature) return { ok: false, reason: 'signature mismatch' };
    if (decoded.status !== 'COMPLETE') return { ok: false, reason: `status ${decoded.status}` };
    return { ok: true, ref: decoded.transaction_code, uuid: decoded.transaction_uuid };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ---------- Khalti (ePayment API v2) ----------

/**
 * Initiate a Khalti payment. Returns the hosted payment page URL.
 * Docs: https://docs.khalti.com/api/v2/
 */
async function khaltiInitiate({ amount, transactionUuid, returnUrl }) {
  const cfg = config.payments.khalti;
  // Khalti expects paisa (NPR × 100)
  const res = await fetch(`${cfg.baseUrl}/epayment/initiate/`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${cfg.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      return_url: returnUrl,
      website_url: cfg.websiteUrl,
      amount: amount * 100,
      purchase_order_id: transactionUuid,
      purchase_order_name: 'Chitra AI subscription',
      customer_info: { name: 'Chitra AI customer' },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok || !data.pidx) {
    throw new Error(data.detail || `Khalti initiate failed (${res.status})`);
  }
  return { pidx: data.pidx, paymentUrl: data.payment_url };
}

/** Look up a Khalti payment status by pidx. */
async function khaltiVerify(pidx) {
  const cfg = config.payments.khalti;
  const res = await fetch(`${cfg.baseUrl}/epayment/lookup/`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${cfg.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pidx }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, reason: data.detail || `lookup ${res.status}` };
  if (data.status !== 'Completed') return { ok: false, reason: `status ${data.status}` };
  return { ok: true, ref: data.transaction_id, uuid: data.purchase_order_id };
}

module.exports = { PLANS, PLAN_QUOTAS, esewaInitiate, esewaVerify, khaltiInitiate, khaltiVerify };
