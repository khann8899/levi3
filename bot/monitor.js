// Levi 3 - Position Monitor
const { getTokenPrice, getSOLPrice } = require('./scanner');
const { buyToken, sellToken, getSOLBalance } = require('./trader');
const { getPositions, savePositions, getSettings, saveSettings, addToHistory, addBalanceSnapshot } = require('./data');

let broadcast = null;
function setBroadcast(fn) { broadcast = fn; }
function notify(data) { if (broadcast) broadcast(data); }

// Stable SOL price cache
let cachedSOLPrice = 150;
let lastSOLPriceFetch = 0;

async function getStableSOLPrice() {
  const now = Date.now();
  if (now - lastSOLPriceFetch > 120000) {
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

// ==================== MONITOR LOOP ====================

async function monitorPositions() {
  const positions = getPositions();
  const settings = getSettings();
  const solPrice = await getStableSOLPrice();
  let settingsChanged = false;

  for (const [mint, pos] of Object.entries(positions.real)) {
    try {
      const changed = await checkPosition(mint, pos, positions, settings.real, solPrice, false, settings);
      if (changed) settingsChanged = true;
    } catch (e) {
      console.error(`Monitor error ${pos.symbol}: ${e.message}`);
    }
  }

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

  try {
    const solBal = await getSOLBalance();
    addBalanceSnapshot('real', solBal * solPrice);
  } catch {}
  addBalanceSnapshot('paper', settings.paper.balance);

  notify({ type: 'positions_update', positions, solPrice });
}

// ==================== POSITION CHECK ====================

async function checkPosition(mint, pos, positions, settings, solPrice, isPaper, allSettings) {
  const currentPrice = await getTokenPrice(mint);
  if (!currentPrice || currentPrice <= 0) return false;

  // Safety: if entry price is invalid, close position
  if (!pos.entryPrice || pos.entryPrice <= 0) {
    console.log(`⚠️ ${pos.symbol} invalid entry price — closing`);
    await closePosition(mint, pos, positions, settings, solPrice, isPaper, 'Invalid entry', 1, allSettings);
    return true;
  }

  pos.currentPrice = currentPrice;
  const multiplier = currentPrice / pos.entryPrice;
  if (!pos.peakPrice || pos.peakPrice <= 0) pos.peakPrice = pos.entryPrice;
  if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;

  const dropFromPeak = ((pos.peakPrice - currentPrice) / pos.peakPrice) * 100;
  const dropFromEntry = ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

  // Max hold time
  const maxHoldMins = settings.maxHoldMins || 30;
  const holdMins = (Date.now() - new Date(pos.openedAt)) / 1000 / 60;
  if (holdMins >= maxHoldMins) {
    console.log(`⏰ ${pos.symbol} expired (${holdMins.toFixed(0)}m) at ${(multiplier*100-100).toFixed(1)}%`);
    await closePosition(mint, pos, positions, settings, solPrice, isPaper, `Expired (${maxHoldMins}m)`, multiplier, allSettings);
    return true;
  }

  // Take profits
  const takeProfits = (settings.takeProfits && settings.takeProfits.length > 0)
    ? settings.takeProfits
    : [{ percent: settings.takeProfitPercent || 25, sellPercent: 100 }];
  const tpIndex = pos.tpIndex || 0;

  console.log(`📊 ${pos.symbol}: ${(multiplier*100-100).toFixed(1)}% | TP${tpIndex+1} at ${takeProfits[tpIndex]?.percent}% | hold:${holdMins.toFixed(0)}m`);

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
      console.log(`📉 Trailing stop ${pos.symbol}: dropped ${dropFromPeak.toFixed(1)}% from peak`);
      await closePosition(mint, pos, positions, settings, solPrice, isPaper, 'Trailing Stop', multiplier, allSettings);
      return true;
    }
  }

  // Hard stop loss
  if (dropFromEntry >= settings.stopLossPercent) {
    console.log(`🛑 Stop loss ${pos.symbol}: -${dropFromEntry.toFixed(1)}%`);
    await closePosition(mint, pos, positions, settings, solPrice, isPaper, 'Stop Loss', multiplier, allSettings);
    return true;
  }

  return false;
}

// ==================== TAKE PROFIT ====================

