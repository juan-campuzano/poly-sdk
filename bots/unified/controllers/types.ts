import { EventEmitter } from 'events';

// ── Kinds ──────────────────────────────────────────────────────────────────

export type StrategyKind = 'arbitrage' | 'copy-trade' | 'dip-arb';

// ── Status ─────────────────────────────────────────────────────────────────

export type StrategyStatusValue = 'stopped' | 'running' | 'paused' | 'degraded' | 'error';
export type StrategyMode = 'dry-run' | 'live';

export interface StrategyStatus {
  kind: StrategyKind;
  status: StrategyStatusValue;
  mode: StrategyMode;
  committedUsdc: number;
  realizedPnlUsdc: number;
  unrealizedPnlUsdc: number;
  watchingMarket?: string;
}

// ── Params ─────────────────────────────────────────────────────────────────

export interface StrategyParams {
  maxSizePerTradeUsdc: number;
  maxPositionUsdc: number;
  minTradeSizeUsdc: number;
  maxSlippage: number;
  profitThreshold: number;
  sumTarget: number;
  dipThreshold: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  priceFilterMin: number;
  priceFilterMax: number;
  topN: number;
  maxPositions: number;
  maxPositionAgeMs: number;
}

export const DEFAULT_PARAMS: Record<StrategyKind, Partial<StrategyParams>> = {
  'arbitrage': {
    profitThreshold: 0.005,
    minTradeSizeUsdc: 5,
    maxSizePerTradeUsdc: 50,
    maxPositionUsdc: 999,
  },
  'copy-trade': {
    maxSizePerTradeUsdc: 1,
    maxPositionUsdc: 5,
    minTradeSizeUsdc: 0.5,  // must be < maxSizePerTradeUsdc or no trades ever fire
    maxSlippage: 0.03,
    // TP must be >= SL: with the old 10%/20% split, sim data showed winners
    // paying +$0.16 avg while losers cost -$1.05 avg (net -72 USD over a day)
    takeProfitPercent: 0.15,
    stopLossPercent: 0.10,
    priceFilterMin: 0.10,
    priceFilterMax: 0.80,
    topN: 50,
    maxPositions: 10,
    maxPositionAgeMs: 8 * 3600 * 1000, // 8 hours
  },
  'dip-arb': {
    maxSizePerTradeUsdc: 20,
    minTradeSizeUsdc: 5,
    sumTarget: 0.92,
    dipThreshold: 0.15,
  },
};

// ── Trade ──────────────────────────────────────────────────────────────────

export interface Trade {
  loggedAt: string;
  strategy: StrategyKind;
  mode: StrategyMode;
  marketName: string;
  conditionId?: string;
  tokenId: string;
  outcome?: string;
  side: 'BUY' | 'SELL';
  price: number;
  sizeUsdc: number;
  result: 'success' | 'skipped' | 'failed';
  reason?: string;
  errorMsg?: string;
}

// ── Position ───────────────────────────────────────────────────────────────

export interface Position {
  strategy: StrategyKind;
  tokenId: string;
  conditionId?: string;
  outcome?: string;
  shares: number;
  costBasisUsdc: number;
  currentPrice: number;
  currentValueUsdc: number;
  unrealizedPnlUsdc: number;
  isSimulated: boolean;
}

// ── StrategyState ──────────────────────────────────────────────────────────

export interface StrategyState {
  kind: StrategyKind;
  enabled: boolean;
  status: StrategyStatusValue;
  mode: StrategyMode;
  params: Partial<StrategyParams>;
  committedUsdc: number;
  openPositions: Position[];
  recentTrades: Trade[];      // ring buffer newest first, max 50
  realizedPnlUsdc: number;
  unrealizedPnlUsdc: number;
  lastError: string | null;
  watchingMarket?: string;    // human-readable name of the market currently being watched
}

// ── StrategyController interface ───────────────────────────────────────────

export interface StrategyController extends EventEmitter {
  readonly kind: StrategyKind;

  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;

  setMode(mode: StrategyMode): void;
  updateParams(patch: Partial<StrategyParams>): void;
  getState(): StrategyState;

  on(event: 'trade',    listener: (t: Trade) => void): this;
  on(event: 'position', listener: (p: Position) => void): this;
  on(event: 'status',   listener: (s: StrategyStatus) => void): this;
  on(event: 'error',    listener: (e: { message: string }) => void): this;
  on(event: string,     listener: (...args: unknown[]) => void): this;
}
