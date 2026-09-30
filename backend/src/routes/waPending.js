const express = require('express');
const waPending = require('../lib/waPending');

/**
 * Muse's event hook — GET /wa-pending (V13).
 *
 * Checked with `WHATSAPP_AUTO_REPLY=off`, the OpenWA webhook counts incoming
 * messages per chat and this endpoint reports them, so Muse can poll cheaply and
 * only wake up (read the real messages through the OpenWA API and reply) when
 * there is something to answer. No tokens are spent while the inbox is quiet.
 *
 * Public and unauthenticated *by design*, which is why it exposes nothing but
 * counts and chat ids — never message content (see lib/waPending.js) and never
 * the API key. Kept deliberately DB-free and gateway-free on the hot path, so a
 * poll costs one in-memory read.
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
 * her own outbound message clears the pending entry here automatically, because
 * the gateway echoes it back to the webhook. When `session_ready` is false, the
 * WhatsApp link is down and Muse emails Meena.
 */

const router = express.Router();

router.get('/', async (req, res) => {
  const snap = await waPending.snapshot();
  // Never cache: a stale copy would hide the very wake-up signal this exists for.
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json(snap);
});

module.exports = router;