async function executeTakeProfit(mint, pos, positions, settings, solPrice, isPaper, multiplier, tp, tpIndex, allSettings) {
  const sellPercent = tp.sellPercent;
  const currentRemaining = pos.remainingPercent || 100;
  const portionOriginalCost = pos.amountUSD * (currentRemaining / 100) * (sellPercent / 100);
  const portionValue = portionOriginalCost * multiplier;
  const pnl = portionValue - portionOriginalCost;

  pos.tpIndex = tpIndex + 1;
  pos.remainingPercent = currentRemaining * (1 - sellPercent / 100);

  if (isPaper) {
    allSettings.paper.balance = parseFloat((allSettings.paper.balance + portionValue).toFixed(2));
    console.log(`📝 Paper TP${tpIndex + 1}: +$${portionValue.toFixed(2)} | balance: $${allSettings.paper.balance.toFixed(2)} | remaining: ${pos.remainingPercent.toFixed(1)}%`);
  }

  const takeProfits = settings.takeProfits || [];
  const allTPsHit = pos.tpIndex >= takeProfits.length;

  // Record partial TP in history
  addToHistory({
    mintAddress: mint,
    symbol: pos.symbol,
    entryPrice: pos.entryPrice,
    exitPrice: pos.currentPrice,
    multiplier,
    pnlUSD: pnl,
    pnlPercent: (multiplier - 1) * 100,
    amountUSD: portionOriginalCost,
    reason: `TP${tpIndex + 1} (+${tp.percent}%)`,
    isPaper,
    openedAt: pos.openedAt,
    duration: Math.round((Date.now() - new Date(pos.openedAt)) / 1000 / 60),
  });

  notify({
    type: 'position_closed',
    trade: { symbol: pos.symbol, multiplier, pnlUSD: pnl, isPaper, reason: `TP${tpIndex + 1}` },
    message: `💰 ${isPaper ? '[PAPER] ' : ''}$${pos.symbol} TP${tpIndex + 1} | ${multiplier.toFixed(2)}x | +$${pnl.toFixed(2)} | ${pos.remainingPercent.toFixed(0)}% left`
  });

  if (allTPsHit) {
    if (pos.remainingPercent > 1) {
      await closePosition(mint, pos, positions, settings, solPrice, isPaper, 'Final TP', multiplier, allSettings);
    } else {
      const posStore = isPaper ? positions.paper : positions.real;
      delete posStore[mint];
    }
  } else {
    const posStore = isPaper ? positions.paper : positions.real;
    posStore[mint] = pos;
    savePositions(positions);
  }
}

// ==================== CLOSE POSITION ====================

async function closePosition(mint, pos, positions, settings, solPrice, isPaper, reason, multiplier, allSettings) {
  const remainingPercent = pos.remainingPercent || 100;
  const remainingCost = pos.amountUSD * (remainingPercent / 100);
  const exitValue = remainingCost * multiplier;
  const pnl = exitValue - remainingCost;
  const isWin = pnl > 0;

  if (isPaper) {
    allSettings.paper.balance = parseFloat((allSettings.paper.balance + exitValue).toFixed(2));
    delete positions.paper[mint];
    console.log(`📝 Paper closed (${reason}): ${multiplier.toFixed(2)}x | ${isWin ? '+' : ''}$${pnl.toFixed(2)} | balance: $${allSettings.paper.balance.toFixed(2)}`);
  } else {
    const result = await sellToken(mint, 100);
    if (!result.success) {
      console.error(`Sell failed ${pos.symbol}: ${result.error}`);
      return;
    }
    delete positions.real[mint];
  }

  addToHistory({
    mintAddress: mint,
    symbol: pos.symbol,
    entryPrice: pos.entryPrice,
    exitPrice: pos.currentPrice,
    multiplier,
    pnlUSD: pnl,
    pnlPercent: (multiplier - 1) * 100,
    amountUSD: remainingCost,
    reason,
    isPaper,
    openedAt: pos.openedAt,
    duration: Math.round((Date.now() - new Date(pos.openedAt)) / 1000 / 60),
  });

  notify({
    type: 'position_closed',
    trade: { symbol: pos.symbol, multiplier, pnlUSD: pnl, isPaper, reason },
    message: `${isWin ? '🏆' : '🔴'} ${isPaper ? '[PAPER] ' : ''}$${pos.symbol} — ${reason} | ${multiplier.toFixed(2)}x | ${isWin ? '+' : ''}$${pnl.toFixed(2)}`
  });
}

// ==================== OPEN POSITION ====================

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

  // CRITICAL: Must have a real, valid entry price
  if (!coin.priceUSD || coin.priceUSD <= 0) {
    console.log(`⚠️ ${coin.symbol} has no price — refusing to open`);
    return false;
  }

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
      entryPrice: coin.priceUSD,
      currentPrice: coin.priceUSD,
      peakPrice: coin.priceUSD,
      remainingPercent: 100,
      tpIndex: 0,
      amountUSD,
      isPaper: true,
      openedAt: new Date().toISOString(),
      score: analysis.score,
      url: coin.url,
    };

    notify({
      type: 'position_opened',
      coin, isPaper: true, amountUSD,
      message: `📝 [PAPER] $${coin.symbol} opened | $${amountUSD} @ $${coin.priceUSD} | balance: $${modeSettings.balance.toFixed(2)}`
    });

  } else {
    const result = await buyToken(coin.mintAddress, amountUSD, solPrice);
    if (!result.success) {
      console.error(`Buy failed ${coin.symbol}: ${result.error}`);
      return false;
    }

    posStore[coin.mintAddress] = {
      symbol: coin.symbol,
      name: coin.name,
      entryPrice: coin.priceUSD,
      currentPrice: coin.priceUSD,
      peakPrice: coin.priceUSD,
      remainingPercent: 100,
      tpIndex: 0,
      amountUSD,
      isPaper: false,
      openedAt: new Date().toISOString(),
      txid: result.txid,
      score: analysis.score,
      url: coin.url,
    };

    notify({
      type: 'position_opened',
      coin, isPaper: false, amountUSD, txid: result.txid,
      message: `🟢 $${coin.symbol} opened | $${amountUSD} @ $${coin.priceUSD}`
    });
  }

  savePositions(positions);
  console.log(`${isPaper ? '📝' : '🟢'} Opened ${coin.symbol} @ $${coin.priceUSD} | $${amountUSD} | Score: ${analysis.score}/10`);
  return true;
}

module.exports = { monitorPositions, openPosition, setBroadcast, getStableSOLPrice };