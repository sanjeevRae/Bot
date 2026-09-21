const config = require('../config');

/**
 * Image → text (OCR) for the knowledge base.
 *
 * Menu photos, handwritten price lists and supplier catalogues are the most
 * common "document" a small business actually owns, and they are images, not
 * files. Free-tier friendly options:
 *
 *   1. OCR.space  — HTTP API, no card, 25k requests/month, works from Render
 *                   with a single key (OCR_SPACE_API_KEY).
 *   2. Groq vision — reuses the Groq key we already have (llama-4 scout / maverick
 *                   multimodal models) when no OCR key is configured.
 *
 * If neither is configured we throw a 400 with copy that tells the merchant to
 * paste the text instead of showing a stack trace.
 */

const OCR_ENDPOINT = process.env.OCR_SPACE_ENDPOINT || 'https://api.ocr.space/parse/image';
const OCR_TIMEOUT_MS = parseInt(process.env.OCR_TIMEOUT_MS || '25000', 10);

/** Groq's multimodal models (used only as the OCR fallback). */
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

function mimeFor(name = '') {
  const ext = String(name).toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1];
  return MIME_BY_EXT[ext] || 'image/jpeg';
}

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** OCR.space returns "Error" strings per page when it cannot read the image. */
function cleanupOcrSpacesText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 1)
    .join('\n')
    .trim();
}

async function ocrWithOcrSpace(buffer, name) {
  const key = config.knowledge.ocrSpaceKey;
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeFor(name) }), name || 'upload.jpg');
  form.append('language', config.knowledge.ocrLanguage || 'eng');
  form.append('isOverlayRequired', 'false');
  // Auto-orient + decent accuracy: cheap, and menus are usually photographed
  // at an angle. '2' = auto-detect text orientation.
  form.append('OCREngine', '2');
  form.append('detectOrientation', 'true');
  form.append('scale', 'true');

  const res = await fetch(OCR_ENDPOINT, {
    method: 'POST',
    headers: { apikey: key },
    body: form,
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.IsErroredOnProcessing) {
    const detail = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(' ') : data.ErrorMessage;
    throw badRequest(`Could not read that image (${detail || `HTTP ${res.status}`}).`);
  }

  const text = cleanupOcrSpacesText(
    (data.ParsedResults || []).map((r) => r.ParsedText).filter(Boolean).join('\n\n')
  );
  if (!text || text.length < 20) {
    throw badRequest('No readable text found in that image. Try a sharper, well-lit photo.');
  }

  return { text, meta: { ocr: 'ocr.space', language: config.knowledge.ocrLanguage } };
}

async function ocrWithGroq(buffer, name) {
  const key = config.groq.apiKey;
  const mime = mimeFor(name);
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      temperature: 0,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Transcribe every piece of text in this image exactly as written, keeping the ' +
                'original line structure. For menus and price lists keep each item together with ' +
                'its price on one line. Output plain text only — no commentary, no markdown.',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(parseInt(process.env.OCR_VISION_TIMEOUT_MS || '25000', 10)),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw badRequest(`Could not read that image (vision model returned ${res.status}). ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = cleanupOcrSpacesText(data.choices?.[0]?.message?.content);
  if (!text || text.length < 20) {
    throw badRequest('No readable text found in that image. Try a sharper, well-lit photo.');
  }

  return { text, meta: { ocr: 'groq-vision', model: VISION_MODEL } };
}

/**
 * Read text out of an image.
 * @param {Buffer} buffer
 * @param {string} name original filename (used to guess the mime type)
 * @returns {Promise<{text:string, meta:object}>}
 */
async function ocrImage(buffer, name) {
  if (!buffer || !buffer.length) throw badRequest('Empty image upload.');

  if (config.knowledge.ocrSpaceKey) {
    try {
      return await ocrWithOcrSpace(buffer, name);
    } catch (err) {
      // A configured-but-failing OCR provider should still fall back rather
      // than block the merchant from training on a photo.
      if (!config.groq.apiKey) throw err;
      console.warn('OCR.space failed, falling back to Groq vision:', err.message);
    }
  }

  if (config.groq.apiKey) return ocrWithGroq(buffer, name);

  throw badRequest(
    'Image OCR is not configured on this deployment. Paste the text instead, or ask the ' +
      'operator to set OCR_SPACE_API_KEY.'
  );
}

module.exports = { ocrImage, cleanupOcrSpacesText, mimeFor };
