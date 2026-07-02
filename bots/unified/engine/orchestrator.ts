import type { StrategyKind, StrategyMode, StrategyParams, StrategyController } from '../controllers/types.ts';
import { BankrollLedger } from '../bankroll/ledger.ts';
import { AppStore } from './store.ts';
import { saveSessionConfig, type SessionConfig } from '../persistence/session-config.ts';
import { TradeLog } from '../persistence/trade-log.ts';

export class Orchestrator {
  private controllers: Map<StrategyKind, StrategyController> = new Map();

  constructor(
    readonly ledger: BankrollLedger,
    readonly store: AppStore,
    private tradeLog: TradeLog,
    private sessionConfigPath: string,
    private sessionConfig: SessionConfig,
  ) {
    ledger.on('changed', (snap) => store.applyBankroll(snap));
    ledger.on('starved', ({ kind }) => store.applyStarvation(kind));
  }

  registerController(controller: StrategyController): void {
    const kind = controller.kind;
    this.controllers.set(kind, controller);

    controller.on('trade', (t) => {
      this.store.applyTrade(kind, t);
      this.tradeLog.write(t);
    });
    controller.on('position', (p) => this.store.applyPosition(kind, p));
    controller.on('status', (s) => this.store.applyStatus(kind, s));
    controller.on('error', ({ message }) => this.store.applyError(kind, message));
  }

  async start(kind: StrategyKind): Promise<void> {
    await this._safe(kind, (c) => c.start());
  }

  pause(kind: StrategyKind): void {
    this._safeSync(kind, (c) => c.pause());
  }

  resume(kind: StrategyKind): void {
    this._safeSync(kind, (c) => c.resume());
  }

  async stop(kind: StrategyKind): Promise<void> {
    await this._safe(kind, (c) => c.stop());
  }

  setMode(kind: StrategyKind, mode: StrategyMode): void {
    this._safeSync(kind, (c) => c.setMode(mode));
    this.sessionConfig.modes[kind] = mode;
    this._persistConfig();
  }

  updateParams(kind: StrategyKind, patch: Partial<StrategyParams>): void {
    this._safeSync(kind, (c) => c.updateParams(patch));
    this.store.setStrategyParams(kind, patch as Record<string, unknown>);
    if (!this.sessionConfig.paramOverrides) this.sessionConfig.paramOverrides = {};
    this.sessionConfig.paramOverrides[kind] = { ...this.sessionConfig.paramOverrides[kind], ...patch };
    this._persistConfig();
  }

  setBankrollTotal(amountUsdc: number): void {
    this.ledger.setTotal(amountUsdc);
    this.sessionConfig.bankrollTotalUsdc = amountUsdc;
    this._persistConfig();
  }

  async shutdown(): Promise<void> {
    for (const [, c] of this.controllers) {
      try { await c.stop(); } catch { /* best effort */ }
    }
    this._persistConfig();
  }

  getController(kind: StrategyKind): StrategyController | undefined {
    return this.controllers.get(kind);
  }

  hasOpenLivePositions(): boolean {
    const state = this.store.getState();
    for (const kind of ['arbitrage', 'copy-trade', 'dip-arb'] as StrategyKind[]) {
      const s = state.strategies[kind];
      if (s.mode === 'live' && s.openPositions.length > 0) return true;
    }
    return false;
  }

  private async _safe(kind: StrategyKind, fn: (c: StrategyController) => Promise<void>): Promise<void> {
    const c = this.controllers.get(kind);
    if (!c) return;
    try { await fn(c); } catch (err) {
      this.store.applyError(kind, err instanceof Error ? err.message : String(err));
    }
  }

  private _safeSync(kind: StrategyKind, fn: (c: StrategyController) => void): void {
    const c = this.controllers.get(kind);
    if (!c) return;
    try { fn(c); } catch (err) {
      this.store.applyError(kind, err instanceof Error ? err.message : String(err));
    }
  }

  private _persistConfig(): void {
    try { saveSessionConfig(this.sessionConfigPath, this.sessionConfig); } catch { /* best effort */ }
  }
}
