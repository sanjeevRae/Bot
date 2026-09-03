import { useState, useEffect } from 'react';
import { api } from '../lib/supabaseClient';

export default function Channels() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waId, setWaId] = useState('');
  const [msId, setMsId] = useState('');
  // OpenWA (self-hosted gateway) — separate from the existing Meta channels
  const [openwa, setOpenwa] = useState(null);
  const [owaSession, setOwaSession] = useState('');
  const [owaChatId, setOwaChatId] = useState('');

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

  async function loadOpenwa() {
    try {
      const d = await api('/api/org/openwa/status');
      setOpenwa(d.openwa || null);
    } catch (e) {
      // Don't overwrite channel errors; just leave OpenWA unmounted if backend lacks it
      setOpenwa(null);
    }
  }

  useEffect(() => { load(); loadOpenwa(); }, []);

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

  async function connectOpenwa() {
    if (!owaSession.trim()) return;
    setBusy(true); setError('');
    try {
      await api('/api/org/openwa/connect', { method: 'POST', body: JSON.stringify({ sessionId: owaSession.trim() }) });
      setOwaSession('');
      await loadOpenwa();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function disconnectOpenwa() {
    setBusy(true); setError('');
    try {
      await api('/api/org/openwa/disconnect', { method: 'POST', body: JSON.stringify({}) });
      await loadOpenwa();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function reconnectOpenwa() {
    setBusy(true); setError('');
    try {
      await api('/api/org/openwa/reconnect', { method: 'POST', body: JSON.stringify({}) });
      await loadOpenwa();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function testOpenwa() {
    if (!owaChatId.trim()) return;
    setBusy(true); setError('');
    try {
      await api('/api/org/openwa/test', { method: 'POST', body: JSON.stringify({ chatId: owaChatId.trim() }) });
      setError('Test message sent.');
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

      {/* OpenWA — self-hosted WhatsApp gateway (added as a new channel; existing channels untouched) */}
      <section className="card mb-8 p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="" width="22" height="22" />
            <h2 className="text-sm font-semibold text-ink-900">WhatsApp (OpenWA)</h2>
          </div>
          <span className={openwa?.connected ? 'chip-success' : 'chip'}>
            {openwa?.connected ? 'Connected' : 'Not connected'}
          </span>
        </div>

        {openwa?.connected ? (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-500">
              Session: <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">{openwa.sessionId}</code>
              {openwa.phoneNumber && <> · Number: <span className="font-medium">{openwa.phoneNumber}</span></>}
              {openwa.status && <> · Status: <span className="font-medium">{openwa.status}</span></>}
            </p>
            <p className="text-[13px] text-ink-500">
              Webhook: <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">{openwa.webhookUrl}</code>
            </p>
            <div className="flex flex-wrap gap-2">
              <button onClick={disconnectOpenwa} disabled={busy} className="btn-secondary !py-2 text-xs">Disconnect</button>
              <button onClick={reconnectOpenwa} disabled={busy} className="btn-secondary !py-2 text-xs">Reconnect</button>
            </div>
            {!openwa.baseUrlConfigured && (
              <p className="text-xs text-amber-600">OpenWA is not configured on the backend (OPENWA_BASE_URL missing).</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={owaSession}
                onChange={(e) => setOwaSession(e.target.value)}
                placeholder="OpenWA Session ID (e.g. e2cfe66b-…)"
                className="input-base flex-1 !py-2 text-[13px]"
              />
              <button onClick={connectOpenwa} disabled={busy} className="btn-primary !py-2 text-xs">Connect</button>
            </div>
            <p className="text-xs text-ink-400">
              OpenWA is a self-hosted WhatsApp gateway. Enter the session ID from your OpenWA dashboard
              (Dashboard → Sessions). Messages will be answered by your existing Chitra AI bot.
            </p>
          </div>
        )}

        {openwa?.connected && (
          <div className="mt-4 flex flex-col gap-2 border-t border-gray-100 pt-4">
            <p className="text-[13px] font-medium text-ink-700">Send a test message</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={owaChatId}
                onChange={(e) => setOwaChatId(e.target.value)}
                placeholder="Your WhatsApp number (e.g. 628123456789)"
                className="input-base flex-1 !py-2 text-[13px]"
              />
              <button onClick={testOpenwa} disabled={busy} className="btn-secondary !py-2 text-xs">Send test</button>
            </div>
          </div>
        )}
      </section>

      <p className="text-xs leading-relaxed text-ink-400">
        Instagram DMs work through the same Messenger connection when your Instagram account is linked to the Facebook Page.
      </p>
    </main>
  );
}
