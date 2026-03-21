// Levi 3 - Enhanced Token Scanner with Two-Pass Validation
const axios = require('axios');
const WebSocket = require('ws');

let newCoinQueue = []; // Stage 1: newly launched, waiting for first check
let watchlist = {};    // Stage 2: passed first check, waiting 60s for recheck
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
          const bondingProgress = (bondingCurveSOL / 85) * 100; // 85 SOL = graduation threshold

          const coin = {
            mintAddress: msg.mint,
            symbol: msg.symbol || msg.name?.slice(0, 10) || 'UNKNOWN',
            name: msg.name || 'Unknown',
            priceUSD: bondingCurveSOL > 0 ? (bondingCurveSOL * solPrice) / totalSupply : 0,
            liquidityUSD,
            bondingCurveSOL,
            bondingProgress: Math.min(bondingProgress, 100),
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
            // Snapshot for 3x improvement check
            snapshot: {
              liquidityUSD,
              txCount: 1,
              buys: 1,
              time: Date.now(),
            }
          };

          newCoinQueue.push(coin);
          console.log(`🆕 ${coin.symbol} launched | liq:$${Math.round(liquidityUSD)} | curve:${bondingProgress.toFixed(1)}%`);
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

// ==================== COIN ANALYSIS ====================

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

// Stage 1: Quick initial check (runs at 30 seconds after launch)
async function runStage1Check(coin) {
  // Honeypot check first (most important)
  const honeypot = await checkHoneypot(coin.mintAddress).catch(() => ({ isHoneypot: false, sellTax: 0 }));
  if (honeypot.isHoneypot) {
    console.log(`❌ ${coin.symbol} HONEYPOT - dumped`);
    return { pass: false, reason: 'Honeypot' };
  }
  if (honeypot.sellTax > 15) {
    console.log(`❌ ${coin.symbol} high sell tax (${honeypot.sellTax}%) - dumped`);
    return { pass: false, reason: `Sell tax ${honeypot.sellTax}%` };
  }

  // Try to get DexScreener data
  const details = await fetchTokenDetails(coin.mintAddress);
  if (details) {
    // Merge DexScreener data
    coin.liquidityUSD = Math.max(coin.liquidityUSD, details.liquidityUSD);
    coin.txnsH1 = details.txnsH1 || coin.txnsH1;
    coin.buysH1 = details.buysH1 || coin.buysH1;
    coin.sellsH1 = details.sellsH1 || coin.sellsH1;
    coin.volumeH1 = details.volumeH1 || coin.volumeH1;
    if (details.symbol && details.symbol !== 'UNKNOWN') coin.symbol = details.symbol;
    if (details.name) coin.name = details.name;
    if (details.url) coin.url = details.url;
    if (details.priceUSD > 0) coin.priceUSD = details.priceUSD;
  }

  // Save snapshot for Stage 2 comparison
  coin.snapshot = {
    liquidityUSD: coin.liquidityUSD,
    txCount: coin.txnsH1,
    buys: coin.buysH1,
    volumeH1: coin.volumeH1,
    time: Date.now(),
  };

  console.log(`⏳ ${coin.symbol} stage1 passed | liq:$${Math.round(coin.liquidityUSD)} | txns:${coin.txnsH1} | honeypot:no | waiting 60s...`);
  return { pass: true, honeypot };
}

