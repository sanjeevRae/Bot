const express = require('express');
const waPending = require('../lib/waPending');

/**
 * Muse's event hook — GET /wa-pending (V13, durable since V14, group-aware since V15).
 *
 * Checked with `WHATSAPP_AUTO_REPLY=off`, the OpenWA webhook records every
 * inbound message as a pending row (`wa_pending_messages`, migration_v14)
 * *before* it acknowledges the delivery, and this endpoint reports them. Direct
 * messages are always recorded; group messages only when they @-mention this
 * bot's own identity (number, LID or display name), because unaddressed team
 * chatter is noise, not work (see the mention gate in routes/openwa.js).
 *
 * Muse can therefore poll cheaply and only wake up (read the real messages
 * through the OpenWA API and reply) when there is something to answer — and a
 * count can no longer be lost by a restart, which is what used to hide a
 * prospect's message.
 *
 * Public and unauthenticated *by design*. The counts, chat ids and mode are
 * safe to expose; the per-message `pending` details carry an author and message
 * body, so if `WA_PENDING_TOKEN` is set they are served only to callers that
 * present it (`?token=` or `x-wa-token`). Set one if this feed is reachable from
 * the open internet.
 *
 * Response:
 *   {
 *     "new_messages": 2,                                  // pending inbound count
 *     "pending_chats": ["97798XXXXXXXX@c.us"],            // chats with pending work
 *     "pending": [                                       // per-message reply hints
 *       { "chat_id": "120363428240535325@g.us", "session_id": "…",
 *         "is_group": true, "message_id": "false_…",
 *         "author": "248065197879524@lid", "author_name": "Sanjeev",
 *         "body": "Recommend some good business names …",
 *         "mentioned_ids": ["248065197879524@lid"], "matched_by": "body-number",
 *         "received_at": "2026-09-30T20:05:00.000Z" }
 *     ],
 *     "session_ready": true,                              // false = WhatsApp link down
 *     "mode": "muse"                                      // 'bot' = backend replies itself
 *   }
 *
 * The contract on Muse's side: while `new_messages > 0`, read that chat's
 * messages from OpenWA, reply per the reply playbook (in a group: answer in the
 * group and tag `author`), and mark the chat read — her own outbound message
 * clears the pending rows here automatically, because the gateway echoes it back
 * to the webhook. When `session_ready` is false, the WhatsApp link is down and
 * Muse emails Meena. Entries are only ever cleared by an observed reply (or by
 * ageing out after WA_PENDING_EXPIRE_DAYS): nothing in this system drops a message
 * silently.
 */

const crypto = require('crypto');

const router = express.Router();

/**
 * Authentication (2026-11-23 hardening — this feed was previously PUBLIC in
 * production: counts, chat ids, session ids, gateway readiness and, when
 * stored, message bodies were served to anyone; production had no token set).
 *
 * Now the ENTIRE response is protected:
 *   - `WA_PENDING_TOKEN` must be set on the server. When it is missing the
 *     feed is DISABLED (503) — fail closed, never fail open.
 *   - Callers must present the token in the `x-wa-token` header. Query-string
 *     tokens are NOT accepted (they leak into logs and proxies).
 *   - The comparison is timing-safe, and the token is never logged.
 *
 * Deployment note: setting WA_PENDING_TOKEN in the backend environment is
 * REQUIRED for Muse's WhatsApp wake-up hook to keep working, and the hook
 * must be updated to send the `x-wa-token` header. Until then this endpoint
 * returns 503/401 and no pending data is exposed.
 */
router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  const token = String(process.env.WA_PENDING_TOKEN || '').trim();
  if (!token) {
    return res.status(503).json({ error: 'Pending feed is not configured' });
  }
  const presented = String(req.headers['x-wa-token'] || '');
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const snap = await waPending.snapshot();
  res.json(snap);
});

module.exports = router;
