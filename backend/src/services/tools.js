const supabaseAdmin = require('../lib/supabase');
const { trackUsage } = require('./rag');

function makeReference() {
  return 'CH' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * Tool executor factory — every tool is tenant-scoped via orgId.
 * extra carries the chat context tools may act on:
 *   { sessionId, channel, target, prefs, deliverInteractive, deliverMedia }
 *   - sessionId  → handoff flagging
 *   - target     → the transport address (phoneNumberId / pageId / chatId …)
 *   - deliver*   → renderers the pipeline provides (see routes/channels.js)
 * The web widget passes only sessionId, so channel-only tools degrade to the
 * text `message` the model relays itself.
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

        // V11: ping the owner on their own WhatsApp so they hear about it
        // instantly, and point them at the Inbox to take over. Best-effort.
        await pingOwnerWhatsApp(orgId, settings, extra, args.reason).catch((e) =>
          console.warn('[tools] owner WhatsApp ping failed:', e.message)
        );

        return {
          success: true,
          message: 'A team member has been notified and will follow up soon.',
        };
      }

      case 'show_options': {
        // Native quick-reply buttons on transports that render them; every
        // other channel (and the web widget) gets the numbered list inside
        // `message`, which the model relays as its reply.
        const options = (Array.isArray(args.options) ? args.options : [])
          .map((o) => ({ id: o.id || o.title, title: o.title || o.id }))
          .filter((o) => o.id && o.title)
          .slice(0, 5);
        if (!options.length) return { success: false, reason: 'No options provided' };

        const body = args.text || 'Please choose an option:';
        const numbered = options.map((o, i) => `${i + 1}. ${o.title}`).join('\n');
        const message = `${body}\n${numbered}`;

        let delivered = false;
        if (typeof extra.deliverInteractive === 'function' && extra.target) {
          const res = await extra.deliverInteractive(extra.target, extra.prefs, body, options);
          delivered = Boolean(res);
        }
        return {
          success: true,
          delivered,
          message: delivered
            ? 'The options were shown to the customer. Do not repeat them; wait for their choice.'
            : `Reply with exactly this list (the channel has no buttons):\n${message}`,
        };
      }

      case 'send_media': {
        // Menu photo / price-list PDF / location pin. URLs must be public —
        // knowledge-base files live in config, so the model only passes what
        // an admin configured (see the prompt rules).
        const media = {
          imageUrl: args.image_url || null,
          documentUrl: args.document_url || null,
          caption: args.caption || null,
          latitude: args.latitude != null ? Number(args.latitude) : null,
          longitude: args.longitude != null ? Number(args.longitude) : null,
          locationName: args.location_name || null,
        };
        const hasSomething =
          media.imageUrl || media.documentUrl || (media.latitude != null && media.longitude != null);
        if (!hasSomething) {
          return { success: false, reason: 'Provide an image_url, document_url, or latitude+longitude' };
        }

        if (typeof extra.deliverMedia !== 'function' || !extra.target) {
          return {
            success: false,
            reason: 'This channel cannot send media. Share the link as text instead.',
          };
        }
        const res = await extra.deliverMedia(extra.target, media);
        return res
          ? { success: true, message: 'Media sent to the customer. Add a short sentence if needed.' }
          : { success: false, reason: 'Media delivery failed; share the link as text instead.' };
      }

      case 'save_channel_prefs': {
        // The owner can also toggle this from the dashboard; exposing it as a
        // tool is deliberately NOT allowed (a customer could switch off
        // notifications). Guarded here so an LLM hallucination can't.
        return { success: false, reason: 'Settings can only be changed from the dashboard.' };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  };
}

/**
 * Notify the business owner of important events (new booking, lead, handoff).
 * Channels: configured webhook (Slack/Zapier/n8n) + email to the org's
 * notification address AND every org user's login email (see services/notify.js).
 */
async function notifyOwner(orgId, settings, message) {
  const { notifyOrg } = require('./notify');
  await notifyOrg(orgId, settings, message);
}

/**
 * V11: WhatsApp ping to the owner's own number when a handoff is requested.
 *
 * Sends from the org's WhatsApp transport when one is usable:
 *   - Meta Cloud API (phone number id in settings) — plain text inside the
 *     24 h window; outside it Meta rejects proactive text and the ping
 *     degrades to the email/webhook notification that already fired.
 *   - OpenWA session (whatsapp_connections) — personal-number session, so
 *     plain text always works.
 * The owner's number comes from channel_settings.handoff.pingNumber (the
 * Settings page writes it) and falls back to settings.whatsapp_number.
 */
async function pingOwnerWhatsApp(orgId, settings, extra, reason) {
  const { handoffPing } = require('./channelPrefs');
  const prefs = extra?.prefs || {};
  const ping = handoffPing(prefs);
  if (!ping) return;

  // Never ping the number that is currently chatting with the bot.
  const remoteDigits = String(extra?.target?.chatId || '').replace(/\D/g, '');
  if (remoteDigits && remoteDigits.endsWith(ping.number.replace(/\D/g, '').slice(-10))) return;

  const text = `${ping.message}${reason ? `\nReason: ${reason}` : ''}`;

  const openwa = await findOwnersOpenwaSession(orgId);
  if (openwa) {
    const svc = require('./openwa');
    await svc.sendText(openwa.openwa_session_id, normalizeJid(ping.number), text);
    return;
  }
  if (settings?.whatsapp_phone_number_id && require('../config').whatsapp.token) {
    const svc = require('./channels');
    await svc.sendWhatsApp(settings.whatsapp_phone_number_id, ping.number.replace(/^\+/, ''), text);
  }
}

function normalizeJid(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits.includes('@') ? digits : `${digits}@c.us`;
}

/** The org's connected OpenWA session, if any (used for owner pings/replies). */
async function findOwnersOpenwaSession(orgId) {
  try {
    const supabaseAdmin = require('../lib/supabase');
    const { data } = await supabaseAdmin
      .from('whatsapp_connections')
      .select('openwa_session_id, status')
      .eq('organization_id', orgId)
      .maybeSingle();
    return data?.openwa_session_id && data.status !== 'disconnected' ? data : null;
  } catch {
    return null;
  }
}

module.exports = { createToolExecutor, pingOwnerWhatsApp, findOwnersOpenwaSession };
