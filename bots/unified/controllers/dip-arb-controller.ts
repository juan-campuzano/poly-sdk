import { EventEmitter } from 'events';
import type { DipArbMarketConfig, DipArbSignal, DipArbExecutionResult, DipArbRoundResult } from '../../../src/services/dip-arb-service.ts';
import { calculateDipArbProfitRate } from '../../../src/services/dip-arb-service.ts';
import { PolymarketSDK } from '../../../src/index.ts';
import { getLogger } from '../../../src/core/logger.ts';
import type {
  StrategyKind, StrategyMode, StrategyParams, StrategyState,
  StrategyStatus, Trade, Position, StrategyController,
} from './types.ts';
import { DEFAULT_PARAMS } from './types.ts';
import type { BankrollLedger } from '../bankroll/ledger.ts';

const log = getLogger();

export class DipArbController extends EventEmitter implements StrategyController {
  readonly kind: StrategyKind = 'dip-arb';

  private _mode: StrategyMode = 'dry-run';
  private _status: 'stopped' | 'running' | 'paused' | 'degraded' | 'error' = 'stopped';
  private _paused = false;
  private _params: Partial<StrategyParams>;
  private _currentMarket: DipArbMarketConfig | null = null;
  private _openPositions: Position[] = [];
  private _realizedPnl = 0;
  private _simRound: {
    roundId: string;
    dipSide: 'UP' | 'DOWN';
    entryPrice: number;
    sizeUsdc: number;
    tokenId: string;
    startedAt: number;
  } | null = null;
  private _simHedgeCheckInterval: ReturnType<typeof setInterval> | null = null;
  // Set after a simulated leg2-timeout loss: no re-entry until market rotation
  private _simHaltUntilRotation = false;

  constructor(
    private sdk: PolymarketSDK,
    private ledger: BankrollLedger,
    params: Partial<StrategyParams> = {},
  ) {
    super();
    this._params = { ...DEFAULT_PARAMS['dip-arb'], ...params };
  }

  async start(): Promise<void> {
    try {
      this._status = 'running';
      this._paused = false;
      this._emitStatus();

      const service = this.sdk.dipArb;

      // sdk.dipArb is a singleton — remove stale listeners from any previous
      // start() call to prevent duplicates on restart.
      service.removeAllListeners('signal');
      service.removeAllListeners('execution');
      service.removeAllListeners('roundComplete');
      service.removeAllListeners('error');
      service.removeAllListeners('stopped');
      service.removeAllListeners('started');
      service.removeAllListeners('rotate');

      service.updateConfig({
        autoExecute: this._mode === 'live',
        sumTarget: this._params.sumTarget ?? 0.92,
        dipThreshold: this._params.dipThreshold ?? 0.15,
        shares: (this._params.maxSizePerTradeUsdc ?? 10),
      });

      service.on('signal', (signal: DipArbSignal) => {
        if (this._paused) return;
        if (this._mode === 'dry-run') {
          this._handleSimulatedSignal(signal);
        }
        // Live: autoExecute=true handles execution inside service
      });

      // execution fires for live orders only; dry-run is handled by the signal
      // handler above, so skip here to avoid emitting the trade twice.
      service.on('execution', (result: DipArbExecutionResult) => {
        if (this._paused || this._mode === 'dry-run') return;
        const sizeUsdc = this._params.maxSizePerTradeUsdc ?? 10;
        const reserved = this.ledger.reserve('dip-arb', sizeUsdc);
        const trade: Trade = {
          loggedAt: new Date().toISOString(),
          strategy: 'dip-arb',
          mode: this._mode,
          marketName: this._currentMarket?.name ?? 'unknown',
          conditionId: this._currentMarket?.conditionId,
          tokenId: this._currentMarket?.upTokenId ?? '',
          side: result.leg === 'merge' ? 'SELL' : 'BUY',
          price: result.price ?? 0,
          sizeUsdc: reserved.ok ? sizeUsdc : 0,
          result: result.success ? 'success' : 'failed',
          reason: `dip-arb-${result.leg}`,
        };
        this.emit('trade', trade);
        if (!reserved.ok) return;
        this._emitStatus();
      });

      service.on('roundComplete', (round: DipArbRoundResult) => {
        this._realizedPnl += round.profit ?? 0;
        const sizeUsdc = this._params.maxSizePerTradeUsdc ?? 10;
        this.ledger.release('dip-arb', sizeUsdc);
        this._openPositions = [];
        this._emitStatus();
      });

      service.on('error', (err: Error) => {
        log.warn(`[dip-arb-controller] service error: ${err.message}`);
        this._status = 'degraded';
        this.emit('error', { message: err.message });
        this._emitStatus();
      });

      service.on('stopped', () => {
        if (this._status !== 'stopped') {
          this._status = 'stopped';
          this._emitStatus();
        }
      });

      // Keep _currentMarket in sync when the service auto-rotates to a new market
      // (happens when the watched market expires or resolves).
      service.on('started', (market: import('../../../src/services/dip-arb-types.ts').DipArbMarketConfig) => {
        this._currentMarket = market;
        // Clear any stuck simulated position/round from the old market
        if (this._openPositions.length > 0) {
          for (const pos of this._openPositions) this.ledger.release('dip-arb', pos.costBasisUsdc);
          this._openPositions = [];
        }
        this._simRound = null;
        this._simHaltUntilRotation = false;
        this._emitStatus();
        log.info(`[dip-arb-controller] rotated to: ${market.name}`);
      });

      service.on('rotate', () => {
        // 'started' will fire right after with the new market config — nothing to do here
      });

      const market = await service.findAndStart({
        coin: undefined,
        preferDuration: '15m',
      });

      if (!market) {
        this._status = 'degraded';
        this.emit('error', { message: 'No suitable UP/DOWN market found' });
        this._emitStatus();
        return;
      }

      this._currentMarket = market;
      log.info(`[dip-arb-controller] started: ${market.name}`);
    } catch (err) {
      this._status = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('error', { message: msg });
      this._emitStatus();
    }
  }

