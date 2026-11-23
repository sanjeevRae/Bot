/**
 * Security regression suite for the 2026-11-23 hardening.
 *
 * Covers: visitor session tokens (expiry/tamper/legacy), the SSRF URL guard,
 * Notion host validation, Turnstile enforcement policy, the wa-pending feed
 * auth, the Meta webhook signature gate, auth middleware (missing token,
 * x-org-id switching, owner gate), widget/bot-page XSS escaping, and rate
 * limiter wiring. Everything runs offline against stubs and local servers —
 * no production contact, no real credentials.
 *
 * Run: npm run test:security   (from backend/)
 */
'use strict';

process.env.SESSION_SECRET = 'security-test-secret-security-test-1234';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key';
process.env.SUPABASE_ANON_KEY = 'dummy-anon-key';
process.env.RATE_LIMIT_PER_HOUR = '3'; // tiny, so the limiter test trips fast
process.env.WA_SESSION_WAIT_MS = '0';
delete process.env.META_APP_SECRET;
delete process.env.TURNSTILE_SECRET_KEY;
delete process.env.WA_PENDING_TOKEN;

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { execFileSync } = require('child_process');
const express = require('express');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}
function section(title) { console.log(`\n== ${title} ==`); }

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
async function req(srv, method, p, { headers = {}, body } = {}) {
  const { port } = srv.address();
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}

/** Run a snippet in a child node process with extra env (for config-at-require cases). */
function childTest(name, env, script) {
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ...env },
      cwd: path.join(__dirname, '..'),
      timeout: 30000,
    }).toString();
    check(name, out.includes('CHILD-OK'));
    if (!out.includes('CHILD-OK')) console.log('   child output:', out.slice(0, 300));
  } catch (e) {
    check(name, false);
    console.log('   child error:', String(e.stdout || e.message).slice(0, 300));
  }
}

