const express = require('express');
const crypto = require('crypto');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { messageQuotaFor } = require('../services/quotas');
const { invalidateOrgContext } = require('../services/orgCache');
const prefs = require('../services/channelPrefs');

const router = express.Router();

// Short in-memory cache for GET /api/org/me. The dashboard, settings, billing
// and the app shell all request it on load; recomputing 6 Supabase round-trips
// for each is wasteful. 60s staleness on usage counters is acceptable.
// Invalidated by any org mutation (settings/profile/channels PATCH).
const meCache = new Map(); // orgId -> { at, payload }
const ME_CACHE_TTL_MS = 60_000;

/** GET /api/org/me — current org + settings + usage stats */
router.get('/me', requireAuth, async (req, res) => {
  const cached = meCache.get(req.orgId);
  if (cached && Date.now() - cached.at < ME_CACHE_TTL_MS) {
    return res.json({ ...cached.payload, cached: true });
  }

  // Usage this month
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthIso = monthStart.toISOString();

  // One round-trip wave instead of 6 sequential ones
  const [orgRes, settingsRes, msgRes, msgTotalRes, bookRes, leadRes, docRes] = await Promise.all([
    supabaseAdmin.from('organizations').select('*').eq('id', req.orgId).single(),
    supabaseAdmin.from('settings').select('*').eq('organization_id', req.orgId).maybeSingle(),
    supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true })
      .eq('organization_id', req.orgId).eq('event_type', 'message').gte('created_at', monthIso),
    // All-time message count — the free tier is measured against this, because
    // its allowance is one-time (lifetime) and never resets.
    supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true })
      .eq('organization_id', req.orgId).eq('event_type', 'message'),
    supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true })
      .eq('organization_id', req.orgId).eq('event_type', 'booking').gte('created_at', monthIso),
    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true })
      .eq('organization_id', req.orgId),
    supabaseAdmin.from('documents').select('id', { count: 'exact', head: true })
      .eq('organization_id', req.orgId),
  ]);

  if (orgRes.error) return res.status(500).json({ error: orgRes.error.message });

  // Free/expired plans: one-time allowance. Paid plans: monthly allowance.
  const quota = messageQuotaFor(orgRes.data);
  const payload = {
    org: orgRes.data,
    settings: settingsRes.data,
    role: req.role,
    usage: {
      messagesThisMonth: msgRes.count || 0,
      messagesTotal: msgTotalRes.count || 0, // all-time; what the free allowance is spent from
      messageQuota: quota.limit,
      messageQuotaPeriod: quota.period, // 'month' | 'lifetime'
      bookingsThisMonth: bookRes.count || 0,
      totalLeads: leadRes.count || 0,
      documents: docRes.count || 0,
    },
  };

  meCache.set(req.orgId, { at: Date.now(), payload });
  res.json(payload);
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
  meCache.delete(req.orgId);
  invalidateOrgContext(req.orgId); // chat must pick up new bot name/greeting at once
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
  meCache.delete(req.orgId);
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
  meCache.delete(req.orgId);
  res.json({ ok: true });
});

/**
 * GET /api/org/channel-prefs — the V11 channel control plane, sanitised for
 * the dashboard: bot tokens are never returned (only whether one is set).
 */
