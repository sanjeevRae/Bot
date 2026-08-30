import '../styles/globals.css';
import { useState, useEffect } from 'react';
import { supabase, fetchApi } from '../lib/supabaseClient';
import Link from 'next/link';
import PostHog from '../components/PostHog';

export default function App({ Component, pageProps }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user || null);
      if (data.session) fetchRole(data.session.access_token);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user || null);
      setRole(null);
      if (session) fetchRole(session.access_token);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function fetchRole(token) {
    try {
      const res = await fetchApi('/api/org/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setRole(data.role || 'owner');
      }
    } catch { /* ignore */ }
  }

  const nav = (
    <nav className="sticky top-0 z-40 border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 sm:py-3.5">
        <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-ink-900">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-xs font-bold text-white">C</span>
          Chitra AI
        </Link>

        {/* Desktop nav */}
        <div className="hidden items-center gap-1 text-sm md:flex">
          {user ? (
            <>
              {[
                ['/dashboard', 'Dashboard'],
                ['/knowledge', 'Knowledge'],
                ['/bookings', 'Bookings'],
                ['/leads', 'Leads'],
                ['/inbox', 'Inbox'],
                ['/channels', 'Channels'],
                ['/agency', 'Clients'],
                ['/billing', 'Billing'],
                ['/settings', 'Settings'],
              ].map(([href, label]) => (
                <Link
                  key={href}
                  href={href}
                  className="rounded-lg px-3 py-1.5 text-ink-500 transition-colors hover:bg-gray-900/[0.04] hover:text-ink-900"
                >
                  {label}
                </Link>
              ))}
              {role === 'admin' && (
                <Link
                  href="/admin"
                  className="rounded-lg px-3 py-1.5 font-medium text-brand-600 transition-colors hover:bg-gray-900/[0.04]"
                >
                  Admin
                </Link>
              )}
              <button
                onClick={() => supabase.auth.signOut()}
                className="ml-2 rounded-lg px-3 py-1.5 text-ink-400 transition-colors hover:text-red-500"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="rounded-lg px-3 py-1.5 text-ink-500 transition-colors hover:bg-gray-900/[0.04] hover:text-ink-900">
                Log in
              </Link>
              <Link href="/signup" className="btn-primary ml-2 !px-4 !py-1.5">
                Get started free
              </Link>
            </>
          )}
        </div>

        {/* Mobile nav — compact text links */}
        <div className="flex items-center gap-0.5 text-[13px] md:hidden">
          {user ? (
            <>
              {[
                ['/dashboard', 'Home'],
                ['/knowledge', 'Docs'],
                ['/bookings', 'Bookings'],
                ['/leads', 'Leads'],
                ['/settings', 'Settings'],
              ].map(([href, label]) => (
                <Link
                  key={href}
                  href={href}
                  className="rounded-lg px-2 py-1.5 text-ink-500 transition-colors hover:bg-gray-900/[0.04] hover:text-ink-900"
                >
                  {label}
                </Link>
              ))}
              {role === 'admin' && (
                <Link
                  href="/admin"
                  className="rounded-lg px-2 py-1.5 font-medium text-brand-600 transition-colors hover:bg-gray-900/[0.04]"
                >
                  Admin
                </Link>
              )}
              <button
                onClick={() => supabase.auth.signOut()}
                className="ml-1 rounded-lg px-2 py-1.5 text-ink-400 transition-colors hover:text-red-500"
              >
                Exit
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="rounded-lg px-2.5 py-1.5 text-sm text-ink-500 transition-colors hover:bg-gray-900/[0.04] hover:text-ink-900">
                Log in
              </Link>
              <Link href="/signup" className="btn-primary !px-3.5 !py-1.5 text-xs">
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen">
      <PostHog />
      {nav}
      {loading ? (
        <div className="flex h-[80vh] items-center justify-center text-sm text-ink-400">Loading…</div>
      ) : (
        <Component {...pageProps} user={user} />
      )}
    </div>
  );
}
