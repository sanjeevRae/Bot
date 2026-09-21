const config = require('../config');

/**
 * Speech → text for voice notes.
 *
 * Merchants record themselves saying the day's specials, the delivery fee, the
 * cancellation policy. Groq already serves Whisper large-v3 on the free tier, so
 * a voice note becomes knowledge with the key we already hold.
 *
 * Limits are enforced here (not just in the route) because Groq's endpoint
 * rejects files over ~25 MB and a long recording also costs transcription time.
 */

const ENDPOINT = process.env.GROQ_TRANSCRIBE_ENDPOINT || 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';
const MAX_AUDIO_BYTES = parseInt(process.env.KB_MAX_AUDIO_BYTES || String(20 * 1024 * 1024), 10);
const TIMEOUT_MS = parseInt(process.env.TRANSCRIBE_TIMEOUT_MS || '90000', 10);

const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mpeg': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
};

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function mimeFor(name = '', fallback = 'audio/mpeg') {
  const ext = String(name).toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1];
  return MIME_BY_EXT[ext] || fallback;
}

/** Is speech-to-text available (a Groq key is configured)? */
function isTranscriptionEnabled() {
  return Boolean(config.groq.apiKey);
}

/**
 * Transcribe an audio buffer.
 * @param {Buffer} buffer
 * @param {string} name original filename (drives the mime type)
 * @param {string} [mimetype] browser-reported type (used as a fallback only)
 * @returns {Promise<{text:string, meta:object}>}
 */
async function transcribeAudio(buffer, name, mimetype) {
  if (!buffer || !buffer.length) throw badRequest('Empty audio upload.');
  if (!isTranscriptionEnabled()) {
    throw badRequest(
      'Voice-note transcription is not configured on this deployment. Paste the text instead, ' +
        'or ask the operator to set GROQ_API_KEY.'
    );
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw badRequest(`Recording too long (max ${Math.round(MAX_AUDIO_BYTES / (1024 * 1024))}MB).`);
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeFor(name, mimetype) }), name || 'recording.mp3');
  form.append('model', MODEL);
  form.append('response_format', 'json');
  // 'text' keeps Whisper from translating — we want the merchant's own words,
  // including Nepali, so retrieval can still match the query language.
  form.append('temperature', '0');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groq.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw badRequest(`Could not transcribe that recording (HTTP ${res.status}). ${body.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  const text = String(data.text || '').trim();

  if (text.length < 5) {
    throw badRequest('The recording was too quiet or too short to transcribe. Try again, or paste the text.');
  }

  return { text, meta: { stt: 'groq', model: MODEL } };
}

module.exports = { transcribeAudio, isTranscriptionEnabled, mimeFor };
