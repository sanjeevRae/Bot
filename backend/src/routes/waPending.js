const express = require('express');
const waPending = require('../lib/waPending');

/**
 * Muse's event hook — GET /wa-pending (V13, durable since V14).
 *
 * Checked with `WHATSAPP_AUTO_REPLY=off`, the OpenWA webhook records every
 * incoming message as a pending row (`wa_pending_messages`, migration_v14)
 * *before* it acknowledges the delivery, and this endpoint reports them. Muse can
 * therefore poll cheaply and only wake up (read the real messages through the
 * OpenWA API and reply) when there is something to answer — and a count can no
 * longer be lost by a restart, which is what used to hide a prospect's message.
 *
 * Public and unauthenticated *by design*, which is why it exposes nothing but
 * counts and chat ids — never message content (see lib/waPending.js) and never
 * the API key.
 *
 * Response:
 *   {
 *     "new_messages": 2,                                  // pending inbound count
 *     "pending_chats": ["97798XXXXXXXX@c.us"],            // chats with pending work
 *     "session_ready": true,                              // false = WhatsApp link down
 *     "mode": "muse"                                      // 'bot' = backend replies itself
 *   }
 *
 * The contract on Muse's side: while `new_messages > 0`, read that chat's
 * messages from OpenWA, reply per the reply playbook, and mark the chat read —
 * her own outbound message clears the pending rows here automatically, because
 * the gateway echoes it back to the webhook. When `session_ready` is false, the
 * WhatsApp link is down and Muse emails Meena. Entries are only ever cleared by
 * an observed reply (or by ageing out after WA_PENDING_EXPIRE_DAYS): nothing in
 * this system drops a message silently.
 */

const router = express.Router();

router.get('/', async (req, res) => {
  const snap = await waPending.snapshot();
  // Never cache: a stale copy would hide the very wake-up signal this exists for.
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json(snap);
});

module.exports = router;
