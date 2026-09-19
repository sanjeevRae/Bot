const supabaseAdmin = require('../lib/supabase');
const config = require('../config');
const { PLAN_QUOTAS } = require('./payments');

/**
 * Message quotas — the single source of truth for every entry point
 * (web widget, WhatsApp / Messenger / Instagram webhooks).
 *
 * There are two different kinds of allowance:
 *
 *   - Paid plans (pro / agency): a MONTHLY allowance. It resets on the 1st of
 *     each month, so "messages used" is counted from the start of this month.
 *
 *   - Free tier (and expired paid plans): a ONE-TIME allowance. It never
 *     resets — a free org gets QUOTA_MESSAGES_TOTAL (default 100) messages in
 *     total, ever, and must upgrade to keep chatting. This is deliberately NOT
 *     a monthly quota, which is why the lifetime period counts every message
 *     the org has ever sent.
 *
 * chat.js and channels.js previously each carried their own copy of this logic
 * (and channels.js read a `monthly_message_quota` column that only exists on
 * organizations, not settings), which is how the free allowance drifted out of
 * sync with what the pricing page advertises. Route through here instead.
 */

/** Start of the current calendar month, local time (the window the monthly quota resets on). */
function startOfMonth(now = new Date()) {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Is a paid plan currently active? `free`, missing plans and expired plans all
 * fall back to the free-tier allowance.
 */
function isPlanActive(org, now = new Date()) {
  if (!org?.plan || org.plan === 'free') return false;
  return !org.plan_expires_at || new Date(org.plan_expires_at) > now;
}

/**
 * Resolve the allowance that applies to an org.
 * An admin-set per-org override (`organizations.monthly_message_quota`) always
 * wins; NULL means "use the plan/platform default".
 *
 * @returns {{limit:number, period:'month'|'lifetime', plan:string, planActive:boolean}}
 */
function messageQuotaFor(org, now = new Date()) {
  const override = Number.isInteger(org?.monthly_message_quota) ? org.monthly_message_quota : null;

  if (isPlanActive(org, now)) {
    const plan = PLAN_QUOTAS[org.plan] || PLAN_QUOTAS.pro;
    return { limit: override ?? plan.messagesPerMonth, period: 'month', plan: org.plan, planActive: true };
  }

  return {
    limit: override ?? config.freeTierQuotas.messagesTotal,
    period: 'lifetime',
    plan: 'free',
    planActive: false,
  };
}

/**
 * Messages used against the current allowance, and whether it is exhausted.
 * Lifetime allowances count every message ever sent (nothing resets them);
 * monthly ones count only the current calendar month.
 *
 * @param {{id:string}} org - needs at least `id`, plus plan columns for paid orgs
 */
async function messageUsageFor(org, now = new Date()) {
  const { limit, period, plan, planActive } = messageQuotaFor(org, now);

  let query = supabaseAdmin
    .from('usage_events')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', org.id)
    .eq('event_type', 'message');

  if (period === 'month') query = query.gte('created_at', startOfMonth(now).toISOString());

  const { count, error } = await query;
  if (error) throw error;

  const used = count || 0;
  return {
    used,
    limit,
    period,
    plan,
    planActive,
    exceeded: used >= limit,
    remaining: Math.max(0, limit - used),
  };
}

/** Visitor-facing text shown when the allowance is exhausted. */
function quotaExceededMessage(period) {
  return period === 'lifetime'
    ? 'This business has used up its free message allowance. Please try again later.'
    : 'This business has reached its monthly message limit. Please try again later.';
}

module.exports = {
  startOfMonth,
  isPlanActive,
  messageQuotaFor,
  messageUsageFor,
  quotaExceededMessage,
};