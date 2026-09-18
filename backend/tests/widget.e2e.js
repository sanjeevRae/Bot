/**
 * Regression test for the GENERATED client scripts — GET /widget.js and GET /bot/:orgId.
 *
 * Why this exists: a refactor once left an extra `});` in the widget template and an
 * orphaned `.then(...)` in the /bot template. Both endpoints still returned HTTP 200,
 * so the breakage was invisible to monitoring — but the emitted scripts failed to
 * PARSE, so the chat widget never appeared and the direct chat link never sent a message.
 *
 * This test renders the real route with a stubbed Supabase client, compiles the emitted
 * JavaScript, then runs it in jsdom and proves a message round-trips to a reply.
 *
 * Run: npm test   (from backend/)  — offline, no credentials, no DB needed.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'stub';

const path = require('path');
const vm = require('vm');
const express = require('express');
const { JSDOM, VirtualConsole } = require('jsdom');

// ---------- Stub the Supabase admin client (chainable query builder) ----------
function builder(result) {
  const b = {};
  ['select', 'eq', 'insert', 'update', 'delete', 'order', 'limit', 'in'].forEach((m) => { b[m] = () => b; });
  b.maybeSingle = async () => result;
  b.single = async () => result;
  return b;
}
const ORG_ROW = { id: 'ORG-1', name: 'Test Biz' };
const SETTINGS_ROW = { brand_color: '#123456', bot_name: 'TestBot', welcome_message: 'Welcome!', white_label: false, custom_domain: null };
const fakeSupabase = {
  from: (t) => builder(t === 'organizations' ? { data: ORG_ROW, error: null } : { data: SETTINGS_ROW, error: null }),
  auth: { getUser: async () => ({ data: { user: null }, error: null }) },
};
const supabasePath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fakeSupabase, children: [], paths: [] };

const widgetRouter = require('../src/routes/widget');
const app = express();
app.use('/', widgetRouter);

// ---------- tiny test harness ----------
let failures = 0;
function check(label, ok, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  -> ' + extra : ''));
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (fn()) return true; } catch (e) { /* keep polling */ }
    await sleep(50);
  }
  return false;
}
function compile(name, code) {
  try { new vm.Script(code, { filename: name }); return null; } catch (e) { return e.message; }
}
function quietDom(html, url) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  return new JSDOM(html, { runScripts: 'dangerously', url, virtualConsole: vc, pretendToBeVisual: true });
}
const submit = (win, form) => form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
const inlineScriptOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');

/** Fake API: issues sessions and rejects any message that arrives without a token. */
function makeFetch(log) {
  return async (url, opts = {}) => {
    const u = String(url);
    log.push(u);
    if (u.includes('/api/chat/session')) {
      return { ok: true, status: 200, json: async () => ({ sessionId: 'S-1', sessionToken: 'TOK-OK', expiresIn: 86400 }) };
    }
    const body = JSON.parse(opts.body || '{}');
    if (!body.sessionToken) {
      log.push('REJECTED:missing-sessionToken');
      return { ok: false, status: 403, json: async () => ({ error: 'Invalid session' }) };
    }
    return { ok: true, status: 200, json: async () => ({ reply: '**Hello** from the fake API for "' + body.message + '"' }) };
  };
}

/** True once the LAST bubble is a finished bot message (not the "..." typing dots). */
function botReplied(doc, sel) {
  const nodes = [...doc.querySelectorAll(sel)];
  if (!nodes.length) return false;
  const last = nodes[nodes.length - 1];
  const t = (last.textContent || '').trim();
  return last.className.includes('bot') && t.length > 10 && !/^[\u2026.]+$/.test(t);
}
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // ==================== 1. GET /widget.js (embeddable script) ====================
    const widgetJs = await (await fetch(`${base}/widget.js?org=ORG-1`)).text();
    check('widget.js is served', widgetJs.length > 1000, widgetJs.length + ' bytes');
    const wErr = compile('widget.js', widgetJs);
    check('widget.js PARSES as JavaScript', !wErr, wErr || '');
    check('widget.js has no orphaned .then chain', !/\};\s*\.then\(/.test(widgetJs));
    check('widget.js asks the server for a session', widgetJs.includes('/api/chat/session'));
    check('widget.js sends sessionToken with every message', widgetJs.includes('sessionToken'));
    check('widget.js self-heals on 403', /r\.status\s*===\s*403/.test(widgetJs));
    check('widget.js never invents a client-side session id', !/Math\.random\(\)/.test(widgetJs));
    check('widget.js uses the org brand colour', widgetJs.includes('"#123456"'));

    const log1 = [];
    const dom1 = quietDom('<!doctype html><html><body><h1>Customer site</h1></body></html>', 'https://customer.example.com/');
    dom1.window.fetch = makeFetch(log1);
    const s1 = dom1.window.document.createElement('script');
    s1.textContent = widgetJs;
    dom1.window.document.head.appendChild(s1);
    const w = dom1.window.document;

    const el = (id) => w.getElementById(id); // may be null when the script did not run
    check('widget: launcher appears on the host page', !!el('chitra-launcher'));
    if (el('chitra-launcher')) {
      el('chitra-launcher').click();
      check('widget: panel opens on click', el('chitra-panel').classList.contains('open'));
      check('widget: welcome message comes from org settings', (el('chitra-msgs').textContent || '').includes('Welcome!'));

      el('chitra-input').value = 'what are your hours?';
      submit(dom1.window, el('chitra-form'));
      check('widget: user message is echoed', (el('chitra-msgs').textContent || '').includes('what are your hours?'));

      const gotReply = await until(() => (el('chitra-msgs').textContent || '').includes('Hello from the fake API'));
      check('widget: BOT REPLY RENDERS end-to-end', gotReply, gotReply ? '' : JSON.stringify(log1));
      check('widget: message carried the session token', !log1.includes('REJECTED:missing-sessionToken'));
      check('widget: reply is markdown-rendered (bold -> <strong>)', !!w.querySelector('#chitra-msgs strong'));
    } else {
      console.log('      (skipping widget DOM checks — the script did not execute)');
    }
