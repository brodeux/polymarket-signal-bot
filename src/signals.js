/**
 * Central signal orchestrator.
 * Combines football and stock signals, scores confidence,
 * cross-references Polymarket odds, and broadcasts via Telegram.
 */

import { generateFootballSignals } from './football.js';
import { generateStockSignals } from './stocks.js';
import { generateCryptoSignals } from './crypto.js';
import { scanAllCategories, scanCategory } from './markets.js';
import { findMarket, detectPriceDrift, getWalletBalance, placeOrder } from './polymarket.js';
import { getTradeAmount, canTrade, recordOpenPosition } from './tradeManager.js';
import { getAllUsers, setPaused, getUserPrivateKey, userHasKey } from './userConfig.js';
import { recordSignal } from './signalStore.js';

// ── Message formatters ────────────────────────────────────────────────────────

/**
 * Format a signal for the public channel broadcast.
 * Handles all signal types: FOOTBALL, STOCK, CRYPTO, MARKET.
 * Does NOT include per-user trade details — those go to individual DMs.
 */
export function formatSignalMessage(signal) {
  const confidenceEmoji = { High: '🟢', Medium: '🟡', Low: '🔴' }[signal.confidence] || '⚪';

  // Build the header label based on signal type
  let typeLabel;
  if (signal.type === 'FOOTBALL') {
    typeLabel = `⚽ ${signal.homeTeam} vs ${signal.awayTeam}`;
  } else if (signal.type === 'STOCK') {
    typeLabel = `📈 ${signal.ticker}`;
  } else if (signal.type === 'CRYPTO') {
    typeLabel = `🪙 ${signal.ticker}`;
  } else if (signal.type === 'MARKET') {
    typeLabel = `${signal.categoryEmoji} ${signal.categoryLabel}`;
  } else {
    typeLabel = signal.marketQuery || 'Unknown';
  }

  // Build price / odds line
  let priceLine;
  if (signal.type === 'MARKET') {
    const yesPct = signal.yesPrice ? `${(signal.yesPrice * 100).toFixed(0)}¢` : '—';
    const noPct  = signal.noPrice  ? `${(signal.noPrice  * 100).toFixed(0)}¢` : '—';
    priceLine = `💰 Odds: YES ${yesPct}  NO ${noPct}`;
  } else if (signal.currentPrice != null) {
    const fmt = signal.currentPrice >= 1000
      ? signal.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : signal.currentPrice.toFixed(2);
    priceLine = `💰 Current Price: $${fmt}`;
  } else {
    priceLine = `💰 Market Odds: see Polymarket`;
  }

  // Market question for MARKET type (truncate long questions)
  const questionLine = signal.type === 'MARKET'
    ? `❓ ${signal.question.length > 80 ? signal.question.slice(0, 77) + '...' : signal.question}`
    : null;

  const tradeNote = signal.confidence === 'Low'
    ? `🤖 Signal only — confidence too low to auto-trade`
    : `🤖 Auto trading at ${signal.confidence === 'High' ? 'full' : 'half'} size for eligible users`;

  return [
    `📊 *NEW SIGNAL — ${typeLabel}*`,
    questionLine,
    `⏱ Timeframe: ${signal.timeframe}`,
    `📌 Position: ${signal.side}`,
    priceLine,
    `🎯 Confidence: ${confidenceEmoji} ${signal.confidence}`,
    `📈 Reasoning: ${signal.reasoning}`,
    tradeNote,
  ].filter(Boolean).join('\n');
}

/**
 * Format a trade confirmation message.
 */
export function formatTradeConfirmation(trade) {
  return [
    `✅ *TRADE PLACED*`,
    `🏷 Market: ${trade.marketName}`,
    `📌 Position: ${trade.side}`,
    `💵 Amount: $${trade.amount.toFixed(2)} USDC`,
    `📊 Odds at entry: ${trade.entryOdds.toFixed(3)}`,
    `🏆 Potential payout: $${trade.potentialPayout.toFixed(2)}`,
    `💼 Remaining budget: $${trade.remainingBudget.toFixed(2)}`,
  ].join('\n');
}

// ── Trade execution ───────────────────────────────────────────────────────────

/**
 * Attempt to place a trade for a signal on behalf of a user.
 * Returns a tradeResult object describing what happened.
 */
async function attemptTrade(user, signal, market) {
  const tradeAmount = getTradeAmount(user.userId, signal.confidence);

  if (tradeAmount === 0) {
    return { skipped: true, reason: 'confidence too low — signal only, no trade placed' };
  }

  // Resolve the private key for this user (their own key, or env fallback)
  const privateKey = getUserPrivateKey(user.userId) || process.env.WALLET_PRIVATE_KEY || null;
  if (!privateKey) {
    return { skipped: true, reason: 'no wallet configured — use /setkey to add your private key' };
  }

  const walletBalance = await getWalletBalance(privateKey);
  const check = canTrade(user.userId, tradeAmount, walletBalance);

  if (!check.allowed) {
    if (check.pauseTrading) setPaused(user.userId, true);
    return {
      skipped: true,
      reason: check.reason,
      pauseTriggered: !!check.pauseTrading,
      noCreditsTriggered: !!check.noCredits,
    };
  }

  // MARKET-type signals already carry their token IDs and prices directly
  const tokenId = signal.side === 'YES'
    ? (signal.yesTokenId || market?.yesTokenId)
    : (signal.noTokenId  || market?.noTokenId);
  const entryOdds = signal.side === 'YES'
    ? (signal.yesPrice || market?.yesPrice || 0)
    : (signal.noPrice  || market?.noPrice  || 0);

  if (!tokenId || entryOdds <= 0) {
    return { skipped: true, reason: 'no valid token or zero odds for this market' };
  }

  const orderResult = await placeOrder(tokenId, signal.side, entryOdds, tradeAmount, privateKey);

  if (!orderResult.success) {
    return { skipped: false, placed: false, reason: orderResult.message };
  }

  const potentialPayout = tradeAmount / entryOdds;

  recordOpenPosition(user.userId, {
    marketId: market.id,
    marketName: market.question,
    side: signal.side,
    amount: tradeAmount,
    entryOdds,
    potentialPayout,
    orderId: orderResult.orderId,
  });

  return {
    placed: true,
    skipped: false,
    amount: tradeAmount,
    marketName: market.question,
    side: signal.side,
    entryOdds,
    potentialPayout,
    orderId: orderResult.orderId,
    walletBalance,
    remainingBudget: walletBalance - tradeAmount,
  };
}

