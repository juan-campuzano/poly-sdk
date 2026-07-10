import { EventEmitter } from 'events';
import { TradeMonitor } from '../../../src/smart-money/monitor.ts';
import { CopyEngine } from '../../../src/smart-money/copy.ts';
import type { TradeEvent } from '../../../src/smart-money/types.ts';
import { PolymarketSDK } from '../../../src/index.ts';
import { getLogger } from '../../../src/core/logger.ts';
import type {
  StrategyKind, StrategyMode, StrategyParams, StrategyState,
  StrategyStatus, Trade, Position, StrategyController,
} from './types.ts';
import { DEFAULT_PARAMS } from './types.ts';
import type { BankrollLedger } from '../bankroll/ledger.ts';

const log = getLogger();

const STALE_TRADE_MS = 60_000;

// Half-spread cost applied to simulated fills so dry-run doesn't assume
// frictionless execution at the observed price.
const SIM_FRICTION = 0.01;

interface OwnPosition {
  conditionId: string;
  outcome?: string;
  shares: number;
  costUsdc: number;
  openedAt: number;
}

export class CopyController extends EventEmitter implements StrategyController {
  readonly kind: StrategyKind = 'copy-trade';

  private _mode: StrategyMode = 'dry-run';
  private _status: 'stopped' | 'running' | 'paused' | 'degraded' | 'error' = 'stopped';
  private _paused = false;
  private _params: Partial<StrategyParams>;

  private monitor: TradeMonitor | null = null;
  private copyEngine: CopyEngine | null = null;
  private riskInterval: ReturnType<typeof setInterval> | null = null;
  private positions = new Map<string, OwnPosition>();
  private latestPrices = new Map<string, number>();
  private _realizedPnl = 0;

  constructor(
    private sdk: PolymarketSDK,
    private ledger: BankrollLedger,
    params: Partial<StrategyParams> = {},
  ) {
    super();
    this._params = { ...DEFAULT_PARAMS['copy-trade'], ...params };
  }

