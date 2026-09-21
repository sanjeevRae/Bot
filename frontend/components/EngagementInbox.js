import { useState, useEffect } from 'react';
import { api } from '../lib/supabaseClient';

/**
 * Inbox — conversations the bot escalated to a human.
 *
 * Lifted verbatim from the former /inbox page so it can render inside the Engagement
 * tabs (and inside the "All" overview) without duplicating the feature.
 *
 * V11 additions (the missing half of the loop):
 *   - "Take over" pauses the bot for that conversation (channel pipelines check
 *     the flag before answering, so the human and the bot never talk over each other)
 *   - a reply box that sends the owner's message on the customer's own channel
 *     (WhatsApp / Messenger / Instagram / Telegram / Viber) and stores it in the
 *     transcript; "Reply & resume bot" sends and hands control back to the bot.
 */
export default function EngagementInbox({ preview, onViewAll }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [replyFor, setReplyFor] = useState(null);

  async function load() {
    try {
      const d = await api('/api/inbox');
      setItems(d.conversations || []);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function run(fn) {
    setBusy(true); setError('');
    try { return await fn(); }
    catch (e) { setError(e.message); return null; }
    finally { setBusy(false); }
  }

  const resolve = (sessionId) =>
    run(async () => {
      await api(`/api/inbox/${encodeURIComponent(sessionId)}/resolve`, { method: 'PATCH' });
      await load();
    });

  const takeover = (sessionId) =>
    run(async () => {
      await api(`/api/inbox/${encodeURIComponent(sessionId)}/takeover`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    });

  const sendReply = (sessionId, resumeBot) =>
    run(async () => {
      if (!reply.trim()) return;
      await api(`/api/inbox/${encodeURIComponent(sessionId)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ text: reply.trim(), resumeBot }),
      });
      setReply('');
      setReplyFor(null);
      await load();
    });

  const shown = preview ? (items || []).slice(0, preview) : items;

  return (
    <section>
      {/* Page header */}
      <div className="section-header">
        <div>
          <h1 className="h-display text-2xl sm:text-[28px]">Inbox</h1>
          <p className="mt-1 text-sm text-ink-500">
            Conversations your bot escalated to a human.
          </p>
        </div>
        {items && items.length > 0 && (
          <span className="chip-warning w-fit">{items.length} pending</span>
        )}
      </div>

      {error && (
        <div className="mb-6 rounded-md border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {!items ? (
        <p className="py-10 text-center text-sm text-ink-400">Loading…</p>
      ) : items.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-sm font-medium text-ink-700">Inbox zero 🎉</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-400">
            When a customer asks for a human or the bot can&apos;t help, the conversation appears here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((c) => (
            <div key={c.sessionId} className="card overflow-hidden">
              <button
                onClick={() => setOpen(open === c.sessionId ? null : c.sessionId)}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-gray-50"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink-900">{c.sessionId}</span>
                    <span className="chip">{c.channel}</span>
                    <span className="chip-accent">{c.messages.length} messages</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-ink-400">
                    Requested {new Date(c.requestedAt).toLocaleString()}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-semibold text-ink-900">
                  {open === c.sessionId ? 'Hide' : 'View'}
                </span>
              </button>

              {open === c.sessionId && (
                <div className="border-t border-gray-200 bg-gray-50 p-5">
                  <div className="mb-4 space-y-2.5">
                    {c.messages.map((m, i) => (
                      <div
                        key={i}
                        className={`max-w-[85%] whitespace-pre-wrap rounded-md px-3.5 py-2.5 text-[13px] ${
                          m.role === 'user'
                            ? 'ml-auto bg-ink-900 text-white'
                            : 'bg-white text-ink-700'
                        }`}
                      >
                        {m.message}
                      </div>
                    ))}
                  </div>
                  {/* Reply on the customer's own channel + bot pause (V11) */}
                  {replyFor === c.sessionId ? (
                    <div className="mb-3 space-y-2">
                      <textarea
                        rows={2}
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        placeholder={`Reply as yourself on ${c.channel}…`}
                        className="input-base resize-none !py-2 text-[13px]"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => sendReply(c.sessionId, false)}
                          disabled={busy || !reply.trim()}
                          className="btn-primary !py-2 text-xs"
                        >
                          Send reply
                        </button>
                        <button
                          onClick={() => sendReply(c.sessionId, true)}
                          disabled={busy || !reply.trim()}
                          className="btn-secondary !py-2 text-xs"
                        >
                          Reply &amp; resume bot
                        </button>
                        <button onClick={() => { setReplyFor(null); setReply(''); }} disabled={busy} className="btn-ghost !py-2 text-xs">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {c.remoteId ? (
                        <button
                          onClick={() => { setReplyFor(c.sessionId); setReply(''); }}
                          disabled={busy}
                          className="btn-primary !py-2 text-xs"
                        >
                          Reply on {c.channel}
                        </button>
                      ) : (
                        <span className="text-xs text-ink-400">
                          Reply unlocks once this customer messages you on {c.channel}.
                        </span>
                      )}
                      {!c.botPaused ? (
                        <button onClick={() => takeover(c.sessionId)} disabled={busy} className="btn-secondary !py-2 text-xs">
                          Take over (pause bot)
                        </button>
                      ) : (
                        <span className="chip-warning">Bot paused — it won&apos;t reply until you resume</span>
                      )}
                      <button onClick={() => resolve(c.sessionId)} disabled={busy} className="btn-ghost !py-2 text-xs">
                        Mark as handled
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {preview && items && items.length > preview && (
        <button onClick={onViewAll} className="btn-link mt-4">
          View all {items.length} conversations →
        </button>
      )}
    </section>
  );
}
