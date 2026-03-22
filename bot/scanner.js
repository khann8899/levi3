// Levi 3 - Dip Buy Strategy Scanner
const axios = require('axios');
const WebSocket = require('ws');

// Coin lifecycle stores
let newCoinQueue = [];   // Just launched, waiting for stage 1
let watchlist = {};      // Passed stage 1, watching for pump+dip pattern
let wsConnected = false;
let pumpWs = null;

const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

// ==================== PUMPPORTAL WEBSOCKET ====================

function connectPumpWebSocket() {
  try {
    pumpWs = new WebSocket('wss://pumpportal.fun/api/data');

    pumpWs.on('open', () => {
      wsConnected = true;
      console.log('🔌 Connected to PumpPortal WebSocket');
      pumpWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    pumpWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.mint && msg.name) {
          const solPrice = 150;
          const bondingCurveSOL = msg.vSolInBondingCurve || 0;
          const totalSupply = msg.vTokensInBondingCurve || 1000000000;
          const liquidityUSD = bondingCurveSOL * solPrice;
          const bondingProgress = Math.min((bondingCurveSOL / 85) * 100, 100);

          const coin = {
            mintAddress: msg.mint,
            symbol: msg.symbol || msg.name?.slice(0, 10) || 'UNKNOWN',
            name: msg.name || 'Unknown',
            priceUSD: totalSupply > 0 ? (bondingCurveSOL * solPrice) / totalSupply : 0,
            liquidityUSD,
            bondingCurveSOL,
            bondingProgress,
            totalSupply,
            volumeH1: 0,
            txnsH1: 1,
            buysH1: 1,
            sellsH1: 0,
            ageMinutes: 0,
            launchTime: Date.now(),
            url: `https://pump.fun/${msg.mint}`,
            dexId: 'pump',
            isNewLaunch: true,
          };

          newCoinQueue.push(coin);
        }
      } catch {}
    });

    pumpWs.on('close', () => {
      wsConnected = false;
      console.log('🔌 PumpPortal WS disconnected, reconnecting...');
      setTimeout(connectPumpWebSocket, 5000);
    });

    pumpWs.on('error', () => {
      wsConnected = false;
      try { pumpWs.close(); } catch {}
    });

  } catch (e) {
    console.error('PumpPortal WS error:', e.message);
    setTimeout(connectPumpWebSocket, 10000);
  }
}

// ==================== DATA FETCHING ====================

async function fetchTokenDetails(mintAddress) {
  try {
    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { timeout: 8000 }
    );
    const pairs = response.data?.pairs?.filter(p => p.chainId === 'solana');
    if (!pairs?.length) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return {
      liquidityUSD: best.liquidity?.usd || 0,
      priceUSD: parseFloat(best.priceUsd) || 0,
      symbol: best.baseToken?.symbol,
      name: best.baseToken?.name,
      volumeH1: best.volume?.h1 || 0,
      txnsH1: (best.txns?.h1?.buys || 0) + (best.txns?.h1?.sells || 0),
      buysH1: best.txns?.h1?.buys || 0,
      sellsH1: best.txns?.h1?.sells || 0,
      priceChangeH1: best.priceChange?.h1 || 0,
      pairCreatedAt: best.pairCreatedAt,
      url: best.url,
    };
  } catch {
    return null;
  }
}

async function checkHoneypot(mintAddress) {
  try {
    const response = await axios.get(
      `https://api.honeypot.is/v2/IsHoneypot?address=${mintAddress}&chainID=solana`,
      { timeout: 5000 }
    );
    return {
      isHoneypot: response.data.honeypotResult?.isHoneypot || false,
      sellTax: response.data.simulationResult?.sellTax || 0,
    };
  } catch {
    return { isHoneypot: false, sellTax: 0 };
  }
}

async function checkMintAuthority(mintAddress, connection) {
  try {
    const { PublicKey } = require('@solana/web3.js');
    const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    const parsed = info?.value?.data?.parsed?.info;
    if (!parsed) return false;
    return parsed.mintAuthority !== null;
  } catch {
    return false;
  }
}

