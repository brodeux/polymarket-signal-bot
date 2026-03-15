/**
 * Persistent signal store.
 * Records every processed signal to data/signals.json so both the bot
 * process and the web/Mini App server can read it.
 * Keeps the most recent MAX_SIGNALS entries.
 */

import { LowSync, JSONFileSync } from 'lowdb';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const dbPath      = path.join(__dirname, '..', 'data', 'signals.json');
const MAX_SIGNALS = 100;

const defaultData = { signals: [] };
const adapter     = new JSONFileSync(dbPath);
const db          = new LowSync(adapter, defaultData);

db.read();
if (!db.data) { db.data = defaultData; db.write(); }

// ── Emoji helpers ─────────────────────────────────────────────────────────────

const TYPE_EMOJI = { FOOTBALL: '⚽', STOCK: '📈', CRYPTO: '🪙', MARKET: '📊' };

function categoryEmoji(signal) {
  if (signal.categoryEmoji) return signal.categoryEmoji;
  return TYPE_EMOJI[signal.type] || '📊';
}

function categoryLabel(signal) {
  if (signal.categoryLabel) return signal.categoryLabel;
  const map = { FOOTBALL: 'Football', STOCK: 'Stocks', CRYPTO: 'Crypto', MARKET: 'Markets' };
  return map[signal.type] || signal.type;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist a signal.  Called from signals.js for every processed signal.
 */
export function recordSignal(signal) {
  try {
    db.read();
    if (!db.data) db.data = defaultData;

    const entry = {
      id:            `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      recordedAt:    new Date().toISOString(),
      type:          signal.type,
      category:      signal.category      || null,
      categoryLabel: categoryLabel(signal),
      categoryEmoji: categoryEmoji(signal),
      question:      signal.question      || signal.marketQuery || '',
      side:          signal.side,
      confidence:    signal.confidence,
      driftPct:      signal.driftPct      ?? 0,
      driftDir:      signal.driftDir      || null,
      yesPrice:      signal.yesPrice      ?? 0,
      noPrice:       signal.noPrice       ?? 0,
      reasoning:     signal.reasoning     || '',
      timeframe:     signal.timeframe     || '—',
      ticker:        signal.ticker        || null,
      currentPrice:  signal.currentPrice  || null,
    };

    db.data.signals.unshift(entry);
    if (db.data.signals.length > MAX_SIGNALS) {
      db.data.signals = db.data.signals.slice(0, MAX_SIGNALS);
    }
    db.write();
  } catch (err) {
    console.error('[SignalStore] recordSignal error:', err.message);
  }
}

/**
 * Return the most recent signals, newest first.
 */
export function getRecentSignals(limit = 30) {
  try {
    db.read();
    return (db.data?.signals || []).slice(0, limit);
  } catch {
    return [];
  }
}
