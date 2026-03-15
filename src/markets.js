/**
 * Polymarket Category Scanner
 * Monitors all major market categories by reading price change data
 * directly from the Gamma API — no CLOB API calls needed.
 *
 * The Gamma API returns oneHourPriceChange, oneDayPriceChange etc.
 * on every market, so we detect significant odds movements without
 * any extra round trips.
 *
 * Categories:
 *   politics      — elections, legislation, political outcomes
 *   sports        — NBA, NFL, UFC, tennis, cricket, any Polymarket sport
 *   world         — geopolitics, economics, science, weather
 *   entertainment — awards, pop culture, celebrity events
 *   crypto        — BTC/ETH/SOL and other on-chain price markets
 */

import axios from 'axios';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Category definitions ──────────────────────────────────────────────────────

export const MARKET_CATEGORIES = {
  politics: {
    label:    'Politics & Elections',
    emoji:    '🗳️',
    tagSlug:  'politics',
    keywords: ['election', 'president', 'senate', 'congress', 'vote', 'minister', 'parliament'],
  },
  sports: {
    label:    'Sports',
    emoji:    '🏆',
    tagSlug:  'sports',
    keywords: ['NBA', 'NFL', 'UFC', 'Super Bowl', 'Champions League', 'World Cup', 'tennis', 'cricket', 'MLB', 'NHL'],
  },
  world: {
    label:    'World Events',
    emoji:    '🌍',
    tagSlug:  'news',
    keywords: ['war', 'GDP', 'inflation', 'recession', 'Fed', 'climate', 'sanctions', 'tariff', 'earthquake'],
  },
  entertainment: {
    label:    'Entertainment',
    emoji:    '🎬',
    tagSlug:  'pop-culture',
    keywords: ['Oscar', 'Grammy', 'Emmy', 'award', 'box office', 'celebrity', 'movie'],
  },
  crypto: {
    label:    'Crypto Markets',
    emoji:    '🪙',
    tagSlug:  'crypto',
    keywords: ['Bitcoin', 'Ethereum', 'Solana', 'BTC', 'ETH', 'SOL', 'crypto'],
  },
  football_markets: {
    label:    'Football',
    emoji:    '⚽',
    tagSlug:  'soccer',
    keywords: ['Premier League', 'Champions League', 'La Liga', 'Bundesliga', 'Serie A', 'FIFA', 'UEFA', 'World Cup'],
  },
};

// ── Market fetching ───────────────────────────────────────────────────────────

/**
 * Normalise a raw Gamma API market object into our standard shape.
 */
function normaliseMarket(m) {
  const tokenIds = Array.isArray(m.clobTokenIds)  ? m.clobTokenIds  : [];
  const prices   = Array.isArray(m.outcomePrices) ? m.outcomePrices.map(p => parseFloat(p) || 0) : [];
  const outcomes = m.outcomes || ['YES', 'NO'];

  const yesPrice = prices[0] > 0 ? prices[0] : 0;
  // Binary markets: YES + NO ≈ 1.0. Derive noPrice if the API didn't return it.
  const noPrice  = prices[1] > 0 ? prices[1] : (yesPrice > 0 ? parseFloat((1 - yesPrice).toFixed(4)) : 0);

  return {
    id:        m.id || m.conditionId,
    question:  m.question,
    slug:      m.slug,
    endDate:   m.endDateIso || m.endDate,
    liquidity: parseFloat(m.liquidityNum || m.liquidity || 0),
    volume:    parseFloat(m.volumeNum    || m.volume    || 0),
    volume24h: parseFloat(m.volume24hr   || 0),
    yesTokenId: tokenIds[0] || null,
    noTokenId:  tokenIds[1] || null,
    yesPrice,
    noPrice,
    // Built-in price change fields (absolute change in YES price, e.g. 0.08 = 8 cent move)
    change1h:  parseFloat(m.oneHourPriceChange  || 0),
    change1d:  parseFloat(m.oneDayPriceChange   || 0),
    change1w:  parseFloat(m.oneWeekPriceChange  || 0),
    lastPrice: parseFloat(m.lastTradePrice || 0),
    outcomes,
  };
}

/**
 * Fetch top active markets for a category, sorted by volume.
 * Tries tag_slug first, falls back to keyword searches.
 */
async function fetchMarketsByCategory(categoryKey, limit = 20) {
  const cat = MARKET_CATEGORIES[categoryKey];
  if (!cat) return [];

  let raw = [];

  // Try tag_slug filter
  try {
    const { data } = await axios.get(`${GAMMA_BASE}/markets`, {
      params: { active: true, closed: false, tag_slug: cat.tagSlug, limit: 50 },
      timeout: 10000,
    });
    raw = Array.isArray(data) ? data : (data.markets || []);
  } catch (err) {
    console.error(`[Markets] tag fetch error (${categoryKey}):`, err.message);
  }

  // Keyword fallback if tag returned nothing
  if (raw.length === 0) {
    for (const keyword of cat.keywords.slice(0, 3)) {
      try {
        await sleep(300);
        const { data } = await axios.get(`${GAMMA_BASE}/markets`, {
          params: { active: true, closed: false, q: keyword, limit: 30 },
          timeout: 10000,
        });
        const results = Array.isArray(data) ? data : (data.markets || []);
        raw.push(...results);
      } catch (err) {
        console.error(`[Markets] keyword search error ("${keyword}"):`, err.message);
      }
    }
  }

  // Deduplicate and sort by 24h volume (most traded markets = most relevant signals)
  const seen = new Set();
  return raw
    .filter(m => { const id = m.id || m.conditionId; if (seen.has(id)) return false; seen.add(id); return true; })
    .sort((a, b) => parseFloat(b.volume24hr || 0) - parseFloat(a.volume24hr || 0))
    .slice(0, limit)
    .map(normaliseMarket);
}

