// Levi 3 - Position Monitor
const { getTokenPrice, getSOLPrice } = require('./scanner');
const { buyToken, sellToken, getSOLBalance } = require('./trader');
const { getPositions, savePositions, getSettings, addToHistory, addBalanceSnapshot } = require('./data');

let broadcast = null; // WebSocket broadcast function

function setBroadcast(fn) { broadcast = fn; }

function notify(data) {
  if (broadcast) broadcast(data);
}

async function monitorPositions() {
  const positions = getPositions();
  const settings = getSettings();
  const solPrice = await getSOLPrice();

  // Monitor real positions
  for (const [mint, pos] of Object.entries(positions.real)) {
    try {
      await checkPosition(mint, pos, positions, settings.real, solPrice, false);
    } catch (e) {
      console.error(`Monitor error ${pos.symbol}: ${e.message}`);
    }
  }

  // Monitor paper positions
  for (const [mint, pos] of Object.entries(positions.paper)) {
    try {
      await checkPosition(mint, pos, positions, settings.paper, solPrice, true);
    } catch (e) {
      console.error(`Paper monitor error ${pos.symbol}: ${e.message}`);
    }
  }

  savePositions(positions);

  // Update balance snapshots
  const realBalance = await getSOLBalance();
  addBalanceSnapshot('real', realBalance * solPrice);
  addBalanceSnapshot('paper', settings.paper.balance);

  // Broadcast update
  notify({ type: 'positions_update', positions, solPrice });
}

async function checkPosition(mint, pos, positions, settings, solPrice, isPaper) {
  const currentPrice = await getTokenPrice(mint);
  if (!currentPrice || currentPrice <= 0) return;

  pos.currentPrice = currentPrice;
  const multiplier = currentPrice / pos.entryPrice;
  const pnlPercent = (multiplier - 1) * 100;

  // Update peak price
  if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;

  const dropFromPeak = ((pos.peakPrice - currentPrice) / pos.peakPrice) * 100;
  const dropFromEntry = ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

  // Take profit check
  const tpMultiplier = 1 + (settings.takeProfitPercent / 100);
  if (multiplier >= tpMultiplier && !pos.tpHit) {
    console.log(`🎯 TP hit for ${pos.symbol}: ${multiplier.toFixed(2)}x`);
    await closePosition(mint, pos, positions, settings, solPrice, isPaper, 'Take Profit', multiplier);
    return;
  }

  // Trailing stop (activates after 1.5x)
  if (pos.peakPrice >= pos.entryPrice * 1.5) {
    if (dropFromPeak >= settings.trailingStopPercent) {
      console.log(`📉 Trailing stop for ${pos.symbol}: dropped ${dropFromPeak.toFixed(1)}% from peak`);
      await closePosition(mint, pos, positions, settings, solPrice, isPaper, 'Trailing Stop', multiplier);
      return;
    }
  }

  // Hard stop loss
  if (dropFromEntry >= settings.stopLossPercent) {
    console.log(`🛑 Stop loss for ${pos.symbol}: -${dropFromEntry.toFixed(1)}%`);
    await closePosition(mint, pos, positions, settings, solPrice, isPaper, 'Stop Loss', multiplier);
    return;
  }
}

async function closePosition(mint, pos, positions, settings, solPrice, isPaper, reason, multiplier) {
  const pnl = pos.amountUSD * (multiplier - 1);
  const isWin = pnl > 0;

  if (isPaper) {
    settings.balance += pos.amountUSD * multiplier;
    delete positions.paper[mint];
  } else {
    const result = await sellToken(mint, 100);
    if (!result.success) {
      console.error(`Sell failed for ${pos.symbol}: ${result.error}`);
      return;
    }
    delete positions.real[mint];
  }

  const trade = {
    mintAddress: mint,
    symbol: pos.symbol,
    entryPrice: pos.entryPrice,
    exitPrice: pos.currentPrice,
    multiplier,
    pnlUSD: pnl,
    pnlPercent: (multiplier - 1) * 100,
    amountUSD: pos.amountUSD,
    reason,
    isPaper,
    openedAt: pos.openedAt,
    duration: Math.round((Date.now() - new Date(pos.openedAt)) / 1000 / 60),
  };

  addToHistory(trade);

  notify({
    type: 'position_closed',
    trade,
    message: `${isWin ? '🏆' : '🔴'} ${isPaper ? '[PAPER] ' : ''}${pos.symbol} closed — ${reason} | ${multiplier.toFixed(2)}x | ${isWin ? '+' : ''}$${pnl.toFixed(2)}`
  });

  console.log(`${isWin ? '✅' : '❌'} ${pos.symbol} closed: ${reason} | ${multiplier.toFixed(2)}x | P&L: $${pnl.toFixed(2)}`);
}

async function openPosition(coin, analysis, isPaper, solPrice) {
  const settings = getSettings();
  const modeSettings = isPaper ? settings.paper : settings.real;
  const positions = getPositions();
  const posStore = isPaper ? positions.paper : positions.real;

  // Check slots
  if (Object.keys(posStore).length >= modeSettings.maxSlots) {
    console.log(`⚠️ Slots full for ${isPaper ? 'paper' : 'real'} mode`);
    return false;
  }

  // Don't buy same coin twice
  if (posStore[coin.mintAddress]) return false;

  const amountUSD = modeSettings.betSize;

  if (isPaper) {
    if (modeSettings.balance < amountUSD) {
      console.log('⚠️ Insufficient paper balance');
      return false;
    }
    modeSettings.balance -= amountUSD;

    posStore[coin.mintAddress] = {
      symbol: coin.symbol,
      name: coin.name,
      entryPrice: coin.priceUSD,
      currentPrice: coin.priceUSD,
      peakPrice: coin.priceUSD,
      amountUSD,
      isPaper: true,
      openedAt: new Date().toISOString(),
      tpHit: false,
      score: analysis.score,
      url: coin.url,
    };

    const { saveSettings } = require('./data');
    saveSettings(settings);

    notify({
      type: 'position_opened',
      coin,
      isPaper: true,
      amountUSD,
      message: `📝 [PAPER] Opened $${coin.symbol} | Score: ${analysis.score}/10 | $${amountUSD}`
    });

  } else {
    const result = await buyToken(coin.mintAddress, amountUSD, solPrice);
    if (!result.success) {
      console.error(`Buy failed for ${coin.symbol}: ${result.error}`);
      return false;
    }

    posStore[coin.mintAddress] = {
      symbol: coin.symbol,
      name: coin.name,
      entryPrice: coin.priceUSD,
      currentPrice: coin.priceUSD,
      peakPrice: coin.priceUSD,
      amountUSD,
      isPaper: false,
      openedAt: new Date().toISOString(),
      tpHit: false,
      txid: result.txid,
      score: analysis.score,
      url: coin.url,
    };

    notify({
      type: 'position_opened',
      coin,
      isPaper: false,
      amountUSD,
      txid: result.txid,
      message: `🟢 Opened $${coin.symbol} | Score: ${analysis.score}/10 | $${amountUSD}`
    });
  }

  savePositions(positions);
  console.log(`${isPaper ? '📝' : '🟢'} Opened ${coin.symbol} | $${amountUSD} | Score: ${analysis.score}/10`);
  return true;
}

module.exports = { monitorPositions, openPosition, setBroadcast };
