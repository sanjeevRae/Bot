const config = require('../config');

/**
 * Embedding service.
 * Primary: HuggingFace Inference API (free tier, no card needed)
 * Fallback: deterministic local hash-embedding so the app never hard-fails.
 *
 * Latency notes (measured): an HF round-trip costs ~380 ms and is on the
 * critical path of every chat message when vector search is used. Two things
 * keep it off the user's clock:
 *   - queries are cached (chat visitors repeat the same handful of questions),
 *   - the timeout is short, so a cold/slow HF instance fails over to the
 *     in-process embedder in ~2.5 s instead of stalling for 30 s.
 */

/** Cache of query → vector. Repeat questions then cost 0 ms. */
const queryCache = new Map();
const CACHE_MAX = 500;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

/** HF request deadline — fail over to the local embedder fast. */
const HF_TIMEOUT_MS = parseInt(process.env.EMBED_TIMEOUT_MS || '2500', 10);

async function embedBatch(texts) {
  const token = config.embeddings.hfToken;
  if (token) {
    try {
      // New HF Inference router endpoint (api-inference.huggingface.co is deprecated)
      const res = await fetch(
        `https://router.huggingface.co/hf-inference/models/${config.embeddings.hfModel}/pipeline/feature-extraction`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inputs: texts, options: { wait_for_model: true } }),
          signal: AbortSignal.timeout(HF_TIMEOUT_MS),
        }
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && Array.isArray(data[0])) return data;
      } else {
        console.warn(`HF embedding failed (${res.status}), using local fallback`);
      }
    } catch (e) {
      console.warn('HF embedding error, using local fallback:', e.message);
    }
  }
  return texts.map(localEmbed);
}

/**
 * Deterministic bag-of-words hashing embedding (384 dims).
 * Not semantic-quality, but keeps RAG functional with zero external deps/cost.
 */
function localEmbed(text) {
  const dim = config.embeddings.dimensions;
  const vec = new Array(dim).fill(0);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  for (const w of words) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) {
      h ^= w.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[Math.abs(h) % dim] += 1;
  }
  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/** Cache key for a query — whitespace/case differences must not miss the cache. */
const cacheKey = (text) => String(text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400);

function cacheGet(key) {
  const hit = queryCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    queryCache.delete(key);
    return null;
  }
  return hit.vec;
}

function cacheSet(key, vec) {
  // Simple FIFO eviction — the oldest key goes when the map is full.
  if (queryCache.size >= CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
  queryCache.set(key, { vec, at: Date.now() });
}

/**
 * Embed a single query string. Cached, so repeated questions are instant.
 */
async function embedText(text) {
  const key = cacheKey(text);
  const cached = cacheGet(key);
  if (cached) return cached;

  const [vec] = await embedBatch([text]);
  cacheSet(key, vec);
  return vec;
}

module.exports = { embedText, embedBatch, localEmbed };
