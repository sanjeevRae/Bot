import { useState, useEffect } from 'react';
import { api } from '../lib/supabaseClient';

export default function Bookings() {
  const [bookings, setBookings] = useState([]);
  const [error, setError] = useState('');

  async function load() {
    try {
      const data = await api('/api/bookings');
      setBookings(data.bookings || []);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function setStatus(id, status) {
    await api(`/api/bookings/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    load();
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-6 sm:py-12">
      {/* Page header */}
      <div className="mb-8 flex flex-col justify-between gap-4 border-b border-gray-200 pb-6 sm:flex-row sm:items-end">
        <div>
          <h1 className="h-display text-2xl sm:text-[28px]">Bookings</h1>
          <p className="mt-1 text-sm text-ink-500">Appointments your bot has made with customers.</p>
        </div>
        <span className="chip w-fit">{bookings.length} booking{bookings.length === 1 ? '' : 's'}</span>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {bookings.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-sm font-medium text-ink-700">No bookings yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-400">
            Your bot will create them automatically when customers ask to book.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {bookings.map((b) => (
            <div key={b.id} className="card flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink-900">{b.customer_name}</span>
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-500">#{b.reference}</span>
                  <span className={
                    b.status === 'confirmed' ? 'chip-success' :
                    b.status === 'cancelled' ? 'inline-flex items-center rounded-full border border-red-100 bg-red-50 px-2.5 py-0.5 text-[11px] font-medium text-red-600' :
                    b.status === 'completed' ? 'chip-accent' : 'chip'
                  }>{b.status}</span>
                </div>
                <div className="mt-1 text-[13px] text-ink-500">
                  {new Date(b.booking_time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  {' · '}{b.party_size} guest{b.party_size === 1 ? '' : 's'}
                  {b.contact_info ? ` · ${b.contact_info}` : ''}
                </div>
                {b.details && <div className="mt-1 text-xs text-ink-400">{b.details}</div>}
              </div>
              {b.status === 'confirmed' && (
                <div className="flex shrink-0 gap-2">
                  <button onClick={() => setStatus(b.id, 'completed')} className="btn-secondary !px-3 !py-1.5 text-xs">Mark done</button>
                  <button
                    onClick={() => setStatus(b.id, 'cancelled')}
                    className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:border-red-200 hover:bg-red-50"
                  >Cancel</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
