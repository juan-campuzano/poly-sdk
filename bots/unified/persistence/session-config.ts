import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { StrategyKind, StrategyMode, StrategyParams } from '../controllers/types.ts';

export interface SessionConfig {
  startedAt: string;
  enabledStrategies: StrategyKind[];
  modes: Record<StrategyKind, StrategyMode>;
  bankrollTotalUsdc: number;
  paramOverrides: Partial<Record<StrategyKind, Partial<StrategyParams>>>;
}

const DEFAULTS: SessionConfig = {
  startedAt: new Date().toISOString(),
  enabledStrategies: ['arbitrage', 'copy-trade', 'dip-arb'],
  modes: { 'arbitrage': 'dry-run', 'copy-trade': 'dry-run', 'dip-arb': 'dry-run' },
  bankrollTotalUsdc: 50,
  paramOverrides: {},
};

export function loadSessionConfig(filePath: string): SessionConfig {
  if (!existsSync(filePath)) return { ...DEFAULTS, startedAt: new Date().toISOString() };
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS, startedAt: new Date().toISOString() };
  }
}

export function saveSessionConfig(filePath: string, config: SessionConfig): void {
  writeFileSync(filePath, JSON.stringify(config, null, 2));
}
