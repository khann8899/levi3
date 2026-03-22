// Levi 3 - Position Monitor
const { getTokenPrice, getSOLPrice } = require('./scanner');
const { buyToken, sellToken, getSOLBalance } = require('./trader');
const { getPositions, savePositions, getSettings, saveSettings, addToHistory, addBalanceSnapshot } = require('./data');
let broadcast = null;

function setBroadcast(fn) { broadcast = fn; }

function notify(data) {
  if (broadcast) broadcast(data);
}

// Cache SOL price to avoid flickering
let cachedSOLPrice = 150;
let lastSOLPriceFetch = 0;

async function getStableSOLPrice() {
  const now = Date.now();
  // Only fetch every 60 seconds
  if (now - lastSOLPriceFetch > 60000) {
    try {
      const price = await getSOLPrice();
      if (price && price > 10 && price < 10000) {
        cachedSOLPrice = price;
        lastSOLPriceFetch = now;
      }
    } catch {}
  }
  return cachedSOLPrice;
}

async function monitorPositions() {
  const positions = getPositions();
  const settings = getSettings();
  const solPrice = await getStableSOLPrice();
  let settingsChanged = false;

  // Monitor real positions
  for (const [mint, pos] of Object.entries(positions.real)) {
    try {
      const changed = await checkPosition(mint, pos, positions, settings.real, solPrice, false, settings);
      if (changed) settingsChanged = true;
    } catch (e) {
      console.error(`Monitor error ${pos.symbol}: ${e.message}`);
    }
  }

  // Monitor paper positions
  for (const [mint, pos] of Object.entries(positions.paper)) {
    try {
      const changed = await checkPosition(mint, pos, positions, settings.paper, solPrice, true, settings);
      if (changed) settingsChanged = true;
    } catch (e) {
      console.error(`Paper monitor error ${pos.symbol}: ${e.message}`);
    }
  }

  savePositions(positions);
  if (settingsChanged) saveSettings(settings);

  // Update balance snapshots
  try {
    const solBalance = await getSOLBalance();
    addBalanceSnapshot('real', solBalance * solPrice);
  } catch {}
  addBalanceSnapshot('paper', settings.paper.balance);

  // Broadcast update
  notify({ type: 'positions_update', positions, solPrice });
}

async function checkPosition(mint, pos, positions, settings, solPrice, isPaper, allSettings) {
  const currentPrice = await getTokenPrice(mint);
  if (!currentPrice || currentPrice <= 0) return false;

  pos.currentPrice = currentPrice;
  const multiplier = currentPrice / pos.entryPrice;

  // Update peak price
  if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;

  const dropFromPeak = ((pos.peakPrice - currentPrice) / pos.peakPrice) * 100;
  const dropFromEntry = ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

  // Max hold time check
  const maxHoldMins = settings.maxHoldMins || 20;
  const holdMins = (Date.now() - new Date(pos.openedAt)) / 1000 / 60;
  if (holdMins >= maxHoldMins) {
    console.log(`⏰ Max hold time reached for ${pos.symbol} (${holdMins.toFixed(1)}m)`);
    if (isPaper) {
      await closePosition(mint, pos, positions, settings, solPrice, isPaper, `Expired (${maxHoldMins}m)`, multiplier, allSettings);
    } else {
      await closePosition(mint, pos, positions, settings, solPrice, isPaper, `Expired (${maxHoldMins}m)`, multiplier, allSettings);
    }
    return true;
  }

  // Multiple Take Profits
  const takeProfits = (settings.takeProfits && settings.takeProfits.length > 0)
    ? settings.takeProfits
    : [{ percent: settings.takeProfitPercent || 55, sellPercent: 100 }];
  const tpIndex = pos.tpIndex || 0;

  console.log(`📊 ${pos.symbol}: ${(multiplier*100-100).toFixed(1)}% | TP${tpIndex+1} at ${takeProfits[tpIndex]?.percent}% | Peak: ${((pos.peakPrice/pos.entryPrice-1)*100).toFixed(1)}%`);

  if (tpIndex < takeProfits.length) {
    const nextTP = takeProfits[tpIndex];
    const tpMultiplier = 1 + (nextTP.percent / 100);
    if (multiplier >= tpMultiplier) {
      console.log(`🎯 TP${tpIndex + 1} hit for ${pos.symbol}: ${multiplier.toFixed(2)}x → sell ${nextTP.sellPercent}%`);
      await executeTakeProfit(mint, pos, positions, settings, solPrice, isPaper, multiplier, nextTP, tpIndex, allSettings);
      return true;
    }
  }

  // Trailing stop (activates after 1.5x)
  if (pos.peakPrice >= pos.entryPrice * 1.5) {
    if (dropFromPeak >= settings.trailingStopPercent) {
      console.log(`📉 Trailing stop for ${pos.symbol}: dropped ${dropFromPeak.toFixed(1)}% from peak`);
      await closePosition(mint, pos, positions, settings, solPrice, isPaper, 'Trailing Stop', multiplier, allSettings);
      return true;
    }
  }

  // Hard stop loss
  if (dropFromEntry >= settings.stopLossPercent) {
    console.log(`🛑 Stop loss for ${pos.symbol}: -${dropFromEntry.toFixed(1)}%`);
    await closePosition(mint, pos, positions, settings, solPrice, isPaper, 'Stop Loss', multiplier, allSettings);
    return true;
  }

  return false;
}