// ==================== STAGE 1: BASIC SAFETY CHECK ====================

async function runStage1Check(coin) {
  // Honeypot check
  const honeypot = await checkHoneypot(coin.mintAddress).catch(() => ({ isHoneypot: false, sellTax: 0 }));
  if (honeypot.isHoneypot) {
    console.log(`❌ ${coin.symbol} honeypot — skip`);
    return { pass: false };
  }
  if (honeypot.sellTax > 15) {
    console.log(`❌ ${coin.symbol} sell tax ${honeypot.sellTax}% — skip`);
    return { pass: false };
  }

  // Get initial price data from DexScreener
  const details = await fetchTokenDetails(coin.mintAddress);
  if (details) {
    if (details.liquidityUSD > 0) coin.liquidityUSD = details.liquidityUSD;
    if (details.priceUSD > 0) coin.priceUSD = details.priceUSD;
    if (details.symbol && details.symbol !== 'UNKNOWN') coin.symbol = details.symbol;
    if (details.name) coin.name = details.name;
    if (details.url) coin.url = details.url;
    coin.txnsH1 = details.txnsH1 || coin.txnsH1;
    coin.buysH1 = details.buysH1 || coin.buysH1;
    coin.sellsH1 = details.sellsH1 || coin.sellsH1;
  }

  // Need some minimum liquidity to even be worth watching
  if (coin.liquidityUSD < 2000) {
    return { pass: false };
  }

  console.log(`👀 ${coin.symbol} watching | liq:$${Math.round(coin.liquidityUSD)} | price:$${coin.priceUSD.toFixed(8)}`);

  return {
    pass: true,
    watchEntry: {
      coin: { ...coin },
      entryLiquidity: coin.liquidityUSD,
      peakPrice: coin.priceUSD,
      peakLiquidity: coin.liquidityUSD,
      dipPrice: null,
      dipLiquidity: null,
      state: 'watching_pump', // watching_pump → dip_detected → recovering → BUY
      lastChecked: Date.now(),
      addedAt: Date.now(),
    }
  };
}

// ==================== DIP WATCH: TRACK PRICE PATTERN ====================

