/**
 * Offline test for the Muse-mode WhatsApp hook (V13) — the `WHATSAPP_AUTO_REPLY`
 * switch, the pending counter behind `GET /wa-pending`, and the outbound-echo
 * acknowledgement that clears a chat.
 *
 * Why this exists: in Muse mode the backend must never answer WhatsApp. A single
 * stray `handleInbound()` call would put the bot and Muse in a reply race again —
 * exactly what the switch was added to stop — and a pending counter that never
 * clears would make Muse re-read the same chats forever. Both are invisible from
 * the phone, so they are pinned down here.
 *
 * Runs the REAL webhook route (signed HMAC payloads, as OpenWA sends them) against
 * a stubbed Supabase client, then reads the REAL public endpoint. No credentials,
 * no gateway, no DB.
 *
 * Run: npm run test:unit   (from backend/)
 */
process.env.WHATSAPP_AUTO_REPLY = 'off';              // the flag under test (default)
process.env.OPENWA_WEBHOOK_SECRET = 'test-secret-0123456789';
process.env.OPENWA_BASE_URL = 'http://openwa.test';    // mocked gateway (see the fetch stub)
process.env.OPENWA_API_KEY = 'test-key';
process.env.WA_SESSION_WAIT_MS = '0';                  // status poll never waits

const path = require('path');
const crypto = require('crypto');
const express = require('express');

// ---------- Gateway stub ----------
// The OpenWA client talks to OPENWA_BASE_URL through global fetch. Intercepting
// only that host leaves the test's own calls to the local express server alone.
// `gateway.status` / `gateway.startError` are scripted per check: the point under
// test is that Reconnect follows the gateway's truth instead of forcing /start.
// `gateway.participants` is the group roster the mention gate learns our own
// `@lid` from; `gateway.webhooks` drives the repair checks.
const realFetch = global.fetch;
const gateway = {
  calls: [],
  status: 'CONNECTED',   // what GET /api/sessions/:id reports
  startError: null,      // when set, POST .../start fails with this message
  session: { phone: '9779712039906', pushName: 'Chitra AI' },
  participants: [],      // group roster entries { number, id } for GET .../groups/:id
  webhooks: [],          // what GET .../webhooks lists
  registered: [],        // POST /webhooks bodies seen here
  deleted: [],           // DELETE /webhooks/:id calls seen here
};
function gatewaySessionBody() {
  return { ...gateway.session, status: gateway.status };
}
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://openwa.test')) {
    const method = (opts && opts.method) || 'GET';
    gateway.calls.push(`${method} ${u}`);
    const m = u.match(/\/api\/sessions\/([^/]+)(\/.*)?$/);
    const rest = (m && m[2]) || '';
    if (method === 'DELETE' && rest.startsWith('/webhooks/')) {
      gateway.deleted.push(decodeURIComponent(rest.slice('/webhooks/'.length)));
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    }
    if (rest === '/webhooks' && method === 'POST') {
      try { gateway.registered.push(JSON.parse((opts && opts.body) || '{}')); } catch { /* ignore */ }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    }
    if (rest === '/webhooks') {
      return { ok: true, status: 200, text: async () => JSON.stringify(gateway.webhooks) };
    }
    if (rest.startsWith('/groups/')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ participants: gateway.participants }),
      };
    }
    if (rest === '/start' && gateway.startError) {
      return { ok: false, status: 409, text: async () => JSON.stringify({ message: gateway.startError }) };
    }
    if (rest === '/start') {
      return { ok: true, status: 200, text: async () => JSON.stringify({}) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(gatewaySessionBody()) };
  }
  return realFetch(url, opts);
};

// ---------- Supabase stub: mode lookup vs. the reply pipeline ----------
// Two different reads happen against `whatsapp_connections`:
//   * lib/waMode.js reads the org's `auto_reply_enabled` switch (kind 'mode'),
//   * bot mode resolves the org to run the RAG/Groq reply pipeline, and that
//     select always carries `organization_id` (kind 'org').
// Counting them separately is what lets the test prove both halves: Muse mode
// never starts the reply pipeline, and `autoReply: true` still does.
// ---------- wa_pending_messages: a real (in-memory) table ----------
// The durable store is the fix for the reported loss, so it is simulated
// faithfully: upsert is idempotent on event_key, updates mark rows handled, and
// the builder is awaitable exactly like a PostgREST query. The V15 detail
// columns ride along in op.payload (spread into the row), so group-mention
// details survive the round trip the same way.
const pendingDb = { rows: [], nextId: 1 };
const rowMatches = (row, filters) => filters.every(([op, col, val]) => {
  if (op === 'eq') return String(row[col]) === String(val);
  if (op === 'lt') return Date.parse(row[col]) < Date.parse(val);
  if (op === 'in') return val.map(String).includes(String(row[col]));
  return true;
});