  private _handleSimulatedSignal(signal: DipArbSignal): void {
    if (signal.type !== 'leg1') return; // only open sim rounds on leg1 entry signals

    // One simulated round at a time — skip new signals while a round is in flight
    if (this._simRound) return;

    // A leg2 timeout in this market proved the dip was directional — wait for rotation
    if (this._simHaltUntilRotation) return;

    const sizeUsdc = this._params.maxSizePerTradeUsdc ?? 10;
    const reserved = this.ledger.reserve('dip-arb', sizeUsdc);
    if (!reserved.ok) return;

    const entryPrice = signal.targetPrice;
    const tokenId = signal.tokenId || (this._currentMarket?.upTokenId ?? '');

    const trade: Trade = {
      loggedAt: new Date().toISOString(),
      strategy: 'dip-arb',
      mode: 'dry-run',
      marketName: this._currentMarket?.name ?? 'unknown',
      conditionId: this._currentMarket?.conditionId,
      tokenId,
      side: 'BUY',
      price: entryPrice,
      sizeUsdc,
      result: 'success',
      reason: `dip-arb-${signal.source}`,
    };
    this.emit('trade', trade);

    const pos: Position = {
      strategy: 'dip-arb',
      tokenId,
      conditionId: this._currentMarket?.conditionId,
      shares: sizeUsdc,
      costBasisUsdc: sizeUsdc,
      currentPrice: entryPrice,
      currentValueUsdc: sizeUsdc,
      unrealizedPnlUsdc: 0,
      isSimulated: true,
    };
    this._openPositions = [pos];
    this.emit('position', pos);

    // Don't fake a profit yet — a Leg1 entry alone isn't a completed arb.
    // Wait for the opposite side's live ask to actually drop enough that
    // entryPrice + hedgePrice <= sumTarget (the same gate the real Leg2
    // detector uses), mirroring what the live strategy would do.
    this._simRound = { roundId: signal.roundId, dipSide: signal.dipSide, entryPrice, sizeUsdc, tokenId, startedAt: Date.now() };
    this._ensureSimHedgeCheckLoop();
  }

  private _ensureSimHedgeCheckLoop(): void {
    if (this._simHedgeCheckInterval) return;
    this._simHedgeCheckInterval = setInterval(() => this._checkSimHedge(), 1000);
  }

