/**
 * Viber Bot API (V11) — connect-your-own-bot.
 *
 * Per-org token in settings.channel_settings.viber.botToken (server-only).
 * Viber signs every webhook with X-Viber-Content-Signature (HMAC-SHA256 over
 * the raw body), so the webhook route mounts with express.raw like OpenWA.
 * Docs: developers.viber.com/docs/api/rest-bot-api/
 */

const API = 'https://chatapi.viber.com/pa';

async function callApi(botToken, method, body) {
  if (!botToken) throw new Error('Viber bot token not configured');
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'X-Viber-Auth-Token': botToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (typeof data.status === 'number' && data.status !== 0)) {
    throw new Error(`Viber ${method} failed (${res.status}): ${data.status_message || 'unknown'}`);
  }
  return data;
}

function chunk(text, max = 4000) {
  const t = String(text || '').trim();
  if (t.length <= max) return [t];
  const out = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.slice(0, 4);
}

function baseMessage(receiver, tracking) {
  return {
    receiver,
    min_api_version: 1,
    ...(tracking ? { tracking_data: String(tracking).slice(0, 100) } : {}),
  };
}

/**
 * Plain-text reply. Viber has no interactive payload that maps to our tap
 * model, so buttons always degrade to a numbered list via channelSend.
 */
async function sendText(botToken, receiver, text, tracking) {
  const parts = chunk(text);
  let last = null;
  for (const part of parts) {
    last = await callApi(botToken, 'send_message', {
      ...baseMessage(receiver, tracking),
      type: 'text',
      text: part,
    });
  }
  return last;
}

async function sendPicture(botToken, receiver, imageUrl, caption, tracking) {
  return callApi(botToken, 'send_message', {
    ...baseMessage(receiver, tracking),
    type: 'picture',
    text: caption ? String(caption).slice(0, 200) : 'Photo',
    media: imageUrl,
    thumbnail: imageUrl,
  });
}

/** Register / remove this org's webhook. `events` keeps the firehose small. */
async function setWebhook(botToken, url, events) {
  return callApi(botToken, 'set_webhook', {
    url,
    event_types: events || ['delivered', 'seen', 'failed', 'subscribed', 'unsubscribed', 'conversation_started', 'message'],
    send_name: true,
    send_photo: true,
  });
}

async function removeWebhook(botToken, url) {
  return callApi(botToken, 'set_webhook', { url: url || '' });
}

/** Verify X-Viber-Content-Signature over the raw body. */
function verifySignature(rawBody, signatureHex, token) {
  if (!signatureHex || !token) return false;
  try {
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', token).update(rawBody).digest('hex');
    const a = Buffer.from(String(signatureHex));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = {
  sendText,
  sendPicture,
  setWebhook,
  removeWebhook,
  verifySignature,
};
