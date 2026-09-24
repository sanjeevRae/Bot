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

/**
 * Does one `mentionedIds`/`mentions`/body-token value point at this session?
 * Matches the phone-form WID, any learned `@lid` of our own, or digits of either.
 */
function isOwnId(entry, ownDigits, ownWid, ownLids = []) {
  if (!entry) return false;
  const value = String(entry).trim().toLowerCase();
  if (ownWid && value === ownWid.toLowerCase()) return true;
  if (ownLids.some((lid) => String(lid).toLowerCase() === value)) return true;
  const digits = digitsOf(value);
  if (!digits) return false;
  if (ownDigits && digits === String(ownDigits)) return true;
  return ownLids.some((lid) => digitsOf(lid) === digits);
}

/**
 * Mentions rendered as "@<display name>" — some gateway builds (and some
 * WhatsApp clients) put the contact's name in the body instead of the number.
 * Word-boundary guarded so "@Chitra AI ltd" does not match "Chitra".
 */
function nameMentioned(body, ownName) {
  const name = String(ownName || '').trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${escaped}(?=\\s|$|[,.!?])`, 'i').test(String(body || ''));
}

/**
 * How (if at all) this payload points at this session's own identity:
 * 'mentionedIds' | 'mentions' | 'body-number' | 'body-name' | null.
 * The structured lists are authoritative; the body checks are the fallback for
 * builds that omit them. Single source of truth for both the decision and the
 * diagnostics endpoint. `ownLids` are the session's own privacy ids — WhatsApp
 * increasingly reports a mention of us as `@lid` rather than as our number.
 */
function matchedBy(data, ownDigits, ownWid, ownName = null, ownLids = []) {
  const lists = [['mentionedIds', data?.mentionedIds], ['mentions', data?.mentions]];
  for (const [key, list] of lists) {
    if (Array.isArray(list) && list.some((entry) => isOwnId(entry, ownDigits, ownWid, ownLids))) return key;
  }
  const tokens = mentionTokens(data?.body);
  if (tokens.some((token) => isOwnId(token, ownDigits, ownWid, ownLids))) return 'body-number';
  if (ownName && nameMentioned(data?.body, ownName)) return 'body-name';
  return null;
}

/**
 * Was this session mentioned? `ownWid`/`ownDigits`/`ownName` come from the
 * session's own number and display name, `ownLids` from its privacy ids.
 */
function mentionedOwnId(data, ownDigits, ownWid, ownName = null, ownLids = []) {
  if (!ownDigits && !ownWid && !ownName && !ownLids.length) return false;
  return matchedBy(data, ownDigits, ownWid, ownName, ownLids) !== null;
}

/**
 * `@lid` mentions that are not (yet) known to be ours. The caller can resolve
 * them (contacts lookup / group roster) to learn this session's own privacy id,
 * which is how a mention like `@248065197879524` becomes recognisable.
 */
function unownedLidMentions(data, ownDigits, ownWid, ownLids = []) {
  const out = [];
  for (const list of [data?.mentionedIds, data?.mentions]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const value = String(entry || '').trim();
      if (!value.endsWith('@lid')) continue;
      if (isOwnId(value, ownDigits, ownWid, ownLids)) continue;
      if (!out.includes(value)) out.push(value);
    }
  }
  return out.slice(0, 5);
}

/**
 * Remove the bot's own mention — the `@<number>` token and/or the `@<name>`
 * form — so the model receives a plain question instead of a stray token. The
 * digit guard (`(?=\D|$)`) keeps a longer number that merely starts with ours.
 */
function stripOwnMention(body, ownDigits, ownName = null, ownLids = []) {
  let out = String(body || '');
  // Our number and every learned privacy id — a mention of us can arrive as either.
  const numbers = [ownDigits, ...ownLids.map((lid) => digitsOf(lid))].filter(Boolean);
  for (const digits of numbers) {
    out = out.replace(new RegExp(`@${digits}(?=\\D|$)`, 'g'), ' ');
  }
  const name = String(ownName || '').trim();
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`@${escaped}(?=\\s|$|[,.!?])`, 'gi'), ' ');
  }
  // "@Bot, price?" leaves a stray separator once the mention is gone.
  return out
    .replace(/^[\s,;:.!?–—-]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Decide what to do with one inbound `message.received` payload.
 *
 * @param {object} args
 * @param {object} args.data                payload.data from the webhook
 * @param {string|null} args.ownDigits      the session's own number (session.phone)
 * @param {string|null} args.ownWid         `${ownDigits}@c.us`, when known
 * @param {string|null} args.ownName        the session's WhatsApp display name,
 *                                          for builds that render "@<name>"
 * @param {boolean} args.groupRepliesEnabled org setting (V12)
 * @param {string|null} args.senderPhone    phone digits for a `@lid` sender, resolved
 *                                          by the caller (null when unknown)
 * @returns {{action:'ignore', reason:string}
 *          |{action:'handle', isGroup:boolean, chatId:string, senderJid:string,
 *            sessionKey:string, remoteId:string, mentionPrefix:string|null,
 *            mentions:string[]|null, body:string, profileName:string|null}}
 */
function planInbound({
  data, ownDigits = null, ownWid = null, ownName = null, ownLids = [],
  groupRepliesEnabled = false, senderPhone = null,
} = {}) {
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
  // Without our own identity we cannot tell "the bot was mentioned" from "someone
  // else was", and answering unrelated chatter is worse than staying silent.
  if (!ownDigits && !ownWid && !ownName && !ownLids.length) {
    return { action: 'ignore', reason: 'own-id-unknown' };
  }
  if (!mentionedOwnId(payload, ownDigits, ownWid, ownName, ownLids)) {
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
    // The Inbox/owner-reply path sends to `remote_id`, so keep it a real phone:
    // a `@lid` author's raw digits are not a valid target, so the caller-resolved
    // phone wins; `sessionKey` stays on the raw author digits (stable either way).
    remoteId: senderPhone || authorDigits || groupDigits,
    mentionPrefix: tagDigits ? `@${tagDigits}` : null,
    mentions: tagDigits ? [`${tagDigits}@c.us`] : null,
    body: stripOwnMention(body, ownDigits, ownName, ownLids) || EMPTY_MENTION_PROMPT,
    profileName,
  };
}

/**
 * Everything the diagnostics endpoint needs to explain a group decision, kept
 * out of `planInbound` so the policy function stays a plain decision.
 */
function describeInbound({ data, ownDigits = null, ownWid = null, ownName = null, ownLids = [] } = {}) {
  const payload = data && typeof data === 'object' ? data : {};
  const listed = []
    .concat(Array.isArray(payload.mentionedIds) ? payload.mentionedIds : [])
    .concat(Array.isArray(payload.mentions) ? payload.mentions : []);
  return {
    chatId: payload.chatId || payload.from || null,
    isGroup: payload.isGroup === true || isGroupChat(payload.chatId || payload.from),
    ownNumber: ownDigits || null,
    ownName: ownName || null,
    // Privacy ids of our own learned so far — the missing piece when a mention
    // arrives as "@<lid>" instead of "@<number>".
    learnedLids: ownLids.slice(0, 5),
    unownedMentions: unownedLidMentions(payload, ownDigits, ownWid, ownLids),
    // What the gateway actually offered, so a miss is explainable (capped — this
    // is a debugging aid, not a transcript).
    offeredMentions: listed.map(String).slice(0, 5),
    bodyMentions: mentionTokens(payload.body).slice(0, 5),
    bodyPreview: String(payload.body || '').slice(0, 80),
    matchedBy: matchedBy(payload, ownDigits, ownWid, ownName, ownLids),
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
  nameMentioned,
  matchedBy,
  mentionedOwnId,
  unownedLidMentions,
  stripOwnMention,
  planInbound,
  describeInbound,
};
