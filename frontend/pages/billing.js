import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/supabaseClient';

const PLANS = [
  {
    id: 'free', name: 'Free', price: 'Rs. 0', tagline: 'Try Chitra with no commitment',
    features: ['200 messages / month', '10 knowledge documents', '50 bookings / month', 'Website widget + QR link'],
  },
  {
    id: 'pro', name: 'Pro', price: 'Rs. 1,500', per: '/mo', tagline: 'For growing businesses',
    highlight: true,
    features: ['2,000 messages / month', '100 knowledge documents', 'Unlimited bookings', 'White-label (remove Chitra branding)', 'Email notifications'],
  },
  {
    id: 'agency', name: 'Agency', price: 'Rs. 4,500', per: '/mo', tagline: 'Manage clients at scale',
    features: ['10,000 messages / month', '500 knowledge documents', 'Everything in Pro', 'Priority support', 'Multi-client management*'],
  },
];

export default function Billing() {
  const [me, setMe] = useState(null);
  const [gateway, setGateway] = useState('esewa');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const formRef = useRef(null);
  const formFields = useRef([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('status')) setStatus(params.get('status'));
    api('/api/org/me').then(setMe).catch((e) => setError(e.message));
  }, []);

  async function checkout(plan) {
    if (plan === 'free') return;
    setBusy(plan); setError('');
    try {
      const d = await api('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan, gateway }),
      });
      if (d.gateway === 'esewa') {
        // Build & auto-submit the signed form to eSewa
        formFields.current = Object.entries(d.fields);
        setTimeout(() => formRef.current?.submit(), 50);
      } else if (d.paymentUrl) {
        window.location.href = d.paymentUrl;
      }
    } catch (e) {
      setError(e.message);
      setBusy('');
    }
  }

  const currentPlan = me?.org?.plan || 'free';
  const expires = me?.org?.plan_expires_at ? new Date(me.org.plan_expires_at).toLocaleDateString() : null;

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-6 sm:py-12">
      {/* Page header */}
      <div className="mb-8 border-b border-gray-200 pb-6">
        <h1 className="h-display text-2xl sm:text-[28px]">Billing</h1>
        <p className="mt-1 text-sm text-ink-500">
          Current plan:{' '}
          <span className="font-semibold capitalize text-brand-600">{currentPlan}</span>
          {expires && currentPlan !== 'free' && <> · renews {expires}</>}
        </p>
      </div>

      {status === 'success' && (
        <div className="mb-6 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
          🎉 Payment successful! Your plan is now active.
        </div>
      )}
      {status === 'failed' && (
        <div className="mb-6 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
          Payment failed or was cancelled. No charge was made — please try again.
        </div>
      )}
      {error && (
        <div className="mb-6 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {/* Gateway picker */}
      <div className="card mb-8 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-ink-900">Payment method</p>
          <p className="text-xs text-ink-400">Pay in NPR with your Nepali digital wallet.</p>
        </div>
        <div className="flex gap-2">
          {[['esewa', 'eSewa'], ['khalti', 'Khalti']].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setGateway(id)}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                gateway === id
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-gray-300 bg-white text-ink-500 hover:border-gray-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Plans */}
      <div className="grid gap-4 md:grid-cols-3 lg:gap-6">
        {PLANS.map((p) => {
          const isCurrent = currentPlan === p.id;
          return (
            <div
              key={p.id}
              className={`card relative flex flex-col p-6 ${
                p.highlight ? 'border-brand-300 ring-1 ring-brand-200' : ''
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 px-3 py-0.5 text-[11px] font-semibold text-white">
                  Most popular
                </span>
              )}
              <h3 className="text-sm font-semibold text-ink-900">{p.name}</h3>
              <p className="mt-1">
                <span className="text-2xl font-bold tracking-tight text-ink-900">{p.price}</span>
                {p.per && <span className="text-sm text-ink-400">{p.per}</span>}
              </p>
              <p className="mt-1 text-xs text-ink-400">{p.tagline}</p>

              <ul className="mt-5 flex-1 space-y-2.5">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-[13px] text-ink-700">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-brand-600"><path d="M20 6 9 17l-5-5" /></svg>
                    {f}
                  </li>
                ))}
              </ul>

              <button
                onClick={() => checkout(p.id)}
                disabled={isCurrent || busy === p.id}
                className={`mt-6 w-full ${isCurrent ? 'btn-secondary cursor-default' : 'btn-primary'}`}
              >
                {isCurrent ? 'Current plan' : busy === p.id ? 'Redirecting…' : `Upgrade to ${p.name}`}
              </button>
            </div>
          );
        })}
      </div>

      {/* Hidden auto-submit form for eSewa redirect */}
      <form ref={formRef} action={formFields.current[0]?.[1] || '#'} method="POST" className="hidden">
        {formFields.current.slice(1).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      </form>

      <p className="mt-8 text-center text-xs leading-relaxed text-ink-400">
        * Multi-client management coming soon · Payments processed securely by eSewa / Khalti ·
        Subscriptions last 30 days per payment
      </p>
    </main>
  );
}
