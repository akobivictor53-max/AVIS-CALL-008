const { supabaseAdmin } = require('../supabaseClient');

async function getRate(action) {
  const { data, error } = await supabaseAdmin
    .from('credit_rates')
    .select('cost')
    .eq('action', action)
    .single();
  if (error) throw error;
  return Number(data.cost);
}

async function getBalance(userId) {
  const { data, error } = await supabaseAdmin
    .from('credit_balances')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.balance) : 0;
}

async function deduct(userId, amount, type, referenceId = null) {
  const { data, error } = await supabaseAdmin.rpc('apply_credit_change', {
    p_user_id: userId,
    p_amount: -Math.abs(amount),
    p_type: type,
    p_reference_id: referenceId,
  });
  if (error) {
    if (error.message?.includes('INSUFFICIENT_CREDITS')) {
      return { ok: false, error: 'INSUFFICIENT_CREDITS', balance: await getBalance(userId) };
    }
    throw error;
  }
  return { ok: true, balance: Number(data) };
}

async function credit(userId, amount, type, referenceId = null) {
  const { data, error } = await supabaseAdmin.rpc('apply_credit_change', {
    p_user_id: userId,
    p_amount: Math.abs(amount),
    p_type: type,
    p_reference_id: referenceId,
  });
  if (error) throw error;
  return Number(data);
}

module.exports = { getRate, getBalance, deduct, credit };
