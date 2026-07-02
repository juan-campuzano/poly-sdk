# Feature Specification: Unified Trading Bot with Steerable Terminal Interface

**Feature Branch**: `001-unified-trading-bot-tui`

**Created**: 2026-06-30

**Status**: Draft

**Input**: User description: "What I to achieve is to actually have a bot that can handle all three strategies planted in this sdk, and to have the ability of steering the bot while I can see the trades, the bankroll, probabilities, etc... I would like that the bot has an interface like something like this https://www.terminal.shop/, you can access that page from ssh, I would like a menu something like that, but the bot should be run from my local terminal"

## User Scenarios & Testing *(mandatory)*

The operator today runs three separate command-line bots — arbitrage, copy-trading, and dip-arbitrage — each as its own process, each writing to its own log file, each configured by editing constants in source before launch. There is no live view of what any bot is doing, no way to adjust behavior without stopping and re-editing code, and no single place to see how the money is being spent. This feature replaces that with one interactive terminal application that runs all three strategies, presents a polished full-screen menu-driven interface (in the visual spirit of terminal.shop), and lets the operator watch and steer everything live from their local terminal.

### User Story 1 - Watch all strategies live in one dashboard (Priority: P1)

The operator launches the unified bot from their local terminal and immediately sees a full-screen dashboard showing, for every enabled strategy: current status (running/paused/stopped), recent trades (side, market, outcome, price, size, result), remaining bankroll, open positions with their current probability/price, and running profit-and-loss. The view updates continuously without the operator typing anything.

**Why this priority**: The core pain today is total blindness into what the bots are doing with real money. A live, unified read-only dashboard delivers immediate standalone value even before any steering controls exist — the operator can run the existing strategies and finally see them. This alone is a viable MVP.

**Independent Test**: Launch the bot with one or more strategies enabled in observe-only (dry-run) mode and confirm the dashboard renders live trade activity, bankroll, open positions, probabilities, and P&L, refreshing as new events arrive — without any control actions required.

**Acceptance Scenarios**:

1. **Given** the bot is launched with all three strategies enabled, **When** a strategy detects and (dry-run) executes a trade, **Then** that trade appears in the dashboard within a few seconds showing market, outcome, side, price, size, and result.
2. **Given** at least one open position exists, **When** the underlying market probability changes, **Then** the dashboard reflects the updated probability/price and updated unrealized P&L for that position.
3. **Given** the bot is running, **When** the operator does nothing, **Then** the bankroll figure, open-position list, and per-strategy totals stay current without manual refresh.
4. **Given** a strategy encounters an error, **When** the error occurs, **Then** the dashboard surfaces the error state for that strategy without crashing the interface or the other strategies.

---

### User Story 2 - Steer strategies without restarting or editing code (Priority: P2)

From the same interface, the operator navigates a menu to start, pause, or stop each strategy individually, and to toggle each between observe-only (dry-run) and live-trading mode. Going live requires an explicit confirmation step. The operator can do this while the bot keeps running, without editing source files or restarting the process.

**Why this priority**: Steering is the second half of the user's request ("the ability of steering the bot"). It depends on the dashboard existing (P1) to be useful and safe, but it is what turns the tool from a monitor into a control surface. Toggling dry-run/live from the UI removes the current error-prone practice of editing a boolean in code before launch.

**Independent Test**: With the bot running, use the menu to pause a running strategy and confirm it stops opening new trades; resume it and confirm activity returns; toggle a strategy from dry-run to live (via confirmation) and confirm subsequent trades are placed for real.

**Acceptance Scenarios**:

1. **Given** a strategy is running, **When** the operator selects "pause" for it, **Then** the strategy stops initiating new trades and its status shows paused, while other strategies are unaffected.
2. **Given** a strategy is paused, **When** the operator selects "resume", **Then** the strategy returns to active status and resumes evaluating opportunities.
3. **Given** a strategy is in dry-run mode, **When** the operator switches it to live mode, **Then** the interface requires an explicit confirmation before any real order is placed.
4. **Given** the operator selects "stop" for a strategy, **When** confirmed, **Then** the strategy ceases activity, its committed capital is released back to the shared pool as its positions close, and it no longer competes for shared funds.

---

### User Story 3 - Adjust strategy parameters at runtime (Priority: P3)

