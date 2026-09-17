import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '../lib/supabaseClient';

export default function Agency() {
  const [clients, setClients] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [email, setEmail] = useState('');
  const [invite, setInvite] = useState(null); // { id, email }

  async function load() {
    try {
      const d = await api('/api/agency/clients');
      setClients(d.clients || []);
    } catch (e) {
      setError(e.message);
      setClients([]); // exit loading state even when the request fails
    }
  }
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const d = await api('/api/agency/clients', { method: 'POST', body: JSON.stringify({ name, industry, email: email || undefined }) });
      setName(''); setIndustry(''); setEmail('');
      const inviteMsg = d.invite?.sent
        ? 'Invite email sent to the client.'
        : d.invite?.error ? `Workspace created, but the invite failed: ${d.invite.error}` : '';
      setSuccess(`Client workspace "${d.client.name}" created. ${inviteMsg}`.trim());
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function remove(id, clientName) {
    if (!confirm(`Delete "${clientName}" and all its data? This cannot be undone.`)) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      await api(`/api/agency/clients/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function sendInvite(e, id, clientName) {
    e.preventDefault();
    const email = invite?.email || '';
    if (!email.trim()) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const d = await api(`/api/agency/clients/${id}/invite`, { method: 'POST', body: JSON.stringify({ email }) });
      if (d.sent && d.mode === 'invite') setSuccess(`Invite email sent to ${email} — they can set up their dashboard.`);
      else if (d.sent && d.mode === 'magiclink') setSuccess(`Sign-in link emailed to ${email}.`);
      else if (d.link) setSuccess(`Email not configured — copy this sign-in link for ${clientName}: ${d.link}`);
      else setSuccess(d.error || 'Invite processed.');
      setInvite(null);
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-6 sm:py-12">
      {/* Page header */}
      <div className="mb-8 border-b border-gray-200 pb-6">
        <h1 className="h-display text-2xl sm:text-[28px]">Agency clients</h1>
        <p className="mt-1 text-sm text-ink-500">
          Create and manage AI assistants for all your clients in one place.
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}
      {success && (
        <div className="mb-6 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{success}</div>
      )}

      {/* Create client */}
      <form onSubmit={create} className="card mb-8 flex flex-col gap-3 p-5 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Client business name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required
            placeholder="e.g. Bloom Salon" className="input-base !py-2 text-sm" />
        </div>
        <div className="flex-1">
          <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Industry (optional)</label>
          <input value={industry} onChange={(e) => setIndustry(e.target.value)}
            placeholder="e.g. Salon / Spa" className="input-base !py-2 text-sm" />
        </div>
        <div className="flex-1">
          <label className="mb-1.5 block text-[13px] font-medium text-ink-700">Client email (optional)</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="owner@bloomsalon.com — sends an invite" className="input-base !py-2 text-sm" />
        </div>
        <button disabled={busy} className="btn-primary !py-2.5 sm:w-auto">Add client</button>
      </form>

      {/* Client list */}
      {!clients ? (
        <p className="py-10 text-center text-sm text-ink-400">Loading…</p>
      ) : clients.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-sm font-medium text-ink-700">No clients yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-400">
            Add your first client above — each gets their own workspace with a Pro-level bot.
          </p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-3 font-medium">Client</th>
                <th className="px-5 py-3 font-medium">Messages</th>
                <th className="px-5 py-3 font-medium">Bookings</th>
                <th className="px-5 py-3 font-medium">Leads</th>
                <th className="px-5 py-3 font-medium">Widget</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {clients.map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-gray-50">
                  <td className="px-5 py-3.5">
                    <p className="font-medium text-ink-900">{c.name}</p>
                    <p className="text-xs text-ink-400">{c.industry || '—'}</p>
                    <p className="text-xs text-ink-400">{c.contact_email || 'No client login yet'}</p>
                  </td>
                  <td className="px-5 py-3.5 text-ink-700">{c.messagesThisMonth}</td>
                  <td className="px-5 py-3.5 text-ink-700">{c.bookingsThisMonth}</td>
                  <td className="px-5 py-3.5 text-ink-700">{c.totalLeads}</td>
                  <td className="px-5 py-3.5">
                    <Link href={`/dashboard?org=${c.id}`} className="btn-link !text-xs">
                      Manage →
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setInvite(invite?.id === c.id ? null : { id: c.id, email: c.contact_email || '' })}
                        className="rounded-md px-2 py-1 text-xs font-medium text-ink-700 transition-colors hover:bg-gray-100"
                      >
                        Invite
                      </button>
                      <button
                        onClick={() => remove(c.id, c.name)}
                        disabled={busy}
                        className="rounded-md px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {invite && clients.some((c) => c.id === invite.id) && (
                <tr className="bg-gray-50">
                  <td colSpan={6} className="px-5 py-3">
                    <form onSubmit={(e) => sendInvite(e, invite.id, clients.find((c) => c.id === invite.id)?.name)} className="flex items-center gap-2">
                      <span className="text-xs font-medium text-ink-700">
                        Invite a login for <strong>{clients.find((c) => c.id === invite.id)?.name}</strong>:
                      </span>
                      <input
                        type="email"
                        required
                        autoFocus
                        value={invite.email}
                        onChange={(e) => setInvite({ ...invite, email: e.target.value })}
                        placeholder="owner@clientbusiness.com"
                        className="input-base !py-1.5 text-sm"
                      />
                      <button disabled={busy} className="btn-primary !px-3 !py-1.5 text-xs">Send invite</button>
                      <button type="button" onClick={() => setInvite(null)} className="rounded-md px-2 py-1 text-xs text-ink-500 hover:bg-gray-100">Cancel</button>
                    </form>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-xs leading-relaxed text-ink-400">
        Each client workspace includes Pro features: white-label widget, custom branding,
        and 2,000 messages/month. Usage resets monthly. Use <strong>Manage</strong> to teach and
        brand a client's bot as if you were them; use <strong>Invite</strong> to give the client
        their own dashboard login.
      </p>
    </main>
  );
}