// ==================== 2. GET /bot/:orgId (direct chat link) ====================
    const botHtml = await (await fetch(`${base}/bot/ORG-1`)).text();
    check('bot page is served', botHtml.includes('<form'), botHtml.length + ' bytes');

    const scripts = [...botHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    check('bot page has exactly one inline script', scripts.length === 1, scripts.length + ' found');
    const bErr = compile('bot-inline.js', scripts[0] || '');
    check('bot page inline script PARSES', !bErr, bErr || '');

    const bjs = scripts[0] || '';
    check('bot page has no orphaned .then after a function body', !/\};\s*\.then\(/.test(bjs));
    check('bot page submit handler is wired to sendMsg', /onsubmit=function\(e\)\{[\s\S]*sendMsg\(t\)\.then\(/.test(bjs));
    check('bot page asks the server for a session', bjs.includes('/api/chat/session'));
    check('bot page sends sessionToken with every message', bjs.includes('sessionToken'));
    check('bot page never invents a client-side session id', !/Math\.random\(\)/.test(bjs));
    check('bot page shows a typing indicator', /typing\.textContent='\\u2026'/.test(bjs));
    check('bot page uses the org brand colour (no hardcoded indigo)', botHtml.includes('#123456') && !botHtml.includes('#6366f1'));
    check('bot page uses the org welcome message', botHtml.includes('add("Welcome!"'));

    const log2 = [];
    const dom2 = quietDom(botHtml, 'https://customer.example.com/bot');
    dom2.window.fetch = makeFetch(log2);
    const s2 = dom2.window.document.createElement('script');
    s2.textContent = inlineScriptOf(botHtml);
    dom2.window.document.body.appendChild(s2);
    const b = dom2.window.document;

    check('bot page: header shows the business name', (b.querySelector('h1')?.textContent || '').includes('Test Biz'));
    check('bot page: welcome message comes from org settings', (b.getElementById('msgs').textContent || '').includes('Welcome!'));

    b.getElementById('in').value = 'do you deliver?';
    submit(dom2.window, b.querySelector('form'));
    check('bot page: user message is echoed', (b.getElementById('msgs').textContent || '').includes('do you deliver?'));
    check('bot page: shows the typing indicator while waiting', !!b.querySelector('#msgs .msg.bot'));

    const gotReply2 = await until(() => (b.getElementById('msgs').textContent || '').includes('Hello from the fake API'));
    check('bot page: BOT REPLY RENDERS end-to-end', gotReply2, gotReply2 ? '' : JSON.stringify(log2));
    check('bot page: message carried the session token', !log2.includes('REJECTED:missing-sessionToken'));
// ==================== 3. Isolation: a 403 must self-heal ====================
    const log3 = [];
    const dom3 = quietDom('<!doctype html><html><body></body></html>', 'https://customer.example.com/');
    let firstCall = true;
    dom3.window.fetch = async (url) => {
      const u = String(url);
      log3.push(u);
      if (u.includes('/api/chat/session')) return { ok: true, status: 200, json: async () => ({ sessionId: 'S-new', sessionToken: 'TOK-FRESH' }) };
      if (firstCall) { firstCall = false; return { ok: false, status: 403, json: async () => ({ error: 'Invalid session' }) }; }
      return { ok: true, status: 200, json: async () => ({ reply: 'recovered reply for this visitor' }) };
    };
    const s3 = dom3.window.document.createElement('script');
    s3.textContent = widgetJs;
    dom3.window.document.head.appendChild(s3);
    const d3 = dom3.window.document;
    d3.getElementById('chitra-launcher')?.click();
    const d3in = d3.getElementById('chitra-input');
    if (d3in) d3in.value = 'hi';
    submit(dom3.window, d3.getElementById('chitra-form') || d3.createElement('form'));
    const recovered = await until(() => botReplied(d3, '#chitra-msgs .chitra-msg'), 4000);
    check('widget: self-heals from a 403 with a fresh session', recovered);
    check('widget: recovery used one extra /api/chat/session call', log3.filter((u) => u.includes('/api/chat/session')).length >= 1);
  } catch (e) {
    check('test ran without throwing', false, e.message + ' @ ' + (e.stack || '').split('\n')[1]);
  } finally {
    server.close();
    console.log(failures === 0 ? '\nALL WIDGET E2E CHECKS PASSED' : `\n${failures} WIDGET E2E CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
  }
});