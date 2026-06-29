import { appendFileSync } from 'fs';
import {
  ArbitrageService,
  type ArbitrageOpportunity,
  type ArbitrageExecutionResult,
  type ArbitrageMarketConfig,
} from '/Users/juan-campuzano/Documents/projects/20-experiments/poly-sdk/src/services/arbitrage-service.ts';
import { defaultConsoleLogger } from '/Users/juan-campuzano/Documents/projects/20-experiments/poly-sdk/src/core/logger.ts';
import { PolymarketSDK } from '/Users/juan-campuzano/Documents/projects/20-experiments/poly-sdk/src/index.ts';

console.log('🤖 Bot iniciado');

// ── LOGGING para análisis de rentabilidad ────
const LOG_FILE = process.env.ARB_LOG_FILE ?? 'arbitrage-trades.jsonl';

interface ArbLogEntry {
  loggedAt: string;
  type: 'opportunity' | 'execution';
  marketName: string;
  arbType: 'long' | 'short';
  profitPercent: number;
  recommendedSize?: number;
  estimatedProfit?: number;
  success?: boolean;
  profit?: number;
  txHashes?: string[];
  errorMsg?: string;
}

function logEntry(entry: ArbLogEntry): void {
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

// ── ARBITRAJE ─────────────────────────────────
const ARB_CONFIG = {
  profitThreshold: 0.005,
  minTradeSize: 5,
  maxTradeSize: 50,
  autoExecute: false, // 👈 cambiar a true cuando quieras operar real
};

// Crypto up/down markets have wide spreads (fast-moving underlying), so they're a
// better target for live arb detection than slow REST scans across all markets.
// Real arb windows last ms-seconds: scanMarkets() is a one-time REST snapshot and
// is too slow to reliably catch them. service.start() below opens a live WebSocket
// and evaluates checkOpportunity() on every orderbook tick instead.
const TARGET_CONFIG = {
  coin: 'all' as const, // 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'all'
  duration: '5m' as const, // '5m' | '15m' | '1h' | '4h' | 'all'
  minMinutesUntilEnd: 2,
  maxMinutesUntilEnd: 30,
};

const sdk = await PolymarketSDK.create({
  privateKey: process.env.POLYMARKET_PRIVATE_KEY,
});

const service = new ArbitrageService({
  privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  profitThreshold: ARB_CONFIG.profitThreshold,
  minTradeSize: ARB_CONFIG.minTradeSize,
  maxTradeSize: ARB_CONFIG.maxTradeSize,
  autoExecute: ARB_CONFIG.autoExecute,
  logger: defaultConsoleLogger,
});

let currentMarket: ArbitrageMarketConfig | null = null;

const stats = {
  opportunitiesSeen: 0,
  executionsAttempted: 0,
  executionsSucceeded: 0,
};

service.on('opportunity', (opportunity: ArbitrageOpportunity) => {
  stats.opportunitiesSeen++;
  console.log(`[ARB] ${opportunity.type.toUpperCase()} +${opportunity.profitPercent.toFixed(2)}% | size ${opportunity.recommendedSize.toFixed(2)} | est. $${opportunity.estimatedProfit.toFixed(2)}`);
  logEntry({
    loggedAt: new Date().toISOString(),
    type: 'opportunity',
    marketName: currentMarket?.name ?? 'unknown',
    arbType: opportunity.type,
    profitPercent: opportunity.profitPercent,
    recommendedSize: opportunity.recommendedSize,
    estimatedProfit: opportunity.estimatedProfit,
  });
});

service.on('execution', (result: ArbitrageExecutionResult) => {
  stats.executionsAttempted++;
  if (result.success) stats.executionsSucceeded++;
  console.log(`[ARB] Execution ${result.success ? '✅' : '❌'} ${result.type} | size ${result.size.toFixed(2)} | profit $${result.profit.toFixed(2)} ${result.error ?? ''}`);
  logEntry({
    loggedAt: new Date().toISOString(),
    type: 'execution',
    marketName: currentMarket?.name ?? 'unknown',
    arbType: result.type,
    profitPercent: 0,
    success: result.success,
    profit: result.profit,
    txHashes: result.txHashes,
    errorMsg: result.error,
  });
});

service.on('error', (err: Error) => console.error('[ARB ERROR]', err));

const candidates = await sdk.markets.scanCryptoShortTermMarkets({
  coin: TARGET_CONFIG.coin,
  duration: TARGET_CONFIG.duration,
  minMinutesUntilEnd: TARGET_CONFIG.minMinutesUntilEnd,
  maxMinutesUntilEnd: TARGET_CONFIG.maxMinutesUntilEnd,
  limit: 10,
  sortBy: 'endDate',
});

if (candidates.length === 0) {
  console.log('[ARB] No se encontraron mercados cripto de corto plazo activos, deteniendo bot');
  process.exit(0);
}

const candidate = candidates[0];
const clobMarket = await sdk.markets.getMarket(candidate.conditionId);
const [upToken, downToken] = clobMarket.tokens;

if (!upToken || !downToken) {
  console.log(`[ARB] Mercado "${candidate.question}" no tiene dos tokens válidos, deteniendo bot`);
  process.exit(0);
}

const market: ArbitrageMarketConfig = {
  name: candidate.question,
  conditionId: candidate.conditionId,
  yesTokenId: upToken.tokenId,
  noTokenId: downToken.tokenId,
  outcomes: [upToken.outcome, downToken.outcome] as [string, string],
};

console.log(`[ARB] Mercado objetivo: ${market.name} (cierra ${candidate.endDate})`);
currentMarket = market;
await service.start(market);
console.log(`[ARB] Monitoreando en vivo: ${market.name} (autoExecute=${ARB_CONFIG.autoExecute})`);

// ── STATS cada 5 minutos ──────────────────────
setInterval(() => {
  console.log(`[STATS] Oportunidades: ${stats.opportunitiesSeen} | Ejecuciones: ${stats.executionsSucceeded}/${stats.executionsAttempted}`);
}, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Deteniendo bot...');
  await service.stop();
  process.exit(0);
});
