import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'public-anon-key-placeholder';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Backend API base URL (Render)
export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
// Optional second backend tried when the primary is unreachable (e.g. Render
// asleep/down). Set NEXT_PUBLIC_API_FALLBACK_URL=http://localhost:5000 to work
// against your local backend while the deployed one is down.
export const API_FALLBACK_URL = process.env.NEXT_PUBLIC_API_FALLBACK_URL || '';

// Time-to-first-response cap (ms) for the primary attempt when a fallback
// exists. Prevents a hung/dead backend (e.g. Render black-holing requests
// while down) from stalling the UI forever. 0 disables the cap.
const API_TIMEOUT_MS = parseInt(process.env.NEXT_PUBLIC_API_TIMEOUT_MS || '20000', 10);

/**
 * Fetch that automatically falls back to API_FALLBACK_URL when the primary
 * API is unreachable — either a network failure (backend down, CORS block),
 * a timeout, or a gateway error (502/503/504 from a sleeping Render instance).
 * Returns the raw Response so callers can handle JSON, files, etc.
 */
export async function fetchApi(path, options = {}) {
  const targets = API_FALLBACK_URL && API_FALLBACK_URL !== API_URL ? [API_URL, API_FALLBACK_URL] : [API_URL];
  let lastRes = null;
  let lastErr = null;
  for (let i = 0; i < targets.length; i++) {
    const base = targets[i];
    const isLast = i === targets.length - 1;
    // Only cap non-final attempts; the final target gets no timeout so
    // legitimately slow endpoints (LLM chat replies) still complete.
    const signal = !isLast && API_TIMEOUT_MS > 0 ? AbortSignal.timeout(API_TIMEOUT_MS) : options.signal;
    try {
      const res = await fetch(`${base}${path}`, signal ? { ...options, signal } : options);
      const gatewayDown = res.status === 502 || res.status === 503 || res.status === 504;
      if (!gatewayDown || isLast) return res;
      lastRes = res; // primary gateway says the app is down — try the fallback
    } catch (e) {
      lastErr = e; // network failure or timeout — try the fallback
    }
  }
  if (lastRes) return lastRes;
  throw new Error(
    `Cannot reach API at ${targets.join(' or ')}${path} — is the backend running, and is this origin in CORS_ORIGINS?`
  );
}

/** Authenticated fetch helper — attaches Supabase JWT */
export async function api(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetchApi(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
