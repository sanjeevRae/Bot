import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/supabaseClient';

/* Inline SVG icons (Lucide-style strokes) */
const Icon = ({ children }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-brand-600">
    {children}
  </svg>
);
const GlobeIcon = () => (<Icon><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></Icon>);
const FileIcon = () => (<Icon><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></Icon>);
const PenIcon = () => (<Icon><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /></Icon>);
const DriveIcon = () => (<Icon><path d="M12 2 2 19h20L12 2Z" /><path d="M12 8v6" /><path d="M12 17h.01" /></Icon>);
const NotionIcon = () => (<Icon><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M8 8v8" /><path d="m8 8 8 8" /><path d="M16 8v8" /></Icon>);

export default function Knowledge() {
  const [docs, setDocs] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState({ title: '', body: '' });
  const fileRef = useRef(null);

  async function load() {
    try {
      const data = await api('/api/knowledge');
      setDocs(data.documents || []);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function crawl(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/api/knowledge/crawl', { method: 'POST', body: JSON.stringify({ url: e.target.url.value }) });
      e.target.reset();
      load();
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  async function addText(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/api/knowledge/text', { method: 'POST', body: JSON.stringify(text) });
      setText({ title: '', body: '' });
      load();
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data: { session } } = await import('../lib/supabaseClient').then(m => m.supabase.auth.getSession());
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'}/api/knowledge/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  async function remove(id) {
    if (!confirm('Delete this document?')) return;
    await api(`/api/knowledge/${id}`, { method: 'DELETE' });
    load();
  }

  async function importUrl(e) {
    e.preventDefault();
    setBusy(true); setError('');
    const kind = new FormData(e.target).get('kind');
    try {
      await api(`/api/knowledge/${kind}`, { method: 'POST', body: JSON.stringify({ url: e.target.url.value }) });
      e.target.reset();
      load();
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  const inputCls = 'input-base';

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-6 sm:py-12">
      {/* Page header */}
      <div className="mb-8 flex flex-col justify-between gap-4 border-b border-gray-200 pb-6 sm:flex-row sm:items-end">
        <div>
          <h1 className="h-display text-2xl sm:text-[28px]">Knowledge base</h1>
          <p className="mt-1 text-sm text-ink-500">Everything here teaches your bot what to say.</p>
        </div>
        <span className="chip w-fit">{docs.length} document{docs.length === 1 ? '' : 's'}</span>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {/* Add sources */}
      <div className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Crawl */}
        <form onSubmit={crawl} className="card flex flex-col p-5 transition-colors duration-150 hover:border-gray-300">
          <div className="mb-3.5 flex h-9 w-9 items-center justify-center rounded-lg border border-brand-100 bg-brand-50"><GlobeIcon /></div>
          <h3 className="mb-0.5 text-sm font-semibold text-ink-900">Website</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">Crawl a page and learn its content.</p>
          <div className="mt-auto space-y-2.5">
            <input name="url" required placeholder="https://yoursite.com" className={`${inputCls} !py-2 text-[13px]`} />
            <button disabled={busy} className="btn-primary w-full !py-2 text-xs">Crawl &amp; learn</button>
          </div>
        </form>

        {/* Upload */}
        <div className="card flex flex-col p-5 transition-colors duration-150 hover:border-gray-300">
          <div className="mb-3.5 flex h-9 w-9 items-center justify-center rounded-lg border border-brand-100 bg-brand-50"><FileIcon /></div>
          <h3 className="mb-0.5 text-sm font-semibold text-ink-900">Upload file</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">PDF, TXT, MD or CSV (max 5MB).</p>
          <div className="mt-auto space-y-2.5">
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv" className="w-full text-xs text-ink-500 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-gray-300 file:bg-white file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-ink-700 hover:file:bg-gray-50" />
            <button onClick={upload} disabled={busy} className="btn-primary w-full !py-2 text-xs">Upload &amp; learn</button>
          </div>
        </div>

        {/* Manual */}
        <form onSubmit={addText} className="card flex flex-col p-5 transition-colors duration-150 hover:border-gray-300">
          <div className="mb-3.5 flex h-9 w-9 items-center justify-center rounded-lg border border-brand-100 bg-brand-50"><PenIcon /></div>
          <h3 className="mb-0.5 text-sm font-semibold text-ink-900">Paste text</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">FAQs, hours, services — anything.</p>
          <div className="mt-auto space-y-2.5">
            <input placeholder="Title" value={text.title} onChange={(e) => setText({ ...text, title: e.target.value })}
              className={`${inputCls} !py-2 text-[13px]`} />
            <textarea rows={3} placeholder="Paste FAQs or info…" value={text.body}
              onChange={(e) => setText({ ...text, body: e.target.value })} className={`${inputCls} resize-none !py-2 text-[13px]`} />
            <button disabled={busy || !text.body} className="btn-primary w-full !py-2 text-xs">Save &amp; learn</button>
          </div>
        </form>

        {/* Google Drive */}
        <form onSubmit={(e) => { e.target.kind.value = 'drive'; importUrl(e); }} className="card flex flex-col p-5 transition-colors duration-150 hover:border-gray-300">
          <input type="hidden" name="kind" defaultValue="drive" />
          <div className="mb-3.5 flex h-9 w-9 items-center justify-center rounded-lg border border-brand-100 bg-brand-50"><DriveIcon /></div>
          <h3 className="mb-0.5 text-sm font-semibold text-ink-900">Google Drive</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">Import a shared file (TXT, MD, CSV or PDF).</p>
          <div className="mt-auto space-y-2.5">
            <input name="url" required placeholder="https://drive.google.com/file/d/…" className={`${inputCls} !py-2 text-[13px]`} />
            <button disabled={busy} className="btn-primary w-full !py-2 text-xs">Import &amp; learn</button>
          </div>
        </form>

        {/* Notion */}
        <form onSubmit={(e) => { e.target.kind.value = 'notion'; importUrl(e); }} className="card flex flex-col p-5 transition-colors duration-150 hover:border-gray-300">
          <input type="hidden" name="kind" defaultValue="notion" />
          <div className="mb-3.5 flex h-9 w-9 items-center justify-center rounded-lg border border-brand-100 bg-brand-50"><NotionIcon /></div>
          <h3 className="mb-0.5 text-sm font-semibold text-ink-900">Notion</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">Import a page shared publicly (&quot;Share to web&quot;).</p>
          <div className="mt-auto space-y-2.5">
            <input name="url" required placeholder="https://notion.so/your-page" className={`${inputCls} !py-2 text-[13px]`} />
            <button disabled={busy} className="btn-primary w-full !py-2 text-xs">Import &amp; learn</button>
          </div>
        </form>
      </div>

      {/* Document list */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-900">Your documents</h2>
      </div>
      {docs.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-sm font-medium text-ink-700">No documents yet</p>
          <p className="mt-1 text-sm text-ink-400">Add your first source above to start teaching your bot.</p>
        </div>
      ) : (
        <div className="card divide-y divide-gray-100 overflow-hidden">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-gray-50">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-ink-900">{d.title}</div>
                <div className="mt-0.5 truncate text-xs text-ink-400">
                  {d.source_type} · {new Date(d.created_at).toLocaleDateString()}
                  {d.url ? ` · ${d.url}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className={
                  d.status === 'ready' ? 'chip-success' :
                  d.status === 'failed' ? 'inline-flex items-center rounded-full border border-red-100 bg-red-50 px-2.5 py-0.5 text-[11px] font-medium text-red-600' :
                  'chip-warning'
                }>{d.status}</span>
                <button
                  onClick={() => remove(d.id)}
                  aria-label={`Delete ${d.title}`}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-lg leading-none text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                >×</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