// Stage 2: Full check after 60 seconds - did metrics improve?
async function runStage2Check(coin, settings, connection) {
  const details = await fetchTokenDetails(coin.mintAddress);

  let currentLiq = coin.liquidityUSD;
  let currentTxns = coin.txnsH1;
  let currentBuys = coin.buysH1;
  let currentSells = coin.sellsH1;
  let currentVolume = coin.volumeH1;

  if (details) {
    currentLiq = Math.max(currentLiq, details.liquidityUSD);
    currentTxns = details.txnsH1 || currentTxns;
    currentBuys = details.buysH1 || currentBuys;
    currentSells = details.sellsH1 || currentSells;
    currentVolume = details.volumeH1 || currentVolume;
    if (details.symbol && details.symbol !== 'UNKNOWN') coin.symbol = details.symbol;
    if (details.name) coin.name = details.name;
    if (details.url) coin.url = details.url;
    if (details.priceUSD > 0) coin.priceUSD = details.priceUSD;
  }

  const snap = coin.snapshot;
  const liqImprovement = snap.liquidityUSD > 0 ? currentLiq / snap.liquidityUSD : 1;
  const txImprovement = snap.txCount > 0 ? currentTxns / snap.txCount : 1;
  const buyRatio = currentTxns > 0 ? currentBuys / currentTxns : 0;

  console.log(`🔬 ${coin.symbol} stage2 | liq:$${Math.round(currentLiq)}(${liqImprovement.toFixed(1)}x) | txns:${currentTxns}(${txImprovement.toFixed(1)}x) | buyratio:${(buyRatio*100).toFixed(0)}%`);

  // Check 3x improvement requirement
  const hasImproved = liqImprovement >= 2 || txImprovement >= 2;

  if (!hasImproved && currentLiq < settings.minLiquidity) {
    console.log(`❌ ${coin.symbol} no improvement - dumped`);
    return { passes: false, reason: 'No improvement after 60s' };
  }

  // Liquidity check
  if (currentLiq < settings.minLiquidity) {
    console.log(`❌ ${coin.symbol} liq too low ($${Math.round(currentLiq)})`);
    return { passes: false, reason: `Low liq: $${Math.round(currentLiq)}` };
  }

  // Buy ratio check - at least 60% buys
  if (buyRatio < 0.6 && currentTxns > 10) {
    console.log(`❌ ${coin.symbol} bad buy ratio (${(buyRatio*100).toFixed(0)}%)`);
    return { passes: false, reason: `Low buy ratio: ${(buyRatio*100).toFixed(0)}%` };
  }

  // Mint authority check
  const hasMintAuth = connection ? await checkMintAuthority(coin.mintAddress, connection).catch(() => false) : false;
  if (hasMintAuth) {
    console.log(`⚠️ ${coin.symbol} has mint authority`);
  }

  // Score
  let score = 5;
  if (currentLiq > 50000) score += 2;
  else if (currentLiq > 20000) score += 1;
  else if (currentLiq > 5000) score += 0;
  if (currentVolume > 10000) score += 1;
  if (currentTxns > 50) score += 1;
  if (buyRatio > 0.75) score += 1;
  if (hasMintAuth) score -= 2;
  if (liqImprovement >= 3 || txImprovement >= 3) score += 1; // Bonus for 3x improvement
  if (coin.bondingProgress > 20) score += 1; // Bonus for high bonding curve progress
  score = Math.max(1, Math.min(10, score));

  // Update coin with latest data
  coin.liquidityUSD = currentLiq;
  coin.txnsH1 = currentTxns;
  coin.buysH1 = currentBuys;
  coin.sellsH1 = currentSells;
  coin.volumeH1 = currentVolume;

  console.log(`📈 ${coin.symbol} score: ${score}/10 | passes: ${score >= settings.minScore || 8}`);

  return {
    passes: score >= (settings.minScore || 8) && !hasMintAuth,
    score,
    hasMintAuth,
    coin,
    reason: score < (settings.minScore || 8) ? `Score: ${score}/10` : 'Passed ✅',
  };
}

// ==================== MAIN FETCH ====================

async function fetchNewTokens(maxAgeMins) {
  const now = Date.now();

  // Update ages and remove expired
  newCoinQueue = newCoinQueue.filter(c => {
    c.ageMinutes = (now - c.launchTime) / 1000 / 60;
    return c.ageMinutes <= maxAgeMins;
  });

  // Move coins ready for stage 1 (30+ seconds old) to processing
  const readyForStage1 = newCoinQueue.filter(c => c.ageMinutes >= 0.5 && !watchlist[c.mintAddress]);
  newCoinQueue = newCoinQueue.filter(c => c.ageMinutes < 0.5 || watchlist[c.mintAddress]);

  // Run stage 1 checks
  for (const coin of readyForStage1) {
    if (watchlist[coin.mintAddress]) continue;
    const result = await runStage1Check(coin);
    if (result.pass) {
      watchlist[coin.mintAddress] = {
        coin,
        addedAt: Date.now(),
        honeypot: result.honeypot,
      };
    }
  }

  // Check watchlist for stage 2 (60+ seconds since stage 1)
  const readyForStage2 = Object.entries(watchlist).filter(([, w]) =>
    (Date.now() - w.addedAt) >= 60000
  );

  // Remove expired from watchlist
  for (const [mint, w] of Object.entries(watchlist)) {
    const age = (now - w.coin.launchTime) / 1000 / 60;
    if (age > maxAgeMins) {
      delete watchlist[mint];
    }
  }

  // Return stage2-ready coins for analysis in bot/index.js
  const coinsToAnalyze = [];
  for (const [mint, w] of readyForStage2) {
    delete watchlist[mint];
    coinsToAnalyze.push({ ...w.coin, readyForStage2: true });
  }

  // Also add DexScreener coins as fallback
  const dexCoins = await fetchDexScreenerCoins(maxAgeMins);
  const watchMints = new Set([...Object.keys(watchlist), ...coinsToAnalyze.map(c => c.mintAddress)]);
  for (const coin of dexCoins) {
    if (!watchMints.has(coin.mintAddress)) {
      coinsToAnalyze.push(coin);
    }
  }

  if (coinsToAnalyze.length > 0) {
    console.log(`🔎 ${coinsToAnalyze.length} coins ready | 📋 watchlist: ${Object.keys(watchlist).length} | 🆕 queue: ${newCoinQueue.length}`);
  }

  return coinsToAnalyze;
}

