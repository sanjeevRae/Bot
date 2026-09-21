import { useState, useEffect, useRef } from 'react';
import { api, fetchApi, getManagingOrg, clearApiCache } from '../lib/supabaseClient';

/**
 * Knowledge base (V10).
 *
 * Three jobs, in the order a merchant actually needs them:
 *   1. Add sources — website, files (Word/Excel/PowerPoint/PDF/CSV), pasted text,
 *      business facts & prices, menu photos (OCR), voice notes, YouTube, Drive, Notion.
 *   2. Curate — rename, pause a source without deleting it, preview the chunks the
 *      bot will actually read, re-sync a website.
 *   3. Verify — "ask your knowledge" shows exactly what the assistant retrieves,
 *      with the source it came from and how long retrieval took.
 */

/* Inline SVG icons (Lucide-style strokes) */
const Icon = ({ children, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-ink-900">
    {children}
  </svg>
);
const GlobeIcon = () => (<Icon><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></Icon>);
const FileIcon = () => (<Icon><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></Icon>);
const PenIcon = () => (<Icon><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /></Icon>);
const DriveIcon = () => (<Icon><path d="M12 2 2 19h20L12 2Z" /><path d="M12 8v6" /><path d="M12 17h.01" /></Icon>);
const NotionIcon = () => (<Icon><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M8 8v8" /><path d="m8 8 8 8" /><path d="M16 8v8" /></Icon>);
const ListIcon = () => (<Icon><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></Icon>);
const VideoIcon = () => (<Icon><path d="m22 8-6 4 6 4V8Z" /><rect width="14" height="12" x="2" y="6" rx="2" /></Icon>);
const PhotoIcon = () => (<Icon><rect width="18" height="18" x="3" y="3" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></Icon>);
const MicIcon = () => (<Icon><path d="M12 19v3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><rect width="6" height="13" x="9" y="2" rx="3" /></Icon>);
const SearchIcon = () => (<Icon size={16}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Icon>);
const RefreshIcon = () => (<Icon size={15}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></Icon>);
const PauseIcon = () => (<Icon size={15}><rect width="4" height="16" x="6" y="4" rx="1" /><rect width="4" height="16" x="14" y="4" rx="1" /></Icon>);
const PlayIcon = () => (<Icon size={15}><path d="m6 3 14 9-14 9V3Z" /></Icon>);
const EyeIcon = () => (<Icon size={15}><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" /></Icon>);
const TrashIcon = () => (<Icon size={15}><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></Icon>);
const PlusIcon = () => (<Icon size={15}><path d="M5 12h14" /><path d="M12 5v14" /></Icon>);
const CloseIcon = () => (<Icon size={15}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>);

/** Upload accept list — keep in step with backend services/extract.js */
const ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.log,' +
  '.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.mp3,.m4a,.wav,.ogg,.oga,.webm,.flac,.aac,.opus';

const FILE_HINTS = [
  'PDF', 'Word (.docx)', 'Excel (.xlsx)', 'PowerPoint (.pptx)', 'TXT / MD / CSV',
  'menu or price photo', 'voice note',
];

const FACT_FIELDS = [
  { key: 'business_name', label: 'Business name', placeholder: 'Chitra Coffee House' },
  { key: 'category', label: 'Type of business', placeholder: 'Café / restaurant' },
  { key: 'phone', label: 'Phone', placeholder: '+977 98…' },
  { key: 'whatsapp', label: 'WhatsApp', placeholder: 'Same as phone, or another number' },
  { key: 'email', label: 'Email', placeholder: 'hello@business.com' },
  { key: 'address', label: 'Address', placeholder: 'Street, area, city' },
  { key: 'map_url', label: 'Map link', placeholder: 'Google Maps link' },
  { key: 'website', label: 'Website', placeholder: 'https://…' },
  { key: 'booking_url', label: 'Booking link', placeholder: 'Cal.com / booking page' },
  { key: 'payment_methods', label: 'Payment methods', placeholder: 'Cash, eSewa, Khalti, card' },
  { key: 'delivery', label: 'Delivery', placeholder: 'Available inside Ring Road' },
  { key: 'delivery_fee', label: 'Delivery fee', placeholder: 'Rs. 80' },
  { key: 'coverage', label: 'Service area', placeholder: 'Kathmandu, Lalitpur, Bhaktapur' },
  { key: 'return_policy', label: 'Return / refund policy', placeholder: 'Exchange within 7 days with receipt' },
  { key: 'cancellation_policy', label: 'Cancellation policy', placeholder: 'Free until 2 hours before' },
  { key: 'languages', label: 'Languages spoken', placeholder: 'Nepali, English, Newari' },
];

const HOUR_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const EMPTY_HOURS = HOUR_DAYS.reduce((acc, d) => ({ ...acc, [d]: '' }), {});
const emptyFacts = () => ({ title: '', ...FACT_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: '' }), {}) });

const MAX_UPLOAD_FILES = 8;

/** POST a batch of files (multipart, so it needs the raw fetch helper). */
async function uploadFiles(token, managing, files) {
  const fd = new FormData();
  for (const file of files) fd.append('file', file);
  const res = await fetchApi('/api/knowledge/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(managing?.id ? { 'x-org-id': managing.id } : {}),
    },
    body: fd,
  });
  return res.json();
}

