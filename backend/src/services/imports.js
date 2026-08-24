const { ingestDocument } = require('./rag');
const { extractTextFromHtml } = require('./ingest');

/**
 * V2 knowledge imports: Google Drive & Notion.
 *
 * Free-tier friendly approach — no OAuth required:
 *  - Google Drive: user shares a file "Anyone with the link" and pastes the
 *    share URL. We download it via the direct-download endpoint and extract
 *    text (txt/md/csv natively; PDF via pdf-parse).
 *  - Notion: user creates a public share link ("Share to web") to a page and
 *    we fetch + strip the HTML.
 */

async function importGoogleDrive({ organizationId, url, title }) {
  const fileId = extractDriveFileId(url);
  if (!fileId) throw Object.assign(new Error('Could not parse a Google Drive file ID from that URL'), { status: 400 });

  const res = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw Object.assign(
      new Error('Could not download the file. Make sure sharing is set to "Anyone with the link".'),
      { status: 400 }
    );
  }

  const contentType = res.headers.get('content-type') || '';
  let text = '';

  if (contentType.includes('pdf')) {
    const pdfParse = require('pdf-parse');
    const buf = Buffer.from(await res.arrayBuffer());
    text = (await pdfParse(buf)).text;
  } else if (/^text\/|json|markdown|csv/.test(contentType)) {
    text = await res.text();
  } else {
    // Try as text anyway (Drive sometimes returns octet-stream)
    const maybe = await res.text();
    // Heuristic: reject binary garbage
    if (maybe.includes('\u0000')) {
      throw Object.assign(new Error('Unsupported Drive file type. Use Docs exported as TXT/MD/CSV or PDF.'), { status: 400 });
    }
    text = maybe;
  }

  if (!text || text.trim().length < 20) {
    throw Object.assign(new Error('Could not extract text from that Drive file'), { status: 400 });
  }

  return ingestDocument({
    organizationId,
    title: title || 'Google Drive document',
    sourceType: 'drive',
    url,
    text,
  });
}

async function importNotion({ organizationId, url, title }) {
  if (!/notion\.(so|site)/.test(url)) {
    throw Object.assign(new Error('Please paste a Notion page URL'), { status: 400 });
  }

  const res = await fetch(url, {
    headers: { 'User-Agent': 'ChitraAI-Bot/1.0 (+https://chitra.ai)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw Object.assign(
      new Error('Could not load that page. Make sure it is shared publicly ("Share to web").'),
      { status: 400 }
    );
  }

  let html = await res.text();

  // Notion pages are JS-rendered; the raw HTML contains the content in a
  // __NEXT_DATA__ payload. Prefer extracting plain text from it when present.
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  let text = '';
  if (nextDataMatch) {
    try {
      const texts = [];
      const walk = (v) => {
        if (typeof v === 'string') {
          if (v.length > 30 && /[a-zA-Z]/.test(v) && !/^notion|^https?:/.test(v)) texts.push(v);
        } else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(JSON.parse(nextDataMatch[1]));
      text = [...new Set(texts)].join('\n\n');
    } catch { /* fall through to html extraction */ }
  }
  if (!text || text.trim().length < 50) {
    text = extractTextFromHtml(html);
  }

  if (!text || text.trim().length < 50) {
    throw Object.assign(
      new Error('Could not extract content. Make sure the page is shared publicly via "Share to web".'),
      { status: 400 }
    );
  }

  return ingestDocument({
    organizationId,
    title: title || 'Notion page',
    sourceType: 'notion',
    url,
    text,
  });
}

function extractDriveFileId(url) {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

module.exports = { importGoogleDrive, importNotion };
