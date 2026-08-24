const express = require('express');
const crypto = require('crypto');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/** GET /api/org/me — current org + settings + usage stats */
router.get('/me', requireAuth, async (req, res) => {
  const [{ data: org }, { data: settings }] = await Promise.all([
    supabaseAdmin.from('organizations').select('*').eq('id', req.orgId).single(),
    supabaseAdmin.from('settings').select('*').eq('organization_id', req.orgId).maybeSingle(),
  ]);

  // Usage this month
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { count: messages } = await supabaseAdmin
    .from('usage_events')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', req.orgId)
    .eq('event_type', 'message')
    .gte('created_at', monthStart.toISOString());

  const config = require('../config');
  const messageQuota = org?.monthly_message_quota ?? config.freeTierQuotas.messagesPerMonth;
  const { count: bookings } = await supabaseAdmin
    .from('usage_events')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', req.orgId)
    .eq('event_type', 'booking')
    .gte('created_at', monthStart.toISOString());

  const { count: leadsCount } = await supabaseAdmin
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', req.orgId);

  const { count: docs } = await supabaseAdmin
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', req.orgId);

  res.json({
    org,
    settings,
    role: req.role,
    usage: {
      messagesThisMonth: messages || 0,
      messageQuota,
      bookingsThisMonth: bookings || 0,
      totalLeads: leadsCount || 0,
      documents: docs || 0,
    },
  });
});

/** PATCH /api/org/settings — update bot settings */
router.patch('/settings', requireAuth, async (req, res) => {
  const allowed = ['bot_name', 'welcome_message', 'brand_color', 'notify_email', 'whatsapp_number', 'webhook_url', 'timezone'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('settings')
    .update(updates)
    .eq('organization_id', req.orgId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ settings: data });
});
/** GET /api/org/channels — messaging channel connection status */
router.get('/channels', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('settings')
    .select('whatsapp_number, whatsapp_phone_number_id, messenger_page_id')
    .eq('organization_id', req.orgId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  const backendUrl = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    channels: {
      whatsapp: {
        connected: !!data?.whatsapp_phone_number_id,
        phoneNumberId: data?.whatsapp_phone_number_id || '',
        displayNumber: data?.whatsapp_number || '',
      },
      messenger: {
        connected: !!data?.messenger_page_id,
        pageId: data?.messenger_page_id || '',
      },
    },
    webhookUrl: `${backendUrl}/api/channels/webhook`,
    verifyTokenHint: 'Set META_VERIFY_TOKEN in backend env; use the same value in Meta App dashboard.',
  });
});

/** POST /api/org/channels — connect a messaging channel */
router.post('/channels', requireAuth, async (req, res) => {
  const { channel, externalId } = req.body;
  const valid = { whatsapp: 'whatsapp_phone_number_id', messenger: 'messenger_page_id' };
  if (!valid[channel]) return res.status(400).json({ error: 'channel must be "whatsapp" or "messenger"' });
  if (!externalId) return res.status(400).json({ error: 'externalId is required' });

  const updates = { [valid[channel]]: String(externalId).trim(), updated_at: new Date().toISOString() };
  const { data, error } = await supabaseAdmin
    .from('settings')
    .update(updates)
    .eq('organization_id', req.orgId)
    .select('whatsapp_number, whatsapp_phone_number_id, messenger_page_id')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, settings: data });
});

/** DELETE /api/org/channels/:channel — disconnect a channel */
router.delete('/channels/:channel', requireAuth, async (req, res) => {
  const valid = { whatsapp: 'whatsapp_phone_number_id', messenger: 'messenger_page_id' };
  const col = valid[req.params.channel];
  if (!col) return res.status(400).json({ error: 'Unknown channel' });

  const { error } = await supabaseAdmin
    .from('settings')
    .update({ [col]: null, updated_at: new Date().toISOString() })
    .eq('organization_id', req.orgId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
/** PATCH /api/org/profile — update org profile */
router.patch('/profile', requireAuth, async (req, res) => {
  const allowed = ['name', 'industry', 'timezone'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .update(updates)
    .eq('id', req.orgId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ org: data });
});

/** POST /api/org/api-key — generate widget API key */
router.post('/api-key', requireAuth, async (req, res) => {
  const rawKey = 'chitra_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const { error } = await supabaseAdmin
    .from('api_keys')
    .insert({ organization_id: req.orgId, key_hash: keyHash, label: 'widget' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ apiKey: rawKey }); // shown once; only hash stored
});

module.exports = router;

// Export helper for widget route to verify keys
function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
module.exports.hashKey = hashKey;
