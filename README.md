# Deriv Over/Under Dual Bot — Node.js Edition v3

Headless Node.js trading bot. Runs 24/7 on Railway with no browser required.

## Strategy

| Bot | Watches | Arms when | Trades |
|-----|---------|-----------|--------|
| Over 1 | Digits 0, 1, 2 | Any digit % rises ≥ threshold | `DIGITOVER 1` |
| Under 8 | Digits 7, 8, 9 | Any digit % rises ≥ threshold | `DIGITUNDER 8` |

**Martingale:** 4.5× stake on the trade immediately after a loss (one step only). Resets to base stake after the martingale trade resolves.

## File Structure

```
deriv-bot/
├── deriv_dual_bot.js   ← Bot logic (pure Node.js, no HTML)
├── .env                ← Your config (never commit this)
├── .env.example        ← Safe template
├── package.json
├── railway.toml
├── .gitignore
└── README.md
```

## Local Setup

```bash
npm install
cp .env.example .env
# Edit .env — set DERIV_API_TOKEN to your token
node deriv_dual_bot.js
```

## 🚀 Deploy to Railway

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Deriv Dual Bot v3 — 4.5x Martingale"
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

### 2. Deploy
1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
2. Select your repository
3. Go to the **Variables** tab → add all vars from `.env.example`
4. Set `DERIV_API_TOKEN` = your actual Deriv API token
5. Railway builds and starts the bot automatically ✅

### 3. Monitor logs
In Railway → your service → **Logs** tab. You'll see real-time output like:
```
[12:00:01] ·   Authorized: CR123456 | Currency: USD | Balance: 100.00
[12:00:02] ↑   [OVER] Digit 2 rising +0.42% → 12.3% — armed, waiting for strike
[12:00:03] 💰  [OVER] Placing DIGITOVER 1 | digit 2 struck | $1.00
[12:00:04] ✅  [OVER] WIN  +$0.87 | Contract 123456789
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DERIV_API_TOKEN` | **required** | Your Deriv API token |
| `MARKET` | `R_100` | Symbol to trade |
| `BASE_STAKE` | `1.00` | USD per trade |
| `DURATION` | `1` | Ticks per contract |
| `RISE_THRESHOLD` | `0.3` | % rise needed to arm a bot |
| `TARGET_PROFIT` | `50.00` | Stops both bots when reached |
| `STOP_LOSS` | `20.00` | Stops both bots when hit |
| `MART_ENABLED` | `true` | Enable martingale |
| `MART_MULTIPLIER` | `4.5` | Stake multiplier after a loss |
| `OVER_ENABLED` | `true` | Enable Over 1 bot |
| `UNDER_ENABLED` | `true` | Enable Under 8 bot |
| `HIST_LEN` | `500` | Digit history window size |
| `DERIV_APP_ID` | `1089` | Deriv app ID |

## ⚠️ Important

- Always test with a **demo account token** first
- The bot runs continuously — monitor your Railway logs regularly
- Set `TARGET_PROFIT` and `STOP_LOSS` to sensible values for your account size
