import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { api } from '../lib/supabaseClient';

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [crawlUrl, setCrawlUrl] = useState('');
  const [manualText, setManualText] = useState('');

  useEffect(() => {
    import('@supabase/supabase-js').then(({ createClient }) => {
      // guard: redirect if not logged in
      const { supabase } = require('../lib/supabaseClient');
      supabase.auth.getSession().then(({ data }) => {
        if (!data.session) router.push('/login');
      });
    });
  }, [router]);

  async function addKnowledge(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
      setDone(true);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  const crawl = () => addKnowledge(() => api('/api/knowledge/crawl', {
    method: 'POST',
    body: JSON.stringify({ url: crawlUrl }),
  }));

  const manual = () => addKnowledge(() => api('/api/knowledge/text', {
    method: 'POST',
    body: JSON.stringify({ title: 'Getting started notes', text: manualText }),
  }));

  return (
    <main className="mx-auto max-w-xl px-6 py-20">
      <p className="eyebrow mb-1">Add knowledge about your business</p>
      <h1 className="mb-10 text-3xl font-semibold tracking-tight text-ink-900">Teach your bot</h1>

      {/* Progress */}
      <div className="mb-10 flex gap-2">
        {[1, 2].map((s) => (
          <div key={s} className={`h-1 flex-1 rounded-full transition-colors duration-300 ${step >= s ? 'bg-brand-500' : 'bg-gray-200'}`} />
        ))}
      </div>

      {done ? (
        <div className="glass-card p-10 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-2xl text-white shadow-lift">✓</div>
          <h2 className="mb-2 text-xl font-semibold tracking-tight text-ink-900">Your bot is learning!</h2>
          <p className="mb-7 text-sm text-ink-500">Knowledge indexed. Try chatting with it from the dashboard.</p>
          <button onClick={() => router.push('/dashboard')} className="btn-primary">
            Go to dashboard →
          </button>
        </div>
      ) : step === 1 ? (
        <div className="glass-card space-y-6 p-7">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink-900">Crawl your website</label>
            <p className="mb-4 text-xs leading-relaxed text-ink-400">We&apos;ll read your site and learn everything about your business.</p>
            <div className="flex gap-2">
              <input
                placeholder="https://yourbusiness.com"
                value={crawlUrl}
                onChange={(e) => setCrawlUrl(e.target.value)}
                className="input-min flex-1"
              />
              <button onClick={crawl} disabled={busy || !crawlUrl} className="btn-primary">
                {busy ? 'Crawling…' : 'Add'}
              </button>
            </div>
          </div>
          <button onClick={() => setStep(2)} className="text-sm font-medium text-brand-600">
            Or paste text manually instead →
          </button>
        </div>
      ) : (
        <div className="glass-card space-y-6 p-7">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink-900">Paste your business info</label>
            <p className="mb-4 text-xs leading-relaxed text-ink-400">FAQs, services, prices, opening hours — anything customers ask about.</p>
            <textarea
              rows={8}
              placeholder={'Example:\nWe are a family restaurant open 11am–10pm daily.\nTable bookings for up to 12 people.\nSpecialties: butter chicken, dosa, wood-fired pizza.'}
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              className="input-min resize-none"
            />
            <button onClick={manual} disabled={busy || manualText.trim().length < 20}
              className="btn-primary mt-4">
              {busy ? 'Indexing…' : 'Save & train bot'}
            </button>
          </div>
          <button onClick={() => setStep(1)} className="text-sm font-medium text-brand-600">← Back to website crawl</button>
        </div>
      )}

      {error && <p className="mt-5 text-sm text-red-500">{error}</p>}
    </main>
  );
}
