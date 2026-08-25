import { useState, useEffect, useRef } from 'react';

/**
 * Floating chat widget for the Chitra AI landing page.
 * Talks to /api/chat using the platform's own org ID.
 * Set NEXT_PUBLIC_DEMO_ORG_ID in Vercel env to enable.
 */
export default function DemoWidget({ orgId }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([{ who: 'bot', text: 'Hi! 👋 Ask me anything about Chitra AI.' }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (open) boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [messages, open]);

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, { who: 'user', text }]);
    setBusy(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, sessionId: `landing_${Date.now()}`, message: text }),
      });
      const data = await res.json();
      setMessages((m) => [...m, { who: 'bot', text: data.reply || data.error || 'Sorry, something went wrong.' }]);
    } catch {
      setMessages((m) => [...m, { who: 'bot', text: 'Connection error. Please try again.' }]);
    }
    setBusy(false);
  }

  return (
    <>
      {/* Panel */}
      {open && (
        <div className="fixed bottom-24 right-5 z-50 flex h-[480px] w-[360px] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between bg-brand-600 px-4 py-3">
            <span className="text-sm font-semibold text-white">Chitra Assistant</span>
            <button onClick={() => setOpen(false)} aria-label="Close chat" className="text-white/80 transition-colors hover:text-white">✕</button>
          </div>

          <div ref={boxRef} className="flex flex-1 flex-col gap-2 overflow-y-auto bg-gray-50 p-3">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
                  m.who === 'user'
                    ? 'self-end rounded-br-sm bg-brand-600 text-white'
                    : 'self-start rounded-bl-sm border border-gray-200 bg-white text-ink-700'
                }`}
              >
                {m.text}
              </div>
            ))}
            {busy && (
              <div className="self-start rounded-lg border border-gray-200 bg-white px-3 py-2">
                <span className="inline-flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: `${i * 150}ms` }} />
                  ))}
                </span>
              </div>
            )}
          </div>

          <form onSubmit={send} className="flex border-t border-gray-200 bg-white">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message…"
              className="flex-1 px-3 py-2.5 text-sm outline-none placeholder:text-ink-400"
            />
            <button type="submit" disabled={busy} className="bg-brand-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-50">
              Send
            </button>
          </form>
        </div>
      )}

      {/* Launcher */}
      <button
        onClick={() => setOpen(!open)}
        aria-label="Open chat"
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-2xl text-white shadow-lg transition-transform hover:scale-105"
      >
        {open ? '✕' : '💬'}
      </button>
    </>
  );
}
