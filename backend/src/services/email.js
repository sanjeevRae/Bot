const config = require('../config');

/**
 * Email notifications. Two providers, HTTP APIs only (no extra deps):
 *   1. Brevo  (https://brevo.com)  — used when BREVO_API_KEY is set.
 *      Brevo is the same provider Supabase uses for confirmation emails,
 *      so the sender domain is already verified there.
 *   2. Resend (https://resend.com) — fallback when only RESEND_API_KEY is set.
 * Falls back silently when neither is configured so the chat pipeline never
 * breaks on notification failure.
 */

/** "Chitra AI <alerts@domain.com>" -> { name, email } */
function parseFrom(raw) {
  const value = String(raw || '').trim();
  const m = value.match(/^(.*?)\s*<\s*([^>]+)\s*>$/);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim() || 'Chitra AI', email: m[2].trim() };
  return { name: 'Chitra AI', email: value };
}

async function sendViaBrevo(to, subject, html, attachments = []) {
  const sender = parseFrom(config.email.from);
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': config.email.brevoApiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      htmlContent: html,
      // Brevo wants base64 payloads under the singular key 'attachment'
      ...(attachments.length ? { attachment: attachments.map((a) => ({ name: a.filename, content: a.content })) } : {}),
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`brevo ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function sendViaResend(to, subject, html, attachments = []) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.email.from,
      to,
      subject,
      html,
      ...(attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })) } : {}),
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend ${res.status}: ${body.slice(0, 300)}`);
  }
}

/** Which provider will be used, given the configured env vars. */
function activeProvider() {
  if (config.email.brevoApiKey) return 'brevo';
  if (config.email.apiKey) return 'resend';
  return null;
}

async function sendEmail(to, subject, html, attachments = []) {
  if (!to || !activeProvider()) return false;
  try {
    if (config.email.brevoApiKey) await sendViaBrevo(to, subject, html, attachments);
    else await sendViaResend(to, subject, html, attachments);
    return true;
  } catch (e) {
    console.warn(`[email] send failed via ${activeProvider()}:`, e.message);
    // If both providers are configured, try the other one once.
    try {
      if (config.email.brevoApiKey && config.email.apiKey) {
        await sendViaResend(to, subject, html, attachments);
        return true;
      }
    } catch (e2) {
      console.warn('[email] fallback provider failed:', e2.message);
    }
    return false;
  }
}

/** Escape a value before embedding it in email HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wrap ready-made body HTML in the branded email shell. Use this when the body
 * is trusted HTML; use notifyTemplate() for plain text (it escapes for you).
 */
function brandedEmail(title, bodyHtml) {
  const logo = config.email.publicUrl
    ? `<img src="${config.email.publicUrl}/logo.png" alt="Chitra AI" width="32" height="32" style="border-radius:8px;display:block;object-fit:contain" />`
    : `<span style="background:#111827;color:#fff;width:32px;height:32px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-weight:700">C</span>`;
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      ${logo}
      <strong style="font-size:15px;color:#111827">Chitra AI</strong>
    </div>
    <h2 style="margin:0 0 8px;font-size:17px;color:#111827">${title}</h2>
    ${bodyHtml}
    <p style="margin-top:20px;font-size:11px;color:#9ca3af">Sent by your Chitra AI assistant</p>
  </div>`;
}

/** Wrap plain text in the branded shell. The text is HTML-escaped. */
function notifyTemplate(title, message) {
  return brandedEmail(
    title,
    `<p style="margin:0;font-size:14px;line-height:1.6;color:#374151">${escapeHtml(message)}</p>`
  );
}

module.exports = { sendEmail, notifyTemplate, brandedEmail, escapeHtml, activeProvider, parseFrom };
