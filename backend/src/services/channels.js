const config = require('../config');

/**
 * Messaging platform integrations (V2).
 *
 * WhatsApp  → Meta WhatsApp Cloud API (graph.facebook.com/v20.0)
 * Messenger → Meta Messenger Send API (same Graph host)
 * Instagram → Meta Instagram Messaging (same Graph host)
 *
 * All three are "verify token + webhook" style. Tokens are per-deployment
 * env vars; routing to the right tenant org happens via phone_number_id
 * (WhatsApp) or page/IG account id mapped in `channel_connections`.
 */

// ---------- Outbound sending ----------

async function sendWhatsApp(phoneNumberId, to, text) {
  const token = config.whatsapp.token;
  if (!token || !phoneNumberId) throw new Error('WhatsApp not configured');
  const res = await fetch(
    `https://graph.facebook.com/${config.meta.apiVersion}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text.slice(0, 4096) },
      }),
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp send failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function sendMessenger(pageId, recipientId, text) {
  const token = config.messenger.pageToken;
  if (!token || !pageId) throw new Error('Messenger not configured');
  const res = await fetch(
    `https://graph.facebook.com/${config.meta.apiVersion}/${pageId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: text.slice(0, 2000) },
      }),
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Messenger send failed (${res.status}): ${body}`);
  }
  return res.json();
}

// sendInstagram uses the same endpoint as Messenger when the IG account is
// linked to a FB page — kept as an alias for clarity.
const sendInstagram = sendMessenger;

module.exports = { sendWhatsApp, sendMessenger, sendInstagram };