router.get('/channel-prefs', requireAuth, async (req, res) => {
  const { data: settings } = await supabaseAdmin
    .from('settings')
    .select('channel_settings, telegram_bot_username, whatsapp_connections(status)')
    .eq('organization_id', req.orgId)
    .maybeSingle();

  const stored = prefs.prefsOf(settings);
  const enabled = {};
  for (const c of ['web', 'whatsapp', 'openwa', 'messenger', 'instagram', 'telegram', 'viber']) {
    enabled[c] = prefs.channelEnabled(stored, c);
  }

  const has = (key) => Boolean(prefs.orgBotToken(stored, key));
  res.json({
    enabled,
    office: stored.office || null,
    handoff: {
      pingNumber: stored.handoff?.pingNumber || '',
      pingMessage: stored.handoff?.pingMessage || '',
    },
    whatsappTemplate: stored.whatsapp || null,
    telegram: { connected: has('telegram'), botUsername: settings?.telegram_bot_username || null },
    viber: { connected: has('viber') },
    openwaConnected: (settings?.whatsapp_connections || []).some((c) => c.status === 'connected'),
    // Failed column reads (pre-migration DB) mean channel_settings is missing.
    migrationPending: !settings || !('channel_settings' in (settings || {})),
  });
});
/**
 * PATCH /api/org/channel-prefs — merge the posted section into
 * channel_settings. Sections: enabled, office, handoff, whatsappTemplate.
 * Sanitised so no bot token can ever be written through this endpoint.
 */
router.patch('/channel-prefs', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const { data: current } = await supabaseAdmin
      .from('settings')
      .select('channel_settings')
      .eq('organization_id', req.orgId)
      .maybeSingle();
    const next = prefs.prefsOf(current);

    if (body.enabled && typeof body.enabled === 'object') {
      const clean = {};
      for (const c of ['web', 'whatsapp', 'openwa', 'messenger', 'instagram', 'telegram', 'viber']) {
        if (typeof body.enabled[c] === 'boolean') clean[c] = body.enabled[c];
      }
      next.channel_enabled = { ...(next.channel_enabled || {}), ...clean };
    }

    if (body.office === null) {
      delete next.office;
    } else if (body.office && typeof body.office === 'object') {
      // Validate hard here: a bad schedule silently fails OPEN (see
      // channelPrefs.isOfficeOpen), so reject nonsense before it is stored.
      const windows = Array.isArray(body.office.windows) ? body.office.windows : [];
      for (const w of windows) {
        if (!Array.isArray(w.days) || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
          return res.status(400).json({ error: 'office.windows[].days must be integers 0-6 (Sun=0)' });
        }
        for (const k of ['open', 'close']) {
          if (w[k] != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(w[k]))) {
            return res.status(400).json({ error: `office.windows[].${k} must be HH:MM (24h)` });
          }
        }
      }
      next.office = {
        timezone: typeof body.office.timezone === 'string' ? body.office.timezone.slice(0, 64) : null,
        windows,
        message: typeof body.office.message === 'string' ? body.office.message.slice(0, 500) : '',
      };
    }

    if (body.handoff && typeof body.handoff === 'object') {
      next.handoff = {
        ...(next.handoff || {}),
        ...(typeof body.handoff.pingNumber === 'string'
          ? { pingNumber: body.handoff.pingNumber.replace(/[^\d+]/g, '').slice(0, 20) }
          : {}),
        ...(typeof body.handoff.pingMessage === 'string'
          ? { pingMessage: body.handoff.pingMessage.slice(0, 500) }
          : {}),
      };
    }

    if (body.whatsappTemplate === null) {
      delete next.whatsapp;
    } else if (body.whatsappTemplate && typeof body.whatsappTemplate === 'object') {
      next.whatsapp = {
        template: String(body.whatsappTemplate.template || '').slice(0, 100).trim(),
        templateLang: String(body.whatsappTemplate.templateLang || 'en_US').slice(0, 12).trim(),
        templateVars: Array.isArray(body.whatsappTemplate.templateVars)
          ? body.whatsappTemplate.templateVars.slice(0, 10).map((v) => String(v).slice(0, 200))
          : [],
      };
    }

    const { error } = await supabaseAdmin
      .from('settings')
      .update({ channel_settings: next, updated_at: new Date().toISOString() })
      .eq('organization_id', req.orgId);
    if (error) return res.status(500).json({ error: error.message });

    meCache.delete(req.orgId);
    invalidateOrgContext(req.orgId);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
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
  meCache.delete(req.orgId);
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
