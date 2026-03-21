// Levi 3 - Main Server
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const bot = require('./bot/index');
const { setBroadcast } = require('./bot/monitor');
const { getSettings, saveSettings, getPositions, getHistory, getBalanceHistory } = require('./bot/data');
const { getSOLBalance, getSOLPrice } = require('./bot/scanner');
const { getSOLBalance: getWalletBalance } = require('./bot/trader');

// Stable SOL price - multiple sources, cached 2 minutes
let cachedSOLPrice = null;
let lastSOLFetch = 0;

async function getStableSOLPrice() {
  const now = Date.now();
  if (cachedSOLPrice && now - lastSOLFetch < 120000) return cachedSOLPrice;

  const sources = [
    async () => {
      const r = await require('axios').get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 5000 });
      return r.data?.solana?.usd;
    },
    async () => {
      const r = await require('axios').get('https://price.jup.ag/v4/price?ids=SOL', { timeout: 5000 });
      return r.data?.data?.SOL?.price;
    },
    async () => {
      const r = await require('axios').get('https://api.dexscreener.com/latest/dex/pairs/solana/So11111111111111111111111111111111111111112', { timeout: 5000 });
      return parseFloat(r.data?.pairs?.[0]?.priceUsd);
    },
  ];

  for (const source of sources) {
    try {
      const price = await source();
      if (price && price > 10 && price < 10000) {
        cachedSOLPrice = price;
        lastSOLFetch = now;
        return price;
      }
    } catch {}
  }

  return cachedSOLPrice || 150;
}

// Pre-fetch price on startup
getStableSOLPrice().catch(() => {});
setInterval(() => getStableSOLPrice().catch(() => {}), 120000);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'levi3secret';
const WEB_USERNAME = process.env.WEB_USERNAME || 'admin';
const WEB_PASSWORD = process.env.WEB_PASSWORD || 'password';

// ==================== AUTH ====================

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== WEB_USERNAME || password !== WEB_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ==================== API ROUTES ====================

app.get('/api/status', authMiddleware, async (req, res) => {
  try {
    const settings = getSettings();
    const positions = getPositions();
    const solPrice = await getStableSOLPrice();

    let solBalance = 0;
    try {
      const { getWallet, getConnection } = require('./bot/trader');
      const wallet = getWallet();
      const connection = getConnection();
      if (wallet && connection) {
        const lamports = await connection.getBalance(wallet.publicKey);
        solBalance = lamports / 1e9;
      }
    } catch {}

    res.json({
      botActive: bot.isActive(),
      solBalance,
      solPrice,
      usdBalance: solBalance * solPrice,
      paperBalance: settings.paper.balance,
      realPositions: Object.keys(positions.real).length,
      paperPositions: Object.keys(positions.paper).length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', authMiddleware, (req, res) => {
  res.json(getSettings());
});

app.post('/api/settings', authMiddleware, (req, res) => {
  const current = getSettings();
  const updated = {
    real: { ...current.real, ...req.body.real },
    paper: { ...current.paper, ...req.body.paper },
  };
  saveSettings(updated);
  res.json({ success: true, settings: updated });
});

app.get('/api/positions', authMiddleware, async (req, res) => {
  const positions = getPositions();
  const { getTokenPrice } = require('./bot/scanner');

  // Enrich with current prices
  for (const [mint, pos] of Object.entries(positions.real)) {
    const price = await getTokenPrice(mint).catch(() => null);
    if (price) pos.currentPrice = price;
    pos.multiplier = pos.currentPrice / pos.entryPrice;
    pos.pnlPercent = (pos.multiplier - 1) * 100;
  }

  for (const [mint, pos] of Object.entries(positions.paper)) {
    const price = await getTokenPrice(mint).catch(() => null);
    if (price) pos.currentPrice = price;
    pos.multiplier = pos.currentPrice / pos.entryPrice;
    pos.pnlPercent = (pos.multiplier - 1) * 100;
  }

  res.json(positions);
});

app.get('/api/history', authMiddleware, (req, res) => {
  res.json(getHistory());
});

app.get('/api/balance-history', authMiddleware, (req, res) => {
  res.json(getBalanceHistory());
});

app.post('/api/bot/start', authMiddleware, (req, res) => {
  bot.start();
  res.json({ success: true, message: 'Bot started' });
});

app.post('/api/bot/stop', authMiddleware, (req, res) => {
  bot.stop();
  res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/paper/reset', authMiddleware, (req, res) => {
  const settings = getSettings();
  const amount = req.body.amount || 100;
  settings.paper.balance = amount;
  saveSettings(settings);

  const { getPositions, savePositions } = require('./bot/data');
  const positions = getPositions();
  positions.paper = {};
  savePositions(positions);

  res.json({ success: true, balance: amount });
});

// ==================== WEBSOCKET ====================

const clients = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    ws.close(1008, 'Unauthorized');
    return;
  }

  clients.add(ws);

  // Keepalive ping every 30 seconds
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);

  ws.on('pong', () => {}); // keep alive
  ws.on('close', () => {
    clients.delete(ws);
    clearInterval(pingInterval);
  });
  ws.on('error', () => {
    clients.delete(ws);
    clearInterval(pingInterval);
  });
});

// Broadcast to all connected clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

setBroadcast(broadcast);

// ==================== START ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Levi 3 server running on port ${PORT}`);
  bot.start();
});