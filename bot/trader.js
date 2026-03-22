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
  return new Connection(url, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
    wsEndpoint: undefined, // Disable WebSocket to avoid fetch issues
  });
}

function rotateRpc() {
  currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
  const url = RPC_ENDPOINTS[currentRpcIndex];
  connection = createConnection(url);
  console.log(`🔄 Switched RPC to: ${url.slice(0, 40)}...`);
  return connection;
}

function init() {
  const rpcUrl = RPC_ENDPOINTS[0];
  connection = createConnection(rpcUrl);

  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error('WALLET_PRIVATE_KEY not set');

  const decoded = bs58.decode(privateKey);
  wallet = Keypair.fromSecretKey(new Uint8Array(decoded));

  console.log(`✅ Wallet: ${wallet.publicKey.toString()}`);
  console.log(`🌐 RPC: ${rpcUrl.slice(0, 40)}...`);
  return { connection, wallet };
}

function getConnection() { return connection; }
function getWallet() { return wallet; }

async function getSOLBalance() {
  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    try {
      const balance = await connection.getBalance(wallet.publicKey);
      return balance / 1e9;
    } catch (e) {
      console.error(`Balance error (RPC ${currentRpcIndex}): ${e.message}`);
      rotateRpc();
    }
  }
  return 0;
}

async function executeTrade(action, mintAddress, amountSOL) {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`💱 ${action.toUpperCase()} ${mintAddress.slice(0, 8)}... ${amountSOL} SOL (attempt ${i + 1})`);

      const response = await axios.post(
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
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'arraybuffer',
          timeout: 15000,
        }
      );

      if (response.status !== 200) throw new Error(`PumpPortal error: ${response.status}`);

      const txBuffer = Buffer.from(response.data);
      let transaction;
      try {
        transaction = VersionedTransaction.deserialize(txBuffer);
        transaction.sign([wallet]);
      } catch {
        transaction = Transaction.from(txBuffer);
        transaction.sign(wallet);
      }

      const txid = await connection.sendRawTransaction(
        transaction instanceof VersionedTransaction ? transaction.serialize() : transaction.serialize(),
        { skipPreflight: true, maxRetries: 2 }
      );

      const confirmation = await connection.confirmTransaction(txid, 'confirmed');
      if (confirmation.value?.err) throw new Error(`TX failed: ${JSON.stringify(confirmation.value.err)}`);

      console.log(`✅ ${action} confirmed: ${txid}`);
      return { success: true, txid };

    } catch (e) {
      console.error(`Trade attempt ${i + 1} failed: ${e.message}`);
      if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return { success: false, error: 'All retries failed' };
}

async function buyToken(mintAddress, amountUSD, solPrice) {
  const solAmount = parseFloat((amountUSD / solPrice).toFixed(6));
  return executeTrade('buy', mintAddress, solAmount);
}

async function sellToken(mintAddress, percentToSell) {
  // Use a tiny amount for sells since PumpPortal handles percentage internally
  // We sell by sending the full position using 'sell' action
  return executeTrade('sell', mintAddress, percentToSell / 100);
}

module.exports = { init, getConnection, getWallet, getSOLBalance, buyToken, sellToken };