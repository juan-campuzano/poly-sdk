import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppState } from '../engine/store.ts';

export function QuitGuard({ state, onConfirm, onCancel }: {
  state: AppState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const livePositions = (Object.values(state.strategies) as typeof state.strategies[keyof typeof state.strategies][]).flatMap((s) =>
    s.mode === 'live' ? s.openPositions.filter((p) => !p.isSimulated) : [],
  );

  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onConfirm();
    else if (input === 'n' || input === 'N' || key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="double" borderColor="red">
      <Text bold color="red">⚠  You have {livePositions.length} open LIVE position(s)</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Quitting does <Text bold color="red">NOT</Text> auto-close live positions.</Text>
        <Text>They will remain open on-chain and can be managed via the Polymarket UI.</Text>
      </Box>
      {livePositions.slice(0, 5).map((p) => (
        <Box key={p.tokenId}>
          <Text>  • {(p.outcome ?? p.tokenId.slice(0, 10)).padEnd(12)} {p.shares.toFixed(2)} shares @ ~{p.currentPrice.toFixed(3)}</Text>
        </Box>
      ))}
      {livePositions.length > 5 && <Text dimColor>  …+{livePositions.length - 5} more</Text>}
      <Box marginTop={1}>
        <Text color="red" bold>Y</Text><Text> = Quit anyway    </Text>
        <Text color="green" bold>N</Text><Text> = Go back</Text>
      </Box>
    </Box>
  );
}
