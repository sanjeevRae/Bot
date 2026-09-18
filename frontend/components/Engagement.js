import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { api } from '../lib/supabaseClient';
import EngagementInbox from './EngagementInbox';
import EngagementBookings from './EngagementBookings';
import EngagementLeads from './EngagementLeads';

/* Inline SVG icons (Lucide-style strokes) — same pattern as the Admin summary cards */
const Icon = ({ children }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-brand-600">
    {children}
  </svg>
);
const MessageIcon = () => (<Icon><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></Icon>);
const CalendarIcon = () => (<Icon><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></Icon>);
const TargetIcon = () => (<Icon><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></Icon>);

/** The Engagement tabs. `initialTab` lets the legacy /inbox, /bookings and /leads
 *  routes open straight into their own tab (see those pages). */
const TABS = [
  ['all', 'All'],
  ['leads', 'Leads'],
  ['bookings', 'Bookings'],
  ['inbox', 'Inbox'],
];

/**
 * Engagement — the single home for Inbox, Bookings and Leads.
 *
 * Each tab simply renders the component that used to be its own page, so every
 * feature (fetch, resolve, status changes, delete), its styling and its API stay
 * exactly as they were. The legacy /inbox, /bookings and /leads routes render this
 * same component with `initialTab` preset, so old links and bookmarks keep working.
 */
export default function Engagement({ initialTab = 'all' }) {
  const router = useRouter();
  const [tab, setTab] = useState(initialTab);
  const [summary, setSummary] = useState(null);

  // Keep the active tab in sync with ?tab=, so /engagement?tab=inbox deep-links
  // and browser back/forward moves between tabs.
  useEffect(() => {
    const q = router.query.tab;
    if (router.isReady && typeof q === 'string' && TABS.some(([id]) => id === q)) setTab(q);
  }, [router.isReady, router.query.tab]);

  function selectTab(id) {
    setTab(id);
    // Update the URL so tabs are shareable/deep-linkable. Same-page query change,
    // so no data refetch happens.
    router.push({ pathname: '/engagement', query: { tab: id } });
  }

  // "All" overview counts. The three section components below fetch these same
  // endpoints, and api() shares/caches GETs, so this costs no extra requests.
  useEffect(() => {
    if (tab !== 'all') return;
    let alive = true;
    (async () => {
      try {
        const [inbox, bookings, leads] = await Promise.all([
          api('/api/inbox'),
          api('/api/bookings'),
          api('/api/leads'),
        ]);
        if (!alive) return;
        const bookingList = bookings.bookings || [];
        setSummary({
          pending: (inbox.conversations || []).length,
          bookings: bookingList.length,
          confirmed: bookingList.filter((b) => b.status === 'confirmed').length,
          leads: (leads.leads || []).length,
        });
      } catch {
        /* the per-section components surface their own errors */
      }
    })();
    return () => { alive = false; };
  }, [tab]);

  const stat = (v) => (summary ? v : '—');

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-6 sm:py-12">
      {/* Page header */}
      <div className="mb-8">
        <p className="eyebrow mb-1">Customer engagement</p>
        <h1 className="h-display text-3xl">Engagement</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-500">
          Everything your bot captured with customers — leads, bookings and escalated conversations — in one place.
        </p>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex flex-wrap gap-1 border-b border-gray-200">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => selectTab(id)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === id
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-ink-500 hover:text-ink-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
{tab === 'all' && (
        <>
          {/* Overview counts */}
          <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              ['Leads captured', stat(summary?.leads), 'shared contact details', <TargetIcon key="t" />],
              ['Bookings', stat(summary?.bookings), `${summary ? summary.confirmed : '—'} confirmed`, <CalendarIcon key="c" />],
              ['Pending escalations', stat(summary?.pending), 'waiting for a human', <MessageIcon key="m" />],
            ].map(([label, value, hint, icon]) => (
              <div key={label} className="glass-hover p-5">
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl border border-white/70 bg-white/60 shadow-soft backdrop-blur">{icon}</div>
                <div className="text-[26px] font-semibold tracking-tight text-ink-900">{value}</div>
                <div className="mt-1 text-xs text-ink-400">{label}</div>
                <div className="mt-0.5 text-[11px] text-ink-400">{hint}</div>
              </div>
            ))}
          </div>

          {/* The three sections, each capped to the latest few with a jump link */}
          <div className="space-y-14">
            <EngagementLeads preview={3} onViewAll={() => selectTab('leads')} />
            <EngagementBookings preview={3} onViewAll={() => selectTab('bookings')} />
            <EngagementInbox preview={3} onViewAll={() => selectTab('inbox')} />
          </div>
        </>
      )}

      {tab === 'leads' && <EngagementLeads />}
      {tab === 'bookings' && <EngagementBookings />}
      {tab === 'inbox' && <EngagementInbox />}
    </main>
  );
}