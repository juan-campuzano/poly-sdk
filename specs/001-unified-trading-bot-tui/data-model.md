# Data Model: Unified Trading Bot with Steerable Terminal Interface

**Feature**: 001-unified-trading-bot-tui | **Date**: 2026-06-30

In-process runtime entities (this is a single-process app; "storage" is memory + JSONL/JSON snapshots, not a database). Field types are conceptual TypeScript.

## StrategyKind

Enum identifying the three strategies.

```
type StrategyKind = 'arbitrage' | 'copy-trade' | 'dip-arb'
```

## StrategyState

The live state the UI renders per strategy. Owned by the controller, mirrored into the store.

| Field | Type | Notes |
|-------|------|-------|
| kind | StrategyKind | identity |
| enabled | boolean | included in this session |
| status | `'stopped' \| 'running' \| 'paused' \| 'degraded' \| 'error'` | see state machine below |
| mode | `'dry-run' \| 'live'` | default `dry-run` (FR-009) |
| params | StrategyParams | current tunable values |
| committedUsdc | number | this strategy's current share of the shared pool (display, FR-004/FR-012) |
| openPositions | Position[] | derived from fills |
| recentTrades | Trade[] | ring buffer, newest first |
| realizedPnlUsdc | number | closed P&L this session |
| unrealizedPnlUsdc | number | sum over open positions |
| lastError | string \| null | most recent error message when `status = error` |

**Status state machine**:

```
stopped --start--> running
running --pause--> paused --resume--> running
running/paused --stop--> stopped   (releases committed capital as positions close)
running --feed disconnect--> degraded --feed recovers--> running
any --unhandled error--> error --operator restart--> stopped
```

Invariants: only `running` may initiate new trades. `paused` and `degraded` keep positions and risk checks (take-profit/stop-loss) alive but gate new entries. Mode change to `live` requires confirmation regardless of status.

## StrategyParams

Per-strategy tunable settings (superset; each kind uses the relevant subset). Each has current value, valid range, and default — the UI enforces range on edit (FR-011).

| Field | Applies to | Default (from existing bots) | Valid range |
|-------|-----------|------------------------------|-------------|
| maxSizePerTradeUsdc | all | copy: 1, arb: 50, dip: derived | > 0, ≤ shared total |
| maxPositionUsdc | copy-trade | 5 | > 0 |
| minTradeSizeUsdc | all | 5 | ≥ platform min |
| maxSlippage | copy-trade | 0.03 | 0–0.2 |
| profitThreshold | arbitrage | 0.005 | > 0 |
| sumTarget | dip-arb | 0.92 | 0–1 |
| dipThreshold | dip-arb | 0.15 | 0–1 |
| takeProfitPercent | copy-trade (risk) | 0.10 | > 0 |
| stopLossPercent | copy-trade (risk) | 0.20 | > 0 |
| priceFilterMin/Max | copy-trade | 0.10 / 0.80 | 0–1, min < max |
| topN | copy-trade | 50 | ≥ 1 |

Note: `bankroll` is **not** a per-strategy param under the shared-pool model — it lives on Bankroll (below). Changing a param is applied on the next evaluation cycle (FR-010) via the controller's `updateParams`.

## Bankroll (shared pool)

Single instance for the whole session (FR-012, shared common pool).

| Field | Type | Notes |
|-------|------|-------|
| totalUsdc | number | operator-configured ceiling; editable at runtime (FR-010) |
| committedUsdc | number | sum of all open reservations across all strategies |
| availableUsdc | number | derived: `totalUsdc - committedUsdc`, never < 0 |
| committedByStrategy | Record<StrategyKind, number> | display share per strategy |

Operations: `reserve(kind, amount) -> ok | starved`, `release(kind, amount)`, `setTotal(amount)`. `reserve` fails (returns `starved` + emits event naming the strategy) when `amount > availableUsdc`. `setTotal` below current `committedUsdc` is allowed but blocks new reservations until capital frees up.

## Trade

One detected/executed strategy action. Persisted to JSONL (append-only), newest kept in `recentTrades`.

| Field | Type | Notes |
|-------|------|-------|
| loggedAt | ISO string | write time |
| strategy | StrategyKind | **new** vs existing per-bot logs |
| mode | `'dry-run' \| 'live'` | FR-015/FR-017 tagging |
| marketName | string | human-readable market |
| conditionId | string? | |
| tokenId | string | |
| outcome | string? | e.g. YES/NO/Up/Down |
| side | `'BUY' \| 'SELL'` | |
| price | number | 0–1 (probability) |
| sizeUsdc | number | |
| result | `'success' \| 'skipped' \| 'failed'` | |
| reason | string? | e.g. leader / take_profit / stop_loss / arb / dip |
| errorMsg | string? | when failed |

## Position

An open holding derived from fills; drives probability + unrealized P&L display.

| Field | Type | Notes |
|-------|------|-------|
| strategy | StrategyKind | owner |
| tokenId | string | |
| conditionId | string? | |
| outcome | string? | |
| shares | number | |
| costBasisUsdc | number | |
| currentPrice | number | latest market-implied probability (0–1) |
| currentValueUsdc | number | `shares * currentPrice` |
| unrealizedPnlUsdc | number | `currentValueUsdc - costBasisUsdc` |
| isSimulated | boolean | true in dry-run (FR-017) |

## Session

One run of the application. Persisted as the JSON session-config snapshot for restart continuity (FR-018).

| Field | Type | Notes |
|-------|------|-------|
| startedAt | ISO string | |
| enabledStrategies | StrategyKind[] | |
| modes | Record<StrategyKind, 'dry-run' \| 'live'> | |
| bankrollTotalUsdc | number | shared pool ceiling |
| paramOverrides | Record<StrategyKind, Partial<StrategyParams>> | which values differ from defaults (FR-018) |

## Relationships

- One **Session** has one **Bankroll** and three **StrategyState** (one per kind, enabled or not).
- One **StrategyState** has many **Position** and many **Trade**.
- Every **Position**/**Trade** debit/credit flows through the single **Bankroll**.
- **StrategyParams** belong to a **StrategyState**; the shared bankroll total belongs to **Bankroll**, not to any strategy.
