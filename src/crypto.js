/**
 * Crypto signal generation — Bitcoin, Ethereum, Solana.
 * Data source: CoinGecko public API (free, no key required).
 * Rate limit: ~30 calls/minute on free tier.
 *
 * Signal logic mirrors stocks.js:
 *   - Price change over 1hr / 4hr / 24hr
 *   - RSI on 30min candles
 *   - Volume spike vs 7-day average
 *   - Cross-reference with Polymarket crypto market odds
 */

import axios from 'axios';
import { RSI } from 'technicalindicators';

const CG_BASE = 'https://api.coingecko.com/api/v3';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cgClient = axios.create({
  baseURL: CG_BASE,
  timeout: 15000,
  headers: { 'Accept': 'application/json' },
});

// ── Response cache (15 min TTL) ───────────────────────────────────────────────
// CoinGecko free tier rate-limits OHLC and market_chart endpoints aggressively.
// Cache responses so each endpoint is only hit once per 15-minute window.
const CACHE_TTL = 15 * 60 * 1000;
const _cache = {};

function cacheGet(key) {
  const entry = _cache[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

function cacheSet(key, data) {
  _cache[key] = { ts: Date.now(), data };
}

// Map from our ticker labels to CoinGecko coin IDs and Polymarket search terms
const COINS = [
  { ticker: 'BTC', id: 'bitcoin',  marketQuery: 'Bitcoin price' },
  { ticker: 'ETH', id: 'ethereum', marketQuery: 'Ethereum price' },
  { ticker: 'SOL', id: 'solana',   marketQuery: 'Solana price'   },
];

// ── Data fetching ─────────────────────────────────────────────────────────────

/**
 * Fetch current price, 24h change and 24h volume for all tracked coins.
 * Single request covers all three.
 */
async function fetchPrices() {
  try {
    const ids = COINS.map(c => c.id).join(',');
    const { data } = await cgClient.get('/simple/price', {
      params: {
        ids,
        vs_currencies: 'usd',
        include_24hr_change: true,
        include_24hr_vol: true,
        include_market_cap: true,
      },
    });
    return data;
  } catch (err) {
    console.error('[Crypto] fetchPrices error:', err.message);
    return {};
  }
}

/**
 * Fetch OHLC candle data for a coin.
 * days=1 → one data point every 30 minutes (~48 candles).
 * days=7 → one data point every 4 hours (~42 candles).
 * Returns array of { time, open, high, low, close }.
 */
async function fetchOHLC(coinId, days = 1) {
  const key = `ohlc_${coinId}_${days}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    await sleep(1000); // extra breathing room before hitting the endpoint
    const { data } = await cgClient.get(`/coins/${coinId}/ohlc`, {
      params: { vs_currency: 'usd', days },
    });
    // CoinGecko returns [[timestamp, open, high, low, close], ...]
    const result = (data || []).map(c => ({
      time:  c[0],
      open:  c[1],
      high:  c[2],
      low:   c[3],
      close: c[4],
    }));
    cacheSet(key, result);
    return result;
  } catch (err) {
    console.error(`[Crypto] fetchOHLC error for ${coinId}:`, err.message);
    return [];
  }
}

/**
 * Fetch daily volume history (7 days) to establish average volume baseline.
 * Returns average daily volume in USD.
 */
async function fetchAvgVolume(coinId) {
  const key = `avgvol_${coinId}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  try {
    await sleep(1000);
    const { data } = await cgClient.get(`/coins/${coinId}/market_chart`, {
      params: { vs_currency: 'usd', days: 7, interval: 'daily' },
    });
    const volumes = (data.total_volumes || []).map(v => v[1]);
    const avg = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
    cacheSet(key, avg);
    return avg;
  } catch (err) {
    console.error(`[Crypto] fetchAvgVolume error for ${coinId}:`, err.message);
    return 0;
  }
}

// ── Technical indicators ──────────────────────────────────────────────────────

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const values = RSI.calculate({ period, values: closes });
  return values.length > 0 ? values[values.length - 1] : null;
}

/**
 * Price change % between candle at index -(lookback+1) and the last candle.
 */
function priceChangePct(candles, lookback) {
  if (candles.length < lookback + 1) return 0;
  const old = candles[candles.length - 1 - lookback].close;
  const now = candles[candles.length - 1].close;
  return old > 0 ? ((now - old) / old) * 100 : 0;
}

// ── Signal generation ─────────────────────────────────────────────────────────

async function analyseCoin(coin, priceData) {
  const meta = priceData[coin.id];
  if (!meta) return null;

  const currentPrice  = meta.usd;
  const change24h     = meta.usd_24h_change || 0;
  const volume24h     = meta.usd_24h_vol   || 0;

  // Fetch 30min candles (1 day) for short-term RSI + 1hr/4hr momentum
  await sleep(600);
  const candles30m = await fetchOHLC(coin.id, 1);
  await sleep(600);
  const candles4h  = await fetchOHLC(coin.id, 7); // 7 days → ~4hr candles
  await sleep(600);
  const avgVolume  = await fetchAvgVolume(coin.id);

  if (candles30m.length < 10) return null;

  const closes30m = candles30m.map(c => c.close);
  const closes4h  = candles4h.map(c => c.close);

  const rsi30m = calculateRSI(closes30m, 14);
  const rsi4h  = calculateRSI(closes4h, 14);

  // ~1hr change: last 2 × 30min candles
  const change1h = priceChangePct(candles30m, 2);
  // ~4hr change: last candle vs 4 candles ago
  const change4h = priceChangePct(candles4h, 1);
  // Volume spike: 24h volume vs 7-day daily average
  const volumeSpike = avgVolume > 0 && volume24h > avgVolume * 1.4;

  const factors = [];
  let bullish = 0;
  let bearish = 0;
  let dominantTimeframe = '1hr';

  // Factor 1: Short-term 1hr price move with volume
  if (change1h > 2 && volumeSpike) {
    factors.push(`${coin.ticker} up ${change1h.toFixed(2)}% in 1hr with volume spike`);
    bullish++;
  } else if (change1h < -2 && volumeSpike) {
    factors.push(`${coin.ticker} down ${Math.abs(change1h).toFixed(2)}% in 1hr with volume spike`);
    bearish++;
  }

  // Factor 2: RSI on 30min chart
  if (rsi30m !== null) {
    if (rsi30m < 30) {
      factors.push(`RSI (30m) oversold at ${rsi30m.toFixed(1)}`);
      bullish++;
    } else if (rsi30m > 70) {
      factors.push(`RSI (30m) overbought at ${rsi30m.toFixed(1)}`);
      bearish++;
    }
  }

  // Factor 3: RSI on 4hr chart
  if (rsi4h !== null) {
    if (rsi4h < 35) {
      factors.push(`RSI (4h) oversold at ${rsi4h.toFixed(1)}`);
      bullish++;
      dominantTimeframe = '4hr';
    } else if (rsi4h > 65) {
      factors.push(`RSI (4h) overbought at ${rsi4h.toFixed(1)}`);
      bearish++;
      dominantTimeframe = '4hr';
    }
  }

  // Factor 4: Strong 4hr momentum
  if (change4h > 4) {
    factors.push(`Strong 4hr momentum: +${change4h.toFixed(2)}%`);
    bullish++;
    dominantTimeframe = '4hr';
  } else if (change4h < -4) {
    factors.push(`Strong 4hr decline: ${change4h.toFixed(2)}%`);
    bearish++;
    dominantTimeframe = '4hr';
  }

  // Factor 5: Significant 24hr move
  if (Math.abs(change24h) > 6) {
    if (change24h > 0) {
      factors.push(`Up ${change24h.toFixed(2)}% in last 24hrs`);
      bullish++;
    } else {
      factors.push(`Down ${Math.abs(change24h).toFixed(2)}% in last 24hrs`);
      bearish++;
    }
  }

  if (factors.length === 0) {
    factors.push(`No strong signal for ${coin.ticker} at $${currentPrice.toLocaleString()}`);
  }

  const isBullish = bullish >= bearish;
  const signalStrength = Math.max(bullish, bearish);

  let confidence;
  if (signalStrength >= 3) confidence = 'High';
  else if (signalStrength === 2) confidence = 'Medium';
  else confidence = 'Low';

  return {
    type: 'CRYPTO',
    ticker: coin.ticker,
    coinId: coin.id,
    side: isBullish ? 'YES' : 'NO',
    confidence,
    factors,
    reasoning: factors.join('; '),
    timeframe: dominantTimeframe,
    currentPrice,
    change1h:  parseFloat(change1h.toFixed(2)),
    change4h:  parseFloat(change4h.toFixed(2)),
    change24h: parseFloat(change24h.toFixed(2)),
    rsi30m: rsi30m != null ? parseFloat(rsi30m.toFixed(1)) : null,
    rsi4h:  rsi4h  != null ? parseFloat(rsi4h.toFixed(1))  : null,
    volumeSpike,
    direction:   isBullish ? 'bullish' : 'bearish',
    marketQuery: coin.marketQuery,
  };
}

/**
 * Generate signals for BTC, ETH and SOL.
 * Fetches prices in one call then analyses each coin sequentially.
 */
export async function generateCryptoSignals() {
  const signals = [];

  try {
    const priceData = await fetchPrices();
    if (!Object.keys(priceData).length) {
      console.log('[Crypto] No price data returned from CoinGecko');
      return signals;
    }

    for (const coin of COINS) {
      await sleep(800); // stay within CoinGecko free tier rate limit
      const signal = await analyseCoin(coin, priceData);
      if (signal) signals.push(signal);
    }
  } catch (err) {
    console.error('[Crypto] generateCryptoSignals error:', err.message);
  }

  return signals;
}
