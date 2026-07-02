import { appendFileSync } from 'fs';
import { PolymarketSDK } from '/Users/juan-campuzano/Documents/projects/20-experiments/poly-sdk/src/index.ts';
import { TradeMonitor } from '/Users/juan-campuzano/Documents/projects/20-experiments/poly-sdk/src/smart-money/monitor.ts';
import { CopyEngine } from '/Users/juan-campuzano/Documents/projects/20-experiments/poly-sdk/src/smart-money/copy.ts';
import type { TradeEvent } from '/Users/juan-campuzano/Documents/projects/20-experiments/poly-sdk/src/smart-money/types.ts';

const sdk = await PolymarketSDK.create({
  privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
});

console.log('🤖 Bot iniciado');

// ── LOGGING para análisis de rentabilidad ────
const LOG_FILE = process.env.COPY_LOG_FILE ?? 'copy-trades.jsonl';

interface CopyLogEntry {
  loggedAt: string;          // ISO timestamp when we wrote this line
  source: TradeEvent['source'];
  detectedAt: number;        // ms, when TradeMonitor saw it
  tradeTimestamp: number;    // ms, when the leader's trade actually happened
  detectionLatencyMs: number;
  address: string;
  conditionId?: string;
  outcome?: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  leaderPrice: number;       // price the leader traded at
  leaderSize: number;
  leaderValueUsdc: number;
  ourAmountUsdc?: number;    // what we sized our copy order to
  ourSlippagePrice?: number; // our worst-acceptable price bound
  remainingBankrollUsdc?: number; // bankroll left after this trade
  reason?: 'leader' | 'take_profit' | 'stop_loss'; // why this order was placed
  pnlPercent?: number; // unrealized P&L at the moment of an independent exit
  dryRun: boolean;
  skipped: boolean;
  skipReason?: string;
  executed: boolean;
  orderId?: string;
  errorMsg?: string;
}

