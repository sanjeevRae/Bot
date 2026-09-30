/**
 * Which reply mode is active for an OpenWA session (V13).
 *
 * Two layers, so both a one-click switch and a one-flag rollback exist:
 *
 *   1. `WHATSAPP_AUTO_REPLY=on` (config.openwa.autoReply) — the ops override. It
 *      forces the backend to answer WhatsApp itself for every org, no matter what
 *      the dashboard says, so an emergency rollback is still one env flip.
 *   2. `whatsapp_connections.auto_reply_enabled` — the per-org switch behind the
 *      "Answer WhatsApp from Chitra" toggle on the Channels page
 *      (migration_v13). Off, which is the default an org that never touched it
 *      keeps, means Muse mode: the backend counts messages and never replies.
 *
 * The row is cached for a few seconds per session so a burst of messages does not
 * query per message; the settings endpoint invalidates the entry so a toggle
 * takes effect on the very next message.
 *
 * The failure direction is deliberate: when the row cannot be read (DB blip, or
 * the migration has not been run) the answer is Muse mode. Staying quiet is
 * recoverable — racing a reply with Muse's is what this whole switch exists to
 * stop.
 *
 * The same read also returns the row's `status`, because "Disconnect" on the
 * Channels page is a soft switch: it keeps the session mapped (and the audit row)
 * but must actually stop this backend from answering. A session whose owner
 * disconnected it is therefore *not* bot mode, whatever the toggle says.
 */

const config = require('../config');

/** How long a resolved mode is reused (WA_MODE_TTL_MS, 0 = always re-read). */
const MODE_TTL_MS = Math.max(0, parseInt(process.env.WA_MODE_TTL_MS || '30000', 10) || 0);
const CACHE_MAX = 500;

/** Stored statuses that mean "the owner switched this session off". */
const OFF_STATUSES = ['disconnected', 'error'];

/** sessionId → { bot, source, softOff, status, at } */
const cache = new Map();
let warnedMissingColumn = false;

/** Drop the cached decision for one session (a toggle) or all of them. */
function invalidate(sessionId) {
  if (sessionId) cache.delete(sessionId);
  else cache.clear();
}

/**
 * The org's own switch for a session:
 * 'org' when the row is readable, 'default' when nothing is mapped for it.
 * Throws when the read fails, so the caller can decide what silence means.
 */
async function readOrgSwitch(sessionId) {
  const supabaseAdmin = require('./supabase');
  const { data, error } = await supabaseAdmin
    .from('whatsapp_connections')
    .select('auto_reply_enabled, status')
    .eq('openwa_session_id', sessionId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message || 'whatsapp_connections read failed');
  if (!data) return { bot: false, source: 'default', softOff: false, status: null };
  const status = data.status || null;
  return {
    bot: data.auto_reply_enabled === true,
    source: 'org',
    softOff: OFF_STATUSES.includes(String(status)),
    status,
  };
}

/**
 * @returns {Promise<{bot: boolean, source: 'env'|'org'|'default', softOff: boolean, status: string|null}>}
 *   `bot` is what the org's toggle says, `softOff` whether the owner disconnected
 *   the session. What actually happens is `bot && !softOff`.
 */
async function modeFor(sessionId) {
  if (config.openwa.autoReply) return { bot: true, source: 'env', softOff: false, status: null };
  if (!sessionId) return { bot: false, source: 'default', softOff: false, status: null };

  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < MODE_TTL_MS) return hit;

  let result;
  try {
    result = await readOrgSwitch(sessionId);
  } catch (err) {
    if (!warnedMissingColumn && /auto_reply_enabled/.test(err.message || '')) {
      warnedMissingColumn = true;
      console.warn(
        '[waMode] whatsapp_connections.auto_reply_enabled is missing — run migration_v13_openwa_auto_reply.sql (staying in Muse mode until then)'
      );
    } else {
      console.warn('[waMode] could not read the auto-reply switch:', err.message);
    }
    result = { bot: false, source: 'default', softOff: false, status: null };
  }

  if (MODE_TTL_MS > 0) {
    cache.set(sessionId, { ...result, at: Date.now() });
    if (cache.size > CACHE_MAX) {
      const now = Date.now();
      for (const [key, entry] of cache) if (now - entry.at >= MODE_TTL_MS) cache.delete(key);
      if (cache.size > CACHE_MAX) cache.clear(); // pathological churn: start over
    }
    return cache.get(sessionId);
  }
  return result;
}

/**
 * Everything a UI or the pending feed wants to know about the current mode,
 * including whether the org's own switch is currently being overridden.
 */
async function statusFor(sessionId) {
  const { bot, source, softOff, status } = await modeFor(sessionId);
  return {
    // What the Channels toggle shows (the stored intent, env override included).
    autoReply: bot,
    // What is actually happening: a disconnected session answers nothing.
    mode: bot && !softOff ? 'bot' : 'muse',
    autoReplySource: source,
    autoReplyForcedByEnv: !!config.openwa.autoReply,
    // Saved as on, but suspended because the owner disconnected the session.
    autoReplySuspended: bot && softOff,
    sessionStatus: status,
  };
}

/** Test hook. */
function reset() {
  cache.clear();
  warnedMissingColumn = false;
}

module.exports = { modeFor, statusFor, invalidate, reset, MODE_TTL_MS };
