const express = require('express');
const { supabaseAdmin } = require('../supabaseClient');
const { requireAuth } = require('../middleware/auth');
const credits = require('../services/creditsService');

const router = express.Router();

router.get('/balance', requireAuth, async (req, res) => {
  const balance = await credits.getBalance(req.user.id);
  res.json({ balance });
});

router.get('/packages', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('credit_packages').select('*').eq('is_active', true).order('credits');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ packages: data });
});

router.post('/packages/:id/redeem', requireAuth, async (req, res) => {
  const { data: pkg, error } = await supabaseAdmin
    .from('credit_packages').select('*').eq('id', req.params.id).eq('is_active', true).single();
  if (error || !pkg) return res.status(404).json({ error: 'Package not found' });

  try {
    const balance = await credits.credit(req.user.id, pkg.credits, 'purchase', pkg.id);
    res.json({ ok: true, balance, message: `Credits Available: ${balance}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/transactions', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('credit_transactions')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ transactions: data });
});

module.exports = router;
