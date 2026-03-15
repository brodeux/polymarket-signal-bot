/**
 * Polymarket Snipe Bot
 * Main entry point — Telegraf bot with premium UI and all user commands.
 */

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import {
  getUser,
  setUserBudget,
  setUserTradeSize,
  setUserMaxDailyLoss,
  setAutoTrade,
  setPaused,
  setUserKey,
  removeUserKey,
  userHasKey,
  getUserPrivateKey,
  setUserWalletAddress,
  getUserWalletAddress,
  getZapCredits,
  addZapCredits,
  getReferralStats,
  setReferredBy,
  addReferral,
} from './userConfig.js';
import {
  getOpenPositions,
  getTradeHistory,
  getDailyStats,
} from './tradeManager.js';
import { getWalletBalance, getWalletAddress, generateWallet } from './polymarket.js';
import { setBotInstance, startScheduler } from './scheduler.js';

// ── Validation helpers ────────────────────────────────────────────────────────

function parsePositiveFloat(str) {
  const val = parseFloat(str);
  return Number.isFinite(val) && val > 0 ? val : null;
}

function userId(ctx) {
  return ctx.from?.id?.toString();
}

// ── Bot setup ─────────────────────────────────────────────────────────────────

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('[Bot] TELEGRAM_BOT_TOKEN is not set. Please configure your .env file.');
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const WEB_APP_URL = process.env.WEB_APP_URL || 'https://t.me/Polymkt_snipe_bot';

// ── /start ────────────────────────────────────────────────────────────────────

bot.start(async ctx => {
  const uid = userId(ctx);
  const isPrivate = ctx.chat.type === 'private';

  // ── Referral tracking ──────────────────────────────────────────────────────
  const referralParam = ctx.startPayload?.trim();
  if (referralParam && referralParam !== uid) {
    setReferredBy(uid, referralParam);
    addReferral(referralParam, uid);
  }

  // ── Auto wallet generation (first visit only) ──────────────────────────────
  const isNewWallet = !userHasKey(uid);
  if (isNewWallet) {
    try {
      const { address, privateKey } = generateWallet();
      setUserKey(uid, privateKey);
      setUserWalletAddress(uid, address);

      // DM the wallet details only in private chat; queue for later otherwise
      if (isPrivate) {
        await ctx.replyWithMarkdown(
          [
            `🏦 *Your Snipe Wallet Has Been Created!*`,
            ``,
            `📬 Address: \`${address}\``,
            `🔐 Key: Stored encrypted — never exposed`,
            ``,
            `*Fund your wallet to start trading:*`,
            `• Send *USDC* to the address above on the *Polygon* network`,
            `• Minimum recommended: $20 USDC`,
            ``,
            `⚠️ *Hot wallet warning:* This is an automated trading wallet. Only deposit funds you are prepared to trade with. Use /exportkey to back up your key.`,
          ].join('\n')
        );
      }
    } catch (err) {
      console.error('[Bot] Auto wallet generation error:', err.message);
    }
  }

  // ── Welcome message ────────────────────────────────────────────────────────
  const botUsername = ctx.botInfo?.username || 'PolymarketSnipeBot';
  const credits = getZapCredits(uid);
  const walletAddress = getUserWalletAddress(uid);

  const welcomeText = [
    `🎯 *Welcome to Polymarket Snipe Bot*`,
    ``,
    `Your fully automated trading engine for Polymarket!`,
    ``,
    `🏦 *Instant Wallet:* Auto-generates a secure trading wallet for you`,
    `⚡ *Auto-Sniper:* Executes trades on 5m/15m/1hr markets automatically`,
    `🛡 *Risk Shield:* Auto-claims winnings and triggers rapid stop-losses`,
    `💚 *Zap Credits:* Fuel your automated trading capacity`,
    `🤝 *Referrals:* Grow your squad and track your invites!`,
    ``,
    walletAddress
      ? `💼 Wallet: \`${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}\``
      : `💼 Wallet: Setting up...`,
    `⚡ Zap Credits: *${credits}* remaining`,
    ``,
    `Click below to launch your terminal!`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.webApp('🎯 Open Polymarket Snipe Bot', WEB_APP_URL)],
    [
      Markup.button.callback('🔗 Referral Hub', 'referral_hub'),
      Markup.button.url('🛡 Support', `https://t.me/${botUsername}`),
    ],
    [Markup.button.url('🌐 Launch Site', WEB_APP_URL)],
  ]);

  return ctx.replyWithMarkdown(welcomeText, keyboard);
});

