const supabaseAdmin = require('../lib/supabase');
const { embedText } = require('./embeddings');
const config = require('../config');

/**
 * Ingest a document: chunk -> embed -> store sections.
 * Tenant-scoped: everything is filtered by organizationId.
 */
async function ingestDocument({ organizationId, title, sourceType, url, text }) {
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
      content,
      embedding: vectors[i],
    }));

    // Insert in batches of 50
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await supabaseAdmin.from('document_sections').insert(rows.slice(i, i + 50));
      if (error) throw error;
    }

    await supabaseAdmin.from('documents').update({ status: 'ready' }).eq('id', doc.id);
    await trackUsage(organizationId, 'embedding', rows.length);

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
  const embedding = await embedText(query);

  const { data, error } = await supabaseAdmin.rpc('match_document_sections', {
    query_embedding: embedding,
    match_count: topK,
    org_id: organizationId,
  });

  if (error) {
    console.error('Retrieval error:', error.message);
    return [];
  }
  return data || [];
}

async function trackUsage(organizationId, eventType, tokens = 0) {
  await supabaseAdmin
    .from('usage_events')
    .insert({ organization_id: organizationId, event_type: eventType, tokens });
}

module.exports = { ingestDocument, deleteDocument, retrieveContext, trackUsage };