The operator opens a settings screen and adjusts key parameters — the shared total bankroll, and per-strategy trade-size limits, profit/threshold settings, and risk controls (take-profit/stop-loss) — while the bot runs. Changes take effect on the next evaluation cycle without a restart. Invalid values are rejected with a clear message.

**Why this priority**: Runtime tuning replaces the current workflow of editing config constants and relaunching. Valuable, but the operator can still deliver value by launching with sensible defaults (P1/P2); live parameter editing is a refinement on top.

**Independent Test**: While the bot runs, change a strategy's max-trade-size (or the shared total bankroll) through the settings screen, confirm the new value is displayed and enforced on the next trade, and confirm an out-of-range value is rejected.

**Acceptance Scenarios**:

1. **Given** the bot is running, **When** the operator changes the shared total bankroll or a strategy's trade-size limit to a valid value, **Then** the new value is enforced and reflected in the dashboard.
2. **Given** the operator enters an invalid parameter value, **When** they attempt to apply it, **Then** the change is rejected with a clear explanation and the prior value is retained.
3. **Given** parameters were changed at runtime, **When** the operator restarts the bot, **Then** the interface makes clear which settings are active (persisted vs. reset to defaults).

---

### Edge Cases

- What happens when strategies collectively try to commit more than the shared bankroll holds? The interface must prevent the pool from going negative and show which strategy was starved when funds ran out.
- How does the system behave when a strategy's data source (market/price/leader feed) disconnects mid-session? The affected strategy's status must reflect the disruption and recover without taking down the interface or other strategies.
- What happens if the operator toggles a strategy to live while it has open dry-run positions? The interface must make clear that simulated positions are not real and cannot be "converted."
- How does the system handle the operator quitting the interface while strategies hold open live positions? Quitting must warn about open live positions and describe what happens to them.
- What happens when two strategies target the same market at the same time? The interface must not double-count bankroll and must show each strategy's exposure distinctly.
- How does the interface behave in a small terminal window or over a low-bandwidth remote shell session? The layout must degrade gracefully rather than corrupt.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST run as a single interactive application launched from the operator's local terminal that can operate all three strategies (arbitrage, copy-trading, dip-arbitrage) within one process.
- **FR-002**: The system MUST present a full-screen, menu-driven terminal interface (styled in the visual spirit of terminal.shop) for navigation and control.
- **FR-003**: The system MUST allow the operator to enable or disable each of the three strategies independently.
- **FR-004**: The system MUST display, per enabled strategy, live status (running/paused/stopped/error), recent trades, this strategy's share of committed capital and the remaining shared bankroll, open positions, current market probability/price per position, and running profit-and-loss.
- **FR-005**: The system MUST update displayed trade activity, bankroll, positions, probabilities, and P&L continuously as new events arrive, without requiring manual refresh.
- **FR-006**: The operator MUST be able to start, pause, resume, and stop each strategy individually while the application continues running.
- **FR-007**: The operator MUST be able to toggle each strategy between observe-only (dry-run) and live-trading mode from the interface.
- **FR-008**: The system MUST require an explicit confirmation before a strategy places any real (live) order.
- **FR-009**: The system MUST default every strategy to observe-only (dry-run) mode on launch.
- **FR-010**: The operator MUST be able to view and adjust the shared total bankroll and each strategy's key parameters (trade-size limits, per-position caps, thresholds, and risk controls) at runtime, with changes applied on the next evaluation cycle.
- **FR-011**: The system MUST validate parameter inputs and reject invalid or out-of-range values with a clear message, retaining the previous valid value.
- **FR-012**: The system MUST draw all strategies' trades from a single shared bankroll pool, so that combined committed capital across all strategies can never exceed the operator's configured total available funds, and MUST show the remaining shared balance and each strategy's current share of committed capital.
- **FR-013**: The system MUST isolate strategy failures so that an error in one strategy neither crashes the interface nor stops the other strategies.
- **FR-014**: The system MUST surface data-source disruptions (disconnects) per strategy and recover automatically when the source returns, without operator intervention.
- **FR-015**: The system MUST persist a record of executed and simulated trades for later analysis, clearly distinguishing dry-run from live activity.
- **FR-016**: The system MUST warn the operator about any open live positions when they attempt to quit the application, and describe the consequence of quitting.
- **FR-017**: The system MUST clearly distinguish simulated (dry-run) positions and results from real (live) ones everywhere they are displayed.
- **FR-018**: The system MUST make the operator's currently active configuration visible, indicating which values are defaults and which were changed at runtime.
- **FR-019**: The interface MUST remain usable when run over a remote shell (e.g., SSH) session, not only in a local terminal, and MUST degrade gracefully in constrained terminal sizes.

