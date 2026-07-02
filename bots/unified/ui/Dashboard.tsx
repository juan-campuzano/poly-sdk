import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../engine/store.ts';
import type { StrategyKind, StrategyState } from '../controllers/types.ts';

const LABEL: Record<StrategyKind, string> = {
  'arbitrage': 'Arbitrage',
  'copy-trade': 'Copy Trade',
  'dip-arb': 'Dip Arb',
};

const STATUS_COLOR: Record<string, string> = {
  running: 'green',
  paused: 'yellow',
  stopped: 'gray',
  degraded: 'yellow',
  error: 'red',
};

function fmtUsdc(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(1)}%`;
}

function StrategyPanel({ state, selected }: { state: StrategyState; selected: boolean }) {
  const borderColor = selected ? 'cyan' : 'gray';
  const statusColor = STATUS_COLOR[state.status] ?? 'white';

  return (
    <Box borderStyle="round" borderColor={borderColor} flexDirection="column" padding={0} marginRight={1} flexGrow={1}>
      <Box>
        <Text bold color={selected ? 'cyan' : 'white'}>{LABEL[state.kind]}</Text>
        <Text> </Text>
        <Text color={statusColor}>[{state.status}]</Text>
        <Text> </Text>
        <Text color={state.mode === 'live' ? 'red' : 'blue'}>{state.mode.toUpperCase()}</Text>
      </Box>

      {state.watchingMarket && (
        <Box>
          <Text dimColor>watching </Text>
          <Text color="gray">{state.watchingMarket.slice(0, 45)}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Committed: </Text>
        <Text>{fmtUsdc(state.committedUsdc)}</Text>
        <Text>  </Text>
        <Text dimColor>Realized P&L: </Text>
        <Text color={state.realizedPnlUsdc >= 0 ? 'green' : 'red'}>{fmtUsdc(state.realizedPnlUsdc)}</Text>
        <Text>  </Text>
        <Text dimColor>Unrealized: </Text>
        <Text color={state.unrealizedPnlUsdc >= 0 ? 'green' : 'red'}>{fmtUsdc(state.unrealizedPnlUsdc)}</Text>
      </Box>

      {state.openPositions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>─ Open Positions ─</Text>
          {state.openPositions.slice(0, 4).map((pos) => (
            <Box key={pos.tokenId}>
              <Text>{pos.isSimulated ? '○' : '●'} </Text>
              <Text>{(pos.outcome ?? pos.tokenId.slice(0, 8)).padEnd(10)}</Text>
              <Text> prob:{pos.currentPrice.toFixed(3)}</Text>
              <Text> P&L:</Text>
              <Text color={pos.unrealizedPnlUsdc >= 0 ? 'green' : 'red'}>{fmtUsdc(pos.unrealizedPnlUsdc)}</Text>
              {pos.isSimulated && <Text color="blue"> [sim]</Text>}
            </Box>
          ))}
          {state.openPositions.length > 4 && <Text dimColor>  …+{state.openPositions.length - 4} more</Text>}
        </Box>
      )}

      {state.recentTrades.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>─ Recent Trades ─</Text>
          {state.recentTrades.slice(0, 3).map((t, i) => (
            <Box key={i}>
              <Text color={t.mode === 'live' ? 'red' : 'blue'}>{t.mode === 'live' ? '●' : '○'}</Text>
              <Text> {t.side} {fmtUsdc(t.sizeUsdc)} @ {t.price.toFixed(3)}</Text>
              <Text color={t.result === 'success' ? 'green' : t.result === 'failed' ? 'red' : 'gray'}> [{t.result}]</Text>
              {t.mode === 'dry-run' && <Text color="blue"> sim</Text>}
            </Box>
          ))}
        </Box>
      )}

      {state.lastError && (
        <Box marginTop={1}>
          <Text color="red">⚠ {state.lastError.slice(0, 60)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function Dashboard({ state, selectedKind, onSelect }: {
  state: AppState;
  selectedKind: StrategyKind;
  onSelect: (kind: StrategyKind) => void;
}) {
  const kinds: StrategyKind[] = ['arbitrage', 'copy-trade', 'dip-arb'];
  const b = state.bankroll;

  const notice = state.starvationNotice && (Date.now() - state.starvationNotice.at < 10_000)
    ? state.starvationNotice : null;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Bankroll header */}
      <Box borderStyle="round" borderColor="magenta" padding={0}>
        <Text bold color="magenta">Shared Bankroll  </Text>
        <Text dimColor>Total: </Text><Text bold>{fmtUsdc(b.totalUsdc)}</Text>
        <Text>  </Text>
        <Text dimColor>Committed: </Text><Text>{fmtUsdc(b.committedUsdc)}</Text>
        <Text>  </Text>
        <Text dimColor>Available: </Text>
        <Text bold color={b.availableUsdc > 0 ? 'green' : 'red'}>{fmtUsdc(b.availableUsdc)}</Text>
        {notice && (
          <Text color="red">  ⚠ {LABEL[notice.kind]} starved (pool exhausted)</Text>
        )}
      </Box>

      {/* Strategy panels */}
      <Box flexDirection="row" marginTop={1}>
        {kinds.map((kind) => (
          <StrategyPanel key={kind} state={state.strategies[kind]} selected={selectedKind === kind} />
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>←/→ select  Enter menu  r sim-report  s settings  q quit</Text>
      </Box>
    </Box>
  );
}
