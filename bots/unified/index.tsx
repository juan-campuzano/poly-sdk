#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { PolymarketSDK } from '../../src/index.ts';
import { setLogger, getLogger } from '../../src/core/logger.ts';
import { BankrollLedger } from './bankroll/ledger.ts';
import { AppStore } from './engine/store.ts';
import { Orchestrator } from './engine/orchestrator.ts';
import { ArbitrageController } from './controllers/arbitrage-controller.ts';
import { CopyController } from './controllers/copy-controller.ts';
import { DipArbController } from './controllers/dip-arb-controller.ts';
import { TradeLog } from './persistence/trade-log.ts';
import { loadSessionConfig, saveSessionConfig } from './persistence/session-config.ts';
import { App } from './ui/App.tsx';

// Redirect SDK logs to stderr so they don't corrupt Ink's stdout-based render.
// The defaultConsoleLogger writes to stdout (console.*), which Ink's patchConsole
// intercepts — but service-level log calls that happen after render() can still
// corrupt cursor position. Routing to stderr avoids that entirely.
setLogger({
  debug: (msg, data) => process.stderr.write(data ? `[sdk] ${msg} ${JSON.stringify(data)}\n` : `[sdk] ${msg}\n`),
  info:  (msg, data) => process.stderr.write(data ? `[sdk] ${msg} ${JSON.stringify(data)}\n` : `[sdk] ${msg}\n`),
  warn:  (msg, data) => process.stderr.write(data ? `[sdk] ${msg} ${JSON.stringify(data)}\n` : `[sdk] ${msg}\n`),
  error: (msg, data) => process.stderr.write(data ? `[sdk] ${msg} ${JSON.stringify(data)}\n` : `[sdk] ${msg}\n`),
});

const log = getLogger();

const SESSION_CONFIG_PATH = process.env.UNIFIED_SESSION_CONFIG ?? 'unified-session.json';
const TRADE_LOG_PATH = process.env.UNIFIED_TRADE_LOG ?? 'unified-trades.jsonl';
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  log.warn('[unified-bot] No POLYMARKET_PRIVATE_KEY set — dry-run only (live mode will be disabled)');
}

log.info('[unified-bot] Starting…');

const sessionConfig = loadSessionConfig(SESSION_CONFIG_PATH);
// SDK uses a dummy key internally when none is provided; real key needed only for live orders
const sdk = await PolymarketSDK.create({ privateKey: PRIVATE_KEY });
const ledger = new BankrollLedger(sessionConfig.bankrollTotalUsdc);
const store = new AppStore();
const tradeLog = new TradeLog(TRADE_LOG_PATH);

// Sync initial bankroll into store
store.applyBankroll(ledger.snapshot());

const orchestrator = new Orchestrator(ledger, store, tradeLog, SESSION_CONFIG_PATH, sessionConfig);

// Wire controllers — logger injection contract (CLAUDE.md): each SDK service
// that owns a watchdog receives `logger:` via its ctor (see ArbitrageService).
const controllers = [
  new ArbitrageController(sdk, ledger, PRIVATE_KEY, sessionConfig.paramOverrides?.['arbitrage'] ?? {}),
  new CopyController(sdk, ledger, sessionConfig.paramOverrides?.['copy-trade'] ?? {}),
  new DipArbController(sdk, ledger, sessionConfig.paramOverrides?.['dip-arb'] ?? {}),
];

for (const c of controllers) {
  orchestrator.registerController(c);
}

// Auto-start enabled strategies in dry-run (FR-009: always start dry-run)
for (const kind of sessionConfig.enabledStrategies) {
  const mode = sessionConfig.modes[kind] ?? 'dry-run';
  // Force dry-run on launch for safety (FR-009)
  if (mode === 'live') {
    log.warn(`[unified-bot] Strategy ${kind} was saved as live — resetting to dry-run for safety`);
    orchestrator.setMode(kind, 'dry-run');
  }
  await orchestrator.start(kind);
}

const { waitUntilExit } = render(<App store={store} orchestrator={orchestrator} />);

process.on('SIGINT', async () => {
  await orchestrator.shutdown();
  process.exit(0);
});

await waitUntilExit();
await orchestrator.shutdown();
process.exit(0);