### Key Entities *(include if feature involves data)*

- **Strategy**: One of the three trading approaches (arbitrage, copy-trading, dip-arbitrage). Has a status, an enabled/disabled flag, a mode (dry-run/live), an allocated bankroll, a set of adjustable parameters, a set of open positions, and running performance totals.
- **Bankroll**: A single shared pool of trading funds all strategies draw from. Has a total configured amount and a remaining balance that decreases as any strategy opens a position and is replenished as positions close. Tracks how much of the committed capital each strategy currently accounts for (for display), but funds are not partitioned per strategy.
- **Trade**: A single detected/executed action by a strategy. Has a timestamp, strategy, market/outcome, side (buy/sell), price, size, dry-run/live flag, result (success/skipped/failed), and reason.
- **Position**: An open holding resulting from trades. Has a market/outcome, size, cost basis, current probability/price, and unrealized profit-and-loss.
- **Strategy Parameters**: The tunable settings per strategy (e.g., bankroll allocation, trade-size limits, profit/dip thresholds, take-profit/stop-loss). Have current values, valid ranges, and defaults.
- **Session**: A single run of the application. Has a start time, the set of enabled strategies, their modes, and the accumulated trade record.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The operator can launch the bot and, within one command and no source-file edits, have all three strategies observable in a single interface.
- **SC-002**: A trade taken (or simulated) by any strategy appears in the live dashboard within 5 seconds of occurring.
- **SC-003**: The operator can pause, resume, or stop any individual strategy and see the effect reflected in status within 3 seconds, without restarting the application.
- **SC-004**: The operator can switch a strategy between observe-only and live mode entirely through the interface, with no code edits, and no live order is ever placed without an explicit confirmation.
- **SC-005**: The operator can adjust at least the shared total bankroll, a per-strategy trade-size limit, and one risk control at runtime, with the new value enforced on the next trade.
- **SC-006**: Combined committed capital across all strategies can never exceed the configured shared total; attempts that would overdraw the pool are prevented and explained, including which strategy was starved.
- **SC-007**: A forced error in one strategy leaves the other strategies running and the interface responsive.
- **SC-008**: 100% of displayed positions and results are unambiguously labeled as either simulated or live.
- **SC-009**: The operator reports being able to answer "what is each strategy doing, and how much money is committed and at what P&L?" at a glance, without consulting external log files.

## Assumptions

- **Single operator, single machine**: The application is used by one operator running it from their own terminal (local or over SSH into their machine). Multi-user access, authentication, and a hosted/served TUI (terminal.shop-style network delivery) are out of scope; terminal.shop is a visual/interaction-style reference, not a network-delivery requirement.
- **Strategies already exist in the SDK**: The three strategies wrap the existing arbitrage, copy-trading, and dip-arbitrage implementations already present in this SDK; this feature composes and controls them rather than reinventing their trading logic.
- **Bankroll model**: All three strategies draw from one shared pool up to an operator-configured total, first-come-first-served. There are no per-strategy caps carved from the total; the system tracks each strategy's current share of committed capital for display only. (Per-strategy trade-size and position caps still limit individual trades — see FR-010.) A burst of activity in one strategy can consume shared funds and temporarily starve the others; the interface must make that visible.
- **Safety-first default**: The bot always starts in observe-only (dry-run) mode; live trading is opt-in per strategy and gated behind explicit confirmation.
- **Credentials**: The operator supplies their Polymarket credentials via the existing environment-variable mechanism used by the current bots; credential management UI is out of scope.
- **Persistence**: Trade records continue to be written to durable local files (as the current bots do) for post-hoc analysis; a database is not required.
- **Scope of "probabilities"**: "Probabilities" refers to the market-implied outcome prices (0–1) already available for each position/market through the SDK.
- **Single running instance**: Only one instance of the unified bot runs at a time against a given set of credentials, to avoid conflicting orders and double-counted bankroll.
