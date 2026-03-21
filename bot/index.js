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
  const realEnabled = settings.real.enabled;
  const paperEnabled = settings.paper.enabled;

  if (!realEnabled && !paperEnabled) return;

  const maxAge = Math.max(
    realEnabled ? settings.real.maxAgeMins : 0,
    paperEnabled ? settings.paper.maxAgeMins : 0
  );

  try {
    const solPrice = await getSOLPrice();
    const newTokens = await fetchNewTokens(maxAge);
    const connection = getConnection();

    for (const coin of newTokens) {
      // Check real mode
      if (realEnabled) {
        const analysis = await analyzeCoin(coin, settings.real, connection);
        if (analysis.passes) {
          await openPosition(coin, analysis, false, solPrice);
        }
      }

      // Check paper mode
      if (paperEnabled) {
        const analysis = await analyzeCoin(coin, settings.paper, connection);
        if (analysis.passes) {
          await openPosition(coin, analysis, true, solPrice);
        }
      }

      // Small delay between coins to avoid rate limiting
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

    // Scan every 30 seconds
    scanInterval = setInterval(scanAndTrade, 30000);

    // Monitor positions every 20 seconds
    monitorInterval = setInterval(monitorPositions, 20000);

    // Initial run
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
