import { useState, useEffect } from 'react';
import { api } from '../lib/supabaseClient';

export default function Channels() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waId, setWaId] = useState('');
  const [msId, setMsId] = useState('');

  async function load() {
    try {
      const d = await api('/api/org/channels');
      setData(d);
      setWaId(d.channels.whatsapp.phoneNumberId || '');
      setMsId(d.channels.messenger.pageId || '');
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function connect(channel, externalId) {
    if (!externalId.trim()) return;
    setBusy(true); setError('');
    try {
      await api('/api/org/channels', { method: 'POST', body: JSON.stringify({ channel, externalId }) });
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function disconnect(channel) {
    setBusy(true); setError('');
    try {
      await api(`/api/org/channels/${channel}`, { method: 'DELETE' });
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  if (!data) return <main className="mx-auto max-w-2xl px-6 py-16 text-sm text-ink-400">{error || 'Loading…'}</main>;

  const { channels, webhookUrl } = data;

  return (
    <main className="mx-auto max-w-2xl px-5 py-10 sm:px-6 sm:py-12">
      {/* Page header */}
      <div className="mb-8 border-b border-gray-200 pb-6">
        <h1 className="h-display text-2xl sm:text-[28px]">Channels</h1>
        <p className="mt-1 text-sm text-ink-500">Let customers chat with your bot on WhatsApp and Messenger.</p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {/* Setup guide */}
      <div className="card mb-5 p-6">
        <h2 className="mb-2 text-sm font-semibold text-ink-900">One-time Meta setup</h2>
        <ol className="list-inside list-decimal space-y-1.5 text-[13px] leading-relaxed text-ink-500">
          <li>Create a free app at <span className="font-medium text-ink-700">developers.facebook.com</span> and add the <em>WhatsApp</em> and/or <em>Messenger</em> product.</li>
          <li>In webhook settings, point the callback URL to:</li>
        </ol>
        <pre className="my-3 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-ink-700">{webhookUrl}</pre>
        <ol start={3} className="list-inside list-decimal space-y-1.5 text-[13px] leading-relaxed text-ink-500">
          <li>Set a verify token — use the same value as <code className="rounded bg-gray-100 px-1 font-mono text-[11px]">META_VERIFY_TOKEN</code> in your backend env.</li>
          <li>Subscribe to the <code className="rounded bg-gray-100 px-1 font-mono text-[11px]">messages</code> field, then paste your Phone Number ID / Page ID below.</li>
        </ol>
      </div>

      {/* WhatsApp */}
      <section className="card mb-5 p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="https://s.magecdn.com/social/tc-whatsapp.svg" alt="" width="22" height="22" />
            <h2 className="text-sm font-semibold text-ink-900">WhatsApp</h2>
          </div>
          <span className={channels.whatsapp.connected ? 'chip-success' : 'chip'}>
            {channels.whatsapp.connected ? 'Connected' : 'Not connected'}
          </span>
        </div>
        {channels.whatsapp.connected ? (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-500">
              Phone Number ID: <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">{channels.whatsapp.phoneNumberId}</code>
              {channels.whatsapp.displayNumber && <> · Number: <span className="font-medium">{channels.whatsapp.displayNumber}</span></>}
            </p>
            <button onClick={() => disconnect('whatsapp')} disabled={busy} className="btn-secondary !py-2 text-xs">Disconnect</button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={waId}
              onChange={(e) => setWaId(e.target.value)}
              placeholder="WhatsApp Phone Number ID"
              className="input-base flex-1 !py-2 text-[13px]"
            />
            <button onClick={() => connect('whatsapp', waId)} disabled={busy} className="btn-primary !py-2 text-xs">Connect</button>
          </div>
        )}
      </section>

      {/* Messenger */}
      <section className="card mb-8 p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="https://s.magecdn.com/social/tc-facebook.svg" alt="" width="22" height="22" />
            <h2 className="text-sm font-semibold text-ink-900">Messenger</h2>
          </div>
          <span className={channels.messenger.connected ? 'chip-success' : 'chip'}>
            {channels.messenger.connected ? 'Connected' : 'Not connected'}
          </span>
        </div>
        {channels.messenger.connected ? (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-500">
              Page ID: <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">{channels.messenger.pageId}</code>
            </p>
            <button onClick={() => disconnect('messenger')} disabled={busy} className="btn-secondary !py-2 text-xs">Disconnect</button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={msId}
              onChange={(e) => setMsId(e.target.value)}
              placeholder="Facebook Page ID"
              className="input-base flex-1 !py-2 text-[13px]"
            />
            <button onClick={() => connect('messenger', msId)} disabled={busy} className="btn-primary !py-2 text-xs">Connect</button>
          </div>
        )}
      </section>

      <p className="text-xs leading-relaxed text-ink-400">
        Instagram DMs work through the same Messenger connection when your Instagram account is linked to the Facebook Page.
      </p>
    </main>
  );
}
