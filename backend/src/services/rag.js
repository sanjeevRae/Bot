const supabaseAdmin = require('../lib/supabase');
const { embedText } = require('./embeddings');
const config = require('../config');
const { fixMojibake } = require('../lib/textNormalize');
const { documentLimit } = require('./quotas');

/**
 * Retrieval.
 *
 * Two paths, both tenant-scoped:
 *   1. Small corpora (<= SMALL_CORPUS_MAX chunks): chunks are cached in memory
 *      and ranked in-process with a BM25-style lexical scorer. No embedding
 *      call, no vector query — instant, and quality is fine because the corpus
 *      is tiny.
 *   2. Larger corpora: pgvector HNSW search (see migration_v9_rag_perf.sql),
 *      plus a Postgres full-text fallback when the vector search returns
 *      nothing (rare terms, SKUs, names).
 */

/** Corpora at or below this many chunks are scored locally (no network). */
const SMALL_CORPUS_MAX = parseInt(process.env.RAG_SMALL_CORPUS_MAX || '120', 10);
/** How many chunks to pass to the model on the small-corpus path.
 *  Kept modest on purpose: every extra chunk is ~750 tokens of prompt that the
 *  model must read before it starts answering (and counts against the free
 *  provider's per-minute token budget, which shows up as a 429 → slow reply). */
const SMALL_CORPUS_TOP_K = parseInt(process.env.RAG_SMALL_CORPUS_TOP_K || '6', 10);
/** How long a cached corpus stays fresh (invalidated on ingest/delete). */
const CORPUS_TTL_MS = 5 * 60 * 1000;
const corpusCache = new Map(); // orgId -> { rows: chunk[]|null, at: number }

/**
 * Ingest a document: chunk -> embed -> store sections.
 * Tenant-scoped: everything is filtered by organizationId.
 *
 * `structured: true` switches to paragraph-aware chunking, which keeps a
 * "Q: … / A: …" pair or a price-list row group in one chunk instead of cutting
 * it apart on a word window (see chunkByParagraphs in services/ingest.js).
 */
async function ingestDocument({ organizationId, title, sourceType, url, text, structured = false }) {
  // Repair UTF-8/CP1252 mojibake coming from third-party sources (crawled sites,
  // pasted text, imports) before it is stored, so the dashboard, knowledge base,
  // bot answers and emails never display garbled characters.
  // Safe by construction: text containing genuine Unicode (Devanagari, emoji,
  // CJK, accented Latin) can never be altered by fixMojibake.
  if (typeof title === 'string') title = fixMojibake(title);
  if (typeof url === 'string') url = fixMojibake(url);
  if (typeof text === 'string') text = fixMojibake(text);
  // Enforce the document allowance for this org's plan: free = 10 (one-time),
  // Pro = 100, Agency = 500 — see PLAN_QUOTAS in services/payments.js.
  const { count } = await supabaseAdmin
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId);

  const limit = await documentLimit(organizationId);
  if (count >= limit) {
    throw Object.assign(
      new Error(`Knowledge document limit reached (${limit}). Upgrade to add more.`),
      { status: 402 }
    );
  }

  const insertRow = {
    organization_id: organizationId,
    title,
    source_type: sourceType,
    url,
    status: 'processing',
    last_synced_at: new Date().toISOString(),
  };

  let { data: doc, error: docErr } = await supabaseAdmin
    .from('documents')
    .insert(insertRow)
    .select()
    .single();

  // A database that has not run migration_v10_knowledge.sql has no
  // `last_synced_at` column. Retry without it so ingestion never depends on the
  // migration being applied first.
  if (docErr && /last_synced_at|is_active/.test(docErr.message)) {
    const { last_synced_at, ...legacyRow } = insertRow;
    ({ data: doc, error: docErr } = await supabaseAdmin.from('documents').insert(legacyRow).select().single());
  }

  if (docErr) throw docErr;

  try {
    const ingest = require('./ingest');
    const chunks = structured ? ingest.chunkByParagraphs(text) : ingest.chunkText(text);
    if (chunks.length === 0) throw new Error('No meaningful content extracted');

    const vectors = await require('./embeddings').embedBatch(chunks);

    const rows = chunks.map((content, i) => ({
      document_id: doc.id,
      organization_id: organizationId,
      content: fixMojibake(content),
      embedding: vectors[i],
    }));

    // Insert in batches of 50
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await supabaseAdmin.from('document_sections').insert(rows.slice(i, i + 50));
      if (error) throw error;
    }

    await supabaseAdmin.from('documents').update({ status: 'ready' }).eq('id', doc.id);
    await trackUsage(organizationId, 'embedding', rows.length);
    invalidateOrgCache(organizationId); // new knowledge must be visible immediately

    return { documentId: doc.id, chunks: rows.length };
  } catch (err) {
    await supabaseAdmin.from('documents').update({ status: 'failed' }).eq('id', doc.id);
    throw err;
  }
}