// ── Signal generation ─────────────────────────────────────────────────────────

/**
 * Convert a normalised market's built-in price change data into a signal.
 *
 * Thresholds (absolute YES price change):
 *   High   — |change1h| >= 0.15  (15 cent move in 1hr)
 *   Medium — |change1h| >= 0.08  (8 cent move in 1hr)
 *   Low    — |change1d| >= 0.12  (12 cent move in 24hr, but 1hr quiet)
 *
 * Returns null if no threshold met.
 */
function marketToSignal(market, categoryKey) {
  const cat = MARKET_CATEGORIES[categoryKey];
  const abs1h = Math.abs(market.change1h);
  const abs1d = Math.abs(market.change1d);

  let confidence, timeframe, changePct;

  if (abs1h >= 0.15) {
    confidence = 'High';
    timeframe  = '1hr';
    changePct  = market.change1h;
  } else if (abs1h >= 0.08) {
    confidence = 'Medium';
    timeframe  = '1hr';
    changePct  = market.change1h;
  } else if (abs1d >= 0.12) {
    confidence = 'Low';
    timeframe  = '24hr';
    changePct  = market.change1d;
  } else {
    return null; // no signal
  }

  // Direction: positive change = YES becoming more likely → bet YES
  //            negative change = YES drifting down → NO is rising → bet NO
  const side = changePct > 0 ? 'YES' : 'NO';
  const absPct = Math.abs(changePct * 100).toFixed(1);
  // For YES signals: YES price surged. For NO signals: NO price surged (inverse of YES drop).
  const signalSidePrice = side === 'YES' ? market.yesPrice : market.noPrice;
  const dirWord = side === 'YES' ? 'surged' : 'rose';

  const reasoning = [
    `${side} price ${dirWord} ${absPct}¢ in ${timeframe}`,
    `Current: YES ${(market.yesPrice * 100).toFixed(0)}¢  NO ${(market.noPrice * 100).toFixed(0)}¢`,
    `24h vol: $${(market.volume24h / 1000).toFixed(0)}k`,
  ].join(' | ');

  return {
    type:           'MARKET',
    category:       categoryKey,
    categoryLabel:  cat.label,
    categoryEmoji:  cat.emoji,
    marketId:       market.id,
    marketQuery:    market.question,
    question:       market.question,
    side,
    confidence,
    factors:        [`${side} price ${dirWord} ${absPct}¢ in ${timeframe}`],
    reasoning,
    timeframe,
    driftPct:       parseFloat((changePct * 100).toFixed(2)),
    driftDir:       changePct > 0 ? 'UP' : 'DOWN',
    yesPrice:       market.yesPrice,
    noPrice:        market.noPrice,
    yesTokenId:     market.yesTokenId,
    noTokenId:      market.noTokenId,
    liquidity:      market.liquidity,
    volume24h:      market.volume24h,
    endDate:        market.endDate,
  };
}

// ── Main scanner ──────────────────────────────────────────────────────────────

/**
 * Scan one category and return signals for markets with notable price moves.
 */
export async function scanCategory(categoryKey, marketsToCheck = 15) {
  const cat = MARKET_CATEGORIES[categoryKey];
  if (!cat) return [];

  let markets;
  try {
    markets = await fetchMarketsByCategory(categoryKey, marketsToCheck);
  } catch (err) {
    console.error(`[Markets] scanCategory error (${categoryKey}):`, err.message);
    return [];
  }

  if (!markets.length) {
    console.log(`[Markets] No active markets for: ${categoryKey}`);
    return [];
  }

  console.log(`[Markets] Scanning ${markets.length} ${cat.label} markets...`);

  const signals = [];
  for (const market of markets) {
    if (!market.yesTokenId) continue; // skip markets with no order book
    const signal = marketToSignal(market, categoryKey);
    if (!signal) continue;

    // For NO signals: if the market only published one token ID, we can't trade NO
    if (signal.side === 'NO' && !market.noTokenId) {
      console.log(`[Markets] Skipping NO signal (no NO token ID): ${market.question.slice(0, 55)}`);
      continue;
    }

    signals.push(signal);
    console.log(`[Markets] ${signal.confidence} ${signal.side} signal: ${signal.question.slice(0, 55)} (${signal.driftPct > 0 ? '+' : ''}${signal.driftPct}¢)`);
  }

  return signals;
}

/**
 * Run a full scan across all (or a subset of) categories.
 */
export async function scanAllCategories(categories = Object.keys(MARKET_CATEGORIES)) {
  const allSignals = [];

  for (const cat of categories) {
    try {
      const signals = await scanCategory(cat, 15);
      allSignals.push(...signals);
      await sleep(400);
    } catch (err) {
      console.error(`[Markets] scanAllCategories error (${cat}):`, err.message);
    }
  }

  return allSignals;
}
