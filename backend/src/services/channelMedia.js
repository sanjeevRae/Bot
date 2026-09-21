const { transcribeAudio, isTranscriptionEnabled } = require('./transcribe');
const { ocrImage } = require('./ocr');

/**
 * Rich inbound messages → chat text (V11).
 *
 * A customer on WhatsApp/Messenger rarely sends clean text: voice notes,
 * menu photos, live locations, stickers, button taps. Previously every one of
 * those was dropped silently (Meta router `continue`d, the OpenWA worker
 * `return`ed) — the worst possible behaviour, because the customer thinks the
 * business ignored them.
 *
 * This module turns each flavour into something the chat pipeline already
 * understands:
 *   - voice/audio  → Groq Whisper transcription (same code the knowledge base
 *                    uses for uploaded voice notes)
 *   - image        → OCR.space / Groq-vision text (same code as menu photos)
 *   - location     → "Shared location: lat,lng" — the bot can answer with
 *                    delivery coverage, directions, "we deliver there"
 *   - interactive  → the tapped button's id/payload becomes the message, so
 *                    "Book a table" taps flow through booking like typed words
 *   - sticker/etc  → a labelled placeholder so retrieval/history show that
 *                    something happened instead of silence
 *
 * Budgets are deliberately channel-tight, not knowledge-base-tight: a 90 s
 * voice note and a 90 s upload are different cost profiles. Media is capped
 * small (voice ≤ 3 MB / ~3 min ogg-opus; image ≤ 2 MB) with fast deadlines so
 * a slow download never holds the visitor's reply hostage — failures fall
 * back to a one-line "couldn't hear that, please type it" via `fallbackText`.
 */

// ------ Budgets (per message, not per upload) ------
const VOICE_MAX_BYTES = parseInt(process.env.CHANNEL_VOICE_MAX_BYTES || String(3 * 1024 * 1024), 10);
const IMAGE_MAX_BYTES = parseInt(process.env.CHANNEL_IMAGE_MAX_BYTES || String(2 * 1024 * 1024), 10);
const MEDIA_FETCH_TIMEOUT_MS = parseInt(process.env.CHANNEL_MEDIA_FETCH_TIMEOUT_MS || '20000', 10);
const MEDIA_STT_TIMEOUT_MS = parseInt(process.env.CHANNEL_MEDIA_STT_TIMEOUT_MS || '45000', 10);
const MEDIA_OCR_TIMEOUT_MS = parseInt(process.env.CHANNEL_MEDIA_OCR_TIMEOUT_MS || '30000', 10);

/** Download a media URL to a Buffer with size + time guards. Null on failure. */
async function fetchMedia(url, maxBytes, headers = {}) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    return buf;
  } catch (err) {
    console.warn('[channel-media] download failed:', err.message);
    return null;
  }
}

function badMedia(kind) {
  return Object.assign(new Error(`Could not process that ${kind}.`), { status: 400 });
}

/**
 * Voice note → chat text. The caller passes whatever filename/mimetype the
 * platform reports (Meta: audio/ogg; OpenWA: often `audio`, sometimes
 * nothing) so Whisper still gets a usable container hint.
 */
async function voiceToText(buffer, { name = 'voice-note.ogg', mimetype } = {}) {
  if (!buffer || buffer.length > VOICE_MAX_BYTES) throw badMedia('voice message');
  if (!isTranscriptionEnabled()) throw badMedia('voice message');
  return (await transcribeAudio(buffer, name, mimetype)).text;
}

/** Photo / screenshot → chat text. */
async function imageToText(buffer, { name = 'photo.jpg' } = {}) {
  if (!buffer || buffer.length > IMAGE_MAX_BYTES) throw badMedia('photo');
  return (await ocrImage(buffer, name)).text;
}

