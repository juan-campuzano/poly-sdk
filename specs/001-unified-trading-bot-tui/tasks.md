---
description: "Task list for Unified Trading Bot with Steerable Terminal Interface"
---

# Tasks: Unified Trading Bot with Steerable Terminal Interface

**Input**: Design documents from `/specs/001-unified-trading-bot-tui/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Only the two unit tests explicitly called out in plan.md (BankrollLedger, StrategyController state machine) are included. No broader TDD suite was requested.

**Organization**: Tasks are grouped by user story (US1=P1 observe, US2=P2 steer, US3=P3 tune) so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3 — only on user-story-phase tasks
- All paths are repo-relative from `/Users/juan-campuzano/Documents/projects/20-experiments/poly-sdk/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and structure for the app layer under `bots/unified/`

- [X] T001 Create the `bots/unified/` directory tree per plan.md (subfolders: `bankroll/`, `controllers/`, `engine/`, `persistence/`, `ui/`) plus `src/__tests__/unit/unified/`
- [X] T002 Add app-layer dependencies: `pnpm add ink react ink-select-input ink-text-input ink-spinner` and `pnpm add -D @types/react`; confirm they land in the app scope only (SDK `src/` gains no runtime deps)
- [X] T003 [P] Ensure TypeScript/`tsx` JSX support for Ink: add `jsx`/`jsxImportSource` (react) settings needed to run `tsx bots/unified/index.tsx` without a build step; verify a trivial `.tsx` renders

**Checkpoint**: `bots/unified/` scaffolding exists and an empty Ink app boots.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types, the bankroll authority, orchestrator/store, and persistence that ALL user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 [P] Define shared runtime types in `bots/unified/controllers/types.ts` per data-model.md: `StrategyKind`, `StrategyState`, `StrategyParams`, `Trade`, `Position`, `StrategyStatus`, and the `StrategyController` interface from `contracts/strategy-controller.md`
- [X] T005 [P] Define bankroll types + `BankrollLedger` interface in `bots/unified/bankroll/ledger.ts` per `contracts/bankroll-ledger.md` (`ReserveResult`, `StarvedEvent`, `BankrollSnapshot`)
- [X] T006 Implement `BankrollLedger` (single shared pool) in `bots/unified/bankroll/ledger.ts`: `reserve`/`release`/`setTotal`/`snapshot`, never-overdraw guard (B1), `starved` + `changed` events (B2/B3), `committedByStrategy` display shares (B5), setTotal-below-committed handling (B4) — depends on T005
- [X] T007 [P] Unit test for `BankrollLedger` in `src/__tests__/unit/unified/ledger.test.ts`: overdraw refused, starved event names the strategy, release replenishes pool, setTotal-below-committed clamps available to 0 (covers SC-006) — depends on T006
- [X] T008 [P] Implement append-only JSONL trade log in `bots/unified/persistence/trade-log.ts`: write `Trade` rows with `strategy` + `mode` (dry-run/live) tags, extending the existing `*-trades.jsonl` schema (FR-015/FR-017) — depends on T004
- [X] T009 [P] Implement session-config load/save in `bots/unified/persistence/session-config.ts` per data-model.md `Session`: enabled strategies, per-strategy modes, `bankrollTotalUsdc`, `paramOverrides` (FR-018) — depends on T004
- [X] T010 Implement observable session store in `bots/unified/engine/store.ts`: aggregates the three `StrategyState` + `BankrollSnapshot`, exposes subscribe/get for the UI, applies controller events (`trade`/`position`/`status`) and ledger `changed` events — depends on T004, T005
- [X] T011 Implement orchestrator skeleton in `bots/unified/engine/orchestrator.ts`: owns the ledger + (to-be-added) controllers + store; routes `start/pause/resume/stop/setMode/updateParams/setBankrollTotal/shutdown`; wraps every controller call in try/catch → `status: error` event (failure isolation, FR-013) — depends on T006, T010
- [X] T012 Implement app bootstrap in `bots/unified/index.tsx`: read `POLYMARKET_PRIVATE_KEY`, `PolymarketSDK.create(...)`, construct ledger + orchestrator + store, load session-config, mount the Ink root; **pass `logger:` to every SDK service constructed** (CLAUDE.md logger-injection contract) — depends on T011

**Checkpoint**: Ledger, orchestrator, store, and persistence exist and are unit-verified; app boots to an empty root wired to a live store.

---

## Phase 3: User Story 1 - Watch all strategies live in one dashboard (Priority: P1) 🎯 MVP

**Goal**: Launch the bot with strategies enabled in dry-run and see a live full-screen dashboard of status, trades, bankroll, open positions + probabilities, and P&L — no control actions required.

