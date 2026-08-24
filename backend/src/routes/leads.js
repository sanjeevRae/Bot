const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/leads — list tenant leads */
router.get('/', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('leads')
    .select('*')
    .eq('organization_id', req.orgId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ leads: data || [] });
});

/** DELETE /api/leads/:id */
router.delete('/:id', async (req, res) => {
  const { error } = await supabaseAdmin
    .from('leads')
    .delete()
    .eq('id', parseInt(req.params.id, 10))
    .eq('organization_id', req.orgId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
