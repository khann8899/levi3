// Levi 3 - Dip Buy Strategy Scanner
const axios = require('axios');
const WebSocket = require('ws');

let newCoinQueue = [];
let watchlist = {};
let wsConnected = false;
let pumpWs = null;

const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

// ==================== WEBSOCKET ====================

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

          newCoinQueue.push({
            mintAddress: msg.mint,
            symbol: msg.symbol || msg.name?.slice(0, 10) || 'UNKNOWN',
            name: msg.name || 'Unknown',
            priceUSD: totalSupply > 0 ? (bondingCurveSOL * solPrice) / totalSupply : 0,
            liquidityUSD,
            bondingCurveSOL,
            bondingProgress,
            totalSupply,
            txnsH1: 1, buysH1: 1, sellsH1: 0, volumeH1: 0,
            ageMinutes: 0,
            launchTime: Date.now(),
            url: `https://pump.fun/${msg.mint}`,
            dexId: 'pump',
            isNewLaunch: true,
          });
        }
      } catch {}
    });

    pumpWs.on('close', () => {
      wsConnected = false;
      console.log('🔌 WS disconnected, reconnecting...');
      setTimeout(connectPumpWebSocket, 5000);
    });

    pumpWs.on('error', () => {
      wsConnected = false;
      try { pumpWs.close(); } catch {}
    });

  } catch (e) {
    console.error('WS error:', e.message);
    setTimeout(connectPumpWebSocket, 10000);
  }
}

// ==================== DATA ====================

async function fetchTokenDetails(mintAddress) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { timeout: 8000 }
    );
    const pairs = res.data?.pairs?.filter(p => p.chainId === 'solana');
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
      url: best.url,
    };
  } catch {
    return null;
  }
}

async function checkHoneypot(mintAddress) {
  try {
    const res = await axios.get(
      `https://api.honeypot.is/v2/IsHoneypot?address=${mintAddress}&chainID=solana`,
      { timeout: 5000 }
    );
    return {
      isHoneypot: res.data.honeypotResult?.isHoneypot || false,
      sellTax: res.data.simulationResult?.sellTax || 0,
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
    return parsed ? parsed.mintAuthority !== null : false;
  } catch {
    return false;
  }
}

// ==================== STAGE 1: SAFETY CHECK ====================

async function runStage1Check(coin) {
  const honeypot = await checkHoneypot(coin.mintAddress).catch(() => ({ isHoneypot: false, sellTax: 0 }));
  if (honeypot.isHoneypot || honeypot.sellTax > 15) return { pass: false };

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
    coin.volumeH1 = details.volumeH1 || coin.volumeH1;
  }

  if (coin.liquidityUSD < 2000) return { pass: false };

  console.log(`👀 ${coin.symbol} | liq:$${Math.round(coin.liquidityUSD)} | price:$${(coin.priceUSD || 0).toFixed(8)}`);

  return {
    pass: true,
    watchEntry: {
      coin: { ...coin },
      entryLiquidity: coin.liquidityUSD,
      peakPrice: coin.priceUSD || 0,
      peakLiquidity: coin.liquidityUSD,
      lowestDipPrice: null,
      dipLiquidity: null,
      state: 'watching_pump',
      lastChecked: Date.now(),
      addedAt: Date.now(),
    }
  };
}

// ==================== DIP WATCH ====================

