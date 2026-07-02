import { EventEmitter } from 'events';
import {
  ArbitrageService,
  type ArbitrageMarketConfig,
  type ArbitrageOpportunity,
  type ArbitrageExecutionResult,
} from '../../../src/services/arbitrage-service.ts';
import { PolymarketSDK } from '../../../src/index.ts';
import { getLogger } from '../../../src/core/logger.ts';
import type {
  StrategyKind, StrategyMode, StrategyParams, StrategyState,
  StrategyStatus, Trade, Position, StrategyController,
} from './types.ts';
import { DEFAULT_PARAMS } from './types.ts';
import type { BankrollLedger } from '../bankroll/ledger.ts';

const log = getLogger();

export class ArbitrageController extends EventEmitter implements StrategyController {
  readonly kind: StrategyKind = 'arbitrage';

  private service: ArbitrageService;
  private _mode: StrategyMode = 'dry-run';
  private _status: 'stopped' | 'running' | 'paused' | 'degraded' | 'error' = 'stopped';
  private _paused = false;
  private _params: Partial<StrategyParams>;
  private _currentMarket: ArbitrageMarketConfig | null = null;
  private _realizedPnl = 0;
  private _openPositions: Position[] = [];

  constructor(
    private sdk: PolymarketSDK,
    private ledger: BankrollLedger,
    private privateKey: string | undefined,
    params: Partial<StrategyParams> = {},
  ) {
    super();
    this._params = { ...DEFAULT_PARAMS['arbitrage'], ...params };
    this.service = this._buildService();
  }

  private _buildService(): ArbitrageService {
    return new ArbitrageService({
      privateKey: this.privateKey,
      profitThreshold: this._params.profitThreshold ?? 0.005,
      minTradeSize: this._params.minTradeSizeUsdc ?? 5,
      maxTradeSize: this._params.maxSizePerTradeUsdc ?? 50,
      autoExecute: this._mode === 'live',
      enableLogging: false,
      logger: log,
    });
  }

  private _wireService(): void {
    this.service.on('opportunity', (opp: ArbitrageOpportunity) => {
      if (this._paused) return;
      if (this._mode === 'dry-run') {
        this._emitSimulatedTrade(opp);
        return;
      }
      // Live: autoExecute handles it inside service
    });

    this.service.on('execution', (result: ArbitrageExecutionResult) => {
      const sizeUsdc = result.profit ?? (this._params.maxSizePerTradeUsdc ?? 50);
      const trade: Trade = {
        loggedAt: new Date().toISOString(),
        strategy: 'arbitrage',
        mode: this._mode,
        marketName: this._currentMarket?.name ?? 'unknown',
        conditionId: this._currentMarket?.conditionId,
        tokenId: this._currentMarket?.yesTokenId ?? '',
        side: 'BUY',
        price: 0,
        sizeUsdc,
        result: result.success ? 'success' : 'failed',
        reason: 'arb',
        errorMsg: result.success ? undefined : 'Execution failed',
      };
      this.emit('trade', trade);
      this._emitStatus();
    });

    this.service.on('error', (err: Error) => {
      log.warn(`[arb-controller] service error: ${err.message}`);
      this._status = 'error';
      this.emit('error', { message: err.message });
      this._emitStatus();
    });

    this.service.on('stopped', () => {
      this._status = 'stopped';
      this._emitStatus();
    });
  }