// ---------------------------------------------------------------------------
section('Visitor session tokens');
// ---------------------------------------------------------------------------
{
  const { issueSession, verifySession } = require('../src/lib/sessionToken');
  const org = 'e37e6fef-c42b-4214-b4b7-c0910f7157da';
  const s = issueSession(org);
  check('fresh token verifies', verifySession(org, s.sessionId, s.sessionToken).ok === true);
  check('wrong org rejected', verifySession('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', s.sessionId, s.sessionToken).ok === false);
  check('tampered token rejected', verifySession(org, s.sessionId, s.sessionToken.slice(0, -2) + 'xx').ok === false);
  check('missing token rejected', verifySession(org, s.sessionId, '').ok === false);
  check('bad session id rejected', verifySession(org, 'not-a-uuid', s.sessionToken).reason === 'invalid_session_id');
  // Legacy v1 token (bare HMAC, no timestamp) must be rejected
  const v1 = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${org}.${s.sessionId}`).digest('base64url');
  check('legacy v1 token rejected', verifySession(org, s.sessionId, v1).ok === false);
  // Expired token (issued 25h ago, correctly signed) must be rejected as expired
  const old = Math.floor(Date.now() / 1000) - 25 * 3600;
  const h = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${org}.${s.sessionId}.${old}`).digest('base64url');
  check('expired token rejected as session_expired', verifySession(org, s.sessionId, `${old}.${h}`).reason === 'session_expired');
  // Future-dated token must be rejected
  const fut = Math.floor(Date.now() / 1000) + 3600;
  const hf = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${org}.${s.sessionId}.${fut}`).digest('base64url');
  check('future-dated token rejected', verifySession(org, s.sessionId, `${fut}.${hf}`).ok === false);
}

// ---------------------------------------------------------------------------
section('SSRF URL guard');
// ---------------------------------------------------------------------------
{
  const { assertPublicUrl, fetchPublic, isBlockedIp } = require('../src/lib/urlGuard');
  const publicResolver = async () => ['93.184.216.34'];
  const blockedUrls = [
    'http://127.0.0.1:8899/page', 'http://localhost:8899/', 'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://192.168.1.1/',
    'http://172.16.0.9/', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/',
    'ftp://example.com/x', 'file:///etc/passwd', 'gopher://example.com/',
  ];
  (async () => {
    for (const u of blockedUrls) {
      let blocked = false;
      try { await assertPublicUrl(u, { resolve: publicResolver }); } catch { blocked = true; }
      check(`blocked: ${u}`, blocked);
    }
    let dnsBlocked = false;
    try { await assertPublicUrl('http://sneaky.test/', { resolve: async () => ['10.1.2.3'] }); } catch { dnsBlocked = true; }
    check('hostname resolving to private IP blocked', dnsBlocked);
    const ok = await assertPublicUrl('https://ok.test/path', { resolve: publicResolver });
    check('public URL allowed', ok.href === 'https://ok.test/path');
    check('isBlockedIp: 8.8.8.8 public', isBlockedIp('8.8.8.8') === false);
    check('isBlockedIp: fe80::1 blocked', isBlockedIp('fe80::1') === true);
    check('isBlockedIp: public v6 allowed', isBlockedIp('2606:4700:4700::1111') === false);

    // Redirect into a private address must be blocked at the second hop.
    const redirectFetch = async (url) => {
      if (String(url).includes('good.test')) {
        return { status: 302, headers: { get: (h) => (h === 'location' ? 'http://127.0.0.1:8899/secret' : null) } };
      }
      throw new Error('should never be fetched');
    };
    let redirectBlocked = false;
    try {
      await fetchPublic('http://good.test/start', { resolve: publicResolver, fetchImpl: redirectFetch });
    } catch (e) { redirectBlocked = e.code === 'url_blocked'; }
    check('redirect to loopback blocked', redirectBlocked);

    // A normal 200 passes through untouched.
    const okFetch = async () => ({ status: 200, headers: { get: () => null } });
    const res = await fetchPublic('http://good.test/page', { resolve: publicResolver, fetchImpl: okFetch });
    check('public fetch passes through', res.status === 200);
  })().then(runHttpSections).catch((e) => { console.error(e); runHttpSections(); });
}

// ---------------------------------------------------------------------------
// HTTP sections (async) — invoked after the guard promises settle.
// ---------------------------------------------------------------------------
async function runHttpSections() {
  // -------------------------------------------------------------------------
  section('Notion import host validation');
  // -------------------------------------------------------------------------
  {
    const { importNotion } = require('../src/services/imports');
    for (const u of [
      'http://127.0.0.1:8899/page?ref=notion.so',
      'https://notion.so.evil.test/page',
      'https://evilnotion.so/page',
      'https://example.com/notion.so',
    ]) {
      let rejected = false;
      try { await importNotion({ organizationId: 'ORG', url: u, title: 't' }); }
      catch (e) { rejected = /Notion page URL/.test(e.message); }
      check(`notion rejected: ${u}`, rejected);
    }
  }

  // -------------------------------------------------------------------------
  section('Turnstile middleware (in-process cases)');
  // -------------------------------------------------------------------------
  {
    const { verifyTurnstile } = require('../src/middleware/turnstile');
    const mk = () => {
      const state = {};
      return {
        state,
        res: {
          status(c) { state.code = c; return this; },
          json(b) { state.body = b; return this; },
        },
      };
    };
    // Dev mode, unconfigured -> skipped
    let nextCalled = false;
    await verifyTurnstile({ body: {}, ip: '1.2.3.4' }, mk().res, () => { nextCalled = true; });
    check('dev + unconfigured skips check', nextCalled === true);
  }
  childTest('production + no TURNSTILE_SECRET_KEY fails closed (503)', {
    NODE_ENV: 'production', SESSION_SECRET: 'prod-test-secret-prod-test-secret-12',
  }, `
    const { verifyTurnstile } = require('./src/middleware/turnstile');
    const res = { status(c){ this.code=c; return this; }, json(b){ this.body=b; return this; } };
    verifyTurnstile({ body: {}, ip: '1.2.3.4' }, res, () => { console.log('NEXT-CALLED'); })
      .then(() => console.log(res.code === 503 ? 'CHILD-OK' : 'BAD ' + res.code));
  `);
  childTest('production boot refuses to start without SESSION_SECRET', {
    NODE_ENV: 'production', SESSION_SECRET: '',
  }, `
    try { require('./src/config'); console.log('BOOTED'); }
    catch (e) { console.log(/SESSION_SECRET is required/.test(e.message) ? 'CHILD-OK' : 'WRONG-ERROR'); }
  `);

  // -------------------------------------------------------------------------
  section('WA pending feed auth');
  // -------------------------------------------------------------------------
  {
    delete process.env.WA_PENDING_TOKEN;
    let router = require('../src/routes/waPending');
    let app = express(); app.use('/wa-pending', router);
    let srv = await listen(app);
    let r = await req(srv, 'GET', '/wa-pending');
    check('token unset -> feed disabled (503)', r.status === 503);
    srv.close();

    process.env.WA_PENDING_TOKEN = 'feed-secret-123';
    delete require.cache[require.resolve('../src/routes/waPending')];
    router = require('../src/routes/waPending');
    app = express(); app.use('/wa-pending', router);
    srv = await listen(app);
    r = await req(srv, 'GET', '/wa-pending');
    check('no header -> 401', r.status === 401);
    r = await req(srv, 'GET', '/wa-pending?token=feed-secret-123');
    check('query-string token NOT accepted -> 401', r.status === 401);
    r = await req(srv, 'GET', '/wa-pending', { headers: { 'x-wa-token': 'wrong' } });
    check('wrong header token -> 401', r.status === 401);
    r = await req(srv, 'GET', '/wa-pending', { headers: { 'x-wa-token': 'feed-secret-123' } });
    check('correct header token -> 200', r.status === 200 && r.json && 'new_messages' in r.json);
    srv.close();
    delete process.env.WA_PENDING_TOKEN;
  }

  // -------------------------------------------------------------------------
  section('Meta webhook gate (no app secret configured)');
  // -------------------------------------------------------------------------
  {
    const channels = require('../src/routes/channels');
    const app = express();
    app.use('/api/channels/webhook', express.raw({ type: '*/*', limit: '2mb' }));
    app.use('/api/channels', channels);
    const srv = await listen(app);
    let r = await req(srv, 'POST', '/api/channels/webhook', { body: { object: 'page', entry: [] } });
    check('unsigned POST with no META_APP_SECRET -> 503 (fail closed)', r.status === 503);
    r = await req(srv, 'GET', '/api/channels/webhook?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=abc');
    check('handshake with no META_VERIFY_TOKEN configured -> 403', r.status === 403);
    srv.close();
  }
  childTest('Meta webhook: valid signature processes, invalid rejected', {
    META_APP_SECRET: 'meta-test-secret', SESSION_SECRET: 'child-secret-child-secret-123456',
  }, `
    const crypto = require('crypto');
    const express = require('express');
    const channels = require('./src/routes/channels');
    const app = express();
    app.use('/api/channels/webhook', express.raw({ type: '*/*', limit: '2mb' }));
    app.use('/api/channels', channels);
    const srv = app.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      const payload = JSON.stringify({ object: 'unknown_object', entry: [] });
      const sig = 'sha256=' + crypto.createHmac('sha256', 'meta-test-secret').update(payload).digest('hex');
      const good = await fetch('http://127.0.0.1:' + port + '/api/channels/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body: payload });
      const bad = await fetch('http://127.0.0.1:' + port + '/api/channels/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' }, body: payload });
      const none = await fetch('http://127.0.0.1:' + port + '/api/channels/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      console.log(good.status === 200 && bad.status === 401 && none.status === 401 ? 'CHILD-OK' : 'BAD ' + good.status + '/' + bad.status + '/' + none.status);
      srv.close();
    });
  `);

  // -------------------------------------------------------------------------
  section('Auth middleware: token, x-org-id, owner gate');
  // -------------------------------------------------------------------------
  {
    // Flexible supabase stub, injected before the auth middleware loads.
    const db = {
      profile: { id: 'user-1', organization_id: 'ORG-A', role: 'member', is_platform_admin: false },
      orgs: {
        'ORG-A': { id: 'ORG-A', parent_org_id: null },
        'ORG-B': { id: 'ORG-B', parent_org_id: 'ORG-X' },
        'ORG-CHILD': { id: 'ORG-CHILD', parent_org_id: 'ORG-A' },
      },
    };
    const builder = (table) => {
      const b = { _table: table, _filters: {} };
      for (const m of ['select', 'order', 'limit', 'insert', 'update', 'delete', 'in', 'neq', 'gte', 'lte', 'is', 'not']) {
        b[m] = () => b;
      }
      b.eq = (col, val) => { b._filters[col] = val; return b; };
      b.single = b.maybeSingle = async () => {
        if (table === 'profiles') return { data: db.profile, error: null };
        if (table === 'organizations') return { data: db.orgs[b._filters.id] || null, error: null };
        return { data: null, error: null };
      };
      b.then = (resolve) => resolve({ data: [], error: null });
      return b;
    };
    const fakeSupabase = {
      from: (t) => builder(t),
      auth: {
        getUser: async (token) => (token === 'good-token'
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: { message: 'invalid' } }),
      },
    };
    const supabaseJsPath = require.resolve('@supabase/supabase-js');
    require.cache[supabaseJsPath] = {
      id: supabaseJsPath, filename: supabaseJsPath, loaded: true,
      exports: {
        createClient: () => ({
          auth: {
            getUser: async (token) => (token === 'good-token' || token === 'owner-token'
              ? { data: { user: { id: 'user-1', email: 't@example.com' } }, error: null }
              : { data: { user: null }, error: { message: 'invalid' } }),
          },
        }),
      },
      children: [], paths: [],
    };
    const supabasePath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
    require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fakeSupabase, children: [], paths: [] };

    const { requireAuth, requireOwner } = require('../src/middleware/auth');
    const app = express();
    app.use(express.json());
    app.get('/who', requireAuth, (req, res) => res.json({ orgId: req.orgId, role: req.role }));
    app.get('/owner-only', requireAuth, requireOwner, (req, res) => res.json({ ok: true }));
    const srv = await listen(app);

    let r = await req(srv, 'GET', '/who');
    check('missing token -> 401', r.status === 401);
    r = await req(srv, 'GET', '/who', { headers: { Authorization: 'Bearer bad-token' } });
    check('invalid token -> 401', r.status === 401);
    r = await req(srv, 'GET', '/who', { headers: { Authorization: 'Bearer good-token' } });
    check('valid token -> own org', r.status === 200 && r.json.orgId === 'ORG-A');
    r = await req(srv, 'GET', '/who', { headers: { Authorization: 'Bearer good-token', 'x-org-id': 'ORG-B' } });
    check('x-org-id to unrelated org ignored', r.status === 200 && r.json.orgId === 'ORG-A');
    r = await req(srv, 'GET', '/who', { headers: { Authorization: 'Bearer good-token', 'x-org-id': 'ORG-CHILD' } });
    check('x-org-id to own client org allowed', r.status === 200 && r.json.orgId === 'ORG-CHILD');
    r = await req(srv, 'GET', '/owner-only', { headers: { Authorization: 'Bearer good-token' } });
    check('member blocked from owner-only route (403)', r.status === 403);
    db.profile.role = 'owner';
    r = await req(srv, 'GET', '/owner-only', { headers: { Authorization: 'Bearer owner-token' } });
    check('owner allowed on owner-only route', r.status === 200);
    db.profile.role = 'member';
    srv.close();

    // -----------------------------------------------------------------------
    section('Widget / bot page XSS escaping');
    // -----------------------------------------------------------------------
    db.orgRow = { id: '11111111-1111-4111-8111-111111111111', name: '<script>alert(1)</script>' };
    db.settingsRow = { brand_color: '#111827', bot_name: '<img src=x onerror=alert(2)>', welcome_message: 'hi', white_label: false };
    const b2 = (table) => {
      const b = { _table: table };
      for (const m of ['select', 'order', 'limit', 'insert', 'update', 'delete', 'in', 'neq', 'is', 'not']) b[m] = () => b;
      b.eq = () => b;
      b.single = async () => (table === 'organizations' ? { data: db.orgRow, error: null } : { data: null, error: null });
      b.maybeSingle = async () => (table === 'settings' ? { data: db.settingsRow, error: null } : { data: null, error: null });
      b.then = (resolve) => resolve({ data: [], error: null });
      return b;
    };
    fakeSupabase.from = (t) => b2(t);
    delete require.cache[require.resolve('../src/routes/widget')];
    const widget = require('../src/routes/widget');
    const wapp = express();
    wapp.use('/', widget);
    const wsrv = await listen(wapp);
    r = await req(wsrv, 'GET', '/bot/11111111-1111-4111-8111-111111111111');
    check('bot page escapes org name in title/h1', r.status === 200 && !r.text.includes('<script>alert(1)</script>') && r.text.includes('&lt;script&gt;alert(1)'));
    r = await req(wsrv, 'GET', '/widget.js?org=11111111-1111-4111-8111-111111111111');
    check('widget script sets bot name via textContent', r.status === 200 && r.text.includes("textContent = BOT_NAME") && r.text.includes('id="chitra-bot-name"'));
    check('widget script no longer concatenates BOT_NAME into innerHTML', !r.text.includes("'<span>'+BOT_NAME+'</span>'") && !r.text.includes('<span>\'+BOT_NAME+\'</span>'));
    wsrv.close();
  }

  // -------------------------------------------------------------------------
  section('Rate limiting');
  // -------------------------------------------------------------------------
  {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    check('server mounts apiLimiter on /api/org', src.includes("app.use('/api/org', apiLimiter"));
    check('server mounts ingestLimiter on crawl', src.includes("'/api/knowledge/crawl'"));
    const { apiLimiter } = require('../src/middleware/rateLimit');
    const app = express();
    app.use('/api/org', apiLimiter);
    app.get('/api/org/me', (req, res) => res.json({ ok: true }));
    const srv = await listen(app);
    let last = 0;
    for (let i = 0; i < 5; i++) {
      const r = await req(srv, 'GET', '/api/org/me');
      last = r.status;
      if (i === 3) check('4th request within the hour is rate-limited (429)', r.status === 429);
    }
    check('limiter keeps rejecting', last === 429);
    srv.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
