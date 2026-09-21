/**
 * One place that turns an uploaded file into plain text for the knowledge base.
 *
 * Why a dispatcher instead of inline ifs in the route:
 *   - the route stays about tenancy/quota/response shaping,
 *   - every format gets the same 5 MB guard and the same readable error copy,
 *   - new formats (see migration_v10_knowledge.sql source_type list) are added
 *     in one switch.
 *
 * Every heavy parser is `require`d lazily so a cold start (and every OCR-free
 * upload) never pays for loading them.
 */

/** Max upload we are willing to parse in-process on a free-tier instance. */
const MAX_FILE_BYTES = parseInt(process.env.KB_MAX_FILE_BYTES || String(5 * 1024 * 1024), 10);

/** source_type written to `documents` for each kind of file. */
const SOURCE_TYPE = {
  pdf: 'upload',
  text: 'upload',
  document: 'document',
  sheet: 'sheet',
  slides: 'slides',
  image: 'image',
  audio: 'audio',
};

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|log|rtf|vtt|srt|html?|xml|ya?ml)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const AUDIO_EXTENSIONS = /\.(mp3|m4a|mp4|mpeg|mpga|wav|webm|ogg|oga|flac|aac|opus)$/i;

/** Human-readable list of everything `detectKind` understands. */
const ACCEPTED_FILE_TYPES =
  'PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), TXT, MD, CSV, JSON, ' +
  'images (.png/.jpg/.webp — menu or price-list photo) or audio (.mp3/.m4a/.wav/.ogg — voice note)';

function extensionOf(name = '') {
  const m = String(name).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : '';
}

/**
 * Decide how to parse a file. The browser-provided mimetype is unreliable
 * (empty or generic on Windows), so the extension wins whenever it is known.
 */
function detectKind(file) {
  const name = (file?.name || '').toLowerCase();
  const mime = (file?.mimetype || '').toLowerCase();
  const ext = extensionOf(name);

  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (ext === '.docx' || ext === '.doc' || mime.includes('wordprocessingml')) return 'document';
  if (ext === '.xlsx' || ext === '.xls' || ext === '.ods' || mime.includes('spreadsheet')) return 'sheet';
  if (ext === '.pptx' || ext === '.ppt' || ext === '.odp' || mime.includes('presentation')) return 'slides';
  if (IMAGE_EXTENSIONS.test(ext) || /^image\//.test(mime)) return 'image';
  if (AUDIO_EXTENSIONS.test(ext) || /^(audio|video)\//.test(mime)) return 'audio';
  if (TEXT_EXTENSIONS.test(ext) || /^text\/|json|markdown|csv/.test(mime)) return 'text';
  return null;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Decode the handful of entities spreadsheet/Office XML export tends to leave. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------- PDF
async function fromPdf(file) {
  const pdfParse = require('pdf-parse');
  const pdf = await pdfParse(file.data);
  return pdf.text;
}

// ---------------------------------------------------------------- plain text
async function fromText(file) {
  return file.data.toString('utf8');
}

// ---------------------------------------------------------------- .docx
async function fromDocument(file) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: file.data });
  return value;
}

// ---------------------------------------------------------------- .xlsx
/**
 * One spreadsheet becomes a "Sheet: name" heading plus one line per row, with
 * columns joined by " | ". Prices in a sheet are exactly the fact a bot must
 * quote correctly, so rows are kept verbatim rather than summarised away.
 */
async function fromSpreadsheet(file) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(file.data, { type: 'buffer' });
  const parts = [];

  for (const sheetName of wb.SheetNames.slice(0, 20)) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    const lines = rows
      .slice(0, 2000)
      .map((row) => row.map((cell) => String(cell).trim()).filter(Boolean).join(' | '))
      .filter((line) => line.length > 1);
    if (!lines.length) continue;
    parts.push(`Sheet: ${sheetName}\n${lines.join('\n')}`);
  }

  if (!parts.length) throw badRequest('That spreadsheet looks empty.');
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- .pptx
async function fromSlides(file) {
  // officeparser v8 exposes an async `parseOffice` that accepts a Buffer; older
  // builds shipped `parseOfficeAsync` (or a path-only `parseOffice`). Support
  // both shapes so a dependency bump cannot silently break slide uploads.
  const officeparser = require('officeparser');
  const parser = officeparser.parseOfficeAsync || officeparser.parseOffice;
  if (typeof parser !== 'function') {
    throw badRequest('Slide parsing is unavailable on this deployment. Upload the deck as PDF instead.');
  }
  return parser.call(officeparser, file.data);
}

// ---------------------------------------------------------------- image → OCR
/**
 * Menu and price-list photos are the single most common thing a small shop has.
 * Free OCR via OCR.space (no card). Without a key we fail with copy that tells
 * the merchant what to do instead of a stack trace.
 */
async function fromImage(file) {
  return require('./ocr').ocrImage(file.data, file.name);
}

// ---------------------------------------------------------------- audio → text
async function fromAudio(file) {
  return require('./transcribe').transcribeAudio(file.data, file.name, file.mimetype);
}

/**
 * Extract text from an uploaded file.
 *
 * @param {{name:string, mimetype:string, size:number, data:Buffer}} file
 * @returns {Promise<{text:string, kind:string, sourceType:string, meta?:object}>}
 */
async function extractFile(file) {
  if (!file || !file.data) throw badRequest('No file received.');
  if (file.size > MAX_FILE_BYTES) {
    throw badRequest(`File too large (max ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB).`);
  }

  const kind = detectKind(file);
  if (!kind) throw badRequest(`Unsupported file type. Use ${ACCEPTED_FILE_TYPES}.`);

  let text = '';
  let meta;

  switch (kind) {
    case 'pdf': text = await fromPdf(file); break;
    case 'text': text = await fromText(file); break;
    case 'document': text = await fromDocument(file); break;
    case 'sheet': text = await fromSpreadsheet(file); break;
    case 'slides': text = await fromSlides(file); break;
    case 'image': {
      const out = await fromImage(file);
      text = out.text;
      meta = out.meta;
      break;
    }
    case 'audio': {
      const out = await fromAudio(file);
      text = out.text;
      meta = out.meta;
      break;
    }
    default: throw badRequest(`Unsupported file type. Use ${ACCEPTED_FILE_TYPES}.`);
  }

  text = cleanText(decodeEntities(text));
  if (text.length < 20) {
    throw badRequest(
      kind === 'image'
        ? 'No readable text found in that image. Try a sharper, well-lit photo.'
        : 'Could not extract text from that file.'
    );
  }

  return { text, kind, sourceType: SOURCE_TYPE[kind] || 'upload', meta };
}

module.exports = {
  extractFile,
  detectKind,
  extensionOf,
  decodeEntities,
  cleanText,
  ACCEPTED_FILE_TYPES,
  MAX_FILE_BYTES,
};