// ── Inline keyboard callbacks ─────────────────────────────────────────────────

bot.action('referral_hub', async ctx => {
  await ctx.answerCbQuery();
  const uid = userId(ctx);
  const botUsername = ctx.botInfo?.username || 'PolymarketSnipeBot';
  const stats = getReferralStats(uid);
  const link = `https://t.me/${botUsername}?start=${uid}`;

  return ctx.replyWithMarkdown(
    [
      `🔗 *Your Referral Hub*`,
      ``,
      `🌐 Your link: \`${link}\``,
      ``,
      `👥 Total referrals: *${stats.total}*`,
      `✅ Active traders: *${stats.active}*`,
      `💰 Referral earnings: *$${stats.earnings.toFixed(2)}* USDC`,
      ``,
      `Share your link and earn rewards when your squad trades!`,
    ].join('\n')
  );
});

// ── /setbudget ────────────────────────────────────────────────────────────────

bot.command('setbudget', ctx => {
  const uid = userId(ctx);
  const args = ctx.message.text.split(' ');
  const amount = parsePositiveFloat(args[1]);

  if (!amount) {
    return ctx.reply('Usage: /setbudget [amount]\nExample: /setbudget 100');
  }
  if (amount < 10) {
    return ctx.reply('Minimum budget is $10 USDC.');
  }
  if (amount > 100000) {
    return ctx.reply('Maximum budget is $100,000 USDC.');
  }

  setUserBudget(uid, amount);
  return ctx.replyWithMarkdown(`✅ Budget set to *$${amount} USDC*.`);
});

// ── /settradesize ─────────────────────────────────────────────────────────────

bot.command('settradesize', ctx => {
  const uid = userId(ctx);
  const args = ctx.message.text.split(' ');
  const amount = parsePositiveFloat(args[1]);

  if (!amount) {
    return ctx.reply('Usage: /settradesize [amount]\nExample: /settradesize 5');
  }

  const user = getUser(uid);
  if (amount > user.budget) {
    return ctx.reply(`Trade size ($${amount}) cannot exceed your budget ($${user.budget}).`);
  }
  if (amount < 1) {
    return ctx.reply('Minimum trade size is $1 USDC.');
  }

  setUserTradeSize(uid, amount);
  return ctx.replyWithMarkdown(
    `✅ Trade size set to *$${amount} USDC*.\n` +
    `🟢 High confidence: $${amount}\n` +
    `🟡 Medium confidence: $${(amount / 2).toFixed(2)}\n` +
    `🔴 Low confidence: signal only, no trade`
  );
});

// ── /setmaxdailyloss ──────────────────────────────────────────────────────────

bot.command('setmaxdailyloss', ctx => {
  const uid = userId(ctx);
  const args = ctx.message.text.split(' ');
  const amount = parsePositiveFloat(args[1]);

  if (!amount) {
    return ctx.reply('Usage: /setmaxdailyloss [amount]\nExample: /setmaxdailyloss 20');
  }

  const user = getUser(uid);
  if (amount > user.budget) {
    return ctx.reply(`Daily loss limit ($${amount}) cannot exceed your budget ($${user.budget}).`);
  }

  setUserMaxDailyLoss(uid, amount);
  return ctx.replyWithMarkdown(`✅ Max daily loss set to *$${amount} USDC*. Auto trading will pause if this is reached.`);
});

// ── /autotrade ────────────────────────────────────────────────────────────────

bot.command('autotrade', ctx => {
  const uid = userId(ctx);
  const args = ctx.message.text.split(' ');
  const toggle = args[1]?.toLowerCase();

  if (toggle !== 'on' && toggle !== 'off') {
    return ctx.reply('Usage: /autotrade on  or  /autotrade off');
  }

  const enabled = toggle === 'on';

  if (enabled) {
    const credits = getZapCredits(uid);
    if (credits <= 0) {
      return ctx.replyWithMarkdown(
        '⚡ *No Zap Credits remaining.*\nTop up with /buycredits before enabling auto trading.'
      );
    }
    setPaused(uid, false);
  }

  setAutoTrade(uid, enabled);
  return ctx.replyWithMarkdown(
    enabled
      ? `✅ Auto trading *enabled*. Trades will be placed automatically when confidence is Medium or High.`
      : `⏸ Auto trading *disabled*. Signals will still be sent but no trades will be placed.`
  );
});

