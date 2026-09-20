const supabaseAdmin = require('../lib/supabase');
const { embedText } = require('./embeddings');
const config = require('../config');
const { fixMojibake } = require('../lib/textNormalize');

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
 */
async function ingestDocument({ organizationId, title, sourceType, url, text }) {
  // Repair UTF-8/CP1252 mojibake coming from third-party sources (crawled sites,
  // pasted text, imports) before it is stored, so the dashboard, knowledge base,
  // bot answers and emails never display garbled characters.
  // Safe by construction: text containing genuine Unicode (Devanagari, emoji,
  // CJK, accented Latin) can never be altered by fixMojibake.
  if (typeof title === 'string') title = fixMojibake(title);
  if (typeof url === 'string') url = fixMojibake(url);
  if (typeof text === 'string') text = fixMojibake(text);
  // Enforce free-tier document quota
  const { count } = await supabaseAdmin
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId);

  if (count >= config.freeTierQuotas.documentsMax) {
    throw Object.assign(new Error(`Free plan limit reached (${config.freeTierQuotas.documentsMax} documents). Upgrade to add more.`), { status: 402 });
  }

  const { data: doc, error: docErr } = await supabaseAdmin
    .from('documents')
    .insert({ organization_id: organizationId, title, source_type: sourceType, url, status: 'processing' })
    .select()
    .single();

  if (docErr) throw docErr;

  try {
    const chunks = require('./ingest').chunkText(text);
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
 * Returns null when the corpus is too big for this path.
 */
async function getSmallCorpus(organizationId) {
  const hit = corpusCache.get(organizationId);
  if (hit && Date.now() - hit.at < CORPUS_TTL_MS) return hit.rows;

  // One round-trip: ask for one row more than the "small" threshold. If that
  // many come back, the corpus is too big for the local path and we stop
  // caching a corpus we would never use.
  const { data, error } = await supabaseAdmin
    .from('document_sections')
    .select('id, document_id, content')
    .eq('organization_id', organizationId)
    .limit(SMALL_CORPUS_MAX + 1);

  if (error) {
    console.error('Corpus load error:', error.message);
    return null;
  }

  const rows = data || [];
  if (rows.length > SMALL_CORPUS_MAX) {
    corpusCache.set(organizationId, { rows: null, at: Date.now() });
    return null;
  }

  corpusCache.set(organizationId, { rows, at: Date.now() });
  return rows;
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
  retrieveContext,
  trackUsage,
  invalidateOrgCache,
  // exported for unit testing of the local scorer
  rankByLexicalSimilarity,
};
