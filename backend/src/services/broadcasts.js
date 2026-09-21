/**
 * Broadcasts (V11) — scheduled template messages to opted-in contacts.
 *
 * Plain text only (channels that need pre-approved templates get the org's
 * WhatsApp template; OpenWA/Viber send plain). Sending is CHECKPOINTED:
 * `processed_ids` records every attempted contact so a crashed run resumes
 * instead of double-sending. The sweeper is started from server.js and is a
 * cheap no-op when nothing is due (one indexed query).
 *
 * Quotas: paid plans only (an accidental free-plan blast would eat their
 * lifetime messages). Each send is tracked as a 'message' usage event.
 */

const supabaseAdmin = require('../lib/supabase');
const prefs = require('./channelPrefs');
const { sendChannelText } = require('./channelSend');

const SWEEP_INTERVAL_MS = parseInt(process.env.BROADCAST_SWEEP_MS || '60000', 10);
const PACE_PER_MINUTE = parseInt(process.env.BROADCAST_PER_MINUTE || '10', 10);
const MAX_TARGETS_PER_SWEEP = parseInt(process.env.BROADCAST_MAX_PER_SWEEP || '300', 10);

/** Start the in-process sweeper (idempotent; safe to call from server.js). */
let timer = null;
function startBroadcastSweeper() {
  if (timer) return;
  timer = setInterval(() => {
    sweepDueBroadcasts().catch((err) => console.error('[broadcasts] sweep failed:', err.message));
  }, SWEEP_INTERVAL_MS);
  // First sweep shortly after boot so a queued broadcast resumes promptly.
  setTimeout(() => sweepDueBroadcasts().catch((e) => console.error('[broadcasts] sweep failed:', e.message)), 20_000);
  console.log(`[broadcasts] sweeper every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s`);
}

/** Rows due to send: scheduled or stuck mid-send, past their scheduled_at. */
async function sweepDueBroadcasts() {
  const now = new Date().toISOString();
  const { data: due, error } = await supabaseAdmin
    .from('channel_broadcasts')
    .select('id, organization_id, channel, message, template_name, processed_ids, scheduled_at, status')
    .in('status', ['scheduled', 'sending'])
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(5);

  if (error) throw error;
  for (const b of due || []) {
    await runBroadcast(b).catch((err) => console.error(`[broadcasts] #${b.id} failed:`, err.message));
  }
}

/** Process one broadcast to completion (idempotent via processed_ids). */
async function runBroadcast(broadcast) {
  const { id, organization_id: orgId, channel, message, template_name: templateName } = broadcast;
  const done = new Set(broadcast.processed_ids || []);

  const { data: settings } = await supabaseAdmin
    .from('settings')
    .select('channel_settings, whatsapp_phone_number_id')
    .eq('organization_id', orgId)
    .maybeSingle();
  const stored = prefs.prefsOf(settings);
  const template = templateName
    ? prefs.whatsappTemplate({ whatsapp: { template: templateName, ...(stored.whatsapp || {}) } })
    : prefs.whatsappTemplate(stored);

  // Audience snapshot at send time (re-queried per sweep, so new opt-ins
  // added mid-flight are included — deliberate, opt-in is the contract).
  const { data: contacts, error } = await supabaseAdmin
    .from('channel_contacts')
    .select('id, channel, remote_id')
    .eq('organization_id', orgId)
    .eq('channel', channel)
    .eq('opt_in', true)
    .limit(MAX_TARGETS_PER_SWEEP + done.size);
  if (error) throw error;

  const targets = (contacts || []).filter((c) => !done.has(c.id));
  if (!targets.length) {
    await finishBroadcast(id, [...done]);
    return;
  }

  // Mark sending so a parallel sweep doesn't double-run.
  await supabaseAdmin
    .from('channel_broadcasts')
    .update({ status: 'sending', started_at: broadcast.started_at || new Date().toISOString() })
    .eq('id', id);

  const conn = await resolveBroadcastTransport(orgId, channel, stored, settings);
  if (!conn) {
    await supabaseAdmin
      .from('channel_broadcasts')
      .update({ status: 'failed', last_error: `${channel} is not connected`, finished_at: new Date().toISOString() })
      .eq('id', id);
    return;
  }

  // Pacing: spread sends across the minute budget.
  const delayMs = Math.max(6000, Math.ceil(60000 / PACE_PER_MINUTE));
  let sent = 0;
  let failed = 0;

  for (const contact of targets.slice(0, MAX_TARGETS_PER_SWEEP)) {
    try {
      await sendChannelText({ ...conn, chatId: contact.remote_id, recipientId: contact.remote_id }, message, { template });
      sent += 1;
      await supabaseAdmin.from('usage_events').insert({ organization_id: orgId, event_type: 'message' });
    } catch (err) {
      failed += 1;
      await supabaseAdmin
        .from('channel_broadcasts')
        .update({ last_error: err.message.slice(0, 500) })
        .eq('id', id);
    }
    done.add(contact.id);
    // Checkpoint after every send: a crash here resumes at this point.
    await supabaseAdmin
      .from('channel_broadcasts')
      .update({ processed_ids: [...done], sent_count: sent, failed_count: failed })
      .eq('id', id);
    await new Promise((r) => setTimeout(r, delayMs));
  }

  await finishBroadcast(id, [...done], sent, failed);
}

/** Transport address for broadcasts, mirroring inbox.buildTarget. */
async function resolveBroadcastTransport(orgId, channel, stored, settings) {
  if (channel === 'whatsapp' && settings?.whatsapp_phone_number_id) {
    return { channel: 'whatsapp', phoneNumberId: settings.whatsapp_phone_number_id };
  }
  if (channel === 'telegram') {
    const botToken = prefs.orgBotToken(stored, 'telegram');
    return botToken ? { channel: 'telegram', botToken } : null;
  }
  if (channel === 'viber') {
    const botToken = prefs.orgBotToken(stored, 'viber');
    return botToken ? { channel: 'viber', botToken } : null;
  }
  if (channel === 'openwa') {
    const { data: conn } = await supabaseAdmin
      .from('whatsapp_connections')
      .select('openwa_session_id, status')
      .eq('organization_id', orgId)
      .maybeSingle();
    return conn?.openwa_session_id && conn.status !== 'disconnected'
      ? { channel: 'openwa', sessionId: conn.openwa_session_id }
      : null;
  }
  return null;
}

module.exports = { startBroadcastSweeper, sweepDueBroadcasts, resolveBroadcastTransport };

async function finishBroadcast(id, processedIds, sent = 0, failed = 0) {
  await supabaseAdmin
    .from('channel_broadcasts')
    .update({
      status: 'done',
      processed_ids: processedIds,
      finished_at: new Date().toISOString(),
      ...(sent ? { sent_count: sent } : {}),
      ...(failed ? { failed_count: failed } : {}),
    })
    .eq('id', id);
}
