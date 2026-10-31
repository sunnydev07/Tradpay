const http = require('http');
const path = require('path');

// Load local .env values without overriding Render or shell variables.
require('./engine/env').loadLocalEnv();

const adminAuth = require('./engine/adminAuth');
const stateStore = require('./engine/stateStore');

// Production balances and ledger entries must live somewhere durable. A local
// file is only durable on a mounted disk; the Supabase state backend keeps the
// server-authoritative snapshot in a service-role-only table and is the free
// Render option.
const configuredDbFile = String(process.env.TRADEPAY_DB_FILE || '').trim();
const stateBackend = String(process.env.TRADEPAY_STATE_BACKEND || '').trim().toLowerCase();
const stateConfigError = stateStore.getConfigError();
const supabaseStateEnabled = stateBackend === 'supabase' && !stateConfigError;

if (stateConfigError) {
  // A half-configured remote backend must never fall back to local-only
  // storage, because the next restart would silently lose the ledger.
  console.error(`[Config] ${stateConfigError}`);
  process.exit(1);
}

if (
  process.env.NODE_ENV === 'production' &&
  !supabaseStateEnabled &&
  !path.isAbsolute(configuredDbFile) &&
  process.env.ALLOW_EPHEMERAL_STORAGE !== 'true'
) {
  console.error(
    '[Config] Durable state is not configured. Set TRADEPAY_STATE_BACKEND=supabase with ' +
    'SUPABASE_SERVICE_ROLE_KEY for free Render hosting, or set TRADEPAY_DB_FILE to an ' +
    'absolute path on a mounted disk. Set ALLOW_EPHEMERAL_STORAGE=true only for disposable previews.'
  );
  process.exit(1);
}

// Admin access must never fall back to a hardcoded secret. A missing, short,
// or placeholder ADMIN_KEY disables admin routes in development and refuses to
// start in production, where an exposed key lets anyone mint balances or
// approve withdrawals.
const adminConfig = adminAuth.validateConfiguredKey();
if (!adminConfig.ok) {
  const message = `[Config] ${adminConfig.reason}. Set ADMIN_KEY to a unique random secret (for example, generate one with "openssl rand -hex 32").`;
  if (process.env.NODE_ENV === 'production') {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message} Admin endpoints are disabled.`);
}

const express = require('express');
const compression = require('compression');
const { WebSocketServer } = require('ws');

const apiRouter = require('./routes/api');
const orderEngine = require('./engine/orderEngine');
const paymentEngine = require('./engine/paymentEngine');
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, token, x-tradepay-signature, x-admin-key, x-admin-session');
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
  const storage = db.getStorageInfo();
  res.status(200).json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    storage: {
      backend: storage.backend,
      table: storage.table,
      durable: storage.durable,
      ok: !storage.lastSaveError,
      initialized: storage.initialized,
      revision: storage.revision,
      lastSavedAt: storage.lastSavedAt
    }
  });
});

// 3. Static Assets (extracted APK assets: static, sounds, css)
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir, {
  maxAge: '1d',
  etag: true,
  setHeaders: (res, filePath) => {
    // Never cache the app shell or the service worker: they must always be
    // revalidated so UI removals take effect immediately on next load.
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// 4. API Endpoints
app.use('/', apiRouter);
app.use('/api', apiRouter);

// 5. Admin Verification Console & Fallback for Single Page Application
app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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
    let allowed = false;
    try {
      allowed = new URL(origin).host === req.headers.host || allowedOrigins.includes(origin);
    } catch (e) {
      allowed = false;
    }
    if (!allowed) {
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
      try {
        ws.send(JSON.stringify({
          type: 'CONNECTED',
          payload: {
            message: 'TradePay Realtime Dispatch Engine Connected',
            nightBonus: orderEngine.isNightBonusNow(),
            timestamp: Date.now()
          }
        }));
      } catch (e) { /* ignore */ }
      return;
    }

    if (!ws.authenticated) {
      ws.close(1008, 'Authentication required');
      return;
    }

    if (data.type === 'PING') {
      try {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      } catch (e) { /* ignore */ }
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
    try {
      client.send(json);
    } catch (e) {
      console.warn('[WS] broadcast send error:', e.message);
    }
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
paymentEngine.setBroadcaster(broadcastAll);

// Flush debounced state before the process exits on deploys or Ctrl+C.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { db.flush(); } catch (e) { /* ignore */ }
  try {
    await db.flushRemote();
  } catch (err) {
    console.error('[DB] Final remote state save failed:', err.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 15000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start Server helper
const PORT = process.env.PORT || 3000;

async function startServer(port = PORT) {
  // Load the authoritative snapshot before accepting requests. If the remote
  // backend is configured but unavailable, fail closed instead of starting
  // with an empty/default ledger.
  const storage = await db.init();
  orderEngine.startSimulation();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      console.log(`=======================================================`);
      console.log(`🚀 TradePay High-Speed Engine running on port ${port}`);
      console.log(`📡 WebSocket ready at ws://localhost:${port}/ws`);
      console.log(`🌐 Web App available at http://localhost:${port}`);
      console.log(`⚡ Render Health Check: http://localhost:${port}/health`);
      console.log(
        `💾 State storage: ${storage.backend}${storage.durable ? ' (durable)' : ' (ephemeral)'}` +
        `${storage.table ? ` table=${storage.table}` : ` path=${storage.path}`}` +
        ` revision=${storage.revision}`
      );
      console.log(`=======================================================`);
      resolve(server);
    });
  });
}

// Only bind the port if this script is run directly from the command line.
// When required by tests or external runners, export the handles safely.
if (require.main === module) {
  startServer().catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] Port ${PORT} is already in use.`);
    } else {
      console.error('[Server] Startup error:', err);
    }
    process.exit(1);
  });
}

module.exports = { app, server, wss, broadcastAll, startServer };
