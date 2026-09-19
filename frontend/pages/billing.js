import { useState, useEffect, useCallback } from 'react';
import { api, supabase } from '../lib/supabaseClient';
import { PLANS, PAID_PLANS, planLabel } from '../lib/plans';

export default function Billing() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  /* ---- upgrade request dialog ---- */
  const [openPlan, setOpenPlan] = useState(null); // plan id, or null when closed
  const [form, setForm] = useState({ name: '', email: '', phone: '', plan: 'pro', message: '' });
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState('');
  const [sent, setSent] = useState(null); // { orderId, planName }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('status')) setStatus(params.get('status'));
    api('/api/org/me').then(setMe).catch((e) => setError(e.message));
  }, []);

  const closeDialog = useCallback(() => setOpenPlan(null), []);

  /* Open and prefill the dialog. Name + email come from the signed-in account
     and the phone from the bot's WhatsApp number, so the customer usually
     just reviews and sends. Every field stays editable. */
  const openRequest = useCallback(async (planId) => {
    setOpenPlan(planId);
    setSent(null);
    setFormError('');
    let name = '';
    let email = '';
    try {
      const { data } = await supabase.auth.getSession();
      const user = data && data.session && data.session.user;
      const meta = (user && user.user_metadata) || {};
      name = meta.full_name || meta.business_name || '';
      email = (user && user.email) || meta.email || '';
    } catch { /* prefill is best effort - the fields are editable anyway */ }
    setForm({
      name,
      email,
      phone: (me && me.settings && me.settings.whatsapp_number) || '',
      plan: planId,
      message: '',
    });
  }, [me]);

  /* While the dialog is open: Escape closes it and the page behind stays put. */
  useEffect(() => {
    if (!openPlan) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeDialog(); };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [openPlan, closeDialog]);

  async function submitRequest(e) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setFormError('');
    try {
      const data = await api('/api/billing/request', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setSent({ orderId: data.orderId, planName: data.planName || planLabel(form.plan) });
    } catch (err) {
      setFormError(err.message || 'Could not send your request. Please try again.');
    } finally {
      setSending(false);
    }
  }

  const bind = (key) => ({
    value: form[key],
    onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const currentPlan = (me && me.org && me.org.plan) || 'free';
  const expires = me && me.org && me.org.plan_expires_at
    ? new Date(me.org.plan_expires_at).toLocaleDateString()
    : null;

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-6 sm:py-12">
      <div className="mb-8 border-b border-gray-200 pb-6">
        <h1 className="h-display text-2xl sm:text-[28px]">Billing</h1>
        <p className="mt-1 text-sm text-ink-500">
          Current plan:{' '}
          <span className="font-semibold capitalize text-brand-600">{currentPlan}</span>
          {expires && currentPlan !== 'free' && <> &middot; renews {expires}</>}
        </p>
      </div>

      {status === 'success' && (
        <div className="mb-6 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
          Payment successful! Your plan is now active.
        </div>
      )}
      {status === 'failed' && (
        <div className="mb-6 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
          That payment did not go through and no charge was made. Send us a request below and we will sort it out.
        </div>
      )}
      {error && (
        <div className="mb-6 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      <div className="grid gap-4 md:grid-cols-3 lg:gap-6">
        {PLANS.map((p) => {
          const isCurrent = currentPlan === p.id;
          return (
            <div
              key={p.id}
              className={`card relative flex flex-col p-6 ${p.highlight ? 'border-brand-300 ring-1 ring-brand-200' : ''}`}
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
                type="button"
                onClick={() => openRequest(p.id)}
                disabled={isCurrent}
                className={`mt-6 w-full ${isCurrent ? 'btn-secondary cursor-default' : 'btn-primary'}`}
              >
                {isCurrent ? 'Current plan' : `Upgrade to ${p.name}`}
              </button>
            </div>
          );
        })}
      </div>

      <p className="mt-8 text-center text-xs leading-relaxed text-ink-400">
        * Multi-client management coming soon &middot; Send a request and our team activates your plan &middot;
        Subscriptions last 30 days per payment
      </p>

      {/* ---- upgrade request dialog ---- */}
      {openPlan && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="upgrade-title"
        >
          {/* Backdrop blurs the page and swallows clicks, so nothing behind moves */}
          <div className="absolute inset-0 bg-ink-900/40 backdrop-blur-sm" onClick={closeDialog} />

          <div className="relative w-full max-w-md rounded-xl border border-gray-200 bg-white p-0 shadow-2xl">
            <button
              type="button"
              onClick={closeDialog}
              aria-label="Close"
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-gray-100 hover:text-ink-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>

            {sent ? (
              <div className="p-6 text-center">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                </div>
                <h2 id="upgrade-title" className="mt-3 h-display text-lg">Request sent</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-500">
                  Thank you. Our team will get back to you shortly to activate the{' '}
                  <strong className="text-ink-900">{sent.planName}</strong> plan.
                </p>
                <p className="mt-4 inline-block rounded-lg bg-gray-50 px-3 py-1.5 text-xs text-ink-600">
                  Order ID <span className="font-semibold text-ink-900">{sent.orderId}</span>
                </p>
                <button type="button" onClick={closeDialog} className="btn-primary mt-5 w-full">Done</button>
              </div>
            ) : (
              <form onSubmit={submitRequest} className="p-5 sm:p-6">
                <h2 id="upgrade-title" className="h-display pr-8 text-lg">Upgrade to {planLabel(openPlan)}</h2>
                <p className="mt-1 text-xs text-ink-500">Check your details and send the request - we will get back to you.</p>

                <div className="mt-4 space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-ink-600">Name</span>
                    <input {...bind('name')} className="input-base" required placeholder="Your name" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-ink-600">Email</span>
                    <input {...bind('email')} type="email" className="input-base" required placeholder="you@business.com" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-ink-600">Phone</span>
                    <input {...bind('phone')} type="tel" className="input-base" required placeholder="+977 98XXXXXXXX" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-ink-600">Plan</span>
                    <select {...bind('plan')} className="input-base">
                      {PAID_PLANS.map((p) => (
                        <option key={p.id} value={p.id}>{p.name} - {p.price}{p.per || ''}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-ink-600">
                      Message <span className="font-normal text-ink-400">(optional)</span>
                    </span>
                    <textarea {...bind('message')} rows="2" className="input-base resize-none" placeholder="Anything we should know?" />
                  </label>
                </div>

                {formError && (
                  <p className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">{formError}</p>
                )}

                <div className="mt-5 flex gap-2">
                  <button type="button" onClick={closeDialog} className="btn-secondary flex-1">Cancel</button>
                  <button type="submit" disabled={sending} className="btn-primary flex-1">
                    {sending ? 'Sending...' : 'Request'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </main>
  );
}