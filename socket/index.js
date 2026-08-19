const { supabaseAdmin } = require('../supabaseClient');
const { verifySocketToken } = require('../middleware/auth');
const credits = require('../services/creditsService');

const BILLING_TICK_MS = 10_000;
const LOW_BALANCE_WARNING_THRESHOLD = 5;

const onlineUsers = new Map();
const activeCalls = new Map();

function userSockets(io, userId) {
  return [...(onlineUsers.get(userId) || [])].map((id) => io.sockets.sockets.get(id)).filter(Boolean);
}

function emitToUser(io, userId, event, payload) {
  userSockets(io, userId).forEach((s) => s.emit(event, payload));
}

async function setPresence(userId, isOnline) {
  await supabaseAdmin.from('users').update({ is_online: isOnline, last_seen: new Date().toISOString() }).eq('id', userId);
}

function callRateAction(callType) {
  return {
    private_voice: 'private_voice_per_min',
    private_video: 'private_video_per_min',
    group_voice: 'group_voice_per_min',
    group_video: 'group_video_per_min',
  }[callType];
}

function callTxType(callType) {
  return { private_voice: 'voice_call', private_video: 'video_call', group_voice: 'group_voice', group_video: 'group_video' }[callType];
}

function startBilling(io, callId) {
  const call = activeCalls.get(callId);
  if (!call) return;

  call.billingTimer = setInterval(async () => {
    const rateAction = callRateAction(call.type);
    const perMinute = await credits.getRate(rateAction);
    const perTick = (perMinute / 60) * (BILLING_TICK_MS / 1000);
    const participants = [...call.participants];

    for (const userId of participants) {
      const result = await credits.deduct(userId, perTick, callTxType(call.type), callId);
      if (!result.ok) {
        emitToUser(io, userId, 'call:credits-exhausted', {
          callId,
          message: 'Your AVIS CALL credits have finished.',
        });
        await endCallForUser(io, callId, userId, 'credits_exhausted');
        continue;
      }
      if (result.balance <= LOW_BALANCE_WARNING_THRESHOLD) {
        emitToUser(io, userId, 'call:low-credit-warning', {
          callId,
          balance: result.balance,
          message: 'Your AVIS CALL credits are running low.',
        });
      }
      emitToUser(io, userId, 'call:credit-update', { callId, balance: result.balance });
    }

    if (call.participants.size === 0) {
      clearInterval(call.billingTimer);
      activeCalls.delete(callId);
      await supabaseAdmin.from('calls').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', callId);
    }
  }, BILLING_TICK_MS);
}

async function endCallForUser(io, callId, userId, reason = 'ended') {
  const call = activeCalls.get(callId);
  if (!call) return;
  call.participants.delete(userId);

  await supabaseAdmin
    .from('call_participants')
    .update({ left_at: new Date().toISOString() })
    .eq('call_id', callId).eq('user_id', userId);

  emitToUser(io, userId, 'call:ended', { callId, reason });

  for (const otherId of call.participants) {
    emitToUser(io, otherId, 'call:peer-left', { callId, userId });
  }

  if (call.participants.size === 0) {
    clearInterval(call.billingTimer);
    activeCalls.delete(callId);
    await supabaseAdmin.from('calls').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', callId);
  }
}

