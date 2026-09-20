const supabaseAdmin = require('../lib/supabase');

/**
 * Per-org context cache (org row + settings).
 *
 * Every chat message needs the org and its settings. Fetching them costs two
 * Supabase round-trips (~340 ms each against a remote project) and they change
 * rarely, so they are cached in-process for ORG_TTL_MS. This is the same
 * trade-off the dashboard already makes with its 60 s /api/org/me cache —
 * settings edits show up within a minute, and `invalidate()` makes mutation
 * routes instant.
 *
 * Only the columns the chat pipeline needs are selected, so nothing that isn't
 * public (e.g. other tenants' data, secrets) is ever held or exposed.
 */

const TTL_MS = parseInt(process.env.ORG_CACHE_TTL_MS || '60000', 10);
const MAX_ENTRIES = 500;
const cache = new Map(); // orgId -> { at, org, settings }

const ORG_COLUMNS = 'id, name, industry, plan, plan_expires_at, monthly_message_quota';

async function load(orgId) {
  const [{ data: org, error }, { data: settings }] = await Promise.all([
    supabaseAdmin.from('organizations').select(ORG_COLUMNS).eq('id', orgId).single(),
    supabaseAdmin.from('settings').select('*').eq('organization_id', orgId).maybeSingle(),
  ]);
  if (error || !org) return null;

  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(orgId, { at: Date.now(), org, settings: settings || null });
  return { org, settings: settings || null };
}

/** Cached org + settings for a chat turn. Returns null when the org doesn't exist. */
async function getOrgContext(orgId) {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return { org: hit.org, settings: hit.settings };
  return load(orgId);
}

/** Drop the cache for one org (call after any org/settings mutation). */
function invalidateOrgContext(orgId) {
  cache.delete(orgId);
}

module.exports = { getOrgContext, invalidateOrgContext, ORG_COLUMNS };