async function updateWatchEntry(mint, watch) {
  const details = await fetchTokenDetails(mint);
  if (!details || details.priceUSD <= 0) return { action: 'wait' };

  const currentPrice = details.priceUSD;
  const currentLiq = details.liquidityUSD || watch.coin.liquidityUSD;

  // Update coin data
  if (details.symbol && details.symbol !== 'UNKNOWN') watch.coin.symbol = details.symbol;
  if (details.name) watch.coin.name = details.name;
  if (details.url) watch.coin.url = details.url;
  watch.coin.priceUSD = currentPrice;
  watch.coin.liquidityUSD = currentLiq;
  watch.coin.txnsH1 = details.txnsH1 || watch.coin.txnsH1;
  watch.coin.buysH1 = details.buysH1 || watch.coin.buysH1;
  watch.coin.sellsH1 = details.sellsH1 || watch.coin.sellsH1;
  watch.coin.volumeH1 = details.volumeH1 || watch.coin.volumeH1;
  watch.lastChecked = Date.now();

  // RUG CHECK — liquidity dropped 30%+ from peak → abandon
  const liqDropFromPeak = watch.peakLiquidity > 0
    ? ((watch.peakLiquidity - currentLiq) / watch.peakLiquidity) * 100
    : 0;

  if (liqDropFromPeak > 30 && currentLiq < watch.entryLiquidity * 0.7) {
    console.log(`🚨 ${watch.coin.symbol} RUG detected — liq dropped ${liqDropFromPeak.toFixed(0)}% — skip`);
    return { action: 'dump' };
  }

  // Update peak
  if (currentPrice > watch.peakPrice) {
    watch.peakPrice = currentPrice;
    watch.peakLiquidity = currentLiq;
  }

  const pumpFromBase = ((watch.peakPrice - watch.coin.priceUSD) / watch.coin.priceUSD) * 100;
  const dropFromPeak = ((watch.peakPrice - currentPrice) / watch.peakPrice) * 100;
  const initialPrice = watch.coin.priceUSD;
  const pumpFromStart = watch.coin.priceUSD > 0 ? ((watch.peakPrice - initialPrice) / initialPrice) * 100 : 0;

  if (watch.state === 'watching_pump') {
    // Wait for 30%+ pump from launch price
    const launchPrice = watch.entryLiquidity > 0 ? watch.coin.priceUSD : currentPrice;
    const pumpedEnough = watch.peakPrice > 0 && pumpFromStart >= 30;

    if (pumpedEnough) {
      watch.state = 'dip_watch';
      console.log(`📈 ${watch.coin.symbol} pumped ${pumpFromStart.toFixed(0)}% → now watching for dip`);
    }
    return { action: 'wait' };
  }

  if (watch.state === 'dip_watch') {
    // Wait for 10-20% dip from peak
    if (dropFromPeak >= 10 && dropFromPeak <= 35) {
      watch.state = 'dip_detected';
      watch.dipPrice = currentPrice;
      watch.dipLiquidity = currentLiq;
      watch.lowestDipPrice = currentPrice;
      console.log(`📉 ${watch.coin.symbol} dipped ${dropFromPeak.toFixed(0)}% from peak → watching for recovery`);
    } else if (dropFromPeak > 35) {
      console.log(`❌ ${watch.coin.symbol} dipped too hard ${dropFromPeak.toFixed(0)}% — skip`);
      return { action: 'dump' };
    }
    return { action: 'wait' };
  }

  if (watch.state === 'dip_detected') {
    // Track lowest point of dip
    if (currentPrice < watch.lowestDipPrice) {
      watch.lowestDipPrice = currentPrice;
      watch.dipLiquidity = currentLiq;
    }

    // Check for recovery — price needs to recover 5%+ from lowest point
    const recoveryFromLow = watch.lowestDipPrice > 0
      ? ((currentPrice - watch.lowestDipPrice) / watch.lowestDipPrice) * 100
      : 0;

    // Make sure liquidity is still healthy during recovery
    const liqHealthy = liqDropFromPeak < 25;
    const txnsActive = (watch.coin.txnsH1 || 0) >= 10;
    const buyRatio = watch.coin.txnsH1 > 0 ? watch.coin.buysH1 / watch.coin.txnsH1 : 0;

    console.log(`🔄 ${watch.coin.symbol} recovery: ${recoveryFromLow.toFixed(1)}% | liq ok:${liqHealthy} | txns:${watch.coin.txnsH1} | buyratio:${(buyRatio*100).toFixed(0)}%`);

    if (recoveryFromLow >= 5 && liqHealthy && txnsActive) {
      console.log(`✅ ${watch.coin.symbol} DIP BUY SIGNAL! pump:${pumpFromStart.toFixed(0)}% dip:${dropFromPeak.toFixed(0)}% recovery:${recoveryFromLow.toFixed(1)}%`);
      return { action: 'buy', coin: watch.coin };
    }

    // If dip goes deeper than 35%, abandon
    if (dropFromPeak > 35) {
      console.log(`❌ ${watch.coin.symbol} dip too deep ${dropFromPeak.toFixed(0)}% — skip`);
      return { action: 'dump' };
    }

    return { action: 'wait' };
  }

  return { action: 'wait' };
}

// ==================== MAIN FETCH ====================

