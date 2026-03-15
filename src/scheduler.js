/**
 * Automated scheduling for signal cycles and daily resets.
 *
 * Schedule:
 *   Every 5 min  — stock signals (TSLA, NVDA)
 *   Every 15 min — live football match signals
 *   Every 1 hr   — full market scan (all football + stocks)
 *   Midnight UTC — daily reset + summary
 */

import cron from 'node-cron';
import { runSignalCycle, formatSignalMessage, formatTradeConfirmation } from './signals.js';
import { resetDailyStats, getDailyStats, getOpenPositions } from './tradeManager.js';
import { getAllUsers, userHasKey } from './userConfig.js';

// Bot instance is injected after Telegraf is set up in bot.js
let _bot = null;

export function setBotInstance(bot) {
  _bot = bot;
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

async function broadcast(text) {
  if (!_bot) return;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return;

  try {
    await _bot.telegram.sendMessage(channelId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[Scheduler] broadcast error:', err.message);
  }
}

async function sendToUser(userId, text) {
  if (!_bot) return;
  try {
    await _bot.telegram.sendMessage(userId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`[Scheduler] sendToUser error for ${userId}:`, err.message);
  }
}

// ── Signal cycle runner ───────────────────────────────────────────────────────

export async function runCycle(mode) {
  const label = mode.toUpperCase();
  console.log(`[Scheduler] Running ${label} signal cycle at ${new Date().toISOString()}`);

  let results;
  try {
    results = await runSignalCycle(mode);
  } catch (err) {
    console.error(`[Scheduler] ${label} cycle error:`, err.message);
    return;
  }

  if (!results || results.length === 0) {
    console.log(`[Scheduler] ${label} cycle — no signals generated`);
    return;
  }

  for (const { signal, tradeResults } of results) {
    // Broadcast signal to the public channel — no per-user trade details
    const signalMsg = formatSignalMessage(signal);
    await broadcast(signalMsg);

    // Send per-user DMs: trade confirmations, pause alerts, wallet warnings
    for (const { user, tradeResult: tr } of tradeResults) {

      // Zap Credits exhausted — notify user
      if (tr?.noCreditsTriggered) {
        await sendToUser(
          user.userId,
          `⚡ *Zap Credits depleted!*\nAuto trading paused — you have 0 Zap Credits left.\nUse /buycredits to top up and keep your sniper running.`
        );
      }

      // Trade placed — send private confirmation to this user
      if (tr?.placed) {
        const openPositions = getOpenPositions(user.userId);
        const openExposure = openPositions.reduce((s, p) => s + p.amount, 0);
        const remainingBudget = user.budget - openExposure;

        const confirmMsg = formatTradeConfirmation({
          marketName: tr.marketName,
          side: tr.side,
          amount: tr.amount,
          entryOdds: tr.entryOdds,
          potentialPayout: tr.potentialPayout,
          remainingBudget,
        });
        await sendToUser(user.userId, confirmMsg);
      }

      // Daily loss limit hit — pause and alert this user
      if (tr?.pauseTriggered) {
        const freshUser = getAllUsers().find(u => u.userId === user.userId);
        await sendToUser(
          user.userId,
          `⚠️ *Daily loss limit of $${freshUser?.maxDailyLoss ?? 0} reached.*\nAuto trading has been paused for your account. Use /resume to restart.`
        );
      }

      // Wallet balance too low — alert this user only
      if (tr?.reason?.includes('Wallet balance')) {
        await sendToUser(user.userId, `⚠️ ${tr.reason}\nAuto trading paused. Top up your wallet and use /resume.`);
      }
    }
  }
}

// ── Daily summary ─────────────────────────────────────────────────────────────

async function sendDailySummaries() {
  const users = getAllUsers();
  for (const user of users) {
    // Only send summaries to users who have registered a wallet
    if (!userHasKey(user.userId)) continue;
    try {
      const stats = getDailyStats(user.userId);
      const openPositions = getOpenPositions(user.userId);
      const openExposure = openPositions.reduce((s, p) => s + p.amount, 0);

      const msg = [
        `📅 *Daily Summary — ${stats.date}*`,
        ``,
        `📊 Trades placed: ${stats.tradesPlaced}`,
        `✅ Wins: ${stats.wins}`,
        `❌ Losses: ${stats.losses}`,
        `💰 Net PnL: ${stats.netPnl >= 0 ? '+' : ''}$${stats.netPnl.toFixed(2)} USDC`,
        `📂 Open positions: ${openPositions.length} ($${openExposure.toFixed(2)} exposure)`,
        ``,
        `Auto trading resumes fresh tomorrow. Use /status to review your settings.`,
      ].join('\n');
      await sendToUser(user.userId, msg);
    } catch (err) {
      console.error(`[Scheduler] daily summary error for user ${user.userId}:`, err.message);
    }
  }
}

// ── Cron jobs ─────────────────────────────────────────────────────────────────

export function startScheduler() {
  // Every 5 minutes — 5min sniper picks (markets closing within 5 min)
  cron.schedule('*/5 * * * *', async () => {
    await runCycle('5min');
  }, { timezone: 'UTC' });

  // Every 15 minutes — crypto + stocks + football + 15min sniper picks
  cron.schedule('*/15 * * * *', async () => {
    await runCycle('crypto');
    await runCycle('stocks');
    await runCycle('football');
    await runCycle('15min');
  }, { timezone: 'UTC' });

  // Every 30 minutes — Polymarket category scan + football markets + 1hr sniper picks
  cron.schedule('*/30 * * * *', async () => {
    await runCycle('markets');
    await runCycle('football_markets');
    await runCycle('1hr');
  }, { timezone: 'UTC' });

  // Every hour — full market scan (all sources combined)
  cron.schedule('0 * * * *', async () => {
    await runCycle('all');
  }, { timezone: 'UTC' });

  // Midnight UTC — daily reset + summary
  cron.schedule('0 0 * * *', async () => {
    console.log('[Scheduler] Midnight reset running...');
    await sendDailySummaries();
    resetDailyStats();
    console.log('[Scheduler] Daily stats reset complete.');
  }, { timezone: 'UTC' });

  console.log('[Scheduler] All cron jobs started.');
}
