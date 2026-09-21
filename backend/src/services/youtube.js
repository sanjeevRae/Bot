/**
 * YouTube → text (video transcript) for the knowledge base.
 *
 * Small businesses put their real answers in videos: the "how to order" clip,
 * the product demo, the price walkthrough. A transcript turns that into
 * retrievable knowledge without any API key.
 *
 * Two strategies, tried in order:
 *   1. InnerTube player API (POST) using the public web key + visitor data read
 *      from the watch page — works for most public videos that have captions.
 *   2. The plain `timedtext` endpoint with the older query params — still served
 *      for a lot of videos, and cheap to try.
 *
 * Caption payloads arrive as either XML `<text>` format or JSON3
 * (`events[].segs[].utf8`); both are handled.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const TIMEOUT_MS = parseInt(process.env.YOUTUBE_TIMEOUT_MS || '20000', 10);

/** Cap the learned transcript so a two-hour podcast does not become 40 chunks. */
const MAX_CHARS = parseInt(process.env.YOUTUBE_MAX_CHARS || '20000', 10);

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function parseVideoId(url) {
  const s = String(url || '').trim();
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/,
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return null;
}

function decodeEntities(s) {
  // Captions arrive double-encoded at times ("&amp;amp;"), so decode until the
  // text stops changing (bounded, in case of pathological input).
  let out = String(s || '');
  for (let pass = 0; pass < 3; pass++) {
    const next = out
      .replace(/&amp;#39;/g, "'")
      .replace(/&amp;quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, code) => {
        try { return String.fromCodePoint(Number(code)); } catch { return ''; }
      })
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** XML caption payload: <text start="1.2" dur="3">hello</text> */
function parseXmlCaptions(xml) {
  const parts = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) {
    const line = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
    if (line) parts.push(line);
  }
  return parts;
}

/** JSON3 caption payload: {events:[{segs:[{utf8:"hi"}]}]} */
function parseJsonCaptions(json) {
  let data;
  try { data = JSON.parse(json); } catch { return []; }
  const parts = [];
  for (const event of data.events || []) {
    const line = (event.segs || [])
      .map((seg) => seg.utf8 || '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    // Skip blank/rolling-caption duplicates YouTube emits per timing segment
    if (!line) continue;
    if (parts[parts.length - 1] === line) continue;
    parts.push(line);
  }
  return parts;
}

/**
 * Captions are one fragment per phrase. Rebuild readable sentences: consecutive
 * fragments that do not end in punctuation belong to the same sentence.
 */
function captionsToText(payload) {
  const trimmed = String(payload || '').trim();
  const lines = trimmed.startsWith('{') ? parseJsonCaptions(trimmed) : parseXmlCaptions(trimmed);

  const sentences = [];
  let current = '';
  for (const line of lines) {
    current = current ? `${current} ${line}` : line;
    if (/[.!?।]$/.test(line) || current.length > 240) {
      sentences.push(current);
      current = '';
    }
  }
  if (current) sentences.push(current);

  return sentences.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchCaptionPayload(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const body = await res.text();
  if (!body || body.length < 20) return null;
  if (/^\s*</.test(body) && !/<text/.test(body)) return null; // error page, not captions
  return body;
}

/** Strategy 1: InnerTube player API (POST with the public web key). */
async function tryInnerTube(videoId, pageHtml) {
  const apiKey = pageHtml.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  if (!apiKey) return null;

  const visitorData = pageHtml.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || '';
  const clientVersion = pageHtml.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20240101.00.00';

  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      context: {
        client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US', visitorData },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return null;

  // Prefer a manual English track, then any English, then auto-generated.
  const withUrl = tracks.filter((t) => t.baseUrl);
  if (!withUrl.length) return null;
  const track =
    withUrl.find((t) => t.kind !== 'asr' && /^en/i.test(t.languageCode || '')) ||
    withUrl.find((t) => /^en/i.test(t.languageCode || '')) ||
    withUrl.find((t) => t.kind === 'asr') ||
    withUrl[0];

  const url = `${track.baseUrl}${track.baseUrl.includes('fmt=') ? '' : '&fmt=json3'}`;
  const payload = await fetchCaptionPayload(url);
  if (!payload) return null;

  return { payload, language: track.languageCode || 'unknown', auto: track.kind === 'asr' };
}

/** Strategy 2: `timedtext` using the baseUrl carried in the watch page. */
async function tryTimedText(videoId, pageHtml) {
  const direct = pageHtml.match(/"baseUrl":"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/)?.[1];
  if (direct) {
    const payload = await fetchCaptionPayload(direct.replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
    if (payload) return { payload, language: 'unknown', auto: false };
  }

  const payload = await fetchCaptionPayload(`https://www.youtube.com/api/timedtext?lang=en&v=${videoId}`);
  if (payload) return { payload, language: 'en', auto: false };
  return null;
}

/**
 * Fetch the transcript of a YouTube video.
 * @param {string} urlOrId watch URL, shorts URL, or a bare 11-character id
 * @returns {Promise<{text:string, videoId:string, title:string, language:string, auto:boolean, url:string}>}
 */
async function fetchYouTubeTranscript(urlOrId) {
  const videoId = parseVideoId(urlOrId);
  if (!videoId) throw badRequest('That does not look like a YouTube video link.');

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const pageRes = await fetch(watchUrl, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!pageRes.ok) {
    throw badRequest(`Could not load that YouTube video (HTTP ${pageRes.status}).`);
  }
  const pageHtml = await pageRes.text();

  const title =
    decodeEntities(pageHtml.match(/<meta\s+name="title"\s+content="([^"]*)"/)?.[1] || '') ||
    `YouTube video ${videoId}`;

  let found = null;
  try {
    found = await tryInnerTube(videoId, pageHtml);
  } catch (err) {
    console.warn('YouTube InnerTube failed:', err.message);
  }
  if (!found) {
    try {
      found = await tryTimedText(videoId, pageHtml);
    } catch (err) {
      console.warn('YouTube timedtext failed:', err.message);
    }
  }

  if (!found) {
    throw badRequest(
      'No captions found on that video. Only videos with captions (or auto-captions) can be ' +
        'learned — try another video, or paste the key points as text.'
    );
  }

  let text = captionsToText(found.payload);
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
  if (text.length < 40) throw badRequest("That video's captions were too short to learn from.");

  return {
    text,
    videoId,
    title,
    language: found.language,
    auto: Boolean(found.auto),
    url: watchUrl,
  };
}

module.exports = { fetchYouTubeTranscript, parseVideoId, captionsToText };
