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

// ---------- Supabase is only reached in bot mode ----------
// Counting a message for Muse happens *before* the org lookup, so a DB touch in
// Muse mode would mean the reply pipeline — and a competing WhatsApp reply — had
// started. The stub counts every access (and answers "no such org") instead of
// throwing, so the test can tell "the old path is still wired, rollback works"
// apart from "Muse mode leaked".
const fakeSupabase = {
  uses: 0,
  from() {
    fakeSupabase.uses += 1;
    const b = {};
    ['select', 'eq', 'neq', 'insert', 'update', 'order', 'limit'].forEach((m) => { b[m] = () => b; });
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({ data: null, error: null });
    return b;
  },
  auth: { getUser: async () => ({ data: { user: null }, error: null }) },
};
const supabasePath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true, exports: fakeSupabase, children: [], paths: [],
};

const config = require('../src/config');
const { webhookRouter } = require('../src/routes/openwa');
const waPendingRoutes = require('../src/routes/waPending');

const app = express();
// Mirrors server.js: the webhook needs the RAW body for HMAC, then JSON parsing.
app.use('/api/webhooks/openwa', express.raw({ type: '*/*', limit: '2mb' }));
app.use(express.json());
app.use('/api/webhooks', webhookRouter);
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

    // ==================== 4. the backend never replied ====================
    check('Muse mode never reached the Supabase reply pipeline', fakeSupabase.uses === 0,
      `uses=${fakeSupabase.uses}`);

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

    // ==================== 8. the off-switch keeps the old bot intact ====================
    // Flipping the flag must restore self-replying. The same payload then reaches
    // the org lookup again, which the stub below turns into a visible use.
    const before = fakeSupabase.uses;
    config.openwa.autoReply = true;
    await deliver(incoming(CHAT_A));
    await until(() => fakeSupabase.uses > before, 2000);
    check('WHATSAPP_AUTO_REPLY=on restores the original auto-reply path (rollback in one flag)',
      fakeSupabase.uses > before, `supabase uses: ${before} -> ${fakeSupabase.uses}`);
    config.openwa.autoReply = false;
  } catch (e) {
    check('test ran without throwing', false, e.message + ' @ ' + (e.stack || '').split('\n')[1]);
  } finally {
    server.close();
    console.log(failures === 0 ? '\nALL MUSE-MODE WA CHECKS PASSED' : `\n${failures} MUSE-MODE WA CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
  }
});

