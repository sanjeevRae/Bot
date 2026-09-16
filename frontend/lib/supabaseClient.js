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

/* ---------- Tiny GET cache: dedupes parallel + repeat page loads ---------- */
// The dashboard, settings, billing pages and the app shell all request
// /api/org/me on mount — often simultaneously. Cache GETs for 30s and share
// in-flight requests so N callers = 1 network call. Any non-GET clears it.
const GET_CACHE_TTL_MS = 30_000;
const getCache = new Map(); // key -> { at, data }
const inFlight = new Map(); // key -> Promise

/** Drop cached GET responses (all, or one path). */
export function clearApiCache(path) {
  if (path) {
    for (const k of getCache.keys()) if (k.endsWith(path)) getCache.delete(k);
  } else {
    getCache.clear();
  }
}

async function authedFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    ...(options.headers || {}),
  };
  // Agency "manage as client": operate on the client workspace
  const managing = getManagingOrg();
  if (managing?.id) headers['x-org-id'] = managing.id;
  const res = await fetchApi(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Authenticated fetch helper — attaches Supabase JWT */
export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();

  // Mutations bypass the cache and invalidate it, so the next GET is fresh.
  if (method !== 'GET' || options.noCache) {
    const data = await authedFetch(path, options);
    clearApiCache();
    return data;
  }

  const managing = getManagingOrg();
  const key = (managing?.id || '') + path;

  const hit = getCache.get(key);
  if (hit && Date.now() - hit.at < GET_CACHE_TTL_MS) return hit.data;

  // Share one request between concurrent callers (page mount bursts)
  if (inFlight.has(key)) return inFlight.get(key);
  const p = authedFetch(path, options)
    .then((data) => { getCache.set(key, { at: Date.now(), data }); return data; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/* ---------- "Manage as client" (agency org switching) ---------- */
const MANAGING_KEY = 'chitra-managing-org';

/** Set the client workspace being managed ({ id, name }) or null to stop. */
export function setManagingOrg(org) {
  try {
    if (org && org.id) sessionStorage.setItem(MANAGING_KEY, JSON.stringify(org));
    else sessionStorage.removeItem(MANAGING_KEY);
  } catch {}
  window.dispatchEvent(new Event('chitra-managing-changed'));
}

/** The client workspace currently being managed, or null. */
export function getManagingOrg() {
  try { return JSON.parse(sessionStorage.getItem(MANAGING_KEY) || 'null'); } catch { return null; }
}