async function updateWatchEntry(mint, watch) {
  const details = await fetchTokenDetails(mint);
  if (!details || details.priceUSD <= 0) return { action: 'wait' };

  const currentPrice = details.priceUSD;
  const currentLiq = details.liquidityUSD || watch.coin.liquidityUSD;

  // Update coin data
  watch.coin.priceUSD = currentPrice;
  watch.coin.liquidityUSD = currentLiq;
  watch.coin.txnsH1 = details.txnsH1 || watch.coin.txnsH1;
  watch.coin.buysH1 = details.buysH1 || watch.coin.buysH1;
  watch.coin.sellsH1 = details.sellsH1 || watch.coin.sellsH1;
  watch.coin.volumeH1 = details.volumeH1 || watch.coin.volumeH1;
  if (details.symbol && details.symbol !== 'UNKNOWN') watch.coin.symbol = details.symbol;
  if (details.name) watch.coin.name = details.name;
  if (details.url) watch.coin.url = details.url;
  watch.lastChecked = Date.now();

  // Update peak
  if (currentPrice > watch.peakPrice) {
    watch.peakPrice = currentPrice;
    watch.peakLiquidity = currentLiq;
  }

  // Rug check — liq dropped 30%+ from peak AND below entry
  const liqDropFromPeak = watch.peakLiquidity > 0
    ? ((watch.peakLiquidity - currentLiq) / watch.peakLiquidity) * 100 : 0;
  if (liqDropFromPeak > 30 && currentLiq < watch.entryLiquidity * 0.7) {
    console.log(`🚨 ${watch.coin.symbol} RUG — liq dropped ${liqDropFromPeak.toFixed(0)}%`);
    return { action: 'dump' };
  }

  const launchPrice = watch.coin.launchTime
    ? (watch.entryLiquidity > 0 ? watch.coin.priceUSD : currentPrice)
    : currentPrice;

  const pumpFromStart = watch.peakPrice > 0 && launchPrice > 0
    ? ((watch.peakPrice - launchPrice) / launchPrice) * 100 : 0;
  const dropFromPeak = watch.peakPrice > 0
    ? ((watch.peakPrice - currentPrice) / watch.peakPrice) * 100 : 0;

  if (watch.state === 'watching_pump') {
    if (watch.peakPrice > 0 && pumpFromStart >= 30) {
      watch.state = 'dip_watch';
      console.log(`📈 ${watch.coin.symbol} pumped ${pumpFromStart.toFixed(0)}% → watching for dip`);
    }
    return { action: 'wait' };
  }

  if (watch.state === 'dip_watch') {
    if (dropFromPeak >= 10 && dropFromPeak <= 35) {
      watch.state = 'dip_detected';
      watch.lowestDipPrice = currentPrice;
      watch.dipLiquidity = currentLiq;
      console.log(`📉 ${watch.coin.symbol} dipped ${dropFromPeak.toFixed(0)}% → watching for recovery`);
    } else if (dropFromPeak > 35) {
      console.log(`❌ ${watch.coin.symbol} dipped too hard ${dropFromPeak.toFixed(0)}%`);
      return { action: 'dump' };
    }
    return { action: 'wait' };
  }

  if (watch.state === 'dip_detected') {
    if (currentPrice < watch.lowestDipPrice) {
      watch.lowestDipPrice = currentPrice;
      watch.dipLiquidity = currentLiq;
    }

    const recoveryFromLow = watch.lowestDipPrice > 0
      ? ((currentPrice - watch.lowestDipPrice) / watch.lowestDipPrice) * 100 : 0;
    const liqHealthy = liqDropFromPeak < 25;
    const txnsActive = (watch.coin.txnsH1 || 0) >= 10;
    const buyRatio = watch.coin.txnsH1 > 0 ? watch.coin.buysH1 / watch.coin.txnsH1 : 0;

    console.log(`🔄 ${watch.coin.symbol} | recovery:${recoveryFromLow.toFixed(1)}% | liqOk:${liqHealthy} | txns:${watch.coin.txnsH1} | buys:${(buyRatio*100).toFixed(0)}%`);

    if (recoveryFromLow >= 5 && liqHealthy && txnsActive) {
      // Fetch fresh price right before buying
      const freshDetails = await fetchTokenDetails(mint);
      if (freshDetails && freshDetails.priceUSD > 0) {
        watch.coin.priceUSD = freshDetails.priceUSD;
        watch.coin.liquidityUSD = freshDetails.liquidityUSD || watch.coin.liquidityUSD;
      }
      if (!watch.coin.priceUSD || watch.coin.priceUSD <= 0) {
        console.log(`⚠️ ${watch.coin.symbol} no price at buy time — skip`);
        return { action: 'dump' };
      }
      console.log(`✅ ${watch.coin.symbol} DIP BUY | pump:${pumpFromStart.toFixed(0)}% dip:${dropFromPeak.toFixed(0)}% recovery:${recoveryFromLow.toFixed(1)}% price:$${watch.coin.priceUSD}`);
      return { action: 'buy', coin: watch.coin };
    }

    if (dropFromPeak > 35) {
      console.log(`❌ ${watch.coin.symbol} dip too deep ${dropFromPeak.toFixed(0)}%`);
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

  // Update ages, remove expired from queue
  newCoinQueue = newCoinQueue.filter(c => {
    c.ageMinutes = (now - c.launchTime) / 1000 / 60;
    return c.ageMinutes <= maxAgeMins;
  });

  // Stage 1: process coins 30+ seconds old
  const readyForStage1 = newCoinQueue.filter(c => c.ageMinutes >= 0.5 && !watchlist[c.mintAddress]);
  newCoinQueue = newCoinQueue.filter(c => c.ageMinutes < 0.5 || watchlist[c.mintAddress]);

  for (const coin of readyForStage1) {
    if (watchlist[coin.mintAddress]) continue;
    const result = await runStage1Check(coin);
    if (result.pass) watchlist[coin.mintAddress] = result.watchEntry;
  }

  // Remove expired from watchlist
  for (const [mint, watch] of Object.entries(watchlist)) {
    const ageMins = (now - watch.addedAt) / 1000 / 60;
    if (ageMins > maxAgeMins) {
      console.log(`⏰ ${watch.coin.symbol} expired from watchlist`);
      delete watchlist[mint];
    }
  }

  // Update watchlist entries, check for buy signals
  for (const [mint, watch] of Object.entries(watchlist)) {
    if (now - watch.lastChecked < 10000) continue; // Check every 10s per coin
    const result = await updateWatchEntry(mint, watch);
    if (result.action === 'buy') {
      coinsReadyToBuy.push({ ...result.coin, readyForBuy: true });
      delete watchlist[mint];
    } else if (result.action === 'dump') {
      delete watchlist[mint];
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (Object.keys(watchlist).length > 0 || coinsReadyToBuy.length > 0) {
    console.log(`👁️ watching:${Object.keys(watchlist).length} | 🛒 ready:${coinsReadyToBuy.length} | 🆕 queue:${newCoinQueue.length} | WS:${wsConnected ? '✅' : '❌'}`);
  }

  return coinsReadyToBuy;
}

// ==================== ANALYZE ====================

async function analyzeCoin(coin, settings, connection) {
  if (!coin.readyForBuy) return { passes: false, reason: 'Not a dip buy signal' };

  // Must have real price
  if (!coin.priceUSD || coin.priceUSD <= 0) {
    return { passes: false, reason: 'No price data' };
  }

  const hasMintAuth = connection
    ? await checkMintAuthority(coin.mintAddress, connection).catch(() => false)
    : false;

  if (hasMintAuth) {
    console.log(`⚠️ ${coin.symbol} mint authority — skip`);
    return { passes: false, reason: 'Mint authority' };
  }

  let score = 6;
  if (coin.liquidityUSD > 50000) score += 2;
  else if (coin.liquidityUSD > 20000) score += 1;
  const buyRatio = coin.txnsH1 > 0 ? coin.buysH1 / coin.txnsH1 : 0.5;
  if (buyRatio > 0.65) score += 1;
  if ((coin.txnsH1 || 0) > 50) score += 1;
  score = Math.min(10, score);

  const minScore = settings.minScore || 6;
  console.log(`🛒 ${coin.symbol} | score:${score}/10 | liq:$${Math.round(coin.liquidityUSD)} | price:$${coin.priceUSD}`);

  return {
    passes: score >= minScore,
    score,
    hasMintAuth,
    coin,
    reason: score >= minScore ? 'Dip buy ✅' : `Score ${score}/10`,
  };
}

// ==================== HELPERS ====================

async function getTokenPrice(mintAddress) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { timeout: 5000 }
    );
    const pairs = res.data?.pairs?.filter(p => p.chainId === 'solana');
    if (!pairs?.length) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return parseFloat(best.priceUsd) || null;
  } catch {
    return null;
  }
}

async function getSOLPrice() {
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 5000 }
    );
    return res.data?.solana?.usd || 150;
  } catch {
    return 150;
  }
}

connectPumpWebSocket();

module.exports = { fetchNewTokens, analyzeCoin, getTokenPrice, getSOLPrice };