function runPending(op) {
  const rows = fakeSupabase.pendingRows;
  if (op.kind === 'upsert') {
    const key = op.conflict;
    const seen = rows.some((r) => String(r[key]) === String(op.payload[key]));
    if (seen) return { data: [], error: null };   // ignoreDuplicates
    const row = {
      id: pendingDb.nextId++,
      status: 'pending',
      is_group: false,
      handled_at: null,
      received_at: new Date().toISOString(),
      ...op.payload,
    };
    rows.push(row);
    return { data: [{ id: row.id }], error: null };
  }
  const hits = rows.filter((r) => rowMatches(r, op.filters));
  if (op.kind === 'update') {
    hits.forEach((r) => Object.assign(r, op.payload));
    return { data: hits.map((r) => ({ id: r.id, chat_id: r.chat_id })), error: null };
  }
  if (op.kind === 'delete') {
    fakeSupabase.pendingRows = rows.filter((r) => !hits.includes(r));
    return { data: null, error: null };
  }
  return { data: hits.slice(0, op.limit), error: null };
}

function pendingTable() {
  const op = { kind: 'select', filters: [], payload: null, conflict: null, limit: 5000 };
  const b = {
    select: () => b,
    upsert: (row, opts) => { op.kind = 'upsert'; op.payload = row; op.conflict = (opts && opts.onConflict) || 'id'; return b; },
    update: (patch) => { op.kind = 'update'; op.payload = patch; return b; },
    delete: () => { op.kind = 'delete'; return b; },
    eq: (c, v) => { op.filters.push(['eq', c, v]); return b; },
    lt: (c, v) => { op.filters.push(['lt', c, v]); return b; },
    in: (c, v) => { op.filters.push(['in', c, v]); return b; },
    order: () => b,
    limit: (n) => { op.limit = n; return b; },
    then: (resolve) => resolve(runPending(op)), // await builder → the query result
  };
  return b;
}

const fakeSupabase = {
  orgLookups: 0,          // reply pipeline reached (would send a WhatsApp reply)
  modeReads: 0,           // the V13 switch was read
  autoReplyEnabled: false, // what the Channels toggle "stores"
  rowStatus: 'connected',  // whatsapp_connections.status (the Disconnect soft switch)
  phoneNumber: '9779712039906', // the stored session number behind mention matching
  hasColumn: true,        // false → a deploy that predates migration_v13
  mapped: true,           // false → no whatsapp_connections row for the session
  patches: [],            // what /settings wrote
  pendingRows: [],        // the wa_pending_messages table (durable store)
  from(table) {
    // The durable pending store gets a real (in-memory) table so the test can
    // prove a count survives a reset — the exact case that lost the 12:46 message.
    if (table === 'wa_pending_messages') return pendingTable();
    const b = { _kind: 'other' };
    ['eq', 'neq', 'insert', 'order', 'limit'].forEach((m) => { b[m] = () => b; });
    b.select = (cols) => {
      const c = String(cols == null ? '' : cols);
      // `organization_id` alone is lib/waPending.js tagging a pending row with its
      // org (not a reply); the reply pipeline's org resolution selects the whole
      // connection row, so it is the one that carries other columns too.
      if (c === 'organization_id') b._kind = 'orgtag';
      else if (c.includes('organization_id')) { fakeSupabase.orgLookups += 1; b._kind = 'org'; }
      else if (c.includes('auto_reply_enabled')) { fakeSupabase.modeReads += 1; b._kind = 'mode'; }
      else if (c === '*') b._kind = 'conn';
      else if (c.includes('phone_number')) b._kind = 'identity';
      else if (c.includes('openwa_session_id')) b._kind = 'session';
      return b;
    };
    b.update = (patch) => {
      fakeSupabase.patches.push(patch);
      if ('auto_reply_enabled' in patch) {
        // Saving the toggle is what migration_v13 enables — mirror PostgREST's
        // "column does not exist" so the migration hint can be tested.
        if (!fakeSupabase.hasColumn) {
          b.error = { message: 'column "auto_reply_enabled" does not exist' };
        } else {
          fakeSupabase.autoReplyEnabled = patch.auto_reply_enabled === true;
        }
      }
      // Disconnect / Reconnect write `status` — the soft switch under test.
      if ('status' in patch) fakeSupabase.rowStatus = patch.status;
      return b; // `await` on a non-thenable yields this object, so `b.error` is the result
    };
    b.single = b.maybeSingle = async () => {
      if (b._kind === 'orgtag') {
        // Tagging a pending row: the org the session belongs to.
        return fakeSupabase.mapped ? { data: { organization_id: 'ORG-1' }, error: null } : { data: null, error: null };
      }
      if (b._kind === 'mode') {
        if (!fakeSupabase.hasColumn) {
          return { data: null, error: { message: 'column "auto_reply_enabled" does not exist' } };
        }
        if (!fakeSupabase.mapped) return { data: null, error: null };
        return { data: { auto_reply_enabled: fakeSupabase.autoReplyEnabled, status: fakeSupabase.rowStatus }, error: null };
      }
      if (b._kind === 'conn') {
        // `select('*')` on the org's connection row — what GET /status reads.
        return fakeSupabase.mapped
          ? {
            data: {
              id: 'CONN-1',
              openwa_session_id: 'chitra-ai',
              phone_number: fakeSupabase.phoneNumber,
              status: fakeSupabase.rowStatus,
              group_replies_enabled: true,
              auto_reply_enabled: fakeSupabase.autoReplyEnabled,
            },
            error: null,
          }
          : { data: null, error: null };
      }
      if (b._kind === 'identity') {
        // The mention gate's own-number read (routes/openwa.js ownNumberFor).
        return fakeSupabase.mapped
          ? { data: { phone_number: fakeSupabase.phoneNumber }, error: null }
          : { data: null, error: null };
      }
      if (b._kind === 'session') {
        // The connection row: `id` for the settings update, the session id for the
        // pending feed's readiness/mode lookups.
        return fakeSupabase.mapped
          ? { data: { id: 'CONN-1', openwa_session_id: 'chitra-ai' }, error: null }
          : { data: null, error: null };
      }
      // Org resolution: no connection mapped → bot mode stops here, before any
      // LLM call or send (the reply-pipeline marker has already been counted).
      return { data: null, error: null };
    };
    return b;
  },
  auth: { getUser: async () => ({ data: { user: null }, error: null }) },
};
const supabasePath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true, exports: fakeSupabase, children: [], paths: [],
};

