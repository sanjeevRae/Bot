import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '../lib/supabaseClient';

export default function Settings() {
  const [org, setOrg] = useState(null);
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const isPro = org?.plan === 'pro' || org?.plan === 'agency';

  useEffect(() => {
    api('/api/org/me')
      .then((d) => { setOrg(d.org); setSettings(d.settings); })
      .catch((e) => setError(e.message));
  }, []);

  async function save() {
    setSaved(false); setError('');
    try {
      await api('/api/org/settings', { method: 'PATCH', body: JSON.stringify(settings) });
      await api('/api/org/profile', { method: 'PATCH', body: JSON.stringify({ name: org.name, industry: org.industry }) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError(e.message); }
  }

  async function generateKey() {
    try {
      const d = await api('/api/org/api-key', { method: 'POST' });
      setApiKey(d.apiKey);
    } catch (e) { setError(e.message); }
  }

  if (!settings) return <main className="mx-auto max-w-2xl px-6 py-16 text-sm text-ink-400">{error || 'Loading…'}</main>;

  const inputCls = 'input-base';

  return (
    <main className="mx-auto max-w-2xl px-5 py-10 sm:px-6 sm:py-12">
      {/* Page header */}
      <div className="mb-8 border-b border-gray-200 pb-6">
        <h1 className="h-display text-2xl sm:text-[28px]">Settings</h1>
        <p className="mt-1 text-sm text-ink-500">Manage your business profile, bot behavior and integrations.</p>
      </div>

      <div className="space-y-5">
        <section className="card p-6">
          <h2 className="mb-1 text-sm font-semibold text-ink-900">Business</h2>
          <p className="mb-4 text-xs text-ink-400">Basic details about your company.</p>
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Business name</label>
              <input value={org?.name || ''} onChange={(e) => setOrg({ ...org, name: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Industry</label>
              <input value={org?.industry || ''} onChange={(e) => setOrg({ ...org, industry: e.target.value })} className={inputCls} />
            </div>
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-1 text-sm font-semibold text-ink-900">Bot personality</h2>
          <p className="mb-4 text-xs text-ink-400">How your assistant introduces itself.</p>
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Bot name</label>
              <input value={settings.bot_name || ''} onChange={(e) => setSettings({ ...settings, bot_name: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Welcome message</label>
              <textarea rows={2} value={settings.welcome_message || ''} onChange={(e) => setSettings({ ...settings, welcome_message: e.target.value })} className={`${inputCls} resize-none`} />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Brand color</label>
              <div className="flex items-center gap-3">
                <input type="color" value={settings.brand_color || '#059669'}
                  onChange={(e) => setSettings({ ...settings, brand_color: e.target.value })}
                  className="h-9 w-14 cursor-pointer rounded-lg border border-gray-300 bg-white p-1" />
                <span className="font-mono text-xs text-ink-500">{settings.brand_color || '#059669'}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-1 text-sm font-semibold text-ink-900">Notifications</h2>
          <p className="mb-4 text-xs text-ink-400">Get notified of new bookings &amp; leads.</p>
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Notification email</label>
              <input type="email" placeholder="you@business.com" value={settings.notify_email || ''}
                onChange={(e) => setSettings({ ...settings, notify_email: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Webhook URL (Slack / Zapier / n8n)</label>
              <input placeholder="https://hooks.example.com/..." value={settings.webhook_url || ''}
                onChange={(e) => setSettings({ ...settings, webhook_url: e.target.value })} className={`${inputCls} font-mono text-[13px]`} />
            </div>
          </div>
        </section>

        <section className="card p-6">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-900">White-label &amp; custom domain</h2>
            {!isPro && <Link href="/billing" className="btn-link !text-xs">Upgrade →</Link>}
          </div>
          <p className="mb-4 text-xs text-ink-400">
            {isPro
              ? 'Remove Chitra branding and use your own chat domain.'
              : 'Available on Pro and Agency plans.'}
          </p>
          <div className={`space-y-4 ${isPro ? '' : 'pointer-events-none opacity-50'}`}>
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={!!settings.white_label}
                onChange={(e) => setSettings({ ...settings, white_label: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 accent-brand-600"
              />
              <span className="text-[13px] text-ink-700">Hide “Powered by Chitra AI” in the widget</span>
            </label>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Custom chat domain</label>
              <input
                placeholder="chat.yourbusiness.com"
                value={settings.custom_domain || ''}
                onChange={(e) => setSettings({ ...settings, custom_domain: e.target.value })}
                className={`${inputCls} font-mono text-[13px]`}
              />
              <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
                After saving, add a CNAME record in your DNS:{' '}
                <code className="rounded bg-gray-100 px-1 font-mono">{settings.custom_domain || 'chat.yourbusiness.com'} → CNAME → your-api.onrender.com</code>
              </p>
            </div>
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-1 text-sm font-semibold text-ink-900">API key</h2>
          <p className="mb-4 text-xs text-ink-400">For advanced integrations. Shown once — store it safely.</p>
          {apiKey && (
            <pre className="mb-4 break-all rounded-lg border border-gray-200 bg-gray-50 p-3.5 font-mono text-xs leading-relaxed text-ink-700">{apiKey}</pre>
          )}
          <button onClick={generateKey} className="btn-secondary !py-2 text-xs">Generate new key</button>
        </section>
      </div>

      {/* Sticky save bar */}
      <div className="sticky bottom-0 mt-8 flex items-center gap-3 border-t border-gray-200 bg-white py-4">
        <button onClick={save} className="btn-primary">Save changes</button>
        {saved && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            Saved
          </span>
        )}
        {error && !saved && <span className="text-sm text-red-500">{error}</span>}
      </div>
    </main>
  );
}
