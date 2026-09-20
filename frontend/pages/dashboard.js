import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import { api, fetchApi, getManagingOrg, setManagingOrg } from '../lib/supabaseClient';

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
  const router = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [copiedCard, setCopiedCard] = useState(null);
  const copyTimer = useRef(null);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  useEffect(() => {
    if (!router.isReady) return;
    // Agency "Manage as client": /dashboard?org=<client id> switches context
    const orgParam = router.query.org;
    if (typeof orgParam === 'string' && orgParam) setManagingOrg({ id: orgParam, name: null });
    api('/api/org/me')
      .then((d) => {
        // keep the client's name in the managing banner fresh
        const managing = getManagingOrg();
        if (managing?.id === d.org?.id && d.org?.name) setManagingOrg({ id: d.org.id, name: d.org.name });
        setData(d);
      })
      .catch((e) => setError(e.message));
  }, [router.isReady, router.query.org]);

  if (error) return <main className="mx-auto max-w-4xl px-6 py-16 text-sm text-red-500">{error}</main>;
  if (!data) return <main className="mx-auto max-w-4xl px-6 py-16 text-sm text-ink-400">Loading dashboard…</main>;

  const { org, usage } = data;

  // Share-and-operate cards: two of them copy install/link values on click.
  const backend = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
  const widgetSnippet = `<script src="${backend}/widget.js?org=${org.id}" defer></script>`;
  const chatLink = `${backend}/bot/${org.id}`;

  /** Clipboard with a fallback for non-secure contexts (http previews). */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }

  async function copyAction(item) {
    if (await copyText(item.copy)) {
      setCopiedCard(item.title);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedCard((c) => (c === item.title ? null : c)), 2000);
    }
  }

  // The free tier's allowance is one-time (lifetime), not monthly — so label it
  // against the all-time count rather than this month's, which never resets it.
  const freeAllowance = usage.messageQuotaPeriod === 'lifetime';
  const messagesUsed = freeAllowance ? usage.messagesTotal ?? usage.messagesThisMonth : usage.messagesThisMonth;

  const stats = [
    {
      label: freeAllowance ? 'Messages used (one-time)' : 'Messages this month',
      value: `${messagesUsed} / ${usage.messageQuota ?? 100}`,
    },
    { label: 'Bookings this month', value: usage.bookingsThisMonth },
    { label: 'Total leads', value: usage.totalLeads },
    { label: 'Knowledge docs', value: usage.documents },
  ];

  return (
    <main className="page-shell">
      <section className="workspace-top">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
        <div>
            <p className="eyebrow mb-2">{org.industry || 'Business'} · Free plan</p>
            <h1 className="h-display text-3xl sm:text-[34px]">{org.name}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-500">
              Manage the assistant, review usage, and install Chitra AI where customers already ask questions.
            </p>
        </div>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-5 text-[22px] font-semibold tracking-tight text-ink-900">Workspace performance</h2>
        <div className="data-panel">
          <div className="data-head grid-cols-[1.5fr_1fr_1fr]">
            <span>Name</span>
            <span>Usage</span>
            <span>Status</span>
          </div>
          <div className="divide-y divide-gray-100">
            {stats.map((s) => (
              <div key={s.label} className="data-row grid-cols-[1.5fr_1fr_1fr]">
                <span className="font-medium text-ink-900">{s.label}</span>
                <span>{s.value}</span>
                <span className="text-ink-500">Active</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <TestChat orgId={org.id} />
        <InstallSection orgId={org.id} />
      </section>

      <section className="mb-10">
        <h2 className="mb-5 text-[22px] font-semibold tracking-tight text-ink-900">Share and operate your assistant</h2>
        <div className="action-grid">
          {[
            { icon: 'AI', title: 'Test assistant', body: 'Preview how your bot answers before customers see it.' },
            { icon: 'KB', title: 'Train knowledge', body: `${usage.documents} source${usage.documents === 1 ? '' : 's'} available to the assistant.` },
            // The widget/link cards copy their value on click — same values as
            // the Install panel below, one click less to get them.
            { icon: 'JS', title: 'Install widget', body: 'Add the assistant to your website with one script.', copy: widgetSnippet, copyName: 'embed snippet' },
            { icon: '↗', title: 'Share chat link', body: 'Use the direct link in QR codes, bios, and campaigns.', copy: chatLink, copyName: 'chat link' },
          ].map((item) => {
            const copied = copiedCard === item.title;
            const content = (
              <>
                <div className="action-icon">{copied ? '✓' : item.icon}</div>
                <h3 className="text-base font-semibold text-ink-900">{item.title}</h3>
                {copied ? (
                  <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-ink-900">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    Copied to clipboard
                  </p>
                ) : (
                  <p className="mt-2 text-sm leading-6 text-ink-500">{item.body}</p>
                )}
              </>
            );

            if (!item.copy) {
              return (
                <div key={item.title} className="action-card">
                  {content}
                </div>
              );
            }

            return (
              <button
                key={item.title}
                type="button"
                aria-label={`Copy ${item.copyName} to clipboard`}
                onClick={() => copyAction(item)}
                className={`action-card action-card-clickable ${copied ? 'action-card-copied' : ''}`}
              >
                {content}
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function TestChat({ orgId }) {
  const [messages, setMessages] = useState([{ who: 'bot', text: 'Hi! Try asking me about this business.' }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);
  const sessRef = useRef(null); // { id, token } — server-issued, never client-made

  // Sessions come from the server (bound to this org via an HMAC token), so
  // test chats are isolated per admin session — never a shared fixed id.
  async function ensureSession() {
    if (sessRef.current) return sessRef.current;
    const res = await fetchApi('/api/chat/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId }),
    });
    if (!res.ok) throw new Error('session');
    const s = await res.json();
    sessRef.current = { id: s.sessionId, token: s.sessionToken };
    return sessRef.current;
  }

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, { who: 'user', text }]);
    setBusy(true);
    try {
      let s = await ensureSession();
      let res = await fetchApi('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, sessionId: s.id, sessionToken: s.token, message: text }),
      });
      if (res.status === 403) {
        sessRef.current = null;
        s = await ensureSession();
        res = await fetchApi('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId, sessionId: s.id, sessionToken: s.token, message: text }),
        });
      }
      const data = await res.json();
      setMessages((m) => [...m, { who: 'bot', text: data.reply || data.error || 'Error' }]);
    } catch {
      setMessages((m) => [...m, { who: 'bot', text: 'Connection error.' }]);
    }
    setBusy(false);
    setTimeout(() => boxRef.current?.scrollTo(0, boxRef.current.scrollHeight), 50);
  }

  return (
    <div className="flex h-[500px] flex-col overflow-hidden rounded-md border border-gray-200 bg-white">
      <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-5 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gray-100 text-[11px] font-semibold text-ink-900">AI</div>
        <div>
          <span className="block text-sm font-semibold text-ink-900">Test your bot</span>
          <span className="text-xs text-ink-400">Private admin preview</span>
        </div>
        <span className="ml-auto flex items-center gap-1 rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span> Live
        </span>
      </div>
      <div ref={boxRef} className="flex flex-1 flex-col gap-2.5 overflow-y-auto bg-white p-4">
        {messages.map((m, i) => (
          <div key={i} className={`space-y-1 px-3.5 py-2.5 text-sm leading-relaxed ${
            m.who === 'user'
              ? 'max-w-[85%] self-end rounded-md bg-ink-900 text-white'
              : 'max-w-[95%] self-start rounded-md bg-gray-50 text-ink-900'
          }`}>
            {m.who === 'bot' ? renderMarkdown(m.text) : <span className="whitespace-pre-wrap">{m.text}</span>}
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 self-start rounded-md bg-gray-50 px-4 py-3">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400" style={{ animationDelay: `${i * 150}ms` }}></span>
            ))}
          </div>
        )}
      </div>
      <form onSubmit={send} className="flex border-t border-gray-200 bg-white">
        <input value={input} onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question…" className="flex-1 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-ink-400" />
        <button className="px-5 text-sm font-semibold text-ink-900 transition-colors hover:text-black">Send</button>
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
    <div className="space-y-6 rounded-md border border-gray-200 bg-white p-6">
      <div>
        <p className="eyebrow mb-2">Distribution</p>
        <h2 className="h-display text-xl">Add to your site</h2>
        <p className="mt-1 text-sm leading-6 text-ink-500">Embed Chitra on your site or share your chat link with customers.</p>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-ink-500">Embed widget</span>
          <button onClick={() => copy(snippet, 'snippet')} className="text-xs font-semibold text-ink-900 hover:text-black">
            {copied === 'snippet' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-gray-50 p-3 text-xs leading-relaxed text-ink-700">{snippet}</pre>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-ink-500">Direct chat link</span>
          <button onClick={() => copy(botLink, 'link')} className="text-xs font-semibold text-ink-900 hover:text-black">
            {copied === 'link' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <pre className="overflow-x-auto break-all rounded-md bg-gray-50 p-3 text-xs leading-relaxed text-ink-700">{botLink}</pre>
      </div>

      <p className="rounded-md bg-gray-50 px-3.5 py-3 text-xs leading-relaxed text-ink-500">
        Tip: generate a QR code for the direct link to make a scan-to-chat card.
      </p>
    </div>
  );
}