// ── /balance ──────────────────────────────────────────────────────────────────

bot.command('balance', async ctx => {
  const uid = userId(ctx);
  const privateKey = getUserPrivateKey(uid);

  if (!privateKey) {
    return ctx.replyWithMarkdown(
      '⚠️ No wallet found. Send /start to auto-generate one.'
    );
  }

  await ctx.reply('Fetching wallet balance...');

  try {
    const balance = await getWalletBalance(privateKey);
    const user = getUser(uid);
    const openPositions = getOpenPositions(uid);
    const openExposure = openPositions.reduce((s, p) => s + p.amount, 0);
    const address = getUserWalletAddress(uid) || getWalletAddress(privateKey);

    return ctx.replyWithMarkdown(
      [
        `💼 *Wallet Balance*`,
        `📬 Address: \`${address}\``,
        `💵 USDC Balance: *$${balance.toFixed(2)}*`,
        `📊 Open exposure: $${openExposure.toFixed(2)} (${openPositions.length} positions)`,
        `✅ Available to trade: *$${Math.max(0, balance - openExposure).toFixed(2)}*`,
        `🎯 Budget cap: $${user.budget.toFixed(2)}`,
        `⚡ Zap Credits: *${getZapCredits(uid)}*`,
      ].join('\n')
    );
  } catch (err) {
    console.error('[Bot] /balance error:', err.message);
    return ctx.reply('⚠️ Could not fetch wallet balance. Try /mywallet.');
  }
});

// ── /positions ────────────────────────────────────────────────────────────────

bot.command('positions', async ctx => {
  const uid = userId(ctx);
  const positions = getOpenPositions(uid);

  if (positions.length === 0) {
    return ctx.reply('You have no open positions.');
  }

  const lines = positions.map((p, i) => {
    const openedAgo = Math.round((Date.now() - new Date(p.openedAt).getTime()) / 60000);
    return [
      `*${i + 1}. ${p.marketName}*`,
      `   📌 ${p.side} | $${p.amount.toFixed(2)} @ ${p.entryOdds.toFixed(3)}`,
      `   🏆 Potential payout: $${p.potentialPayout.toFixed(2)}`,
      `   ⏱ Opened ${openedAgo}min ago`,
    ].join('\n');
  });

  const totalExposure = positions.reduce((s, p) => s + p.amount, 0);

  return ctx.replyWithMarkdown(
    [`📊 *Open Positions (${positions.length})*`, '', ...lines, '', `💵 Total exposure: $${totalExposure.toFixed(2)}`].join('\n')
  );
});

// ── /history ──────────────────────────────────────────────────────────────────

bot.command('history', ctx => {
  const uid = userId(ctx);
  const trades = getTradeHistory(uid, 10);

  if (trades.length === 0) {
    return ctx.reply('No closed trades yet.');
  }

  const lines = trades.map((t, i) => {
    const icon = t.outcome === 'WIN' ? '✅' : '❌';
    const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
    return `${icon} *${t.marketName}*\n   ${t.side} $${t.amount.toFixed(2)} → ${pnlStr}`;
  });

  return ctx.replyWithMarkdown(
    [`📜 *Last ${trades.length} Closed Trades*`, '', ...lines].join('\n')
  );
});

// ── /pause ────────────────────────────────────────────────────────────────────

bot.command('pause', ctx => {
  const uid = userId(ctx);
  setPaused(uid, true);
  return ctx.replyWithMarkdown('⏸ *Trading paused.* No signals or trades will be processed. Use /resume to restart.');
});

// ── /resume ───────────────────────────────────────────────────────────────────

bot.command('resume', ctx => {
  const uid = userId(ctx);
  setPaused(uid, false);
  return ctx.replyWithMarkdown('▶️ *Trading resumed.* Signals and auto trading are active again.');
});

// ── /status ───────────────────────────────────────────────────────────────────

