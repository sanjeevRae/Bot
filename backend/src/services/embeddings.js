const config = require('../config');

/**
 * Embedding service.
 * Primary: HuggingFace Inference API (free tier, no card needed)
 * Fallback: deterministic local hash-embedding so the app never hard-fails.
 */

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
          signal: AbortSignal.timeout(30000),
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

async function embedText(text) {
  const [vec] = await embedBatch([text]);
  return vec;
}

module.exports = { embedText, embedBatch };
