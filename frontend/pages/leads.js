import { useState, useEffect } from 'react';
import { api } from '../lib/supabaseClient';

export default function Leads() {
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

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <p className="eyebrow mb-1">Visitors who shared their contact info with your bot</p>
      <h1 className="mb-10 text-3xl font-semibold tracking-tight text-ink-900">Leads</h1>

      {error && <p className="mb-6 text-sm text-red-500">{error}</p>}

      <div className="space-y-2">
        {leads.length === 0 && (
          <div className="glass-card p-10 text-center text-sm text-ink-400">
            No leads yet. When a visitor shares their name/phone/email in chat, they&apos;ll appear here.
          </div>
        )}
        {leads.map((l) => (
          <div key={l.id} className="quiet-card flex items-center justify-between px-5 py-4">
            <div>
              <div className="text-sm font-medium text-ink-900">{l.lead_name || 'Unknown name'}</div>
              <div className="mt-0.5 text-xs text-ink-500">{l.contact_info}</div>
              {l.notes && <div className="mt-0.5 text-xs text-ink-400">{l.notes}</div>}
              <div className="mt-1 text-[11px] text-gray-300">{new Date(l.created_at).toLocaleString()}</div>
            </div>
            <button onClick={() => remove(l.id)} className="text-lg leading-none text-gray-300 transition-colors hover:text-red-400">×</button>
          </div>
        ))}
      </div>
    </main>
  );
}
