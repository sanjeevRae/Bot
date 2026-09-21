/**
 * SMS fallback (V11) — outbound only.
 *
 * Nepali gateways (e.g. Sparrow SMS) charge per message, so this transport
 * is NEVER free-tier: every send requires an active paid plan and is counted
 * against the org's monthly messages quota like any other reply. Used for
 * booking confirmations and handoff pings where WhatsApp/data isn't reliable.
 *
 * Contract: any HTTP provider with { baseUrl, apiKey }. Two shapes are
 * supported, picked by SEND_SMS_MODE:
 *   - 'sparrow'  POST {baseUrl}/sms/send/  { token, from, to, text }
 *   - 'generic'  POST {baseUrl}  { to, text } with Bearer apiKey
 * Unknown provider? Set SMS_API_URL + mode and the generic shape usually fits.
 */

const config = require('../config');

function smsConfig() {
  return {
    baseUrl: (process.env.SMS_API_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.SMS_API_KEY || '',
    mode: (process.env.SMS_MODE || 'generic').toLowerCase(),
    sender: process.env.SMS_SENDER_ID || 'ChitraAI',
    timeoutMs: parseInt(process.env.SMS_TIMEOUT_MS || '10000', 10),
  };
}

function isSmsConfigured() {
  const c = smsConfig();
  return Boolean(c.baseUrl && c.apiKey);
}

/** Nepali mobile numbers: 98XXXXXXXX / +97798XXXXXXXX / 97798XXXXXXXX. */
function normalizeNpNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (/^98\d{8}$/.test(digits)) return `+977${digits}`;
  if (/^97798\d{8}$/.test(digits)) return `+${digits}`;
  if (/^\+97798\d{8}$/.test(String(raw || '').trim())) return String(raw).trim();
  return null;
}

/**
 * Send one SMS (≤ 3 concatenated segments; longer texts are cut at a word
 * boundary rather than billed twice silently).
 * @returns {Promise<{ok:boolean, provider:string, segments:number}>}
 */
async function sendSms(to, text) {
  const cfg = smsConfig();
  if (!cfg.baseUrl || !cfg.apiKey) throw new Error('SMS not configured (SMS_API_URL / SMS_API_KEY)');
  const number = normalizeNpNumber(to);
  if (!number) throw new Error('Invalid Nepali mobile number');

  // GSM-7-ish budget: 3 segments ≈ 459 chars. Cut, don't silently double-bill.
  let body = String(text || '').trim();
  if (body.length > 459) {
    let cut = body.lastIndexOf(' ', 459);
    if (cut < 300) cut = 459;
    body = body.slice(0, cut).trim();
  }
  if (!body) throw new Error('Empty SMS body');

  let res;
  if (cfg.mode === 'sparrow') {
    res = await fetch(`${cfg.baseUrl}/sms/send/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cfg.apiKey, from: cfg.sender, to: number.replace(/^\+/, ''), text: body }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } else {
    res = await fetch(cfg.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: number, from: cfg.sender, text: body }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  }

  const payload = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`SMS send failed (${res.status}): ${payload.slice(0, 200)}`);
  }
  return { ok: true, provider: cfg.mode, segments: body.length > 160 ? (body.length > 306 ? 3 : 2) : 1 };
}

module.exports = { sendSms, isSmsConfigured, normalizeNpNumber };
