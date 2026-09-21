/**
 * Offline regression tests for the V10 knowledge base.
 *
 * Covers the whole curated-knowledge surface without a database or network:
 *   - routes: list + quota, stats, structured templates, paste-text, upload
 *     (CSV + unsupported type), rename/pause, chunk preview, "ask your
 *     knowledge" search, refresh guard, YouTube URL guard
 *   - services: paragraph chunking (keeps Q&A together), structured-fact
 *     formatting, YouTube URL/caption parsing
 *
 * Supabase and auth are stubbed with chainable fakes (same approach as
 * tests/widget.e2e.js). Run from backend/:  node tests/knowledge.e2e.js
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'stub';
// Force the offline code paths: local embedder, no Groq OCR/Whisper calls.
process.env.HUGGINGFACE_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.GROQ_API_KEY_2 = '';

const path = require('path');
const assert = require('assert');
const express = require('express');

const ORG_ID = 'org-1';

/* ---------- Stub middleware/auth (no Supabase) ---------- */
const authPath = require.resolve(path.join(__dirname, '..', 'src', 'middleware', 'auth'));
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true, exports: {
    requireAuth(req, _res, next) {
      req.user = { id: 'user-1', email: 'owner@test' };
      req.orgId = ORG_ID;
      req.role = 'owner';
      next();
    },
  }, children: [], paths: [],
};

/* ---------- In-memory tenant data ---------- */
let nextDocId = 100;
const DB = {
  documents: [
    { id: 1, organization_id: ORG_ID, title: 'Website crawl', source_type: 'crawl', url: 'https://shop.test', status: 'ready', created_at: new Date().toISOString(), is_active: true, last_synced_at: new Date().toISOString() },
    { id: 2, organization_id: ORG_ID, title: 'Manual notes', source_type: 'manual', url: null, status: 'ready', created_at: new Date().toISOString(), is_active: false, last_synced_at: null },
  ],
  document_sections: [
    { id: 1, document_id: 1, organization_id: ORG_ID, content: 'Delivery inside Ring Road costs Rs. 80 and takes about 45 minutes.' },
    { id: 2, document_id: 2, organization_id: ORG_ID, content: 'Opening hours: Daily 9:00-18:00' },
  ],
};
const writes = { documents: [], document_sections: [], usage_events: [] };

const isDocActive = (id) => {
  const doc = DB.documents.find((d) => d.id === id);
  return doc ? doc.is_active !== false : false;
};

