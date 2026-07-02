# Contract: TUI Command Surface

The keyboard/menu commands the interface exposes and what each maps to on the orchestrator. This is the "steering" contract — the UI never touches SDK services directly; every action routes through the orchestrator, which routes to controllers + ledger.

## Screens

| Screen | Purpose | Reached by |
|--------|---------|-----------|
| Dashboard | Live per-strategy panels: status, recent trades, open positions + probabilities, per-strategy P&L, shared bankroll header | default / `Esc` from any screen |
| StrategyMenu | Control one strategy: start / pause / resume / stop, toggle mode | select a strategy on Dashboard (`↑/↓` + `Enter`) |
| SettingsScreen | View + edit a strategy's params and the shared bankroll total | `s` from Dashboard or StrategyMenu |
| ConfirmLiveModal | Blocking confirmation before enabling live mode | triggered by a mode→live action |
| QuitGuard | Warn about open live positions before exit | `q` / `Ctrl-C` when live positions open |

## Global keys

| Key | Action | Routes to |
|-----|--------|-----------|
| `↑` / `↓` | move selection | UI only |
| `Enter` | activate selection | context |
| `Esc` | back to Dashboard | UI only |
| `s` | open Settings for selected strategy | UI only |
| `q` / `Ctrl-C` | quit (guarded if live positions open) | `orchestrator.shutdown()` via QuitGuard |

## StrategyMenu commands

| Command | Precondition | Orchestrator call | Guarantee |
|---------|--------------|-------------------|-----------|
| Start | status = stopped | `orchestrator.start(kind)` → `controller.start()` | status → running within 3s (SC-003) |
| Pause | status = running | `orchestrator.pause(kind)` → `controller.pause()` | no new trades initiated (US2-AC1) |
| Resume | status = paused | `orchestrator.resume(kind)` → `controller.resume()` | activity returns (US2-AC2) |
| Stop | status ∈ {running,paused,degraded} | confirm → `orchestrator.stop(kind)` → `controller.stop()` | capital released to shared pool (US2-AC4) |
| Toggle mode → live | any | **opens ConfirmLiveModal first** | no live order without explicit confirm (FR-008, SC-004) |
| Toggle mode → dry-run | any | `orchestrator.setMode(kind,'dry-run')` | immediate, no confirm needed |

## SettingsScreen commands

| Command | Orchestrator call | Guarantee |
|---------|-------------------|-----------|
| Edit a strategy param | validate → `orchestrator.updateParams(kind, patch)` → `controller.updateParams` | applied next cycle (FR-010); invalid rejected with message, prior value kept (FR-011) |
| Edit shared bankroll total | validate → `orchestrator.setBankrollTotal(amount)` → `ledger.setTotal` | enforced immediately (FR-012) |
| Field shows default vs overridden | read from Session.paramOverrides | operator can see which values changed at runtime (FR-018) |

## ConfirmLiveModal

- **Confirm** → `orchestrator.setMode(kind, 'live')`; subsequent trades for that strategy place real orders.
- **Cancel** → strategy stays in dry-run; no state change.
- The modal blocks other input until resolved. (FR-008)

## QuitGuard

- Shown on quit only when at least one **live** position is open (FR-016).
- Lists open live positions and states plainly: **quitting does NOT auto-close live positions**; they remain on-chain.
- **Confirm quit** → `orchestrator.shutdown()` (stops feeds, flushes JSONL log, persists session snapshot) then exit.
- **Cancel** → returns to Dashboard.

## Rendering guarantees

- Store-driven redraw: any `trade`/`position`/`status`/`bankroll changed` event updates the Dashboard within 5s (SC-002).
- Every position/trade row is tagged simulated vs live (FR-017 / SC-008).
- Layout uses responsive boxes so a narrow terminal collapses columns rather than corrupting (FR-019).