async function fetchNewTokens(maxAgeMins) {
  const now = Date.now();
  const coinsReadyToBuy = [];

  // Update ages, remove expired
  newCoinQueue = newCoinQueue.filter(c => {
    c.ageMinutes = (now - c.launchTime) / 1000 / 60;
    return c.ageMinutes <= maxAgeMins;
  });

  // Stage 1: Process new coins that are 30+ seconds old
  const readyForStage1 = newCoinQueue.filter(c => c.ageMinutes >= 0.5 && !watchlist[c.mintAddress]);
  newCoinQueue = newCoinQueue.filter(c => c.ageMinutes < 0.5 || watchlist[c.mintAddress]);

  for (const coin of readyForStage1) {
    if (watchlist[coin.mintAddress]) continue;
    const result = await runStage1Check(coin);
    if (result.pass) {
      watchlist[coin.mintAddress] = result.watchEntry;
    }
  }

  // Remove expired watchlist entries
  for (const [mint, watch] of Object.entries(watchlist)) {
    const ageMins = (now - watch.addedAt) / 1000 / 60;
    if (ageMins > maxAgeMins) {
      console.log(`⏰ ${watch.coin.symbol} expired from watchlist (${ageMins.toFixed(0)}m)`);
      delete watchlist[mint];
    }
  }

  // Update all watchlist entries and check for buy signals
  const watchEntries = Object.entries(watchlist);
  for (const [mint, watch] of watchEntries) {
    // Only check every 10 seconds per coin
    if (now - watch.lastChecked < 10000) continue;

    const result = await updateWatchEntry(mint, watch);

    if (result.action === 'buy') {
      coinsReadyToBuy.push({ ...result.coin, readyForBuy: true });
      delete watchlist[mint];
    } else if (result.action === 'dump') {
      delete watchlist[mint];
    }

    // Small delay between checks
    await new Promise(r => setTimeout(r, 300));
  }

  if (watchEntries.length > 0 || coinsReadyToBuy.length > 0) {
    console.log(`👁️ watching:${Object.keys(watchlist).length} | 🛒 ready:${coinsReadyToBuy.length} | 🆕 queue:${newCoinQueue.length} | 🔌 WS:${wsConnected ? 'on' : 'off'}`);
  }

  return coinsReadyToBuy;
}

// ==================== ANALYZE (for buy-ready coins) ====================

async function analyzeCoin(coin, settings, connection) {
  // Coins from dip strategy are already vetted
  if (coin.readyForBuy) {
    const minScore = settings.minScore || 6;
    const hasMintAuth = connection
      ? await checkMintAuthority(coin.mintAddress, connection).catch(() => false)
      : false;

    if (hasMintAuth) {
      console.log(`⚠️ ${coin.symbol} has mint authority — skip`);
      return { passes: false, reason: 'Mint authority' };
    }

    // Score based on available data
    let score = 6; // Base score — already passed dip strategy
    if (coin.liquidityUSD > 20000) score += 1;
    if (coin.liquidityUSD > 50000) score += 1;
    if ((coin.txnsH1 || 0) > 50) score += 1;
    const buyRatio = coin.txnsH1 > 0 ? coin.buysH1 / coin.txnsH1 : 0.5;
    if (buyRatio > 0.65) score += 1;
    score = Math.min(10, score);

    console.log(`🛒 ${coin.symbol} DIP BUY | score:${score}/10 | liq:$${Math.round(coin.liquidityUSD)} | txns:${coin.txnsH1}`);

    return {
      passes: score >= minScore,
      score,
      hasMintAuth,
      coin,
      reason: 'Dip buy signal ✅',
    };
  }

  // Fallback for any non-dip coins (shouldn't happen often)
  return { passes: false, reason: 'Not a dip buy signal' };
}

// ==================== PRICE / SOL ====================

async function getTokenPrice(mintAddress) {
  try {
    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { timeout: 5000 }
    );
    const pairs = response.data?.pairs?.filter(p => p.chainId === 'solana');
    if (!pairs?.length) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return parseFloat(best.priceUsd) || null;
  } catch {
    return null;
  }
}

async function getSOLPrice() {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 5000 }
    );
    return response.data?.solana?.usd || 150;
  } catch {
    return 150;
  }
}

// Start WebSocket
connectPumpWebSocket();

module.exports = { fetchNewTokens, analyzeCoin, getTokenPrice, getSOLPrice };