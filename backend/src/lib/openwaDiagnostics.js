/**
 * Tiny in-memory diagnostics ring for the OpenWA integration.
 *
 * The group path has several deliberately silent gates (not mentioned, org
 * toggle off, own number unknown) and a send can still fail at the gateway — all
 * of which look identical from the phone: no reply. Instead of making the owner
 * read Render logs, routes/openwa.js records each decision here and
 * `GET /api/org/openwa/diagnostics` replays the last few.
 *
 * Deliberately a bounded array: diagnostics must never grow without limit.
 */

const MAX_ENTRIES = 25;
const entries = [];

/** Add one decision/send record. Free-form; `at` is stamped for callers. */
function record(entry) {
  entries.push({ at: new Date().toISOString(), ...(entry || {}) });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Newest first. */
function list(limit = 15) {
  return entries.slice(-limit).reverse();
}

function clear() {
  entries.length = 0;
}

module.exports = { MAX_ENTRIES, record, list, clear };
