import { useState, useEffect } from 'react';
import { api } from '../lib/supabaseClient';

/**
 * Leads — visitors who shared their contact information with the bot.
 *
 * Lifted from the former /leads page so it can render inside the Engagement tabs
 * (and inside the "All" overview) without duplicating the feature. The header now
 * matches the Inbox/Bookings tabs (same .h-display scale + count chip) so all
 * Engagement tabs look like one page. `preview` caps the list for the All tab.
 */
export default function EngagementLeads({ preview, onViewAll }) {
  const [leads, setLeads] = useState([]);
  const [error, setError] = useState('');

  async function load() {
    try {
      const data = await api('/api/leads');
      setLeads(data.leads || []);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function remove(id) {
    if (!confirm('Delete this lead?')) return;
    await api(`/api/leads/${id}`, { method: 'DELETE' });
    load();
  }

  const shown = preview ? leads.slice(0, preview) : leads;

  return (
    <section>
      {/* Page header */}
      <div className="section-header">
        <div>
          <h1 className="h-display text-2xl sm:text-[28px]">Leads</h1>
          <p className="mt-1 text-sm text-ink-500">Visitors who shared their contact info with your bot.</p>
        </div>
        <span className="chip w-fit">{leads.length} lead{leads.length === 1 ? '' : 's'}</span>
      </div>

      {error && <p className="mb-6 text-sm text-red-500">{error}</p>}

      <div className="space-y-3">
        {leads.length === 0 && (
          <div className="glass-card p-12 text-center">
            <p className="text-sm font-medium text-ink-700">No leads yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-ink-400">
              When a visitor shares their name, phone, or email in chat, they&apos;ll appear here.
            </p>
          </div>
        )}
        {shown.map((l) => (
          <div key={l.id} className="quiet-card flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-gray-50">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-ink-900">{l.lead_name || 'Unknown name'}</div>
              <div className="mt-0.5 text-xs text-ink-500">{l.contact_info}</div>
              {l.notes && <div className="mt-0.5 text-xs text-ink-400">{l.notes}</div>}
              <div className="mt-1 text-[11px] text-gray-300">{new Date(l.created_at).toLocaleString()}</div>
            </div>
            <button onClick={() => remove(l.id)} className="text-lg leading-none text-gray-300 transition-colors hover:text-red-400">×</button>
          </div>
        ))}
      </div>

      {preview && leads.length > preview && (
        <button onClick={onViewAll} className="btn-link mt-4">
          View all {leads.length} leads →
        </button>
      )}
    </section>
  );
}
