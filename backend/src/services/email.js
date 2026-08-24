const config = require('../config');

/**
 * Email notifications via Resend (https://resend.com — free tier,
 * 100 emails/day, no credit card). Falls back silently when not
 * configured so the chat pipeline never breaks on notification failure.
 */
async function sendEmail(to, subject, html) {
  if (!config.email.apiKey || !to) return false;
  try {
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
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[email] send failed (${res.status}): ${body}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[email] send error:', e.message);
    return false;
  }
}

/** Wrap a plain-text notification in a minimal branded template. */
function notifyTemplate(title, message) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <span style="background:#059669;color:#fff;width:32px;height:32px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-weight:700">C</span>
      <strong style="font-size:15px;color:#111827">Chitra AI</strong>
    </div>
    <h2 style="margin:0 0 8px;font-size:17px;color:#111827">${title}</h2>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#374151">${message}</p>
    <p style="margin-top:20px;font-size:11px;color:#9ca3af">Sent by your Chitra AI assistant</p>
  </div>`;
}

module.exports = { sendEmail, notifyTemplate };