/* ---------- Chainable Supabase stub ---------- */
function fakeSupabase() {
  function build(table) {
    const b = {
      _table: table, _filters: [], _selectOpts: {}, _selectCols: '',
      _rows: null, _update: null, _deleted: false,
    };
    b.select = (cols, opts) => { b._selectCols = String(cols || ''); b._selectOpts = opts || {}; return b; };
    b.eq = (col, val) => { b._filters.push({ col, val }); return b; };
    b.in = (col, vals) => { b._filters.push({ col, vals }); return b; };
    b.order = () => b;
    b.limit = () => b;
    b.gte = () => b;
    b.insert = (rows) => { b._rows = rows; return b; };
    b.update = (patch) => { b._update = patch; return b; };
    b.delete = () => { b._deleted = true; return b; };
    b.single = async () => singleResult(b);
    b.maybeSingle = async () => singleResult(b);
    b.then = (resolve, reject) => Promise.resolve(listResult(b)).then(resolve, reject);
    return b;
  }

  function sectionsFiltered(b) {
    let rows = DB.document_sections;
    for (const f of b._filters) {
      if (f.col === 'document_id') rows = rows.filter((r) => r.document_id === f.val);
      if (f.col === 'documents.is_active') rows = rows.filter((r) => isDocActive(r.document_id));
    }
    return rows;
  }

  function listResult(b) {
    if (b._table === 'documents') {
      if (b._deleted) {
        let removed = null;
        for (const f of b._filters) {
          if (f.col === 'id') {
            removed = DB.documents.find((d) => d.id === f.val) || null;
            DB.documents = DB.documents.filter((d) => d.id !== f.val);
          }
        }
        return { data: removed, error: null };
      }
      if (b._update) {
        DB.documents = DB.documents.map((d) => ({ ...d, ...b._update }));
        const first = b._filters.find((f) => f.col === 'id');
        const doc = first ? DB.documents.find((d) => d.id === first.val) : DB.documents[0];
        return { data: doc ? { ...doc } : null, error: null };
      }
      if (b._rows) {
        const rows = (Array.isArray(b._rows) ? b._rows : [b._rows]).map((r) => ({
          id: ++nextDocId,
          organization_id: ORG_ID,
          title: r.title,
          source_type: r.source_type,
          url: r.url ?? null,
          status: r.status,
          created_at: new Date().toISOString(),
          is_active: true,
          last_synced_at: r.last_synced_at ?? null,
        }));
        DB.documents.push(...rows);
        writes.documents.push(...rows);
        return { data: rows, error: null };
      }
      let rows = DB.documents;
      const inFilter = b._filters.find((f) => f.vals);
      if (inFilter) rows = rows.filter((d) => inFilter.vals.includes(d.id));
      return { data: rows.map((d) => ({ ...d })), error: null };
    }

    if (b._table === 'document_sections') {
      if (b._rows) {
        const rows = (Array.isArray(b._rows) ? b._rows : [b._rows]).map((r) => ({ ...r }));
        DB.document_sections.push(...rows);
        writes.document_sections.push(...rows);
        return { data: rows, error: null };
      }
      const rows = sectionsFiltered(b);
      if (b._selectCols.includes('documents!inner')) {
        return {
          data: rows.map((r) => ({ id: r.id, document_id: r.document_id, content: r.content, documents: { is_active: isDocActive(r.document_id) } })),
          error: null,
        };
      }
      if (b._selectCols.trim().startsWith('document_id')) {
        return { data: rows.map((r) => ({ document_id: r.document_id })), error: null };
      }
      if (b._selectOpts.count) {
        return { data: rows.slice(0, 20).map((r) => ({ id: r.id, content: r.content })), count: rows.length, error: null };
      }
      return { data: rows.map((r) => ({ ...r })), error: null };
    }

    if (b._table === 'usage_events') {
      if (b._rows) writes.usage_events.push(...(Array.isArray(b._rows) ? b._rows : [b._rows]));
      return { data: null, error: null };
    }

    return { data: null, error: null };
  }

  function singleResult(b) {
    if (b._table === 'documents') {
      if (b._selectOpts.count) return { data: null, error: null, count: DB.documents.length };
      if (b._rows) {
        const row = (Array.isArray(b._rows) ? b._rows : [b._rows])[0];
        const created = {
          id: ++nextDocId,
          organization_id: ORG_ID,
          title: row.title,
          source_type: row.source_type,
          url: row.url ?? null,
          status: row.status,
          created_at: new Date().toISOString(),
          is_active: true,
          last_synced_at: row.last_synced_at ?? null,
        };
        DB.documents.push(created);
        writes.documents.push(created);
        return { data: { ...created }, error: null };
      }
      if (b._update) {
        const idFilter = b._filters.find((f) => f.col === 'id');
        const doc = DB.documents.find((d) => d.id === idFilter?.val);
        if (!doc) return { data: null, error: null };
        Object.assign(doc, b._update);
        return { data: { ...doc }, error: null };
      }
      const idFilter = b._filters.find((f) => f.col === 'id');
      const doc = DB.documents.find((d) => d.id === idFilter?.val);
      return { data: doc ? { ...doc } : null, error: null };
    }
    if (b._table === 'organizations') {
      return { data: { id: ORG_ID, plan: 'free', plan_expires_at: null }, error: null };
    }
    if (b._table === 'profiles') {
      return { data: { organization_id: ORG_ID, role: 'owner' }, error: null };
    }
    return { data: null, error: null };
  }

  return { from: (table) => build(table) };
}

const supabasePath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true, exports: fakeSupabase(), children: [], paths: [],
};

const knowledgeRouter = require('../src/routes/knowledge');
const { chunkByParagraphs } = require('../src/services/ingest');
const { buildStructuredText } = require('../src/services/structured');
const { parseVideoId, captionsToText } = require('../src/services/youtube');
const { detectKind, extractFile } = require('../src/services/extract');

/* ---------- Tiny HTTP harness ---------- */
let server;
let base;

