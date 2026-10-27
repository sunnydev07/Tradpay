const http = require('http');
const path = require('path');
const express = require('express');
const compression = require('compression');
const { WebSocketServer } = require('ws');

const apiRouter = require('./routes/api');
const orderEngine = require('./engine/orderEngine');
const auth = require('./engine/auth');
const db = require('./engine/db');
const supabaseService = require('./engine/supabaseService');

if (!supabaseService.isConfigured()) {
  const message = '[Config] SUPABASE_URL and SUPABASE_KEY are required for authentication.';
  if (process.env.NODE_ENV === 'production') {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message} Login and registration will return 503 until they are set.`);
}

const app = express();
const server = http.createServer(app);

// 1. Performance & baseline hardening
app.disable('x-powered-by');
app.use(compression());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Same-origin CORS by default; add extra origins through CORS_ORIGINS.
const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch (e) {
      sameOrigin = false;
    }
    if (!sameOrigin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ code: 403, data: null, msg: 'Origin not allowed' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, token, x-tradepay-signature');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Capture the exact bytes for payment-webhook signature verification.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 2. Health check endpoint for Render single instance monitoring
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// 3. Static Assets (extracted APK assets: static, sounds, css)
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir, {
  maxAge: '1d',
  etag: true
}));

// 4. API Endpoints
app.use('/', apiRouter);
app.use('/api', apiRouter);

// 5. Fallback for Single Page Application
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// 6. WebSocket Server on same HTTP port for real-time order dispatch.
// Connections are unauthenticated until they send { type: 'AUTH', token }.
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Map();
const AUTH_TIMEOUT_MS = 10000;

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        ws.close(1008, 'Origin not allowed');
        return;
      }
    } catch (e) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
  }

  ws.isAlive = true;
  ws.authenticated = false;
  ws.authPending = false;

  const authTimer = setTimeout(() => {
    if (!ws.authenticated) ws.close(1008, 'Authentication timeout');
  }, AUTH_TIMEOUT_MS);
  authTimer.unref?.();

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }

    if (data.type === 'AUTH') {
      if (ws.authenticated || ws.authPending) return;
      ws.authPending = true;
      const user = await auth.authenticateToken(String(data.token || ''));
      ws.authPending = false;
      if (!user) {
        try {
          ws.send(JSON.stringify({ type: 'AUTH_FAILED', payload: { message: 'Invalid or expired session' } }));
        } catch (e) { /* ignore */ }
        ws.close(1008, 'Invalid token');
        return;
      }
      if (ws.readyState !== 1) return;
      ws.authenticated = true;
      ws.userId = String(user.id);
      clients.set(ws, { userId: ws.userId });
      clearTimeout(authTimer);
      ws.send(JSON.stringify({
        type: 'CONNECTED',
        payload: {
          message: 'TradePay Realtime Dispatch Engine Connected',
          nightBonus: orderEngine.isNightBonusNow(),
          timestamp: Date.now()
        }
      }));
      return;
    }

    if (!ws.authenticated) {
      ws.close(1008, 'Authentication required');
      return;
    }

    if (data.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    clients.delete(ws);
  });

  ws.on('error', () => {
    clearTimeout(authTimer);
    clients.delete(ws);
  });
});

// Broadcast only to authenticated clients; user-scoped events go to the owner.
function broadcastAll(data) {
  const json = JSON.stringify(data);
  const targetUserId = data && data.payload && data.payload.userId != null
    ? String(data.payload.userId)
    : null;

  for (const [client, meta] of clients) {
    if (client.readyState !== 1) continue;
    if (targetUserId && meta.userId !== targetUserId) continue;
    client.send(json);
  }
}

const heartbeat = setInterval(() => {
  for (const [client] of clients) {
    if (client.isAlive === false) {
      client.terminate();
      clients.delete(client);
      continue;
    }
    client.isAlive = false;
    try { client.ping(); } catch (e) { /* ignore */ }
  }
}, 30000);
heartbeat.unref?.();

wss.on('close', () => clearInterval(heartbeat));

// Hook broadcaster into order engine
orderEngine.setBroadcaster(broadcastAll);

// Start background order dispatch simulator
orderEngine.startSimulation();

// Flush debounced state before the process exits on deploys or Ctrl+C.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { db.flush(); } catch (e) { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 TradePay High-Speed Engine running on port ${PORT}`);
  console.log(`📡 WebSocket ready at ws://localhost:${PORT}/ws`);
  console.log(`🌐 Web App available at http://localhost:${PORT}`);
  console.log(`⚡ Render Health Check: http://localhost:${PORT}/health`);
  console.log(`=======================================================`);
});
