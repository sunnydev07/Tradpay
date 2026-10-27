const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { WebSocketServer } = require('ws');

const apiRouter = require('./routes/api');
const orderEngine = require('./engine/orderEngine');

const app = express();
const server = http.createServer(app);

// 1. Performance Middlewares
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

// 6. WebSocket Server on same HTTP port for real-time order dispatch
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  // Send welcome & current status
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    payload: {
      message: 'TradePay Realtime Dispatch Engine Connected',
      nightBonus: orderEngine.isNightBonusNow(),
      timestamp: Date.now()
    }
  }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// Broadcast function
function broadcastAll(data) {
  const json = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      client.send(json);
    }
  }
}

// Hook broadcaster into order engine
orderEngine.setBroadcaster(broadcastAll);

// Start background order dispatch simulator
orderEngine.startSimulation();

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