  private _checkSimHedge(): void {
    const round = this._simRound;
    if (!round) return;

    const service = this.sdk.dipArb;
    const asks = service.getCurrentAsks();
    const oppositeAsk = round.dipSide === 'UP' ? asks.down : asks.up;
    const sameSideAsk = round.dipSide === 'UP' ? asks.up : asks.down;
    const config = service.getConfig();
    const elapsedSec = (Date.now() - round.startedAt) / 1000;

    if (oppositeAsk != null) {
      const hedgePrice = oppositeAsk * (1 + (config.maxSlippage ?? 0.02));
      const totalCost = round.entryPrice + hedgePrice;

      if (totalCost <= (config.sumTarget ?? 0.92)) {
        const profitRate = calculateDipArbProfitRate(totalCost);
        this._closeSimRound(round, hedgePrice, round.sizeUsdc * profitRate, 'dip-arb-hedge-close');
        return;
      }
    }

    // No profitable hedge showed up in time — exit the unhedged leg1 leg,
    // same as the live strategy's emergency exit on Leg2 timeout.
    if (elapsedSec > (config.leg2TimeoutSeconds ?? 180)) {
      const exitPrice = sameSideAsk ?? round.entryPrice;
      const pnl = round.sizeUsdc * ((exitPrice - round.entryPrice) / round.entryPrice);
      this._simHaltUntilRotation = true;
      log.info('[dip-arb-controller] leg2 timeout — halting entries until market rotation');
      this._closeSimRound(round, exitPrice, pnl, 'dip-arb-leg2-timeout');
    }
  }

  private _closeSimRound(
    round: NonNullable<typeof this._simRound>,
    exitPrice: number,
    pnl: number,
    reason: string,
  ): void {
    this._realizedPnl += pnl;
    this.ledger.release('dip-arb', round.sizeUsdc);
    this._openPositions = [];
    this._simRound = null;

    const closeTrade: Trade = {
      loggedAt: new Date().toISOString(),
      strategy: 'dip-arb',
      mode: 'dry-run',
      marketName: this._currentMarket?.name ?? 'unknown',
      conditionId: this._currentMarket?.conditionId,
      tokenId: round.tokenId,
      side: 'SELL',
      price: exitPrice,
      sizeUsdc: round.sizeUsdc + pnl,
      result: 'success',
      reason,
    };
    this.emit('trade', closeTrade);
    this._emitStatus();
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
    try { await this.sdk.dipArb.stop(); } catch { /* best effort */ }
    if (this._simHedgeCheckInterval) {
      clearInterval(this._simHedgeCheckInterval);
      this._simHedgeCheckInterval = null;
    }
    this._simRound = null;
    this._simHaltUntilRotation = false;
    for (const pos of this._openPositions) {
      this.ledger.release('dip-arb', pos.costBasisUsdc);
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
    try {
      this.sdk.dipArb.updateConfig({
        sumTarget: this._params.sumTarget,
        dipThreshold: this._params.dipThreshold,
        shares: this._params.maxSizePerTradeUsdc,
      });
    } catch { /* not started yet */ }
  }

  getState(): StrategyState {
    return {
      kind: 'dip-arb', enabled: true, status: this._status, mode: this._mode, params: this._params,
      committedUsdc: this.ledger.snapshot().committedByStrategy['dip-arb'],
      openPositions: this._openPositions, recentTrades: [],
      realizedPnlUsdc: this._realizedPnl,
      unrealizedPnlUsdc: this._openPositions.reduce((s, p) => s + p.unrealizedPnlUsdc, 0),
      lastError: null,
      watchingMarket: this._currentMarket?.name,
    };
  }

  private _emitStatus(): void {
    const status: StrategyStatus = {
      kind: 'dip-arb', status: this._status, mode: this._mode,
      committedUsdc: this.ledger.snapshot().committedByStrategy['dip-arb'],
      realizedPnlUsdc: this._realizedPnl,
      unrealizedPnlUsdc: this._openPositions.reduce((s, p) => s + p.unrealizedPnlUsdc, 0),
      watchingMarket: this._currentMarket?.name,
    };
    this.emit('status', status);
  }
}
