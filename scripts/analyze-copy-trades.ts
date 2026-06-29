/**
 * Analyze copy-trades.jsonl (written by my-bot.ts) to estimate whether
 * the detected/copied trades would have been profitable, and render an
 * HTML report with charts (cumulative PnL, per-trade PnL, win/loss split).
 *
 * For each logged trade, fetches the token's price N minutes after the
 * trade (via CLOB /prices-history) and compares it to the price we would
 * have entered at, to estimate hypothetical P&L.
 *
 * Also simulates running the strategy with a fixed bankroll: trades open
 * and tie up capital for HOLD_MINUTES, so if more capital is demanded than
 * is free at that moment, the trade is skipped (capital-constrained) rather
 * than assuming unlimited concurrent positions.
 *
 * Usage:
 *   npx tsx scripts/analyze-copy-trades.ts [path/to/copy-trades.jsonl]
 *
 * Env:
 *   HORIZONS_MIN=1,5,15,60   comma-separated minutes-after-entry to mark to
 *   REPORT_FILE=path.html   where to write the HTML report (default: copy-trades-report.html)
 *   BANKROLL=20             total capital for the concurrency-aware simulation (USDC)
 *   HOLD_MINUTES=30         how long each simulated position ties up capital before closing
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { PolymarketSDK } from '../src/index.js';

interface CopyLogEntry {
  loggedAt: string;
  source: 'polling' | 'mempool';
  detectedAt: number;
  tradeTimestamp: number;
  detectionLatencyMs: number;
  address: string;
  conditionId?: string;
  outcome?: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  leaderPrice: number;
  leaderSize: number;
  leaderValueUsdc: number;
  ourAmountUsdc?: number;
  ourSlippagePrice?: number;
  dryRun: boolean;
  skipped: boolean;
  skipReason?: string;
  executed: boolean;
  orderId?: string;
  errorMsg?: string;
}

interface EvaluatedTrade {
  label: string;
  tradeTimestamp: number;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  ourAmountUsdc?: number;
  dryRun: boolean;
  pnlByHorizon: Record<number, number | undefined>;
}

interface BankrollSimResult {
  bankroll: number;
  holdMinutes: number;
  finalBalance: number;
  takenCount: number;
  skippedCapitalCount: number;
  skippedNoDataCount: number;
  equityCurve: { time: number; equity: number }[];
}

const logPath = process.argv[2] ?? process.env.COPY_LOG_FILE ?? 'copy-trades.jsonl';
const reportPath = process.env.REPORT_FILE ?? 'copy-trades-report.html';
const bankroll = parseFloat(process.env.BANKROLL ?? '20');
const holdMinutes = parseInt(process.env.HOLD_MINUTES ?? '30', 10);

const horizons = Array.from(
  new Set(
    (process.env.HORIZONS_MIN ?? '1,5,15,60')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n))
      .concat(holdMinutes)
  )
).sort((a, b) => a - b);
const primaryHorizon = horizons[horizons.length - 1];

/**
 * Simulate running the strategy with a fixed bankroll, respecting capital
 * constraints: each trade ties up its USDC amount for `holdMinutes`, and a
 * trade is skipped if there isn't enough free capital at that moment
 * (mirrors what would happen with overlapping/concurrent copy trades).
 */