bot.command('status', ctx => {
  const uid = userId(ctx);
  const user = getUser(uid);
  const stats = getDailyStats(uid);
  const openPositions = getOpenPositions(uid);
  const openExposure = openPositions.reduce((s, p) => s + p.amount, 0);

  const autoTradeStatus = user.autoTradeEnabled
    ? (user.paused ? '⏸ Paused' : '✅ Enabled')
    : '❌ Disabled';
  const walletStatus = userHasKey(uid) ? '🔐 Auto-generated & encrypted' : '❌ Not set — use /start';
  const credits = getZapCredits(uid);

  return ctx.replyWithMarkdown(
    [
      `⚙️ *Snipe Bot Status*`,
      ``,
      `🔑 Wallet: ${walletStatus}`,
      `⚡ Zap Credits: *${credits}*`,
      ``,
      `💼 Budget: $${user.budget.toFixed(2)} USDC`,
      `💲 Trade size: $${user.tradeSize.toFixed(2)} USDC`,
      `  🟢 High confidence: $${user.tradeSize.toFixed(2)}`,
      `  🟡 Medium confidence: $${(user.tradeSize / 2).toFixed(2)}`,
      `  🔴 Low confidence: signal only`,
      `🛑 Max daily loss: $${user.maxDailyLoss.toFixed(2)} USDC`,
      `🤖 Auto trade: ${autoTradeStatus}`,
      ``,
      `📊 *Today's Stats (${stats.date})*`,
      `  Trades: ${stats.tradesPlaced} | W: ${stats.wins} / L: ${stats.losses}`,
      `  Net PnL: ${stats.netPnl >= 0 ? '+' : ''}$${stats.netPnl.toFixed(2)} USDC`,
      `  Open positions: ${openPositions.length} ($${openExposure.toFixed(2)} exposure)`,
    ].join('\n')
  );
});

// ── /setkey ───────────────────────────────────────────────────────────────────

bot.command('setkey', async ctx => {
  const uid = userId(ctx);

  // Enforce DM only — never accept keys in group chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply(
      '⛔ For your security, /setkey only works in a private chat with the bot. ' +
      'Open a DM with me and send it there.'
    );
  }

  const args = ctx.message.text.split(' ');
  const rawKey = args[1]?.trim();

  if (!rawKey) {
    return ctx.replyWithMarkdown(
      '*Usage:* `/setkey [your_private_key]`\n\n' +
      '⚠️ *Security rules:*\n' +
      '• Only use a *dedicated trading wallet* — never your main wallet\n' +
      '• Only send this command here in a private DM — never in a group\n' +
      '• Your message will be auto-deleted immediately after submission\n' +
      '• Your key is stored encrypted and tied only to your Telegram ID\n\n' +
      'Use /deletekey at any time to remove your key.'
    );
  }

  // Basic validation — private keys are 64 hex chars (with or without 0x prefix)
  const keyHex = rawKey.startsWith('0x') ? rawKey.slice(2) : rawKey;
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    // Delete the message even on invalid input to avoid key exposure
    try { await ctx.deleteMessage(); } catch {}
    return ctx.reply('⚠️ Invalid private key format. A private key must be a 64-character hex string. Please check and try again.');
  }

  const isReplacing = userHasKey(uid);

  // Delete the message containing the key immediately
  try {
    await ctx.deleteMessage();
  } catch {
    await ctx.reply('⚠️ Could not auto-delete your message. Please delete it manually from this chat right now.');
  }

  try {
    setUserKey(uid, keyHex);
    const address = getWalletAddress(keyHex);

    const lines = [
      `✅ *Wallet key ${isReplacing ? 'updated' : 'saved'} and encrypted.*`,
      ``,
      `📬 Wallet address: \`${address}\``,
      `🔐 Stored: encrypted with AES-256, tied to your Telegram ID only`,
      ``,
      `*Next steps:*`,
      `1. Fund this address with USDC on the *Polygon* network`,
      `2. Run /balance to confirm the balance is showing`,
      `3. Run /autotrade on to start auto trading`,
      ``,
      `Use /deletekey at any time to permanently remove your key from this bot.`,
    ];

    if (isReplacing) {
      lines.splice(1, 0, `⚠️ Your previous key has been replaced.`);
    }

    return ctx.replyWithMarkdown(lines.join('\n'));
  } catch (err) {
    console.error('[Bot] /setkey error:', err.message);
    return ctx.reply('⚠️ Failed to save key. Please try again.');
  }
});

// ── /deletekey (+ /removekey alias) ──────────────────────────────────────────

