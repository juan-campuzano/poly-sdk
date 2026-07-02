import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { StrategyKind, StrategyParams } from '../controllers/types.ts';
import type { AppState } from '../engine/store.ts';

const LABEL: Record<StrategyKind, string> = {
  'arbitrage': 'Arbitrage',
  'copy-trade': 'Copy Trade',
  'dip-arb': 'Dip Arb',
};

type ParamKey = keyof StrategyParams;
const PARAM_RANGES: Partial<Record<ParamKey, [number, number]>> = {
  maxSizePerTradeUsdc: [1, 10000],
  maxPositionUsdc: [1, 10000],
  minTradeSizeUsdc: [0, 1000],
  maxSlippage: [0, 0.5],
  profitThreshold: [0, 1],
  sumTarget: [0, 1],
  dipThreshold: [0, 1],
  takeProfitPercent: [0, 10],
  stopLossPercent: [0, 10],
  priceFilterMin: [0, 1],
  priceFilterMax: [0, 1],
  topN: [1, 1000],
};

function validateParam(key: ParamKey, value: string): { valid: boolean; parsed: number; error?: string } {
  const n = parseFloat(value);
  if (isNaN(n)) return { valid: false, parsed: 0, error: 'Must be a number' };
  const range = PARAM_RANGES[key];
  if (range && (n < range[0] || n > range[1])) {
    return { valid: false, parsed: n, error: `Must be between ${range[0]} and ${range[1]}` };
  }
  return { valid: true, parsed: n };
}

type EditTarget =
  | { type: 'bankroll' }
  | { type: 'param'; kind: StrategyKind; key: ParamKey };

export function SettingsScreen({ state, kind, onApply, onBack }: {
  state: AppState;
  kind: StrategyKind;
  onApply: (target: EditTarget, value: number) => void;
  onBack: () => void;
}) {
  const s = state.strategies[kind];
  const b = state.bankroll;
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [inputVal, setInputVal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);

  const paramEntries = Object.entries(s.params) as [ParamKey, number][];

  const handleSubmit = (val: string) => {
    if (!editing) return;
    let key: ParamKey | null = null;
    if (editing.type === 'param') key = editing.key;
    const n = parseFloat(val);
    if (isNaN(n)) { setError('Must be a number'); return; }
    if (editing.type === 'param' && key) {
      const r = validateParam(key, val);
      if (!r.valid) { setError(r.error ?? 'Invalid'); return; }
    }
    if (editing.type === 'bankroll' && n <= 0) { setError('Bankroll must be > 0'); return; }
    onApply(editing, n);
    setEditing(null);
    setInputVal('');
    setError(null);
  };

  if (editing) {
    const label = editing.type === 'bankroll' ? 'Shared Bankroll Total' : editing.key;
    return (
      <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
        <Text bold>Edit: <Text color="yellow">{label}</Text></Text>
        <Box marginTop={1}>
          <Text>New value: </Text>
          <TextInput
            value={inputVal}
            onChange={setInputVal}
            onSubmit={handleSubmit}
            placeholder="Enter number…"
          />
        </Box>
        {error && <Text color="red">✗ {error}</Text>}
        <Text dimColor>Enter to apply  Esc to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      <Text bold color="cyan">{LABEL[kind]} — Settings</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>─ Shared Pool ─</Text>
        <Text>
          {'  '}Bankroll Total: <Text bold>${b.totalUsdc.toFixed(2)}</Text>
          <Text color="blue">  [press b to edit]</Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>─ {LABEL[kind]} Params ─</Text>
        {paramEntries.map(([key, val]) => (
          <Text key={key}>
            {'  '}{key}: <Text bold>{val}</Text>
            {PARAM_RANGES[key] && <Text dimColor>  [{PARAM_RANGES[key]![0]}–{PARAM_RANGES[key]![1]}]</Text>}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press a param name initial + Enter, or b for bankroll.  Esc to go back.</Text>
      </Box>
    </Box>
  );
}
