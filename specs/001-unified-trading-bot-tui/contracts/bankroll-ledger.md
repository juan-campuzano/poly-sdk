# Contract: BankrollLedger (shared common pool)

Single in-process authority for the operator's shared trading funds. Every strategy debits/credits through this one object, guaranteeing combined committed capital never exceeds the configured total (FR-012, SC-006). No per-strategy partitioning — first-come-first-served.

## Interface

```ts
interface BankrollLedger {
  reserve(kind: StrategyKind, amountUsdc: number): ReserveResult;
  release(kind: StrategyKind, amountUsdc: number): void;
  setTotal(amountUsdc: number): void;      // runtime-editable ceiling (FR-010)
  snapshot(): BankrollSnapshot;

  on(event: 'starved', cb: (e: StarvedEvent) => void): void;
  on(event: 'changed', cb: (s: BankrollSnapshot) => void): void;
}

type ReserveResult =
  | { ok: true;  reservedUsdc: number }
  | { ok: false; reason: 'starved'; availableUsdc: number };

type StarvedEvent = {
  kind: StrategyKind;      // which strategy was denied
  requestedUsdc: number;
  availableUsdc: number;
};

type BankrollSnapshot = {
  totalUsdc: number;
  committedUsdc: number;
  availableUsdc: number;   // totalUsdc - committedUsdc, always >= 0
  committedByStrategy: Record<StrategyKind, number>;
};
```

## Behavioral guarantees

- **B1 — never overdraw**: `reserve` returns `ok: false` (reason `starved`) whenever `amountUsdc > availableUsdc`; committed capital can never exceed `totalUsdc`. (SC-006)
- **B2 — starvation is visible**: a failed reserve emits a `starved` event naming the denied strategy so the UI can show which strategy ran out of shared funds. (spec edge case, FR-012)
- **B3 — release replenishes the shared pool**: `release` returns funds to `availableUsdc` and decrements that strategy's `committedByStrategy`; profits from a winning close raise no ceiling of their own but restore availability.
- **B4 — setTotal may go below committed**: lowering `totalUsdc` under current `committedUsdc` is allowed and simply blocks new reservations until positions close (`availableUsdc` clamped at 0). (FR-010)
- **B5 — display-only per-strategy shares**: `committedByStrategy` is for the dashboard; it imposes no per-strategy cap (shared-pool model).
- **B6 — dry-run uses the same ledger**: simulated trades reserve/release against the same pool so dry-run bankroll math matches live. (FR-017 parity)
- **B7 — single authority**: exactly one BankrollLedger instance per session; all controllers share it (prevents the double-counting called out in the spec).

## Non-goals

- No persistence of the ledger itself between runs beyond the `bankrollTotalUsdc` in the session snapshot; committed reservations are rebuilt from live/open positions on restart.
- No on-chain settlement here; live orders settle via `TradingService`. The ledger reconciles against on-chain balance at open/close in live mode but is authoritative for the fast first-come reservation gate.