async function executeTakeProfit(mint, pos, positions, settings, solPrice, isPaper, multiplier, tp, tpIndex, allSettings) {
  const sellPercent = tp.sellPercent;
  const currentRemaining = pos.remainingPercent || 100;

  // Calculate value of the portion being sold
  const portionOriginalCost = pos.amountUSD * (currentRemaining / 100) * (sellPercent / 100);
  const portionValue = portionOriginalCost * multiplier;
  const pnl = portionValue - portionOriginalCost;

  // Update position
  pos.tpIndex = tpIndex + 1;
  pos.remainingPercent = currentRemaining * (1 - sellPercent / 100);

  if (isPaper) {
    allSettings.paper.balance = parseFloat((allSettings.paper.balance + portionValue).toFixed(2));
    console.log(`📝 Paper TP${tpIndex + 1}: sold ${sellPercent}% → +$${portionValue.toFixed(2)} | balance $${allSettings.paper.balance.toFixed(2)} | remaining: ${pos.remainingPercent.toFixed(1)}%`);
  }

  const takeProfits = settings.takeProfits || [];
  const allTPsHit = pos.tpIndex >= takeProfits.length;

  notify({
    type: 'position_closed',
    trade: { symbol: pos.symbol, multiplier, pnlUSD: pnl, isPaper, reason: `TP${tpIndex + 1} (+${tp.percent}%)` },
    message: `💰 ${isPaper ? '[PAPER] ' : ''}$${pos.symbol} TP${tpIndex + 1} | ${multiplier.toFixed(2)}x | sold ${sellPercent}% | +$${pnl.toFixed(2)} | ${pos.remainingPercent.toFixed(0)}% left`
  });

  if (allTPsHit) {
    // Close remaining position
    if (pos.remainingPercent > 1) {
      await closePosition(mint, pos, positions, settings, solPrice, isPaper, 'Final TP', multiplier, allSettings);
    } else {
      // Tiny remainder, just remove
      const posStore = isPaper ? positions.paper : positions.real;
      delete posStore[mint];
    }
  } else {
    // Save updated position with new tpIndex and remainingPercent
    const posStore = isPaper ? positions.paper : positions.real;
    posStore[mint] = pos;
    savePositions(positions); // Save immediately so next cycle picks up new tpIndex
  }
}

async function closePosition(mint, pos, positions, settings, solPrice, isPaper, reason, multiplier, allSettings) {
  // Only use remainingPercent of original bet for exit value calculation
  const remainingPercent = pos.remainingPercent || 100;
  const remainingCost = pos.amountUSD * (remainingPercent / 100);
  const exitValue = remainingCost * multiplier;
  const pnl = exitValue - remainingCost;
  const isWin = pnl > 0;

  if (isPaper) {
    allSettings.paper.balance = parseFloat((allSettings.paper.balance + exitValue).toFixed(2));
    delete positions.paper[mint];
    console.log(`📝 Paper closed (${reason}): +$${exitValue.toFixed(2)} → balance $${allSettings.paper.balance.toFixed(2)}`);
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
    message: `${isWin ? '🏆' : '🔴'} ${isPaper ? '[PAPER] ' : ''}$${pos.symbol} — ${reason} | ${multiplier.toFixed(2)}x | ${isWin ? '+' : ''}$${pnl.toFixed(2)}`
  });

  console.log(`${isWin ? '✅' : '❌'} ${pos.symbol} closed: ${reason} | ${multiplier.toFixed(2)}x | P&L: $${pnl.toFixed(2)}`);
}

async function openPosition(coin, analysis, isPaper, solPrice) {
  const settings = getSettings();
  const modeSettings = isPaper ? settings.paper : settings.real;
  const positions = getPositions();
  const posStore = isPaper ? positions.paper : positions.real;

  if (Object.keys(posStore).length >= modeSettings.maxSlots) {
    console.log(`⚠️ Slots full (${isPaper ? 'paper' : 'real'})`);
    return false;
  }

  if (posStore[coin.mintAddress]) return false;

  const amountUSD = modeSettings.betSize;

  if (isPaper) {
    if (modeSettings.balance < amountUSD) {
      console.log('⚠️ Insufficient paper balance');
      return false;
    }
    modeSettings.balance = parseFloat((modeSettings.balance - amountUSD).toFixed(2));
    saveSettings(settings);

    posStore[coin.mintAddress] = {
      symbol: coin.symbol,
      name: coin.name,
      entryPrice: coin.priceUSD || 0.000001,
      currentPrice: coin.priceUSD || 0.000001,
      peakPrice: coin.priceUSD || 0.000001,
      amountUSD,
      isPaper: true,
      openedAt: new Date().toISOString(),
      tpHit: false,
      score: analysis.score,
      url: coin.url,
    };

    notify({
      type: 'position_opened',
      coin, isPaper: true, amountUSD,
      message: `📝 [PAPER] Opened $${coin.symbol} | Score: ${analysis.score}/10 | $${amountUSD} | Balance: $${modeSettings.balance.toFixed(2)}`
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
      entryPrice: coin.priceUSD || 0.000001,
      currentPrice: coin.priceUSD || 0.000001,
      peakPrice: coin.priceUSD || 0.000001,
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
      coin, isPaper: false, amountUSD, txid: result.txid,
      message: `🟢 Opened $${coin.symbol} | Score: ${analysis.score}/10 | $${amountUSD}`
    });
  }

  savePositions(positions);
  console.log(`${isPaper ? '📝' : '🟢'} Opened ${coin.symbol} | $${amountUSD} | Score: ${analysis.score}/10`);
  return true;
}

module.exports = { monitorPositions, openPosition, setBroadcast };