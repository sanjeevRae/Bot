export const PLANS = [
  {
    id: 'free', name: 'Free', price: 'Rs. 0', amountNpr: 0, tagline: 'Try Chitra with no commitment',
    description: 'Perfect for individuals, freelancers or small teams who want to explore Chitra and see the value before upgrading.',
    features: ['100 messages (one-time)', '5 knowledge documents', '50 bookings / month', 'Website widget + QR link'],
  },
  {
    id: 'pro', name: 'Pro', price: 'Rs. 1,500', amountNpr: 1500, per: '/mo', tagline: 'For growing businesses',
    description: 'Ideal for small and medium businesses that need more capacity, customization and automation to grow faster.',
    highlight: true,
    features: ['2,000 messages / month', '100 knowledge documents', 'Unlimited bookings', 'White-label (remove Chitra branding)', 'Email notifications'],
  },
  {
    id: 'agency', name: 'Agency', price: 'Rs. 4,500', amountNpr: 4500, per: '/mo', tagline: 'Manage clients at scale',
    description: 'Built for agencies and teams managing multiple clients. Get more capacity, advanced features and dedicated support to scale your business.',
    features: ['10,000 messages / month', '500 knowledge documents', 'Everything in Pro', 'Priority support', 'Multi-client management*'],
  },
];

export const PAID_PLANS = PLANS.filter((p) => p.id !== 'free');

export const planLabel = (id) => (PLANS.find((p) => p.id === id) || {}).name || id;

/* ---------- Billing cycles ---------- */

/** Discount applied when a full year is paid up front. */
export const ANNUAL_DISCOUNT = 0.4;

export const formatNpr = (n) => `Rs. ${n.toLocaleString('en-US')}`;

/** Monthly-equivalent price once the yearly discount is applied. */
export const annualMonthly = (plan) => Math.round(plan.amountNpr * (1 - ANNUAL_DISCOUNT));

/** What gets charged in a single yearly payment. */
export const annualTotal = (plan) => annualMonthly(plan) * 12;

/** Display values for a plan on a given billing cycle. */
export function planPrice(plan, annual) {
  if (plan.id === 'free') return { price: plan.price, per: '', period: 'one-time free allowance' };
  if (annual) {
    return {
      price: formatNpr(annualMonthly(plan)),
      per: '/mo',
      period: `${formatNpr(annualTotal(plan))} billed yearly`,
    };
  }
  return { price: plan.price, per: plan.per, period: 'per month' };
}
