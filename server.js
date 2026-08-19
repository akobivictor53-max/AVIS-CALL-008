require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const roomsRouter = require('./routes/rooms');
const creditsRouter = require('./routes/credits');
const adminRouter = require('./routes/admin');
const iceRouter = require('./routes/ice');
const conversationsRouter = require('./routes/conversations');
const { attachSocketHandlers } = require('./socket');

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

app.use(helmet());
app.use(express.json());
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : '*',
  credentials: true,
}));

app.use('/api/', rateLimit({ windowMs: 60_000, max: 120 }));
app.use('/api/rooms/:slug/join', rateLimit({ windowMs: 60_000, max: 10 }));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/rooms', roomsRouter);
app.use('/api/credits', creditsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/ice-servers', iceRouter);
app.use('/api/conversations', conversationsRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const io = new Server(server, {
  cors: { origin: allowedOrigins.length ? allowedOrigins : '*', credentials: true },
});
attachSocketHandlers(io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`AVIS CALL backend listening on :${PORT}`));
