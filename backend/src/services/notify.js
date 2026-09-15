const supabaseAdmin = require('../lib/supabase');
const { sendEmail, notifyTemplate } = require('./email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(email) {
  const v = String(email || '').trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : null;
}

/**
 * Who gets notified for this organization?
 *   1. settings.notify_email  — explicit "Notification email" from Settings
 *   2. every member of the org — i.e. the email each user logs in with
 *      (owner/admin first), so the account that set the bot up always hears
 *      about new bookings / leads / human handoffs.
 * Deduped and validated; never throws (returns [] on failure).
 */
async function getOrgRecipients(orgId, settings) {
  const found = new Map(); // email -> best role seen
  const rankOf = (role) => ({ owner: 0, admin: 1, member: 2 }[role] ?? 3);
  const add = (email, role = 'member') => {
    const e = normalize(email);
    if (!e) return;
    const prev = found.get(e);
    if (!prev || rankOf(role) < rankOf(prev)) found.set(e, role);
  };

  add(settings?.notify_email, 'owner');

  try {
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, role')
      .eq('organization_id', orgId);
    if (error) throw new Error(error.message);

    const withoutEmail = [];
    for (const p of profiles || []) {
      if (p.email) add(p.email, p.role === 'admin' ? 'admin' : p.role || 'member');
      else withoutEmail.push(p.id);
    }

    // Older signups may not have profiles.email mirrored — fall back to auth.users.
    for (const id of withoutEmail.slice(0, 5)) {
      try {
        const { data } = await supabaseAdmin.auth.admin.getUserById(id);
        add(data?.user?.email, 'owner');
      } catch { /* ignore individual lookup failures */ }
    }
  } catch (e) {
    console.warn('[notify] recipient lookup failed:', e.message);
  }

  // owner/admin first so the primary account is the first recipient
  const rank = { owner: 0, admin: 1, member: 2 };
  return [...found.keys()].sort((a, b) => (rank[found.get(a)] ?? 3) - (rank[found.get(b)] ?? 3));
}

/**
 * Notify an organization that something happened on their bot
 * (new booking, new lead, human handoff). Sends to:
 *   - the configured webhook, when set (Slack / Zapier / n8n)
 *   - email — explicit notification address + all org users' login emails
 * Never throws: a failed notification must not break the chat pipeline.
 */
async function notifyOrg(orgId, settings, message, subject) {
  const result = { recipients: [], emailed: false, webhook: false };
  try {
    if (settings?.webhook_url) {
      try {
        await fetch(settings.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org_id: orgId, type: 'notification', message }),
          signal: AbortSignal.timeout(5000),
        });
        result.webhook = true;
      } catch (e) {
        console.warn('[notify] webhook failed:', e.message);
      }
    }

    const recipients = await getOrgRecipients(orgId, settings);
    result.recipients = recipients;
    if (!recipients.length) return result;

    const finalSubject = subject || (message.includes(':') ? message.split(':')[0].trim() : 'New activity on your bot');
    const html = notifyTemplate('New activity on your bot', message);

    const sends = await Promise.all(recipients.map((to) => sendEmail(to, finalSubject, html)));
    result.emailed = sends.some(Boolean);
  } catch (e) {
    console.warn('[notify] notifyOrg failed:', e.message);
  }
  return result;
}

module.exports = { notifyOrg, getOrgRecipients };
