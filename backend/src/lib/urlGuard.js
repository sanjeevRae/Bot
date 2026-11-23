'use strict';

/**
 * SSRF guard for every server-side fetch of a user-influenced URL
 * (knowledge crawl, Notion/Drive imports, channel media downloads).
 *
 * Why this exists (2026-11-23 hardening): the crawl/import fetchers used to
 * fetch any URL verbatim — loopback, `localhost`, private LAN addresses and
 * the cloud metadata address 169.254.169.254 were all reachable, redirects
 * into them were followed, and the Notion "check" was a substring regex over
 * the whole URL (a loopback URL containing `notion.so` passed). The fetched
 * text is stored in the tenant's knowledge base, so this was non-blind SSRF
 * for any free-signup user.
 *
 * What `assertPublicUrl` enforces:
 *   - scheme is http: or https: only (no file:, ftp:, gopher:, data:, …)
 *   - the hostname is resolved via DNS and EVERY resolved address must be a
 *     public unicast address — private, loopback, link-local (incl. the
 *     metadata range), CGNAT, multicast, reserved, documentation and
 *     unspecified ranges are rejected, as are IPv4-mapped IPv6 forms of them
 *   - IP literals are checked directly without DNS
 *
 * What `fetchPublic` adds:
 *   - redirects are followed MANUALLY (max 5), re-validating every hop, so a
 *     public URL can never bounce the server into a private one
 *   - Authorization headers are dropped on cross-host redirects
 *
 * Known residual risk (documented, accepted): DNS rebinding TOCTOU — the
 * hostname is resolved for validation, then resolved again by fetch. Fully
 * closing it needs IP-pinned connections with custom TLS handling, which the
 * platform's fetch stack doesn't support; the window is small and the check
 * still defeats direct, redirect-based and stored-URL attacks.
 */

const dns = require('dns').promises;
const net = require('net');

function guardError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'url_blocked' });
}

/** Is this IPv4 address a non-public one? (input: dotted quad string) */
function isBlockedIpv4(ip) {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF special (incl. NAT64 well-known)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared address space
  if (a === 192 && b === 31) return true; // AS112
  if (a === 192 && b === 175) return true; // AS112
  if (a === 198 && b === 51) return true; // TEST-NET-2 (documentation)
  if (a === 203 && b === 0) return true; // TEST-NET-3 203.0.113.0/24 (documentation)
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Is this IPv6 address a non-public one? Handles ::ffff:a.b.c.d mapped forms. */
function isBlockedIpv6(ip) {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
  if (/^ff/.test(lower)) return true; // multicast
  if (lower.startsWith('2001:db8')) return true; // documentation
  if (lower.startsWith('::ffff:')) return true; // any other mapped form — treat as blocked unless plain v4 above
  return false;
}

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return true; // not an IP at all — callers only pass resolved/literal IPs
}

async function defaultResolve(hostname) {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => r.address);
}

/**
 * Validate that a URL is safe for the server to fetch. Returns the parsed URL.
 * Throws a status-400 error describing the rejection (safe to show users).
 * `deps.resolve` is injectable for tests.
 */
async function assertPublicUrl(rawUrl, deps = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw guardError('That URL could not be parsed.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw guardError('Only http:// and https:// URLs are allowed.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw guardError('That URL has no host.');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw guardError('That URL points to a local address, which is not allowed.');
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw guardError('That URL points to a private or reserved address, which is not allowed.');
    return url;
  }
  const resolve = deps.resolve || defaultResolve;
  let addresses;
  try {
    addresses = await resolve(host);
  } catch {
    throw guardError('That host could not be resolved.');
  }
  if (!addresses || addresses.length === 0) {
    throw guardError('That host could not be resolved.');
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw guardError('That URL resolves to a private or reserved address, which is not allowed.');
    }
  }
  return url;
}

/**
 * fetch() with SSRF validation on the initial URL and on every redirect hop.
 * Options: { headers, timeoutMs, maxRedirects, method, body, resolve, fetchImpl }
 * Returns the final Response (non-redirect). Throws guard errors (status 400)
 * for blocked URLs and a plain Error for too many redirects.
 */
async function fetchPublic(rawUrl, opts = {}) {
  const {
    headers = {},
    timeoutMs = 15000,
    maxRedirects = 5,
    method = 'GET',
    body,
    resolve,
    fetchImpl = fetch,
  } = opts;

  let current = String(rawUrl);
  let currentHeaders = { ...headers };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current, { resolve });
    const res = await fetchImpl(url.href, {
      method,
      body,
      headers: currentHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!isRedirect) return res;
    if (hop === maxRedirects) throw new Error('Too many redirects');
    const next = new URL(res.headers.get('location'), url.href);
    if (next.host !== url.host) {
      // Never leak credentials to a different host via redirect.
      const { Authorization, authorization, ...rest } = currentHeaders;
      currentHeaders = rest;
    }
    current = next.href;
  }
  throw new Error('Too many redirects');
}

module.exports = { assertPublicUrl, fetchPublic, isBlockedIp, isBlockedIpv4, isBlockedIpv6 };
