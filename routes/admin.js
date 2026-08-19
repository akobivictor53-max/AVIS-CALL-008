const express = require('express');
const { supabaseAdmin } = require('../supabaseClient');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/stats', async (req, res) => {
  const [
    users, activeRooms, activeCalls, privateCalls, groupCalls, videoCalls,
    reports, blocked, txCredited, txConsumed,
  ] = await Promise.all([
    supabaseAdmin.from('users').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('rooms').select('id', { count: 'exact', head: true }).eq('is_closed', false),
    supabaseAdmin.from('calls').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabaseAdmin.from('calls').select('id', { count: 'exact', head: true }).in('type', ['private_voice', 'private_video']),
    supabaseAdmin.from('calls').select('id', { count: 'exact', head: true }).in('type', ['group_voice', 'group_video']),
    supabaseAdmin.from('calls').select('id', { count: 'exact', head: true }).in('type', ['private_video', 'group_video']),
    supabaseAdmin.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabaseAdmin.from('blocked_users').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('credit_transactions').select('amount').gt('amount', 0),
    supabaseAdmin.from('credit_transactions').select('amount').lt('amount', 0),
  ]);

  const sum = (rows) => (rows.data || []).reduce((s, r) => s + Number(r.amount), 0);

  res.json({
    totalUsers: users.count || 0,
    activeRooms: activeRooms.count || 0,
    activeCalls: activeCalls.count || 0,
    privateCalls: privateCalls.count || 0,
    groupCalls: groupCalls.count || 0,
    videoCalls: videoCalls.count || 0,
    openReports: reports.count || 0,
    blockedUsers: blocked.count || 0,
    creditsIssued: sum(txCredited),
    creditsConsumed: Math.abs(sum(txConsumed)),
    systemStatus: 'operational',
  });
});

router.post('/rates', async (req, res) => {
  const { action, cost } = req.body;
  const { error } = await supabaseAdmin
    .from('credit_rates').update({ cost }).eq('action', action);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/packages', async (req, res) => {
  const { name, credits, price } = req.body;
  const { data, error } = await supabaseAdmin
    .from('credit_packages').insert({ name, credits, price }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ package: data });
});

router.get('/reports', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('reports').select('*, reporter:reporter_id(display_name), reported:reported_id(display_name)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ reports: data });
});

module.exports = router;
