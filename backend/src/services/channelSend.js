const config = require('../config');

/**
 * Outbound message dispatch (V11).
 *
 * The old layer (`sendWhatsApp` / `sendMessenger`) could only send plain
 * text, cut anything long with `.slice`, and had no answer for WhatsApp's
 * 24-hour customer-service window. This module sits in front of it:
 *
 *   - `splitReply` cuts long answers into numbered parts (1/3) at sentence
 *     boundaries instead of truncating mid-item
 *   - `sendChannelText` routes one reply to the right transport per channel
 *     and detects the "outside 24h window" error (Meta 131047) to retry
 *     with the org's configured template message
 *   - `sendInteractive` renders booking/FAQ follow-ups as native buttons
 *     (WhatsApp Cloud interactive payload, Telegram inline keyboard,
 *     Messenger quick replies); unknown shapes fall back to plain text
 *   - `sendMedia` pushes a photo/PDF/location from knowledge (menu card,
 *     price list) down transports that support it
 *
 * Everything fails loudly with Error carrying the channel name, so the
 * channel pipelines can log per-transport instead of a bare console.error.
 */

const MAX_SPLIT_PARTS = parseInt(process.env.CHANNEL_MAX_SPLIT_PARTS || '4', 10);

function plainText(text) {
  return String(text || '')
    .replace(/\|\|/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^\s*[-*]{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split a long reply into numbered parts at sentence boundaries.
 * WhatsApp allows ~4096 chars/message, Messenger/Telegram ~2000-4096, but a
 * single wall of text is unreadable — split at ~900 chars so lists survive
 * and every part reads whole. Cap at MAX_SPLIT_PARTS; the tail becomes
 * "…(continued in chat)" rather than vanishing silently.
 */
function splitReply(text, maxChars = 900) {
  const clean = plainText(text);
  if (!clean) return [''];
  if (clean.length <= maxChars) return [clean];

  // Sentence-ish units: keep numbered list items ("1. …") together with the
  // line that follows them when the next line continues the item.
  const rawLines = clean.split('\n');
  const units = [];
  for (const line of rawLines) {
    const t = line.trim();
    if (t) units.push(t);
  }
  if (!units.length) return [clean.slice(0, maxChars)];

  const parts = [];
  let current = '';
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = '';
  };
  for (const u of units) {
    // A unit longer than the budget is cut at a word boundary.
    let rest = u;
    while (rest.length > maxChars) {
      if (current.trim()) push();
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut < maxChars * 0.4) cut = maxChars;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if ((current ? current.length + 1 : 0) + rest.length > maxChars) push();
    current = current ? `${current}\n${rest}` : rest;
  }
  push();

  const kept = parts.slice(0, MAX_SPLIT_PARTS);
  if (parts.length > MAX_SPLIT_PARTS) {
    kept[kept.length - 1] += '\n…(continued in chat)';
  }
  if (kept.length > 1) {
    return kept.map((p, i) => `(Part ${i + 1}/${kept.length})\n${p}`);
  }
  return kept;
}

/** WhatsApp Cloud "outside the 24h window" errors (business-initiated text). */
function isWindowError(err) {
  const msg = String((err && (err.message || err)) || '');
  return /131047|outside.*24.*hour|24.*hour.*window|messaging window/i.test(msg);
}

/**
 * Send one text reply on any channel, splitting long answers and falling
 * back to a template when WhatsApp's 24h window has closed.
 *
 * @param {object} target  { channel, phoneNumberId?, pageId?, chatId?, recipientId?, sessionId?, botToken? }
 * @param {string} text    reply text (plain, post-plainText)
 * @param {object} opts    { template?: {name, lang, vars} }
 * @returns {Promise<{sent:number, templated:boolean}>}
 */
async function sendChannelText(target, text, opts = {}) {
  const channel = target.channel || 'whatsapp';
  const parts = splitReply(text);
  const legacy = require('./channels');
  let sent = 0;
  let templated = false;

  for (const part of parts) {
    try {
      await sendOne(channel, target, part, legacy);
      sent += 1;
    } catch (err) {
      // Outside the customer-service window: Meta rejects proactive text.
      // Retry THIS part as the org's template message when configured.
      if ((channel === 'whatsapp' || channel === 'openwa') && isWindowError(err) && opts.template?.name) {
        await sendOneTemplate(channel, target, part, opts.template, legacy);
        templated = true;
        sent += 1;
        continue;
      }
      throw Object.assign(new Error(`[${channel}] send failed: ${err.message}`), { channel, cause: err });
    }
  }

  return { sent, templated };
}

async function sendOne(channel, target, text, legacy) {
  switch (channel) {
    case 'whatsapp':
      return legacy.sendWhatsApp(target.phoneNumberId, target.chatId, text);
    case 'openwa': {
      const openwa = require('./openwa');
      return openwa.sendText(target.sessionId, target.chatId, text);
    }
    case 'messenger':
    case 'instagram':
      return legacy.sendMessenger(target.pageId, target.recipientId, text);
    case 'telegram': {
      const telegram = require('./telegram');
      return telegram.sendMessage(target.botToken, target.chatId, text);
    }
    case 'viber': {
      const viber = require('./viber');
      return viber.sendText(target.botToken, target.chatId, text);
    }
    default:
      throw new Error(`unknown channel "${channel}"`);
  }
}

async function sendOneTemplate(channel, target, text, template, legacy) {
  if (channel === 'openwa') {
    // OpenWA sessions are personal-number sessions: no template namespace.
    const openwa = require('./openwa');
    return openwa.sendText(target.sessionId, target.chatId, `${template.name}: ${text}`.slice(0, 4000));
  }
  return legacy.sendWhatsAppTemplate(target.phoneNumberId, target.chatId, template, text);
}

/**
 * Interactive follow-ups: native buttons where the transport has them.
 * `options` = [{ id, title }]. Titles are capped at 20 chars (WhatsApp hard
 * limit); longer sets degrade to a numbered plain-text list so the tap still
 * works when typed back ("1").
 */
async function sendInteractive(target, bodyText, options = []) {
  const channel = target.channel;
  const clean = options
    .filter((o) => o && (o.id || o.title))
    .slice(0, 3)
    .map((o) => ({ id: String(o.id || o.title).slice(0, 64), title: String(o.title || o.id).slice(0, 20) }));

  if (!clean.length) return sendChannelText(target, bodyText);

  const legacy = require('./channels');
  try {
    if (channel === 'whatsapp' && target.phoneNumberId) {
      return legacy.sendWhatsAppInteractive(target.phoneNumberId, target.chatId, bodyText, clean);
    }
    if (channel === 'telegram' && target.botToken) {
      const telegram = require('./telegram');
      return telegram.sendInlineKeyboard(target.botToken, target.chatId, bodyText, clean);
    }
    if ((channel === 'messenger' || channel === 'instagram') && target.pageId) {
      return legacy.sendMessengerQuickReplies(target.pageId, target.recipientId, bodyText, clean);
    }
  } catch (err) {
    console.warn(`[channelSend] interactive failed on ${channel}, falling back to text:`, err.message);
  }

  // Fallback (OpenWA, Viber, unknown, or a failed native call): numbered list.
  // The inbound normaliser maps a typed "1" back to the same option id.
  const lines = clean.map((o, i) => `${i + 1}. ${o.title}`);
  return sendChannelText(target, `${plainText(bodyText)}\n${lines.join('\n')}`);
}

/**
 * Rich media from knowledge: menu photo, price-list PDF, location pin.
 * Transports without a media endpoint fall back to a text pointer.
 */
async function sendMedia(target, media) {
  const channel = target.channel;
  const legacy = require('./channels');
  try {
    if ((channel === 'whatsapp' || channel === 'openwa') && media.imageUrl) {
      if (channel === 'whatsapp') {
        return legacy.sendWhatsAppImage(target.phoneNumberId, target.chatId, media.imageUrl, media.caption);
      }
      const openwa = require('./openwa');
      return openwa.sendImage(target.sessionId, target.chatId, media.imageUrl, media.caption);
    }
    if ((channel === 'whatsapp' || channel === 'openwa') && media.documentUrl) {
      if (channel === 'whatsapp') {
        return legacy.sendWhatsAppDocument(target.phoneNumberId, target.chatId, media.documentUrl, media.caption);
      }
      const openwa = require('./openwa');
      return openwa.sendDocument(target.sessionId, target.chatId, media.documentUrl, media.caption);
    }
    if (channel === 'telegram' && target.botToken && (media.imageUrl || media.documentUrl)) {
      const telegram = require('./telegram');
      if (media.imageUrl) return telegram.sendPhoto(target.botToken, target.chatId, media.imageUrl, media.caption);
      return telegram.sendDocument(target.botToken, target.chatId, media.documentUrl, media.caption);
    }
    if ((channel === 'whatsapp' || channel === 'openwa') && media.latitude != null && media.longitude != null) {
      if (channel === 'whatsapp') {
        return legacy.sendWhatsAppLocation(
          target.phoneNumberId, target.chatId, media.latitude, media.longitude,
          media.locationName, media.locationAddress
        );
      }
      const openwa = require('./openwa');
      return openwa.sendLocation(target.sessionId, target.chatId, media.latitude, media.longitude, media.locationName);
    }
  } catch (err) {
    console.warn(`[channelSend] media failed on ${channel}, falling back to text:`, err.message);
  }
  if (media.caption || media.imageUrl || media.documentUrl) {
    return sendChannelText(target, media.caption || `Here's the file you asked for: ${media.documentUrl || media.imageUrl}`);
  }
  return sendChannelText(target, media.fallbackText || 'Here are the details you asked for.');
}

module.exports = {
  plainText,
  splitReply,
  isWindowError,
  sendChannelText,
  sendInteractive,
  sendMedia,
};