function handleDeleteKey(ctx) {
  const uid = userId(ctx);

  if (!userHasKey(uid)) {
    return ctx.replyWithMarkdown(
      'You have no stored private key.\n\nUse /setkey in a private DM to register one.'
    );
  }

  // Disable auto trading first so no trade fires between removal and confirmation
  setAutoTrade(uid, false);
  removeUserKey(uid);

  return ctx.replyWithMarkdown(
    [
      `🗑 *Your private key has been permanently deleted.*`,
      ``,
      `• Auto trading has been disabled`,
      `• Your wallet address and trade history are preserved`,
      `• Your key is gone — this bot can no longer access your wallet`,
      ``,
      `Use /setkey in a private DM to register a new key at any time.`,
    ].join('\n')
  );
}

bot.command('deletekey', handleDeleteKey);
bot.command('removekey', handleDeleteKey); // alias for backwards compatibility

// ── /myaddress ────────────────────────────────────────────────────────────────

bot.command('myaddress', ctx => {
  const uid = userId(ctx);
  const address = getUserWalletAddress(uid) || getWalletAddress(getUserPrivateKey(uid));

  if (!address) {
    return ctx.reply('No wallet found. Send /start to generate one automatically.');
  }

  return ctx.replyWithMarkdown(
    `📬 *Your wallet address:*\n\`${address}\`\n\n` +
    `Send USDC (Polygon network) to this address to fund your trades.`
  );
});

// ── /mywallet ─────────────────────────────────────────────────────────────────

bot.command('mywallet', async ctx => {
  const uid = userId(ctx);
  const address = getUserWalletAddress(uid) || getWalletAddress(getUserPrivateKey(uid));

  if (!address) {
    return ctx.reply('No wallet found. Send /start to generate one automatically.');
  }

  await ctx.reply('Fetching wallet balance...');

  try {
    const privateKey = getUserPrivateKey(uid);
    const balance = privateKey ? await getWalletBalance(privateKey) : 0;
    const openPositions = getOpenPositions(uid);
    const openExposure = openPositions.reduce((s, p) => s + p.amount, 0);
    const credits = getZapCredits(uid);

    return ctx.replyWithMarkdown(
      [
        `🏦 *Your Snipe Wallet*`,
        ``,
        `📬 Address: \`${address}\``,
        `💵 USDC Balance: *$${balance.toFixed(2)}*`,
        `📊 Open exposure: $${openExposure.toFixed(2)} (${openPositions.length} positions)`,
        `✅ Available to trade: *$${Math.max(0, balance - openExposure).toFixed(2)}*`,
        `⚡ Zap Credits: *${credits}*`,
        ``,
        `_Fund via Polygon network — USDC only_`,
      ].join('\n')
    );
  } catch (err) {
    console.error('[Bot] /mywallet error:', err.message);
    return ctx.reply('⚠️ Could not fetch balance. Your wallet address is still valid.');
  }
});

// ── /exportkey ────────────────────────────────────────────────────────────────

bot.command('exportkey', async ctx => {
  const uid = userId(ctx);

  if (ctx.chat.type !== 'private') {
    return ctx.reply('⛔ /exportkey only works in a private DM for your security.');
  }

  const privateKey = getUserPrivateKey(uid);
  if (!privateKey) {
    return ctx.reply('No wallet found. Send /start to generate one.');
  }

  const address = getUserWalletAddress(uid) || getWalletAddress(privateKey);

  await ctx.replyWithMarkdown(
    [
      `🔐 *Private Key Export*`,
      ``,
      `⚠️ *CRITICAL SECURITY WARNING:*`,
      `• Anyone with this key controls your wallet funds`,
      `• Never share it with anyone — including this bot's developers`,
      `• Store it in a password manager or hardware wallet`,
      `• Delete this message after saving your key`,
      ``,
      `📬 Address: \`${address}\``,
      `🔑 Private Key:`,
      `\`${privateKey}\``,
      ``,
      `_Import this key into MetaMask or any EVM-compatible wallet to access your funds._`,
    ].join('\n')
  );
});

// ── /referrals ────────────────────────────────────────────────────────────────

