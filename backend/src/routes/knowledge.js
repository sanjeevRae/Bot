const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const {
  ingestDocument,
  deleteDocument,
  updateDocument,
  touchSyncedAt,
  retrieveContext,
  invalidateOrgCache,
  chunkCountsByDocument,
} = require('../services/rag');
const { crawlSite, chunkByParagraphs } = require('../services/ingest');
const { importGoogleDrive, importNotion } = require('../services/imports');
const { extractFile, ACCEPTED_FILE_TYPES } = require('../services/extract');
const { fetchYouTubeTranscript } = require('../services/youtube');
const { buildStructuredText, INDUSTRY_TEMPLATES } = require('../services/structured');
const { documentLimit } = require('../services/quotas');
const { isTranscriptionEnabled } = require('../services/transcribe');

const router = express.Router();
router.use(requireAuth);

/**
 * Curated knowledge base (V10).
 *
 * Add sources:
 *   POST /crawl          website crawl (`refresh: true` re-syncs in place)
 *   POST /text           pasted text
 *   POST /structured     business facts + Q&A + prices typed in the dashboard
 *   POST /upload         one or many files (PDF/DOCX/XLSX/PPTX/TXT/CSV/image/audio)
 *   POST /youtube        video transcript
 *   POST /drive|notion   shared-link imports
 *
 * Curate:
 *   GET    /             list with chunk counts + quota
 *   GET    /stats        quota + totals
 *   GET    /sections/:id chunk preview for one document
 *   PATCH  /:id          rename / enable / disable
 *   DELETE /:id          delete
 *
 * Verify:
 *   POST   /search       "test your knowledge" — what would the bot retrieve?
 */

/** Columns to return for a document: adds the V10 columns when they exist. */
function docColumns(withV10 = true) {
  const base = 'id, title, source_type, url, status, created_at';
  return withV10 ? `${base}, is_active, last_synced_at` : base;
}

/** A database that has not run migration_v10 rejects the new columns. */
function needsV10Fallback(error) {
  return Boolean(error) && /is_active|last_synced_at/.test(error.message || '');
}