**Independent Test**: Run `tsx bots/unified/index.tsx` with strategies enabled in dry-run; confirm each strategy's simulated trades, bankroll header, open positions with probabilities, and P&L render and refresh live (SC-002).

### Implementation for User Story 1

- [X] T013 [P] [US1] Implement `arbitrage-controller.ts` in `bots/unified/controllers/`: wrap `ArbitrageService`, `start()` picks target market + `service.start(market)`, dry-run execution records simulated fills, reserve/release via ledger (G3), emit `trade`/`position`/`status`/`error` (G4), inject `logger:` — depends on T004, T006
- [X] T014 [P] [US1] Implement `copy-controller.ts` in `bots/unified/controllers/`: compose `SmartMoneyCore` + `TradeMonitor` + `CopyEngine` (as the current copy-trade bot does), dry-run simulated fills, ledger reserve/release, emit normalized events, inject `logger:` — depends on T004, T006
- [X] T015 [P] [US1] Implement `dip-arb-controller.ts` in `bots/unified/controllers/`: wrap `DipArbService`, `start()` + `service.updateConfig`, dry-run simulated fills, ledger reserve/release, emit normalized events, inject `logger:` — depends on T004, T006
- [X] T016 [US1] Register the three controllers in the orchestrator and auto-start enabled strategies in dry-run on launch (US1 needs activity without control actions); route their events into the store — depends on T011, T013, T014, T015
- [X] T017 [US1] Implement Ink root `App.tsx` in `bots/unified/ui/`: subscribe to the store, render the Dashboard, handle top-level render loop (event-driven redraw) — depends on T010, T012
- [X] T018 [US1] Implement `Dashboard.tsx` in `bots/unified/ui/`: shared bankroll header (total/committed/available), and per-strategy panels showing status, recent trades, open positions with current probability, and realized/unrealized P&L; refresh on store changes within 5s (SC-002) — depends on T017
- [X] T019 [US1] Tag every position/trade row as simulated vs live in `Dashboard.tsx` (FR-017 / SC-008) — depends on T018
- [X] T020 [US1] Surface per-strategy `error` and `degraded` status in the Dashboard so one strategy failing/​disconnecting shows without crashing the view (FR-013/FR-014 display side) — depends on T018

**Checkpoint**: Launching the app shows a live, auto-updating dashboard of all enabled strategies in dry-run — MVP is demoable.

---

## Phase 4: User Story 2 - Steer strategies without restarting or editing code (Priority: P2)

**Goal**: From the interface, start/pause/resume/stop each strategy and toggle dry-run⇄live (with explicit confirmation), while the app keeps running.

**Independent Test**: With the app running, pause a running strategy (no new trades), resume it (activity returns), and switch one to live via the confirmation modal (subsequent trades are real).

### Implementation for User Story 2

- [X] T021 [US2] Implement pause/resume gating inside all three controllers: `pause()` blocks new-entry execution but keeps feeds + take-profit/stop-loss alive; `resume()` clears the gate (contract G1, US2-AC1/AC2) — depends on T013, T014, T015
- [X] T022 [US2] Implement `stop()` in all three controllers: tear down feeds and release committed capital to the shared pool as positions close (US2-AC4) — depends on T013, T014, T015
- [X] T023 [US2] Implement live-mode execution path in all three controllers: `setMode('live')` routes execution to real orders via `TradingService`; dry-run keeps simulated fills (contract G2) — depends on T013, T014, T015
- [X] T024 [US2] Implement global keybindings + screen routing in `App.tsx` per `contracts/tui-commands.md` (↑/↓ select, Enter activate, Esc back, s settings, q quit) — depends on T017
- [X] T025 [US2] Implement `StrategyMenu.tsx` in `bots/unified/ui/`: Start/Pause/Resume/Stop (with stop confirm) and mode toggle, each routed through the orchestrator; status reflects within 3s (SC-003) — depends on T024, T021, T022
- [X] T026 [US2] Implement `ConfirmLiveModal.tsx` in `bots/unified/ui/`: blocking confirmation before any dry-run→live switch; Confirm calls `orchestrator.setMode(kind,'live')`, Cancel keeps dry-run (FR-008, SC-004) — depends on T025, T023
- [X] T027 [US2] Implement `QuitGuard.tsx` in `bots/unified/ui/`: on quit with open live positions, list them and warn they are NOT auto-closed; Confirm → `orchestrator.shutdown()` (stop feeds, flush JSONL, persist session) then exit (FR-016) — depends on T024

**Checkpoint**: Operator can fully steer each strategy and safely go live/quit — US1 + US2 both work.

