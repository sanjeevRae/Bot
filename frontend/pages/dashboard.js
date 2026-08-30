import { useState, useEffect, useRef } from 'react';
import { api, fetchApi } from '../lib/supabaseClient';

/**
 * Minimal markdown → JSX renderer for bot replies.
 * Supports: **bold**, *italic*, `code`, - bullets, 1. numbered lists,
 * ### headings, tables (| a | b |), and [links](url).
 */
function renderMarkdown(text) {
  const inline = (s) => {
    const parts = [];
    let rest = s;
    const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/;
    while (rest) {
      const m = rest.match(pattern);
      if (!m) { parts.push(rest); break; }
      if (m.index > 0) parts.push(rest.slice(0, m.index));
      const tok = m[0];
      if (tok.startsWith('**')) parts.push(<strong key={parts.length} className="font-semibold">{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith('*')) parts.push(<em key={parts.length}>{tok.slice(1, -1)}</em>);
      else if (tok.startsWith('`')) parts.push(<code key={parts.length} className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[12px]">{tok.slice(1, -1)}</code>);
      else {
        const lm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
        parts.push(<a key={parts.length} href={lm[2]} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline">{lm[1]}</a>);
      }
      rest = rest.slice(m.index + tok.length);
    }
    return parts;
  };

  // Split table rows out first: | a | b | c |
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const parseRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  const lines = text.split('\n');
  const blocks = [];
  let list = [];
  let ordered = false;
  let table = null; // { header: [], rows: [][] }

  const flushList = () => {
    if (!list.length) return;
    const items = list.map((item, i) => (
      <li key={i} className="flex gap-2">
        {ordered
          ? <span className="shrink-0 font-semibold text-brand-600">{i + 1}.</span>
          : <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current opacity-50" />}
        <span>{inline(item)}</span>
      </li>
    ));
    blocks.push(
      ordered
        ? <ol key={`ol-${blocks.length}`} className="my-1 space-y-1">{items}</ol>
        : <ul key={`ul-${blocks.length}`} className="my-1 space-y-1">{items}</ul>
    );
    list = [];
  };

  const flushTable = () => {
    if (!table) return;
    blocks.push(
      <div key={`tb-${blocks.length}`} className="my-2 overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              {table.header.map((h, i) => (
                <th key={i} className="px-2.5 py-1.5 font-semibold text-ink-900">{inline(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {table.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td key={i} className="px-2.5 py-1.5 align-top text-ink-700">{inline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    table = null;
  };

  for (const line of lines) {
    // Table handling
    if (isTableRow(line)) {
      const cells = parseRow(line);
      // separator row like |---|---| → skip
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) table = { header: cells, rows: [] };
      else table.rows.push(cells);
      continue;
    }
    flushTable();

    const bullet = line.match(/^\s*[-•*]\s+(.*)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    const heading = line.match(/^(#{1,6})\s+(.*)/);

    if (bullet || numbered) {
      const isOrdered = !!numbered;
      if (list.length && ordered !== isOrdered) flushList();
      ordered = isOrdered;
      list.push((bullet || numbered)[1]);
    } else {
      flushList();
      if (heading) {
        const level = heading[1].length;
        blocks.push(
          <p key={blocks.length} className={`mt-1 font-semibold ${level <= 2 ? 'text-[15px]' : 'text-sm'}`}>
            {inline(heading[2])}
          </p>
        );
      } else if (line.trim()) {
        blocks.push(<p key={blocks.length} className="min-h-[1em]">{inline(line)}</p>);
      }
    }
  }
  flushList();
  flushTable();
  return blocks;
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/org/me')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <main className="mx-auto max-w-4xl px-6 py-16 text-sm text-red-500">{error}</main>;
  if (!data) return <main className="mx-auto max-w-4xl px-6 py-16 text-sm text-ink-400">Loading dashboard…</main>;

  const { org, usage } = data;

  const stats = [
    { label: 'Messages this month', value: `${usage.messagesThisMonth} / ${usage.messageQuota ?? 100}` },
    { label: 'Bookings this month', value: usage.bookingsThisMonth },
    { label: 'Total leads', value: usage.totalLeads },
    { label: 'Knowledge docs', value: usage.documents },
  ];

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <p className="eyebrow mb-1">{org.industry || 'Business'} · Free plan</p>
      <h1 className="mb-10 text-3xl font-semibold tracking-tight text-ink-900">{org.name}</h1>

      {/* Stats */}
      <div className="mb-12 grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="glass-hover p-5">
            <div className="text-[26px] font-semibold tracking-tight text-ink-900">{s.value}</div>
            <div className="mt-1 text-xs text-ink-400">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <TestChat orgId={org.id} />
        <InstallSection orgId={org.id} />
      </div>
    </main>
  );
}

function TestChat({ orgId }) {
  const [messages, setMessages] = useState([{ who: 'bot', text: 'Hi! Try asking me about this business.' }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, { who: 'user', text }]);
    setBusy(true);
    try {
      const res = await fetchApi('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, sessionId: 'dashboard-test', message: text }),
      });
      const data = await res.json();
      setMessages((m) => [...m, { who: 'bot', text: data.reply || data.error || 'Error' }]);
    } catch {
      setMessages((m) => [...m, { who: 'bot', text: 'Connection error.' }]);
    }
    setBusy(false);
    setTimeout(() => boxRef.current?.scrollTo(0, boxRef.current.scrollHeight), 50);
  }

  return (
    <div className="quiet-card flex h-[480px] flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-white/70 px-5 py-3.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-[11px] font-semibold text-white">C</div>
        <span className="text-sm font-medium text-ink-900">Test your bot</span>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-emerald-600">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span> Live
        </span>
      </div>
      <div ref={boxRef} className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-4">
        {messages.map((m, i) => (
          <div key={i} className={`space-y-1 px-3.5 py-2.5 text-sm leading-relaxed ${
            m.who === 'user'
              ? 'max-w-[85%] self-end rounded-2xl rounded-br-md bg-gradient-to-br from-brand-600 to-brand-800 text-white shadow-lift'
              : 'max-w-[95%] self-start rounded-2xl rounded-bl-md border border-white/80 bg-white/80 text-ink-900 backdrop-blur'
          }`}>
            {m.who === 'bot' ? renderMarkdown(m.text) : <span className="whitespace-pre-wrap">{m.text}</span>}
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 self-start rounded-2xl border border-white/80 bg-white/80 px-4 py-3 backdrop-blur">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400" style={{ animationDelay: `${i * 150}ms` }}></span>
            ))}
          </div>
        )}
      </div>
      <form onSubmit={send} className="flex border-t border-white/70 bg-white/50">
        <input value={input} onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question…" className="flex-1 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-ink-400" />
        <button className="px-5 text-sm font-medium text-brand-600 transition-colors hover:text-brand-800">Send</button>
      </form>
    </div>
  );
}

function InstallSection({ orgId }) {
  const [copied, setCopied] = useState('');
  const backend = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
  const snippet = `<script src="${backend}/widget.js?org=${orgId}" defer></script>`;
  const botLink = `${backend}/bot/${orgId}`;

  function copy(text, what) {
    navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(''), 1500);
  }

  return (
    <div className="quiet-card space-y-6 p-6">
      <h2 className="text-sm font-medium text-ink-900">Install on your site</h2>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs text-ink-500">1 · Embed widget (any website)</span>
          <button onClick={() => copy(snippet, 'snippet')} className="text-xs font-medium text-brand-600 hover:text-brand-800">
            {copied === 'snippet' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-white/60 bg-gray-900/[0.05] p-3 text-xs leading-relaxed text-ink-700">{snippet}</pre>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs text-ink-500">2 · Direct chat link (QR codes, bio)</span>
          <button onClick={() => copy(botLink, 'link')} className="text-xs font-medium text-brand-600 hover:text-brand-800">
            {copied === 'link' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <pre className="overflow-x-auto break-all rounded-xl border border-white/60 bg-gray-900/[0.05] p-3 text-xs leading-relaxed text-ink-700">{botLink}</pre>
      </div>

      <p className="text-xs leading-relaxed text-ink-400">
        Tip: generate a QR code for the direct link to make a scan-to-chat card.
      </p>
    </div>
  );
}
