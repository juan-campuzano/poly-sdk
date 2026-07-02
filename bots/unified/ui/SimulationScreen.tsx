import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppState } from '../engine/store.ts';
import type { StrategyKind, Trade } from '../controllers/types.ts';

const KINDS: StrategyKind[] = ['arbitrage', 'copy-trade', 'dip-arb'];
const LABEL: Record<StrategyKind, string> = {
  'arbitrage':  'Arbitrage',
  'copy-trade': 'Copy Trade',
  'dip-arb':    'Dip Arb',
};

function fmtUsdc(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}$${n.toFixed(2)}`;
}

function fmtPct(wins: number, total: number): string {
  if (total === 0) return '—';
  return `${((wins / total) * 100).toFixed(0)}%`;
}

function TradeRow({ trade }: { trade: Trade }) {
  const time = new Date(trade.loggedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const sideColor = trade.side === 'BUY' ? 'green' : 'cyan';
  const resultColor = trade.result === 'success' ? 'green' : trade.result === 'failed' ? 'red' : 'gray';

  return (
    <Box>
      <Text dimColor>{time} </Text>
      <Text color={sideColor}>{trade.side.padEnd(4)}</Text>
      <Text> ${trade.sizeUsdc.toFixed(2).padStart(7)}</Text>
      <Text dimColor> @{trade.price.toFixed(3)}</Text>
      <Text color={resultColor}> [{trade.result}]</Text>
      {trade.reason && <Text dimColor>  {trade.reason}</Text>}
      <Text dimColor>  {trade.marketName.slice(0, 30)}</Text>
    </Box>
  );
}

export function SimulationScreen({ state, onBack }: { state: AppState; onBack: () => void }) {
  const [selectedKind, setSelectedKind] = useState<StrategyKind>('arbitrage');

  useInput((input, key) => {
    if (key.escape || input === 'r' || input === 'R') { onBack(); return; }
    if (key.leftArrow)  setSelectedKind(k => { const i = KINDS.indexOf(k); return KINDS[(i - 1 + KINDS.length) % KINDS.length]; });
    if (key.rightArrow) setSelectedKind(k => { const i = KINDS.indexOf(k); return KINDS[(i + 1) % KINDS.length]; });
  });

  const totals = { entries: 0, wins: 0, exits: 0, grossPnlUsdc: 0 };
  for (const k of KINDS) {
    const ss = state.simStats[k];
    totals.entries      += ss.entries;
    totals.wins         += ss.wins;
    totals.exits        += ss.exits;
    totals.grossPnlUsdc += ss.grossPnlUsdc;
  }

  const sim = state.simStats[selectedKind];
  const simTrades = sim.simTrades;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text bold color="yellow">Simulation Report  </Text>
        <Text dimColor>dry-run session totals  </Text>
        <Text dimColor>Entries: </Text><Text>{totals.entries}</Text>
        <Text>  </Text>
        <Text dimColor>Closed: </Text><Text>{totals.exits}</Text>
        <Text>  </Text>
        <Text dimColor>Win rate: </Text><Text>{fmtPct(totals.wins, totals.exits)}</Text>
        <Text>  </Text>
        <Text dimColor>Sim P&L: </Text>
        <Text bold color={totals.grossPnlUsdc >= 0 ? 'green' : 'red'}>{fmtUsdc(totals.grossPnlUsdc)}</Text>
      </Box>

      {/* Per-strategy summary row */}
      <Box flexDirection="row" marginTop={1}>
        {KINDS.map(k => {
          const ss = state.simStats[k];
          const selected = k === selectedKind;
          return (
            <Box
              key={k}
              borderStyle="round"
              borderColor={selected ? 'yellow' : 'gray'}
              flexDirection="column"
              marginRight={1}
              flexGrow={1}
              paddingX={1}
            >
              <Text bold color={selected ? 'yellow' : 'white'}>{LABEL[k]}</Text>
              <Box marginTop={0}>
                <Text dimColor>Entries </Text><Text>{ss.entries}</Text>
                <Text>  </Text>
                <Text dimColor>Closed </Text><Text>{ss.exits}</Text>
                <Text>  </Text>
                <Text dimColor>Win% </Text><Text>{fmtPct(ss.wins, ss.exits)}</Text>
              </Box>
              <Box>
                <Text dimColor>Sim P&L </Text>
                <Text color={ss.grossPnlUsdc >= 0 ? 'green' : 'red'}>{fmtUsdc(ss.grossPnlUsdc)}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Trade log for selected strategy */}
      <Box borderStyle="round" borderColor="yellow" flexDirection="column" marginTop={1} paddingX={1}>
        <Text bold color="yellow">{LABEL[selectedKind]} — Sim Trade Log</Text>
        {simTrades.length === 0 ? (
          <Text dimColor>  No simulated trades yet. Start the strategy in dry-run mode.</Text>
        ) : (
          simTrades.slice(0, 20).map((t, i) => <TradeRow key={i} trade={t} />)
        )}
        {simTrades.length > 20 && (
          <Text dimColor>  …+{simTrades.length - 20} earlier trades (session total: {simTrades.length})</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>←/→ switch strategy  Esc/r back to dashboard</Text>
      </Box>
    </Box>
  );
}
