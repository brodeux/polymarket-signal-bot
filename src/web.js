/**
 * Static file server + Mini App REST API.
 * Serves /public on PORT (default 3000).
 * All /api/* routes require Telegram initData HMAC auth.
 */

import 'dotenv/config';
import http   from 'http';
import fs     from 'fs';
import path   from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import {
  getUser,
  userHasKey,
  getUserWalletAddress,
  getZapCredits,
  getReferralStats,
  setAutoTrade,
  setPaused,
  getSniperSettings,
  setSniperSettings,
} from './userConfig.js';
import { getOpenPositions, getDailyStats, getTradeHistory } from './tradeManager.js';
import { getWalletBalance } from './polymarket.js';
import { getUserPrivateKey } from './userConfig.js';
import { getRecentSignals } from './signalStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC    = path.join(__dirname, '..', 'public');
const PORT      = parseInt(process.env.WEB_PORT || '3000', 10);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_USERNAME = process.env.BOT_USERNAME || 'Polymkt_snipe_bot';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Telegram initData validation ──────────────────────────────────────────────
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

function validateInitData(initDataStr) {
  if (!initDataStr || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initDataStr);
    const hash   = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const expected = crypto.createHmac('sha256', secretKey)
      .update(checkString)
      .digest('hex');

    if (expected !== hash) return null;

    const userJson = params.get('user');
    return userJson ? JSON.parse(userJson) : null;
  } catch {
    return null;
  }
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function getInitDataFromReq(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('tma ')) return auth.slice(4);
  // Also accept as query param for GET requests (dev convenience)
  const url   = new URL(req.url, 'http://localhost');
  return url.searchParams.get('initData') || null;
}

// ── API route handlers ────────────────────────────────────────────────────────

async function handleMe(req, res, tgUser) {
  const uid = tgUser.id.toString();
  const user = getUser(uid);
  const stats = getDailyStats(uid);
  const openPositions = getOpenPositions(uid);
  const credits = getZapCredits(uid);
  const walletAddress = getUserWalletAddress(uid);
  const referralStats = getReferralStats(uid);
  const openExposure = openPositions.reduce((s, p) => s + p.amount, 0);

  let balance = 0;
  try {
    const pk = getUserPrivateKey(uid);
    if (pk) balance = await getWalletBalance(pk);
  } catch { /* non-fatal */ }

  json(res, 200, {
    userId: uid,
    firstName: tgUser.first_name || '',
    username: tgUser.username || '',
    wallet: {
      address: walletAddress || null,
      balance,
      openExposure,
      available: Math.max(0, balance - openExposure),
    },
    trading: {
      autoTradeEnabled: user.autoTradeEnabled,
      paused: user.paused,
      budget: user.budget,
      tradeSize: user.tradeSize,
      maxDailyLoss: user.maxDailyLoss,
    },
    zapCredits: credits,
    stats: {
      date: stats.date,
      tradesPlaced: stats.tradesPlaced,
      wins: stats.wins,
      losses: stats.losses,
      netPnl: stats.netPnl,
    },
    positions: openPositions,
    referral: {
      link: `https://t.me/${BOT_USERNAME}?start=${uid}`,
      total: referralStats.total,
      active: referralStats.active,
      earnings: referralStats.earnings,
    },
  });
}

async function handleHistory(req, res, tgUser) {
  const uid = tgUser.id.toString();
  const trades = getTradeHistory(uid, 20);
  json(res, 200, { trades });
}

async function handleAutoTrade(req, res, tgUser) {
  const uid = tgUser.id.toString();
  const body = await readBody(req);
  const enable = !!body.enabled;

  if (enable) {
    setPaused(uid, false);
  }
  setAutoTrade(uid, enable);

  const user = getUser(uid);
  json(res, 200, {
    autoTradeEnabled: user.autoTradeEnabled,
    paused: user.paused,
  });
}

