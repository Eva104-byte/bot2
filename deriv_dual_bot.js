/**
 * ============================================================
 *  Deriv Over/Under Dual Bot — Node.js Edition  (v3)
 *  Runs 24/7 headlessly on Railway or any Node.js server.
 * ============================================================
 *
 *  STRATEGY:
 *    • Over 1 Bot  — watches digits 0, 1, 2.
 *                    Arms when any digit % rises above threshold.
 *                    On the next tick where that armed digit appears
 *                    → places a DIGITOVER '1' contract.
 *
 *    • Under 8 Bot — same logic for digits 7, 8, 9.
 *                    → places a DIGITUNDER '8' contract.
 *
 *    • Martingale  — 4.5× stake on the trade immediately after a loss
 *                    (one step only). Resets to base stake after the
 *                    martingale trade resolves (win or loss).
 *
 *  SETUP:
 *    1.  npm install ws dotenv
 *    2.  cp .env.example .env  →  fill in DERIV_API_TOKEN
 *    3.  node deriv_dual_bot.js
 *
 *  RAILWAY:
 *    Push to GitHub → New Project → Deploy from repo.
 *    Add env vars in the Railway "Variables" tab.
 * ============================================================
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');

// ─────────────────────────────────────────────────────────────
//  CONFIG  — all values driven by environment variables
//
//  Required:
//    DERIV_API_TOKEN           Your Deriv API token
//
//  Optional (all have sensible defaults):
//    MARKET                    Starting symbol           (default: R_100)
//    BASE_STAKE                USD per trade             (default: 1.00)
//    DURATION                  Ticks per trade           (default: 1)
//    RISE_THRESHOLD            % rise needed to arm      (default: 0.3)
//    TARGET_PROFIT             USD — stops both bots     (default: 50.00)
//    STOP_LOSS                 USD — stops both bots     (default: 20.00)
//    MART_ENABLED              true | false              (default: true)
//    MART_MULTIPLIER           multiplier on loss        (default: 4.5)
//    OVER_ENABLED              true | false              (default: true)
//    UNDER_ENABLED             true | false              (default: true)
//    HIST_LEN                  digit history window      (default: 500)
//    DERIV_APP_ID              Deriv app ID              (default: 1089)
// ─────────────────────────────────────────────────────────────

function envBool(key, def) {
  const v = process.env[key];
  if (v === undefined) return def;
  return v.toLowerCase() === 'true';
}
function envFloat(key, def) {
  const v = parseFloat(process.env[key]);
  return isNaN(v) ? def : v;
}
function envInt(key, def) {
  const v = parseInt(process.env[key]);
  return isNaN(v) ? def : v;
}

const CONFIG = {
  API_TOKEN:       process.env.DERIV_API_TOKEN || 'YOUR_API_TOKEN_HERE',
  MARKET:          process.env.MARKET          || 'R_100',
  APP_ID:          envInt  ('DERIV_APP_ID',     1089),

  BASE_STAKE:      envFloat('BASE_STAKE',       1.00),
  DURATION:        envInt  ('DURATION',         1),
  RISE_THRESHOLD:  envFloat('RISE_THRESHOLD',   0.3),
  TARGET_PROFIT:   envFloat('TARGET_PROFIT',    50.00),
  STOP_LOSS:       envFloat('STOP_LOSS',        20.00),

  MART_ENABLED:    envBool ('MART_ENABLED',     true),
  MART_MULTIPLIER: envFloat('MART_MULTIPLIER',  4.5),

  OVER_ENABLED:    envBool ('OVER_ENABLED',     true),
  UNDER_ENABLED:   envBool ('UNDER_ENABLED',    true),

  HIST_LEN:        envInt  ('HIST_LEN',         500),
};

// Watched digit groups
const OVER_DIGITS  = [0, 1, 2];   // arms Over 1 contract
const UNDER_DIGITS = [7, 8, 9];   // arms Under 8 contract

const MARKET_NAMES = {
  R_10:     'Volatility 10',
  R_25:     'Volatility 25',
  R_50:     'Volatility 50',
  R_75:     'Volatility 75',
  R_100:    'Volatility 100',
  '1HZ10V': 'Volatility 10 (1s)',
  '1HZ25V': 'Volatility 25 (1s)',
  '1HZ50V': 'Volatility 50 (1s)',
  '1HZ75V': 'Volatility 75 (1s)',
  '1HZ100V':'Volatility 100 (1s)',
};

// ─────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────

// Connection
let ws             = null;
let connected      = false;
let reconnectDelay = 2000;

// Tick history
let rawDigits  = [];   // last-digit ring buffer  (max HIST_LEN + 10)
let priceHist  = [];   // raw price ring buffer   (max 10)

// Digit frequency arrays (index = digit 0–9)
let digitPcts  = Array(10).fill(10.0);
let prevPcts   = Array(10).fill(10.0);

// Martingale
let inMartingale  = false;   // true → next trade of that bot uses MART_MULTIPLIER × stake

// ── Over Bot state ────────────────────────────────────────────
let overRunning    = false;
let overArmed      = false;
let overArmedDigit = null;
let overTradeBusy  = false;
let overWins = 0, overLosses = 0, overPnl = 0;
let overLastLoss   = false;

// ── Under Bot state ───────────────────────────────────────────
let underRunning    = false;
let underArmed      = false;
let underArmedDigit = null;
let underTradeBusy  = false;
let underWins = 0, underLosses = 0, underPnl = 0;
let underLastLoss   = false;

// Combined P&L
let totalPnl = 0;
let botsActive = true;   // set false when TP/SL hit

// Request tracking
let nextReqId = 1000;
const reqBotMap      = new Map();   // reqId → 'over' | 'under'
const contractBotMap = new Map();   // contractId → 'over' | 'under'

// ─────────────────────────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en', { hour12: false });
}

function log(msg, type = '') {
  const icons = {
    win:   '✅',
    loss:  '❌',
    trade: '💰',
    mart:  '🔺',
    over:  '↑ ',
    under: '↓ ',
    warn:  '⚠️ ',
    info:  'ℹ️ ',
  };
  const icon = icons[type] || '·  ';
  console.log(`[${ts()}] ${icon} ${msg}`);
}

// ─────────────────────────────────────────────────────────────
//  DIGIT / FREQUENCY HELPERS
// ─────────────────────────────────────────────────────────────
function getLastDigit(price) {
  return parseInt(price.toFixed(2).slice(-1));
}

function recalcPcts() {
  if (rawDigits.length < 10) return;
  const window = rawDigits.slice(-CONFIG.HIST_LEN);
  const counts = Array(10).fill(0);
  window.forEach(d => counts[d]++);
  const total = window.length;
  prevPcts = [...digitPcts];
  for (let d = 0; d <= 9; d++) {
    digitPcts[d] = (counts[d] / total) * 100;
  }
}

// ─────────────────────────────────────────────────────────────
//  STAKE / MARTINGALE
// ─────────────────────────────────────────────────────────────
function getStake(bot) {
  const base     = CONFIG.BASE_STAKE;
  const wasLoss  = bot === 'over' ? overLastLoss : underLastLoss;
  if (CONFIG.MART_ENABLED && wasLoss && inMartingale) {
    return +(base * CONFIG.MART_MULTIPLIER).toFixed(2);
  }
  return +base.toFixed(2);
}

// ─────────────────────────────────────────────────────────────
//  RISK CONTROLS
// ─────────────────────────────────────────────────────────────
function checkRiskLimits() {
  totalPnl = overPnl + underPnl;

  if (totalPnl >= CONFIG.TARGET_PROFIT) {
    botsActive   = false;
    overRunning  = false;
    underRunning = false;
    log(`🎯 Target profit $${CONFIG.TARGET_PROFIT.toFixed(2)} reached — both bots stopped. Net P&L: +$${totalPnl.toFixed(2)}`, 'win');
  }

  if (totalPnl <= -Math.abs(CONFIG.STOP_LOSS)) {
    botsActive   = false;
    overRunning  = false;
    underRunning = false;
    log(`🛑 Stop loss $${CONFIG.STOP_LOSS.toFixed(2)} hit — both bots stopped. Net P&L: $${totalPnl.toFixed(2)}`, 'loss');
  }
}

// ─────────────────────────────────────────────────────────────
//  TRADE PLACEMENT
// ─────────────────────────────────────────────────────────────
function placeTrade(bot) {
  if (!ws || !connected) return;

  const stake    = getStake(bot);
  const reqId    = nextReqId++;
  const isMart   = CONFIG.MART_ENABLED && (bot === 'over' ? overLastLoss : underLastLoss) && inMartingale;

  reqBotMap.set(reqId, bot);

  if (bot === 'over') {
    overTradeBusy = true;
    log(`[OVER] Placing DIGITOVER 1 | digit ${overArmedDigit} struck | $${stake.toFixed(2)}${isMart ? ' 🔺MART' : ''}`, 'trade');
    ws.send(JSON.stringify({
      req_id: reqId,
      buy:    1,
      price:  stake,
      parameters: {
        amount:        stake,
        basis:         'stake',
        contract_type: 'DIGITOVER',
        currency:      'USD',
        duration:      CONFIG.DURATION,
        duration_unit: 't',
        symbol:        CONFIG.MARKET,
        barrier:       '1',
      },
    }));
  } else {
    underTradeBusy = true;
    log(`[UNDER] Placing DIGITUNDER 8 | digit ${underArmedDigit} struck | $${stake.toFixed(2)}${isMart ? ' 🔺MART' : ''}`, 'trade');
    ws.send(JSON.stringify({
      req_id: reqId,
      buy:    1,
      price:  stake,
      parameters: {
        amount:        stake,
        basis:         'stake',
        contract_type: 'DIGITUNDER',
        currency:      'USD',
        duration:      CONFIG.DURATION,
        duration_unit: 't',
        symbol:        CONFIG.MARKET,
        barrier:       '8',
      },
    }));
  }
}

// ─────────────────────────────────────────────────────────────
//  TICK PROCESSING
// ─────────────────────────────────────────────────────────────
function processTick(quote) {
  priceHist.push(quote);
  if (priceHist.length > 10) priceHist.shift();

  const lastD = getLastDigit(quote);
  rawDigits.push(lastD);
  if (rawDigits.length > CONFIG.HIST_LEN + 10) rawDigits.shift();

  recalcPcts();

  const threshold = CONFIG.RISE_THRESHOLD;

  // ── OVER BOT ──────────────────────────────────────────────
  if (CONFIG.OVER_ENABLED && overRunning && botsActive && !overTradeBusy) {
    if (!overArmed) {
      for (const d of OVER_DIGITS) {
        if (digitPcts[d] - prevPcts[d] >= threshold) {
          overArmed      = true;
          overArmedDigit = d;
          log(`[OVER] Digit ${d} rising +${(digitPcts[d] - prevPcts[d]).toFixed(2)}% → ${digitPcts[d].toFixed(1)}% — armed, waiting for strike`, 'over');
          break;
        }
      }
    } else {
      if (lastD === overArmedDigit) {
        overArmed = false;
        placeTrade('over');
      }
    }
  }

  // ── UNDER BOT ─────────────────────────────────────────────
  if (CONFIG.UNDER_ENABLED && underRunning && botsActive && !underTradeBusy) {
    if (!underArmed) {
      for (const d of UNDER_DIGITS) {
        if (digitPcts[d] - prevPcts[d] >= threshold) {
          underArmed      = true;
          underArmedDigit = d;
          log(`[UNDER] Digit ${d} rising +${(digitPcts[d] - prevPcts[d]).toFixed(2)}% → ${digitPcts[d].toFixed(1)}% — armed, waiting for strike`, 'under');
          break;
        }
      }
    } else {
      if (lastD === underArmedDigit) {
        underArmed = false;
        placeTrade('under');
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  CONTRACT RESULT HANDLER
// ─────────────────────────────────────────────────────────────
function handleContractResult(poc) {
  const bot    = contractBotMap.get(poc.contract_id) || 'over';
  const profit = parseFloat(poc.profit || 0);
  contractBotMap.delete(poc.contract_id);

  const won = profit >= 0;

  if (bot === 'over') {
    overTradeBusy = false;
    overPnl += profit;
    if (won) {
      overWins++;
      overLastLoss = false;
      log(`[OVER] WIN  +$${profit.toFixed(2)} | Contract ${poc.contract_id}`, 'win');
    } else {
      overLosses++;
      overLastLoss = true;
      log(`[OVER] LOSS  $${profit.toFixed(2)} | Contract ${poc.contract_id}`, 'loss');
    }
    log(`[OVER] Stats — Wins: ${overWins} | Losses: ${overLosses} | P&L: $${overPnl.toFixed(2)}`);
  } else {
    underTradeBusy = false;
    underPnl += profit;
    if (won) {
      underWins++;
      underLastLoss = false;
      log(`[UNDER] WIN  +$${profit.toFixed(2)} | Contract ${poc.contract_id}`, 'win');
    } else {
      underLosses++;
      underLastLoss = true;
      log(`[UNDER] LOSS  $${profit.toFixed(2)} | Contract ${poc.contract_id}`, 'loss');
    }
    log(`[UNDER] Stats — Wins: ${underWins} | Losses: ${underLosses} | P&L: $${underPnl.toFixed(2)}`);
  }

  // Martingale state management
  if (CONFIG.MART_ENABLED) {
    if (!won) {
      inMartingale = true;
      log(`[MART] Loss detected — next ${bot.toUpperCase()} trade will use ${CONFIG.MART_MULTIPLIER}× martingale stake`, 'mart');
    } else if (inMartingale) {
      inMartingale = false;
      if (bot === 'over')  overLastLoss  = false;
      else                 underLastLoss = false;
      log(`[MART] Martingale trade resolved — stake reset to base $${CONFIG.BASE_STAKE.toFixed(2)}`, 'mart');
    }
  }

  checkRiskLimits();
}

// ─────────────────────────────────────────────────────────────
//  WEBSOCKET
// ─────────────────────────────────────────────────────────────
function subscribeToTicks(market) {
  if (!ws || !connected) return;
  ws.send(JSON.stringify({ ticks: market, subscribe: 1 }));
  log(`Subscribed to ${MARKET_NAMES[market] || market} tick stream`);
}

function connectWS() {
  log('Connecting to Deriv WebSocket API…');
  ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.APP_ID}`);

  ws.on('open', () => {
    connected      = true;
    reconnectDelay = 2000;
    log('WebSocket connected');
    ws.send(JSON.stringify({ authorize: CONFIG.API_TOKEN }));
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Authorization ──────────────────────────────────────
    if (msg.msg_type === 'authorize') {
      if (msg.error) {
        log('Auth error: ' + msg.error.message, 'loss');
        return;
      }
      const acc = msg.authorize;
      log(`Authorized: ${acc.loginid} | Currency: ${acc.currency} | Balance: ${parseFloat(acc.balance).toFixed(2)}`);
      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      subscribeToTicks(CONFIG.MARKET);

      // Start bots
      if (CONFIG.OVER_ENABLED && botsActive) {
        overRunning = true;
        log('Over 1 Bot started — watching digits 0, 1, 2 for rising %', 'over');
      }
      if (CONFIG.UNDER_ENABLED && botsActive) {
        underRunning = true;
        log('Under 8 Bot started — watching digits 7, 8, 9 for rising %', 'under');
      }
    }

    // ── Balance ────────────────────────────────────────────
    if (msg.msg_type === 'balance' && msg.balance) {
      log(`Balance update: ${msg.balance.currency} ${parseFloat(msg.balance.balance).toFixed(2)}`);
    }

    // ── Tick ──────────────────────────────────────────────
    if (msg.msg_type === 'tick') {
      processTick(msg.tick.quote);
    }

    // ── Buy response ──────────────────────────────────────
    if (msg.msg_type === 'buy') {
      const reqId    = msg.req_id;
      const botOwner = reqBotMap.get(reqId) || 'over';
      reqBotMap.delete(reqId);

      if (msg.error) {
        log(`Buy error: ${msg.error.message}`, 'loss');
        if (botOwner === 'over')  overTradeBusy  = false;
        else                      underTradeBusy = false;
        return;
      }

      const contractId = msg.buy.contract_id;
      contractBotMap.set(contractId, botOwner);
      log(`Contract placed | ID: ${contractId}`, 'trade');
      ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }));
    }

    // ── Contract result ───────────────────────────────────
    if (msg.msg_type === 'proposal_open_contract') {
      const poc = msg.proposal_open_contract;
      if (!poc || !(poc.is_sold || poc.status === 'sold')) return;
      handleContractResult(poc);
    }
  });

  ws.on('error', err => {
    log(`WebSocket error: ${err.message}`, 'warn');
  });

  ws.on('close', () => {
    connected    = false;
    overRunning  = false;
    underRunning = false;
    log(`WebSocket disconnected — reconnecting in ${reconnectDelay / 1000}s…`, 'warn');
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
      connectWS();
    }, reconnectDelay);
  });
}

// ─────────────────────────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────────────────────────
if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
  console.error('\n❌  DERIV_API_TOKEN is not set. Add it to your .env file or Railway Variables.\n');
  process.exit(1);
}

log('='.repeat(58));
log('  Deriv Over/Under Dual Bot — Node.js Edition  v3');
log('='.repeat(58));
log(`Market:          ${MARKET_NAMES[CONFIG.MARKET] || CONFIG.MARKET}`);
log(`Base Stake:      $${CONFIG.BASE_STAKE.toFixed(2)}`);
log(`Duration:        ${CONFIG.DURATION} tick(s)`);
log(`Rise Threshold:  ${CONFIG.RISE_THRESHOLD}%`);
log(`Target Profit:   $${CONFIG.TARGET_PROFIT.toFixed(2)}`);
log(`Stop Loss:       $${CONFIG.STOP_LOSS.toFixed(2)}`);
log(`Over 1 Bot:      ${CONFIG.OVER_ENABLED  ? 'Enabled — watches digits 0, 1, 2' : 'Disabled'}`);
log(`Under 8 Bot:     ${CONFIG.UNDER_ENABLED ? 'Enabled — watches digits 7, 8, 9' : 'Disabled'}`);
log(`Martingale:      ${CONFIG.MART_ENABLED  ? `Enabled — ${CONFIG.MART_MULTIPLIER}× stake on loss (one step)` : 'Disabled'}`);
log('='.repeat(58));

connectWS();

// Graceful shutdown
process.on('SIGINT', () => {
  log('\nShutting down gracefully…');
  if (ws) ws.terminate();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('\nSIGTERM received — shutting down…');
  if (ws) ws.terminate();
  process.exit(0);
});
