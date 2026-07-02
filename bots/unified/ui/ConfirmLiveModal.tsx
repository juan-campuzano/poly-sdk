import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { StrategyKind } from '../controllers/types.ts';

const LABEL: Record<StrategyKind, string> = {
  'arbitrage': 'Arbitrage',
  'copy-trade': 'Copy Trade',
  'dip-arb': 'Dip Arb',
};

export function ConfirmLiveModal({ kind, onConfirm, onCancel }: {
  kind: StrategyKind;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onConfirm();
    else if (input === 'n' || input === 'N' || key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="double" borderColor="red">
      <Text bold color="red">⚠  SWITCHING TO LIVE MODE — REAL MONEY</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Strategy: <Text bold color="yellow">{LABEL[kind]}</Text></Text>
        <Text>From this point on, <Text bold color="red">real orders</Text> will be placed on Polymarket.</Text>
        <Text>All simulated (dry-run) positions are NOT converted to real ones.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="green" bold>Y</Text><Text> = Confirm live mode    </Text>
        <Text color="red" bold>N</Text><Text> = Cancel, stay dry-run</Text>
      </Box>
    </Box>
  );
}
