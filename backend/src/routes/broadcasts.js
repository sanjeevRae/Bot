const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { isPlanActive } = require('../services/quotas');
const { sendSms, normalizeNpNumber, isSmsConfigured } = require('../services/sms');

const router = express.Router();
router.use(requireAuth);

const BROADCAST_CHANNELS = ['whatsapp', 'openwa', 'telegram', 'viber'];

/**
 * Broadcasts API (V11) — scheduled messages to opted-in contacts.
 *
 * Rules enforced here (never trusted from the client):
 *   - Paid plans only: a blast would burn a free org's lifetime messages.
 *   - message ≤ 1000 chars; the channel must be connected on the org.
 *   - Contacts are the org's own channel_contacts rows with opt_in — the
 *     customer must have messaged the business first (natural opt-in) or
 *     the owner flips them in/out on the contacts list.
 *   - SMS sends are counted against the monthly message quota.
 */

router.get('/', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('channel_broadcasts')
    .select('id, channel, message, template_name, status, audience, scheduled_at, sent_count, failed_count, last_error, created_at')
    .eq('organization_id', req.orgId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });

  const { data: contacts } = await supabaseAdmin
    .from('channel_contacts')
    .select('channel')
    .eq('organization_id', req.orgId)
    .eq('opt_in', true);

  const audience = {};
  for (const c of contacts || []) audience[c.channel] = (audience[c.channel] || 0) + 1;

  res.json({ broadcasts: data || [], audience });
});

/** POST /api/broadcasts — queue a broadcast (status=scheduled; sweeper sends). */
router.post('/', async (req, res) => {
  try {
    const channel = String(req.body?.channel || '');
    const message = String(req.body?.message || '').trim();
    const templateName = String(req.body?.templateName || '').trim() || null;
    const scheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : new Date();

    if (!BROADCAST_CHANNELS.includes(channel)) {
      return res.status(400).json({ error: `channel must be one of: ${BROADCAST_CHANNELS.join(', ')}` });
    }
    if (message.length < 2 || message.length > 1000) {
      return res.status(400).json({ error: 'message must be 2-1000 characters' });
    }
    if (Number.isNaN(scheduledAt.getTime())) {
      return res.status(400).json({ error: 'scheduledAt is not a valid date' });
    }

    // Paid plans only — the sweeper double-checks at send time.
    const { data: orgRow } = await supabaseAdmin
      .from('organizations')
      .select('plan, plan_expires_at')
      .eq('id', req.orgId)
      .single();
    if (!isPlanActive(orgRow)) {
      return res.status(402).json({ error: 'Broadcasts are available on Pro and Agency plans.' });
    }

    // Channel must be connected, otherwise the queue would just fail.
    const { data: settingsRow } = await supabaseAdmin
      .from('settings')
      .select('channel_settings, whatsapp_phone_number_id')
      .eq('organization_id', req.orgId)
      .maybeSingle();
    const prefs = require('../services/channelPrefs');
    const { resolveBroadcastTransport } = require('../services/broadcasts');
    const stored = prefs.prefsOf(settingsRow);
    const transport = await resolveBroadcastTransport(req.orgId, channel, stored, settingsRow);
    if (!transport) {
      return res.status(400).json({ error: `${channel} is not connected. Connect it on the Channels page first.` });
    }

    const { data, error } = await supabaseAdmin
      .from('channel_broadcasts')
      .insert({
        organization_id: req.orgId,
        channel,
        message,
        template_name: templateName,
        audience: 'opted_in',
        status: 'scheduled',
        scheduled_at: scheduledAt.toISOString(),
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, broadcast: data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** PATCH /api/broadcasts/:id — reschedule or cancel while it is still queued. */
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const updates = {};
    if (req.body?.status === 'cancelled') {
      updates.status = 'cancelled';
      updates.finished_at = new Date().toISOString();
    }
    if (req.body?.scheduledAt) {
      const when = new Date(req.body.scheduledAt);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid scheduledAt' });
      updates.scheduled_at = when.toISOString();
      updates.status = 'scheduled';
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

    const { data, error } = await supabaseAdmin
      .from('channel_broadcasts')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', req.orgId) // tenant guard
      .in('status', ['draft', 'scheduled']) // a sending/done run cannot be edited
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Broadcast not found (or already sending)' });
    res.json({ ok: true, broadcast: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/broadcasts/sms — one-off SMS to one Nepali number (booking
 * confirmations, handoff pings). Paid plans only; counted against quota.
 */
router.post('/sms', async (req, res) => {
  try {
    const to = normalizeNpNumber(req.body?.to || '');
    const text = String(req.body?.text || '').trim();
    if (!to) return res.status(400).json({ error: 'to must be a Nepali mobile number (98… or +97798…)' });
    if (!text) return res.status(400).json({ error: 'text is required' });

    const { data: orgRow } = await supabaseAdmin
      .from('organizations')
      .select('plan, plan_expires_at')
      .eq('id', req.orgId)
      .single();
    if (!isPlanActive(orgRow)) {
      return res.status(402).json({ error: 'SMS is available on Pro and Agency plans.' });
    }
    if (!isSmsConfigured()) {
      return res.status(400).json({ error: 'SMS is not configured on this deployment (SMS_API_URL / SMS_API_KEY).' });
    }

    const result = await sendSms(to, text);
    await supabaseAdmin.from('usage_events').insert({ organization_id: req.orgId, event_type: 'message' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

/** PATCH /api/broadcasts/contacts/:id — opt a contact in or out. */
router.patch('/contacts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    if (typeof req.body?.opt_in !== 'boolean') return res.status(400).json({ error: 'opt_in boolean required' });

    const { error } = await supabaseAdmin
      .from('channel_contacts')
      .update({ opt_in: req.body.opt_in })
      .eq('id', id)
      .eq('organization_id', req.orgId); // tenant guard
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/broadcasts/contacts — opted-in audience per channel. */
router.get('/contacts', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('channel_contacts')
    .select('id, channel, session_id, remote_id, display_name, opt_in, last_inbound_at')
    .eq('organization_id', req.orgId)
    .order('last_inbound_at', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ contacts: data || [] });
});

module.exports = router;