---

## Phase 5: User Story 3 - Adjust strategy parameters at runtime (Priority: P3)

**Goal**: Edit each strategy's params and the shared bankroll total while running; changes apply next cycle; invalid values rejected.

**Independent Test**: While running, change a strategy's `maxSizePerTradeUsdc` and the shared bankroll total; confirm new values enforced on the next trade and an out-of-range value is rejected with the prior value retained.

### Implementation for User Story 3

- [X] T028 [US3] Implement `updateParams(patch)` in all three controllers so changes apply on the next evaluation cycle (arb: reconstruct config; copy: update COPY/RISK config used by handler; dip: `service.updateConfig`) (FR-010) — depends on T013, T014, T015
- [X] T029 [US3] Add parameter validation with valid ranges from data-model.md (reject out-of-range, keep prior value, return a clear message) — reused by the settings UI (FR-011) — depends on T004
- [X] T030 [US3] Implement `SettingsScreen.tsx` in `bots/unified/ui/`: view/edit per-strategy params and the shared bankroll total; route param edits via `orchestrator.updateParams`, bankroll via `orchestrator.setBankrollTotal`→`ledger.setTotal`; show default vs overridden per field (FR-018) — depends on T024, T028, T029
- [X] T031 [US3] Persist runtime `paramOverrides` + `bankrollTotalUsdc` to session-config on change and surface them on next launch (FR-018) — depends on T030, T009

**Checkpoint**: All three user stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Hardening and the remaining plan-mandated test + validation

- [X] T032 [P] Unit test for the `StrategyController` state machine in `src/__tests__/unit/unified/controller-state.test.ts`: stopped→running→paused→running→stopped transitions, pause gates entries, degraded↔running recovery (plan.md Testing) — depends on T021, T022
- [X] T033 [P] Verify feed-disconnect recovery: controllers reflect `degraded` on data-source loss and auto-return to `running` without operator action (FR-014) — depends on T020, T021
- [X] T034 [P] Make the Dashboard layout responsive so a narrow terminal / low-bandwidth shell collapses columns instead of corrupting (FR-019) — depends on T018
- [X] T035 Run `scripts/ci/check-logger-inject.sh diff` and confirm every `new RealtimeServiceV2(...)`/`new TradingService(...)` added under `bots/unified/` passes the logger-injection gate — depends on T012, T013, T014, T015, T023
- [ ] T036 Execute the `quickstart.md` walkthrough end-to-end in dry-run and confirm SC-001..SC-008 hold; note any gaps — depends on all prior
- [ ] T037 [P] Add a short usage section to `bots/unified/` (README or header comment) documenting launch, keys, and the safety model; note the three standalone bots remain as fallbacks — depends on T036

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup — BLOCKS all user stories
- **User Stories (Phase 3→5)**: all depend on Foundational; then proceed in priority order (P1→P2→P3) or in parallel if staffed
- **Polish (Phase 6)**: depends on the user stories it hardens

### User Story Dependencies

- **US1 (P1)**: after Foundational. Delivers the MVP (observe-only dashboard). No dependency on US2/US3.
- **US2 (P2)**: builds on US1's controllers/UI (adds steering); independently testable once US1's controllers exist.
- **US3 (P3)**: builds on US1's controllers + US2's screen routing (adds settings); independently testable.

### Within Each User Story

- Controllers (models/services) before orchestrator wiring before UI screens
- UI screen routing (T024) precedes the menu/modal/settings screens

### Parallel Opportunities

- Setup: T003 is [P]
- Foundational: T004/T005 [P]; after T006 → T007/T008/T009 [P]
- US1: the three controllers T013/T014/T015 are [P] (separate files)
- Polish: T032/T033/T034/T037 are [P]

---

## Parallel Example: User Story 1

```bash
# The three strategy controllers are independent files — build in parallel:
Task: "Implement arbitrage-controller.ts (T013)"
Task: "Implement copy-controller.ts (T014)"
Task: "Implement dip-arb-controller.ts (T015)"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL) → 3. Phase 3 US1 → **STOP & VALIDATE**: live dry-run dashboard for all strategies. Demoable MVP.

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 → observe-only dashboard (MVP)
3. US2 → full steering + safe live/quit
4. US3 → runtime tuning
5. Polish → hardening + plan-mandated tests + quickstart validation

### Notes

- [P] = different files, no incomplete-task dependency
- Dry-run is the default throughout; live paths (T023/T026) are the only ones that place real orders and are gated by confirmation
- All new SDK-service construction must pass `logger:` (T035 gate)
- Commit after each task or logical group; stop at any checkpoint to validate a story independently
