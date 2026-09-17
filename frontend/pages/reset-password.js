import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useRouter } from 'next/router';
import Link from 'next/link';

/**
 * /reset-password
 * The link Supabase emails (via resetPasswordForEmail) lands here with
 * #access_token=...&refresh_token=... in the URL. We exchange them for a
 * session, then let the user set a new password.
 */
export default function ResetPassword() {
  const router = useRouter();
  const [stage, setStage] = useState('checking'); // checking | ready | error
  const [errMsg, setErrMsg] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Consume the recovery tokens from the URL fragment once on load.
  useEffect(() => {
    if (!router.isReady) return;
    if (router.asPath.includes('reset-password')) { /* marker for lint clarity */ }

    (async () => {
      try {
        const hash = window.location.hash;
        const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : '');
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');

        if (params.get('error')) throw new Error(params.get('error_description') || params.get('error'));

        let { data } = await supabase.auth.getSession();
        if (!data?.session && accessToken && refreshToken) {
          const res = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          if (res.error) throw new Error(res.error.message);
          data = res.data;
        }
        if (!data?.session) {
          throw new Error('This reset link is invalid or has expired. Please request a new one.');
        }
        setStage('ready');
      } catch (e) {
        setStage('error');
        setErrMsg(e.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password.length < 6) return setErrMsg('Password must be at least 6 characters.');
    if (password !== confirm) return setErrMsg('Passwords do not match.');
    setBusy(true);
    setErrMsg('');
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setErrMsg(error.message);
    setDone(true);
    setTimeout(() => router.replace('/login'), 2500);
  }

  if (done) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50 px-5">
        <div className="w-full max-w-md text-center">
          <h1 className="h-display text-2xl">✓ Password updated!</h1>
          <p className="mt-2 text-sm text-ink-500">Your new password is active. Taking you to login…</p>
          <Link href="/login" className="mt-6 inline-block text-sm font-medium text-brand-600 hover:underline">Go to login now</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-5 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-5 h-11 w-11 overflow-hidden rounded-xl bg-white ring-1 ring-gray-200">
            <img src="/logo.png" alt="Chitra AI logo" className="h-full w-full object-contain" />
          </div>
          <h1 className="h-display text-2xl">Set a new password</h1>
          <p className="mt-1.5 text-sm text-ink-500">Choose a strong password you don&rsquo;t use anywhere else.</p>
        </div>

        {stage === 'checking' && (
          <div className="card p-7 text-center text-sm text-ink-500">Verifying your reset link…</div>
        )}

        {stage === 'error' && (
          <div className="card p-7 text-center">
            <p className="text-sm text-red-600">{errMsg}</p>
            <Link href="/login" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline">
              Back to login
            </Link>
          </div>
        )}

        {stage === 'ready' && (
          <div className="card p-7 sm:p-8">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="new-password" className="mb-1.5 block text-[13px] font-medium text-ink-700">New password</label>
                <input
                  id="new-password"
                  type="password" required minLength={6} autoComplete="new-password"
                  placeholder="Minimum 6 characters" value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-base"
                />
              </div>
              <div>
                <label htmlFor="confirm-password" className="mb-1.5 block text-[13px] font-medium text-ink-700">Confirm new password</label>
                <input
                  id="confirm-password"
                  type="password" required minLength={6} autoComplete="new-password"
                  placeholder="Type it again" value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="input-base"
                />
              </div>
              {errMsg && (
                <div className="rounded-lg border border-red-100 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-600">{errMsg}</div>
              )}
              <button disabled={busy} className="btn-primary w-full py-2.5">
                {busy ? 'Updating…' : 'Set new password'}
              </button>
            </form>
          </div>
        )}

        <p className="mt-6 text-center text-sm text-ink-500">
          <Link href="/login" className="font-medium text-brand-600 transition-colors hover:text-brand-700">← Back to login</Link>
        </p>
      </div>
    </main>
  );
}