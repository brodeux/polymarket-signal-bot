import { LowSync, JSONFileSync } from 'lowdb';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { encrypt, decrypt } from './encryption.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'users.json');

const defaultData = { users: {} };
const adapter = new JSONFileSync(dbPath);
const db = new LowSync(adapter, defaultData);

db.read();
// Initialize with defaults if file was empty or missing
if (!db.data) {
  db.data = defaultData;
  db.write();
}

function ensureUser(userId) {
  db.read();
  if (!db.data) { db.data = defaultData; }
  if (!db.data.users[userId]) {
    db.data.users[userId] = {
      userId,
      budget: parseFloat(process.env.DEFAULT_BUDGET) || 100,
      tradeSize: parseFloat(process.env.DEFAULT_TRADE_SIZE) || 5,
      maxDailyLoss: parseFloat(process.env.DEFAULT_MAX_DAILY_LOSS) || 20,
      autoTradeEnabled: false,
      paused: false,
      zapCredits: 100,
      walletAddress: null,
      referredBy: null,
      referrals: [],
      referralEarnings: 0,
      // Sniper settings
      marketType:      'all',  // '5min' | '15min' | '1hr' | 'all'
      targetAsset:     'all',  // 'BTC-USD' | 'ETH-USD' | 'SOL-USD' | 'politics' | 'sports' | 'football' | 'all'
      entryConfidence: 50,     // 0-100 minimum confidence % to enter
      stopLoss:        70,     // 0-100 emergency stop-loss % of budget
      entryTrigger:    30,     // seconds before market close to snipe (0 = any time)
      // Demo mode — paper trading with virtual funds
      demoMode:        true,   // on by default; user switches off when ready to go live
      demoBalance:     1000,   // virtual USDC balance for demo trades
      createdAt: new Date().toISOString(),
    };
    db.write();
  }
  return db.data.users[userId];
}

export function getUser(userId) {
  return ensureUser(userId);
}

export function setUserBudget(userId, amount) {
  ensureUser(userId);
  db.data.users[userId].budget = amount;
  db.write();
}

export function setUserTradeSize(userId, amount) {
  ensureUser(userId);
  db.data.users[userId].tradeSize = amount;
  db.write();
}

export function setUserMaxDailyLoss(userId, amount) {
  ensureUser(userId);
  db.data.users[userId].maxDailyLoss = amount;
  db.write();
}

export function setAutoTrade(userId, enabled) {
  ensureUser(userId);
  db.data.users[userId].autoTradeEnabled = enabled;
  db.write();
}

export function setPaused(userId, paused) {
  ensureUser(userId);
  db.data.users[userId].paused = paused;
  db.write();
}

export function getAllUsers() {
  db.read();
  if (!db.data) { db.data = defaultData; }
  return Object.values(db.data.users);
}

/**
 * Store a user's encrypted private key.
 * The raw key is never stored — only the encrypted form.
 */
export function setUserKey(userId, rawPrivateKey) {
  ensureUser(userId);
  // Normalise — strip 0x prefix if present
  const key = rawPrivateKey.startsWith('0x') ? rawPrivateKey.slice(2) : rawPrivateKey;
  db.data.users[userId].encryptedKey = encrypt(key);
  db.write();
}

/**
 * Returns the decrypted private key for a user, or null if not set.
 * Never log the return value of this function.
 */
export function getUserPrivateKey(userId) {
  db.read();
  if (!db.data) return null;
  const user = db.data.users[userId];
  if (!user?.encryptedKey) return null;
  try {
    return decrypt(user.encryptedKey);
  } catch {
    return null;
  }
}

/**
 * Remove a user's stored private key.
 */
export function removeUserKey(userId) {
  db.read();
  if (!db.data?.users[userId]) return;
  delete db.data.users[userId].encryptedKey;
  db.write();
}

/**
 * Returns true if the user has a stored private key.
 */
export function userHasKey(userId) {
  db.read();
  if (!db.data) return false;
  return !!db.data.users[userId]?.encryptedKey;
}

// ── Wallet address ────────────────────────────────────────────────────────────

/**
 * Store the wallet address (public) for quick display without key decryption.
 */
export function setUserWalletAddress(userId, address) {
  ensureUser(userId);
  db.data.users[userId].walletAddress = address;
  db.write();
}

