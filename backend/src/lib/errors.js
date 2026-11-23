'use strict';

/**
 * Safe client-facing errors (2026-11-23 hardening).
 *
 * Routes used to return raw `error.message` from Supabase/Postgres to API
 * clients — leaking schema details (column names, constraint names, SQL
 * fragments) that help an attacker map the database. `publicError` applies
 * one rule:
 *
 *   - Errors OUR code created with an HTTP 4xx status (validation, quota,
 *     not-found, conflict — always constructed with user-safe copy) are
 *     shown as-is.
 *   - Everything else (database errors, upstream failures, unexpected
 *     exceptions) becomes a generic message. The real error is still logged
 *     server-side at the throw/catch site as before.
 *
 * Supabase Auth errors carry a numeric `status` too; their messages are
 * user-facing by design ("Invalid login credentials") and safe to pass.
 */
function publicError(err, fallback = 'Something went wrong. Please try again.') {
  if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500 && err.message) {
    return err.message;
  }
  return fallback;
}

module.exports = { publicError };