function simulateBankroll(trades: EvaluatedTrade[], bankroll: number, holdMinutes: number): BankrollSimResult {
  const sorted = [...trades].sort((a, b) => a.tradeTimestamp - b.tradeTimestamp);
  const holdMs = holdMinutes * 60_000;

  type Event = { time: number; kind: 'open' | 'close'; trade: EvaluatedTrade; size: number; pnl: number };
  const openQueue: Event[] = sorted
    .filter((t) => (t.ourAmountUsdc ?? 0) > 0 && t.pnlByHorizon[holdMinutes] !== undefined)
    .map((t) => ({
      time: t.tradeTimestamp,
      kind: 'open' as const,
      trade: t,
      size: t.ourAmountUsdc!,
      pnl: t.pnlByHorizon[holdMinutes]!,
    }));

  let available = bankroll;
  let takenCount = 0;
  let skippedCapitalCount = 0;
  const skippedNoDataCount = sorted.length - openQueue.length;
  const equityCurve: { time: number; equity: number }[] = [{ time: sorted[0]?.tradeTimestamp ?? 0, equity: bankroll }];
  const pendingCloses: Event[] = [];

  for (const openEvt of openQueue) {
    // Settle any closes scheduled before this open.
    while (pendingCloses.length > 0 && pendingCloses[0].time <= openEvt.time) {
      const closeEvt = pendingCloses.shift()!;
      available += closeEvt.size + closeEvt.pnl;
      equityCurve.push({ time: closeEvt.time, equity: available + pendingCloses.reduce((s, e) => s + e.size, 0) });
    }

    if (openEvt.size > available) {
      skippedCapitalCount++;
      continue;
    }

    available -= openEvt.size;
    takenCount++;
    pendingCloses.push({ ...openEvt, time: openEvt.time + holdMs });
    pendingCloses.sort((a, b) => a.time - b.time);
    equityCurve.push({ time: openEvt.time, equity: available + pendingCloses.reduce((s, e) => s + e.size, 0) });
  }

  // Drain remaining closes.
  while (pendingCloses.length > 0) {
    const closeEvt = pendingCloses.shift()!;
    available += closeEvt.size + closeEvt.pnl;
    equityCurve.push({ time: closeEvt.time, equity: available + pendingCloses.reduce((s, e) => s + e.size, 0) });
  }

  return {
    bankroll,
    holdMinutes,
    finalBalance: available,
    takenCount,
    skippedCapitalCount,
    skippedNoDataCount,
    equityCurve,
  };
}

function loadEntries(path: string): CopyLogEntry[] {
  const raw = readFileSync(path, 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CopyLogEntry);
}

/** Find the price point closest to (but not before) targetTs in a price history series. */
function priceAt(points: { timestamp: number; price: number }[], targetTs: number): number | undefined {
  if (points.length === 0) return undefined;
  let best = points[0];
  for (const p of points) {
    if (p.timestamp <= targetTs) best = p;
    else break;
  }
  return best.price;
}