export function getUserWalletAddress(userId) {
  db.read();
  if (!db.data) return null;
  return db.data.users[userId]?.walletAddress || null;
}

// ── Zap Credits ───────────────────────────────────────────────────────────────

export function getZapCredits(userId) {
  const user = ensureUser(userId);
  return user.zapCredits ?? 100;
}

export function deductZapCredit(userId) {
  ensureUser(userId);
  const current = db.data.users[userId].zapCredits ?? 100;
  db.data.users[userId].zapCredits = Math.max(0, current - 1);
  db.write();
  return db.data.users[userId].zapCredits;
}

export function addZapCredits(userId, amount) {
  ensureUser(userId);
  db.data.users[userId].zapCredits = (db.data.users[userId].zapCredits ?? 0) + amount;
  db.write();
  return db.data.users[userId].zapCredits;
}

// ── Demo mode ─────────────────────────────────────────────────────────────────

export function setDemoMode(userId, enabled) {
  ensureUser(userId);
  db.data.users[userId].demoMode = enabled;
  // Auto-refill virtual balance when enabling demo
  if (enabled && (db.data.users[userId].demoBalance ?? 0) < 10) {
    db.data.users[userId].demoBalance = 1000;
  }
  db.write();
}

export function getDemoBalance(userId) {
  const user = ensureUser(userId);
  return user.demoBalance ?? 1000;
}

export function adjustDemoBalance(userId, delta) {
  ensureUser(userId);
  const current = db.data.users[userId].demoBalance ?? 1000;
  db.data.users[userId].demoBalance = Math.max(0, parseFloat((current + delta).toFixed(2)));
  db.write();
  return db.data.users[userId].demoBalance;
}

// ── Sniper settings ───────────────────────────────────────────────────────────

export function setSniperSettings(userId, { marketType, targetAsset, entryConfidence, stopLoss, entryTrigger, tradeSize } = {}) {
  ensureUser(userId);
  const u = db.data.users[userId];
  if (marketType      !== undefined) u.marketType      = marketType;
  if (targetAsset     !== undefined) u.targetAsset     = targetAsset;
  if (entryConfidence !== undefined) u.entryConfidence = Math.max(0, Math.min(100, entryConfidence));
  if (stopLoss        !== undefined) u.stopLoss        = Math.max(0, Math.min(100, stopLoss));
  if (entryTrigger    !== undefined) u.entryTrigger    = Math.max(0, entryTrigger);
  if (tradeSize       !== undefined) u.tradeSize       = Math.max(1, tradeSize);
  db.write();
}

export function getSniperSettings(userId) {
  const u = ensureUser(userId);
  return {
    marketType:      u.marketType      ?? 'all',
    targetAsset:     u.targetAsset     ?? 'all',
    entryConfidence: u.entryConfidence ?? 50,
    stopLoss:        u.stopLoss        ?? 70,
    entryTrigger:    u.entryTrigger    ?? 30,
    tradeSize:       u.tradeSize       ?? 5,
  };
}

// ── Referral system ───────────────────────────────────────────────────────────

/**
 * Record that newUserId was referred by referrerId.
 * No-op if already set (first-touch attribution).
 */
export function setReferredBy(newUserId, referrerId) {
  ensureUser(newUserId);
  if (!db.data.users[newUserId].referredBy) {
    db.data.users[newUserId].referredBy = referrerId;
    db.write();
  }
}

/**
 * Add newUserId to referrerId's referral list (deduped).
 */
export function addReferral(referrerId, newUserId) {
  ensureUser(referrerId);
  const list = db.data.users[referrerId].referrals ?? [];
  if (!list.includes(newUserId)) {
    list.push(newUserId);
    db.data.users[referrerId].referrals = list;
    db.write();
  }
}

/**
 * Return referral stats for a user.
 */
export function getReferralStats(userId) {
  db.read();
  if (!db.data) return { total: 0, active: 0, earnings: 0 };
  const user = db.data.users[userId];
  if (!user) return { total: 0, active: 0, earnings: 0 };

  const referrals = user.referrals ?? [];
  const active = referrals.filter(id => db.data.users[id]?.autoTradeEnabled).length;

  return {
    total: referrals.length,
    active,
    earnings: user.referralEarnings ?? 0,
  };
}
