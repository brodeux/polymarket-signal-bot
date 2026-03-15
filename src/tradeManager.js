import { LowSync, JSONFileSync } from 'lowdb';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUser, setPaused, getZapCredits, deductZapCredit } from './userConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'trades.json');

const defaultData = {
  openPositions: [],
  closedTrades: [],
  dailyStats: {},
};

const adapter = new JSONFileSync(dbPath);
const db = new LowSync(adapter, defaultData);
db.read();
// Initialize with defaults if file was empty or missing
if (!db.data) {
  db.data = defaultData;
  db.write();
}

// ── Daily stats helpers ───────────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getDailyStats(userId) {
  db.read();
  if (!db.data) { db.data = defaultData; }
  const key = `${userId}:${todayKey()}`;
  if (!db.data.dailyStats[key]) {
    db.data.dailyStats[key] = {
      userId,
      date: todayKey(),
      tradesPlaced: 0,
      totalSpent: 0,
      wins: 0,
      losses: 0,
      netPnl: 0,
    };
    db.write();
  }
  return db.data.dailyStats[key];
}

// ── Trade size by confidence ──────────────────────────────────────────────────

export function getTradeAmount(userId, confidence) {
  const user = getUser(userId);
  if (confidence === 'High') return user.tradeSize;
  if (confidence === 'Medium') return user.tradeSize / 2;
  return 0; // Low — signal only, no trade
}

// ── Pre-trade validation ──────────────────────────────────────────────────────

export function canTrade(userId, tradeAmount, walletBalance) {
  const user = getUser(userId);
  const stats = getDailyStats(userId);

  if (user.paused) {
    return { allowed: false, reason: 'Bot is paused. Use /resume to restart.' };
  }

  if (!user.autoTradeEnabled) {
    return { allowed: false, reason: 'Auto trading is disabled. Use /autotrade on.' };
  }

  if (tradeAmount <= 0) {
    return { allowed: false, reason: 'Confidence too low — signal only, no trade placed.' };
  }

  if (walletBalance < tradeAmount) {
    return {
      allowed: false,
      reason: `Wallet balance ($${walletBalance.toFixed(2)}) is below trade size ($${tradeAmount.toFixed(2)}). Auto trading paused.`,
      pauseTrading: true,
    };
  }

  // Check daily loss limit
  const dailyLoss = Math.abs(Math.min(stats.netPnl, 0));
  if (dailyLoss >= user.maxDailyLoss) {
    return {
      allowed: false,
      reason: `Daily loss limit of $${user.maxDailyLoss} reached. Auto trading paused. Use /resume to restart.`,
      pauseTrading: true,
    };
  }

  // Check total open exposure vs budget
  const openExposure = getTotalOpenExposure(userId);
  if (openExposure + tradeAmount > user.budget) {
    return {
      allowed: false,
      reason: `Trade would exceed budget. Open exposure: $${openExposure.toFixed(2)}, Budget: $${user.budget.toFixed(2)}.`,
    };
  }

  // Check Zap Credits
  if (getZapCredits(userId) <= 0) {
    return {
      allowed: false,
      reason: 'No Zap Credits remaining. Use /buycredits to top up and resume auto trading.',
      noCredits: true,
    };
  }

  return { allowed: true };
}

// ── Open positions ────────────────────────────────────────────────────────────

export function getTotalOpenExposure(userId) {
  db.read();
  if (!db.data) { db.data = defaultData; }
  return db.data.openPositions
    .filter(p => p.userId === userId)
    .reduce((sum, p) => sum + p.amount, 0);
}

export function getOpenPositions(userId) {
  db.read();
  return db.data.openPositions.filter(p => p.userId === userId);
}

export function recordOpenPosition(userId, position) {
  db.read();
  const stats = getDailyStats(userId);

  db.data.openPositions.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId,
    marketId: position.marketId,
    marketName: position.marketName,
    side: position.side,       // 'YES' | 'NO'
    amount: position.amount,
    entryOdds: position.entryOdds,
    potentialPayout: position.potentialPayout,
    orderId: position.orderId || null,
    openedAt: new Date().toISOString(),
  });

  stats.tradesPlaced++;
  stats.totalSpent += position.amount;
  db.write();

  // Deduct one Zap Credit for this trade
  deductZapCredit(userId);
}

export function resolvePosition(positionId, outcome) {
  db.read();
  const idx = db.data.openPositions.findIndex(p => p.id === positionId);
  if (idx === -1) return null;

  const position = db.data.openPositions.splice(idx, 1)[0];
  const pnl = outcome === 'WIN'
    ? position.potentialPayout - position.amount
    : -position.amount;

  const closedTrade = {
    ...position,
    outcome,
    pnl,
    closedAt: new Date().toISOString(),
  };

  db.data.closedTrades.push(closedTrade);

  const stats = getDailyStats(position.userId);
  if (outcome === 'WIN') {
    stats.wins++;
  } else {
    stats.losses++;
  }
  stats.netPnl += pnl;

  db.write();
  return closedTrade;
}

// ── History ───────────────────────────────────────────────────────────────────

export function getTradeHistory(userId, limit = 10) {
  db.read();
  return db.data.closedTrades
    .filter(t => t.userId === userId)
    .slice(-limit)
    .reverse();
}

export function getDailySummary(userId) {
  return getDailyStats(userId);
}

// ── Daily reset (called at midnight UTC) ─────────────────────────────────────

export function resetDailyStats() {
  db.read();
  // Stats are keyed by date so old data is naturally excluded.
  // Just trim entries older than 30 days to prevent unbounded growth.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  for (const key of Object.keys(db.data.dailyStats)) {
    const date = db.data.dailyStats[key].date;
    if (new Date(date) < cutoff) {
      delete db.data.dailyStats[key];
    }
  }
  db.write();
}

export { getDailyStats };
