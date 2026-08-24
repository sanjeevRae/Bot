const express = require('express');
const supabaseAdmin = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/bookings — list tenant bookings */
router.get('/', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .select('*')
    .eq('organization_id', req.orgId)
    .order('booking_time', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ bookings: data || [] });
});

/** PATCH /api/bookings/:id — update status (cancel/complete) */
router.patch('/:id', async (req, res) => {
  const { status } = req.body;
  if (!['confirmed', 'cancelled', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .update({ status })
    .eq('id', parseInt(req.params.id, 10))
    .eq('organization_id', req.orgId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ booking: data });
});

module.exports = router;
