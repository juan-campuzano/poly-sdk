import { appendFileSync } from 'fs';
import {
  type DipArbSignal,
  type DipArbExecutionResult,
  type DipArbRoundResult,
  type DipArbMarketConfig,
  isDipArbLeg1Signal,
} from '/Users/juan-campuzano/Documents/projects/20-experiments/poly-sdk/src/services/dip-arb-service.ts';
import { PolymarketSDK } from '/Users/juan-campuzano/Documents/projects/20-experiments/poly-sdk/src/index.ts';

console.log('🤖 Bot iniciado');

// ── LOGGING para análisis de rentabilidad ────
const LOG_FILE = process.env.DIP_ARB_LOG_FILE ?? 'dip-arb-trades.jsonl';

interface DipArbLogEntry {
  loggedAt: string;
  type: 'signal' | 'execution' | 'roundComplete';
  marketName: string;
  roundId: string;
  side?: string;
  source?: string;
  profitRate?: number;
  success?: boolean;
  price?: number;
  shares?: number;
  profit?: number;
  errorMsg?: string;
}

function logEntry(entry: DipArbLogEntry): void {
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

// ── DIP ARB ────────────────────────────────────
const DIP_ARB_CONFIG = {
  shares: 20,
  sumTarget: 0.92,
  dipThreshold: 0.15,
  autoExecute: false, // 👈 cambiar a true cuando quieras operar real
  autoMerge: true,
  debug: false,
};

const TARGET_CONFIG = {
  coin: undefined as 'BTC' | 'ETH' | 'SOL' | 'XRP' | undefined, // undefined = cualquiera
  preferDuration: '15m' as '5m' | '15m',
};

const sdk = await PolymarketSDK.create({
  privateKey: process.env.POLYMARKET_PRIVATE_KEY,
});

const service = sdk.dipArb;
service.updateConfig(DIP_ARB_CONFIG);

let currentMarket: DipArbMarketConfig | null = null;

const stats = {
  signalsSeen: 0,
  executionsAttempted: 0,
  executionsSucceeded: 0,
  roundsCompleted: 0,
};

service.on('signal', (signal: DipArbSignal) => {
  stats.signalsSeen++;
  if (isDipArbLeg1Signal(signal)) {
    console.log(`[DIPARB] Leg1 ${signal.dipSide} +${(signal.dropPercent * 100).toFixed(1)}% | target ${signal.targetPrice.toFixed(4)} | est.profit ${(signal.estimatedProfitRate * 100).toFixed(2)}%`);
    logEntry({
      loggedAt: new Date().toISOString(),
      type: 'signal',
      marketName: currentMarket?.name ?? 'unknown',
      roundId: signal.roundId,
      side: signal.dipSide,
      source: signal.source,
      profitRate: signal.estimatedProfitRate,
      price: signal.targetPrice,
    });
  } else {
    console.log(`[DIPARB] Leg2 ${signal.hedgeSide} | totalCost ${signal.totalCost.toFixed(4)} | est.profit ${(signal.expectedProfitRate * 100).toFixed(2)}%`);
    logEntry({
      loggedAt: new Date().toISOString(),
      type: 'signal',
      marketName: currentMarket?.name ?? 'unknown',
      roundId: signal.roundId,
      side: signal.hedgeSide,
      profitRate: signal.expectedProfitRate,
      price: signal.targetPrice,
    });
  }
});

service.on('execution', (result: DipArbExecutionResult) => {
  stats.executionsAttempted++;
  if (result.success) stats.executionsSucceeded++;
  console.log(`[DIPARB] Execution ${result.success ? '✅' : '❌'} ${result.leg} | shares ${result.shares?.toFixed(2) ?? '-'} @ ${result.price?.toFixed(4) ?? '-'} ${result.error ?? ''}`);
  logEntry({
    loggedAt: new Date().toISOString(),
    type: 'execution',
    marketName: currentMarket?.name ?? 'unknown',
    roundId: result.roundId,
    side: result.side,
    success: result.success,
    price: result.price,
    shares: result.shares,
    errorMsg: result.error,
  });
});

service.on('roundComplete', (result: DipArbRoundResult) => {
  stats.roundsCompleted++;
  console.log(`[DIPARB] Round ${result.status} | profit $${result.profit?.toFixed(2) ?? '0.00'} (${((result.profitRate ?? 0) * 100).toFixed(2)}%) | merged ${result.merged}`);
  logEntry({
    loggedAt: new Date().toISOString(),
    type: 'roundComplete',
    marketName: currentMarket?.name ?? 'unknown',
    roundId: result.roundId,
    profitRate: result.profitRate,
    profit: result.profit,
    success: result.status === 'completed',
  });
});

service.on('error', (err: Error) => console.error('[DIPARB ERROR]', err));

const market = await service.findAndStart({
  coin: TARGET_CONFIG.coin,
  preferDuration: TARGET_CONFIG.preferDuration,
});

if (!market) {
  console.log('[DIPARB] No se encontraron mercados UP/DOWN adecuados, deteniendo bot');
  process.exit(0);
}

currentMarket = market;
console.log(`[DIPARB] Mercado objetivo: ${market.name} (cierra ${market.endTime.toISOString()})`);
console.log(`[DIPARB] Monitoreando en vivo (autoExecute=${DIP_ARB_CONFIG.autoExecute})`);

// ── STATS cada 5 minutos ──────────────────────
setInterval(() => {
  console.log(`[STATS] Señales: ${stats.signalsSeen} | Ejecuciones: ${stats.executionsSucceeded}/${stats.executionsAttempted} | Rondas: ${stats.roundsCompleted}`);
}, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Deteniendo bot...');
  await service.stop();
  process.exit(0);
});