/** "12 Aug" / "2 days ago" — compact enough for a dense table cell. */
function syncedLabel(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  if (mins < 60 * 24 * 30) return `${Math.round(mins / 1440)}d ago`;
  return then.toLocaleDateString();
}

/* ---------- Saved chime (Web Audio — no asset, no dependency) ---------- */
let audioCtx = null;

/** Warm up the AudioContext inside a user gesture so later playback is allowed. */
function primeAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* sound is a nicety — never break the flow */ }
}

/** Short two-tone chime (E5 → B5) played when "Save & learn" finishes. */
function playSavedChime() {
  try {
    if (!audioCtx || audioCtx.state !== 'running') return;
    [659.25, 987.77].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = audioCtx.currentTime + i * 0.11;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.55);
    });
  } catch { /* sound is a nicety — never break the flow */ }
}

export default function Knowledge() {
  const [docs, setDocs] = useState([]);
  const [quota, setQuota] = useState(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [migrationPending, setMigrationPending] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null); // { message, key } — floating "saved" notification
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [rowBusy, setRowBusy] = useState(null);
  const [text, setText] = useState({ title: '', body: '' });
  const [factsOpen, setFactsOpen] = useState(false);
  const [factsClosing, setFactsClosing] = useState(false);
  const [facts, setFacts] = useState(emptyFacts);
  const [hours, setHours] = useState(EMPTY_HOURS);
  const [services, setServices] = useState([]);
  const [faqs, setFaqs] = useState([]);
  const [extraRows, setExtraRows] = useState([]);
  const [extraText, setExtraText] = useState('');
  const [templates, setTemplates] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const fileRef = useRef(null);
  const toastTimer = useRef(null);

  async function load() {
    try {
      const data = await api('/api/knowledge');
      setDocs(data.documents || []);
      setQuota(data.quota || null);
      setAudioEnabled(data.audioEnabled !== false);
      setMigrationPending(Boolean(data.migrationPending));
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
    api('/api/knowledge/structured')
      .then((d) => setTemplates(d.templates || {}))
      .catch(() => {});
  }, []);

  /** Floating success notification (bottom-right, auto-dismisses). */
  function showToast(message) {
    clearTimeout(toastTimer.current);
    setToast({ message, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }

  /** Animate the facts modal out, then unmount it. */
  function closeFacts() {
    if (factsClosing) return;
    setFactsClosing(true);
    setTimeout(() => {
      setFactsOpen(false);
      setFactsClosing(false);
    }, 170);
  }

  // Escape closes the facts modal; the page behind it must not scroll.
  useEffect(() => {
    if (!factsOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeFacts(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [factsOpen]);

  /** One busy flag for the whole page, with the action named while it runs. */
  async function run(label, fn) {
    setBusy(true);
    setBusyLabel(label);
    setError('');
    try {
      return await fn();
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  }

  async function runRow(id, fn) {
    setRowBusy(id);
    setError('');
    try {
      return await fn();
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setRowBusy(null);
    }
  }

  // ---------------------------------------------------------------- add sources
  async function crawl(e) {
    e.preventDefault();
    const form = e.target;
    const url = form.url.value;
    await run('Crawling your website…', async () => {
      const result = await api('/api/knowledge/crawl', { method: 'POST', body: JSON.stringify({ url }) });
      form.reset();
      await load();
      showToast(`Learned ${result.chunks} chunks from ${result.pagesCrawled || 1} page(s).`);
    });
  }

  async function addText(e) {
    e.preventDefault();
    await run('Saving your notes…', async () => {
      const result = await api('/api/knowledge/text', { method: 'POST', body: JSON.stringify(text) });
      setText({ title: '', body: '' });
      await load();
      playSavedChime();
      showToast(`Saved ${result.chunks} chunks.`);
    });
  }

  async function importUrl(e) {
    e.preventDefault();
    const form = e.target;
    const kind = new FormData(form).get('kind');
    const url = form.url.value;
    await run('Importing…', async () => {
      const result = await api(`/api/knowledge/${kind}`, { method: 'POST', body: JSON.stringify({ url }) });
      form.reset();
      await load();
      showToast(kind === 'youtube' ? `Learned "${result.videoTitle}" (${result.chunks} chunks).` : `Imported ${result.chunks} chunks.`);
    });
  }

  async function upload(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    if (files.length > MAX_UPLOAD_FILES) {
      setError(`Upload up to ${MAX_UPLOAD_FILES} files at a time.`);
      return;
    }

    await run(`Reading ${files.length} file${files.length > 1 ? 's' : ''}…`, async () => {
      const { supabase } = await import('../lib/supabaseClient');
      const { data: { session } } = await supabase.auth.getSession();
      const data = await uploadFiles(session.access_token, getManagingOrg(), files);
      // uploadFiles uses the raw helper (it must not JSON-encode a FormData
      // body), so clear the GET cache by hand — otherwise the list below would
      // be served from the 30 s cache and the new sources would not appear.
      clearApiCache();

      if (fileRef.current) fileRef.current.value = '';
      await load();

      const failed = (data.results || []).filter((r) => !r.ok);
      if (failed.length) {
        // Partial success: say exactly which file failed and why.
        setError(`${failed.length} of ${files.length} file(s) could not be read — ${failed[0].file}: ${failed[0].error}`);
      } else if (data.ok) {
        showToast(`${data.added} file${data.added > 1 ? 's' : ''} learned.`);
      } else {
        setError(data.error || 'Upload failed');
      }
    });
  }

  // ------------------------------------------------------- business facts form
  const setFact = (key, value) => setFacts((f) => ({ ...f, [key]: value }));
  const setHour = (day, value) => setHours((h) => ({ ...h, [day]: value }));

  /** Immutable row updater for the repeating services / FAQ / custom-fact lists. */
  const patchRows = (setter) => (index, patch) =>
    setter((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const setServiceRow = patchRows(setServices);
  const setFaqRow = patchRows(setFaqs);
  const setExtraRow = patchRows(setExtraRows);

  /** Copy an industry starter set into the form — the merchant edits their own. */
  function applyTemplate(key) {
    const template = templates[key];
    if (!template) return;
    setFacts((f) => ({ ...f, ...(template.facts || {}), title: f.title || `${template.label} details` }));
    if (Array.isArray(template.services)) setServices(template.services.map((s) => ({ ...s })));
    if (Array.isArray(template.faqs)) setFaqs(template.faqs.map((q) => ({ ...q })));
  }

  async function saveFacts(e) {
    e.preventDefault();
    primeAudio(); // user gesture — unlock the AudioContext for the saved chime
    const payload = {
      ...facts,
      title: facts.title || 'Business details',
      hours,
      services: services.filter((s) => (s.name || '').trim()),
      faqs: faqs.filter((q) => (q.question || '').trim() && (q.answer || '').trim()),
      facts: extraRows.filter((r) => (r.label || '').trim() && (r.value || '').trim()),
      extra_text: extraText,
    };

    await run('Saving business details…', async () => {
      const result = await api('/api/knowledge/structured', { method: 'POST', body: JSON.stringify(payload) });
      window.dispatchEvent(new CustomEvent('chitra-managing-changed'));
      await load();
      playSavedChime();
      showToast(`Business details saved — ${result.chunks} chunk${result.chunks === 1 ? '' : 's'} learned.`);
      setFacts(emptyFacts());
      setHours(EMPTY_HOURS);
      setServices([]);
      setFaqs([]);
      setExtraRows([]);
      setExtraText('');
      closeFacts();
    });
  }

  // ----------------------------------------------------------- curate sources
  async function toggleActive(doc) {
    await runRow(doc.id, async () => {
      const data = await api(`/api/knowledge/${doc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !doc.is_active }),
      });
      setDocs((list) => list.map((d) => (d.id === doc.id ? { ...d, ...data.document } : d)));
      showToast(data.document.is_active
        ? `"${doc.title}" is answering questions again.`
        : `"${doc.title}" is paused — it stays saved but is no longer used.`);
    });
  }

  async function rename(doc) {
    const next = window.prompt('Rename this source', doc.title);
    if (next === null || !next.trim() || next.trim() === doc.title) return;
    await runRow(doc.id, async () => {
      const data = await api(`/api/knowledge/${doc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: next.trim() }),
      });
      setDocs((list) => list.map((d) => (d.id === doc.id ? { ...d, ...data.document } : d)));
    });
  }

  async function resync(doc) {
    if (!window.confirm(`Re-crawl ${doc.url} and replace this source?`)) return;
    await runRow(doc.id, async () => {
      const result = await api('/api/knowledge/refresh', {
        method: 'POST',
        body: JSON.stringify({ id: doc.id }),
      });
      await load();
      showToast(`Re-synced from ${result.pagesCrawled || 1} page(s) — ${result.chunks} chunks.`);
    });
  }

  async function remove(doc) {
    if (!window.confirm(`Delete "${doc.title}"? The bot forgets it immediately.`)) return;
    await runRow(doc.id, async () => {
      await api(`/api/knowledge/${doc.id}`, { method: 'DELETE' });
      await load();
      showToast(`Deleted "${doc.title}".`);
    });
  }

  /** Show the exact chunks retrieval will read for a source. */
  async function openPreview(doc) {
    setPreviewBusy(true);
    setError('');
    try {
      const data = await api(`/api/knowledge/sections/${doc.id}`);
      setPreview(data);
    } catch (err) {
      setError(err.message);
    }
    setPreviewBusy(false);
  }

  // ------------------------------------------------------------------- verify
  async function runSearch(e) {
    e?.preventDefault();
    if (searchQuery.trim().length < 2) return;
    setSearching(true);
    setError('');
    try {
      setSearchResult(await api('/api/knowledge/search', {
        method: 'POST',
        body: JSON.stringify({ query: searchQuery.trim() }),
      }));
    } catch (err) {
      setError(err.message);
    }
    setSearching(false);
  }

  const inputCls = 'input-base';

  return (
    <main className="page-shell">
      {/* Page header */}
      <div className="mb-7 border-b border-gray-200 pb-7">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p className="eyebrow mb-2">Training sources</p>
            <h1 className="h-display text-3xl sm:text-[34px]">Knowledge base</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-500">
              Teach your assistant from your website, files, price lists, photos, voice notes and videos —
              then check exactly what it retrieves before a customer asks.
            </p>
          </div>
          {quota && (
            <div className="shrink-0 rounded-xl border border-gray-200 bg-white px-4 py-3">
              <div className="flex items-center justify-between gap-6 text-[11px] font-medium uppercase tracking-wide text-ink-400">
                <span>Documents</span>
                <span className="text-ink-700">{quota.documents.used} / {quota.documents.limit}</span>
              </div>
              <div className="mt-2 h-1.5 w-40 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-ink-900 transition-all"
                  style={{ width: `${Math.min(100, (quota.documents.used / Math.max(1, quota.documents.limit)) * 100)}%` }}
                />
              </div>
              <div className="mt-2 text-[11px] text-ink-400">{quota.chunks.used} chunks searchable</div>
            </div>
          )}
        </div>
      </div>

      {migrationPending && (
        <div className="mb-6 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-700">
          Run <span className="font-medium">backend/supabase/migration_v10_knowledge.sql</span> in Supabase to enable
          pausing sources, chunk previews and the new file types.
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}
      {busy && (
        <div className="mb-4 flex items-center gap-2 text-xs text-ink-500">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-ink-900" />
          {busyLabel || 'Working…'}
        </div>
      )}

      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight text-ink-900">Choose a training method</h2>
          <p className="mt-1 text-sm text-ink-500">Facts you type in beat a crawl — start with what customers always ask.</p>
        </div>
      </div>

      {/* Add sources */}
      <div className="mb-10 grid gap-4 lg:grid-cols-3">
        {/* Business facts — the highest-accuracy source, so it leads the grid */}
        <div className="action-card flex flex-col">
          <div className="action-icon"><ListIcon /></div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Business facts &amp; prices</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">
            Hours, phone, delivery fee, services with prices, and the questions customers always ask.
            What you type is quoted exactly.
          </p>
          <div className="mt-auto space-y-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => { primeAudio(); setFactsOpen(true); }}
              className="btn-primary w-full !py-2 text-xs"
            >
              Add business facts
            </button>
            <p className="text-[11px] leading-relaxed text-ink-400">
              Opens a form — accurate hours, fees and prices even if your website is out of date.
            </p>
          </div>
        </div>

        {/* Crawl */}
        <form onSubmit={crawl} className="action-card flex flex-col">
          <div className="action-icon"><GlobeIcon /></div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Website</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">
            Crawl your site and learn every page — sitemap-aware, so services and prices are picked up.
          </p>
          <div className="mt-auto space-y-2.5">
            <input name="url" required placeholder="https://yoursite.com" className={`${inputCls} !py-2 text-[13px]`} />
            <button disabled={busy} className="btn-primary w-full !py-2 text-xs">Crawl &amp; learn</button>
          </div>
        </form>

        {/* Upload — files, photos and voice notes */}
        <div className="action-card flex flex-col">
          <div className="action-icon"><FileIcon /></div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Upload files &amp; photos</h3>
          <p className="mb-3 text-xs leading-relaxed text-ink-500">Drop up to {MAX_UPLOAD_FILES} at once.</p>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files); }}
            onClick={() => fileRef.current?.click()}
            className="cursor-pointer rounded-lg border border-dashed border-gray-300 bg-gray-50/60 px-3 py-4 text-center text-[11px] leading-relaxed text-ink-500 transition-colors hover:border-ink-900/30 hover:bg-gray-50"
          >
            Drag files here or click to browse
          </div>
          <input ref={fileRef} type="file" multiple accept={ACCEPT} onChange={(e) => upload(e.target.files)} className="hidden" />
          <div className="mt-auto space-y-2.5 pt-3">
            <div className="flex flex-wrap gap-1">
              {FILE_HINTS.map((hint) => (
                <span key={hint} className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[10px] text-ink-500">{hint}</span>
              ))}
            </div>
            {!audioEnabled && <p className="text-[11px] text-ink-400">Voice notes need a Groq key on the server.</p>}
          </div>
        </div>

        {/* Paste text */}
        <form onSubmit={addText} className="action-card flex flex-col">
          <div className="action-icon"><PenIcon /></div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Paste text</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">FAQs, hours, policies — anything you can copy.</p>
          <div className="mt-auto space-y-2.5">
            <input placeholder="Title" value={text.title} onChange={(e) => setText({ ...text, title: e.target.value })}
              className={`${inputCls} !py-2 text-[13px]`} />
            <textarea rows={3} placeholder="Paste FAQs or info…" value={text.body}
              onChange={(e) => setText({ ...text, body: e.target.value })} className={`${inputCls} resize-none !py-2 text-[13px]`} />
            <button disabled={busy || !text.body} className="btn-primary w-full !py-2 text-xs">Save &amp; learn</button>
          </div>
        </form>

        {/* YouTube transcript */}
        <form onSubmit={(e) => { e.target.kind.value = 'youtube'; importUrl(e); }} className="action-card flex flex-col">
          <input type="hidden" name="kind" defaultValue="youtube" />
          <div className="action-icon"><VideoIcon /></div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">YouTube video</h3>
          <p className="mb-4 text-xs leading-relaxed text-ink-500">
            Learn from a video&apos;s captions — demos, walkthroughs, price explanations.
          </p>
          <div className="mt-auto space-y-2.5">
            <input name="url" required placeholder="https://youtube.com/watch?v=…" className={`${inputCls} !py-2 text-[13px]`} />
            <button disabled={busy} className="btn-primary w-full !py-2 text-xs">Learn transcript</button>
          </div>
        </form>
      </div>

      {/* Business facts modal */}
      {factsOpen && (
        <div
          onClick={factsClosing ? undefined : closeFacts}
          className={`modal-overlay fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6 ${
            factsClosing ? 'animate-[overlay-fade-out_.17s_ease-in_forwards]' : 'animate-[overlay-fade-in_.18s_ease-out]'
          }`}
        >
        <form
          onSubmit={saveFacts}
          onClick={(e) => e.stopPropagation()}
          className={`modal-panel card flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl shadow-xl sm:rounded-2xl ${
            factsClosing ? 'animate-[modal-pop-out_.17s_ease-in_forwards]' : 'animate-[modal-pop-in_.22s_cubic-bezier(0.16,1,0.3,1)]'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-ink-900">Business facts &amp; prices</h2>
              <p className="mt-1 text-xs text-ink-500">Only the fields you fill in are learned. Add rows as you need them.</p>
            </div>
            <div className="flex items-end gap-3">
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-ink-500">Start from a template</label>
                <select
                  defaultValue=""
                  onChange={(e) => { applyTemplate(e.target.value); e.target.value = ''; }}
                  className={`${inputCls} !py-2 text-[13px]`}
                >
                  <option value="">Choose your type of business…</option>
                  {Object.entries(templates).map(([key, t]) => (
                    <option key={key} value={key}>{t.label}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={closeFacts}
                aria-label="Close business facts"
                className="flex h-9 w-9 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-gray-100 hover:text-ink-900"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Title</label>
              <input value={facts.title} onChange={(e) => setFact('title', e.target.value)}
                placeholder="Business details" className={`${inputCls} !py-2 text-[13px]`} />
            </div>
            {FACT_FIELDS.map((field) => (
              <div key={field.key}>
                <label className="mb-1.5 block text-[13px] font-medium text-ink-700">{field.label}</label>
                <input value={facts[field.key]} onChange={(e) => setFact(field.key, e.target.value)}
                  placeholder={field.placeholder} className={`${inputCls} !py-2 text-[13px]`} />
              </div>
            ))}
          </div>
          {/* Opening hours */}
          <div className="mt-7 border-t border-gray-200 pt-5">
            <h3 className="text-sm font-semibold text-ink-900">Opening hours</h3>
            <p className="mb-3 mt-1 text-xs text-ink-500">e.g. 9:00–18:00, or “Closed”. Leave a day empty to skip it.</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {HOUR_DAYS.map((day) => (
                <div key={day}>
                  <label className="mb-1.5 block text-[12px] font-medium capitalize text-ink-600">{day}</label>
                  <input value={hours[day]} onChange={(e) => setHour(day, e.target.value)}
                    placeholder="9:00–18:00" className={`${inputCls} !py-2 text-[13px]`} />
                </div>
              ))}
            </div>
          </div>
          {/* Services & prices */}
          <div className="mt-7 border-t border-gray-200 pt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">Services &amp; prices</h3>
                <p className="mt-1 text-xs text-ink-500">One line per item — the bot quotes these exactly.</p>
              </div>
              <button type="button" onClick={() => setServices((rows) => [...rows, { name: '', price: '', duration: '' }])}
                className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 text-xs">
                <PlusIcon /> Add item
              </button>
            </div>
            <div className="space-y-2">
              {services.length === 0 && <p className="text-xs text-ink-400">No items yet.</p>}
              {services.map((service, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
                  <input value={service.name || ''} onChange={(e) => setServiceRow(index, { name: e.target.value })}
                    placeholder="Service or product" className={`${inputCls} !py-2 text-[13px]`} />
                  <input value={service.price || ''} onChange={(e) => setServiceRow(index, { price: e.target.value })}
                    placeholder="Rs. 500" className={`${inputCls} !py-2 text-[13px]`} />
                  <input value={service.duration || ''} onChange={(e) => setServiceRow(index, { duration: e.target.value })}
                    placeholder="30 min" className={`${inputCls} !py-2 text-[13px]`} />
                  <button type="button" aria-label="Remove item"
                    onClick={() => setServices((rows) => rows.filter((_, i) => i !== index))}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-red-50 hover:text-red-500">
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
          </div>
          {/* FAQs */}
          <div className="mt-7 border-t border-gray-200 pt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">Questions customers ask</h3>
                <p className="mt-1 text-xs text-ink-500">Matched against the real questions your customers type.</p>
              </div>
              <button type="button" onClick={() => setFaqs((rows) => [...rows, { question: '', answer: '' }])}
                className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 text-xs">
                <PlusIcon /> Add question
              </button>
            </div>
            <div className="space-y-2">
              {faqs.length === 0 && <p className="text-xs text-ink-400">No questions yet.</p>}
              {faqs.map((faq, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[2fr_3fr_auto]">
                  <input value={faq.question || ''} onChange={(e) => setFaqRow(index, { question: e.target.value })}
                    placeholder="Do you deliver?" className={`${inputCls} !py-2 text-[13px]`} />
                  <input value={faq.answer || ''} onChange={(e) => setFaqRow(index, { answer: e.target.value })}
                    placeholder="Yes — inside Ring Road, Rs. 80" className={`${inputCls} !py-2 text-[13px]`} />
                  <button type="button" aria-label="Remove question"
                    onClick={() => setFaqs((rows) => rows.filter((_, i) => i !== index))}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-red-50 hover:text-red-500">
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
          </div>
          {/* Free-form details — for anything the fixed fields above do not cover */}
          <div className="mt-7 border-t border-gray-200 pt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">Anything else</h3>
                <p className="mt-1 text-xs text-ink-500">Label + answer pairs, plus a free-text box.</p>
              </div>
              <button type="button" onClick={() => setExtraRows((rows) => [...rows, { label: '', value: '' }])}
                className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 text-xs">
                <PlusIcon /> Add detail
              </button>
            </div>
            <div className="space-y-2">
              {extraRows.map((row, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[2fr_3fr_auto]">
                  <input value={row.label || ''} onChange={(e) => setExtraRow(index, { label: e.target.value })}
                    placeholder="Loyalty discount" className={`${inputCls} !py-2 text-[13px]`} />
                  <input value={row.value || ''} onChange={(e) => setExtraRow(index, { value: e.target.value })}
                    placeholder="10% after 5 visits" className={`${inputCls} !py-2 text-[13px]`} />
                  <button type="button" aria-label="Remove detail"
                    onClick={() => setExtraRows((rows) => rows.filter((_, i) => i !== index))}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-red-50 hover:text-red-500">
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
            <textarea
              rows={3}
              value={extraText}
              onChange={(e) => setExtraText(e.target.value)}
              placeholder="Order process, parking, seasonal notes — anything a customer might ask."
              className={`${inputCls} mt-3 resize-none !py-2 text-[13px]`}
            />
          </div>

          </div>

          <div className="flex items-center gap-3 border-t border-gray-200 bg-white px-6 py-4">
            <button disabled={busy} className="btn-primary inline-flex items-center gap-2 !py-2 text-xs">
              {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-white" />}
              {busy ? 'Learning…' : 'Save & learn'}
            </button>
            <button type="button" onClick={closeFacts} disabled={busy} className="btn-ghost !py-2 text-xs">Cancel</button>
            <span className="text-[11px] text-ink-400">Saving adds one document you can pause or delete later.</span>
          </div>
        </form>
        </div>
      )}

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

      {/* Test your knowledge */}
      <div className="card mb-10 p-5">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">Ask your knowledge</h2>
            <p className="mt-1 text-xs text-ink-500">
              Type a real customer question to see exactly which chunks the assistant would read.
            </p>
          </div>
          <form onSubmit={runSearch} className="flex w-full gap-2 sm:w-auto">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Do you deliver to Lalitpur?"
              className={`${inputCls} !py-2 text-[13px] sm:w-72`}
            />
            <button disabled={searching || searchQuery.trim().length < 2} className="btn-primary shrink-0 !py-2 text-xs">
              {searching ? 'Searching…' : 'Test'}
            </button>
          </form>
        </div>

        {searchResult && (
          <div className="mt-4 border-t border-gray-200 pt-4">
            <div className="mb-3 flex items-center justify-between text-xs text-ink-500">
              <span>
                {searchResult.matches.length === 0
                  ? 'Nothing matched — the assistant would answer without your knowledge.'
                  : `${searchResult.matches.length} chunk(s) would be sent, retrieved in ${searchResult.elapsedMs} ms`}
              </span>
              <button onClick={() => setSearchResult(null)} className="text-ink-400 hover:text-ink-900">Clear</button>
            </div>
            <div className="space-y-2">
              {searchResult.matches.map((match) => (
                <div key={match.id} className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px] text-ink-400">
                    <span className="truncate font-medium text-ink-600">{match.title}</span>
                    <span className="shrink-0">
                      {match.sourceType}
                      {match.similarity != null ? ` · score ${Number(match.similarity).toFixed(2)}` : ''}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-600">{match.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mb-3 flex items-center justify-between border-b border-gray-200 pb-3">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight text-ink-900">Knowledge performance</h2>
          <p className="mt-1 text-xs text-ink-500">
            Preview what the bot reads, pause a source, re-sync a website — or delete it for good.
          </p>
        </div>
        {docs.length > 0 && (
          <span className="shrink-0 text-xs text-ink-400">
            {docs.filter((d) => d.is_active !== false).length} active of {docs.length}
          </span>
        )}
      </div>
      {docs.length === 0 ? (
        <div className="data-panel p-12 text-center">
          <p className="text-sm font-medium text-ink-700">No documents yet</p>
          <p className="mt-1 text-sm text-ink-400">Add your first source above to start teaching your bot.</p>
        </div>
      ) : (
        <div className="data-panel">
          <div className="data-head hidden sm:grid sm:grid-cols-[2.2fr_1fr_0.7fr_auto]">
            <span>Name</span>
            <span>Source</span>
            <span>Status</span>
            <span className="text-right">Actions</span>
          </div>
          <div className="divide-y divide-gray-100">
          {docs.map((d) => (
            <div key={d.id} className={`grid gap-4 px-5 py-4 text-sm text-ink-700 transition-colors sm:grid-cols-[2.2fr_1fr_0.7fr_auto] sm:items-center ${d.is_active === false ? 'bg-gray-50/70' : 'hover:bg-gray-50'}`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <button onClick={() => rename(d)} title="Rename this source"
                    className={`truncate text-left font-medium hover:underline ${d.is_active === false ? 'text-ink-400' : 'text-ink-900'}`}>
                    {d.title}
                  </button>
                  {d.is_active === false && (
                    <span className="shrink-0 rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-ink-500">
                      paused
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-xs text-ink-400">
                  {d.chunks} chunk{d.chunks === 1 ? '' : 's'}
                  {d.last_synced_at
                    ? ` · synced ${syncedLabel(d.last_synced_at)}`
                    : ` · added ${new Date(d.created_at).toLocaleDateString()}`}
                  {d.url ? ` · ${d.url}` : ''}
                </div>
              </div>
              <div className="text-xs text-ink-500">{d.source_type}</div>
              <div>
                <span className={
                  d.status === 'ready' ? 'chip-success' :
                  d.status === 'failed' ? 'inline-flex items-center rounded-full border border-red-100 bg-red-50 px-2.5 py-0.5 text-[11px] font-medium text-red-600' :
                  'chip-warning'
                }>{d.status}</span>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1">
                {rowBusy === d.id ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-ink-900" />
                ) : (
                  <>
                    {d.source_type === 'crawl' && d.url && (
                      <button onClick={() => resync(d)} title="Re-crawl this page"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-gray-100 hover:text-ink-900">
                        <RefreshIcon />
                      </button>
                    )}
                    <button onClick={() => toggleActive(d)}
                      title={d.is_active === false ? 'Start using this source again' : 'Stop using this source'}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-gray-100 hover:text-ink-900">
                      {d.is_active === false ? <PlayIcon /> : <PauseIcon />}
                    </button>
                    <button onClick={() => openPreview(d)} title="Preview what the bot reads"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-gray-100 hover:text-ink-900">
                      <EyeIcon />
                    </button>
                    <button onClick={() => remove(d)} title="Delete this source"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-300 transition-colors hover:bg-red-50 hover:text-red-500">
                      <TrashIcon />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          </div>
        </div>
      )}
      {/* Saved notification (chime + toast) */}
      {toast && (
        <div
          key={toast.key}
          role="status"
          className="toast-pop fixed bottom-6 right-6 z-[60] flex max-w-sm items-start gap-3 rounded-xl border border-emerald-200 bg-white px-4 py-3 shadow-lg"
        >
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <p className="min-w-0 pt-0.5 text-sm font-medium leading-5 text-ink-900">{toast.message}</p>
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
            className="ml-1 mt-0.5 shrink-0 text-lg leading-none text-ink-300 transition-colors hover:text-ink-900"
          >
            ×
          </button>
        </div>
      )}

      {/* Chunk preview: exactly what retrieval will read for this source */}
      {(preview || previewBusy) && (
        <div
          onClick={() => setPreview(null)}
          className="modal-overlay fixed inset-0 z-40 flex items-end justify-center bg-black/40 animate-[overlay-fade-in_.18s_ease-out] sm:items-center sm:p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="modal-panel max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-t-2xl bg-white shadow-xl animate-[modal-pop-in_.22s_cubic-bezier(0.16,1,0.3,1)] sm:rounded-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-ink-900">{preview?.document?.title || 'Loading…'}</h3>
                <p className="mt-0.5 text-xs text-ink-400">
                  {preview ? `${preview.total} chunk(s) learned · showing first ${preview.shown}` : 'Reading your knowledge base…'}
                </p>
              </div>
              <button onClick={() => setPreview(null)} aria-label="Close preview"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-gray-100 hover:text-ink-900">
                <CloseIcon />
              </button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
              {previewBusy && <p className="text-sm text-ink-500">Loading chunks…</p>}
              {preview && preview.sections.length === 0 && (
                <p className="text-sm text-ink-500">This source has no stored chunks — re-add it, or check its status.</p>
              )}
              <div className="space-y-3">
                {(preview?.sections || []).map((section, index) => (
                  <div key={section.id} className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
                    <div className="mb-1 text-[11px] font-medium text-ink-400">Chunk {index + 1}</div>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-700">{section.content}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