// ── Main signal processor ─────────────────────────────────────────────────────

/**
 * Process an array of signals:
 * 1. Cross-reference each signal with Polymarket for odds drift
 * 2. For each active user: evaluate trade logic and optionally place order
 * 3. Return array of { signal, market, tradeResults[] } for broadcasting
 */
export async function processSignals(signals) {
  const users = getAllUsers();
  const results = [];

  for (const signal of signals) {
    let market = null;
    let driftData = null;

    try {
      if (signal.type === 'MARKET') {
        // MARKET signals already have all token/price data from markets.js — no lookup needed
        market = {
          id:         signal.marketId,
          question:   signal.question,
          yesTokenId: signal.yesTokenId,
          noTokenId:  signal.noTokenId,
          yesPrice:   signal.yesPrice,
          noPrice:    signal.noPrice,
        };
        driftData = { driftPct: signal.driftPct, direction: signal.driftDir };
      } else {
        // For FOOTBALL, STOCK, CRYPTO — find the market on Polymarket
        market = await findMarket(signal.marketQuery);

        // Cross-reference: boost confidence if Polymarket odds have also moved
        if (market?.yesTokenId) {
          driftData = await detectPriceDrift(market.yesTokenId, 15);
          if (driftData && Math.abs(driftData.driftPct) > 10) {
            signal.factors.push(
              `Polymarket odds drifted ${driftData.driftPct > 0 ? '+' : ''}${driftData.driftPct}% in 15min`
            );
            if (signal.confidence === 'Low' && signal.factors.length >= 2) signal.confidence = 'Medium';
            else if (signal.confidence === 'Medium' && signal.factors.length >= 3) signal.confidence = 'High';
            signal.reasoning = signal.factors.join('; ');
          }
        }
      }
    } catch (err) {
      console.error('[Signals] market lookup error:', err.message);
    }

    // Attempt trades for all eligible users
    const tradeResults = [];
    for (const user of users) {
      let tradeResult = null;
      if (user.autoTradeEnabled && !user.paused && market) {
        try {
          tradeResult = await attemptTrade(user, signal, market);
        } catch (err) {
          console.error(`[Signals] trade attempt error for user ${user.userId}:`, err.message);
          tradeResult = { skipped: true, reason: `Internal error: ${err.message}` };
        }
      } else if (!market) {
        tradeResult = { skipped: true, reason: 'No matching Polymarket found' };
      } else if (user.paused) {
        tradeResult = { skipped: true, reason: 'Paused — limit reached' };
      } else {
        tradeResult = { skipped: true, reason: 'Auto trading disabled' };
      }
      tradeResults.push({ user, tradeResult });
    }

    // Persist to signal store so Mini App can display it
    recordSignal(signal);

    results.push({ signal, market, driftData, tradeResults });
  }

  return results;
}

/**
 * Run a full signal cycle: generate all signals and process them.
 * Returns processed results for broadcasting.
 */
/**
 * mode options:
 *   'stocks'        — TSLA + NVDA only
 *   'crypto'        — BTC, ETH, SOL only
 *   'football'      — live football matches only
 *   'markets'       — Polymarket category scan (politics, sports, world, entertainment)
 *   'all'           — full hourly scan: stocks + crypto + football (live+upcoming) + markets
 */
export async function runSignalCycle(mode = 'all') {
  const allSignals = [];

  try {
    if (mode === 'stocks' || mode === 'all') {
      const stockSignals = await generateStockSignals();
      allSignals.push(...stockSignals);
    }

    if (mode === 'crypto' || mode === 'all') {
      const cryptoSignals = await generateCryptoSignals();
      allSignals.push(...cryptoSignals);
    }

    if (mode === 'football' || mode === 'all') {
      const footballMode = mode === 'football' ? 'live' : 'all';
      const footballSignals = await generateFootballSignals(footballMode);
      allSignals.push(...footballSignals);
    }

    if (mode === 'markets' || mode === 'all') {
      // Scan politics, sports, world events, entertainment on Polymarket
      const marketSignals = await scanAllCategories(['politics', 'sports', 'world', 'entertainment', 'crypto']);
      allSignals.push(...marketSignals);
    }
  } catch (err) {
    console.error('[Signals] runSignalCycle generation error:', err.message);
  }

  if (allSignals.length === 0) return [];

  return processSignals(allSignals);
}
