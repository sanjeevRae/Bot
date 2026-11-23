/**
 * Cloudflare Turnstile token helper for the public chat calls.
 *
 * The backend verifies a fresh token on every /api/chat request in
 * production (see backend middleware/turnstile.js). This helper renders an
 * invisible Turnstile widget once and returns a fresh single-use token per
 * call. When NEXT_PUBLIC_TURNSTILE_SITE_KEY is not set (local dev), it
 * resolves '' immediately and the backend skips verification.
 *
 * The site key is PUBLIC by design (it ships in every page that renders a
 * Turnstile widget). The secret key must never appear in frontend code.
 */

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';

let loadPromise = null;
let widgetId = null;
let pendingResolve = null;

function loadTurnstile() {
  if (!loadPromise) {
    loadPromise = new Promise((resolve) => {
      if (typeof window === 'undefined') return resolve(false);
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => {
        try {
          const holder = document.createElement('div');
          holder.style.display = 'none';
          document.body.appendChild(holder);
          widgetId = window.turnstile.render(holder, {
            sitekey: SITE_KEY,
            size: 'invisible',
            callback: (token) => {
              if (pendingResolve) {
                const r = pendingResolve;
                pendingResolve = null;
                r(token);
              }
            },
            'error-callback': () => {
              if (pendingResolve) {
                const r = pendingResolve;
                pendingResolve = null;
                r('');
              }
            },
          });
          resolve(true);
        } catch {
          resolve(false);
        }
      };
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }
  return loadPromise;
}

/** Fresh Turnstile token, or '' when not configured / unavailable. */
export async function getTurnstileToken() {
  if (!SITE_KEY) return '';
  const ok = await loadTurnstile();
  if (!ok || widgetId === null || typeof window === 'undefined' || !window.turnstile) return '';
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingResolve = null;
      resolve('');
    }, 5000);
    pendingResolve = (token) => {
      clearTimeout(timer);
      resolve(token);
    };
    try {
      window.turnstile.reset(widgetId);
      window.turnstile.execute(widgetId);
    } catch {
      clearTimeout(timer);
      pendingResolve = null;
      resolve('');
    }
  });
}
