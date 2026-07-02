# Research: Unified Trading Bot with Steerable Terminal Interface

**Feature**: 001-unified-trading-bot-tui | **Date**: 2026-06-30

This document resolves the open technical choices behind the plan. Each item lists the Decision, Rationale, and Alternatives considered.

## 1. Terminal UI framework

**Decision**: Use **Ink** (`ink` + `react`) for the full-screen TUI.

**Rationale**:
- terminal.shop's look-and-feel (boxed panels, live-updating regions, keyboard-driven menus, color) maps directly onto Ink's flexbox layout + component model. Ink is the de-facto React renderer for terminals and is what most polished Node TUIs use.
- The dashboard is inherently reactive: many independent data streams (trades, positions, bankroll, status) update a shared view. React's declarative render fits an event-driven store far better than manual cursor/redraw bookkeeping.
- Pure TypeScript/ESM, runs under `tsx` with no build step — consistent with the existing `bots/*.ts` execution model and Node 24.
- Rich ecosystem for the exact widgets needed: `ink-table` (positions/trades tables), `ink-select-input` (menus), `ink-text-input` (parameter editing), `ink-spinner` (busy/connecting states). Only add the ones actually used.

**Alternatives considered**:
- **blessed / neo-blessed**: powerful but imperative, unmaintained-ish, and awkward to drive from an event store; more boilerplate for the same result.
- **Raw ANSI + readline**: zero deps but re-implements layout, focus, and redraw — violates Simplicity/YAGNI for a multi-panel live dashboard.
- **Bubble Tea (Go)** — what terminal.shop actually uses — rejected: wrong language; would fork the project off its TypeScript SDK.

**New dependencies**: `ink`, `react`, and a minimal set of `ink-*` widgets, plus `@types/react` (dev). These are app-layer only; the published SDK (`src/`) gains no new runtime deps.

## 2. Concurrency / process model

**Decision**: Single Node process, single event loop. Each strategy runs on its own timers/WebSocket cadence exactly as the standalone bots do today; the orchestrator owns all three concurrently. UI redraws are event-driven off a shared store.

**Rationale**:
- The three bots already run happily as independent single-process programs using async timers + SDK WebSockets. Node's event loop multiplexes them without threads.
- Avoids IPC/worker complexity. Failure isolation (FR-013) is achieved with per-controller try/catch + error events, not process boundaries.
- Ink renders on the same loop; strategy work is I/O-bound (network), so it won't starve the UI.

**Alternatives considered**:
- **Worker threads / child processes per strategy**: real isolation but adds IPC, serialization, and lifecycle complexity for no clear benefit at this scale (tens of positions, 3 strategies). Rejected as premature.

## 3. Steering model — the StrategyController abstraction

**Decision**: Introduce one `StrategyController` interface that normalizes the three services' differing surfaces into: `enable/disable`, `start/pause/resume/stop`, `setMode(dry-run|live)`, `updateParams(partial)`, plus an event emitter (`trade`, `position`, `status`, `error`). Three thin adapters implement it.

**Rationale**:
- The services differ today: `ArbitrageService` and `DipArbService` expose `start(market)/stop()` (and DipArb has `updateConfig`), while copy-trading is *composed in the bot* from `SmartMoneyCore` + `TradeMonitor` + `CopyEngine`. A common interface lets the orchestrator and UI treat all three uniformly.
- **Pause vs stop**: `pause` = keep feeds/positions alive but stop *initiating new trades* (a gate the adapter enforces before calling the underlying execute path); `stop` = tear down feeds and release committed capital as positions close. This matches the spec's US2 semantics without needing new methods inside the SDK services.
- **Mode toggle**: dry-run/live is enforced at the adapter's execute boundary (route to simulated fill vs real order), so no SDK change is needed; it also guarantees FR-008 confirmation happens above the service.

**Alternatives considered**:
- **Modify each SDK service to add pause/mode**: rejected — bloats the SDK with app-only concerns and violates the project rule that the SDK stays a pure toolkit; harder to keep the standalone bots working.
- **No common interface (special-case each in the UI)**: rejected — pushes three divergent lifecycles into the view layer, making the dashboard and menus branch-heavy.

## 4. Shared bankroll ledger

**Decision**: A single in-process `BankrollLedger` (one shared pool) that every controller must call to reserve funds before a buy and to release on sell/close. Reservations are first-come-first-served; a buy that would push committed capital past the configured total is rejected and surfaced as a "starved" event naming the strategy.

**Rationale**:
- The spec's resolved bankroll model is a **shared common pool** (no per-strategy partition). A single authority is the only way to guarantee combined committed capital never exceeds the total (FR-012, SC-006) when three strategies debit concurrently.
- Today each bot tracks its own bankroll variable (e.g. copy-trade's `remainingBankroll`); unifying into one ledger removes the double-counting risk called out in the spec edge cases.
- Ledger tracks per-strategy *share of committed capital* for display only (FR-004/FR-012) without carving hard caps.
- Per-trade caps (max size, max position) still live in each strategy's own params — the ledger only enforces the global pool ceiling.

**Alternatives considered**:
- **Per-strategy sub-allocations**: explicitly rejected by the operator's clarification (shared pool chosen).
- **On-chain balance as source of truth per trade**: too slow/racy for a first-come gate across three concurrent strategies; the in-process ledger is authoritative for reservations and reconciles against on-chain balances in live mode at open/close.

## 5. Persistence

**Decision**: Keep append-only JSONL trade logs (extend the existing `*-trades.jsonl` schema with a `strategy` field and a `mode: dry-run|live` tag) and add a small JSON `session-config` file for runtime-adjusted parameters + enabled strategies + shared bankroll total.

**Rationale**:
- Matches the existing analysis workflow (`scripts/analyze-copy-trades.ts`) and the spec assumption that a database is not required.
- Runtime edits (FR-010/FR-018) need to survive a restart and be distinguishable from defaults; a single JSON snapshot is the simplest durable store.

**Alternatives considered**:
- **SQLite**: unnecessary for tens of positions and a single operator; adds a dependency. Rejected.

## 6. Failure isolation & recovery

**Decision**: The orchestrator wraps each controller's lifecycle and event handling in try/catch, converts thrown errors into `error` status events, and keeps the other controllers + UI running. Data-source disconnects are handled by the SDK's existing reconnect logic (RealtimeServiceV2 watchdog / TradeMonitor polling); the controller reflects a `degraded` status until the feed recovers.

**Rationale**: Satisfies FR-013/FR-014 without process isolation. Leans on the CLAUDE.md logger-injection contract so watchdog/reconnect diagnostics are never silently swallowed.

**Alternatives considered**: crash-and-restart supervision — overkill for in-process strategies and would drop UI state.

## 7. Safety gates

**Decision**: Dry-run is the default for every strategy at launch (FR-009). Switching a strategy to live opens a blocking `ConfirmLiveModal` (FR-008). Quitting while any live position is open opens a `QuitGuard` warning describing that open live positions are **not** auto-closed (FR-016).

**Rationale**: Directly encodes the spec's safety requirements at the UI boundary, above the trading services, so no real order can bypass them.

## Open questions carried forward

None blocking. All spec-level clarifications were resolved (terminal.shop = visual reference; shared common pool bankroll; dry-run default). Remaining choices (exact widget set, color palette) are cosmetic and deferred to implementation.
