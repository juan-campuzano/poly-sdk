import { EventEmitter } from 'events';
import type { StrategyKind } from '../controllers/types.ts';

export type ReserveResult =
  | { ok: true; reservedUsdc: number }
  | { ok: false; reason: 'starved'; availableUsdc: number };

export interface StarvedEvent {
  kind: StrategyKind;
  requestedUsdc: number;
  availableUsdc: number;
}

export interface BankrollSnapshot {
  totalUsdc: number;
  committedUsdc: number;
  availableUsdc: number;
  committedByStrategy: Record<StrategyKind, number>;
}

export class BankrollLedger extends EventEmitter {
  private _totalUsdc: number;
  private _committedByStrategy: Map<StrategyKind, number> = new Map([
    ['arbitrage', 0],
    ['copy-trade', 0],
    ['dip-arb', 0],
  ]);

  constructor(totalUsdc: number) {
    super();
    this._totalUsdc = totalUsdc;
  }

  get committedUsdc(): number {
    let sum = 0;
    for (const v of this._committedByStrategy.values()) sum += v;
    return sum;
  }

  get availableUsdc(): number {
    return Math.max(0, this._totalUsdc - this.committedUsdc);
  }

  reserve(kind: StrategyKind, amountUsdc: number): ReserveResult {
    if (amountUsdc <= 0) return { ok: true, reservedUsdc: 0 };
    const available = this.availableUsdc;
    if (amountUsdc > available) {
      const evt: StarvedEvent = { kind, requestedUsdc: amountUsdc, availableUsdc: available };
      this.emit('starved', evt);
      return { ok: false, reason: 'starved', availableUsdc: available };
    }
    const current = this._committedByStrategy.get(kind) ?? 0;
    this._committedByStrategy.set(kind, current + amountUsdc);
    this.emit('changed', this.snapshot());
    return { ok: true, reservedUsdc: amountUsdc };
  }

  release(kind: StrategyKind, amountUsdc: number): void {
    if (amountUsdc <= 0) return;
    const current = this._committedByStrategy.get(kind) ?? 0;
    this._committedByStrategy.set(kind, Math.max(0, current - amountUsdc));
    this.emit('changed', this.snapshot());
  }

  setTotal(amountUsdc: number): void {
    this._totalUsdc = amountUsdc;
    this.emit('changed', this.snapshot());
  }

  snapshot(): BankrollSnapshot {
    return {
      totalUsdc: this._totalUsdc,
      committedUsdc: this.committedUsdc,
      availableUsdc: this.availableUsdc,
      committedByStrategy: {
        'arbitrage': this._committedByStrategy.get('arbitrage') ?? 0,
        'copy-trade': this._committedByStrategy.get('copy-trade') ?? 0,
        'dip-arb': this._committedByStrategy.get('dip-arb') ?? 0,
      },
    };
  }

  on(event: 'starved', listener: (e: StarvedEvent) => void): this;
  on(event: 'changed', listener: (s: BankrollSnapshot) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}