async function deleteDocument(organizationId, documentId) {
  const { error } = await supabaseAdmin
    .from('documents')
    .delete()
    .eq('id', documentId)
    .eq('organization_id', organizationId); // tenant guard
  if (error) throw error;
  invalidateOrgCache(organizationId); // the deleted chunks must stop being served
}

/**
 * Update a document's curation fields (title, active flag).
 * Only `title` and `is_active` are accepted — anything else is ignored so this
 * can never be used to rewrite provenance (source_type, url, status).
 * Returns the updated row.
 */
async function updateDocument(organizationId, documentId, patch = {}) {
  const update = {};
  if (typeof patch.title === 'string' && patch.title.trim()) update.title = patch.title.trim().slice(0, 200);
  if (typeof patch.is_active === 'boolean') update.is_active = patch.is_active;

  if (!Object.keys(update).length) {
    throw Object.assign(new Error('Nothing to update — send a title or an is_active flag'), { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('documents')
    .update(update)
    .eq('id', documentId)
    .eq('organization_id', organizationId) // tenant guard
    .select('id, title, source_type, url, status, is_active, last_synced_at, created_at')
    .maybeSingle();

  if (error) throw error;
  if (!data) throw Object.assign(new Error('Document not found'), { status: 404 });

  // A disable/enable changes what retrieval may return.
  invalidateOrgCache(organizationId);
  return data;
}

/**
 * Mark a source as freshly synced. Kept for callers that re-ingest in place —
 * `ingestDocument` already stamps `last_synced_at` on insert, and tolerates a
 * database that predates migration_v10 (no `last_synced_at` column).
 */
async function touchSyncedAt(organizationId, documentId) {
  const { error } = await supabaseAdmin
    .from('documents')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', documentId)
    .eq('organization_id', organizationId);
  if (error && !/last_synced_at/.test(error.message)) throw error;
}

/**
 * Retrieve top-k relevant chunks for a query, scoped to tenant.
 */
async function retrieveContext(organizationId, query, topK = config.rag.topK) {
  // ---- Fast path: small knowledge bases -------------------------------------
  // For a small corpus the whole thing fits in the prompt budget, so scoring it
  // in-process beats a 380 ms embedding round-trip + a vector query. We rank
  // with a tiny BM25-style lexical scorer (token overlap weighted by rarity),
  // which is instant and, for a handful of chunks, as good as vector search.
  // In the dashboard's "test your knowledge" search the merchant WANTS to see
  // what a fresh ingest produced, so that path invalidates the cache first
  // (invalidateOrgCache) and calls retrieveContext with exactly this query.
  // The vector path is skipped for short queries that the lexical scorer cannot
  // rank: those are greetings, not knowledge questions.
  const small = await getSmallCorpus(organizationId);
  if (small) {
    const ranked = rankByLexicalSimilarity(small, query).slice(0, Math.max(topK, SMALL_CORPUS_TOP_K));
    if (ranked.length) return ranked;
  }

  // ---- Vector path ---------------------------------------------------------
  const embedding = await embedText(query);

  const { data, error } = await supabaseAdmin.rpc('match_document_sections', {
    query_embedding: embedding,
    match_count: topK,
    org_id: organizationId,
  });

  if (error) {
    console.error('Retrieval error:', error.message);
  } else if (data && data.length) {
    return data;
  }

  // ---- Lexical fallback ----------------------------------------------------
  // Vector search can miss exact terms (SKUs, names, rare words). Falls back to
  // Postgres full-text search, tenant-scoped, before giving up.
  const { data: kw, error: kwErr } = await supabaseAdmin.rpc('match_document_sections_keyword', {
    query_text: query,
    match_count: topK,
    org_id: organizationId,
  });
  if (kwErr) {
    console.error('Keyword retrieval error:', kwErr.message);
    return [];
  }
  return kw || [];
}

/**
 * Whole corpus for orgs small enough to score locally.
 * Cached for CORPUS_TTL_MS so a chatty widget doesn't re-read it every message.
 * Returns null when the corpus is too big for this path — or when there is no
 * active knowledge at all (an empty corpus must NOT be cached as `[]` forever:
 * the merchant may be mid-ingest).
 *
 * Disabled sources are excluded here because this path never touches SQL:
 * migration_v10 added `documents.is_active`, and it has to be applied when the
 * corpus is built, not at query time.
 */
async function getSmallCorpus(organizationId) {
  const hit = corpusCache.get(organizationId);
  if (hit && Date.now() - hit.at < CORPUS_TTL_MS) return hit.rows;

  // One round-trip: ask for one row more than the "small" threshold. If that
  // many come back, the corpus is too big for the local path and we stop
  // caching a corpus we would never use.
  const { data, error } = await supabaseAdmin
    .from('document_sections')
    .select('id, document_id, content, documents!inner(is_active)')
    .eq('organization_id', organizationId)
    .eq('documents.is_active', true)
    .limit(SMALL_CORPUS_MAX + 1);

  if (error) {
    // A database that has not run migration_v10 yet has no `is_active`. Fall
    // back to the plain query so chat keeps working until the migration lands.
    if (/is_active/.test(error.message)) {
      const { data: plain, error: plainErr } = await supabaseAdmin
        .from('document_sections')
        .select('id, document_id, content')
        .eq('organization_id', organizationId)
        .limit(SMALL_CORPUS_MAX + 1);
      if (plainErr) {
        console.error('Corpus load error:', plainErr.message);
        return null;
      }
      return cacheCorpus(organizationId, (plain || []).map(stripJoin));
    }
    console.error('Corpus load error:', error.message);
    return null;
  }

  return cacheCorpus(organizationId, (data || []).map(stripJoin));
}

/** Drop the joined `documents` object — the scorer only needs id/content. */
function stripJoin(row) {
  if (!row) return row;
  const { documents, ...rest } = row;
  return rest;
}

/** Remember how big the corpus was; null = "too big for the local path". */
function cacheCorpus(organizationId, rows) {
  if (rows.length > SMALL_CORPUS_MAX) {
    corpusCache.set(organizationId, { rows: null, at: Date.now() });
    return null;
  }
  if (rows.length === 0) {
    // Cache emptiness only briefly so a first ingest shows up immediately.
    corpusCache.set(organizationId, { rows, at: Date.now() - CORPUS_TTL_MS + 10_000 });
    return rows;
  }
  corpusCache.set(organizationId, { rows, at: Date.now() });
  return rows;
}

/**
 * Per-document chunk counts, for the dashboard's knowledge table (how much of a
 * source the bot can actually quote is the number merchants ask about).
 * Returns a Map keyed by document_id.
 */
async function chunkCountsByDocument(organizationId) {
  const { data, error } = await supabaseAdmin
    .from('document_sections')
    .select('document_id')
    .eq('organization_id', organizationId)
    .limit(20000);

  if (error) {
    console.error('Chunk count error:', error.message);
    return new Map();
  }

  const counts = new Map();
  for (const row of data || []) {
    counts.set(row.document_id, (counts.get(row.document_id) || 0) + 1);
  }
  return counts;
}

/**
 * BM25-lite ranking in-process: score = Σ over query terms of
 * idf(term) × (term frequency in chunk), with idf = log(N / df).
 * Enough to put the right chunk first on small corpora, at zero latency.
 */
function rankByLexicalSimilarity(rows, query) {
  const tokenize = (text) =>
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097F\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);

  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length) return rows;

  const docTokens = rows.map((r) => tokenize(r.content));
  const df = new Map();
  queryTerms.forEach((t) => {
    let n = 0;
    docTokens.forEach((tokens) => {
      if (tokens.includes(t)) n += 1;
    });
    df.set(t, n);
  });

  const N = rows.length;
  return rows
    .map((row, i) => {
      const tokens = docTokens[i];
      let score = 0;
      for (const term of queryTerms) {
        const freq = tokens.filter((t) => t === term).length;
        if (!freq) continue;
        const idf = Math.log(1 + N / (1 + (df.get(term) || 0)));
        score += idf * (1 + Math.log(freq)); // log-damped term frequency
      }
      return { ...row, similarity: Number(score.toFixed(4)) };
    })
    .filter((r) => r.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity);
}

/** Drop cached corpus/embeddings for an org after its knowledge changes. */
function invalidateOrgCache(organizationId) {
  corpusCache.delete(organizationId);
}

async function deleteDocument(organizationId, documentId) {
  const { error } = await supabaseAdmin
    .from('documents')
    .delete()
    .eq('id', documentId)
    .eq('organization_id', organizationId); // tenant guard
  if (error) throw error;
  invalidateOrgCache(organizationId);
}

async function trackUsage(organizationId, eventType, tokens = 0) {
  await supabaseAdmin
    .from('usage_events')
    .insert({ organization_id: organizationId, event_type: eventType, tokens });
}

module.exports = {
  ingestDocument,
  deleteDocument,
  updateDocument,
  touchSyncedAt,
  retrieveContext,
  trackUsage,
  invalidateOrgCache,
  chunkCountsByDocument,
  // exported for unit testing of the local scorer
  rankByLexicalSimilarity,
};
