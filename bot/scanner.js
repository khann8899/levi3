// Levi 3 - Token Scanner using PumpPortal WebSocket for fresh coins
const axios = require('axios');
const WebSocket = require('ws');

let newCoinQueue = [];
let wsConnected = false;
let pumpWs = null;

const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

// Connect to PumpPortal WebSocket for real-time new coin launches
function connectPumpWebSocket() {
  try {
    pumpWs = new WebSocket('wss://pumpportal.fun/api/data');

    pumpWs.on('open', () => {
      wsConnected = true;
      console.log('🔌 Connected to PumpPortal WebSocket');
      // Subscribe to new token events
      pumpWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    pumpWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.mint && msg.name) {
          // Calculate liquidity from bonding curve SOL
          const solPrice = 150; // Approximate, good enough for filtering
          const bondingCurveSOL = msg.vSolInBondingCurve || 0;
          const liquidityUSD = bondingCurveSOL * solPrice;

          const coin = {
            mintAddress: msg.mint,
            symbol: msg.symbol || msg.name?.slice(0, 10) || 'UNKNOWN',
            name: msg.name || 'Unknown',
            priceUSD: msg.vTokensInBondingCurve > 0 ? (bondingCurveSOL * solPrice) / msg.vTokensInBondingCurve : 0,
            liquidityUSD,
            volumeH1: 0,
            priceChangeH1: 0,
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
          if (liquidityUSD > 0) {
            console.log(`🆕 New launch: ${coin.symbol} (liq: $${Math.round(liquidityUSD)})`);
          } else {
            console.log(`🆕 New launch: ${coin.symbol} (${coin.mintAddress.slice(0, 8)}...)`);
          }
        }
      } catch {}
    });

    pumpWs.on('close', () => {
      wsConnected = false;
      console.log('🔌 PumpPortal WS disconnected, reconnecting in 5s...');
      setTimeout(connectPumpWebSocket, 5000);
    });

    pumpWs.on('error', () => {
      wsConnected = false;
      pumpWs.close();
    });

  } catch (e) {
    console.error('PumpPortal WS error:', e.message);
    setTimeout(connectPumpWebSocket, 10000);
  }
}

// Fallback: DexScreener search for recent coins
async function fetchDexScreenerCoins(maxAgeMins) {
  const urls = [
    'https://api.dexscreener.com/latest/dex/search?q=pumpswap&chainIds=solana',
    'https://api.dexscreener.com/latest/dex/search?q=pump.fun&chainIds=solana',
  ];

  const coins = [];
  const now = Date.now();
  const seen = new Set();

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

// Main fetch function - combines WebSocket queue + DexScreener fallback
async function fetchNewTokens(maxAgeMins) {
  const coins = [];
  const seen = new Set();
  const now = Date.now();

  // Update age of WS coins and remove expired ones
  newCoinQueue = newCoinQueue.filter(coin => {
    const ageMs = now - coin.launchTime;
    coin.ageMinutes = ageMs / 1000 / 60;
    return coin.ageMinutes <= maxAgeMins; // Remove coins older than maxAgeMins
  });

  // Get ready WS coins (at least 30 seconds old)
  for (const coin of newCoinQueue) {
    if (coin.ageMinutes >= 0.5 && !seen.has(coin.mintAddress)) {
      seen.add(coin.mintAddress);
      coins.push({ ...coin });
    }
  }

  // Remove processed coins from queue
  newCoinQueue = newCoinQueue.filter(c => !seen.has(c.mintAddress) || c.ageMinutes < 0.5);

  // Also check DexScreener for coins with confirmed liquidity
  const dexCoins = await fetchDexScreenerCoins(maxAgeMins);
  for (const coin of dexCoins) {
    if (!seen.has(coin.mintAddress)) {
      seen.add(coin.mintAddress);
      coins.push(coin);
    }
  }

  if (coins.length > 0) {
    console.log(`🔎 ${coins.length} coins to check (${wsConnected ? '🔌 WS connected' : '⚠️ WS offline'})`);
  }

  return coins;
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

async function analyzeCoin(coin, settings, connection) {
  let tokenData = { ...coin };

  // For brand new WS coins, skip if under 30 seconds old
  if (coin.isNewLaunch && tokenData.ageMinutes < 0.5) {
    return { passes: false, reason: 'Too new, waiting...' };
  }

  if (tokenData.liquidityUSD === 0 || tokenData.symbol === 'UNKNOWN' || coin.isNewLaunch) {
    try {
      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${coin.mintAddress}`,
        { timeout: 8000 }
      );
      const pairs = response.data?.pairs?.filter(p => p.chainId === 'solana');
      if (pairs?.length > 0) {
        const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        tokenData.liquidityUSD = best.liquidity?.usd || 0;
        tokenData.priceUSD = parseFloat(best.priceUsd) || tokenData.priceUSD;
        tokenData.symbol = best.baseToken?.symbol || tokenData.symbol;
        tokenData.name = best.baseToken?.name || tokenData.name;
        tokenData.volumeH1 = best.volume?.h1 || 0;
        tokenData.txnsH1 = (best.txns?.h1?.buys || 0) + (best.txns?.h1?.sells || 0);
        tokenData.buysH1 = best.txns?.h1?.buys || 0;
        tokenData.sellsH1 = best.txns?.h1?.sells || 0;
        tokenData.url = best.url || tokenData.url;
        if (best.pairCreatedAt) {
          tokenData.ageMinutes = (Date.now() - best.pairCreatedAt) / 1000 / 60;
        }
        console.log(`📊 ${tokenData.symbol}: liq=$${Math.round(tokenData.liquidityUSD)} age=${Math.round(tokenData.ageMinutes)}m`);
      }
    } catch {}
  }

  // Age filter
  if (tokenData.ageMinutes > settings.maxAgeMins) {
    return { passes: false, reason: `Too old: ${Math.round(tokenData.ageMinutes)}m` };
  }

  // Liquidity filter
  if (tokenData.liquidityUSD < settings.minLiquidity) {
    return { passes: false, reason: `Low liq: $${Math.round(tokenData.liquidityUSD)}` };
  }

  // Honeypot check
  const honeypot = await checkHoneypot(coin.mintAddress).catch(() => ({ isHoneypot: false, sellTax: 0 }));
  if (honeypot.isHoneypot) return { passes: false, reason: 'Honeypot' };
  if (honeypot.sellTax > 10) return { passes: false, reason: `Sell tax: ${honeypot.sellTax}%` };

  // Mint authority check
  const hasMintAuth = connection ? await checkMintAuthority(coin.mintAddress, connection).catch(() => false) : false;

  // Score
  let score = 5;
  if (tokenData.liquidityUSD > 50000) score += 2;
  else if (tokenData.liquidityUSD > 20000) score += 1;
  if (tokenData.volumeH1 > 20000) score += 1;
  if (tokenData.txnsH1 > 100) score += 1;
  if (tokenData.buysH1 > tokenData.sellsH1) score += 1;
  if (hasMintAuth) score -= 2;
  if (tokenData.priceChangeH1 > 30) score += 1;
  score = Math.max(1, Math.min(10, score));

  console.log(`📈 ${tokenData.symbol} score: ${score}/10 | passes: ${score >= 8}`);

  return {
    passes: score >= 8 && !honeypot.isHoneypot,
    score,
    hasMintAuth,
    honeypot,
    coin: tokenData,
    reason: score < 8 ? `Score: ${score}/10` : 'Passed',
  };
}

// Start WebSocket on module load
connectPumpWebSocket();

module.exports = { fetchNewTokens, analyzeCoin, getTokenPrice, getSOLPrice };