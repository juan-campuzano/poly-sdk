import type { StrategyKind, StrategyState, Trade, Position, StrategyStatus } from '../controllers/types.ts';
import type { BankrollSnapshot } from '../bankroll/ledger.ts';

const TRADE_RING_MAX = 50;
const SIM_LOG_MAX = 200;

export interface SimStats {
  entries: number;       // BUY dry-run trades
  exits: number;        // SELL dry-run trades
  wins: number;         // successful exits
  losses: number;       // failed exits
  grossPnlUsdc: number; // running realized P&L from sim (updated via status events)
  simTrades: Trade[];   // all sim trades newest-first, capped at SIM_LOG_MAX
}

export interface AppState {
  strategies: Record<StrategyKind, StrategyState>;
  bankroll: BankrollSnapshot;
  starvationNotice: { kind: StrategyKind; at: number } | null;
  simStats: Record<StrategyKind, SimStats>;
}

type Listener = (state: AppState) => void;

function makeInitialSimStats(): SimStats {
  return { entries: 0, exits: 0, wins: 0, losses: 0, grossPnlUsdc: 0, simTrades: [] };
}

function makeInitialStrategyState(kind: StrategyKind): StrategyState {
  return {
    kind,
    enabled: true,
    status: 'stopped',
    mode: 'dry-run',
    params: {},
    committedUsdc: 0,
    openPositions: [],
    recentTrades: [],
    realizedPnlUsdc: 0,
    unrealizedPnlUsdc: 0,
    lastError: null,
  };
}

export class AppStore {
  private _state: AppState = {
    strategies: {
      'arbitrage': makeInitialStrategyState('arbitrage'),
      'copy-trade': makeInitialStrategyState('copy-trade'),
      'dip-arb': makeInitialStrategyState('dip-arb'),
    },
    bankroll: { totalUsdc: 50, committedUsdc: 0, availableUsdc: 50, committedByStrategy: { 'arbitrage': 0, 'copy-trade': 0, 'dip-arb': 0 } },
    starvationNotice: null,
    simStats: {
      'arbitrage': makeInitialSimStats(),
      'copy-trade': makeInitialSimStats(),
      'dip-arb': makeInitialSimStats(),
    },
  };

  private _listeners: Set<Listener> = new Set();

  getState(): AppState {
    return this._state;
  }

  subscribe(fn: Listener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify(): void {
    for (const fn of this._listeners) fn(this._state);
  }

  applyTrade(kind: StrategyKind, trade: Trade): void {
    const s = this._state.strategies[kind];
    const trades = [trade, ...s.recentTrades].slice(0, TRADE_RING_MAX);

    // Accumulate sim stats for dry-run trades
    let simStats = this._state.simStats;
    if (trade.mode === 'dry-run') {
      const prev = simStats[kind];
      const simTrades = [trade, ...prev.simTrades].slice(0, SIM_LOG_MAX);
      simStats = {
        ...simStats,
        [kind]: {
          ...prev,
          entries: trade.side === 'BUY' ? prev.entries + 1 : prev.entries,
          exits:   trade.side === 'SELL' ? prev.exits + 1 : prev.exits,
          wins:    trade.side === 'SELL' && trade.result === 'success' ? prev.wins + 1 : prev.wins,
          losses:  trade.side === 'SELL' && trade.result === 'failed'  ? prev.losses + 1 : prev.losses,
          simTrades,
        },
      };
    }

    if (trade.side === 'SELL' && trade.result === 'success') {
      // Close matching position and realize P&L
      const pos = s.openPositions.find(p => p.tokenId === trade.tokenId);
      const pnl = pos ? trade.sizeUsdc - pos.costBasisUsdc * (trade.sizeUsdc / (pos.currentValueUsdc || trade.sizeUsdc)) : 0;
      this._state = {
        ...this._state,
        simStats,
        strategies: {
          ...this._state.strategies,
          [kind]: { ...s, recentTrades: trades, realizedPnlUsdc: s.realizedPnlUsdc + pnl, openPositions: s.openPositions.filter(p => p.tokenId !== trade.tokenId) },
        },
      };
    } else {
      this._state = {
        ...this._state,
        simStats,
        strategies: { ...this._state.strategies, [kind]: { ...s, recentTrades: trades } },
      };
    }
    this._notify();
  }

  applyPosition(kind: StrategyKind, position: Position): void {
    const s = this._state.strategies[kind];
    const existing = s.openPositions.findIndex(p => p.tokenId === position.tokenId);
    const openPositions = existing >= 0
      ? s.openPositions.map((p, i) => i === existing ? position : p)
      : [...s.openPositions, position];
    const unrealizedPnlUsdc = openPositions.reduce((sum, p) => sum + p.unrealizedPnlUsdc, 0);
    this._state = {
      ...this._state,
      strategies: { ...this._state.strategies, [kind]: { ...s, openPositions, unrealizedPnlUsdc } },
    };
    this._notify();
  }

  applyStatus(kind: StrategyKind, status: StrategyStatus): void {
    const s = this._state.strategies[kind];
    // Keep sim grossPnlUsdc in sync with the controller's authoritative realizedPnlUsdc
    // when in dry-run mode (live P&L is tracked separately via applyTrade).
    const prevSim = this._state.simStats[kind];
    const simStats = status.mode === 'dry-run'
      ? { ...this._state.simStats, [kind]: { ...prevSim, grossPnlUsdc: status.realizedPnlUsdc } }
      : this._state.simStats;
    this._state = {
      ...this._state,
      simStats,
      strategies: {
        ...this._state.strategies,
        [kind]: { ...s, status: status.status, mode: status.mode, committedUsdc: status.committedUsdc, realizedPnlUsdc: status.realizedPnlUsdc, unrealizedPnlUsdc: status.unrealizedPnlUsdc, watchingMarket: status.watchingMarket ?? s.watchingMarket },
      },
    };
    this._notify();
  }

  applyError(kind: StrategyKind, msg: string): void {
    const s = this._state.strategies[kind];
    this._state = {
      ...this._state,
      strategies: { ...this._state.strategies, [kind]: { ...s, status: 'error', lastError: msg } },
    };
    this._notify();
  }

  applyBankroll(snap: BankrollSnapshot): void {
    this._state = { ...this._state, bankroll: snap };
    this._notify();
  }

  applyStarvation(kind: StrategyKind): void {
    this._state = { ...this._state, starvationNotice: { kind, at: Date.now() } };
    this._notify();
  }

  setStrategyParams(kind: StrategyKind, patch: Record<string, unknown>): void {
    const s = this._state.strategies[kind];
    this._state = {
      ...this._state,
      strategies: { ...this._state.strategies, [kind]: { ...s, params: { ...s.params, ...patch } } },
    };
    this._notify();
  }
}
