# Contract: StrategyController

The common control + event surface every strategy adapter exposes to the orchestrator and UI. This is the app-layer abstraction that normalizes `ArbitrageService`, `DipArbService`, and the composed copy-trading building blocks (`SmartMoneyCore` + `TradeMonitor` + `CopyEngine`) into one uniform interface. Nothing in `src/` changes; adapters wrap the existing services.

## Interface

```ts
interface StrategyController {
  readonly kind: StrategyKind;

  // Lifecycle
  start(): Promise<void>;   // stopped -> running; open feeds, begin evaluating
  pause(): void;            // running -> paused; stop initiating NEW trades, keep positions + risk checks
  resume(): void;           // paused -> running
  stop(): Promise<void>;    // -> stopped; tear down feeds, release committed capital as positions close

  // Mode (dry-run/live). Switching to 'live' MUST be gated by confirmation ABOVE this call.
  setMode(mode: 'dry-run' | 'live'): void;

  // Runtime tuning; applied on the next evaluation cycle.
  updateParams(patch: Partial<StrategyParams>): void;

  // Current snapshot for the store/UI.
  getState(): StrategyState;

  // Normalized event stream (Node EventEmitter or typed equivalent).
  on(event: 'trade',    cb: (t: Trade) => void): void;
  on(event: 'position', cb: (p: Position) => void): void;   // open/update/close
  on(event: 'status',   cb: (s: StrategyStatus) => void): void;
  on(event: 'error',    cb: (e: { message: string }) => void): void;
}
```

## Behavioral guarantees

- **G1 — pause gates entries only**: while `paused`, the adapter MUST NOT call the underlying execute/buy path, but MUST keep polling/WS feeds and MUST keep running take-profit/stop-loss exits. (US2-AC1, US2-AC2)
- **G2 — mode is enforced at the execute boundary**: in `dry-run` the adapter records a simulated fill and never places a real order; in `live` it places a real order via `TradingService`. (FR-007, FR-017)
- **G3 — every buy reserves from the shared ledger first**: the adapter MUST call `BankrollLedger.reserve(kind, amount)` and only proceed if it returns `ok`; on sell/close it MUST call `release`. (FR-012 — see bankroll-ledger.md)
- **G4 — failures are events, not throws**: any error during evaluation/execution is caught and emitted as an `error` + `status: 'error'`; it MUST NOT propagate to crash the orchestrator/UI. (FR-013)
- **G5 — feed disconnects surface as `degraded`** and auto-recover to `running` without operator action. (FR-014)
- **G6 — logger injection**: any SDK service the adapter constructs (`RealtimeServiceV2`, `TradingService`, …) MUST be passed `logger:` per the CLAUDE.md contract.

## Adapter mapping

| Controller op | arbitrage-controller (ArbitrageService) | copy-controller (SmartMoneyCore+TradeMonitor+CopyEngine) | dip-arb-controller (DipArbService) |
|---------------|-----------------------------------------|----------------------------------------------------------|-------------------------------------|
| start | pick target market, `service.start(market)` | resolve top-N leaders, start `TradeMonitor` | pick target market, `service.start(market)` |
| pause | set internal `paused` gate before `checkOpportunity` execute | gate `CopyEngine` execution in the `onTrade` handler | gate execution on signal |
| resume | clear gate | clear gate | clear gate |
| stop | `service.stop()` | `monitor.stop()`, settle | `service.stop()` |
| setMode | route execute to sim vs real | flip `CopyEngine` dryRun path | flip execute path |
| updateParams | reconstruct config / setters | update `COPY_CONFIG`/`RISK_CONFIG` used by handler | `service.updateConfig(patch)` |

## StrategyStatus payload

```ts
type StrategyStatus = {
  kind: StrategyKind;
  status: 'stopped' | 'running' | 'paused' | 'degraded' | 'error';
  mode: 'dry-run' | 'live';
  committedUsdc: number;
  realizedPnlUsdc: number;
  unrealizedPnlUsdc: number;
};
```
