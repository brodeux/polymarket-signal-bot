# Polymarket Signal & Auto-Trading Bot

A fully automated Telegram bot that monitors Polymarket football and stock markets, generates trading signals from live data, and optionally places trades automatically.

---

## Features

- **Football signals** — live match analysis using API-Football (form, H2H, live score)
- **Stock signals** — TSLA & NVDA momentum and RSI analysis via Polygon.io
- **Polymarket integration** — cross-references odds drift; places YES/NO limit orders via CLOB API
- **Auto trade sizing** — High confidence = full size, Medium = half size, Low = signal only
- **Daily risk management** — enforces budget caps and daily loss limits with automatic pausing
- **Telegram bot** — full command interface for every setting

---

## Prerequisites

- Node.js 18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- API-Football account (api-football.com / RapidAPI)
- Polygon.io API key (polygon.io)
- A Polygon network wallet funded with USDC for live trading

---

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd polymarket-signal-bot
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHANNEL_ID=your_channel_or_chat_id_here

POLYGON_API_KEY=your_polygon_api_key_here
API_FOOTBALL_KEY=your_api_football_key_here

WALLET_PRIVATE_KEY=your_wallet_private_key_here

DEFAULT_TRADE_SIZE=5
DEFAULT_BUDGET=100
DEFAULT_MAX_DAILY_LOSS=20
```

> **Security**: Never commit `.env`. Your private key is only used for signing transactions and is never logged.

### 3. Start the bot

```bash
npm start
```

Or use watch mode during development:

```bash
npm run dev
```

---

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Welcome message and setup guide |
| `/setbudget [amount]` | Set total USDC trading budget |
| `/settradesize [amount]` | Set USDC per trade |
| `/setmaxdailyloss [amount]` | Set daily loss limit before auto-pause |
| `/autotrade on\|off` | Enable or disable automatic trade placement |
| `/balance` | Show wallet USDC balance and open exposure |
| `/positions` | Show all open positions |
| `/history` | Show last 10 closed trades |
| `/pause` | Pause all trading and signals |
| `/resume` | Resume trading and signals |
| `/status` | Show current bot config and today's stats |

---

## Signal Confidence Tiers

| Confidence | Factors aligned | Action |
|---|---|---|
| Low | 1 | Signal sent to Telegram only — no trade |
| Medium | 2 | Trade at 50% of set trade size |
| High | 3+ | Trade at full set trade size |

---

## Schedule

| Interval | Action |
|---|---|
| Every 5 min | TSLA & NVDA stock signals |
| Every 15 min | Live football match signals |
| Every 1 hour | Full market scan (all signals) |
| Midnight UTC | Daily reset + summary sent to each user |

---

## Project Structure

```
src/
  bot.js           — Telegram bot commands and launch
  signals.js       — Central signal processor and broadcaster
  polymarket.js    — Polymarket CLOB API + order placement
  football.js      — API-Football data and signal logic
  stocks.js        — Polygon.io data and RSI signal logic
  scheduler.js     — node-cron scheduling
  tradeManager.js  — Budget, risk management, position tracking
  userConfig.js    — Per-user settings stored in lowdb
data/
  users.json       — User config (auto-created, gitignored)
  trades.json      — Trade history (auto-created, gitignored)
```

---

## Risk Warning

This bot places real trades using real funds. Always:

- Start with a small budget to test
- Monitor daily loss limits carefully
- Never trade more than you can afford to lose
- Polymarket markets can be illiquid — verify manually before enabling large trade sizes
