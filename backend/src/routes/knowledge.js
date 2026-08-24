const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { ingestDocument, deleteDocument } = require('../services/rag');
const { crawlUrl } = require('../services/ingest');
const { importGoogleDrive, importNotion } = require('../services/imports');

const router = express.Router();
router.use(requireAuth);

/** GET /api/knowledge — list tenant documents */
router.get('/', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('documents')
    .select('id, title, source_type, url, status, created_at')
    .eq('organization_id', req.orgId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ documents: data || [] });
});

/** POST /api/knowledge/crawl — crawl a website URL */
router.post('/crawl', async (req, res) => {
  try {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    let normalized = url.trim();
    if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;

    const text = await crawlUrl(normalized);
    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Could not extract meaningful content from that URL' });
    }

    const result = await ingestDocument({
      organizationId: req.orgId,
      title: title || new URL(normalized).hostname,
      sourceType: 'crawl',
      url: normalized,
      text,
    });
    res.json({ ok: true, ...result });
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
    const result = await ingestDocument({
      organizationId: req.orgId,
      title: title || 'Manual notes',
      sourceType: 'manual',
      text,
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
    const file = req.files.file;

    if (file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 5MB on free plan)' });
    }

    let text = '';
    if (file.mimetype === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      const pdf = await pdfParse(file.data);
      text = pdf.text;
    } else if (/^text\/|json|markdown|csv/.test(file.mimetype) || /\.(txt|md|csv|json)$/i.test(file.name)) {
      text = file.data.toString('utf8');
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Use PDF, TXT, MD or CSV.' });
    }

    if (!text || text.trim().length < 20) {
      return res.status(400).json({ error: 'Could not extract text from file' });
    }

    const result = await ingestDocument({
      organizationId: req.orgId,
      title: file.name,
      sourceType: 'upload',
      text,
    });
    res.json({ ok: true, ...result });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