// ---------- Auth stub: the org-scoped settings route without a real JWT ----------
const authPath = require.resolve(path.join(__dirname, '..', 'src', 'middleware', 'auth'));
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: { requireAuth: (req, res, next) => { req.orgId = 'ORG-1'; next(); } },
  children: [],
  paths: [],
};

const config = require('../src/config');
const waMode = require('../src/lib/waMode');
const waPending = require('../src/lib/waPending');
const { webhookRouter, orgRouter } = require('../src/routes/openwa');
const waPendingRoutes = require('../src/routes/waPending');

const app = express();
// Mirrors server.js: the webhook needs the RAW body for HMAC, then JSON parsing.
app.use('/api/webhooks/openwa', express.raw({ type: '*/*', limit: '2mb' }));
app.use(express.json());
app.use('/api/webhooks', webhookRouter);
app.use('/api/org/openwa', orgRouter);
app.use('/wa-pending', waPendingRoutes);
app.use('/api/wa-pending', waPendingRoutes);

// ---------- tiny test harness (same shape as the other e2e tests) ----------
let failures = 0;
function check(label, ok, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  -> ' + extra : ''));
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch (e) { /* keep polling */ }
    await sleep(25);
  }
  return false;
}

const SESSION = 'chitra-ai';
const CHAT_A = '9779810135468@c.us';
const CHAT_B = '9779800000002@c.us';
const GROUP = '120363000000000000@g.us';