async function fetchDexScreenerCoins(maxAgeMins) {
  const urls = [
    'https://api.dexscreener.com/latest/dex/search?q=pumpswap&chainIds=solana',
    'https://api.dexscreener.com/latest/dex/search?q=pump.fun&chainIds=solana',
  ];

  const coins = [];
  const seen = new Set();
  const now = Date.now();

  for (const url of urls) {
    try {
      const response = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const pairs = response.data?.pairs || [];
      pairs.sort((a, b) => b.pairCreatedAt - a.pairCreatedAt);

      for (const pair of pairs) {
        const mint = pair.baseToken?.address;
        if (!mint || SKIP_MINTS.has(mint) || seen.has(mint)) continue;
        const age = (now - pair.pairCreatedAt) / 1000 / 60;
        if (age < 0 || age > maxAgeMins) continue;
        seen.add(mint);
        coins.push({
          mintAddress: mint,
          symbol: pair.baseToken.symbol || 'UNKNOWN',
          name: pair.baseToken.name || 'Unknown',
          priceUSD: parseFloat(pair.priceUsd) || 0,
          liquidityUSD: pair.liquidity?.usd || 0,
          volumeH1: pair.volume?.h1 || 0,
          priceChangeH1: pair.priceChange?.h1 || 0,
          txnsH1: (pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0),
          buysH1: pair.txns?.h1?.buys || 0,
          sellsH1: pair.txns?.h1?.sells || 0,
          ageMinutes: age,
          url: pair.url || `https://dexscreener.com/solana/${mint}`,
          dexId: pair.dexId || '',
        });
      }
    } catch {}
  }
  return coins;
}

// ==================== STANDARD ANALYZE (for DexScreener coins) ====================

async function analyzeCoin(coin, settings, connection) {
  // Stage 2 coins use the enhanced check
  if (coin.readyForStage2) {
    return runStage2Check(coin, settings, connection);
  }

  // Standard analysis for DexScreener coins
  let tokenData = { ...coin };

  if (tokenData.liquidityUSD < settings.minLiquidity) {
    return { passes: false, reason: `Low liq: $${Math.round(tokenData.liquidityUSD)}` };
  }

  if (tokenData.ageMinutes > settings.maxAgeMins) {
    return { passes: false, reason: `Too old: ${Math.round(tokenData.ageMinutes)}m` };
  }

  const honeypot = await checkHoneypot(coin.mintAddress).catch(() => ({ isHoneypot: false, sellTax: 0 }));
  if (honeypot.isHoneypot) return { passes: false, reason: 'Honeypot' };
  if (honeypot.sellTax > 10) return { passes: false, reason: `Sell tax: ${honeypot.sellTax}%` };

  const hasMintAuth = connection ? await checkMintAuthority(coin.mintAddress, connection).catch(() => false) : false;

  const buyRatio = tokenData.txnsH1 > 0 ? tokenData.buysH1 / tokenData.txnsH1 : 0.5;

  let score = 5;
  if (tokenData.liquidityUSD > 50000) score += 2;
  else if (tokenData.liquidityUSD > 20000) score += 1;
  if (tokenData.volumeH1 > 20000) score += 1;
  if (tokenData.txnsH1 > 100) score += 1;
  if (buyRatio > 0.65) score += 1;
  if (hasMintAuth) score -= 2;
  if (tokenData.priceChangeH1 > 30) score += 1;
  score = Math.max(1, Math.min(10, score));

  console.log(`📈 ${tokenData.symbol} score: ${score}/10`);

  return {
    passes: score >= (settings.minScore || 8) && !honeypot.isHoneypot,
    score,
    hasMintAuth,
    honeypot,
    coin: tokenData,
    reason: score < (settings.minScore || 8) ? `Score: ${score}/10` : 'Passed',
  };
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