function renderHtmlReport(trades: EvaluatedTrade[], horizons: number[], primaryHorizon: number, sim: BankrollSimResult): string {
  const sorted = [...trades].sort((a, b) => a.tradeTimestamp - b.tradeTimestamp);

  // Cumulative PnL series per horizon
  const cumulativeByHorizon: Record<number, number[]> = {};
  const labels = sorted.map((t) => new Date(t.tradeTimestamp).toLocaleString());
  for (const h of horizons) {
    let running = 0;
    cumulativeByHorizon[h] = sorted.map((t) => {
      running += t.pnlByHorizon[h] ?? 0;
      return running;
    });
  }

  const perTradePnl = sorted.map((t) => t.pnlByHorizon[primaryHorizon] ?? 0);
  const perTradeColors = perTradePnl.map((p) => (p >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)'));

  const wins = perTradePnl.filter((p) => p > 0).length;
  const losses = perTradePnl.filter((p) => p < 0).length;
  const flat = perTradePnl.length - wins - losses;

  const totalPnlByHorizon = horizons.map((h) => sorted.reduce((sum, t) => sum + (t.pnlByHorizon[h] ?? 0), 0));

  const palette = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4'];
  const cumulativeDatasets = horizons.map((h, i) => ({
    label: `+${h}m`,
    data: cumulativeByHorizon[h],
    borderColor: palette[i % palette.length],
    backgroundColor: 'transparent',
    tension: 0.15,
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Copy Trading Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #94a3b8; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #1e293b; border-radius: 8px; padding: 16px; }
  .card .value { font-size: 28px; font-weight: 700; }
  .card .label { color: #94a3b8; font-size: 13px; }
  .positive { color: #22c55e; }
  .negative { color: #ef4444; }
  .chart-box { background: #1e293b; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  canvas { max-height: 360px; }
</style>
</head>
<body>
  <h1>Copy Trading Report</h1>
  <div class="subtitle">${sorted.length} evaluated trades · generated ${new Date().toISOString()}</div>

  <div class="grid">
    ${horizons
      .map((h, i) => `<div class="card">
        <div class="label">Total PnL @ +${h}m</div>
        <div class="value ${totalPnlByHorizon[i] >= 0 ? 'positive' : 'negative'}">$${totalPnlByHorizon[i].toFixed(2)}</div>
      </div>`)
      .join('\n')}
    <div class="card">
      <div class="label">Win / Loss / Flat (@ +${primaryHorizon}m)</div>
      <div class="value">${wins} / ${losses} / ${flat}</div>
    </div>
    <div class="card">
      <div class="label">$${sim.bankroll} bankroll, ${sim.holdMinutes}m hold → final balance</div>
      <div class="value ${sim.finalBalance >= sim.bankroll ? 'positive' : 'negative'}">$${sim.finalBalance.toFixed(2)}</div>
    </div>
  </div>

  <div class="chart-box">
    <canvas id="equityChart"></canvas>
  </div>
  <div class="chart-box">
    <canvas id="cumulativeChart"></canvas>
  </div>
  <div class="chart-box">
    <canvas id="perTradeChart"></canvas>
  </div>
  <div class="chart-box" style="max-width: 360px;">
    <canvas id="winLossChart"></canvas>
  </div>

  <script>
    const labels = ${JSON.stringify(labels)};

    new Chart(document.getElementById('equityChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(sim.equityCurve.map((p) => new Date(p.time).toLocaleString()))},
        datasets: [{
          label: 'Equity ($${sim.bankroll} bankroll, ${sim.holdMinutes}m hold)',
          data: ${JSON.stringify(sim.equityCurve.map((p) => p.equity))},
          borderColor: '#22d3ee',
          backgroundColor: 'rgba(34,211,238,0.1)',
          fill: true,
          tension: 0.1,
          pointRadius: 0,
        }],
      },
      options: {
        plugins: {
          title: { display: true, text: 'Bankroll equity curve ($${sim.bankroll} start, ${sim.holdMinutes}m hold, ${sim.takenCount} taken / ${sim.skippedCapitalCount} skipped-capital)', color: '#e2e8f0' },
          legend: { labels: { color: '#e2e8f0' } },
        },
        scales: { x: { ticks: { color: '#94a3b8', maxTicksLimit: 12 } }, y: { ticks: { color: '#94a3b8' } } },
      },
    });

    new Chart(document.getElementById('cumulativeChart'), {
      type: 'line',
      data: { labels, datasets: ${JSON.stringify(cumulativeDatasets)} },
      options: {
        plugins: { title: { display: true, text: 'Cumulative hypothetical PnL ($)', color: '#e2e8f0' }, legend: { labels: { color: '#e2e8f0' } } },
        scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } },
      },
    });

    new Chart(document.getElementById('perTradeChart'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'PnL @ +${primaryHorizon}m', data: ${JSON.stringify(perTradePnl)}, backgroundColor: ${JSON.stringify(perTradeColors)} }] },
      options: {
        plugins: { title: { display: true, text: 'Per-trade PnL @ +${primaryHorizon}m ($)', color: '#e2e8f0' }, legend: { display: false } },
        scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } },
      },
    });

    new Chart(document.getElementById('winLossChart'), {
      type: 'doughnut',
      data: {
        labels: ['Win', 'Loss', 'Flat'],
        datasets: [{ data: [${wins}, ${losses}, ${flat}], backgroundColor: ['#22c55e', '#ef4444', '#64748b'] }],
      },
      options: { plugins: { title: { display: true, text: 'Win / Loss split', color: '#e2e8f0' }, legend: { labels: { color: '#e2e8f0' } } } },
    });
  </script>
</body>
</html>`;
}

async function main() {
  const entries = loadEntries(logPath);
  const tradeable = entries.filter((e) => e.executed && !e.skipped && e.conditionId);

  console.log(`Loaded ${entries.length} log lines (${tradeable.length} executed/copy-able trades) from ${logPath}`);
  if (tradeable.length === 0) {
    console.log('Nothing to analyze yet.');
    return;
  }

  const sdk = new PolymarketSDK(); // read-only, no privateKey needed for price history

  const maxHorizonSec = Math.max(...horizons) * 60;
  const totalPnl: Record<number, number> = {};
  for (const h of horizons) totalPnl[h] = 0;

  const evaluatedTrades: EvaluatedTrade[] = [];

  for (const entry of tradeable) {
    const entryPrice = entry.ourSlippagePrice ?? entry.leaderPrice;
    const tradeTs = Math.floor(entry.tradeTimestamp / 1000); // unix seconds
    const shares = entry.ourAmountUsdc ? entry.ourAmountUsdc / entryPrice : undefined;

    let points;
    try {
      points = await sdk.markets.getPricesHistory({
        tokenId: entry.tokenId,
        startTs: tradeTs,
        endTs: tradeTs + maxHorizonSec + 60,
        fidelity: 1, // 1-minute resolution
      });
    } catch (err) {
      console.log(`  [skip] ${entry.tokenId.slice(0, 10)}… price history fetch failed: ${(err as Error).message}`);
      continue;
    }

    if (points.length === 0) {
      console.log(`  [skip] ${entry.tokenId.slice(0, 10)}… no price history returned (market may be closed)`);
      continue;
    }

    const pnlByHorizon: Record<number, number | undefined> = {};
    const row: string[] = [
      `${entry.side} ${entry.outcome ?? entry.tokenId.slice(0, 8)} @ ${entryPrice.toFixed(4)}`,
      `(${entry.dryRun ? 'dry-run' : 'live'})`,
    ];

    for (const h of horizons) {
      const exitPrice = priceAt(points, tradeTs + h * 60);
      if (exitPrice === undefined || shares === undefined) {
        row.push(`+${h}m: N/A`);
        pnlByHorizon[h] = undefined;
        continue;
      }
      const pnl = entry.side === 'BUY'
        ? (exitPrice - entryPrice) * shares
        : (entryPrice - exitPrice) * shares;
      totalPnl[h] += pnl;
      pnlByHorizon[h] = pnl;
      row.push(`+${h}m: $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${exitPrice.toFixed(4)})`);
    }

    console.log('  ' + row.join(' | '));

    evaluatedTrades.push({
      label: `${entry.side} ${entry.outcome ?? entry.tokenId.slice(0, 8)}`,
      tradeTimestamp: entry.tradeTimestamp,
      side: entry.side,
      entryPrice,
      ourAmountUsdc: entry.ourAmountUsdc,
      dryRun: entry.dryRun,
      pnlByHorizon,
    });
  }

  console.log('\n── Summary ─────────────────────────────────');
  console.log(`Evaluated: ${evaluatedTrades.length}/${tradeable.length} trades`);
  for (const h of horizons) {
    console.log(`  Total hypothetical PnL @ +${h}m: $${totalPnl[h] >= 0 ? '+' : ''}${totalPnl[h].toFixed(2)}`);
  }

  const sim = simulateBankroll(evaluatedTrades, bankroll, holdMinutes);
  const simReturn = ((sim.finalBalance - bankroll) / bankroll) * 100;
  console.log(`\n── Bankroll simulation ($${bankroll}, ${holdMinutes}m hold) ──`);
  console.log(`  Trades taken: ${sim.takenCount} | skipped (capital): ${sim.skippedCapitalCount} | skipped (no data): ${sim.skippedNoDataCount}`);
  console.log(`  Final balance: $${sim.finalBalance.toFixed(2)} (${simReturn >= 0 ? '+' : ''}${simReturn.toFixed(1)}%)`);

  if (evaluatedTrades.length > 0) {
    const html = renderHtmlReport(evaluatedTrades, horizons, primaryHorizon, sim);
    const outPath = resolve(reportPath);
    writeFileSync(outPath, html);
    console.log(`\n📊 HTML report written to: ${outPath}`);
    console.log(`   Open it with: open "${outPath}"`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