/**
 * Normalise one inbound message into the text the pipeline will answer.
 *
 * @param {object} msg platform-shaped message parts:
 *   { kind: 'text'|'audio'|'voice'|'image'|'location'|'interactive'|'button'|'sticker'|'other',
 *     text?, mediaUrl?, mediaHeaders?, mediaName?, mimetype?,
 *     latitude?, longitude?, locationName?,
 *     interactiveId?, interactiveTitle?, caption? }
 * @returns {Promise<{text:string, mediaKind:string|null, mediaFailed:boolean}>}
 *   `mediaFailed` is true when the media existed but couldn't be read — the
 *   caller turns that into the one-line "please type it" fallback instead of
 *   sending a useless placeholder to the model. Meta and OpenWA both funnel
 *   through here so behaviour is identical on both transports.
 */
async function normalizeInbound(msg = {}) {
  const kind = msg.kind || (msg.text ? 'text' : 'other');

  // Plain text — captions on media messages travel as the body on most
  // platforms and are cheap gold for the retriever, so prefer them when the
  // media itself can't be fetched.
  if (kind === 'text') {
    return { text: String(msg.text || '').trim(), mediaKind: null, mediaFailed: false };
  }

  // Buttons / quick replies / list picks: the tap IS the message.
  if (kind === 'interactive' || kind === 'button') {
    const picked = String(msg.interactiveTitle || msg.interactiveId || '').trim();
    const fallback = picked || String(msg.text || '').trim();
    return {
      text: fallback || '[customer tapped a button]',
      mediaKind: 'interactive',
      mediaFailed: !fallback,
    };
  }

  // Live location or venue: coordinates the bot can reason about.
  if (kind === 'location') {
    const lat = Number(msg.latitude);
    const lng = Number(msg.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const name = msg.locationName ? ` (${msg.locationName})` : '';
      return { text: `Shared location: ${lat},${lng}${name}`, mediaKind: 'location', mediaFailed: false };
    }
    return { text: '[customer shared a location]', mediaKind: 'location', mediaFailed: true };
  }

  // Voice / audio notes — the single most common non-text message on WhatsApp.
  if (kind === 'audio' || kind === 'voice' || kind === 'ptt') {
    try {
      const buf = msg.buffer || await fetchMedia(msg.mediaUrl, VOICE_MAX_BYTES, msg.mediaHeaders);
      if (!buf) throw badMedia('voice message');
      const text = await voiceToText(buf, { name: msg.mediaName || 'voice-note.ogg', mimetype: msg.mimetype });
      const caption = msg.caption ? `\n(Caption: ${msg.caption})` : '';
      return { text: `[Voice message] ${text}${caption}`.trim(), mediaKind: 'audio', mediaFailed: false };
    } catch (err) {
      console.warn('[channel-media] voice failed:', err.message);
      return { text: '', mediaKind: 'audio', mediaFailed: true };
    }
  }

  // Photos / screenshots (menus, receipts, damaged items).
  if (kind === 'image' || kind === 'photo') {
    try {
      const buf = msg.buffer || await fetchMedia(msg.mediaUrl, IMAGE_MAX_BYTES, msg.mediaHeaders);
      if (!buf) throw badMedia('photo');
      const text = await imageToText(buf, { name: msg.mediaName || 'photo.jpg' });
      const caption = msg.caption ? `\n(Caption: ${msg.caption})` : '';
      return { text: `[Photo] ${text}${caption}`.trim(), mediaKind: 'image', mediaFailed: false };
    } catch (err) {
      console.warn('[channel-media] image failed:', err.message);
      return { text: '', mediaKind: 'image', mediaFailed: true };
    }
  }

  // Documents / video / contacts / stickers / anything else: acknowledge,
  // never go silent. `mediaFailed: true` routes these to the short fallback.
  if (kind === 'document' || kind === 'video') {
    return { text: `[customer sent a ${kind}]`, mediaKind: kind, mediaFailed: true };
  }
  if (kind === 'sticker') {
    return { text: '[customer sent a sticker]', mediaKind: 'sticker', mediaFailed: true };
  }
  return { text: '[customer sent a message]', mediaKind: 'other', mediaFailed: true };
}

/** One-line fallback when media couldn't be read. */
function mediaFallbackText() {
  return "Sorry, I couldn't open that — could you type it as a message instead?";
}

module.exports = {
  normalizeInbound,
  voiceToText,
  imageToText,
  fetchMedia,
  mediaFallbackText,
  VOICE_MAX_BYTES,
  IMAGE_MAX_BYTES,
};
