/**
 * Inbound-routing rules for the OpenWA webhook — Chitra AI side only.
 *
 * The gateway is never modified: it already delivers direct and group messages
 * on the same `message.received` event, exposes the group id in `chatId`, the
 * real sender in `author` and the @-mentioned WIDs in `mentionedIds`. All the
 * policy lives here.
 *
 * Policy
 *   - Direct messages: always answered, to the sender (as before).
 *   - Group messages: answered ONLY when the org enabled group replies AND this
 *     session's own number was @-mentioned. A bot that answers every line in a
 *     group is spam, and a mention is the only unambiguous "talk to me" signal.
 *   - Group conversations are keyed per person (`group + author`) so context and
 *     memory stay isolated between members of the same group.
 *
 * Kept side-effect free (no I/O, no config, no requires) so the rules can be
 * driven with plain payload objects in tests; the async parts — the session's own
 * number, `@lid` → phone resolution, the DB — stay in routes/openwa.js.
 */

const GROUP_SUFFIX = '@g.us';

/** Last-resort prompt when someone @-mentions the bot with no other text. */
const EMPTY_MENTION_PROMPT = '(group mention with no text — greet them and ask what they need)';

/**
 * Digits of a JID, phone or privacy id: "9779810135468@c.us" → "9779810135468",
 * "123@lid" → "123". Also accepts a bare number string.
 */
function digitsOf(value) {
  return String(value || '').split('@')[0].replace(/\D/g, '');
}

function isGroupChat(value) {
  return String(value || '').endsWith(GROUP_SUFFIX);
}

/** A JID like "628123456789@c.us". Anything malformed (no `@`, spaces) → null. */
function normalizeWid(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(s)) return null;
  return s;
}

/** The `@<number>` tokens WhatsApp renders a mention as, without the `@`. */
function mentionTokens(body) {
  // Up to 20 local-part digits: phone numbers cap at 15 (E.164) but group ids and
  // privacy ids run to 18+, and a truncated token would silently never match.
  return (String(body || '').match(/@\d{6,20}/g) || []).map((t) => t.slice(1));
}

/** Does one `mentionedIds`/`mentions` entry point at this session's own number? */
function isOwnId(entry, ownDigits, ownWid) {
  if (!entry) return false;
  const value = String(entry).trim();
  if (ownWid && value.toLowerCase() === ownWid.toLowerCase()) return true;
  const digits = digitsOf(value);
  return Boolean(digits && ownDigits && digits === String(ownDigits));
}

/**
 * Was this session mentioned? The structured list is authoritative (`mentionedIds`
 * on WhatsApp Web builds, `mentions` on some others); the body token is the
 * fallback, because a build that omits the list still renders "@<number>" in the
 * text. `ownWid`/`ownDigits` come from the session's own phone number.
 */
function mentionedOwnId(data, ownDigits, ownWid) {
  if (!ownDigits && !ownWid) return false;
  const lists = [data?.mentionedIds, data?.mentions];
  for (const list of lists) {
    if (Array.isArray(list) && list.some((entry) => isOwnId(entry, ownDigits, ownWid))) return true;
  }
  return ownDigits ? mentionTokens(data?.body).includes(String(ownDigits)) : false;
}

/**
 * Remove the bot's own `@<number>` token so the model receives a plain question
 * instead of a stray mention token. Digit-guarded (`(?=\D|$)`) so a longer number
 * that merely starts with ours is left alone.
 */