let seq = 0;
function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', process.env.OPENWA_WEBHOOK_SECRET).update(body).digest('hex');
}

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;

  const pending = async () => (await fetch(`${base}/wa-pending`)).json();

  /** POST a signed OpenWA delivery exactly like the gateway does. */
  async function deliver(payload, { signed = true } = {}) {
    const body = Buffer.from(JSON.stringify(payload));
    const headers = { 'Content-Type': 'application/json' };
    if (signed) headers['X-OpenWA-Signature'] = sign(body);
    return fetch(`${base}/api/webhooks/openwa`, { method: 'POST', headers, body });
  }

  /** An incoming customer message. */
  function incoming(chatId, opts = {}) {
    seq += 1;
    return {
      event: 'message.received',
      sessionId: SESSION,
      idempotencyKey: opts.idempotencyKey || `incoming-${seq}`,
      data: {
        id: `MSG-${seq}`,
        chatId,
        from: opts.from || chatId,
        body: opts.body || 'hello',
        type: 'text',
        fromMe: false,
        ...(opts.data || {}),
      },
    };
  }

  /** Our own (Muse's) outgoing message echoed back by the gateway. */
  function outgoing(chatId, opts = {}) {
    seq += 1;
    return {
      event: 'message.received',
      sessionId: SESSION,
      idempotencyKey: `outgoing-${seq}`,
      data: {
        id: `MSG-${seq}`,
        chatId,
        from: opts.from || '9779712039906@c.us',
        to: chatId,
        body: 'Here is my answer',
        type: 'text',
        fromMe: true,
      },
    };
  }

  try {
    // ==================== 1. the switch defaults to off ====================
    check('WHATSAPP_AUTO_REPLY defaults to off (Muse mode)', config.openwa.autoReply === false,
      `autoReply=${config.openwa.autoReply}`);

    const zero = await pending();
    check('GET /wa-pending answers with the agreed shape',
      zero.new_messages === 0 && Array.isArray(zero.pending_chats) && zero.pending_chats.length === 0
      && zero.session_ready === true && zero.mode === 'muse',
      JSON.stringify(zero));
    check('the feed carries counts and chat ids only — never message text',
      !JSON.stringify(zero).includes('hello') && !('messages' in zero) && !('body' in zero));
    check('the feed is also served under /api/wa-pending',
      (await fetch(`${base}/api/wa-pending`)).ok);

    // ==================== 2. signature is enforced ====================
    const unsigned = await deliver(incoming(CHAT_A), { signed: false });
    check('an unsigned delivery is rejected (401)', unsigned.status === 401, `status=${unsigned.status}`);
    await sleep(50);
    check('a rejected delivery is not counted', (await pending()).new_messages === 0);


    // ==================== 3. incoming messages are counted per chat ====================
    await deliver(incoming(CHAT_A));
    await until(async () => (await pending()).new_messages === 1);
    let p = await pending();
    check('a new message shows up as pending', p.new_messages === 1 && p.pending_chats[0] === CHAT_A,
      JSON.stringify(p));

    await deliver(incoming(CHAT_A, { body: 'second line' }));
    await until(async () => (await pending()).new_messages === 2);
    p = await pending();
    check('two messages in one chat = 2 pending, 1 chat (the { chat: 2 } contract)',
      p.new_messages === 2 && p.pending_chats.length === 1, JSON.stringify(p));

    // A retry of the same delivery (OpenWA reuses the payload) must not
    // double-count — the durable store dedupes on the event key.
    const retried = incoming(CHAT_B, { idempotencyKey: 'retry-me' });
    await deliver(retried);
    await deliver(retried);
    await until(async () => (await pending()).new_messages === 3);
    p = await pending();
    check('a retried delivery (same idempotency key) is counted once',
      p.new_messages === 3 && p.pending_chats.length === 2, JSON.stringify(p));
    check('pending_chats lists the most recently active chat first', p.pending_chats[0] === CHAT_B,
      JSON.stringify(p.pending_chats));

    // ---------- 4. the backend never replied ----------
    check('Muse mode never reached the Supabase reply pipeline (org lookup)', fakeSupabase.orgLookups === 0,
      `orgLookups=${fakeSupabase.orgLookups}`);

    // ==================== 5. outbound echo clears the chat ====================
    await deliver(outgoing(CHAT_B));
    await until(async () => (await pending()).new_messages === 2);
    p = await pending();
    check("Muse's own outbound message clears that chat's pending entry",
      p.new_messages === 2 && p.pending_chats.length === 1 && p.pending_chats[0] === CHAT_A,
      JSON.stringify(p));

    // An outbound echo can carry a privacy-id chat form; it must never add a chat.
    await deliver(outgoing('248065197879524@lid', { from: '9779712039906@lid' }));
    check('an outbound echo never adds a chat (fromMe is not an inbound message)',
      (await pending()).pending_chats.length === 1);
    // The same conversation can be addressed as @lid on one side and @c.us on the
    // other (privacy ids), so clearing falls back to the digits of the JID.
    // CHAT_B was cleared above, so clearing CHAT_A empties the feed.
    await deliver(incoming(CHAT_A));
    await until(async () => (await pending()).new_messages === 3);
    await deliver(outgoing('9779810135468@lid'));
    await until(async () => (await pending()).new_messages === 0);
    check('a @lid-form outbound echo still clears the @c.us pending chat',
      (await pending()).pending_chats.length === 0, JSON.stringify(await pending()));

    // The OLD group contract ("every group line counts") is gone: in a busy team
    // group only a line that @-mentions the bot is work for Muse, so plain chatter
    // must add nothing (section 12 covers the mention path).
    const beforeChatter = (await pending()).new_messages;
    await deliver(incoming(GROUP, { from: GROUP, data: { isGroup: true, author: '9779810135468@c.us' } }));
    await sleep(150);
    p = await pending();
    check('group chatter without a mention of the bot is not counted',
      p.new_messages === beforeChatter && !p.pending_chats.includes(GROUP), JSON.stringify(p));



    // ==================== 6. session readiness ====================
    await deliver({ event: 'session.disconnected', sessionId: SESSION, data: { status: 'disconnected' } });
    await until(async () => (await pending()).session_ready === false);
    check('a session going down reports session_ready:false (the outage alert trigger)',
      (await pending()).session_ready === false);

    await deliver({ event: 'session.connected', sessionId: SESSION, data: { status: 'CONNECTED' } });
    await until(async () => (await pending()).session_ready === true);
    check('a session coming back reports session_ready:true', (await pending()).session_ready === true);

    await deliver({ event: 'session.status', sessionId: SESSION, data: { status: 'disconnected' } });
    await until(async () => (await pending()).session_ready === false);
    check('a status event carrying a down status flips readiness',
      (await pending()).session_ready === false);

    await deliver(incoming(CHAT_A));
    await until(async () => (await pending()).session_ready === true);
    check('an incoming message proves the link is up again', (await pending()).session_ready === true);

    // ==================== 7. readiness never blocks the feed ====================
    const t0 = Date.now();
    await fetch(`${base}/wa-pending`);
    const elapsed = Date.now() - t0;
    check('the feed stays fast (one in-memory read, no gateway call on the hot path)',
      elapsed < 250, `${elapsed}ms`);

    // ==================== 8. the dashboard toggle (V13) ====================
    // POST /api/org/openwa/settings { autoReply } is what the Channels page's
    // switch calls. On = this backend answers (original path), off = Muse mode.
    await waPending.clearPending();   // deterministic starting point
    await deliver(incoming(CHAT_A));
    await until(async () => (await pending()).new_messages === 1);

    let res = await fetch(`${base}/api/org/openwa/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoReply: true }),
    });
    let body = await res.json();
    check('toggle to Chitra: /settings saves it and reports bot mode',
      res.status === 200 && body.autoReply === true && body.mode === 'bot' && body.autoReplySource === 'org',
      JSON.stringify(body));
    check('toggle to Chitra: the column was written',
      fakeSupabase.patches.some((p) => p.auto_reply_enabled === true),
      JSON.stringify(fakeSupabase.patches));

    p = await pending();
    check('toggle to Chitra: pending messages are NOT dropped (only an observed reply clears them)',
      p.new_messages === 1 && p.pending_chats[0] === CHAT_A, JSON.stringify(p));
    check('toggle to Chitra: the feed says mode "bot" so Muse stands down', p.mode === 'bot', p.mode);

    const beforeBot = fakeSupabase.orgLookups;
    await deliver(incoming(CHAT_A));
    await until(() => fakeSupabase.orgLookups > beforeBot, 2000);
    check('toggle to Chitra: incoming messages reach the reply pipeline again',
      fakeSupabase.orgLookups > beforeBot, `orgLookups=${fakeSupabase.orgLookups}`);
    await sleep(50);
    check('toggle to Chitra: the new message is not counted for Muse (the bot answers it)',
      (await pending()).new_messages === 1);

    // ...and switching back must not need a deploy.
    res = await fetch(`${base}/api/org/openwa/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoReply: false }),
    });
    body = await res.json();
    check('toggle back to Muse: /settings reports muse mode',
      res.status === 200 && body.autoReply === false && body.mode === 'muse',
      JSON.stringify(body));
    check('toggle back to Muse: the feed follows immediately', (await pending()).mode === 'muse');

    await deliver(incoming(CHAT_A));
    await until(async () => (await pending()).new_messages === 2);
    p = await pending();
    check('toggle back to Muse: counting resumes (the untouched row stays, the new one is added)',
      p.new_messages === 2 && p.mode === 'muse', JSON.stringify(p));

    res = await fetch(`${base}/api/org/openwa/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('an empty settings payload is rejected (400)', res.status === 400, `status=${res.status}`);

    // Before migration_v13 the switch cannot be saved, and the safe direction is
    // Muse mode: no reply is ever sent while the column is missing.
    fakeSupabase.hasColumn = false;
    waMode.invalidate(SESSION);
    res = await fetch(`${base}/api/org/openwa/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoReply: true }),
    });
    body = await res.json();
    check('without migration_v13 the toggle explains itself instead of failing silently',
      res.status === 500 && /migration_v13/.test(body.error || ''), JSON.stringify(body));
    const beforeMissing = fakeSupabase.orgLookups;
    await deliver(incoming(CHAT_A));
    await until(async () => (await pending()).new_messages >= 1);
    check('a deploy without migration_v13 stays in Muse mode (no reply, no race)',
      fakeSupabase.orgLookups === beforeMissing && (await pending()).mode === 'muse',
      `orgLookups=${fakeSupabase.orgLookups}`);
    fakeSupabase.hasColumn = true;

    // ==================== 9. the env override keeps the old bot intact ====================
    // WHATSAPP_AUTO_REPLY=on must force bot mode regardless of the dashboard, so
    // the ops rollback stays a single flag flip.
    const beforeEnv = fakeSupabase.orgLookups;
    config.openwa.autoReply = true;
    await deliver(incoming(CHAT_A));
    await until(() => fakeSupabase.orgLookups > beforeEnv, 2000);
    check('WHATSAPP_AUTO_REPLY=on overrides the dashboard and restores the original auto-reply path',
      fakeSupabase.orgLookups > beforeEnv, `orgLookups=${fakeSupabase.orgLookups}`);
    check('with the env override on, the feed reports mode "bot" (and the toggle is ignored)',
      (await pending()).mode === 'bot');
    config.openwa.autoReply = false;
    waMode.invalidate(SESSION);

    // ============ 10. Disconnect must actually stay disconnected ============
    // Reported bug: clicking Disconnect left the card saying "Connected", because
    // `connected` only meant "a session id is saved". Now the owner's soft switch
    // decides the badge AND stops the backend from answering.
    fakeSupabase.autoReplyEnabled = true;  // Chitra mode — the bug would send a reply
    fakeSupabase.rowStatus = 'connected';
    waMode.invalidate(SESSION);
    await waPending.clearPending();

    let st = (await (await fetch(`${base}/api/org/openwa/status`)).json()).openwa;
    check('/status: a connected session is linked + connected + answering',
      st.linked === true && st.connected === true && st.disconnectedByOwner === false
      && st.autoReply === true && st.mode === 'bot' && st.autoReplySuspended === false,
      JSON.stringify(st));

    let d = await (await fetch(`${base}/api/org/openwa/disconnect`, { method: 'POST' })).json();
    check('POST /disconnect switches the session off and reports it',
      d.ok === true && d.autoReply === true && d.autoReplySuspended === true && d.mode === 'muse',
      JSON.stringify(d));

    st = (await (await fetch(`${base}/api/org/openwa/status`)).json()).openwa;
    check('/status no longer claims Connected after Disconnect (the reported bug)',
      st.linked === true && st.connected === false && st.disconnectedByOwner === true
      && st.status === 'disconnected', JSON.stringify(st));

    // The soft switch has to mean something on the wire, not just in the badge.
    const beforeOff = fakeSupabase.orgLookups;
    await deliver(incoming(CHAT_A));
    await until(async () => (await pending()).new_messages === 1);
    check('a disconnected session answers nothing (reply pipeline untouched, message counted)',
      fakeSupabase.orgLookups === beforeOff && (await pending()).new_messages === 1,
      `orgLookups=${fakeSupabase.orgLookups}`);
    check('the pending feed reports muse mode while the backend is switched off',
      (await pending()).mode === 'muse');

    // The gateway is already up (the owner's switch is what is off): Reconnect
    // reconciles the row instead of blindly forcing /start — the exact failure
    // the user hit ("Session is already started" → 502 → row stuck at
    // 'disconnected' forever).
    gateway.status = 'CONNECTED';
    const startsBefore = gateway.calls.filter((c) => c.includes('/start')).length;
    d = await (await fetch(`${base}/api/org/openwa/reconnect`, { method: 'POST' })).json();
    check('POST /reconnect on an already-started session succeeds without forcing /start',
      d.ok === true && d.mode === 'bot' && d.autoReply === true && d.autoReplySuspended === false,
      JSON.stringify(d));
    check('reconnect asked the gateway first and skipped /start when it was already up',
      gateway.calls.some((c) => c.includes(`/api/sessions/${SESSION}`) && !c.includes('/start'))
      && gateway.calls.filter((c) => c.includes('/start')).length === startsBefore,
      gateway.calls.join(' | '));

    st = (await (await fetch(`${base}/api/org/openwa/status`)).json()).openwa;
    check('/status: connected again after Reconnect',
      st.connected === true && st.disconnectedByOwner === false && st.mode === 'bot',
      JSON.stringify(st));

    // ...but when the gateway really is down, /start is called exactly once.
    fakeSupabase.rowStatus = 'disconnected';
    waMode.invalidate(SESSION);
    gateway.status = 'STOPPED';
    const startsDown = gateway.calls.filter((c) => c.includes('/start')).length;
    d = await (await fetch(`${base}/api/org/openwa/reconnect`, { method: 'POST' })).json();
    check('POST /reconnect calls /start exactly once when the gateway is down',
      d.ok === true && d.mode === 'bot'
      && gateway.calls.filter((c) => c.includes('/start')).length === startsDown + 1,
      JSON.stringify(d));

    // ...and a broken session still 502s with the real message instead of
    // silently flipping the row to 'connected'.
    fakeSupabase.rowStatus = 'disconnected';
    waMode.invalidate(SESSION);
    gateway.startError = 'Session 03bc39c2 does not exist';
    const fails = await fetch(`${base}/api/org/openwa/reconnect`, { method: 'POST' });
    const failBody = await fails.json();
    check('POST /reconnect fails honestly (502 + gateway message) when the session is broken',
      fails.status === 502 && /does not exist/.test(failBody.error || ''), JSON.stringify(failBody));
    gateway.startError = null;
    st = (await (await fetch(`${base}/api/org/openwa/status`)).json()).openwa;
    check('a failed reconnect leaves the row disconnected (no false green)',
      st.connected === false && st.disconnectedByOwner === true, JSON.stringify(st));

    fakeSupabase.rowStatus = 'connected';
    waMode.invalidate(SESSION);

    const beforeOn = fakeSupabase.orgLookups;
    await deliver(incoming(CHAT_A));
    await until(() => fakeSupabase.orgLookups > beforeOn, 2000);
    check('after Reconnect the reply pipeline is reachable again',
      fakeSupabase.orgLookups > beforeOn, `orgLookups=${fakeSupabase.orgLookups}`);

    // Leave the stub in its default state (Muse mode, connected).
    fakeSupabase.autoReplyEnabled = false;
    fakeSupabase.rowStatus = 'connected';
    waMode.invalidate(SESSION);

    // ============ 11. a counted message can never be lost (the 12:46 report) ============
    // Reported: a genuine inbound ("test", new waMessageId) was counted —
    //   [OpenWA] Message counted for Muse { …, pending: 1, suspended: true }
    // — yet GET /wa-pending stayed at 0 on every poll afterwards. "suspended" is
    // NOT dedup and NOT "ignored": it only means the owner had switched the bot
    // off (whatsapp_connections.status = 'disconnected'). The message was counted
    // in memory, the service restarted around then (a deploy), and the count died
    // with the process — the webhook had already been acknowledged, so OpenWA
    // never redelivered it. Both halves are pinned down here.
    fakeSupabase.autoReplyEnabled = false;
    fakeSupabase.rowStatus = 'disconnected';       // the owner had hit Disconnect
    waMode.invalidate(SESSION);
    await waPending.clearPending();

    const msgId = 'false_202229004943510@lid_ACA8EFD57D7C210614E34A7D9DD2618A';
    const incident = incoming('202229004943510@lid', { body: 'test', data: { id: msgId } });
    const orgLookupsBefore = fakeSupabase.orgLookups;
    await deliver(incident);
    await until(async () => (await pending()).new_messages === 1);
    let incidentFeed = await pending();
    check('a message arriving while the session is switched off is still counted (botOff ≠ ignored)',
      incidentFeed.new_messages === 1 && incidentFeed.pending_chats[0] === '202229004943510@lid',
      JSON.stringify(incidentFeed));
    check('it is stored durably, and the bot still answers nothing',
      fakeSupabase.pendingRows.filter((r) => r.status === 'pending').length === 1
      && fakeSupabase.orgLookups === orgLookupsBefore,
      `rows=${fakeSupabase.pendingRows.length} orgLookups=${fakeSupabase.orgLookups}`);

    // THE RESTART: process memory gone, database intact — exactly a Render deploy.
    waPending.reset();
    waMode.reset();
    const afterRestart = await pending();
    check('the pending message SURVIVES a service restart (the reported bug)',
      afterRestart.new_messages === 1 && afterRestart.pending_chats[0] === '202229004943510@lid',
      JSON.stringify(afterRestart));

    // OpenWA retrying the same payload after the restart must not double-count:
    // the old in-memory dedupe could never have caught that.
    await deliver(incident);
    await sleep(100);
    check('a redelivered payload is not counted twice (idempotent across restarts)',
      (await pending()).new_messages === 1, JSON.stringify(await pending()));

    // ...and Muse's reply still clears it, after the restart.
    await deliver(outgoing('202229004943510@lid', { from: '9779712039906@lid' }));
    await until(async () => (await pending()).new_messages === 0);
    incidentFeed = await pending();
    check("Muse's reply clears the chat even after a restart (rows are settled, not forgotten)",
      incidentFeed.new_messages === 0
      && fakeSupabase.pendingRows.every((r) => r.status !== 'pending'),
      JSON.stringify(incidentFeed));

    // Two messages two minutes apart are two messages: nothing here dedupes by
    // chat, body or recency.
    await deliver(incoming('202229004943510@lid', { body: 'first' }));
    await deliver(incoming('202229004943510@lid', { body: 'second' }));
    await until(async () => (await pending()).new_messages === 2);
    incidentFeed = await pending();
    check('two messages from the same chat in quick succession both surface',
      incidentFeed.new_messages === 2 && incidentFeed.pending_chats.length === 1,
      JSON.stringify(incidentFeed));

    fakeSupabase.rowStatus = 'connected';
    waMode.invalidate(SESSION);
    await waPending.clearPending();

    // ============ 12. group mentions reach the feed in Muse mode ============
    // Reported 2026-09-30 ~20:05 NPT: "@248065197879524 recommend some good
    // business names" in 120363428240535325@g.us never surfaced — feed stayed 0.
    const GROUP_ID = '120363428240535325@g.us';
    const MENTION_LID = '248065197879524@lid';
    fakeSupabase.autoReplyEnabled = false;
    fakeSupabase.rowStatus = 'connected';
    fakeSupabase.phoneNumber = '9779712039906';
    waMode.invalidate(SESSION);
    await waPending.clearPending();
    gateway.participants = [{ number: '9779712039906', id: MENTION_LID }];

    // (d) Plain chatter in the group is NOBODY's work: never written, never a reply.
    const orgBeforeNoise = fakeSupabase.orgLookups;
    const sendsBefore = gateway.calls.filter((c) => c.includes('/messages/send-text')).length;
    await deliver(incoming(GROUP_ID, {
      body: 'hey team, lunch tomorrow?',
      data: { author: '149959471063139@lid', senderName: 'Teammate' },
    }));
    await sleep(150);
    check('group chatter without a mention of the bot is never counted (anti-noise)',
      (await pending()).new_messages === 0, JSON.stringify(await pending()));
    check('...and the backend never answers it either',
      fakeSupabase.orgLookups === orgBeforeNoise
      && gateway.calls.filter((c) => c.includes('/messages/send-text')).length === sendsBefore,
      `orgLookups=${fakeSupabase.orgLookups}`);

    // (b) The reported case: our @lid in the body, author + name + waMessageId.
    const mentionBody = 'Recommend some good business names for the online e-commerce @248065197879524';
    const mentionMsgId = 'false_202229004943510@lid_MENTION01';
    const mentionDelivery = incoming(GROUP_ID, {
      body: mentionBody,
      data: {
        id: mentionMsgId,
        author: '202229004943510@lid',
        senderName: 'Sanjeev',
        mentionedIds: [MENTION_LID],
      },
    });
    await deliver(mentionDelivery);
    await until(async () => (await pending()).new_messages === 1);
    let mentionFeed = await pending();
    check('a group @-mention of the bot counts exactly like a 1:1 message',
      mentionFeed.new_messages === 1 && mentionFeed.pending_chats[0] === GROUP_ID,
      JSON.stringify(mentionFeed));
    const detail = (mentionFeed.pending || [])[0] || {};
    check('the detail carries what Muse needs to answer in the group tagging the asker',
      detail.chat_id === GROUP_ID && detail.is_group === true
      && detail.message_id === mentionMsgId
      && detail.author === '202229004943510@lid' && detail.author_name === 'Sanjeev'
      && String(detail.body || '').includes('Recommend some good business names')
      && Array.isArray(detail.mentioned_ids) && detail.mentioned_ids.includes(MENTION_LID)
      && typeof detail.matched_by === 'string' && detail.matched_by.length > 0,
      JSON.stringify(detail));
    check('the backend does not answer a counted group mention itself (no double reply)',
      fakeSupabase.orgLookups === orgBeforeNoise
      && gateway.calls.filter((c) => c.includes('/messages/send-text')).length === sendsBefore,
      `orgLookups=${fakeSupabase.orgLookups}`);

    // The same delivery again (gateway retry — identical payload) → still 1;
    // then Muse's group echo clears the group.
    await deliver(mentionDelivery);
    await sleep(100);
    check('the same group mention redelivered is not counted twice',
      (await pending()).new_messages === 1, JSON.stringify(await pending()));
    await deliver(outgoing(GROUP_ID));
    await until(async () => (await pending()).new_messages === 0);
    check("Muse's group reply clears the group chat",
      (await pending()).new_messages === 0
      && fakeSupabase.pendingRows.every((r) => r.status !== 'pending'));

    // A mention by our own NUMBER (no LID, no roster learning needed) counts too.
    await deliver(incoming(GROUP_ID, {
      body: 'hey @9779712039906, are you there?',
      data: { id: 'GROUP-NUMBER-1', author: '149959471063139@lid', senderName: 'Teammate' },
    }));
    await until(async () => (await pending()).new_messages === 1);
    check('a mention of the bot by its own number counts (body-number path)',
      (await pending()).pending_chats[0] === GROUP_ID);


    // ============ 13. a group-filtering webhook is detected and repaired ============
    // Reported: group messages never arrived at all. Our own registration never
    // sets filters, so the cause is a stale gateway hook carrying { isGroup: false }
    // (or a wrong URL / missing event). /webhook/repair must fix that, and must
    // leave a correct hook alone. The backend derives the hook URL from
    // PUBLIC_BACKEND_URL, so point that at this test server for these checks.
    const previousPublicUrl = process.env.PUBLIC_BACKEND_URL;
    process.env.PUBLIC_BACKEND_URL = base;
    const hookUrl = `${base}/api/webhooks/openwa`;

    gateway.webhooks = [{ id: 'WH-FILTERED', url: hookUrl, events: ['message.received'], filters: { isGroup: false } }];
    gateway.registered.length = 0;
    gateway.deleted.length = 0;
    let repair = await (await fetch(`${base}/api/org/openwa/webhook/repair`, { method: 'POST' })).json();
    check('a group-filtering webhook is repaired (re-registered with no filters)',
      repair.ok === true && repair.repaired === true && repair.reason === 'fixed'
      && gateway.registered.length === 1 && !('filters' in gateway.registered[0]),
      JSON.stringify({ repair, registered: gateway.registered }));
    check('the filtered hook is deleted first so the gateway cannot fan out twice',
      gateway.deleted.includes('WH-FILTERED'), JSON.stringify(gateway.deleted));
    check('the clean registration still asks for message.received with the secret',
      gateway.registered[0].events.includes('message.received')
      && typeof gateway.registered[0].secret === 'string' && gateway.registered[0].secret.length > 0,
      JSON.stringify(gateway.registered[0]));

    // An already-correct hook is left exactly as it is.
    gateway.webhooks = [{ id: 'WH-CLEAN', url: hookUrl, events: ['message.received'] }];
    gateway.registered.length = 0;
    gateway.deleted.length = 0;
    repair = await (await fetch(`${base}/api/org/openwa/webhook/repair`, { method: 'POST' })).json();
    check('a correctly wired webhook is never touched',
      repair.repaired === false && repair.reason === 'already-clean'
      && gateway.registered.length === 0 && gateway.deleted.length === 0,
      JSON.stringify(repair));

    // No hook at all → created.
    gateway.webhooks = [];
    gateway.registered.length = 0;
    repair = await (await fetch(`${base}/api/org/openwa/webhook/repair`, { method: 'POST' })).json();
    check('a missing webhook is created',
      repair.repaired === true && repair.reason === 'created' && gateway.registered.length === 1,
      JSON.stringify(repair));

    // A hook that lost the event we rely on is repaired too.
    gateway.webhooks = [{ id: 'WH-NOEVENT', url: hookUrl, events: ['session.status'] }];
    gateway.registered.length = 0;
    repair = await (await fetch(`${base}/api/org/openwa/webhook/repair`, { method: 'POST' })).json();
    check('a webhook missing message.received is repaired',
      repair.repaired === true && gateway.registered.length === 1,
      JSON.stringify(repair));
    if (previousPublicUrl === undefined) delete process.env.PUBLIC_BACKEND_URL;
    else process.env.PUBLIC_BACKEND_URL = previousPublicUrl;

    // Reset the harness to the default (Muse mode, connected) for a clean exit.
    fakeSupabase.rowStatus = 'connected';
    waMode.invalidate(SESSION);
    await waPending.clearPending();
  } catch (e) {
    check('test ran without throwing', false, e.message + ' @ ' + (e.stack || '').split('\n')[1]);
  } finally {
    server.close();
    console.log(failures === 0 ? '\nALL MUSE-MODE WA CHECKS PASSED' : `\n${failures} MUSE-MODE WA CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
  }
});

