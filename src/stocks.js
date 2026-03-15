/**
 * Stock signal generation for Tesla (TSLA) and Nvidia (NVDA).
 *
 * Data source: Yahoo Finance (free, no API key required).
 * Polygon.io is retained in .env for potential future use but Yahoo Finance
 * is used here as it provides full intraday candles on the free tier.
 */

import axios from 'axios';
import { RSI } from 'technicalindicators';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const YF_BASE = 'https://query1.finance.yahoo.com';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const yfClient = axios.create({
  baseURL: YF_BASE,
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

// Simple in-memory response cache — avoids hammering Yahoo Finance
const _cache = new Map();

async function cachedGet(url, params) {
  const key = url + JSON.stringify(params);
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;
  const { data } = await yfClient.get(url, { params });
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

// ── Data fetching ─────────────────────────────────────────────────────────────

/**
 * Fetch OHLCV candles from Yahoo Finance.
 * @param {string} ticker   - e.g. 'TSLA', 'NVDA'
 * @param {string} interval - '5m', '15m', '1h', '1d'
 * @param {string} range    - '1d', '5d', '1mo'
 */
export async function fetchCandles(ticker, interval = '5m', range = '1d') {
  try {
    const data = await cachedGet(
      `/v8/finance/chart/${ticker}`,
      { interval, range, includePrePost: false }
    );

    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps = result.timestamp || [];
    const ohlcv = result.indicators?.quote?.[0];
    if (!ohlcv || timestamps.length === 0) return [];

    return timestamps.map((t, i) => ({
      time: t * 1000,
      open:   ohlcv.open?.[i]   || 0,
      high:   ohlcv.high?.[i]   || 0,
      low:    ohlcv.low?.[i]    || 0,
      close:  ohlcv.close?.[i]  || 0,
      volume: ohlcv.volume?.[i] || 0,
    })).filter(c => c.close > 0);
  } catch (err) {
    console.error(`[Stocks] fetchCandles error for ${ticker} (${interval}/${range}):`, err.message);
    return [];
  }
}

/**
 * Fetch current quote for a ticker.
 * Returns { ticker, price, change, changePct, marketState } or null.
 */
export async function fetchQuote(ticker) {
  try {
    const data = await cachedGet(
      `/v8/finance/chart/${ticker}`,
      { interval: '1m', range: '1d' }
    );
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return {
      ticker,
      price: meta.regularMarketPrice || 0,
      prevClose: meta.chartPreviousClose || meta.previousClose || 0,
      marketState: meta.marketState || 'CLOSED',
    };
  } catch (err) {
    console.error(`[Stocks] fetchQuote error for ${ticker}:`, err.message);
    return null;
  }
}

// ── Technical indicators ──────────────────────────────────────────────────────

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const values = RSI.calculate({ period, values: closes });
  return values.length > 0 ? values[values.length - 1] : null;
}

function isVolumeIncreasing(candles) {
  if (candles.length < 5) return false;
  const recent = candles[candles.length - 1].volume;
  const avg = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, candles.length);
  return recent > avg * 1.2;
}

function priceChangePct(candles, lookback = 3) {
  if (candles.length < lookback + 1) return 0;
  const old = candles[candles.length - 1 - lookback].close;
  const now = candles[candles.length - 1].close;
  return old > 0 ? ((now - old) / old) * 100 : 0;
}

// ── Signal generation ─────────────────────────────────────────────────────────

async function analyseStock(ticker) {
  // Fetch all timeframes — small delay between calls to be polite
  const candles5m = await fetchCandles(ticker, '5m', '1d');
  await sleep(400);
  const candles15m = await fetchCandles(ticker, '15m', '5d');
  await sleep(400);
  const candles1h = await fetchCandles(ticker, '1h', '1mo');
  await sleep(400);
  const quote = await fetchQuote(ticker);

  const currentPrice = quote?.price
    || (candles5m.length > 0 ? candles5m[candles5m.length - 1].close : null);

  if (!currentPrice || candles5m.length < 10) {
    console.log(`[Stocks] Insufficient data for ${ticker} — skipping`);
    return null;
  }

  const closes5m = candles5m.map(c => c.close);
  const closes1h  = candles1h.map(c => c.close);

  const rsi5m = calculateRSI(closes5m, 14);
  const rsi1h  = calculateRSI(closes1h, 14);
  const changePct15m = priceChangePct(candles15m, 3);
  const changePct1h  = priceChangePct(candles1h, 1);
  const volumeSpike  = isVolumeIncreasing(candles5m);

  // Day change vs previous close
  const prevClose = quote?.prevClose || 0;
  const dayChangePct = prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0;

  const factors = [];
  let bullish = 0;
  let bearish = 0;
  let dominantTimeframe = '5min';

  // Factor 1: price up >1.5% in 15min with volume
  if (changePct15m > 1.5 && volumeSpike) {
    factors.push(`Price up ${changePct15m.toFixed(2)}% in 15min with volume spike`);
    bullish++;
    dominantTimeframe = '15min';
  } else if (changePct15m < -1.5 && volumeSpike) {
    factors.push(`Price down ${Math.abs(changePct15m).toFixed(2)}% in 15min with volume spike`);
    bearish++;
    dominantTimeframe = '15min';
  }

  // Factor 2: RSI on 5min
  if (rsi5m !== null) {
    if (rsi5m < 30) {
      factors.push(`RSI (5m) oversold at ${rsi5m.toFixed(1)}`);
      bullish++;
    } else if (rsi5m > 70) {
      factors.push(`RSI (5m) overbought at ${rsi5m.toFixed(1)}`);
      bearish++;
    }
  }

  // Factor 3: RSI on 1hr
  if (rsi1h !== null) {
    if (rsi1h < 35) {
      factors.push(`RSI (1h) oversold at ${rsi1h.toFixed(1)}`);
      bullish++;
      dominantTimeframe = '1hr';
    } else if (rsi1h > 65) {
      factors.push(`RSI (1h) overbought at ${rsi1h.toFixed(1)}`);
      bearish++;
      dominantTimeframe = '1hr';
    }
  }

  // Factor 4: 1hr momentum
  if (changePct1h > 2) {
    factors.push(`Strong 1hr momentum: +${changePct1h.toFixed(2)}%`);
    bullish++;
    dominantTimeframe = '1hr';
  } else if (changePct1h < -2) {
    factors.push(`Strong 1hr decline: ${changePct1h.toFixed(2)}%`);
    bearish++;
    dominantTimeframe = '1hr';
  }

  // Factor 5: significant day move not yet priced in
  if (Math.abs(dayChangePct) > 3) {
    if (dayChangePct > 0) {
      factors.push(`Up ${dayChangePct.toFixed(2)}% on the day`);
      bullish++;
    } else {
      factors.push(`Down ${Math.abs(dayChangePct).toFixed(2)}% on the day`);
      bearish++;
    }
  }

  if (factors.length === 0) {
    factors.push(`No strong technical signal for ${ticker} at $${currentPrice.toFixed(2)}`);
  }

  const isBullish = bullish >= bearish;
  const signalStrength = Math.max(bullish, bearish);

  let confidence;
  if (signalStrength >= 3) confidence = 'High';
  else if (signalStrength === 2) confidence = 'Medium';
  else confidence = 'Low';

  return {
    type: 'STOCK',
    ticker,
    side: isBullish ? 'YES' : 'NO',
    confidence,
    factors,
    reasoning: factors.join('; '),
    timeframe: dominantTimeframe,
    currentPrice,
    dayChangePct: parseFloat(dayChangePct.toFixed(2)),
    rsi5m:  rsi5m  != null ? parseFloat(rsi5m.toFixed(1))  : null,
    rsi1h:  rsi1h  != null ? parseFloat(rsi1h.toFixed(1))  : null,
    changePct15m: parseFloat(changePct15m.toFixed(2)),
    changePct1h:  parseFloat(changePct1h.toFixed(2)),
    volumeSpike,
    marketState: quote?.marketState || 'UNKNOWN',
    direction: isBullish ? 'bullish' : 'bearish',
    marketQuery: `${ticker} stock price`,
  };
}

/**
 * Generate signals for TSLA and NVDA.
 */
export async function generateStockSignals() {
  const signals = [];
  try {
    const tslaSignal = await analyseStock('TSLA');
    if (tslaSignal) signals.push(tslaSignal);

    await sleep(1000); // brief pause between tickers

    const nvdaSignal = await analyseStock('NVDA');
    if (nvdaSignal) signals.push(nvdaSignal);
  } catch (err) {
    console.error('[Stocks] generateStockSignals error:', err.message);
  }
  return signals;
}