function stripOwnMention(body, ownDigits) {
  let out = String(body || '');
  if (ownDigits) out = out.replace(new RegExp(`@${ownDigits}(?=\\D|$)`, 'g'), ' ');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Decide what to do with one inbound `message.received` payload.
 *
 * @param {object} args
 * @param {object} args.data                payload.data from the webhook
 * @param {string|null} args.ownDigits      the session's own number (session.phone)
 * @param {string|null} args.ownWid         `${ownDigits}@c.us`, when known
 * @param {boolean} args.groupRepliesEnabled org setting (V12)
 * @param {string|null} args.senderPhone    phone digits for a `@lid` sender, resolved
 *                                          by the caller (null when unknown)
 * @returns {{action:'ignore', reason:string}
 *          |{action:'handle', isGroup:boolean, chatId:string, senderJid:string,
 *            sessionKey:string, remoteId:string, mentionPrefix:string|null,
 *            mentions:string[]|null, body:string, profileName:string|null}}
 */
function planInbound({ data, ownDigits = null, ownWid = null, groupRepliesEnabled = false, senderPhone = null } = {}) {
  const payload = data && typeof data === 'object' ? data : {};
  // Our own outbound echoes.
  if (payload.fromMe) return { action: 'ignore', reason: 'fromMe' };

  const chatId = normalizeWid(payload.chatId || payload.from);
  if (!chatId) return { action: 'ignore', reason: 'invalid-chat' };

  const isGroup = payload.isGroup === true || isGroupChat(chatId);
  const body = typeof payload.body === 'string' ? payload.body : '';
  const profileName = payload.senderName || payload.pushName || null;

  // ---------------- direct message ----------------
  if (!isGroup) {
    const senderJid = normalizeWid(payload.from || chatId);
    if (!senderJid) return { action: 'ignore', reason: 'invalid-sender' };
    // A `@lid` privacy id cannot be used as a send target, so the caller resolves
    // the real phone number first and hands it in (openwa.resolvePhone).
    const replyTo = senderPhone ? `${senderPhone}@c.us` : senderJid;
    const senderDigits = digitsOf(replyTo) || digitsOf(senderJid);
    return {
      action: 'handle',
      isGroup: false,
      chatId: replyTo,
      senderJid,
      sessionKey: `whatsapp_${senderDigits}`,
      remoteId: senderDigits,
      mentionPrefix: null,
      mentions: null,
      body,
      profileName,
    };
  }

  // ---------------- group message ----------------
  if (!groupRepliesEnabled) return { action: 'ignore', reason: 'group-disabled' };
  // Without our own number we cannot tell "the bot was mentioned" from "someone
  // else was", and answering unrelated chatter is worse than staying silent.
  if (!ownDigits && !ownWid) return { action: 'ignore', reason: 'own-id-unknown' };
  if (!mentionedOwnId(payload, ownDigits, ownWid)) {
    return { action: 'ignore', reason: 'group-not-mentioned' };
  }

  // In a group `from` is the group itself; `author` is the only real sender.
  const authorJid = normalizeWid(payload.author || payload.from);
  if (!authorJid) return { action: 'ignore', reason: 'invalid-sender' };

  const authorDigits = digitsOf(authorJid);
  const groupDigits = digitsOf(chatId);

  // A mention tag needs BOTH the literal `@<number>` token and the matching WID,
  // so it only goes out when the author's real number is known: a `@c.us` author
  // or a `@lid` one the caller resolved. Otherwise the reply is sent untagged
  // rather than risking a rejected send.
  const tagDigits = senderPhone || (authorJid.endsWith('@c.us') ? authorDigits : null);

  return {
    action: 'handle',
    isGroup: true,
    chatId, // answer into the group, never as a DM to the author
    senderJid: authorJid,
    sessionKey: `whatsapp_group_${groupDigits}_${authorDigits}`,
    // The Inbox/owner-reply path sends to `remote_id`, so keep it the person:
    // a human takeover DMs the customer instead of posting in the group.
    remoteId: authorDigits || groupDigits,
    mentionPrefix: tagDigits ? `@${tagDigits}` : null,
    mentions: tagDigits ? [`${tagDigits}@c.us`] : null,
    body: stripOwnMention(body, ownDigits) || EMPTY_MENTION_PROMPT,
    profileName,
  };
}

module.exports = {
  GROUP_SUFFIX,
  EMPTY_MENTION_PROMPT,
  digitsOf,
  isGroupChat,
  normalizeWid,
  mentionTokens,
  isOwnId,
  mentionedOwnId,
  stripOwnMention,
  planInbound,
};
