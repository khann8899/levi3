// Levi 3 - Token Scanner
const axios = require('axios');

const SCAN_URLS = [
  'https://api.dexscreener.com/token-profiles/latest/v1',  // Latest token profiles - most fresh
  'https://api.dexscreener.com/latest/dex/search?q=pumpswap&chainIds=solana',
  'https://api.dexscreener.com/latest/dex/search?q=pump.fun&chainIds=solana',
];

const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

const SKIP_SYMBOLS = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'WETH', 'BTC']);

let seenTokens = new Set();
let lastReset = Date.now();
let urlIndex = 0;

async function fetchNewTokens(maxAgeMins) {
  if (Date.now() - lastReset > 30 * 60 * 1000) {
    seenTokens = new Set();
    lastReset = Date.now();
    console.log('🔄 Reset seen tokens');
  }

  const url = SCAN_URLS[urlIndex % SCAN_URLS.length];
  urlIndex++;
  const isProfileEndpoint = url.includes('token-profiles');

  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const newCoins = [];
    const now = Date.now();

    if (isProfileEndpoint) {
      // token-profiles returns array of {chainId, tokenAddress, ...}
      const profiles = response.data || [];
      const solanaProfiles = profiles.filter(p => p.chainId === 'solana');

      for (const profile of solanaProfiles) {
        const mint = profile.tokenAddress;
        if (!mint || SKIP_MINTS.has(mint)) continue;
        if (seenTokens.has(mint)) continue;
        seenTokens.add(mint);

        // Add to list — liquidity will be fetched in analyzeCoin
        newCoins.push({
          mintAddress: mint,
          symbol: profile.symbol || 'UNKNOWN',
          name: profile.name || 'Unknown',
          priceUSD: 0,
          liquidityUSD: 0, // Will be fetched
          volumeH1: 0,
          priceChangeH1: 0,
          txnsH1: 0,
          buysH1: 0,
          sellsH1: 0,
          ageMinutes: 0, // Will be set after enrichment
          url: profile.url || `https://dexscreener.com/solana/${mint}`,
          dexId: '',
        });
      }
      console.log(`📡 [profiles] ${profiles.length} total → ${newCoins.length} new Solana tokens`);

    } else {
      // Search endpoint returns {pairs: [...]}
      const pairs = response.data?.pairs || [];
      pairs.sort((a, b) => b.pairCreatedAt - a.pairCreatedAt);

      for (const pair of pairs) {
        const mint = pair.baseToken?.address;
        if (!mint || SKIP_MINTS.has(mint)) continue;
        if (SKIP_SYMBOLS.has(pair.baseToken?.symbol)) continue;
        if (seenTokens.has(mint)) continue;

        const ageMinutes = (now - pair.pairCreatedAt) / 1000 / 60;
        if (ageMinutes < 0 || ageMinutes > maxAgeMins) continue;

        seenTokens.add(mint);
        newCoins.push({
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
          ageMinutes,
          url: pair.url || `https://dexscreener.com/solana/${mint}`,
          dexId: pair.dexId || '',
        });
      }

      const query = url.split('q=')[1]?.split('&')[0] || '';
      console.log(`📡 [${query}] ${pairs.length} pairs → ${newCoins.length} new (under ${maxAgeMins}m)`);
    }

    if (newCoins.length > 0) {
      console.log(`🔍 New coins: ${newCoins.map(c => c.symbol + '($' + Math.round(c.liquidityUSD) + ')').join(', ')}`);
    }

    return newCoins;

  } catch (e) {
    console.error(`Scanner error: ${e.message}`);
    return [];
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

  // If liquidity is 0, fetch fresh data from DexScreener token endpoint
  if (tokenData.liquidityUSD === 0) {
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
        tokenData.volumeH1 = best.volume?.h1 || 0;
        tokenData.txnsH1 = (best.txns?.h1?.buys || 0) + (best.txns?.h1?.sells || 0);
        tokenData.buysH1 = best.txns?.h1?.buys || 0;
        tokenData.sellsH1 = best.txns?.h1?.sells || 0;
        tokenData.url = best.url || tokenData.url;
        console.log(`📊 Enriched ${coin.symbol}: liq=$${Math.round(tokenData.liquidityUSD)}`);
      }
    } catch {}
  }

  // Basic liquidity check
  if (tokenData.liquidityUSD < settings.minLiquidity) {
    return { passes: false, reason: `Low liquidity: $${Math.round(tokenData.liquidityUSD)}` };
  }

  // Honeypot check
  const honeypot = await checkHoneypot(coin.mintAddress).catch(() => ({ isHoneypot: false, sellTax: 0 }));
  if (honeypot.isHoneypot) return { passes: false, reason: 'Honeypot detected' };
  if (honeypot.sellTax > 10) return { passes: false, reason: `High sell tax: ${honeypot.sellTax}%` };

  // Mint authority check
  const hasMintAuth = connection ? await checkMintAuthority(coin.mintAddress, connection).catch(() => false) : false;

  // Score the coin using enriched tokenData
  let score = 5;
  if (tokenData.liquidityUSD > 50000) score += 2;
  else if (tokenData.liquidityUSD > 20000) score += 1;
  if (tokenData.volumeH1 > 20000) score += 1;
  if (tokenData.txnsH1 > 100) score += 1;
  if (tokenData.buysH1 > tokenData.sellsH1) score += 1;
  if (hasMintAuth) score -= 2;
  if (tokenData.priceChangeH1 > 30) score += 1;
  score = Math.max(1, Math.min(10, score));

  return {
    passes: score >= 4 && !honeypot.isHoneypot,
    score,
    hasMintAuth,
    honeypot,
    coin: tokenData, // return enriched coin data
    reason: score < 4 ? `Low score: ${score}/10` : 'Passed',
  };
}

module.exports = { fetchNewTokens, analyzeCoin, getTokenPrice, getSOLPrice };