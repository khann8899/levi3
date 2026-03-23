// Levi 3 - Trade Executor
const axios = require('axios');
const { Connection, PublicKey, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58');

let connection = null;
let wallet = null;

const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC_URL,
  'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
].filter(Boolean);

let currentRpcIndex = 0;

function createConnection(url) {
  return new Connection(url, { commitment: 'confirmed' });
}

function init() {
  connection = createConnection(RPC_ENDPOINTS[0]);

  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error('WALLET_PRIVATE_KEY not set');

  let decoded;
  try {
    decoded = bs58.decode(privateKey);
  } catch {
    const b = require('bs58');
    decoded = b.default ? b.default.decode(privateKey) : b.decode(privateKey);
  }

  wallet = Keypair.fromSecretKey(new Uint8Array(decoded));
  console.log(`✅ Wallet: ${wallet.publicKey.toString()}`);
  console.log(`🌐 RPC: ${RPC_ENDPOINTS[0]?.slice(0, 50)}...`);
  return { connection, wallet };
}

function getConnection() { return connection; }
function getWallet() { return wallet; }

async function rpcCall(method, params) {
  const url = RPC_ENDPOINTS[currentRpcIndex] || 'https://api.mainnet-beta.solana.com';
  const res = await axios.post(url, {
    jsonrpc: '2.0', id: 1, method, params
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
  if (res.data?.error) throw new Error(res.data.error.message);
  return res.data?.result;
}

async function getSOLBalance() {
  try {
    if (!wallet) return 0;
    const result = await rpcCall('getBalance', [wallet.publicKey.toString()]);
    return (result?.value || 0) / 1e9;
  } catch (e) {
    console.error('Balance error:', e.message);
    return 0;
  }
}

async function sendRawTransactionHttp(serializedTx) {
  const encoded = Buffer.from(serializedTx).toString('base64');
  const result = await rpcCall('sendTransaction', [encoded, {
    skipPreflight: true,
    encoding: 'base64',
    maxRetries: 3,
  }]);
  if (!result) throw new Error('No transaction ID returned');
  return result;
}

async function confirmTransactionHttp(txid, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const result = await rpcCall('getSignatureStatuses', [[txid]]);
      const status = result?.value?.[0];
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        if (status.err) throw new Error(`TX failed: ${JSON.stringify(status.err)}`);
        return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Confirmation timeout');
}

async function executeTrade(action, mintAddress, amountSOL) {
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`💱 ${action.toUpperCase()} ${mintAddress.slice(0, 8)}... ${amountSOL} SOL (attempt ${i + 1})`);

      const res = await axios.post(
        'https://pumpportal.fun/api/trade-local',
        {
          publicKey: wallet.publicKey.toString(),
          action,
          mint: mintAddress,
          denominatedInSol: 'true',
          amount: amountSOL,
          slippage: 15,
          priorityFee: 0.0005,
          pool: 'auto',
        },
        { headers: { 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 15000 }
      );

      if (res.status !== 200) throw new Error(`PumpPortal error: ${res.status}`);

      const txBuffer = Buffer.from(res.data);
      let transaction;
      try {
        transaction = VersionedTransaction.deserialize(txBuffer);
        transaction.sign([wallet]);
      } catch {
        transaction = Transaction.from(txBuffer);
        transaction.sign(wallet);
      }

      const txid = await sendRawTransactionHttp(
        transaction instanceof VersionedTransaction ? transaction.serialize() : transaction.serialize()
      );

      await confirmTransactionHttp(txid);
      console.log(`✅ ${action} confirmed: ${txid}`);
      return { success: true, txid };

    } catch (e) {
      console.error(`Trade attempt ${i + 1} failed: ${e.message}`);
      if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return { success: false, error: 'All retries failed' };
}

async function buyToken(mintAddress, amountUSD, solPrice) {
  const solAmount = parseFloat((amountUSD / solPrice).toFixed(6));
  return executeTrade('buy', mintAddress, solAmount);
}

async function sellToken(mintAddress, percentToSell) {
  return executeTrade('sell', mintAddress, percentToSell / 100);
}

module.exports = { init, getConnection, getWallet, getSOLBalance, buyToken, sellToken };