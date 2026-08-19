const express = require('express');
const bcrypt = require('bcryptjs');
const { supabaseAdmin } = require('../supabaseClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function slugify() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// Create a room
router.post('/', requireAuth, async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'name and password are required' });

  const password_hash = await bcrypt.hash(password, 10);
  const slug = slugify();

  const { data: room, error } = await supabaseAdmin
    .from('rooms')
    .insert({ name, slug, password_hash, owner_id: req.user.id })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await supabaseAdmin.from('room_members').insert({
    room_id: room.id, user_id: req.user.id, role: 'owner',
  });

  res.json({
    room: { id: room.id, name: room.name, slug: room.slug },
    joinLink: `${process.env.PUBLIC_FRONTEND_URL || ''}/room/${room.slug}`,
  });
});

// Join a room by slug + password
router.post('/:slug/join', requireAuth, async (req, res) => {
  const { password } = req.body;
  const { data: room, error } = await supabaseAdmin
    .from('rooms')
    .select('*')
    .eq('slug', req.params.slug)
    .single();
  if (error || !room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_closed) return res.status(410).json({ error: 'This room has been closed' });

  const valid = await bcrypt.compare(password || '', room.password_hash);
  if (!valid) return res.status(401).json({ error: 'Incorrect room password' });

  const { data: existingBlock } = await supabaseAdmin
    .from('room_members')
    .select('is_blocked')
    .eq('room_id', room.id)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (existingBlock?.is_blocked) return res.status(403).json({ error: 'You are blocked from this room' });

  await supabaseAdmin.from('room_members').upsert(
    { room_id: room.id, user_id: req.user.id, role: 'member' },
    { onConflict: 'room_id,user_id', ignoreDuplicates: false }
  );

  res.json({ room: { id: room.id, name: room.name, slug: room.slug } });
});

// Rooms the current user belongs to
router.get('/mine', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('room_members')
    .select('role, rooms:room_id(id, name, slug, is_closed, owner_id)')
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rooms: data.filter((r) => r.rooms && !r.rooms.is_closed).map((r) => ({ ...r.rooms, myRole: r.role })) });
});

// List members
router.get('/:id/members', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('room_members')
    .select('user_id, role, is_blocked, users:user_id(display_name, is_online, last_seen)')
    .eq('room_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ members: data });
});

async function assertOwner(roomId, userId) {
  const { data } = await supabaseAdmin
    .from('rooms').select('owner_id').eq('id', roomId).single();
  return data?.owner_id === userId;
}

// Block a member (owner only)
router.post('/:id/block', requireAuth, async (req, res) => {
  if (!(await assertOwner(req.params.id, req.user.id))) return res.status(403).json({ error: 'Owner only' });
  const { userId } = req.body;
  const { error } = await supabaseAdmin
    .from('room_members').update({ is_blocked: true })
    .eq('room_id', req.params.id).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Remove a member (owner only)
router.post('/:id/remove', requireAuth, async (req, res) => {
  if (!(await assertOwner(req.params.id, req.user.id))) return res.status(403).json({ error: 'Owner only' });
  const { userId } = req.body;
  const { error } = await supabaseAdmin
    .from('room_members').delete()
    .eq('room_id', req.params.id).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Close a room (owner only)
router.post('/:id/close', requireAuth, async (req, res) => {
  if (!(await assertOwner(req.params.id, req.user.id))) return res.status(403).json({ error: 'Owner only' });
  const { error } = await supabaseAdmin
    .from('rooms').update({ is_closed: true }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Recent messages (paginated, latest 50)
router.get('/:id/messages', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('room_messages')
    .select('id, sender_id, content, reply_to, created_at, users:sender_id(display_name)')
    .eq('room_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data.reverse() });
});

module.exports = router;
