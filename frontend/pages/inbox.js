import { useState, useEffect } from 'react';
import { api } from '../lib/supabaseClient';

export default function Inbox() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const d = await api('/api/inbox');
      setItems(d.conversations || []);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function resolve(sessionId) {
    setBusy(true);
    try {
      await api(`/api/inbox/${sessionId}/resolve`, { method: 'PATCH' });
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 sm:px-6 sm:py-12">
      {/* Page header */}
      <div className="mb-8 flex flex-col justify-between gap-4 border-b border-gray-200 pb-6 sm:flex-row sm:items-end">
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
        <div className="mb-6 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
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
          {items.map((c) => (
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
                <span className="shrink-0 text-xs font-medium text-brand-600">
                  {open === c.sessionId ? 'Hide' : 'View'}
                </span>
              </button>

              {open === c.sessionId && (
                <div className="border-t border-gray-200 bg-gray-50 p-5">
                  <div className="mb-4 space-y-2.5">
                    {c.messages.map((m, i) => (
                      <div
                        key={i}
                        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3.5 py-2.5 text-[13px] ${
                          m.role === 'user'
                            ? 'ml-auto rounded-br-sm bg-brand-600 text-white'
                            : 'rounded-bl-sm border border-gray-200 bg-white text-ink-700'
                        }`}
                      >
                        {m.message}
                      </div>
                    ))}
                  </div>
                  <button onClick={() => resolve(c.sessionId)} disabled={busy} className="btn-primary !py-2 text-xs">
                    Mark as handled
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
