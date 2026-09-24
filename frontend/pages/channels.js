import { useState, useEffect } from 'react';
import { api } from '../lib/supabaseClient';

function TelegramIcon({ className = 'h-5 w-5' }) {
  return (
    <svg className={className} viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid">
      <defs><linearGradient id="tg" x1="50%" x2="50%" y1="0%" y2="100%"><stop offset="0%" stop-color="#2AABEE"/><stop offset="100%" stop-color="#229ED9"/></linearGradient></defs>
      <path fill="url(#tg)" d="M128 0C94.06 0 61.48 13.494 37.5 37.49A128.038 128.038 0 0 0 0 128c0 33.934 13.5 66.514 37.5 90.51C61.48 242.506 94.06 256 128 256s66.52-13.494 90.5-37.49c24-23.996 37.5-56.576 37.5-90.51 0-33.934-13.5-66.514-37.5-90.51C194.52 13.494 161.94 0 128 0Z"/>
      <path fill="#FFF" d="M57.94 126.648c37.32-16.256 62.2-26.974 74.64-32.152 35.56-14.786 42.94-17.354 47.76-17.441 1.06-.017 3.42.245 4.96 1.49 1.28 1.05 1.64 2.47 1.82 3.467.16.996.38 3.266.2 5.038-1.92 20.24-10.26 69.356-14.5 92.026-1.78 9.592-5.32 12.808-8.74 13.122-7.44.684-13.08-4.912-20.28-9.63-11.26-7.386-17.62-11.982-28.56-19.188-12.64-8.328-4.44-12.906 2.76-20.386 1.88-1.958 34.64-31.748 35.26-34.45.08-.338.16-1.598.2-2.262-.74-.666-1.84-.438-2.64-.258-1.14.256-19.12 12.152-54 35.686-5.1 3.508-9.72 5.218-13.88 5.128-4.56-.098-13.36-2.584-19.9-4.708-8-2.606-14.38-3.984-13.82-8.41.28-2.304 3.46-4.662 9.52-7.072Z"/>
    </svg>
  );
}

function ViberIcon({ className = 'h-5 w-5' }) {
  return (
    <img
      src="https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/viber/default.svg"
      alt="Viber"
      className={className}
    />
  );
}

