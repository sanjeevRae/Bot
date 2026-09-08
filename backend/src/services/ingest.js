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
 * Extract readable text from raw HTML using Cheerio (robust DOM parsing).
 * De-noises boilerplate (nav/footer/cookie banners) and prefers the main
 * content region when the page has one.
 */
const cheerio = require('cheerio');

function extractTextFromHtml(html) {
  const $ = cheerio.load(html);
  return extractTextFrom$($);
}

function extractTextFrom$($) {
  // De-noise: scripts, styles, boilerplate blocks, cookie banners
  $(
    'script, style, noscript, nav, footer, header, aside, form, iframe, svg, [role="navigation"], [role="banner"], [role="contentinfo"]'
  ).remove();
  $('[class*=cookie], [id*=cookie], [class*=consent], [class*=newsletter], [class*=social-share], [class*=breadcrumb]').remove();

  // Prefer the main content region if the page has one
  let $root = $('main, article, [role="main"], #content, .content').first();
  if ($root.length === 0) $root = $('body');
  if ($root.length === 0) $root = $.root();

  // Preserve line breaks at block boundaries
  $root.find('br').replaceWith('\n');
  $root
    .find('p, div, h1, h2, h3, h4, h5, h6, li, tr, section, article, td, th')
    .each(function () {
      const $el = $(this);
      $el.append('\n');
    });

  const text = $root
    .text()
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

/**
 * Extract structured data (JSON-LD) from a page and render it as readable
 * text lines. This is where e-commerce sites expose products, prices and
 * stock status (schema.org Product / Offer), plus FAQs, local business info
 * and reviews — data invisible to plain tag-stripping.
 */
function extractJsonLd(html) {
  const $ = cheerio.load(html);
  return extractJsonLdFrom$($);
}

function extractJsonLdFrom$($) {
  const blocks = $('script[type="application/ld+json"]')
    .map(function () { return $(this).html(); })
    .get();
  const out = [];
  const line = (s) => String(s).replace(/\s+/g, ' ').trim();

  const walk = (node, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth)); return; }
    if (typeof node !== 'object') return;
    if (node['@graph']) walk(node['@graph'], depth + 1);

    const type = String(node['@type'] || '');
    if (/Product|ProductGroup|Vehicle|RealEstateListing/i.test(type)) {
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
      const avail = String(offer.availability || '').replace(/^https?:\/\/schema\.org\//i, '');
      const parts = [];
      if (node.name) parts.push(line(node.name));
      if (node.brand) parts.push('Brand: ' + line(node.brand.name || node.brand));
      if (offer.price != null) parts.push('Price: ' + line(offer.price) + (offer.priceCurrency ? ' ' + offer.priceCurrency : ''));
      if (avail) parts.push('Availability: ' + line(avail));
      if (node.description) parts.push(line(node.description));
      if (node.aggregateRating) parts.push('Rating: ' + line(node.aggregateRating.ratingValue) + '/5 (' + line(node.aggregateRating.reviewCount || '') + ' reviews)');
      if (parts.length) out.push('[' + type + '] ' + parts.join(' | '));
      // Variants (size/color/price) — Shopify emits these under hasVariant
      (node.hasVariant || []).forEach((v) => {
        const vo = Array.isArray(v.offers) ? v.offers[0] : v.offers || {};
        const vp = [];
        if (v.name) vp.push(line(v.name));
        else if (v.color || v.size) vp.push(line([node.name, v.color, v.size].filter(Boolean).join(' — ')));
        if (vo.price != null) vp.push('Price: ' + line(vo.price) + (vo.priceCurrency ? ' ' + vo.priceCurrency : ''));
        if (vo.availability) vp.push('Availability: ' + line(String(vo.availability).replace(/^https?:\/\/schema\.org\//i, '')));
        if (vp.length) out.push('[Variant] ' + vp.join(' | '));
      });
    } else if (/FAQPage/i.test(type)) {
      (node.mainEntity || []).forEach((q) => {
        if (q && q.name && q.acceptedAnswer && q.acceptedAnswer.text) {
          out.push('[FAQ] Q: ' + line(q.name) + '\nA: ' + line(q.acceptedAnswer.text));
        }
      });
    } else if (/Event/i.test(type)) {
      const parts = [];
      if (node.name) parts.push(line(node.name));
      if (node.startDate) parts.push('Starts: ' + line(node.startDate));
      if (node.endDate) parts.push('Ends: ' + line(node.endDate));
      if (node.location) parts.push('Location: ' + line(node.location.name || node.location.address || node.location));
      if (node.offer || node.offers) {
        const o = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        if (o && o.price != null) parts.push('Price: ' + line(o.price) + (o.priceCurrency ? ' ' + o.priceCurrency : ''));
      }
      if (node.description) parts.push(line(node.description));
      if (parts.length) out.push('[Event] ' + parts.join(' | '));
    } else if (/JobPosting/i.test(type)) {
      const parts = [];
      if (node.title) parts.push(line(node.title));
      if (node.hiringOrganization) parts.push('Employer: ' + line(node.hiringOrganization.name || node.hiringOrganization));
      if (node.jobLocation) {
        const a = node.jobLocation.address || {};
        parts.push('Location: ' + line([a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ')));
      }
      const sal = node.baseSalary && node.baseSalary.value;
      if (sal) parts.push('Salary: ' + line([sal.minValue, sal.maxValue].filter(Boolean).join('-') + ' ' + (node.baseSalary.currency || '')));
      if (node.employmentType) parts.push('Type: ' + line(node.employmentType));
      if (node.description) parts.push(line(node.description).slice(0, 500));
      if (parts.length) out.push('[Job] ' + parts.join(' | '));
    } else if (/Course/i.test(type)) {
      const parts = [];
      if (node.name) parts.push(line(node.name));
      if (node.provider) parts.push('Provider: ' + line(node.provider.name || node.provider));
      if (node.description) parts.push(line(node.description));
      const o = node.offers && (Array.isArray(node.offers) ? node.offers[0] : node.offers);
      if (o && o.price != null) parts.push('Price: ' + line(o.price) + (o.priceCurrency ? ' ' + o.priceCurrency : ''));
      if (parts.length) out.push('[Course] ' + parts.join(' | '));
    } else if (/Apartment|House|Accommodation|SingleFamilyResidence/i.test(type)) {
      const parts = [];
      if (node.name) parts.push(line(node.name));
      if (node.numberOfRooms) parts.push('Rooms: ' + line(node.numberOfRooms));
      if (node.numberOfBedrooms) parts.push('Bedrooms: ' + line(node.numberOfBedrooms));
      if (node.floorSize && node.floorSize.value) parts.push('Size: ' + line(node.floorSize.value) + ' ' + line(node.floorSize.unitCode || ''));
      const o = node.offers && (Array.isArray(node.offers) ? node.offers[0] : node.offers);
      if (o && o.price != null) parts.push('Price: ' + line(o.price) + (o.priceCurrency ? ' ' + o.priceCurrency : ''));
      if (node.address) {
        const a = node.address;
        parts.push('Address: ' + line([a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(', ')));
      }
      if (parts.length) out.push('[Property] ' + parts.join(' | '));
    } else if (/Review/i.test(type)) {
      const parts = [];
      if (node.itemReviewed) parts.push(line(node.itemReviewed.name || ''));
      if (node.reviewRating) parts.push('Rating: ' + line(node.reviewRating.ratingValue) + '/5');
      if (node.author) parts.push('By: ' + line(node.author.name || node.author));
      if (node.reviewBody) parts.push(line(node.reviewBody).slice(0, 300));
      if (parts.length) out.push('[Review] ' + parts.join(' | '));
    } else if (/Article|BlogPosting|NewsArticle/i.test(type)) {
      const parts = [];
      if (node.headline) parts.push(line(node.headline));
      if (node.datePublished) parts.push('Published: ' + line(node.datePublished));
      if (node.author) parts.push('By: ' + line(node.author.name || node.author));
      if (node.description) parts.push(line(node.description));
      if (parts.length) out.push('[Article] ' + parts.join(' | '));
    } else if (/LocalBusiness|Organization|Store|Restaurant/i.test(type)) {
      const parts = [];
      if (node.name) parts.push(line(node.name));
      if (node.telephone) parts.push('Phone: ' + line(node.telephone));
      if (node.address) {
        const a = node.address;
        parts.push('Address: ' + line([a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', ')));
      }
      if (node.priceRange) parts.push('Price range: ' + line(node.priceRange));
      if (node.openingHours) parts.push('Hours: ' + line(Array.isArray(node.openingHours) ? node.openingHours.join('; ') : node.openingHours));
      if (parts.length) out.push('[' + type + '] ' + parts.join(' | '));
    }

    ['mainEntity', 'itemListElement', 'offers', 'hasOfferCatalog', 'containsPlace', 'hasVariant'].forEach((k) => {
      if (node[k]) walk(node[k], depth + 1);
    });
  };

  for (const m of blocks) {
    try { walk(JSON.parse(m.trim()), 0); } catch { /* malformed JSON-LD — skip */ }
  }
  return out;
}

/**
 * OpenGraph / Twitter / HTML-microdata fallback — catches sites that skip
 * JSON-LD but still tag products with og: or itemprop attributes.
 */
/**
 * OpenGraph / HTML-microdata fallback for sites that skip JSON-LD.
 */
function extractMicroData(html) {
  const out = [];
  const metaVal = (prop) => {
    const re = new RegExp("<meta[^>]+(?:property|name)=\"?[^>]{0,40}" + prop + "\"?[^>]*content=\"([^\"]{1,300})\"", "i");
    const m = html.match(re);
    return m ? m[1].trim() : null;
  };
  const attr = (prop) => {
    const re = new RegExp("itemprop=\"[^>]{0,40}" + prop + "[^>]*content=\"([^\"]{1,120})\"", "i");
    const m = html.match(re);
    return m ? m[1].trim() : null;
  };
  const stripNs = (s) => String(s).replace(/^https?:\/\/schema\.org\//i, "");
  const price = metaVal("product:price:amount") || metaVal("og:price:amount");
  const curr = metaVal("product:price:currency");
  const avail = metaVal("product:availability") || metaVal("og:availability");
  const title = metaVal("og:title");
  if (title) out.push("[Meta] Title: " + title);
  if (price) out.push("[Meta] Price: " + price + (curr ? " " + curr : ""));
  if (avail) out.push("[Meta] Availability: " + stripNs(avail));
  const mPrice = attr("price");
  const mAvail = attr("availability");
  const mName = attr("name");
  if (mName && !title) out.push("[Meta] Name: " + mName);
  if (mPrice && !price) out.push("[Meta] Price: " + mPrice);
  if (mAvail && !avail) out.push("[Meta] Availability: " + stripNs(mAvail));
  return out;
}

/** Normalize a URL for dedupe: strip hash, trailing slash, tracking params. */
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ref'].forEach((p) => url.searchParams.delete(p));
    let s = url.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch { return null; }
}

/** Collect same-origin, content-page links from a loaded Cheerio document. */
function extractLinksFrom$($, baseUrl) {
  const baseUrlStr = baseUrl || ($.root().attr('base') || '');
  const origin = new URL(baseUrlStr || 'http://placeholder.local').origin;
  const skipExt = /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|zip|mp4|mp3|ico|woff2?|ttf|xml|json)(\?|$)/i;
  const links = [];
  $('a[href]').each(function () {
    const href = $(this).attr('href');
    if (!href || href.startsWith('#')) return;
    const n = normalizeUrl(new URL(href, baseUrlStr).href);
    if (!n || !n.startsWith(origin) || skipExt.test(n)) return;
    if (/\/(cart|checkout|login|signup|register|account|wishlist|compare)(\/|$)/i.test(n)) return;
    links.push(n);
  });
  return links;
}

/**
 * Fetch one page: best-effort text (server HTML, SPA bundle fallback) plus
 * structured JSON-LD data and title/meta. Returns { text, links }.
 */
async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ChitraAI-Bot/1.0 (+https://chitra.ai)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  // Memory guardrail: skip giant pages (their DOM tree would spike memory).
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  if (len > 1.5 * 1024 * 1024) throw new Error(`Page too large (${len} bytes): ${url}`);
  const html = await res.text();
  if (html.length > 1.5 * 1024 * 1024) throw new Error(`Page too large (${html.length} bytes): ${url}`);

  // ONE Cheerio load per page — text, JSON-LD and links all share this DOM.
  // (Three separate loads tripled the memory peak; this keeps the crawl lean.)
  const $ = cheerio.load(html);

  const structured = extractJsonLdFrom$($).concat(extractMicroData(html));
  let text = extractTextFrom$($);

  // Per-page cap: one bloated page must not eat the whole crawl budget.
  const PAGE_CAP = 30000;
  if (text.length > PAGE_CAP) {
    const cut = text.lastIndexOf('\n', PAGE_CAP);
    text = text.slice(0, cut > 1000 ? cut : PAGE_CAP);
  }

  const title = (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1];
  const desc = (html.match(/<meta\s+(?:name="description"|property="og:description")\s+content="([^"]{1,400})"/i) || [])[1];
  const meta = [title ? 'Page title: ' + title.trim() : '', desc ? 'Summary: ' + desc.trim() : ''].filter(Boolean).join('\n');

  if (text.length < 200) {
    const bundlePaths = [...html.matchAll(/<script[^>]+src="(\/[^"]+\.js)"/g)]
      .map((m) => m[1])
      .filter((p) => !/widget|analytics|gtag|facebook|hotjar/i.test(p))
      .slice(0, 3);
    const origin = new URL(url).origin;
    for (const path of bundlePaths) {
      try {
        const bRes = await fetch(origin + path, { signal: AbortSignal.timeout(15000) });
        if (!bRes.ok) continue;
        const js = await bRes.text();
        const bundleText = extractTextFromJsBundle(js);
        if (bundleText.length > text.length) text = bundleText;
        if (text.length >= 500) break;
      } catch { /* try next bundle */ }
    }
  }

  const combined = [meta, text, structured.join('\n')].filter(Boolean).join('\n\n');

  // Pagination: rel="next" or common ?page= patterns — follow listing pages.
  let next = null;
  const nextMatch = html.match(/<link[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<a[^>]+(?:rel=["']next["']|class=["'][^"']*\bnext\b)[^>]+href=["']([^"']+)["']/i)
    || html.match(/<a[^>]+href=["']([^"']*\?page=\d+[^"']*)["'][^>]*>/i);
  if (nextMatch) {
    next = normalizeUrl(new URL(nextMatch[1], url).href);
    if (next && !next.startsWith(new URL(url).origin)) next = null;
  }

  return { text: combined, links: extractLinksFrom$($, url), next };
}

/** Legacy single-page helper (kept for compatibility). */
async function crawlUrl(url) {
  const { text } = await fetchPageText(url);
  return text;
}

/** Try sitemaps to seed the crawl queue with the site's full page catalog. */
async function collectSitemapUrls(origin) {
  const found = new Set();
  const childSitemaps = [];
  const zlib = require('zlib');

  // Sitemaps are sometimes gzipped (.xml.gz) — fetch + inflate transparently.
  const fetchSitemap = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(String(res.status));
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf).toString('utf8');
    return buf.toString('utf8');
  };

  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml']) {
    try {
      const xml = await fetchSitemap(origin + path);
      if (/<sitemapindex/i.test(xml)) {
        [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].slice(0, 8).forEach((m) => childSitemaps.push(m[1]));
      } else {
        [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].forEach((m) => found.add(m[1]));
      }
      if (found.size) break;
    } catch { /* try next candidate */ }
  }

  for (const child of childSitemaps.slice(0, 8)) {
    try {
      const xml = await fetchSitemap(child);
      [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].forEach((m) => found.add(m[1]));
    } catch { /* skip */ }
  }

  return [...found]
    .map((u) => normalizeUrl(u))
    .filter((u) => u && u.startsWith(origin) && !/\.(jpg|jpeg|png|gif|pdf|zip|mp4|xml|gz)(\?|$)/i.test(u));
}

/**
 * Crawl a website: start page + same-origin links (depth-aware BFS) + sitemap
 * URLs + rel="next" pagination. Lightweight (no headless browser) but deep
 * enough to reach product and category pages on e-commerce sites.
 * Slow at crawl time by design — once ingested, RAG answers stay instant.
 *
 * @returns {Promise<{text: string, pages: string[]}>}
 */
async function crawlSite(startUrl, opts = {}) {
  // Global single-flight lock: only one crawl runs at a time across the whole
  // server, guaranteeing memory stays bounded no matter how many users click
  // "crawl" simultaneously. Others queue here until it's their turn.
  while (_crawlRunning) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  _crawlRunning = true;
  try {
    return await _crawlSiteInner(startUrl, opts);
  } finally {
    _crawlRunning = false;
  }
}

let _crawlRunning = false;

async function _crawlSiteInner(startUrl, opts = {}) {
  const maxPages = Math.min(parseInt(opts.maxPages || process.env.CRAWL_MAX_PAGES || '75', 10) || 75, 200);
  const maxDepth = Math.max(0, parseInt(opts.maxDepth || process.env.CRAWL_MAX_DEPTH || '3', 10) || 3);
  const concurrency = Math.max(1, parseInt(process.env.CRAWL_CONCURRENCY || '3', 10) || 3);
  const maxTotalChars = parseInt(process.env.CRAWL_MAX_TOTAL_CHARS || '1000000', 10) || 1000000;
  const origin = new URL(startUrl).origin;

  // Queue items: { url, depth } — depth 0 = always allowed (sitemap + start),
  // link-discovered pages must respect maxDepth.
  // Sitemap URLs first (full catalog), product/collection URLs jump the queue.
  const queue = [];
  try {
    const sm = await collectSitemapUrls(origin);
    const start = normalizeUrl(startUrl);
    const idx = sm.indexOf(start);
    if (idx !== -1) sm.splice(idx, 1);
    const isProducty = (u) => /product|item|collection|shop|catalog|\-p\-|\/p\//i.test(u);
    const producty = sm.filter(isProducty);
    const rest = sm.filter((u) => !isProducty(u));
    queue.push(...[...producty, ...rest].map((url) => ({ url, depth: 0 })));
  } catch { /* sitemap is optional */ }
  queue.unshift({ url: normalizeUrl(startUrl), depth: 0 });

  const seen = new Set();
  const results = [];
  let totalChars = 0;
  let fetched = 0;

  const worker = async () => {
    for (;;) {
      if (fetched >= maxPages || totalChars >= maxTotalChars) return;
      const item = queue.shift();
      if (!item) return;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      fetched++;
      try {
        const { text, links, next } = await fetchPageText(item.url);
        if (!text || text.length < 40) continue;
        if (totalChars + text.length > maxTotalChars) return;
        totalChars += text.length;
        results.push('=== ' + item.url + ' ===\n' + text);
        // Pagination wins priority — listing pages lead deep into the catalog.
        if (next && !seen.has(next)) queue.unshift({ url: next, depth: item.depth });
        // Enqueue newly discovered same-origin pages (respect depth budget)
        if (item.depth < maxDepth) {
          for (const link of links) {
            if (!seen.has(link)) queue.push({ url: link, depth: item.depth + 1 });
          }
        }
      } catch { /* dead link / timeout — skip */ }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, maxPages) }, worker));

  return {
    text: results.join('\n\n'),
    pages: results.map((r) => r.split('\n')[0].replace('=== ', '').replace(' ===', '')),
  };
}

module.exports = { chunkText, extractTextFromHtml, extractJsonLd, extractMicroData, crawlUrl, crawlSite };
