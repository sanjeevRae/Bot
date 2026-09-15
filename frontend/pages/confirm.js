import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useRouter } from 'next/router';
import Link from 'next/link';

export default function Confirm() {
  const router = useRouter();
  const [state, setState] = useState('working'); // working | ok | error
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!router.isReady) return;

    (async () => {
      try {
        // The confirmation email links to /confirm#access_token=...&refresh_token=...
        const hash = window.location.hash;
        const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : '');
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');

        if (params.get('error')) throw new Error(params.get('error_description') || params.get('error'));

        // If Supabase already auto-swapped the tokens, just fetch the session.
        let { data } = await supabase.auth.getSession();
        if (!data?.session && accessToken && refreshToken) {
          const res = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          if (res.error) throw new Error(res.error.message);
          data = res.data;
        }

        if (!data?.session) {
          throw new Error('No session. The link may be invalid or expired — please log in.');
        }
        setState('ok');
        setTimeout(() => router.replace('/onboarding'), 1200);
      } catch (e) {
        setState('error');
        setMsg(e.message);
      }
    })();
  }, [router.isReady, router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-5">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-base font-bold text-white">C</div>
        <h1 className="h-display text-2xl">
          {state === 'working' && 'Confirming your email…'}
          {state === 'ok' && '✓ Email confirmed!'}
          {state === 'error' && 'Confirmation failed'}
        </h1>
        <p className="mt-2 text-sm text-ink-500">
          {state === 'ok' && 'Your account is active. Taking you to onboarding…'}
          {state === 'error' && (msg || 'Something went wrong.')}
        </p>
        {state === 'error' && (
          <Link href="/login" className="mt-6 inline-block text-sm font-medium text-brand-600 hover:underline">
            Go to login
          </Link>
        )}
      </div>
    </main>
  );
}