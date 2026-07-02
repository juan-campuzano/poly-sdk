# Implementation Plan: Unified Trading Bot with Steerable Terminal Interface

**Branch**: `001-unified-trading-bot-tui` | **Date**: 2026-06-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-unified-trading-bot-tui/spec.md`

## Summary

Replace the three separate strategy bots (`bots/arbitrage-bot.ts`, `bots/copy-trade-bot.ts`, `bots/dip-arb-bot.ts`) with a single interactive terminal application that runs all three strategies in one Node process and gives the operator a full-screen, menu-driven dashboard (in the visual spirit of terminal.shop) to observe and steer them live.

Technical approach: wrap each existing SDK strategy behind a common **StrategyController** interface (start/pause/resume/stop, dry-run⇄live toggle, runtime param updates) that emits a normalized event stream. A single in-process **shared bankroll ledger** mediates every buy/sell so combined committed capital can never exceed the operator-configured total (first-come-first-served, no per-strategy partitioning). A React-for-terminal UI (Ink) subscribes to the controllers' event streams and renders the dashboard + menus; keyboard actions call back into the controllers. All existing strategy trading logic (ArbitrageService, DipArbService, TradeMonitor+CopyEngine) is reused unchanged behind the wrappers.

## Technical Context

**Language/Version**: TypeScript 5.7 (ESM), Node.js 24, executed via `tsx` (no build step for the bot entry point, consistent with existing `bots/*.ts`)

**Primary Dependencies**: `@catalyst-team/poly-sdk` (this repo — ArbitrageService, DipArbService, SmartMoneyCore, TradeMonitor, CopyEngine, TradingService, DataApiClient); **Ink** (`ink` + `react`) for the terminal UI — new dependency, resolved in research.md

**Storage**: Local files only — JSONL trade log (append-only, extends the existing `*-trades.jsonl` pattern) plus a JSON session/config snapshot for runtime-adjusted parameters. No database (per spec Assumptions).

**Testing**: `vitest` (existing). Unit tests for the shared bankroll ledger and StrategyController state machine; a light render/interaction test for the TUI store. Live trading paths remain manually verified in dry-run first.

**Target Platform**: Operator's local terminal (also usable over SSH). Single process, single operator, single instance.

**Project Type**: Single-project CLI/TUI application layered on top of the SDK. New code lives under `bots/unified/` (application) using `src/` services as a library. No changes to `src/` public trading logic are required.

**Performance Goals**: Trade/position/bankroll updates reflected in the UI within 5s of the event (SC-002); status changes reflected within 3s (SC-003); UI refresh loop targeted at ~4–10 fps (event-driven redraw, not a busy loop).

**Constraints**: Never place a live order without explicit confirmation (FR-008) and always start in dry-run (FR-009). A failure in one strategy must not crash the UI or the other strategies (FR-013). Layout must degrade gracefully in small terminals and over low-bandwidth shells (FR-019). Logger injection contract from CLAUDE.md applies to any newly constructed SDK service.

**Scale/Scope**: 3 strategies, 1 shared bankroll, tens of concurrent open positions, a handful of menu screens (dashboard, per-strategy control, settings, confirm-live modal, quit-with-open-positions warning).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution (`.specify/memory/constitution.md`) is an **unratified template** (all placeholder tokens). There are therefore no binding constitutional gates. In their place, this plan is held to the project's existing engineering conventions in `CLAUDE.md`:

- **Simplicity First / YAGNI** (global CLAUDE.md): reuse existing SDK services; add the minimum wrapper layer needed for steering + shared bankroll; no speculative abstraction. ✅ The plan reuses all three strategy implementations unchanged and adds one controller interface + one ledger.
- **Find existing implementation before adding files** (project CLAUDE.md rule 1): the three bots and their services are the basis; new code composes them. ✅
- **Explicit data-source selection, no implicit fallback** (rule 4): strategy mode (dry-run/live) and bankroll debits are explicit and surfaced in the UI. ✅
- **Logger injection contract** (CLAUDE.md): any `new RealtimeServiceV2(...)` / `new TradingService(...)` created by the wrappers must pass `logger:`. ✅ Enforced in design; `scripts/ci/check-logger-inject.sh diff` gate still applies.
- **Do not commit local creds/scripts** (rule 5): credentials continue via env vars (`POLYMARKET_PRIVATE_KEY`). ✅

**Result**: PASS (no violations; Complexity Tracking table left empty).

## Project Structure

### Documentation (this feature)

```text
specs/001-unified-trading-bot-tui/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── strategy-controller.md   # Common control + event contract for all strategies
│   ├── bankroll-ledger.md       # Shared-pool debit/credit contract
│   └── tui-commands.md          # Keyboard/menu command surface
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
bots/
├── arbitrage-bot.ts          # EXISTING — standalone bots kept as-is (reference / fallback)
├── copy-trade-bot.ts         # EXISTING
├── dip-arb-bot.ts            # EXISTING
└── unified/                  # NEW — the unified steerable application
    ├── index.tsx             # Entry point: `tsx bots/unified/index.tsx` — wires SDK, ledger, controllers, UI
    ├── bankroll/
    │   └── ledger.ts         # Shared in-process bankroll ledger (single pool, debit/credit, guards overdraft)
    ├── controllers/
    │   ├── types.ts          # StrategyController interface + normalized event/state types
    │   ├── arbitrage-controller.ts   # Wraps ArbitrageService
    │   ├── copy-controller.ts        # Wraps SmartMoneyCore + TradeMonitor + CopyEngine
    │   └── dip-arb-controller.ts     # Wraps DipArbService
    ├── engine/
    │   ├── orchestrator.ts   # Owns the 3 controllers + ledger; start/pause/resume/stop/setMode/updateParams routing; failure isolation
    │   └── store.ts          # Aggregated observable session state the UI subscribes to
    ├── persistence/
    │   ├── trade-log.ts      # Append-only JSONL writer (dry-run/live tagged) — extends existing pattern
    │   └── session-config.ts # Load/save runtime-adjusted params + enabled strategies
    └── ui/
        ├── App.tsx           # Root Ink component + global keybindings + screen routing
        ├── Dashboard.tsx     # Live per-strategy panels: status, trades, positions, probabilities, P&L, bankroll
        ├── StrategyMenu.tsx  # Per-strategy start/pause/resume/stop + mode toggle
        ├── SettingsScreen.tsx# Runtime parameter editing with validation
        ├── ConfirmLiveModal.tsx  # Explicit confirmation gate before live mode
        └── QuitGuard.tsx     # Warn on quit with open live positions

src/                          # EXISTING SDK — used as a library, not modified for this feature
└── ...

src/__tests__/unit/
└── unified/                  # NEW — ledger + controller state-machine unit tests
```

**Structure Decision**: Single-project layout. The unified app is a new `bots/unified/` tree that consumes `src/` as a library, mirroring how the existing standalone bots import SDK services. No modification of the SDK's public trading logic is planned; the only new "shared" concepts (bankroll ledger, controller interface) live inside the app layer so the SDK stays a pure toolkit. The three existing bots remain in place as reference and single-strategy fallbacks.

## Complexity Tracking

> No constitutional violations. Table intentionally empty.