function SmsIcon({ className = 'h-5 w-5' }) {
  return (
    <svg className={className} fill="#34DA50" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <title>iMessage</title>
      <path d="M5.285 0A5.273 5.273 0 0 0 0 5.285v13.43A5.273 5.273 0 0 0 5.285 24h13.43A5.273 5.273 0 0 0 24 18.715V5.285A5.273 5.273 0 0 0 18.715 0ZM12 4.154a8.809 7.337 0 0 1 8.809 7.338A8.809 7.337 0 0 1 12 18.828a8.809 7.337 0 0 1-2.492-.303A8.656 7.337 0 0 1 5.93 19.93a9.929 7.337 0 0 0 1.54-2.155 8.809 7.337 0 0 1-4.279-6.283A8.809 7.337 0 0 1 12 4.154"/>
    </svg>
  );
}

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
  const [diag, setDiag] = useState(null);
  // V11 bot-token channels
  const [tgToken, setTgToken] = useState('');
  const [viberToken, setViberToken] = useState('');

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

  // Group chats stay silent unless the bot is @-mentioned; this is the org switch.
  async function toggleGroupReplies(next) {
    setBusy(true); setError('');
    try {
      await api('/api/org/openwa/settings', { method: 'POST', body: JSON.stringify({ groupRepliesEnabled: next }) });
      await loadOpenwa();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  // Pulls the last inbound decisions + live gateway facts, so "it did not answer
  // in the group" is answerable without the server logs.
  async function loadDiagnostics() {
    setBusy(true); setError('');
    try {
      const d = await api('/api/org/openwa/diagnostics');
      setDiag(d.diagnostics || null);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  // Plain text into a group JID — proves the send path without waiting for a
  // mention, which is exactly what a silent bot needs to rule out first.
  async function testGroup(chatId) {
    setBusy(true); setError('');
    try {
      await api('/api/org/openwa/test', { method: 'POST', body: JSON.stringify({ chatId }) });
      setError('Test message sent to that group.');
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
            <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="" width="22" height="22" />
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
              <button onClick={loadDiagnostics} disabled={busy} className="btn-secondary !py-2 text-xs">Diagnose group replies</button>
            </div>
            <label className="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50/60 px-3.5 py-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-brand-600"
                checked={openwa.groupRepliesEnabled !== false}
                disabled={busy}
                onChange={(e) => toggleGroupReplies(e.target.checked)}
              />
              <span className="text-[13px] text-ink-700">
                <span className="font-medium">Reply in groups when @-mentioned</span>
                <span className="mt-0.5 block text-xs text-ink-400">
                  The bot stays silent in a group chat until someone mentions{' '}
                  <span className="font-medium">{openwa.phoneNumber || 'its number'}</span>; it then answers
                  in the group and tags the person who asked. Direct messages are never affected.
                </span>
              </span>
            </label>

            {diag && (
              <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[13px] font-medium text-ink-700">Group-reply diagnostics</p>
                  <div className="flex items-center gap-3">
                    <button onClick={loadDiagnostics} disabled={busy} className="text-[12px] font-medium text-brand-600 hover:text-brand-700">Refresh</button>
                    <button onClick={() => setDiag(null)} className="text-[12px] text-ink-400 hover:text-ink-600">Hide</button>
                  </div>
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-3 font-mono text-[11px] leading-relaxed text-ink-600">{JSON.stringify(diag, null, 2)}</pre>
                {Array.isArray(diag.groups) && diag.groups.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1.5 text-xs text-ink-500">
                      Groups this number is in — “Send test” posts a plain message, no mention needed:
                    </p>
                    <ul className="space-y-1">
                      {diag.groups.map((g) => (
                        <li key={g.id} className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-[11px] text-ink-600">{g.name || '(unnamed)'} · {g.id}</span>
                          <button onClick={() => testGroup(g.id)} disabled={busy} className="btn-secondary !py-1 !px-2 text-[11px]">Send test</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
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

      {/* Telegram — connect-your-own-bot (V11) */}
      <section className="card mb-5 p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center">
              <TelegramIcon />
            </div>
            <h2 className="text-sm font-semibold text-ink-900">Telegram</h2>
          </div>
          <span className={channels.telegram?.connected ? 'chip-success' : 'chip'}>
            {channels.telegram?.connected ? 'Connected' : 'Not connected'}
          </span>
        </div>

        {channels.telegram?.connected ? (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-500">
              Bot token connected. Set your webhook in BotFather to <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">{webhookUrl.replace('/api/channels/webhook', '/api/webhooks/telegram/:orgId')}</code>
            </p>
            <button
              onClick={() => disconnect('telegram')}
              disabled={busy}
              className="btn-secondary !py-2 text-xs"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={tgToken}
              onChange={(e) => setTgToken(e.target.value)}
              placeholder="Bot token (e.g. 123456:ABC-…)"
              className="input-base flex-1 !py-2 text-[13px]"
            />
            <button
              onClick={() => connect('telegram', tgToken)}
              disabled={busy}
              className="btn-primary !py-2 text-xs"
            >
              Connect
            </button>
          </div>
        )}
      </section>

      {/* Viber — connect-your-own-bot (V11) */}
      <section className="card mb-5 p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ViberIcon />
            <h2 className="text-sm font-semibold text-ink-900">Viber</h2>
          </div>
          <span className={channels.viber?.connected ? 'chip-success' : 'chip'}>
            {channels.viber?.connected ? 'Connected' : 'Not connected'}
          </span>
        </div>

        {channels.viber?.connected ? (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-500">
              Bot token connected. Set your webhook in the Viber dashboard to <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">{webhookUrl.replace('/api/channels/webhook', '/api/webhooks/viber/:orgId')}</code>
            </p>
            <button
              onClick={() => disconnect('viber')}
              disabled={busy}
              className="btn-secondary !py-2 text-xs"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={viberToken}
              onChange={(e) => setViberToken(e.target.value)}
              placeholder="Bot token"
              className="input-base flex-1 !py-2 text-[13px]"
            />
            <button
              onClick={() => connect('viber', viberToken)}
              disabled={busy}
              className="btn-primary !py-2 text-xs"
            >
              Connect
            </button>
          </div>
        )}
      </section>

      {/* SMS — backend-configured (admin only) */}
      <section className="card mb-8 p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center">
              <SmsIcon />
            </div>
            <h2 className="text-sm font-semibold text-ink-900">SMS</h2>
          </div>
          <span className={channels.sms?.configured ? 'chip-success' : 'chip'}>
            {channels.sms?.configured ? 'Configured' : 'Not configured'}
          </span>
        </div>

        {channels.sms?.configured ? (
          <p className="text-[13px] text-ink-500">
            SMS is enabled via your SMS provider. SMS sends are counted against your monthly message quota. Used for booking confirmations and handoff pings.
          </p>
        ) : (
          <p className="text-[13px] text-ink-500">
            Contact support to enable it for your account.
          </p>
        )}
      </section>

      <p className="text-xs leading-relaxed text-ink-400">
        Instagram DMs work through the same Messenger connection when your Instagram account is linked to the Facebook Page.
      </p>
    </main>
  );
}
