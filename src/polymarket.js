/**
 * Polymarket CLOB API integration.
 * Docs: https://docs.polymarket.com
 *
 * SECURITY NOTE: The wallet private key is only read from process.env at runtime
 * and is never logged, stored, or transmitted outside of transaction signing.
 */

import axios from 'axios';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const CLOB_BASE = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';

// ── HTTP client ───────────────────────────────────────────────────────────────

const clob = axios.create({
  baseURL: CLOB_BASE,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

// ── Wallet setup ──────────────────────────────────────────────────────────────

/**
 * Generate a brand-new random Ethereum/Polygon wallet.
 * Returns { address, privateKey } — privateKey has no 0x prefix.
 * The caller is responsible for encrypting and storing the private key.
 */
export function generateWallet() {
  const wallet = ethers.Wallet.createRandom();
  const privateKey = wallet.privateKey.startsWith('0x')
    ? wallet.privateKey.slice(2)
    : wallet.privateKey;
  return { address: wallet.address, privateKey };
}

/**
 * Build an ethers.Wallet from a raw private key string.
 * Accepts an explicit key, or falls back to WALLET_PRIVATE_KEY env var.
 * The key is never logged.
 */
export function buildWallet(rawPrivateKey = null) {
  const key = rawPrivateKey || process.env.WALLET_PRIVATE_KEY;
  if (!key) throw new Error('No private key available. Set WALLET_PRIVATE_KEY or use /setkey.');
  const normalized = key.startsWith('0x') ? key : `0x${key}`;
  return new ethers.Wallet(normalized);
}

// ── Market fetching ───────────────────────────────────────────────────────────

/**
 * Fetch active markets, optionally filtered by keyword.
 * Returns array of market objects.
 */
export async function fetchActiveMarkets(keyword = '') {
  try {
    const url = keyword
      ? `${GAMMA_BASE}/markets?active=true&closed=false&limit=50&q=${encodeURIComponent(keyword)}`
      : `${GAMMA_BASE}/markets?active=true&closed=false&limit=50`;

    const { data } = await axios.get(url, { timeout: 10000 });
    const markets = Array.isArray(data) ? data : (data.markets || []);

    return markets.map(m => {
      // Gamma API uses clobTokenIds[0]=YES, clobTokenIds[1]=NO
      // outcomePrices[0]=YES price, outcomePrices[1]=NO price (as strings)
      const tokenIds = Array.isArray(m.clobTokenIds) ? m.clobTokenIds : [];
      const prices   = Array.isArray(m.outcomePrices) ? m.outcomePrices.map(p => parseFloat(p)) : [];

      return {
        id:          m.id || m.conditionId,
        slug:        m.slug,
        question:    m.question,
        description: m.description,
        endDate:     m.endDateIso || m.endDate,
        volume:      parseFloat(m.volumeNum  || m.volume   || 0),
        liquidity:   parseFloat(m.liquidityNum || m.liquidity || 0),
        volume24h:   parseFloat(m.volume24hr || 0),
        // Normalised token fields used by the rest of the codebase
        yesTokenId:  tokenIds[0] || null,
        noTokenId:   tokenIds[1] || null,
        yesPrice:    prices[0]   || 0,
        noPrice:     prices[1]   || 0,
        // Built-in price change fields from Gamma API (absolute change in YES price)
        change1h:    parseFloat(m.oneHourPriceChange  || 0),
        change1d:    parseFloat(m.oneDayPriceChange   || 0),
        change1w:    parseFloat(m.oneWeekPriceChange  || 0),
        lastPrice:   parseFloat(m.lastTradePrice      || 0),
        bestBid:     parseFloat(m.bestBid             || 0),
        bestAsk:     parseFloat(m.bestAsk             || 0),
        // Keep tokens array for backwards compat — map from clobTokenIds + outcomes
        tokens: tokenIds.map((tid, i) => ({
          token_id: tid,
          outcome:  (m.outcomes || ['YES','NO'])[i] || (i === 0 ? 'YES' : 'NO'),
          price:    prices[i] || 0,
        })),
      };
    });
  } catch (err) {
    console.error('[Polymarket] fetchActiveMarkets error:', err.message);
    return [];
  }
}

/**
 * Fetch a single market's current orderbook/prices.
 * Returns { tokenId, yesPrice, noPrice } or null.
 */
export async function fetchMarketPrices(tokenId) {
  try {
    const { data } = await clob.get(`/last-trade-price?token_id=${tokenId}`);
    return {
      tokenId,
      price: parseFloat(data.price || 0),
    };
  } catch (err) {
    console.error(`[Polymarket] fetchMarketPrices error for ${tokenId}:`, err.message);
    return null;
  }
}

/**
 * Fetch recent price history for a token (last N trades).
 */
export async function fetchPriceHistory(tokenId, limit = 20) {
  try {
    const { data } = await clob.get(`/prices-history?token_id=${tokenId}&interval=1h&fidelity=1`);
    const history = Array.isArray(data.history) ? data.history : [];
    return history.slice(-limit).map(h => ({
      timestamp: h.t,
      price: parseFloat(h.p),
    }));
  } catch (err) {
    console.error(`[Polymarket] fetchPriceHistory error for ${tokenId}:`, err.message);
    return [];
  }
}

/**
 * Detect price drift over a time window (in minutes).
 * Returns { driftPct, direction } or null.
 */
export async function detectPriceDrift(tokenId, windowMinutes = 15) {
  const history = await fetchPriceHistory(tokenId, 50);
  if (history.length < 2) return null;

  const cutoff = Date.now() / 1000 - windowMinutes * 60;
  const windowPrices = history.filter(h => h.timestamp >= cutoff);
  if (windowPrices.length < 2) return null;

  const oldest = windowPrices[0].price;
  const newest = windowPrices[windowPrices.length - 1].price;
  if (oldest === 0) return null;

  const driftPct = ((newest - oldest) / oldest) * 100;
  return {
    driftPct: parseFloat(driftPct.toFixed(2)),
    direction: driftPct > 0 ? 'UP' : 'DOWN',
    from: oldest,
    to: newest,
  };
}

// ── Wallet balance ────────────────────────────────────────────────────────────

/**
 * Fetch the USDC balance for a wallet on Polygon.
 * @param {string|null} privateKey  - raw private key, or null to use env key
 * Returns balance as a float.
 */
export async function getWalletBalance(privateKey = null) {
  try {
    const wallet = buildWallet(privateKey);
    const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
    const abi = ['function balanceOf(address) view returns (uint256)'];
    const contract = new ethers.Contract(USDC_POLYGON, abi, provider);
    const raw = await contract.balanceOf(wallet.address);
    return parseFloat(ethers.formatUnits(raw, 6));
  } catch (err) {
    console.error('[Polymarket] getWalletBalance error:', err.message);
    return 0;
  }
}

/**
 * Return the public wallet address for a given private key (or env key).
 * Safe to display — does not expose the private key.
 */
export function getWalletAddress(privateKey = null) {
  try {
    return buildWallet(privateKey).address;
  } catch {
    return null;
  }
}

// ── Order placement ───────────────────────────────────────────────────────────

/**
 * Build and sign a CLOB limit order.
 * side: 'BUY' (YES) | 'SELL' (NO)
 * Returns the signed order object.
 */
function buildOrderSignature(tokenId, side, price, size, privateKey = null) {
  const wallet = buildWallet(privateKey);
  // Simplified order payload — in production, use Polymarket's order builder SDK
  const orderData = {
    salt: Date.now().toString(),
    maker: wallet.address,
    signer: wallet.address,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId,
    makerAmount: (size * 1e6).toFixed(0),        // USDC in micro-units
    takerAmount: (size / price * 1e6).toFixed(0), // shares
    expiration: Math.floor(Date.now() / 1000) + 3600,
    nonce: Date.now().toString(),
    feeRateBps: '0',
    side: side === 'BUY' ? 0 : 1,
    signatureType: 0,
  };

  // Sign the order hash
  const orderHash = ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'uint256', 'uint256', 'uint256'],
    [orderData.salt, orderData.maker, orderData.makerAmount, orderData.takerAmount, orderData.expiration]
  );

  const signature = wallet.signingKey.sign(orderHash);
  return {
    ...orderData,
    signature: ethers.Signature.from(signature).serialized,
  };
}

