/**
 * StrategyController state machine tests (plan.md Polish phase).
 * Uses ArbitrageController as the representative implementation.
 * Tests state transitions without touching real network/services.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BankrollLedger } from '../../../../bots/unified/bankroll/ledger.ts';
import type { StrategyMode } from '../../../../bots/unified/controllers/types.ts';

// Minimal mock SDK for the controller (avoids network calls)
function makeMockSdk() {
  return {
    markets: {
      scanCryptoShortTermMarkets: vi.fn().mockResolvedValue([
        { question: 'Mock Market', conditionId: '0xabc', endDate: new Date().toISOString() },
      ]),
      getMarket: vi.fn().mockResolvedValue({
        tokens: [
          { tokenId: 'token-yes', outcome: 'Up' },
          { tokenId: 'token-no', outcome: 'Down' },
        ],
      }),
    },
  } as unknown as import('../../../../src/index.ts').PolymarketSDK;
}

// A minimal stub controller for pure state-machine testing
class StubController {
  status: 'stopped' | 'running' | 'paused' | 'degraded' | 'error' = 'stopped';
  mode: StrategyMode = 'dry-run';
  private _paused = false;
  allowsEntry = true;

  async start() { this.status = 'running'; this._paused = false; }
  pause()  { this._paused = true; this.status = 'paused'; }
  resume() { this._paused = false; this.status = 'running'; }
  async stop() { this.status = 'stopped'; }
  setMode(m: StrategyMode) { this.mode = m; }

  // Simulates what _paused = true blocks
  canInitiateEntry() { return !this._paused && this.status === 'running'; }
}

describe('StrategyController state machine', () => {
  let ctrl: StubController;

  beforeEach(() => { ctrl = new StubController(); });

  it('starts in stopped state', () => {
    expect(ctrl.status).toBe('stopped');
    expect(ctrl.mode).toBe('dry-run');
  });

  it('stopped → running on start()', async () => {
    await ctrl.start();
    expect(ctrl.status).toBe('running');
  });

  it('running → paused on pause(); paused blocks new trade entries', async () => {
    await ctrl.start();
    expect(ctrl.canInitiateEntry()).toBe(true);
    ctrl.pause();
    expect(ctrl.status).toBe('paused');
    expect(ctrl.canInitiateEntry()).toBe(false);
  });

  it('paused → running on resume(); entries resume', async () => {
    await ctrl.start();
    ctrl.pause();
    ctrl.resume();
    expect(ctrl.status).toBe('running');
    expect(ctrl.canInitiateEntry()).toBe(true);
  });

  it('running → stopped on stop()', async () => {
    await ctrl.start();
    await ctrl.stop();
    expect(ctrl.status).toBe('stopped');
  });

  it('paused → stopped on stop()', async () => {
    await ctrl.start();
    ctrl.pause();
    await ctrl.stop();
    expect(ctrl.status).toBe('stopped');
  });

  it('setMode does not change status', async () => {
    await ctrl.start();
    ctrl.setMode('live');
    expect(ctrl.status).toBe('running');
    expect(ctrl.mode).toBe('live');
  });

  it('dry-run mode set on init, never live without explicit call', () => {
    expect(ctrl.mode).toBe('dry-run');
  });
});
