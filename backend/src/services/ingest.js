const config = require('../config');

/**
 * Chunk text into overlapping windows (~word-based approximation of tokens).
 */
function chunkText(text, chunkSize = config.rag.chunkSize, overlap = config.rag.chunkOverlap) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const chunks = [];
  let start = 0;

  while (start < words.length) {
    const chunkWords = words.slice(start, start + chunkSize);
    if (chunkWords.length === 0) break;
    chunks.push(chunkWords.join(' '));
    start += chunkSize - overlap;
  }
  return chunks.filter((c) => c.length > 20);
}

/**
 * Extract readable text from raw HTML (for website crawling).
 */
function extractTextFromHtml(html) {
  // Lightweight extraction without heavy deps
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract human-readable copy from a JS bundle (SPA fallback).
 * Client-rendered sites keep their text inside string literals in the bundle.
 * Heuristics: length, letter ratio, no code punctuation at the start,
 * and must look like sentences (spaces + common words).
 */
function extractTextFromJsBundle(js) {
  const raw = js.match(/["'](?:[^"'\\]|\\.){40,800}["']/g) || [];
  const seen = new Set();
  const out = [];

  for (const s of raw) {
    const body = s.slice(1, -1);
    // Skip obvious code / config / paths
    if (/[{}();=<>]|=>|\bfunction\b|\bvar\b|\breturn\b|^https?:|^\/|\\n|\\u/.test(body)) continue;
    // Skip framework/dev noise
    if (/React has blocked|minified|dev environment|frame rate|npmjs\.com|error boundary/i.test(body)) continue;
    // Must be mostly letters/spaces and contain multiple words
    const letters = (body.match(/[A-Za-z]/g) || []).length;
    if (letters / body.length < 0.7) continue;
    const words = body.split(/\s+/);
    if (words.length < 6) continue;
    // Must read like prose: contains " the ", " and ", or similar glue
    if (!/\b(the|and|for|with|your|our|we|is|are|to|of|a)\b/i.test(body)) continue;

    const key = body.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(body.trim());
  }
  return out.join('\n\n');
}

/**
 * Fetch a URL and return extracted text.
 * Handles both server-rendered pages and client-side SPAs:
 *  - If the HTML has little text but references JS bundles, pull the main
 *    bundle(s) and extract readable copy from them.
 */
async function crawlUrl(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ChitraAI-Bot/1.0 (+https://chitra.ai)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const html = await res.text();

  let text = extractTextFromHtml(html);

  // SPA detection: tiny extracted text + module scripts present
  if (text.length < 200) {
    const bundlePaths = [...html.matchAll(/<script[^>]+src="(\/[^"]+\.js)"/g)]
      .map((m) => m[1])
      .filter((p) => !/widget|analytics|gtag|facebook|hotjar/i.test(p))
      .slice(0, 3); // cap to avoid heavy fetching

    const origin = new URL(url).origin;
    for (const path of bundlePaths) {
      try {
        const bRes = await fetch(origin + path, { signal: AbortSignal.timeout(15000) });
        if (!bRes.ok) continue;
        const js = await bRes.text();
        const bundleText = extractTextFromJsBundle(js);
        if (bundleText.length > text.length) text = bundleText;
        if (text.length >= 500) break; // good enough
      } catch { /* try next bundle */ }
    }

    // Last resort: meta description often carries a solid summary on SPAs
    if (text.length < 100) {
      const desc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
        || html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
      if (desc?.[1]) text = (text ? text + '\n\n' : '') + desc[1];
    }
  }

  return text;
}

module.exports = { chunkText, extractTextFromHtml, crawlUrl };
