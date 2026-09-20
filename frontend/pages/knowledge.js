import { useState, useEffect, useRef } from 'react';
import { api, fetchApi, getManagingOrg } from '../lib/supabaseClient';

/* Inline SVG icons (Lucide-style strokes) */
const Icon = ({ children }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-ink-900">
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
      const managing = getManagingOrg();
      const res = await fetchApi('/api/knowledge/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          ...(managing?.id ? { 'x-org-id': managing.id } : {}),
        },
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
    <main className="page-shell">
      {/* Page header */}
      <div className="mb-7 border-b border-gray-200 pb-7">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow mb-2">Training sources</p>
          <h1 className="h-display text-3xl sm:text-[34px]">Knowledge base</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-500">Upload, paste, or import the information your assistant should use when answering customers.</p>
        </div>
        <div className="workspace-steps">
          <span className="workspace-step">Dashboard</span>
          <span>›</span>
          <span className="workspace-step-active">Knowledge</span>
          <span>›</span>
          <span className="workspace-step">Engagement</span>
        </div>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight text-ink-900">Choose a training method</h2>
          <p className="mt-1 text-sm text-ink-500">Start with a website, file, or direct text source.</p>
        </div>
      </div>

      {/* Add sources */}
      <div className="mb-10 grid gap-4 lg:grid-cols-3">
        {/* Crawl */}
        <form onSubmit={crawl} className="action-card flex flex-col">
          <div className="action-icon"><GlobeIcon /></div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Website</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">Crawl a page and learn its content.</p>
          <div className="mt-auto space-y-2.5">
            <input name="url" required placeholder="https://yoursite.com" className={`${inputCls} !py-2 text-[13px]`} />
            <button disabled={busy} className="btn-primary w-full !py-2 text-xs">Crawl &amp; learn</button>
          </div>
        </form>

        {/* Upload */}
        <div className="action-card flex flex-col">
          <div className="action-icon"><FileIcon /></div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Upload file</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">PDF, TXT, MD or CSV (max 5MB).</p>
          <div className="mt-auto space-y-2.5">
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv" className="w-full text-xs text-ink-500 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-gray-300 file:bg-white file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-ink-700 hover:file:bg-gray-50" />
            <button onClick={upload} disabled={busy} className="btn-primary w-full !py-2 text-xs">Upload &amp; learn</button>
          </div>
        </div>

        {/* Manual */}
        <form onSubmit={addText} className="action-card flex flex-col">
          <div className="action-icon"><PenIcon /></div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Paste text</h3>
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
      </div>

      <div className="mb-10">
        <div className="mb-3 flex items-center justify-between border-b border-gray-200 pb-3">
          <h2 className="text-sm font-semibold text-ink-900">Connected source imports</h2>
          <span className="text-xs text-ink-400">Optional imports</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
        <form onSubmit={(e) => { e.target.kind.value = 'drive'; importUrl(e); }} className="action-card flex flex-col">
          <input type="hidden" name="kind" defaultValue="drive" />
          <div className="action-icon"><DriveIcon /></div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Google Drive</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">Import a shared file (TXT, MD, CSV or PDF).</p>
          <div className="mt-auto space-y-2.5">
            <input name="url" required placeholder="https://drive.google.com/file/d/…" className={`${inputCls} !py-2 text-[13px]`} />
            <button disabled={busy} className="btn-primary w-full !py-2 text-xs">Import &amp; learn</button>
          </div>
        </form>

        {/* Notion */}
        <form onSubmit={(e) => { e.target.kind.value = 'notion'; importUrl(e); }} className="action-card flex flex-col">
          <input type="hidden" name="kind" defaultValue="notion" />
          <div className="action-icon"><NotionIcon /></div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Notion</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">Import a page shared publicly (&quot;Share to web&quot;).</p>
          <div className="mt-auto space-y-2.5">
            <input name="url" required placeholder="https://notion.so/your-page" className={`${inputCls} !py-2 text-[13px]`} />
            <button disabled={busy} className="btn-primary w-full !py-2 text-xs">Import &amp; learn</button>
          </div>
        </form>
        </div>
      </div>

      {/* Document list */}
      <div className="mb-3 flex items-center justify-between border-b border-gray-200 pb-3">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight text-ink-900">Knowledge performance</h2>
          <p className="mt-1 text-xs text-ink-500">Review what the assistant can use when answering customers.</p>
        </div>
      </div>
      {docs.length === 0 ? (
        <div className="data-panel p-12 text-center">
          <p className="text-sm font-medium text-ink-700">No documents yet</p>
          <p className="mt-1 text-sm text-ink-400">Add your first source above to start teaching your bot.</p>
        </div>
      ) : (
        <div className="data-panel">
          <div className="data-head hidden sm:grid sm:grid-cols-[2fr_1fr_auto]">
            <span>Name</span>
            <span>Source</span>
            <span>Status</span>
          </div>
          <div className="divide-y divide-gray-100">
          {docs.map((d) => (
            <div key={d.id} className="grid gap-4 px-5 py-4 text-sm text-ink-700 transition-colors hover:bg-gray-50 sm:grid-cols-[2fr_1fr_auto] sm:items-center">
              <div className="min-w-0">
                <div className="truncate font-medium text-ink-900">{d.title}</div>
                <div className="mt-0.5 truncate text-xs text-ink-400">
                  {d.source_type} · {new Date(d.created_at).toLocaleDateString()}
                  {d.url ? ` · ${d.url}` : ''}
                </div>
              </div>
              <div className="text-xs text-ink-500">{d.source_type}</div>
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
        </div>
      )}
    </main>
  );
}