/** GET /api/knowledge — list tenant documents with chunk counts and quota */
router.get('/', async (req, res) => {
  try {
    const withV10 = req.query.legacy !== '1';

    const [{ data, error }, counts, limit] = await Promise.all([
      supabaseAdmin
        .from('documents')
        .select(docColumns(withV10))
        .eq('organization_id', req.orgId)
        .order('created_at', { ascending: false }),
      chunkCountsByDocument(req.orgId),
      documentLimit(req.orgId),
    ]);

    if (error) {
      if (needsV10Fallback(error)) {
        // Retry without the V10 columns so the page still loads pre-migration.
        const { data: plain, error: plainErr } = await supabaseAdmin
          .from('documents')
          .select(docColumns(false))
          .eq('organization_id', req.orgId)
          .order('created_at', { ascending: false });
        if (plainErr) return res.status(500).json({ error: plainErr.message });
        const documents = (plain || []).map((d) => ({ ...d, is_active: true, chunks: counts.get(d.id) || 0 }));
        return res.json({
          documents,
          quota: { documents: { used: documents.length, limit }, chunks: { used: 0, limit: null } },
          migrationPending: true,
        });
      }
      return res.status(500).json({ error: error.message });
    }

    const documents = (data || []).map((d) => ({ ...d, chunks: counts.get(d.id) || 0 }));
    res.json({
      documents,
      quota: {
        documents: { used: documents.length, limit },
        chunks: { used: [...counts.values()].reduce((a, b) => a + b, 0), limit: null },
      },
      audioEnabled: isTranscriptionEnabled(),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** GET /api/knowledge/stats — quota + totals for the header meter (cheap) */
router.get('/stats', async (req, res) => {
  try {
    const [counts, limit, { count, error }] = await Promise.all([
      chunkCountsByDocument(req.orgId),
      documentLimit(req.orgId),
      supabaseAdmin
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', req.orgId),
    ]);

    if (error) return res.status(500).json({ error: error.message });

    res.json({
      documents: { used: count || 0, limit },
      chunks: { used: [...counts.values()].reduce((a, b) => a + b, 0), limit: null },
      audioEnabled: isTranscriptionEnabled(),
      acceptedFileTypes: ACCEPTED_FILE_TYPES,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** GET /api/knowledge/structured — industry starter templates for the facts form */
router.get('/structured', (_req, res) => {
  res.json({ templates: INDUSTRY_TEMPLATES });
});

/** POST /api/knowledge/search — what would the assistant retrieve for this query? */
router.post('/search', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    if (query.length < 2) return res.status(400).json({ error: 'Type a question to test' });

    // A merchant testing search expects fresh results, not a cached corpus.
    invalidateOrgCache(req.orgId);
    const started = Date.now();
    const hits = await retrieveContext(req.orgId, query, Math.min(parseInt(req.body?.limit, 10) || 5, 12));
    const elapsedMs = Date.now() - started;

    const meta = new Map();
    const ids = [...new Set((hits || []).map((h) => h.document_id).filter(Boolean))];
    if (ids.length) {
      const { data } = await supabaseAdmin
        .from('documents')
        .select('id, title, source_type')
        .eq('organization_id', req.orgId)
        .in('id', ids);
      for (const d of data || []) meta.set(d.id, d);
    }

    res.json({
      query,
      elapsedMs,
      matches: (hits || []).map((h) => ({
        id: h.id,
        documentId: h.document_id,
        title: meta.get(h.document_id)?.title || `Document ${h.document_id}`,
        sourceType: meta.get(h.document_id)?.source_type,
        similarity: h.similarity,
        content: String(h.content || '').slice(0, 900),
      })),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** GET /api/knowledge/sections/:id — chunk preview for one document */
router.get('/sections/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid document id' });

    const { data: doc, error: docErr } = await supabaseAdmin
      .from('documents')
      .select(docColumns())
      .eq('id', id)
      .eq('organization_id', req.orgId)
      .maybeSingle();

    let document = doc;
    if (docErr && needsV10Fallback(docErr)) {
      const { data: plain } = await supabaseAdmin
        .from('documents')
        .select(docColumns(false))
        .eq('id', id)
        .eq('organization_id', req.orgId)
        .maybeSingle();
      document = plain ? { ...plain, is_active: true } : null;
    } else if (docErr) {
      return res.status(500).json({ error: docErr.message });
    }
    if (!document) return res.status(404).json({ error: 'Document not found' });

    const { data: sections, count, error } = await supabaseAdmin
      .from('document_sections')
      .select('id, content', { count: 'exact' })
      .eq('document_id', id)
      .eq('organization_id', req.orgId)
      .order('id', { ascending: true })
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });

    res.json({ document, total: count || 0, shown: (sections || []).length, sections: sections || [] });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * PATCH /api/knowledge/:id — rename and/or enable-disable a source.
 * Declared after every literal path ("/stats", "/search", …) so "refresh" or
 * "search" can never be parsed as an id.
 */
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid document id' });

    const updated = await updateDocument(req.orgId, id, {
      title: req.body?.title,
      is_active: typeof req.body?.is_active === 'boolean' ? req.body.is_active : undefined,
    });
    res.json({ ok: true, document: updated });
  } catch (err) {
    // Pre-migration databases have no `is_active` column — say what to run.
    if (/is_active/.test(err.message || '')) {
      return res.status(400).json({
        error: 'Pausing sources needs backend/supabase/migration_v10_knowledge.sql to be run in Supabase first.',
      });
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** POST /api/knowledge/crawl — crawl a website URL */
router.post('/crawl', async (req, res) => {
  try {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    let normalized = url.trim();
    if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;

    const { text, pages } = await crawlSite(normalized);
    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Could not extract meaningful content from that URL' });
    }

    // Refresh mode: replace the previous crawl of the same URL instead of
    // stacking a duplicate (lets merchants re-sync prices/stock periodically).
    if (req.body.refresh) {
      const { data: old } = await supabaseAdmin
        .from('documents')
        .select('id')
        .eq('organization_id', req.orgId)
        .eq('url', normalized)
        .eq('source_type', 'crawl');
      for (const doc of old || []) {
        try { await deleteDocument(req.orgId, doc.id); } catch { /* keep going */ }
      }
    }

    const result = await ingestDocument({
      organizationId: req.orgId,
      title: title || new URL(normalized).hostname,
      sourceType: 'crawl',
      url: normalized,
      text,
    });
    res.json({ ok: true, ...result, pagesCrawled: pages.length, pages });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** POST /api/knowledge/text — manual entry / paste FAQs */
router.post('/text', async (req, res) => {
  try {
    const { title, text } = req.body;
    if (!text || text.trim().length < 20) {
      return res.status(400).json({ error: 'Please provide at least a sentence of content' });
    }
    const body = String(text);
    // Content that already looks like facts or FAQ lines ("Label: value",
    // blank-line separated blocks) keeps far more meaning when chunked by
    // paragraph than on a blind word window — see chunkByParagraphs.
    const looksStructured = /\n\s*\n/.test(body) || /^[^\n:]{2,40}:/m.test(body);
    const result = await ingestDocument({
      organizationId: req.orgId,
      title: title || 'Manual notes',
      sourceType: 'manual',
      text: body,
      structured: looksStructured,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** POST /api/knowledge/upload — file upload (txt/md/pdf) */
router.post('/upload', async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: 'No file uploaded (field name: "file")' });
    }

    // Accept one file or many: the dashboard lets a merchant drop a whole folder
    // of price lists at once (express-fileupload returns an array in that case).
    const list = Array.isArray(req.files.file) ? req.files.file : [req.files.file];
    if (list.length > 8) {
      return res.status(400).json({ error: 'Upload up to 8 files at a time.' });
    }

    const results = [];
    for (const file of list) {
      try {
        // Extraction runs BEFORE ingestion so a parse failure never leaves a
        // half-ingested "processing" row behind.
        const { text, kind, sourceType, meta } = await extractFile(file);
        const result = await ingestDocument({
          organizationId: req.orgId,
          title: file.name,
          sourceType,
          text,
          // Spreadsheets and OCR output are row/line oriented — paragraph-aware
          // chunking keeps a row group together with its heading.
          structured: kind === 'sheet' || kind === 'image',
        });
        results.push({ file: file.name, ok: true, kind, meta, ...result });
      } catch (err) {
        results.push({ file: file.name, ok: false, error: err.message });
      }
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length) {
      // Nothing landed: surface the first reason as the HTTP error.
      const first = failed[0];
      return res.status(400).json({ error: first.error, results });
    }

    res.json({ ok: true, results, added: results.length - failed.length, failed: failed.length });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/knowledge/structured — business facts, prices and Q&A typed in.
 *
 * This is the highest-accuracy way to teach the bot: a merchant states their
 * hours, fees and prices exactly, instead of hoping a crawl of their site
 * captured them. The payload is turned into "Label: value" lines and "Q:/A:"
 * blocks (services/structured.js) and ingested with paragraph chunking so each
 * fact stays whole.
 */
router.post('/structured', async (req, res) => {
  try {
    const { text, title, sections } = buildStructuredText(req.body || {});
    if (!text || text.length < 20) {
      return res.status(400).json({ error: 'Fill in at least one detail before saving' });
    }

    const result = await ingestDocument({
      organizationId: req.orgId,
      title,
      sourceType: 'structured',
      text,
      structured: true,
    });

    res.json({ ok: true, ...result, sections });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/knowledge/refresh — re-crawl a website source in place.
 * Keeps the merchant's title and active flag; replaces the content. This is the
 * button that makes a knowledge base maintainable (prices and hours change).
 * Declared before PATCH/DELETE `/:id` so "refresh" is never read as an id.
 */
router.post('/refresh', async (req, res) => {
  try {
    const id = parseInt(req.body?.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id is required' });

    const { data: doc, error } = await supabaseAdmin
      .from('documents')
      .select('id, title, url, source_type')
      .eq('id', id)
      .eq('organization_id', req.orgId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.source_type !== 'crawl' || !doc.url) {
      return res.status(400).json({ error: 'Only website sources can be re-synced. Delete and re-add other sources.' });
    }

    const { text, pages } = await crawlSite(doc.url);
    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Could not extract meaningful content from that URL' });
    }

    await deleteDocument(req.orgId, doc.id);
    const result = await ingestDocument({
      organizationId: req.orgId,
      title: doc.title,
      sourceType: 'crawl',
      url: doc.url,
      text,
    });

    res.json({ ok: true, ...result, pagesCrawled: pages.length });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** POST /api/knowledge/youtube — learn from a video transcript */
router.post('/youtube', async (req, res) => {
  try {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const video = await fetchYouTubeTranscript(url);
    const result = await ingestDocument({
      organizationId: req.orgId,
      title: title || `${video.title} (transcript)`,
      sourceType: 'youtube',
      url: video.url,
      text: video.text,
      // Captions are rebuilt into sentences, so word-window chunking is fine.
      structured: false,
    });

    res.json({
      ok: true,
      ...result,
      videoTitle: video.title,
      language: video.language,
      autoCaptions: video.auto,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** POST /api/knowledge/drive — import a shared Google Drive file */
router.post('/drive', async (req, res) => {
  try {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const result = await importGoogleDrive({ organizationId: req.orgId, url, title });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** POST /api/knowledge/notion — import a publicly shared Notion page */
router.post('/notion', async (req, res) => {
  try {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const result = await importNotion({ organizationId: req.orgId, url, title });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** DELETE /api/knowledge/:id */
router.delete('/:id', async (req, res) => {
  try {
    await deleteDocument(req.orgId, parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
