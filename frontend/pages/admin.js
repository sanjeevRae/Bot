import { useState, useEffect, useMemo } from 'react';
import { api, API_URL } from '../lib/supabaseClient';

/* Inline SVG icons (Lucide-style strokes) */
const Icon = ({ children }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-brand-600">
    {children}
  </svg>
);
const BuildingIcon = () => (<Icon><rect width="16" height="20" x="4" y="2" rx="2" /><path d="M9 22v-4h6v4" /><path d="M8 6h.01" /><path d="M16 6h.01" /><path d="M12 6h.01" /><path d="M12 10h.01" /><path d="M12 14h.01" /><path d="M16 10h.01" /><path d="M16 14h.01" /><path d="M8 10h.01" /><path d="M8 14h.01" /></Icon>);
const MessageIcon = () => (<Icon><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></Icon>);
const TargetIcon = () => (<Icon><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></Icon>);
const CalendarIcon = () => (<Icon><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></Icon>);

export default function Admin() {
  const [tenants, setTenants] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null); // tenant id being edited
  const [quotaInput, setQuotaInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);

  async function load() {
    try {
      const data = await api('/api/admin/tenants');
      setTenants(data.tenants || []);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!tenants) return [];
    const q = search.toLowerCase();
    return tenants.filter(
      (t) => t.name?.toLowerCase().includes(q) || t.ownerEmail?.toLowerCase().includes(q)
    );
  }, [tenants, search]);

  async function saveQuota(tenantId) {
    setSaving(true);
    setError('');
    try {
      const value = quotaInput.trim() === '' ? null : parseInt(quotaInput, 10);
      if (value !== null && (isNaN(value) || value < 0)) throw new Error('Enter a valid number');
      await api(`/api/admin/tenants/${tenantId}/quota`, {
        method: 'PATCH',
        body: JSON.stringify({ quota: value }),
      });
      setEditing(null);
      load();
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  }

  async function toggleAgency(tenantId, hasAgency) {
    if (hasAgency && !confirm('Revoke the Agency plan from this business? It will be downgraded to free.')) return;
    setPlanBusy(true);
    setError('');
    try {
      await api(`/api/admin/tenants/${tenantId}/${hasAgency ? 'revoke-agency' : 'grant-agency'}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      load();
    } catch (e) {
      setError(e.message);
    }
    setPlanBusy(false);
  }

  if (error && !tenants) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-24 text-center">
        <p className="eyebrow mb-3">403</p>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">Admin access required</h1>
        <p className="mt-2 text-sm text-ink-400">{error}</p>
      </main>
    );
  }

  if (!tenants) return <main className="mx-auto max-w-5xl px-6 py-16 text-sm text-ink-400">Loading…</main>;

  const totalMessages = tenants.reduce((s, t) => s + t.messagesThisMonth, 0);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      {/* Header */}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow mb-1">Platform overview</p>
          <h1 className="text-3xl font-semibold tracking-tight text-ink-900">Admin</h1>
        </div>
        <div className="flex gap-2">
          <a href={`${API_URL}/api/admin/export`} target="_blank" rel="noreferrer" className="btn-outline !py-2 text-xs">
            Export tenants CSV
          </a>
          <a href={`${API_URL}/api/admin/export?type=messages`} target="_blank" rel="noreferrer" className="btn-outline !py-2 text-xs">
            Export usage CSV
          </a>
        </div>
      </div>

      {/* Summary */}
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          ['Businesses', tenants.length, <BuildingIcon key="b" />],
          ['Messages this month', totalMessages, <MessageIcon key="m" />],
          ['Total leads', tenants.reduce((s, t) => s + t.totalLeads, 0), <TargetIcon key="t" />],
          ['Total bookings', tenants.reduce((s, t) => s + t.totalBookings, 0), <CalendarIcon key="c" />],
        ].map(([label, value, icon]) => (
          <div key={label} className="glass-hover p-5">
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl border border-white/70 bg-white/60 shadow-soft backdrop-blur">{icon}</div>
            <div className="text-[26px] font-semibold tracking-tight text-ink-900">{value}</div>
            <div className="mt-1 text-xs text-ink-400">{label}</div>
          </div>
        ))}
      </div>

      {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

      {/* Search */}
      <input
        placeholder="Search by business or email…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="input-min mb-4 max-w-xs"
      />

      {/* Tenant table */}
      <div className="quiet-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/70 bg-white/40 text-left text-xs text-ink-400 backdrop-blur">
              <th className="px-5 py-3 font-medium">Business</th>
              <th className="px-5 py-3 font-medium">Owner</th>
              <th className="px-5 py-3 font-medium">Usage / Quota</th>
              <th className="hidden px-5 py-3 font-medium md:table-cell">Docs · Leads · Bookings</th>
              <th className="px-5 py-3 font-medium">Agency plan</th>
              <th className="px-5 py-3 text-right font-medium">Extend usage</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-ink-400">No businesses found.</td></tr>
            )}
            {filtered.map((t) => {
              const quota = t.quota ?? 100; // platform default
              const pct = Math.min(100, Math.round((t.messagesThisMonth / quota) * 100));
              const nearLimit = pct >= 80;
              return (
                <tr key={t.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-900/[0.015]">
                  <td className="px-5 py-3.5">
                    <div className="font-medium text-ink-900">{t.name}</div>
                    <div className="text-xs text-ink-400">{t.industry || '—'}</div>
                  </td>
                  <td className="px-5 py-3.5 text-ink-500">{t.ownerEmail || '—'}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium ${nearLimit ? 'text-red-500' : 'text-ink-700'}`}>
                        {t.messagesThisMonth} / {t.quota === null ? '100' : t.quota}
                      </span>
                      {t.quota !== null && (
                        <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
                          extended
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 h-1 w-24 overflow-hidden rounded-full bg-gray-100">
                      <div
                        className={`h-full rounded-full transition-all ${nearLimit ? 'bg-red-400' : 'bg-brand-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </td>
                  <td className="hidden px-5 py-3.5 text-xs text-ink-500 md:table-cell">
                    {t.documents} docs · {t.totalLeads} leads · {t.totalBookings} bookings
                  </td>
                  <td className="px-5 py-3.5">
                    {t.plan === 'agency' ? (
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">
                          Agency
                        </span>
                        {t.planExpiresAt && (
                          <span className="text-[11px] text-ink-400">till {String(t.planExpiresAt).slice(0, 10)}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-ink-400">—</span>
                    )}
                    <button
                      onClick={() => toggleAgency(t.id, t.plan === 'agency')}
                      disabled={planBusy}
                      className={`mt-1.5 block !px-3 !py-1.5 text-xs ${t.plan === 'agency' ? 'btn-outline' : 'btn-primary'}`}
                    >
                      {t.plan === 'agency' ? 'Revoke' : 'Grant Agency'}
                    </button>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    {editing === t.id ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <input
                          autoFocus
                          type="number"
                          min="0"
                          placeholder="messages"
                          value={quotaInput}
                          onChange={(e) => setQuotaInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && saveQuota(t.id)}
                          className="input-min !w-24 !px-2 !py-1 text-xs"
                        />
                        <button onClick={() => saveQuota(t.id)} disabled={saving}
                          className="btn-primary !rounded-lg !px-2.5 !py-1 text-xs">
                          Save
                        </button>
                        <button onClick={() => setEditing(null)} className="btn-ghost !px-2 !py-1 text-xs">
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditing(t.id); setQuotaInput(t.quota ?? ''); }}
                        className="btn-outline !px-3 !py-1.5 text-xs"
                      >
                        Extend
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-ink-400">
        Leave the field empty and save to reset a business back to the default free plan (100 messages/month).
      </p>
    </main>
  );
}