  private _emitSimulatedTrade(opp: ArbitrageOpportunity): void {
    const sizeUsdc = Math.min(opp.recommendedSize ?? 20, this._params.maxSizePerTradeUsdc ?? 50);
    const reserved = this.ledger.reserve('arbitrage', sizeUsdc);
    if (!reserved.ok) return;

    const trade: Trade = {
      loggedAt: new Date().toISOString(),
      strategy: 'arbitrage',
      mode: 'dry-run',
      marketName: this._currentMarket?.name ?? 'unknown',
      conditionId: this._currentMarket?.conditionId,
      tokenId: this._currentMarket?.yesTokenId ?? '',
      side: 'BUY',
      price: opp.effectivePrices.buyYes,
      sizeUsdc,
      result: 'success',
      reason: `arb-${opp.type}`,
    };
    this.emit('trade', trade);

    // Simulate instant position
    const position: Position = {
      strategy: 'arbitrage',
      tokenId: this._currentMarket?.yesTokenId ?? '',
      conditionId: this._currentMarket?.conditionId,
      outcome: this._currentMarket?.outcomes?.[0],
      shares: sizeUsdc,
      costBasisUsdc: sizeUsdc,
      currentPrice: opp.effectivePrices.buyYes,
      currentValueUsdc: sizeUsdc * (1 + (opp.profitPercent ?? 0)),
      unrealizedPnlUsdc: sizeUsdc * (opp.profitPercent ?? 0),
      isSimulated: true,
    };
    this._openPositions = [position];
    this.emit('position', position);

    // Simulate close immediately with profit
    setTimeout(() => {
      this.ledger.release('arbitrage', sizeUsdc);
      this._realizedPnl += sizeUsdc * (opp.profitPercent ?? 0);
      this._openPositions = [];
      const sellTrade: Trade = { ...trade, side: 'SELL', loggedAt: new Date().toISOString(), reason: 'arb-close' };
      this.emit('trade', sellTrade);
      this._emitStatus();
    }, 2000);
  }

  async start(): Promise<void> {
    try {
      this._status = 'running';
      this._paused = false;
      this._emitStatus();

      const candidates = await this.sdk.markets.scanCryptoShortTermMarkets({
        coin: 'all',
        duration: '5m',
        minMinutesUntilEnd: 2,
        maxMinutesUntilEnd: 30,
        limit: 10,
        sortBy: 'endDate',
      });

      if (candidates.length === 0) {
        this._status = 'degraded';
        this.emit('error', { message: 'No short-term crypto markets found' });
        this._emitStatus();
        return;
      }

      const candidate = candidates[0];
      const clobMarket = await this.sdk.markets.getMarket(candidate.conditionId);
      const [upToken, downToken] = clobMarket.tokens;

      if (!upToken || !downToken) {
        this._status = 'error';
        this.emit('error', { message: `Market "${candidate.question}" missing tokens` });
        this._emitStatus();
        return;
      }

      this._currentMarket = {
        name: candidate.question,
        conditionId: candidate.conditionId,
        yesTokenId: upToken.tokenId,
        noTokenId: downToken.tokenId,
        outcomes: [upToken.outcome, downToken.outcome] as [string, string],
      };

      this.service = this._buildService();
      this._wireService();
      await this.service.start(this._currentMarket);
    } catch (err) {
      this._status = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('error', { message: msg });
      this._emitStatus();
    }
  }

  pause(): void {
    this._paused = true;
    this._status = 'paused';
    this._emitStatus();
  }

  resume(): void {
    this._paused = false;
    this._status = 'running';
    this._emitStatus();
  }

  async stop(): Promise<void> {
    try {
      await this.service.stop();
    } catch { /* best effort */ }
    for (const pos of this._openPositions) {
      this.ledger.release('arbitrage', pos.costBasisUsdc);
    }
    this._openPositions = [];
    this._status = 'stopped';
    this._emitStatus();
  }

  setMode(mode: StrategyMode): void {
    this._mode = mode;
    this._emitStatus();
  }

  updateParams(patch: Partial<StrategyParams>): void {
    this._params = { ...this._params, ...patch };
  }

  getState(): StrategyState {
    return {
      kind: 'arbitrage',
      enabled: true,
      status: this._status,
      mode: this._mode,
      params: this._params,
      committedUsdc: this.ledger.snapshot().committedByStrategy['arbitrage'],
      openPositions: this._openPositions,
      recentTrades: [],
      realizedPnlUsdc: this._realizedPnl,
      unrealizedPnlUsdc: this._openPositions.reduce((s, p) => s + p.unrealizedPnlUsdc, 0),
      lastError: null,
      watchingMarket: this._currentMarket?.name,
    };
  }

  private _emitStatus(): void {
    const status: StrategyStatus = {
      kind: 'arbitrage',
      status: this._status,
      mode: this._mode,
      committedUsdc: this.ledger.snapshot().committedByStrategy['arbitrage'],
      realizedPnlUsdc: this._realizedPnl,
      unrealizedPnlUsdc: this._openPositions.reduce((s, p) => s + p.unrealizedPnlUsdc, 0),
      watchingMarket: this._currentMarket?.name,
    };
    this.emit('status', status);
  }
}
