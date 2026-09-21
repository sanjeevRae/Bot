/**
 * Per-org channel control plane (V11) — stored in settings.channel_settings (JSONB).
 *
 * One JSONB column instead of a column per toggle, because the plan keeps
 * adding knobs (toggles, office hours, handoff ping, template names, bot
 * tokens). Reads are already cached with the settings row in
 * services/orgCache.js, so every helper here is synchronous and pure: it
 * never touches the network or the database. Unknown keys are ignored, so an
 * old deploy reading a newer settings blob stays safe.
 *
 * Shape (all keys optional):
 * {
 *   channel_enabled: { web, whatsapp, openwa, messenger, instagram, telegram, viber },
 *   office: { timezone: 'Asia/Kathmandu',
 *             windows: [{ days: [1,2,3,4,5], open: '09:00', close: '18:00' }],
 *             message: 'We are closed…' },
 *   handoff: { activeSessionIds: ['whatsapp_97798…'], pingNumber, pingMessage },
 *   whatsapp: { template, templateLang, templateVars[] },
 *   telegram: { botToken },
 *   viber: { botToken }
 * }
 */

function prefsOf(settings) {
  const raw = settings && settings.channel_settings;
  return raw && typeof raw === 'object' ? raw : {};
}

/** Default-open: a channel answers unless the org explicitly disabled it. */
function channelEnabled(prefs, channel) {
  const map = prefs.channel_enabled;
  if (!map || typeof map !== 'object' || !(channel in map)) return true;
  return Boolean(map[channel]);
}

/** ---- Office hours ---- */

function getOffice(prefs) {
  const o = prefs.office;
  if (!o || typeof o !== 'object') return null;
  const windows = Array.isArray(o.windows) ? o.windows : [];
  if (!windows.length) return null;
  return {
    timezone: typeof o.timezone === 'string' ? o.timezone : null,
    windows,
    message: typeof o.message === 'string' ? o.message : '',
  };
}

/** Local weekday (0–6) + minutes-since-midnight in a timezone (Intl, no deps). */
function localDayAndMinutes(date, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = {};
    for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
    const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
    const minutes = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    if (day === undefined || Number.isNaN(minutes)) throw new Error('bad parts');
    return { day, minutes };
  } catch {
    return { day: date.getDay(), minutes: date.getHours() * 60 + date.getMinutes() };
  }
}

function toMinutes(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return mins >= 0 && mins < 24 * 60 ? mins : null;
}

/**
 * Is the business currently open? Overnight windows (open 18:00, close 02:00)
 * are supported. Unknown shapes fail OPEN — a misconfigured schedule must
 * never silence the bot.
 */
function isOfficeOpen(office, now = new Date()) {
  if (!office) return true;
  try {
    const { day, minutes } = localDayAndMinutes(now, office.timezone);
    for (const w of office.windows || []) {
      const days = Array.isArray(w.days) ? w.days : [];
      if (!days.includes(day)) continue;
      const open = toMinutes(w.open);
      const close = toMinutes(w.close);
      if (open === null || close === null) continue;
      if (open <= close) {
        if (minutes >= open && minutes < close) return true;
      } else if (minutes >= open || minutes < close) {
        return true; // overnight span
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** Null when open; otherwise the closed message the merchant configured. */
function officeClosedMessage(prefs, now = new Date()) {
  const office = getOffice(prefs);
  if (!office || isOfficeOpen(office, now)) return null;
  return office.message || "Sorry, we're currently closed. We'll get back to you during business hours.";
}

/** ---- Human handoff (bot pause) ---- */

/**
 * Session ids the owner has taken over (Inbox "take over" writes here; the
 * channel pipelines skip the LLM while listed). The resolve endpoint removes
 * them again — so "pause bot" is a data change, not a deploy.
 */
function handoffSessionIds(prefs) {
  const list = prefs.handoff && prefs.handoff.activeSessionIds;
  return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
}

function isHandoffActive(prefs, sessionId) {
  return handoffSessionIds(prefs).includes(sessionId);
}

/** Owner's phone for the handoff ping (WhatsApp number in international format). */
function handoffPing(prefs) {
  const h = prefs.handoff;
  if (!h || typeof h !== 'object') return null;
  const number = String(h.pingNumber || '').replace(/[^\d+]/g, '');
  if (!number) return null;
  return {
    number,
    message: typeof h.pingMessage === 'string' && h.pingMessage.trim()
      ? h.pingMessage.trim()
      : 'A customer on your bot asked for a human. Open the Inbox to reply.',
  };
}

/** ---- WhatsApp re-engagement template (24-hour window) ---- */

function whatsappTemplate(prefs) {
  const w = prefs.whatsapp;
  if (!w || typeof w !== 'object') return null;
  const name = String(w.template || '').trim();
  if (!name) return null;
  return {
    name,
    lang: String(w.templateLang || 'en_US').trim() || 'en_US',
    vars: Array.isArray(w.templateVars) ? w.templateVars.map((v) => String(v)) : [],
  };
}

/** ---- Per-org bot tokens (Telegram / Viber connect-your-own-bot) ---- */

function orgBotToken(prefs, key) {
  const section = prefs[key];
  if (!section || typeof section !== 'object') return '';
  return String(section.botToken || '').trim();
}

module.exports = {
  prefsOf,
  channelEnabled,
  getOffice,
  isOfficeOpen,
  officeClosedMessage,
  handoffSessionIds,
  isHandoffActive,
  handoffPing,
  whatsappTemplate,
  orgBotToken,
};
