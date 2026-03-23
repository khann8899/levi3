// Levi 3 - Main Bot Loop
const { fetchNewTokens, analyzeCoin, getSOLPrice } = require('./scanner');
const { init, getConnection } = require('./trader');
const { monitorPositions, openPosition } = require('./monitor');
const { getSettings } = require('./data');

let isRunning = false;
let scanInterval = null;
let monitorInterval = null;

async function scanAndTrade() {
  const settings = getSettings();
  const paperEnabled = settings.paper.enabled;
  const realEnabled = settings.real.enabled;
  if (!paperEnabled && !realEnabled) return;

  const maxAge = Math.max(
    realEnabled ? settings.real.maxAgeMins : 0,
    paperEnabled ? settings.paper.maxAgeMins : 0
  );

  try {
    const solPrice = await getSOLPrice();
    const coins = await fetchNewTokens(maxAge);
    const connection = getConnection();

    for (const coin of coins) {
      if (paperEnabled) {
        const analysis = await analyzeCoin(coin, settings.paper, connection);
        if (analysis.passes) {
          await openPosition(analysis.coin || coin, analysis, true, solPrice);
        }
      }
      if (realEnabled) {
        const analysis = await analyzeCoin(coin, settings.real, connection);
        if (analysis.passes) {
          await openPosition(analysis.coin || coin, analysis, false, solPrice);
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e) {
    console.error('Scan error:', e.message);
  }
}

function start() {
  if (isRunning) return;
  try {
    init();
    isRunning = true;
    scanInterval = setInterval(scanAndTrade, 30000);
    monitorInterval = setInterval(monitorPositions, 20000);
    scanAndTrade();
    monitorPositions();
    console.log('🚀 Levi 3 bot started!');
  } catch (e) {
    console.error('Bot start error:', e.message);
  }
}

function stop() {
  if (scanInterval) clearInterval(scanInterval);
  if (monitorInterval) clearInterval(monitorInterval);
  isRunning = false;
  console.log('⏹️ Bot stopped');
}

function isActive() { return isRunning; }

module.exports = { start, stop, isActive };