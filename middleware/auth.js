const { supabaseAdmin } = require('../supabaseClient');

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing auth token' });

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired token' });

    req.user = data.user;
    req.token = token;
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(500).json({ error: 'Auth check failed' });
  }
}

async function requireAdmin(req, res, next) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('is_admin')
    .eq('id', req.user.id)
    .single();
  if (error || !data?.is_admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

async function verifySocketToken(token) {
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

module.exports = { requireAuth, requireAdmin, verifySocketToken };