async function handleSettings(req, res, tgUser) {
  const uid = tgUser.id.toString();
  if (req.method === 'GET') {
    return json(res, 200, getSniperSettings(uid));
  }
  // POST — save settings
  const body = await readBody(req);
  const VALID_MARKET_TYPES  = ['5min', '15min', '1hr', 'all'];
  const VALID_TARGET_ASSETS = ['all', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'politics', 'sports', 'football', 'crypto'];
  const update = {};
  if (VALID_MARKET_TYPES.includes(body.marketType))   update.marketType      = body.marketType;
  if (VALID_TARGET_ASSETS.includes(body.targetAsset)) update.targetAsset     = body.targetAsset;
  if (typeof body.entryConfidence === 'number')       update.entryConfidence = body.entryConfidence;
  if (typeof body.stopLoss        === 'number')       update.stopLoss        = body.stopLoss;
  if (typeof body.entryTrigger    === 'number')       update.entryTrigger    = body.entryTrigger;
  if (typeof body.tradeSize       === 'number')       update.tradeSize       = body.tradeSize;
  setSniperSettings(uid, update);
  return json(res, 200, getSniperSettings(uid));
}

async function handleSignals(req, res) {
  const url   = new URL(req.url, 'http://localhost');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 100);
  const signals = getRecentSignals(limit);
  json(res, 200, { signals });
}

// Credit packages — must match bot.js
const CREDIT_PACKAGES = {
  100:  { stars: 50,   label: '100 Zap Credits'   },
  500:  { stars: 200,  label: '500 Zap Credits'   },
  1000: { stars: 350,  label: '1,000 Zap Credits' },
  5000: { stars: 1500, label: '5,000 Zap Credits' },
};

async function handleBuyCredits(req, res, tgUser) {
  const url = new URL(req.url, 'http://localhost');
  const pkg = parseInt(url.searchParams.get('package') || '100', 10);
  const pack = CREDIT_PACKAGES[pkg];

  if (!pack) return json(res, 400, { error: 'Invalid package' });

  // Create invoice link via Telegram Bot API (native fetch, Node 18+)
  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title:          `${pack.label} — Polymarket Snipe Bot`,
      description:    `Fuel ${pkg.toLocaleString()} automated trades. Credits added instantly after payment.`,
      payload:        JSON.stringify({ userId: tgUser.id.toString(), credits: pkg }),
      provider_token: '',
      currency:       'XTR',
      prices:         [{ label: pack.label, amount: pack.stars }],
    }),
  });

  const data = await tgRes.json();
  if (!data.ok) return json(res, 502, { error: data.description || 'Telegram API error' });

  json(res, 200, { invoiceLink: data.result, package: pkg, stars: pack.stars });
}

// ── Router ────────────────────────────────────────────────────────────────────

async function handleApi(req, res) {
  const url    = new URL(req.url, 'http://localhost');
  const route  = url.pathname;
  const method = req.method.toUpperCase();

  // CORS pre-flight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // /api/signals is public (no auth needed — signals are not user-specific)
  if (route === '/api/signals' && method === 'GET') return handleSignals(req, res);

  // All other routes require auth
  const initDataStr = getInitDataFromReq(req);
  const tgUser = validateInitData(initDataStr);

  if (!tgUser) {
    return json(res, 401, { error: 'Unauthorized — invalid or missing initData' });
  }

  if (route === '/api/me'          && method === 'GET')  return handleMe(req, res, tgUser);
  if (route === '/api/history'     && method === 'GET')  return handleHistory(req, res, tgUser);
  if (route === '/api/autotrade'   && method === 'POST') return handleAutoTrade(req, res, tgUser);
  if (route === '/api/settings'    && (method === 'GET' || method === 'POST')) return handleSettings(req, res, tgUser);
  if (route === '/api/buy-credits' && method === 'GET')  return handleBuyCredits(req, res, tgUser);

  json(res, 404, { error: 'Not found' });
}

// ── Static file handler ───────────────────────────────────────────────────────

function handleStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = path.join(PUBLIC, urlPath);
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    try { await handleApi(req, res); }
    catch (err) {
      console.error('[Web] API error:', err.message);
      json(res, 500, { error: 'Internal server error' });
    }
  } else {
    handleStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`[Web] Mini App server running on http://localhost:${PORT}`);
});
