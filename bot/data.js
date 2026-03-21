// Levi 3 - Data Manager
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(filename, defaultValue) {
  ensureDataDir();
  const file = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return defaultValue;
}

function writeJSON(filename, data) {
  ensureDataDir();
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

// Default settings
const DEFAULT_SETTINGS = {
  real: {
    enabled: false,
    betSize: 2,
    maxSlots: 3,
    minLiquidity: 10000,
    maxAgeMins: 15,
    takeProfits: [
      { percent: 55, sellPercent: 50 },
      { percent: 100, sellPercent: 50 },
    ],
    stopLossPercent: 25,
    trailingStopPercent: 20,
  },
  paper: {
    enabled: true,
    balance: 100,
    betSize: 2,
    maxSlots: 3,
    minLiquidity: 10000,
    maxAgeMins: 15,
    takeProfits: [
      { percent: 55, sellPercent: 50 },
      { percent: 100, sellPercent: 50 },
    ],
    stopLossPercent: 25,
    trailingStopPercent: 20,
  }
};

function getSettings() {
  return readJSON('settings.json', DEFAULT_SETTINGS);
}

function saveSettings(settings) {
  writeJSON('settings.json', settings);
}

function getPositions() {
  return readJSON('positions.json', { real: {}, paper: {} });
}

function savePositions(positions) {
  writeJSON('positions.json', positions);
}

function getHistory() {
  return readJSON('history.json', []);
}

function addToHistory(trade) {
  const history = getHistory();
  history.unshift({ ...trade, closedAt: new Date().toISOString() });
  // Keep only last 7 days
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const filtered = history.filter(t => new Date(t.closedAt).getTime() > cutoff);
  writeJSON('history.json', filtered);
}

function getBalanceHistory() {
  return readJSON('balance_history.json', { real: [], paper: [] });
}

function addBalanceSnapshot(type, balance) {
  const history = getBalanceHistory();
  if (!history[type]) history[type] = [];
  history[type].push({ time: new Date().toISOString(), balance });
  // Keep last 7 days of snapshots (1 per minute = ~10080 points)
  if (history[type].length > 10080) history[type] = history[type].slice(-10080);
  writeJSON('balance_history.json', history);
}

module.exports = {
  getSettings, saveSettings,
  getPositions, savePositions,
  getHistory, addToHistory,
  getBalanceHistory, addBalanceSnapshot,
};