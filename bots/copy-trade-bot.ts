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
  maxSizePerTrade: 10,
  // Total USDC budget shared across all copied BUYs. Each BUY is scaled down
  // to fit whatever remains; SELLs return their proceeds to the pool (capped
  // at the original bankroll, so profits aren't auto-reinvested).
  bankroll: 20,
  maxSlippage: 0.03,
  orderType: 'FOK' as const,
  minTradeSize: 5,
  dryRun: true, // 👈 cambiar a false cuando quieras operar real
};

// Remaining USDC budget. Decremented on BUYs, replenished (up to bankroll) on SELLs.
let remainingBankroll = COPY_CONFIG.bankroll;

// Dry-run never places real orders, so there's no on-chain position to check —
// track simulated USDC value per tokenId instead, fed by our own simulated fills.
const simulatedPositions = new Map<string, number>();

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

/** USDC value of our own position in this token, or 0 if we don't hold it. */
async function getMyPositionValueUsdc(conditionId: string, tokenId: string): Promise<number> {
  const positions = await sdk.dataApi.getPositions(myAddress, { market: [conditionId] });
  const position = positions.find((p) => p.asset === tokenId);
  if (!position || position.size <= 0) return 0;
  return position.currentValue ?? position.size * (position.curPrice ?? 0);
}

monitor.on('trade', async (trade: TradeEvent) => {
  stats.tradesDetected++;

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
    amount = Math.min(amount, remainingBankroll);
    if (amount < 1) {
      stats.tradesSkipped++;
      logTrade({ ...baseEntry, dryRun: COPY_CONFIG.dryRun, skipped: true, skipReason: 'bankroll_exhausted', executed: false, remainingBankrollUsdc: remainingBankroll });
      return;
    }
  } else {
    // SELLs are sized against what we actually hold, not the leader's trade size —
    // we can't sell more than we have, and if we never copied the BUY there's nothing to mirror.
    const myPositionValue = COPY_CONFIG.dryRun
      ? (simulatedPositions.get(trade.tokenId) ?? 0)
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
    const heldValue = simulatedPositions.get(trade.tokenId) ?? 0;
    if (trade.side === 'BUY') {
      remainingBankroll -= amount;
      simulatedPositions.set(trade.tokenId, heldValue + amount);
    } else {
      remainingBankroll = Math.min(remainingBankroll + amount, COPY_CONFIG.bankroll);
      const remaining = heldValue - amount;
      if (remaining > 0.01) simulatedPositions.set(trade.tokenId, remaining);
      else simulatedPositions.delete(trade.tokenId);
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
      if (trade.side === 'BUY') {
        remainingBankroll -= amount;
      } else {
        remainingBankroll = Math.min(remainingBankroll + amount, COPY_CONFIG.bankroll);
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
  monitor.stop();
  sdk.stop();
  process.exit(0);
});