async function call(method, pathname, { json, form } = {}) {
  const headers = {};
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(`${base}${pathname}`, { method, headers, body });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function run() {
  const app = express();
  app.use(express.json());
  app.use(require('express-fileupload')());
  app.use('/api/knowledge', knowledgeRouter);

  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  await testsReading();
  await testsCuration();
  await testsUpload();
  await testsUnits();

  console.log('\nAll knowledge.e2e tests passed.');
  server.close();
}

/* ---------- Reading: list, templates, paste-text ingest, search ---------- */
async function testsReading() {
  let r = await call('GET', '/api/knowledge');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.documents.length, 2);
  assert.strictEqual(r.json.documents[0].chunks, 1, 'chunk counts are joined onto the list');
  assert.strictEqual(r.json.quota.documents.limit, 10, 'free-plan document allowance');
  assert.strictEqual(r.json.quota.chunks.used, 2);
  console.log('ok  GET / lists documents with chunk counts + quota');

  r = await call('GET', '/api/knowledge/structured');
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.templates.restaurant, 'industry templates are served');
  console.log('ok  GET /structured serves industry starter templates');

  r = await call('POST', '/api/knowledge/text', { json: { title: 'x', text: 'too short' } });
  assert.strictEqual(r.status, 400);
  const qa = Array.from({ length: 40 }, (_, i) =>
    `Q: Question ${i} about the cafe?\n\nA: Detailed answer number ${i} with several more words.`
  ).join('\n\n');
  r = await call('POST', '/api/knowledge/text', { json: { title: 'FAQ', text: qa } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.chunks >= 2, 'long Q&A text is chunked by paragraph, not one blob');
  const created = DB.documents[DB.documents.length - 1];
  assert.strictEqual(created.source_type, 'manual');
  console.log('ok  POST /text validates and ingests with paragraph chunking');

  r = await call('POST', '/api/knowledge/search', { json: { query: 'delivery fee' } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.matches.length >= 1, 'search finds the delivery chunk');
  assert.strictEqual(r.json.matches[0].documentId, 1, 'the paused document is NOT retrieved');
  assert.strictEqual(r.json.matches[0].title, 'Website crawl');
  assert.ok(typeof r.json.elapsedMs === 'number');
  console.log('ok  POST /search retrieves only from active sources, with timing');
}

/* ---------- Curation: rename/pause, preview, refresh + YouTube guards ---------- */
async function testsCuration() {
  let r = await call('PATCH', '/api/knowledge/1', { json: { is_active: false } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.document.is_active, false);
  r = await call('PATCH', '/api/knowledge/1', { json: { title: 'Renamed crawl' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.document.title, 'Renamed crawl');
  r = await call('PATCH', '/api/knowledge/1', { json: {} });
  assert.strictEqual(r.status, 400, 'empty patch is rejected');
  r = await call('PATCH', '/api/knowledge/1', { json: { source_type: 'manual' } });
  assert.strictEqual(r.status, 400, 'provenance fields cannot be rewritten');
  console.log('ok  PATCH /:id renames + pauses, and rejects empty/provenance patches');

  r = await call('GET', '/api/knowledge/sections/1');
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.total >= 1 && r.json.sections.length >= 1);
  assert.ok(r.json.sections[0].content.length > 10);
  r = await call('GET', '/api/knowledge/sections/9999');
  assert.strictEqual(r.status, 404, 'another tenant / missing document is not found');
  console.log('ok  GET /sections/:id previews the stored chunks');

  r = await call('POST', '/api/knowledge/refresh', { json: { id: 2 } });
  assert.strictEqual(r.status, 400);
  assert.ok(/website sources/.test(r.json.error));
  r = await call('POST', '/api/knowledge/refresh', { json: {} });
  assert.strictEqual(r.status, 400);
  console.log('ok  POST /refresh only allows website sources');

  r = await call('POST', '/api/knowledge/youtube', { json: { url: 'https://vimeo.com/123' } });
  assert.strictEqual(r.status, 400);
  assert.ok(/YouTube video link/.test(r.json.error));
  console.log('ok  POST /youtube rejects non-YouTube URLs before any network call');

  r = await call('DELETE', '/api/knowledge/9999');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(DB.documents.length, 3, 'deleting an unknown id changes nothing');
  console.log('ok  DELETE /:id is idempotent for unknown ids');
}

/* ---------- Uploads: unsupported type + CSV price list ---------- */
async function testsUpload() {
  let fd = new FormData();
  fd.append('file', new Blob([Buffer.from('MZ')], { type: 'application/octet-stream' }), 'virus.exe');
  let r = await call('POST', '/api/knowledge/upload', { form: fd });
  assert.strictEqual(r.status, 400);
  assert.ok(/Unsupported file type/.test(r.json.error), 'clear copy for unknown extensions');
  console.log('ok  POST /upload rejects unsupported types with readable copy');

  fd = new FormData();
  fd.append('file', new Blob([Buffer.from('Item,Price\nMomo,220\nChowmein,180\n')], { type: 'text/csv' }), 'menu.csv');
  r = await call('POST', '/api/knowledge/upload', { form: fd });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.added, 1, 'one file learned');
  assert.strictEqual(r.json.results[0].kind, 'text');
  const learned = writes.document_sections.map((s) => s.content).join(' ');
  assert.ok(/Momo, ?220/.test(learned), 'CSV rows are ingested verbatim so prices stay quotable');
  console.log('ok  POST /upload learns a CSV price list');

  fd = new FormData();
  fd.append('file', new Blob([Buffer.from('Item,Price,Stock\nMomo,220,50\nChowmein,180,30\n')], { type: 'text/csv' }), 'a.csv');
  fd.append('file', new Blob([Buffer.from('MZ')], { type: 'application/octet-stream' }), 'bad.exe');
  r = await call('POST', '/api/knowledge/upload', { form: fd });
  assert.strictEqual(r.status, 200, 'a batch with one bad file still lands the good one');
  assert.strictEqual(r.json.added, 1);
  assert.strictEqual(r.json.failed, 1);
  assert.ok(r.json.results.some((x) => x.file === 'bad.exe' && x.ok === false));
  console.log('ok  POST /upload reports per-file success/failure in a batch');

  assert.strictEqual(detectKind({ name: 'Menu.DOCX', mimetype: '' }), 'document');
  assert.strictEqual(detectKind({ name: 'prices.xlsx', mimetype: '' }), 'sheet');
  assert.strictEqual(detectKind({ name: 'deck.pptx', mimetype: '' }), 'slides');
  assert.strictEqual(detectKind({ name: 'menu.jpg', mimetype: '' }), 'image');
  assert.strictEqual(detectKind({ name: 'note.mp3', mimetype: '' }), 'audio');
  assert.strictEqual(detectKind({ name: 'readme', mimetype: 'text/plain' }), 'text');
  await assert.rejects(() => extractFile({ name: 'big.bin', mimetype: '', size: 6 * 1024 * 1024, data: Buffer.alloc(8) }), /File too large/);
  await assert.rejects(() => extractFile({ name: 'menu.png', mimetype: 'image/jpeg', size: 10, data: Buffer.alloc(10) }), /OCR is not configured/);
  console.log('ok  detectKind/extractFile route formats and enforce the size + config guards');
}

/* ---------- Pure units: chunking, structured facts, YouTube parsing ---------- */
async function testsUnits() {
  const faqText =
    'Q: How much is delivery?\nA: Rs. 80 inside Ring Road.\n\nQ: Is there parking?\nA: Street parking only.';
  const single = chunkByParagraphs(faqText, 400);
  assert.strictEqual(single.length, 1, 'a small Q&A doc stays in one retrievable chunk');

  const big = Array.from({ length: 30 }, (_, i) =>
    `Q: Question ${i} about the product?\nA: The answer to question ${i} lorem ipsum dolor sit amet consectetur.`
  ).join('\n\n');
  const many = chunkByParagraphs(big, 60);
  assert.ok(many.length > 1, 'a large Q&A doc splits into several chunks');
  for (const chunk of many) {
    assert.ok(/Q: /.test(chunk), 'no chunk cuts a question away from its answer');
  }

  const st = buildStructuredText({
    title: 'Facts',
    business_name: 'Cafe X',
    phone: '+9779800000000',
    hours: { monday: '9:00-18:00', tuesday: '9:00-18:00', wednesday: '9:00-18:00', thursday: '9:00-18:00', friday: '9:00-18:00' },
    services: [{ name: 'Momo', price: 'Rs. 220' }],
    faqs: [{ question: 'Do you deliver?', answer: 'Yes.' }],
    facts: [{ label: 'WiFi', value: 'Free' }],
  });
  assert.strictEqual(st.sections.facts, 3, 'named fields + custom rows are counted');
  assert.ok(st.sections.hours && st.sections.services === 1 && st.sections.faqs === 1);
  assert.ok(/Opening hours: Daily 9:00–18:00/.test(st.text), 'five identical days collapse to a Daily line');
  assert.ok(st.text.includes('Phone: +9779800000000'));
  assert.ok(st.text.includes('Services and prices:'));
  assert.ok(st.text.includes('Q: Do you deliver?\nA: Yes.'));
  assert.ok(!/undefined|\[object Object\]/.test(st.text), 'no raw objects or undefined leak into the text');

  const empty = buildStructuredText({});
  assert.strictEqual(empty.text, '');
  assert.strictEqual(empty.title, 'Business details');

  assert.strictEqual(parseVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s'), 'dQw4w9WgXcQ');
  assert.strictEqual(parseVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(parseVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(parseVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(parseVideoId('https://vimeo.com/123'), null);
  assert.strictEqual(parseVideoId('not a url'), null);

  const json3 = JSON.stringify({
    events: [
      { segs: [{ utf8: 'Hello ' }, { utf8: 'world.' }] },
      { segs: [{ utf8: 'Next ' }, { utf8: 'line?' }] },
    ],
  });
  const xml = '<transcript><text start="0" dur="1">Hello &amp;amp; welcome.</text><text start="1" dur="1">Second line.</text></transcript>';
  assert.ok(captionsToText(json3).includes('Hello world.'));
  assert.ok(captionsToText(xml).includes('Hello & welcome.'));
  assert.strictEqual(captionsToText(''), '');
  console.log('ok  unit: chunking, structured facts, YouTube URL + caption parsing');
}

run().catch((err) => {
  console.error('FAILED:', err && (err.stack || err.message));
  if (server) server.close();
  process.exit(1);
});
