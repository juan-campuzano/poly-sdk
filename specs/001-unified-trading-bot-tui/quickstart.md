# Quickstart: Unified Trading Bot with Steerable Terminal Interface

**Feature**: 001-unified-trading-bot-tui

## What this is

One interactive terminal app that runs all three SDK strategies (arbitrage, copy-trade, dip-arb) at once and lets you watch and steer them live — trades, shared bankroll, position probabilities, and P&L — from your local terminal (works over SSH too). Starts in dry-run; live trading is opt-in per strategy behind a confirmation.

## Prerequisites

- Node 24 + `tsx` (already used by the existing bots)
- `POLYMARKET_PRIVATE_KEY` set in your environment (same as the current bots)
- App dependencies installed: `pnpm add ink react ink-select-input ink-text-input ink-spinner && pnpm add -D @types/react` (added during implementation)

## Run it

```bash
POLYMARKET_PRIVATE_KEY=0x... tsx bots/unified/index.tsx
```

You land on the **Dashboard**. Nothing trades until you start a strategy, and everything is dry-run by default.

## First session walkthrough (dry-run)

1. **Watch (US1)**: Dashboard shows three panels (arbitrage / copy-trade / dip-arb), each with status, recent trades, open positions + current probability, and P&L. The header shows the shared bankroll (total / committed / available).
2. **Start a strategy (US2)**: `↑/↓` to select a panel, `Enter` to open its menu, choose **Start**. Status flips to `running`; simulated trades begin appearing within a few seconds.
3. **Pause / resume**: from the same menu, **Pause** stops new entries (existing positions + take-profit/stop-loss keep running); **Resume** brings it back.
4. **Tune at runtime (US3)**: press `s` to open Settings, change e.g. `maxSizePerTradeUsdc` or the shared **bankroll total**; invalid values are rejected with a message. Changes apply on the next cycle.
5. **Go live (guarded)**: toggling a strategy to **live** opens a confirmation modal. Only after you confirm does that strategy place real orders. Everything on screen is labeled simulated vs live.
6. **Quit safely**: `q`. If any live position is open, a guard warns you (open live positions are NOT auto-closed) before exit.

## How to verify it works (maps to Success Criteria)

- **SC-001**: single command launches all three strategies observable — no source edits.
- **SC-002**: trigger a (dry-run) trade → it appears on the Dashboard within 5s.
- **SC-003**: Pause/Resume/Stop a strategy → status reflects within 3s, no restart.
- **SC-004**: switch a strategy dry-run→live entirely in the UI; confirm no live order is placed without the confirmation modal.
- **SC-005**: change bankroll total + a per-strategy trade-size limit + one risk control at runtime; new values enforced next trade.
- **SC-006**: drive strategies until combined committed capital nears the total → further buys are refused and a "starved" notice names the affected strategy; the pool never goes negative.
- **SC-007**: force an error in one strategy (e.g. bad market) → other two keep running, UI stays responsive.
- **SC-008**: every position/trade row is unambiguously simulated or live.

## Where things live

- Entry: `bots/unified/index.tsx`
- Shared bankroll: `bots/unified/bankroll/ledger.ts` (contract: `contracts/bankroll-ledger.md`)
- Strategy wrappers: `bots/unified/controllers/*` (contract: `contracts/strategy-controller.md`)
- Orchestrator + store: `bots/unified/engine/*`
- UI: `bots/unified/ui/*` (commands: `contracts/tui-commands.md`)
- Trade log / session snapshot: `bots/unified/persistence/*`

## Notes

- The three standalone bots (`bots/arbitrage-bot.ts`, etc.) remain as reference / single-strategy fallbacks; this app does not replace or modify the SDK's trading logic under `src/`.
- Only one instance should run per set of credentials (avoids conflicting orders / double-counted bankroll).