function logTrade(entry: CopyLogEntry): void {
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

// ── COPY TRADING ──────────────────────────────
// sdk.smartMoney.startAutoCopyTrading() was removed from the SDK (clean break,
// see commit d417003). Compose the same behavior from the low-level building
// blocks the SDK now exposes: SmartMoneyCore (leaderboard) + TradeMonitor
// (detection) + CopyEngine (execution).
const COPY_CONFIG = {
  topN: 50,
  sizeScale: 0.01,
  // Lowered from 10: a handful of large leader trades were each capping out at
  // maxSizePerTrade and burning through the whole bankroll in minutes, leaving
  // only 5-7 open positions for the rest of the run. At 3, the same $50
  // bankroll spreads across ~15+ positions, giving more surface area for
  // leader-mirrored sells and take-profit/stop-loss to actually trigger.
  maxSizePerTrade: 1,
  maxPositionUsdc: 5, // max total cost basis per token across all BUYs
  // Total USDC budget shared across all copied BUYs. Each BUY is scaled down
  // to fit whatever remains; SELLs return their proceeds to the pool (profits
  // compound — no cap). New BUYs are paused when bankroll < minBankrollFloor.
  bankroll: 50,
  minBankrollFloor: 10, // pause new BUYs below this balance
  maxSlippage: 0.03,
  orderType: 'FOK' as const,
  minTradeSize: 5,
  dryRun: true, // 👈 cambiar a false cuando quieras operar real
};

// Independent risk management — exits a position on our own P&L, regardless
// of whether the leader has sold. Checked on a timer, not on leader activity.
const RISK_CONFIG = {
  takeProfitPercent: 0.10, // sell once unrealized gain hits +10%
  stopLossPercent: 0.20,   // sell once unrealized loss hits -20%
  checkIntervalMs: 10_000,
};

// Only copy tokens in this price range — near-certain outcomes (>0.80) have
// no room for take-profit and near-zero outcomes (<0.10) are too illiquid.
const PRICE_FILTER = { min: 0.10, max: 0.80 };

// Remaining USDC budget. Decremented on BUYs, replenished (up to bankroll) on SELLs.
let remainingBankroll = COPY_CONFIG.bankroll;

// Trades older than this (ms) at detection time are startup replay — we skip
// order execution for them but still record prices for the risk check.
const STALE_TRADE_MS = 60_000;

// Our own cost-basis bookkeeping per tokenId, used both to cap mirrored SELLs
// (dry-run has no on-chain position to check) and to evaluate take-profit/stop-loss.
interface OwnPosition {
  conditionId: string;
  outcome?: string;
  shares: number;
  costUsdc: number;
}
const positions = new Map<string, OwnPosition>();

// Latest observed trade price per tokenId, updated from the live Activity feed.
// Used by runRiskCheck instead of getMidpoint (which fails for illiquid CLOB markets).
const latestPrices = new Map<string, number>();

const onTrade = (trade: TradeEvent, result: { success: boolean; errorMsg?: string }) => {
  console.log(`[COPY] ${trade.address.slice(0, 10)}… | ${trade.side} ${trade.outcome ?? trade.tokenId.slice(0, 8)} @ $${trade.price} | ${result.success ? '✅' : '❌'}`);
};
const onError = (err: Error) => console.error('[COPY ERROR]', err);

const stats = {
  tradesDetected: 0,
  tradesExecuted: 0,
  tradesSkipped: 0,
  tradesFailed: 0,
};

const targetAddresses = (await sdk.smartMoneyCore.getSmartMoneyList(COPY_CONFIG.topN)).map((w) => w.address);

const monitor = new TradeMonitor(sdk.dataApi, { pollIntervalMs: 5_000 });
const copyEngine = new CopyEngine(sdk.tradingService);
const myAddress = sdk.tradingService.getAddress();

/** USDC value of our own on-chain position in this token, or 0 if we don't hold it (live mode only). */
async function getMyPositionValueUsdc(conditionId: string, tokenId: string): Promise<number> {
  const apiPositions = await sdk.dataApi.getPositions(myAddress, { market: [conditionId] });
  const position = apiPositions.find((p) => p.asset === tokenId);
  if (!position || position.size <= 0) return 0;
  return position.currentValue ?? position.size * (position.curPrice ?? 0);
}

/** Record a fill against our own cost-basis bookkeeping (used for sizing caps + P&L checks). */
function recordFill(tokenId: string, conditionId: string, outcome: string | undefined, side: 'BUY' | 'SELL', amountUsdc: number, fillPrice: number): void {
  const existing = positions.get(tokenId);
  if (side === 'BUY') {
    const shares = amountUsdc / fillPrice;
    if (existing) {
      existing.shares += shares;
      existing.costUsdc += amountUsdc;
    } else {
      positions.set(tokenId, { conditionId, outcome, shares, costUsdc: amountUsdc });
    }
    return;
  }

  if (!existing) return;
  const sharesSold = amountUsdc / fillPrice;
  const soldFraction = Math.min(1, sharesSold / existing.shares);
  existing.shares -= sharesSold;
  existing.costUsdc -= existing.costUsdc * soldFraction;
  if (existing.shares <= 0.0001) positions.delete(tokenId);
}

/** Current USDC value of our tracked position in this token, or 0 if we don't hold it. */
function getOwnPositionValueUsdc(tokenId: string, currentPrice: number): number {
  const position = positions.get(tokenId);
  return position ? position.shares * currentPrice : 0;
}

/**
 * Sell a position on our own initiative (take-profit/stop-loss), independent of
 * whatever the leader is doing. Closes the full tracked position.
 */
async function closePosition(tokenId: string, reason: 'take_profit' | 'stop_loss', currentPrice: number, pnlPercent: number): Promise<void> {
  const position = positions.get(tokenId);
  if (!position) return;

  const amount = position.shares * currentPrice;
  const slippagePrice = Math.max(currentPrice - COPY_CONFIG.maxSlippage, 0);

  const baseEntry = {
    loggedAt: new Date().toISOString(),
    source: 'polling' as const,
    detectedAt: Date.now(),
    tradeTimestamp: Date.now(),
    detectionLatencyMs: 0,
    address: myAddress,
    conditionId: position.conditionId,
    outcome: position.outcome,
    tokenId,
    side: 'SELL' as const,
    leaderPrice: currentPrice,
    leaderSize: position.shares,
    leaderValueUsdc: amount,
    reason,
    pnlPercent,
  };

  if (COPY_CONFIG.dryRun) {
    recordFill(tokenId, position.conditionId, position.outcome, 'SELL', amount, currentPrice);
    remainingBankroll += amount;
    console.log(`[COPY] (dry-run) ${reason.toUpperCase()} exit: SELL $${amount.toFixed(2)} @ ~$${currentPrice.toFixed(4)} | P&L ${(pnlPercent * 100).toFixed(1)}%`);
    logTrade({ ...baseEntry, dryRun: true, skipped: false, executed: true, ourAmountUsdc: amount, ourSlippagePrice: slippagePrice, remainingBankrollUsdc: remainingBankroll });
    return;
  }

  try {
    const result = await copyEngine.executeOrder({
      conditionId: position.conditionId,
      outcome: position.outcome ?? '',
      tokenId,
      side: 'SELL',
      amount,
      price: slippagePrice,
      orderType: COPY_CONFIG.orderType,
    });

    if (result.success) {
      recordFill(tokenId, position.conditionId, position.outcome, 'SELL', amount, currentPrice);
      remainingBankroll += amount;
    }

    console.log(`[COPY] ${reason.toUpperCase()} exit: SELL $${amount.toFixed(2)} @ ~$${currentPrice.toFixed(4)} | P&L ${(pnlPercent * 100).toFixed(1)}% | ${result.success ? '✅' : '❌'}`);
    logTrade({ ...baseEntry, dryRun: false, skipped: false, executed: result.success, ourAmountUsdc: amount, ourSlippagePrice: slippagePrice, orderId: result.orderId, errorMsg: result.errorMsg, remainingBankrollUsdc: remainingBankroll });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    onError(error);
    logTrade({ ...baseEntry, dryRun: false, skipped: false, executed: false, errorMsg: error.message });
  }
}

/** Periodic, leader-independent risk check: take-profit / stop-loss on our own tracked positions. */
async function runRiskCheck(): Promise<void> {
  const entries = Array.from(positions.entries());
  if (entries.length === 0) return;

  console.log(`[RISK] Checking ${entries.length} positions...`);

  for (const [tokenId, position] of entries) {
    const currentPrice = latestPrices.get(tokenId);

    if (!currentPrice || currentPrice <= 0) {
      console.log(`[RISK] ${tokenId.slice(0, 12)}... no price seen yet, skipping`);
      continue;
    }

    const avgEntryPrice = position.costUsdc / position.shares;
    if (avgEntryPrice <= 0) continue;

    const pnlPercent = (currentPrice - avgEntryPrice) / avgEntryPrice;
    console.log(`[RISK] ${tokenId.slice(0, 12)}... entry=${avgEntryPrice.toFixed(4)} cur=${currentPrice.toFixed(4)} pnl=${(pnlPercent * 100).toFixed(1)}%`);

    if (pnlPercent >= RISK_CONFIG.takeProfitPercent) {
      await closePosition(tokenId, 'take_profit', currentPrice, pnlPercent);
    } else if (pnlPercent <= -RISK_CONFIG.stopLossPercent) {
      await closePosition(tokenId, 'stop_loss', currentPrice, pnlPercent);
    }
  }
}

monitor.on('trade', async (trade: TradeEvent) => {
  stats.tradesDetected++;

  // Keep latest observed trade price for every token — used by runRiskCheck
  // instead of getMidpoint which fails for illiquid CLOB markets.
  if (trade.tokenId && trade.price > 0) {
    latestPrices.set(trade.tokenId, trade.price);
  }

  const isStale = (trade.detectedAt - trade.timestamp) > STALE_TRADE_MS;

  const baseEntry: Omit<CopyLogEntry, 'skipped' | 'skipReason' | 'executed' | 'dryRun'> = {
    loggedAt: new Date().toISOString(),
    source: trade.source,
    detectedAt: trade.detectedAt,
    tradeTimestamp: trade.timestamp,
    detectionLatencyMs: trade.detectedAt - trade.timestamp,
    address: trade.address,
    conditionId: trade.conditionId,
    outcome: trade.outcome,
    tokenId: trade.tokenId,
    side: trade.side,
    leaderPrice: trade.price,
    leaderSize: trade.size,
    leaderValueUsdc: trade.price * trade.size,
  };

  if (isStale) {
    stats.tradesSkipped++;
    logTrade({ ...baseEntry, dryRun: COPY_CONFIG.dryRun, skipped: true, skipReason: 'stale_trade', executed: false });
    return;
  }

  const tradeValue = trade.price * trade.size;
  if (tradeValue < COPY_CONFIG.minTradeSize) {
    stats.tradesSkipped++;
    logTrade({ ...baseEntry, dryRun: COPY_CONFIG.dryRun, skipped: true, skipReason: 'below_min_trade_size', executed: false });
    return;
  }

  if (!trade.conditionId) {
    stats.tradesSkipped++;
    logTrade({ ...baseEntry, dryRun: COPY_CONFIG.dryRun, skipped: true, skipReason: 'missing_condition_id', executed: false });
    return;
  }

  let amount = Math.min(tradeValue * COPY_CONFIG.sizeScale, COPY_CONFIG.maxSizePerTrade);

  // BUYs draw down the shared bankroll; scale the order to whatever's left.
  if (trade.side === 'BUY') {
    if (trade.price < PRICE_FILTER.min || trade.price > PRICE_FILTER.max) {
      stats.tradesSkipped++;
      logTrade({ ...baseEntry, dryRun: COPY_CONFIG.dryRun, skipped: true, skipReason: 'price_out_of_range', executed: false });
      return;
    }
    if (remainingBankroll < COPY_CONFIG.minBankrollFloor) {
      stats.tradesSkipped++;
      logTrade({ ...baseEntry, dryRun: COPY_CONFIG.dryRun, skipped: true, skipReason: 'below_floor', executed: false, remainingBankrollUsdc: remainingBankroll });
      return;
    }
    const existingCost = positions.get(trade.tokenId)?.costUsdc ?? 0;
    const roomInPosition = COPY_CONFIG.maxPositionUsdc - existingCost;
    if (roomInPosition <= 0) {
      stats.tradesSkipped++;
      logTrade({ ...baseEntry, dryRun: COPY_CONFIG.dryRun, skipped: true, skipReason: 'position_cap_reached', executed: false, remainingBankrollUsdc: remainingBankroll });
      return;
    }
    amount = Math.min(amount, remainingBankroll, roomInPosition);
    if (amount < 1) {
      stats.tradesSkipped++;
      logTrade({ ...baseEntry, dryRun: COPY_CONFIG.dryRun, skipped: true, skipReason: 'bankroll_exhausted', executed: false, remainingBankrollUsdc: remainingBankroll });
      return;
    }
  } else {
    // SELLs are sized against what we actually hold, not the leader's trade size —
    // we can't sell more than we have, and if we never copied the BUY there's nothing to mirror.
    const myPositionValue = COPY_CONFIG.dryRun
      ? getOwnPositionValueUsdc(trade.tokenId, trade.price)
      : await getMyPositionValueUsdc(trade.conditionId, trade.tokenId);
    if (myPositionValue < 1) {
      stats.tradesSkipped++;
      logTrade({ ...baseEntry, dryRun: COPY_CONFIG.dryRun, skipped: true, skipReason: 'no_position_to_sell', executed: false });
      return;
    }
    amount = Math.min(amount, myPositionValue);
  }

  // FOK/FAK `price` is the worst acceptable fill price (slippage bound).
  const slippagePrice = trade.side === 'BUY'
    ? Math.min(trade.price + COPY_CONFIG.maxSlippage, 1)
    : Math.max(trade.price - COPY_CONFIG.maxSlippage, 0);

  if (COPY_CONFIG.dryRun) {
    recordFill(trade.tokenId, trade.conditionId, trade.outcome, trade.side, amount, trade.price);
    if (trade.side === 'BUY') {
      remainingBankroll -= amount;
    } else {
      remainingBankroll += amount;
    }

    console.log(`[COPY] (dry-run) would ${trade.side} $${amount.toFixed(2)} @ ~$${slippagePrice.toFixed(4)} | bankroll left: $${remainingBankroll.toFixed(2)}`);
    stats.tradesExecuted++;
    onTrade(trade, { success: true });
    logTrade({
      ...baseEntry,
      dryRun: true,
      skipped: false,
      executed: true,
      ourAmountUsdc: amount,
      ourSlippagePrice: slippagePrice,
      remainingBankrollUsdc: remainingBankroll,
    });
    return;
  }

  try {
    const result = await copyEngine.executeOrder({
      conditionId: trade.conditionId,
      outcome: trade.outcome ?? '',
      tokenId: trade.tokenId,
      side: trade.side,
      amount,
      price: slippagePrice,
      orderType: COPY_CONFIG.orderType,
    });

    if (result.success) {
      stats.tradesExecuted++;
      recordFill(trade.tokenId, trade.conditionId, trade.outcome, trade.side, amount, trade.price);
      if (trade.side === 'BUY') {
        remainingBankroll -= amount;
      } else {
        remainingBankroll += amount;
      }
    } else {
      stats.tradesFailed++;
    }

    onTrade(trade, result);
    logTrade({
      ...baseEntry,
      dryRun: false,
      skipped: false,
      executed: result.success,
      ourAmountUsdc: amount,
      ourSlippagePrice: slippagePrice,
      orderId: result.orderId,
      errorMsg: result.errorMsg,
      remainingBankrollUsdc: remainingBankroll,
    });
  } catch (err) {
    stats.tradesFailed++;
    const error = err instanceof Error ? err : new Error(String(err));
    onError(error);
    logTrade({
      ...baseEntry,
      dryRun: false,
      skipped: false,
      executed: false,
      ourAmountUsdc: amount,
      ourSlippagePrice: slippagePrice,
      errorMsg: error.message,
    });
  }
});

monitor.watch(targetAddresses, 'polling');
console.log(`[COPY] Siguiendo ${targetAddresses.length} wallets (dryRun=${COPY_CONFIG.dryRun})`);

// ── RISK MANAGEMENT ───────────────────────────
// Independent of the leader: take-profit/stop-loss our own open positions.
const riskCheckInterval = setInterval(() => {
  runRiskCheck().catch((err) => onError(err instanceof Error ? err : new Error(String(err))));
}, RISK_CONFIG.checkIntervalMs);

// ── ARBITRAJE ─────────────────────────────────
// const arbService = sdk.arbitrage ?? null;
// // El ArbitrageService escanea y loguea oportunidades
// // con autoExecute: false solo monitorea sin operar
// const arbConfig = {
//   profitThreshold: 0.005,
//   minTradeSize: 5,
//   maxTradeSize: 50,
//   autoExecute: false, // 👈 cambiar a true cuando quieras operar
// };

// ── DIP ARB ───────────────────────────────────
// sdk.dipArb.updateConfig({
//   shares: 5,
//   sumTarget: 0.9,
//   dipThreshold: 0.15,
//   autoExecute: false, // 👈 cambiar a true cuando quieras operar
// });

// sdk.dipArb.on('signal', (signal) => {
//   console.log(`[DIPARB] Señal: ${signal.type} ${signal.side} @ ${signal.price}`);
// });

// sdk.dipArb.on('roundComplete', (result) => {
//   console.log(`[DIPARB] Ronda completa | Profit: $${result.profit?.toFixed(2)}`);
// });

// const dipMarket = await sdk.dipArb.findAndStart({ coin: 'BTC', preferDuration: '15m' });
// console.log(`[DIPARB] Monitoreando: ${dipMarket?.market?.name}`);

// ── STATS cada 5 minutos ──────────────────────
setInterval(() => {
  console.log(`[STATS] Detectados: ${stats.tradesDetected} | Ejecutados: ${stats.tradesExecuted}`);
}, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Deteniendo bot...');
  clearInterval(riskCheckInterval);
  monitor.stop();
  sdk.stop();
  process.exit(0);
});