  async start(): Promise<void> {
    try {
      this._status = 'running';
      this._paused = false;
      this._emitStatus();

      const topN = this._params.topN ?? 50;
      const targetAddresses = await this._selectLeaders(topN);

      this.monitor = new TradeMonitor(this.sdk.dataApi, { pollIntervalMs: 5_000 });
      this.copyEngine = new CopyEngine(this.sdk.tradingService);

      const targetSet = new Set(targetAddresses);
      this.monitor.on('trade', (tradeEvent: TradeEvent) => {
        if (targetSet.has((tradeEvent.address ?? '').toLowerCase())) {
          this._handleLeaderTrade(tradeEvent).catch((err) => {
            log.warn(`[copy-controller] trade handling error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        // Only track prices for tokens we hold — otherwise every tokenId ever
        // traded by any watched wallet accumulates here forever.
        if (this.positions.has(tradeEvent.tokenId)) {
          this.latestPrices.set(tradeEvent.tokenId, tradeEvent.price);
        }
      });

      this.monitor.on('error', (err: Error) => {
        log.warn(`[copy-controller] monitor error: ${err.message}`);
        this._status = 'degraded';
        this.emit('error', { message: err.message });
        this._emitStatus();
      });

      (this.monitor as unknown as { on(e: 'reconnect', cb: () => void): void }).on?.('reconnect', () => {
        this._status = 'running';
        this._emitStatus();
      });

      // Start polling — without this the monitor never fires
      this.monitor.watch(targetAddresses, 'polling');

      // Risk check loop (take-profit / stop-loss)
      const checkIntervalMs = 10_000;
      this.riskInterval = setInterval(() => {
        this._runRiskCheck().catch((err) => {
          log.warn(`[copy-controller] risk check error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, checkIntervalMs);

      this._emitStatus();
    } catch (err) {
      this._status = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('error', { message: msg });
      this._emitStatus();
    }
  }

  /**
   * Pick leaders worth copying from the weekly leaderboard instead of raw
   * all-time PnL. The weekly endpoint doesn't populate tradeCount/makerVolume,
   * so the quality gate is return-on-volume: a real edge shows as pnl that is
   * a meaningful fraction of volume, while churners and market makers show
   * huge volume with thin pnl.
   */
  private async _selectLeaders(topN: number): Promise<string[]> {
    const lb = await this.sdk.smartMoneyCore.getLeaderboard({ period: 'week', limit: 200, sortBy: 'pnl' });
    const curated = lb.entries
      .filter((e) => e.pnl > 0 && e.volume >= 10_000 && e.pnl / e.volume >= 0.05)
      .slice(0, topN)
      .map((e) => e.address.toLowerCase());

    if (curated.length > 0) {
      log.info(`[copy-controller] following ${curated.length} curated weekly leaders`);
      return curated;
    }
    // Curation came up empty (API hiccup / missing fields) — fall back to the
    // old all-time list rather than following nobody.
    log.warn('[copy-controller] leader curation empty, falling back to all-time smart money list');
    const wallets = await this.sdk.smartMoneyCore.getSmartMoneyList(topN);
    return wallets.map((w) => w.address.toLowerCase());
  }

  private async _handleLeaderTrade(tradeEvent: TradeEvent): Promise<void> {
    if (this._paused) return;

    // Skip stale trades from startup replay
    const age = Date.now() - tradeEvent.timestamp;
    if (age > STALE_TRADE_MS) return;

    // Must have a conditionId to place any order
    if (!tradeEvent.conditionId) return;

    // Filter on LEADER's trade value (original bot: minTradeSize = $5 on leader's USDC value)
    const leaderValueUsdc = tradeEvent.price * tradeEvent.size;
    const minLeaderTrade = this._params.minTradeSizeUsdc ?? 5;
    if (leaderValueUsdc < minLeaderTrade) return;

    if (tradeEvent.side === 'BUY') {
      const priceMin = this._params.priceFilterMin ?? 0.10;
      const priceMax = this._params.priceFilterMax ?? 0.80;
      if (tradeEvent.price < priceMin || tradeEvent.price > priceMax) return;

      const maxPos = this._params.maxPositions ?? 10;
      const existing = this.positions.get(tradeEvent.tokenId);
      if (!existing && this.positions.size >= maxPos) return;

      // Never average down: only add to a position that is at/above its
      // average entry. Adding to losers is what concentrated the losses
      // (losers grew to the cap while winners exited small).
      if (existing) {
        const avgEntry = existing.costUsdc / existing.shares;
        const mark = this.latestPrices.get(tradeEvent.tokenId) ?? tradeEvent.price;
        if (mark < avgEntry) return;
      }

      const existingCost = existing?.costUsdc ?? 0;
      const roomInPosition = (this._params.maxPositionUsdc ?? 5) - existingCost;
      if (roomInPosition <= 0) return;

      const sizeScale = 0.01;
      const sizeUsdc = Math.min(
        leaderValueUsdc * sizeScale,
        this._params.maxSizePerTradeUsdc ?? 1,
        roomInPosition,
      );
      if (sizeUsdc < 0.10) return;

      const reserved = this.ledger.reserve('copy-trade', sizeUsdc);
      if (!reserved.ok) {
        this._emitTrade(tradeEvent, 'BUY', sizeUsdc, 'skipped', 'starved');
        return;
      }

      if (this._mode === 'live' && this.copyEngine) {
        try {
          const slippagePrice = Math.min(tradeEvent.price + (this._params.maxSlippage ?? 0.03), 1);
          await this.copyEngine.executeOrder({
            conditionId: tradeEvent.conditionId,
            tokenId: tradeEvent.tokenId,
            outcome: tradeEvent.outcome ?? '',
            side: 'BUY',
            amount: sizeUsdc,
            price: slippagePrice,
            orderType: 'FOK',
          });
          this._recordFill(tradeEvent.tokenId, tradeEvent.conditionId, tradeEvent.outcome, 'BUY', sizeUsdc, tradeEvent.price);
          this._emitTrade(tradeEvent, 'BUY', sizeUsdc, 'success', 'leader');
          this._emitPosition(tradeEvent.tokenId, tradeEvent.conditionId, tradeEvent.outcome);
        } catch (err) {
          this.ledger.release('copy-trade', sizeUsdc);
          this._emitTrade(tradeEvent, 'BUY', sizeUsdc, 'failed', 'leader', err instanceof Error ? err.message : String(err));
        }
      } else {
        // dry-run simulated fill — pay half-spread instead of assuming a
        // fill at the leader's exact price
        const fillPrice = Math.min(tradeEvent.price * (1 + SIM_FRICTION), 1);
        this._recordFill(tradeEvent.tokenId, tradeEvent.conditionId, tradeEvent.outcome, 'BUY', sizeUsdc, fillPrice);
        this._emitTrade(tradeEvent, 'BUY', sizeUsdc, 'success', 'leader');
        this._emitPosition(tradeEvent.tokenId, tradeEvent.conditionId, tradeEvent.outcome);
      }
    } else {
      // SELL — mirror only if we hold this token
      if (!this.positions.has(tradeEvent.tokenId)) return;
      await this._closePosition(tradeEvent.tokenId, tradeEvent.price, 'leader');
    }
  }

  private _riskCheckInFlight = false;

  private async _runRiskCheck(): Promise<void> {
    if (this._riskCheckInFlight || this.positions.size === 0) return;
    this._riskCheckInFlight = true;
    try {
      // Mark to market from the CLOB — leader-trade prices alone go stale
      // whenever no watched wallet touches a token we hold.
      await this._refreshPositionPrices();

      const now = Date.now();
      const maxAgeMs = this._params.maxPositionAgeMs ?? 8 * 3600 * 1000;

      for (const [tokenId, pos] of [...this.positions]) {
        const price = this.latestPrices.get(tokenId) ?? pos.costUsdc / pos.shares;

        // Auto-close positions held past the TTL regardless of price
        if (now - pos.openedAt >= maxAgeMs) {
          await this._closePosition(tokenId, price, 'ttl_expired');
          continue;
        }

        const pnlPercent = (pos.shares * price - pos.costUsdc) / pos.costUsdc;
        const tp = this._params.takeProfitPercent ?? 0.15;
        const sl = this._params.stopLossPercent ?? 0.10;

        if (pnlPercent >= tp) {
          await this._closePosition(tokenId, price, 'take_profit');
        } else if (pnlPercent <= -sl) {
          await this._closePosition(tokenId, price, 'stop_loss');
        }
      }
    } finally {
      this._riskCheckInFlight = false;
    }
  }

  private async _refreshPositionPrices(): Promise<void> {
    await Promise.all(
      [...this.positions.keys()].map(async (tokenId) => {
        try {
          const mid = await this.sdk.markets.getMidpoint(tokenId);
          if (Number.isFinite(mid) && mid > 0) this.latestPrices.set(tokenId, mid);
        } catch { /* keep last known price */ }
      }),
    );
  }

  /**
   * Close a position: in live mode place a real FOK sell first (previously
   * risk closes only mutated internal state — live TP/SL never sold anything);
   * in dry-run pay half-spread on the exit. Releases the reserved cost basis
   * (releasing current value instead was leaking phantom committed capital
   * into the ledger on every stop-loss, starving future buys).
   */
  private async _closePosition(tokenId: string, markPrice: number, reason: string): Promise<void> {
    const pos = this.positions.get(tokenId);
    if (!pos) return;

    const exitPrice = this._mode === 'live'
      ? markPrice
      : Math.max(0, markPrice * (1 - SIM_FRICTION));

    if (this._mode === 'live' && this.copyEngine) {
      try {
        // SELL market orders take `amount` in shares (clob UserMarketOrder semantics)
        const result = await this.copyEngine.executeOrder({
          conditionId: pos.conditionId,
          tokenId,
          outcome: pos.outcome ?? '',
          side: 'SELL',
          amount: pos.shares,
          price: exitPrice,
          orderType: 'FOK',
        });
        if (!result.success) {
          log.warn(`[copy-controller] live close (${reason}) failed for ${tokenId.slice(0, 10)}: ${result.errorMsg ?? 'unknown'}`);
          return; // keep the position; next risk tick retries
        }
      } catch (err) {
        log.warn(`[copy-controller] live close (${reason}) error for ${tokenId.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    this._realizedPnl += pos.shares * exitPrice - pos.costUsdc;
    this.ledger.release('copy-trade', pos.costUsdc);
    this._closePositionInternal(tokenId, exitPrice, reason);
    this._emitStatus();
  }

  private _closePositionInternal(tokenId: string, price: number, reason: string): void {
    const pos = this.positions.get(tokenId);
    if (!pos) return;
    const amount = pos.shares * price;
    this.positions.delete(tokenId);
    this.latestPrices.delete(tokenId);
    const t: Trade = {
      loggedAt: new Date().toISOString(),
      strategy: 'copy-trade',
      mode: this._mode,
      marketName: tokenId.slice(0, 10),
      conditionId: pos.conditionId,
      tokenId,
      outcome: pos.outcome,
      side: 'SELL',
      price,
      sizeUsdc: amount,
      result: 'success',
      reason,
    };
    this.emit('trade', t);
    this._emitStatus();
  }

  private _recordFill(tokenId: string, conditionId: string, outcome: string | undefined, side: 'BUY' | 'SELL', amountUsdc: number, price: number): void {
    const existing = this.positions.get(tokenId);
    if (side === 'BUY') {
      const shares = amountUsdc / price;
      if (existing) {
        existing.shares += shares;
        existing.costUsdc += amountUsdc;
      } else {
        this.positions.set(tokenId, { conditionId, outcome, shares, costUsdc: amountUsdc, openedAt: Date.now() });
      }
    } else {
      if (!existing) return;
      const shares = amountUsdc / price;
      existing.shares -= shares;
      existing.costUsdc -= existing.costUsdc * Math.min(1, shares / existing.shares);
      if (existing.shares <= 0.0001) this.positions.delete(tokenId);
    }
  }

  private _emitTrade(te: TradeEvent, side: 'BUY' | 'SELL', sizeUsdc: number, result: Trade['result'], reason: string, errorMsg?: string): void {
    const t: Trade = {
      loggedAt: new Date().toISOString(),
      strategy: 'copy-trade',
      mode: this._mode,
      marketName: te.conditionId?.slice(0, 12) ?? 'unknown',
      conditionId: te.conditionId,
      tokenId: te.tokenId,
      outcome: te.outcome,
      side,
      price: te.price,
      sizeUsdc,
      result,
      reason,
      errorMsg,
    };
    this.emit('trade', t);
  }

  private _emitPosition(tokenId: string, conditionId?: string, outcome?: string): void {
    const pos = this.positions.get(tokenId);
    if (!pos) return;
    const price = this.latestPrices.get(tokenId) ?? pos.costUsdc / pos.shares;
    const currentValue = pos.shares * price;
    const p: Position = {
      strategy: 'copy-trade',
      tokenId,
      conditionId,
      outcome,
      shares: pos.shares,
      costBasisUsdc: pos.costUsdc,
      currentPrice: price,
      currentValueUsdc: currentValue,
      unrealizedPnlUsdc: currentValue - pos.costUsdc,
      isSimulated: this._mode === 'dry-run',
    };
    this.emit('position', p);
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
    if (this.riskInterval) clearInterval(this.riskInterval);
    if (this.monitor) this.monitor.stop();
    for (const [, pos] of this.positions) {
      this.ledger.release('copy-trade', pos.costUsdc);
    }
    this.positions.clear();
    this.latestPrices.clear();
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
    const openPositions: Position[] = [];
    for (const [tokenId, pos] of this.positions) {
      const price = this.latestPrices.get(tokenId) ?? pos.costUsdc / pos.shares;
      openPositions.push({
        strategy: 'copy-trade', tokenId, conditionId: pos.conditionId, outcome: pos.outcome,
        shares: pos.shares, costBasisUsdc: pos.costUsdc, currentPrice: price,
        currentValueUsdc: pos.shares * price, unrealizedPnlUsdc: pos.shares * price - pos.costUsdc,
        isSimulated: this._mode === 'dry-run',
      });
    }
    return {
      kind: 'copy-trade', enabled: true, status: this._status, mode: this._mode, params: this._params,
      committedUsdc: this.ledger.snapshot().committedByStrategy['copy-trade'],
      openPositions, recentTrades: [],
      realizedPnlUsdc: this._realizedPnl,
      unrealizedPnlUsdc: openPositions.reduce((s, p) => s + p.unrealizedPnlUsdc, 0),
      lastError: null,
    };
  }

  private _emitStatus(): void {
    const state = this.getState();
    const status: StrategyStatus = {
      kind: 'copy-trade', status: this._status, mode: this._mode,
      committedUsdc: state.committedUsdc, realizedPnlUsdc: this._realizedPnl,
      unrealizedPnlUsdc: state.unrealizedPnlUsdc,
    };
    this.emit('status', status);
  }
}