bot.command('referrals', ctx => {
  const uid = userId(ctx);
  const botUsername = ctx.botInfo?.username || 'PolymarketSnipeBot';
  const stats = getReferralStats(uid);
  const link = `https://t.me/${botUsername}?start=${uid}`;

  return ctx.replyWithMarkdown(
    [
      `🤝 *Referral Dashboard*`,
      ``,
      `🌐 Your referral link:`,
      `\`${link}\``,
      ``,
      `📊 *Stats:*`,
      `👥 Total referrals: *${stats.total}*`,
      `✅ Active traders: *${stats.active}*`,
      `💰 Earnings: *$${stats.earnings.toFixed(2)}* USDC`,
      ``,
      `_Share your link to grow your squad. Earnings from fee-sharing will appear here once enabled._`,
    ].join('\n')
  );
});

// ── /credits ──────────────────────────────────────────────────────────────────

bot.command('credits', ctx => {
  const uid = userId(ctx);
  const credits = getZapCredits(uid);

  const bar = credits >= 100 ? '🟢🟢🟢🟢🟢'
    : credits >= 60 ? '🟢🟢🟢🟡⬜'
    : credits >= 30 ? '🟡🟡⬜⬜⬜'
    : credits > 0  ? '🔴⬜⬜⬜⬜'
    : '⬛⬛⬛⬛⬛';

  return ctx.replyWithMarkdown(
    [
      `⚡ *Zap Credits*`,
      ``,
      `${bar} *${credits}* credits remaining`,
      ``,
      `Each automated trade costs *1 Zap Credit*.`,
      credits === 0
        ? `\n❌ *Credits depleted* — auto trading paused.\nUse /buycredits to top up.`
        : credits < 20
        ? `\n⚠️ Running low! Use /buycredits to top up soon.`
        : ``,
    ].filter(l => l !== undefined).join('\n')
  );
});

// ── /buycredits ───────────────────────────────────────────────────────────────

bot.command('buycredits', ctx => {
  return ctx.replyWithMarkdown(
    [
      `💚 *Buy Zap Credits*`,
      ``,
      `_Payment integration coming soon!_`,
      ``,
      `*Planned packages:*`,
      `• 100 Credits — $1.00 USDC`,
      `• 500 Credits — $4.00 USDC`,
      `• 1,000 Credits — $7.00 USDC`,
      `• 5,000 Credits — $25.00 USDC`,
      ``,
      `Stay tuned — on-chain USDC payments will be enabled in the next update.`,
    ].join('\n')
  );
});

// ── Error handling ────────────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`[Bot] Unhandled error for ${ctx.updateType}:`, err.message);
  ctx.reply('⚠️ An unexpected error occurred. Please try again.').catch(() => {});
});

// ── Launch ────────────────────────────────────────────────────────────────────

setBotInstance(bot);
startScheduler();

bot.launch({
  dropPendingUpdates: true,
}).then(async () => {
  console.log('[Bot] Polymarket Snipe Bot is running...');

  // Set the bot's persistent menu button to open the Mini App
  try {
    await bot.telegram.setChatMenuButton({
      menuButton: {
        type: 'web_app',
        text: '🎯 Trade',
        web_app: { url: WEB_APP_URL },
      },
    });
    console.log('[Bot] Menu button set to Mini App.');
  } catch (err) {
    console.error('[Bot] Could not set menu button:', err.message);
  }

  // Register command list shown in Telegram UI
  try {
    await bot.telegram.setMyCommands([
      { command: 'start',          description: 'Welcome & wallet setup' },
      { command: 'mywallet',       description: 'View wallet & USDC balance' },
      { command: 'balance',        description: 'Wallet balance summary' },
      { command: 'autotrade',      description: 'Enable or disable auto trading' },
      { command: 'credits',        description: 'Check Zap Credits balance' },
      { command: 'buycredits',     description: 'Buy more Zap Credits' },
      { command: 'status',         description: 'Full bot status' },
      { command: 'positions',      description: 'View open positions' },
      { command: 'history',        description: 'Last 10 closed trades' },
      { command: 'referrals',      description: 'Referral link & stats' },
      { command: 'setbudget',      description: 'Set total USDC budget' },
      { command: 'settradesize',   description: 'Set USDC per trade' },
      { command: 'setmaxdailyloss', description: 'Set daily loss limit' },
      { command: 'pause',          description: 'Pause auto trading' },
      { command: 'resume',         description: 'Resume auto trading' },
      { command: 'exportkey',      description: 'Export your private key (DM only)' },
      { command: 'deletekey',      description: 'Remove your stored key' },
    ]);
  } catch (err) {
    console.error('[Bot] Could not set commands:', err.message);
  }
}).catch(err => {
  console.error('[Bot] Failed to launch:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