/**
 * Place a limit order on Polymarket CLOB.
 * @param {string} tokenId    - The token ID for the outcome
 * @param {string} outcome    - 'YES' or 'NO'
 * @param {number} price      - Price between 0 and 1 (e.g. 0.65 = 65 cents)
 * @param {number} size       - USDC amount to spend
 * @param {string|null} privateKey - User's private key, or null for env key
 * @returns {{ success, orderId, message }}
 */
export async function placeOrder(tokenId, outcome, price, size, privateKey = null) {
  try {
    const wallet = buildWallet(privateKey);
    const side = outcome === 'YES' ? 'BUY' : 'SELL';
    const signedOrder = buildOrderSignature(tokenId, side, price, size, privateKey);

    const { data } = await clob.post('/order', {
      order: signedOrder,
      owner: wallet.address,
      orderType: 'GTC', // Good Till Cancelled
    });

    return {
      success: true,
      orderId: data.orderId || data.orderID || 'unknown',
      message: data.message || 'Order placed successfully',
    };
  } catch (err) {
    console.error('[Polymarket] placeOrder error:', err.message);
    return {
      success: false,
      orderId: null,
      message: err.response?.data?.message || err.message,
    };
  }
}

/**
 * Cancel an open order by orderId.
 */
export async function cancelOrder(orderId, privateKey = null) {
  try {
    const wallet = buildWallet(privateKey);
    const { data } = await clob.delete(`/order/${orderId}`, {
      headers: { 'POLY_ADDRESS': wallet.address },
    });
    return { success: true, message: data.message || 'Cancelled' };
  } catch (err) {
    console.error('[Polymarket] cancelOrder error:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Fetch all open orders for the wallet address.
 */
export async function getOpenOrders(privateKey = null) {
  try {
    const wallet = buildWallet(privateKey);
    const { data } = await clob.get(`/orders?maker_address=${wallet.address}&status=LIVE`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[Polymarket] getOpenOrders error:', err.message);
    return [];
  }
}

/**
 * Search for a football or stock market on Polymarket by keyword.
 * Returns the best matching market with its YES token details.
 */
export async function findMarket(keyword) {
  const markets = await fetchActiveMarkets(keyword);
  if (markets.length === 0) return null;

  // Return the most liquid matching market
  const sorted = markets.sort((a, b) => b.liquidity - a.liquidity);
  const market = sorted[0];

  const yesToken = market.tokens.find(t =>
    t.outcome?.toUpperCase() === 'YES'
  ) || market.tokens[0];

  const noToken = market.tokens.find(t =>
    t.outcome?.toUpperCase() === 'NO'
  ) || market.tokens[1];

  return {
    ...market,
    yesTokenId: yesToken?.token_id,
    noTokenId: noToken?.token_id,
    yesPrice: parseFloat(yesToken?.price || 0),
    noPrice: parseFloat(noToken?.price || 0),
  };
}
