/**
 * Telegram Bot API (V11) — connect-your-own-bot.
 *
 * Free, no review, per-org BotFather token stored in
 * settings.channel_settings.telegram.botToken (never in the frontend).
 * Long-polling is NOT used: one webhook secret per org (stored in settings
 * alongside the Meta ids) verifies Telegram's deliveries, exactly like the
 * Meta verify-token handshake but with a secret path segment.
 */

const API = 'https://api.telegram.org';

async function callApi(botToken, method, body) {
  if (!botToken) throw new Error('Telegram bot token not configured');
  const res = await fetch(`${API}/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed (${res.status}): ${data.description || 'unknown'}`);
  }
  return data.result;
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

/** Plain-text reply (no markdown — the prompt already says plain text only). */
async function sendMessage(botToken, chatId, text) {
  const parts = chunk(text);
  let last = null;
  for (const part of parts) {
    last = await callApi(botToken, 'sendMessage', { chat_id: chatId, text: part });
  }
  return last;
}

/**
 * Native inline keyboard (callback buttons). `options` = [{ id, title }].
 * Taps arrive back as callback_query with data = id.
 */
async function sendInlineKeyboard(botToken, chatId, text, options) {
  const clean = (options || [])
    .filter((o) => o && (o.id || o.title))
    .slice(0, 8)
    .map((o) => [{ text: String(o.title || o.id).slice(0, 32), callback_data: String(o.id || o.title).slice(0, 64) }]);
  if (!clean.length) return sendMessage(botToken, chatId, text);
  return callApi(botToken, 'sendMessage', {
    chat_id: chatId,
    text: String(text || '').slice(0, 4000),
    reply_markup: { inline_keyboard: clean },
  });
}

async function answerCallback(botToken, callbackQueryId, text) {
  if (!callbackQueryId) return null;
  return callApi(botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

/** Photo/document delivery (menu card, price-list PDF). */
async function sendPhoto(botToken, chatId, photoUrl, caption) {
  return callApi(botToken, 'sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
  });
}

async function sendDocument(botToken, chatId, documentUrl, caption) {
  return callApi(botToken, 'sendDocument', {
    chat_id: chatId,
    document: documentUrl,
    ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
  });
}

/** Register this org's webhook. Called on connect; idempotent on Telegram's side. */
async function setWebhook(botToken, url, secret) {
  return callApi(botToken, 'setWebhook', {
    url,
    ...(secret ? { secret_token: secret } : {}),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  });
}

async function deleteWebhook(botToken) {
  return callApi(botToken, 'deleteWebhook', {});
}

/** Who owns this token (shown on the Channels page after connect). */
async function getMe(botToken) {
  return callApi(botToken, 'getMe', {});
}

/** Photo by file_id → downloadable URL. Prefers the largest size available. */
async function photoFileUrl(botToken, photos) {
  const list = Array.isArray(photos) ? photos : [];
  if (!list.length) return null;
  const biggest = list[list.length - 1];
  if (!biggest?.file_id) return null;
  const file = await callApi(botToken, 'getFile', { file_id: biggest.file_id });
  if (!file?.file_path) return null;
  return `${API}/file/bot${botToken}/${file.file_path}`;
}

/** Voice/audio by file_id → downloadable URL (ogg-opus, ideal for Whisper). */
async function voiceFileUrl(botToken, fileId) {
  if (!fileId) return null;
  const file = await callApi(botToken, 'getFile', { file_id: fileId });
  if (!file?.file_path) return null;
  return `${API}/file/bot${botToken}/${file.file_path}`;
}

module.exports = {
  sendMessage,
  sendInlineKeyboard,
  answerCallback,
  sendPhoto,
  sendDocument,
  setWebhook,
  deleteWebhook,
  getMe,
  photoFileUrl,
  voiceFileUrl,
};