function attachSocketHandlers(io) {
  io.use(async (socket, next) => {
    const user = await verifySocketToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('Unauthorized'));
    socket.userId = user.id;
    next();
  });

  io.on('connection', async (socket) => {
    const userId = socket.userId;
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    await setPresence(userId, true);
    socket.broadcast.emit('presence:update', { userId, isOnline: true });

    socket.on('room:join', ({ roomId }) => socket.join(`room:${roomId}`));
    socket.on('room:leave', ({ roomId }) => socket.leave(`room:${roomId}`));

    socket.on('room:typing', ({ roomId, isTyping }) => {
      socket.to(`room:${roomId}`).emit('room:typing', { roomId, userId, isTyping });
    });

    socket.on('room:message', async ({ roomId, content, replyTo }, ack) => {
      try {
        const rate = await credits.getRate('chat_message');
        const result = await credits.deduct(userId, rate, 'chat', roomId);
        if (!result.ok) {
          return ack?.({ ok: false, error: 'Your AVIS CALL credits have finished.' });
        }
        const { data: msg, error } = await supabaseAdmin
          .from('room_messages')
          .insert({ room_id: roomId, sender_id: userId, content, reply_to: replyTo || null })
          .select('id, sender_id, content, reply_to, created_at')
          .single();
        if (error) return ack?.({ ok: false, error: error.message });

        io.to(`room:${roomId}`).emit('room:message', msg);
        ack?.({ ok: true, message: msg, balance: result.balance });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('dm:typing', ({ toUserId, isTyping }) => {
      emitToUser(io, toUserId, 'dm:typing', { fromUserId: userId, isTyping });
    });

    socket.on('dm:message', async ({ conversationId, toUserId, content, replyTo }, ack) => {
      try {
        const rate = await credits.getRate('chat_message');
        const result = await credits.deduct(userId, rate, 'chat', conversationId);
        if (!result.ok) return ack?.({ ok: false, error: 'Your AVIS CALL credits have finished.' });

        const { data: msg, error } = await supabaseAdmin
          .from('private_messages')
          .insert({ conversation_id: conversationId, sender_id: userId, content, reply_to: replyTo || null })
          .select('*').single();
        if (error) return ack?.({ ok: false, error: error.message });

        emitToUser(io, toUserId, 'dm:message', msg);
        ack?.({ ok: true, message: msg, balance: result.balance });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('call:invite', async ({ callId, type, roomId, toUserId, toUserIds }) => {
      const targets = toUserIds || [toUserId];
      const { data: call, error } = await supabaseAdmin
        .from('calls')
        .insert({ id: callId, type, room_id: roomId || null, initiator_id: userId, status: 'ringing' })
        .select().single();
      if (error) return socket.emit('call:error', { error: error.message });

      await supabaseAdmin.from('call_participants').insert({ call_id: call.id, user_id: userId });

      targets.filter(Boolean).forEach((t) =>
        emitToUser(io, t, 'call:incoming', { callId, type, fromUserId: userId, roomId })
      );
    });

    socket.on('call:accept', async ({ callId }) => {
      let call = activeCalls.get(callId);
      if (!call) {
        const { data } = await supabaseAdmin.from('calls').select('*').eq('id', callId).single();
        call = { type: data.type, participants: new Set(), roomId: data.room_id };
        activeCalls.set(callId, call);
        startBilling(io, callId);
        await supabaseAdmin.from('calls').update({ status: 'active' }).eq('id', callId);
      }
      call.participants.add(userId);
      await supabaseAdmin.from('call_participants').upsert({ call_id: callId, user_id: userId }, { onConflict: 'call_id,user_id' });
      io.to([...call.participants].map(String)).emit('call:peer-joined', { callId, userId });
      socket.emit('call:accepted', { callId, participants: [...call.participants] });
    });

    socket.on('call:decline', ({ callId, toUserId }) => {
      emitToUser(io, toUserId, 'call:declined', { callId, byUserId: userId });
    });

    socket.on('call:end', async ({ callId }) => {
      await endCallForUser(io, callId, userId, 'ended_by_user');
    });

    socket.on('call:signal', ({ callId, toUserId, signal }) => {
      emitToUser(io, toUserId, 'call:signal', { callId, fromUserId: userId, signal });
    });

    socket.on('user:block', async ({ blockedId }) => {
      await supabaseAdmin.from('blocked_users').upsert({ blocker_id: userId, blocked_id: blockedId });
    });

    socket.on('user:report', async ({ reportedId, reason, context }) => {
      await supabaseAdmin.from('reports').insert({ reporter_id: userId, reported_id: reportedId, reason, context });
    });

    socket.on('disconnect', async () => {
      onlineUsers.get(userId)?.delete(socket.id);
      if ((onlineUsers.get(userId)?.size || 0) === 0) {
        onlineUsers.delete(userId);
        await setPresence(userId, false);
        socket.broadcast.emit('presence:update', { userId, isOnline: false });

        for (const [callId, call] of activeCalls) {
          if (call.participants.has(userId)) await endCallForUser(io, callId, userId, 'disconnected');
        }
      }
    });
  });
}

module.exports = { attachSocketHandlers };
