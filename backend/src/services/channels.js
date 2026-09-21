const config = require('../config');

/**
 * Messaging platform integrations — legacy transport layer (Meta Cloud API).
 *
 * V11 note: `plainText`/`splitReply`/send-dispatch live in services/channelSend.js
 * now; this module keeps the raw Graph API calls and gains the payloads V11
 * needs (templates, interactive buttons, quick replies, images, documents,
 * locations). New code should call `channelSend.sendChannelText` /
 * `sendInteractive` / `sendMedia`, not these helpers directly.
 */

// ---------- Outbound sending ----------

/**
 * Strip markdown that messaging apps render as raw symbols
 * (tables, **bold**, # headings, code fences, links).
 * Thin wrapper kept for the Meta webhook path's direct callers.
 */
function plainText(text) {
  return require('./channelSend').plainText(text);
}

async function graphPost(path, token, body) {
  const res = await fetch(
    `https://graph.facebook.com/${config.meta.apiVersion}${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Meta send failed (${res.status}): ${errBody}`);
  }
  return res.json();
}

async function sendWhatsApp(phoneNumberId, to, text) {
  const token = config.whatsapp.token;
  if (!token || !phoneNumberId) throw new Error('WhatsApp not configured');
  return graphPost(`/${phoneNumberId}/messages`, token, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: plainText(text).slice(0, 4096) },
  });
}

/**
 * WhatsApp template message (approved templates only) — the ONLY
 * business-initiated message Meta allows outside the 24 h customer-service
 * window. `template` = { name, lang, vars[] }; `fallbackText` is logged, not
 * sent (Meta rejects mixing template + free text in one send).
 */
async function sendWhatsAppTemplate(phoneNumberId, to, template, fallbackText) {
  const token = config.whatsapp.token;
  if (!token || !phoneNumberId) throw new Error('WhatsApp not configured');
  if (!template?.name) throw new Error('No WhatsApp template configured');
  const parameters = (template.vars || []).slice(0, 10).map((text) => ({ type: 'text', text: String(text) }));
  return graphPost(`/${phoneNumberId}/messages`, token, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.lang || 'en_US' },
      ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
    },
  }).catch((err) => {
    // Re-raise with the fallback attached so the owner's reply path can log
    // what the visitor would have seen had proactive text been allowed.
    err.templateFallback = fallbackText;
    throw err;
  });
}

/** WhatsApp native interactive buttons (max 3, titles ≤ 20 chars). */
async function sendWhatsAppInteractive(phoneNumberId, to, bodyText, options) {
  const token = config.whatsapp.token;
  if (!token || !phoneNumberId) throw new Error('WhatsApp not configured');
  const buttons = options.slice(0, 3).map((o) => ({
    type: 'reply',
    reply: { id: o.id, title: o.title },
  }));
  return graphPost(`/${phoneNumberId}/messages`, token, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: plainText(bodyText).slice(0, 1024) },
      action: { buttons },
    },
  });
}

/** WhatsApp image by URL (menu cards, receipts). */
async function sendWhatsAppImage(phoneNumberId, to, imageUrl, caption) {
  const token = config.whatsapp.token;
  if (!token || !phoneNumberId) throw new Error('WhatsApp not configured');
  return graphPost(`/${phoneNumberId}/messages`, token, {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link: imageUrl, ...(caption ? { caption: plainText(caption).slice(0, 1024) } : {}) },
  });
}

/** WhatsApp document by URL (price-list PDFs). */
async function sendWhatsAppDocument(phoneNumberId, to, documentUrl, caption) {
  const token = config.whatsapp.token;
  if (!token || !phoneNumberId) throw new Error('WhatsApp not configured');
  const filename = String(documentUrl).split('/').pop().split('?')[0].slice(0, 120) || 'document';
  return graphPost(`/${phoneNumberId}/messages`, token, {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: {
      link: documentUrl,
      filename,
      ...(caption ? { caption: plainText(caption).slice(0, 1024) } : {}),
    },
  });
}

/** WhatsApp location pin (shop address, delivery point). */
async function sendWhatsAppLocation(phoneNumberId, to, latitude, longitude, name, address) {
  const token = config.whatsapp.token;
  if (!token || !phoneNumberId) throw new Error('WhatsApp not configured');
  return graphPost(`/${phoneNumberId}/messages`, token, {
    messaging_product: 'whatsapp',
    to,
    type: 'location',
    location: {
      latitude: String(latitude),
      longitude: String(longitude),
      ...(name ? { name: String(name).slice(0, 200) } : {}),
      ...(address ? { address: String(address).slice(0, 500) } : {}),
    },
  });
}

async function sendMessenger(pageId, recipientId, text) {
  const token = config.messenger.pageToken;
  if (!token || !pageId) throw new Error('Messenger not configured');
  return graphPost(`/${pageId}/messages`, token, {
    recipient: { id: recipientId },
    message: { text: plainText(text).slice(0, 2000) },
  });
}

/**
 * Messenger/Instagram quick replies (max 11 shown by Meta; we cap at 5 so
 * they stay tappable on a phone). Payloads echo `id` so the tap maps back
 * to the same option the bot offered.
 */
async function sendMessengerQuickReplies(pageId, recipientId, text, options) {
  const token = config.messenger.pageToken;
  if (!token || !pageId) throw new Error('Messenger not configured');
  const quickReplies = options.slice(0, 5).map((o) => ({
    content_type: 'text',
    title: String(o.title).slice(0, 20),
    payload: String(o.id).slice(0, 1000),
  }));
  return graphPost(`/${pageId}/messages`, token, {
    recipient: { id: recipientId },
    message: { text: plainText(text).slice(0, 2000), quick_replies: quickReplies },
  });
}

// sendInstagram uses the same endpoint as Messenger when the IG account is
// linked to a FB page — kept as an alias for clarity.
const sendInstagram = sendMessenger;

module.exports = {
  plainText,
  sendWhatsApp,
  sendWhatsAppTemplate,
  sendWhatsAppInteractive,
  sendWhatsAppImage,
  sendWhatsAppDocument,
  sendWhatsAppLocation,
  sendMessenger,
  sendMessengerQuickReplies,
  sendInstagram,
};

