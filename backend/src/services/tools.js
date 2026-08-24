const supabaseAdmin = require('../lib/supabase');
const { trackUsage } = require('./rag');

function makeReference() {
  return 'CH' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * Tool executor factory — every tool is tenant-scoped via orgId.
 * extra.sessionId lets tools act on the current chat session (handoff).
 */
function createToolExecutor(orgId, org, settings, extra = {}) {
  return async function executeTool(name, args) {
    if (name === 'request_human') args = { ...args, session_id: extra.sessionId };
    switch (name) {
      case 'check_availability': {
        // Simple internal calendar check: no conflicting booking at that time.
        const when = new Date(`${args.date}T${args.time || '12:00'}:00`);
        if (isNaN(when.getTime())) return { available: false, reason: 'Invalid date/time' };

        const { data, error } = await supabaseAdmin
          .from('bookings')
          .select('id')
          .eq('organization_id', orgId)
          .eq('booking_time', when.toISOString())
          .neq('status', 'cancelled');

        if (error) return { available: false, reason: error.message };
        return { available: data.length === 0, date: args.date, time: args.time };
      }

      case 'create_booking': {
        const when = new Date(`${args.date}T${args.time || '12:00'}:00`);
        if (isNaN(when.getTime())) return { success: false, reason: 'Invalid date/time' };

        const reference = makeReference();
        const { data, error } = await supabaseAdmin
          .from('bookings')
          .insert({
            organization_id: orgId,
            customer_name: args.name,
            contact_info: args.contact,
            booking_time: when.toISOString(),
            party_size: args.party_size || 1,
            details: args.details || null,
            reference,
          })
          .select()
          .single();

        if (error) return { success: false, reason: error.message };

        await trackUsage(orgId, 'booking');
        await notifyOwner(orgId, settings,
          `📅 New booking ${reference}: ${args.name} on ${args.date} at ${args.time}` +
          (args.party_size ? ` (${args.party_size} guests)` : ''));

        return { success: true, reference, booking_id: data.id };
      }

      case 'create_lead': {
        const { data, error } = await supabaseAdmin
          .from('leads')
          .insert({
            organization_id: orgId,
            lead_name: args.name || null,
            contact_info: args.contact,
            notes: args.notes || null,
            source: 'chat',
          })
          .select()
          .single();

        if (error) return { success: false, reason: error.message };

        await trackUsage(orgId, 'lead');
        await notifyOwner(orgId, settings,
          `🎯 New lead: ${args.name || 'Unknown'} — ${args.contact}${args.notes ? ` (${args.notes})` : ''}`);

        return { success: true, lead_id: data.id };
      }

      case 'request_human': {
        // Flag this chat session for human follow-up; owner sees it in the Inbox.
        const { error } = await supabaseAdmin
          .from('chat_history')
          .update({ handoff_requested: true })
          .eq('organization_id', orgId)
          .eq('session_id', args.session_id || '');

        if (error) return { success: false, reason: error.message };

        await notifyOwner(orgId, settings,
          `🙋 Human handoff requested: ${args.reason || 'Visitor asked for a person'}`);

        return {
          success: true,
          message: 'A team member has been notified and will follow up soon.',
        };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  };
}

/**
 * Notify the business owner of important events (new booking, lead).
 * Channels: configured webhook (Slack/Zapier/n8n) + email via Resend.
 */
async function notifyOwner(orgId, settings, message) {
  try {
    if (settings?.webhook_url) {
      await fetch(settings.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, type: 'notification', message }),
        signal: AbortSignal.timeout(5000),
      });
    }
    if (settings?.notify_email) {
      const { sendEmail, notifyTemplate } = require('./email');
      await sendEmail(
        settings.notify_email,
        message.split(':')[0].trim(), // e.g. "📅 New booking CH4X2P"
        notifyTemplate('New activity on your bot', message)
      );
    }
  } catch (e) {
    console.warn('notifyOwner failed:', e.message);
  }
}

module.exports = { createToolExecutor };
