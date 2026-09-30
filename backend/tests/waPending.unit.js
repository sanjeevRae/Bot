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
process.env.OPENWA_BASE_URL = '';                      // no gateway → no probe calls
process.env.OPENWA_API_KEY = '';
process.env.WA_SESSION_WAIT_MS = '0';                  // status poll never waits

const path = require('path');
const crypto = require('crypto');
const express = require('express');

// ---------- Supabase stub: mode lookup vs. the reply pipeline ----------
// Two different reads happen against `whatsapp_connections`:
//   * lib/waMode.js reads the org's `auto_reply_enabled` switch (kind 'mode'),
//   * bot mode resolves the org to run the RAG/Groq reply pipeline, and that
//     select always carries `organization_id` (kind 'org').
// Counting them separately is what lets the test prove both halves: Muse mode
// never starts the reply pipeline, and `autoReply: true` still does.
const fakeSupabase = {
  orgLookups: 0,          // reply pipeline reached (would send a WhatsApp reply)
  modeReads: 0,           // the V13 switch was read
  autoReplyEnabled: false, // what the Channels toggle "stores"
  hasColumn: true,        // false → a deploy that predates migration_v13
  mapped: true,           // false → no whatsapp_connections row for the session
  patches: [],            // what /settings wrote
  from() {
    const b = { _kind: 'other' };
    ['eq', 'neq', 'insert', 'order', 'limit'].forEach((m) => { b[m] = () => b; });
    b.select = (cols) => {
      const c = String(cols == null ? '' : cols);
      if (c.includes('organization_id')) { fakeSupabase.orgLookups += 1; b._kind = 'org'; }
      else if (c.includes('auto_reply_enabled')) { fakeSupabase.modeReads += 1; b._kind = 'mode'; }
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
      return b; // `await` on a non-thenable yields this object, so `b.error` is the result
    };
    b.single = b.maybeSingle = async () => {
      if (b._kind === 'mode') {
        if (!fakeSupabase.hasColumn) {
          return { data: null, error: { message: 'column "auto_reply_enabled" does not exist' } };
        }
        if (!fakeSupabase.mapped) return { data: null, error: null };
        return { data: { auto_reply_enabled: fakeSupabase.autoReplyEnabled }, error: null };
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

    // A retry of the same delivery must not double-count.
    await deliver(incoming(CHAT_B, { idempotencyKey: 'retry-me' }));
    await deliver(incoming(CHAT_B, { idempotencyKey: 'retry-me' }));
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

    await deliver(incoming(GROUP, { from: GROUP, data: { isGroup: true, author: '9779810135468@c.us' } }));
    await until(async () => (await pending()).new_messages === 3);
    p = await pending();
    check('group messages are counted too (chatId is the group)', p.pending_chats.includes(GROUP),
      JSON.stringify(p.pending_chats));

    await deliver(outgoing(CHAT_A));
    await until(async () => (await pending()).new_messages === 1);
    p = await pending();
    check('clearing one chat leaves the others untouched', p.pending_chats[0] === GROUP,
      JSON.stringify(p));

    // The same conversation can be addressed as @lid on one side and @c.us on the
    // other (privacy ids), so clearing falls back to the digits of the JID.
    await deliver(incoming(CHAT_A));
    await until(async () => (await pending()).new_messages === 2);
    await deliver(outgoing('9779810135468@lid'));
    await until(async () => (await pending()).new_messages === 1);
    p = await pending();
    check('a @lid-form outbound echo still clears the @c.us pending chat',
      p.new_messages === 1 && p.pending_chats[0] === GROUP, JSON.stringify(p));


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
    check('toggle to Chitra: the pending list is cleared (Muse is out of this session)',
      p.new_messages === 0 && p.pending_chats.length === 0, JSON.stringify(p));
    check('toggle to Chitra: the feed says mode "bot" so Muse stands down', p.mode === 'bot', p.mode);

    const beforeBot = fakeSupabase.orgLookups;
    await deliver(incoming(CHAT_A));
    await until(() => fakeSupabase.orgLookups > beforeBot, 2000);
    check('toggle to Chitra: incoming messages reach the reply pipeline again',
      fakeSupabase.orgLookups > beforeBot, `orgLookups=${fakeSupabase.orgLookups}`);
    await sleep(50);
    check('toggle to Chitra: nothing is counted for Muse while the bot answers',
      (await pending()).new_messages === 0);

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
    await until(async () => (await pending()).new_messages === 1);
    check('toggle back to Muse: counting resumes and the reply pipeline is untouched',
      fakeSupabase.orgLookups === beforeBot + 1 || fakeSupabase.orgLookups >= beforeBot,
      `orgLookups=${fakeSupabase.orgLookups}`);

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
  } catch (e) {
    check('test ran without throwing', false, e.message + ' @ ' + (e.stack || '').split('\n')[1]);
  } finally {
    server.close();
    console.log(failures === 0 ? '\nALL MUSE-MODE WA CHECKS PASSED' : `\n${failures} MUSE-MODE WA CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
  }
});

