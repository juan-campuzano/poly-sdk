import React from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { StrategyKind, StrategyMode } from '../controllers/types.ts';
import type { AppState } from '../engine/store.ts';

const LABEL: Record<StrategyKind, string> = {
  'arbitrage': 'Arbitrage',
  'copy-trade': 'Copy Trade',
  'dip-arb': 'Dip Arb',
};

export type MenuAction =
  | { type: 'start' | 'pause' | 'resume' | 'stop' | 'back' }
  | { type: 'setMode'; mode: StrategyMode };

export function StrategyMenu({ state, kind, onAction }: {
  state: AppState;
  kind: StrategyKind;
  onAction: (a: MenuAction) => void;
}) {
  const s = state.strategies[kind];

  const items = [
    ...(s.status === 'stopped' ? [{ label: '▶ Start', value: 'start' }] : []),
    ...(s.status === 'running' || s.status === 'degraded' ? [{ label: '⏸ Pause', value: 'pause' }] : []),
    ...(s.status === 'paused' ? [{ label: '▶ Resume', value: 'resume' }] : []),
    ...(s.status !== 'stopped' ? [{ label: '⏹ Stop', value: 'stop' }] : []),
    s.mode === 'dry-run'
      ? { label: '🔴 Switch to LIVE mode', value: 'toLive' }
      : { label: '🔵 Switch to DRY-RUN mode', value: 'toDryRun' },
    { label: '← Back', value: 'back' },
  ];

  const handleSelect = (item: { value: string }) => {
    if (item.value === 'start') onAction({ type: 'start' });
    else if (item.value === 'pause') onAction({ type: 'pause' });
    else if (item.value === 'resume') onAction({ type: 'resume' });
    else if (item.value === 'stop') onAction({ type: 'stop' });
    else if (item.value === 'toLive') onAction({ type: 'setMode', mode: 'live' });
    else if (item.value === 'toDryRun') onAction({ type: 'setMode', mode: 'dry-run' });
    else if (item.value === 'back') onAction({ type: 'back' });
  };

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      <Text bold color="cyan">{LABEL[kind]} — Control</Text>
      <Box marginTop={1}>
        <Text dimColor>Status: </Text><Text>{s.status}</Text>
        <Text>  Mode: </Text>
        <Text color={s.mode === 'live' ? 'red' : 'blue'}>{s.mode.toUpperCase()}</Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={handleSelect} />
      </Box>
    </Box>
  );
}
