const express = require('express');
const { supabaseAdmin } = require('../supabaseClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('private_conversations')
    .select('*, a:user_a(display_name, is_online), b:user_b(display_name, is_online)')
    .or(`user_a.eq.${req.user.id},user_b.eq.${req.user.id}`);
  if (error) return res.status(500).json({ error: error.message });

  const shaped = data.map((c) => {
    const otherIsA = c.user_a !== req.user.id;
    return {
      id: c.id,
      otherUserId: otherIsA ? c.user_a : c.user_b,
      otherDisplayName: (otherIsA ? c.a : c.b)?.display_name,
      otherIsOnline: (otherIsA ? c.a : c.b)?.is_online,
    };
  });
  res.json({ conversations: shaped });
});

router.post('/start', requireAuth, async (req, res) => {
  const { otherUserId } = req.body;
  const [userA, userB] = [req.user.id, otherUserId].sort();

  const { data: existing } = await supabaseAdmin
    .from('private_conversations').select('*').eq('user_a', userA).eq('user_b', userB).maybeSingle();
  if (existing) return res.json({ conversation: existing });

  const { data, error } = await supabaseAdmin
    .from('private_conversations').insert({ user_a: userA, user_b: userB }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversation: data });
});

router.get('/:id/messages', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('private_messages')
    .select('*')
    .eq('conversation_id', req.params.id)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data });
});

module.exports = router;
