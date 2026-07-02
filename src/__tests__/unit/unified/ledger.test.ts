import { describe, it, expect, vi } from 'vitest';
import { BankrollLedger as Ledger } from '../../../../bots/unified/bankroll/ledger.ts';

describe('BankrollLedger', () => {
  it('allows reserve when funds available', () => {
    const l = new Ledger(100);
    const r = l.reserve('arbitrage', 40);
    expect(r.ok).toBe(true);
    expect(l.snapshot().committedUsdc).toBe(40);
    expect(l.snapshot().availableUsdc).toBe(60);
  });

  it('refuses reserve when over pool ceiling and emits starved naming the strategy', () => {
    const l = new Ledger(30);
    const starvedMock = vi.fn();
    l.on('starved', starvedMock);
    l.reserve('copy-trade', 20);
    const r = l.reserve('dip-arb', 20);  // only 10 left
    expect(r.ok).toBe(false);
    expect(starvedMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dip-arb', requestedUsdc: 20 }));
  });

  it('release replenishes the shared pool', () => {
    const l = new Ledger(100);
    l.reserve('arbitrage', 60);
    l.release('arbitrage', 30);
    expect(l.snapshot().availableUsdc).toBe(70);
  });

  it('setTotal below committed clamps availableUsdc to 0 and blocks further reserves', () => {
    const l = new Ledger(100);
    l.reserve('copy-trade', 80);
    l.setTotal(50);                          // committed 80 > new total 50
    expect(l.snapshot().availableUsdc).toBe(0);
    const r = l.reserve('arbitrage', 1);
    expect(r.ok).toBe(false);
  });

  it('committedByStrategy tracks per-strategy shares', () => {
    const l = new Ledger(200);
    l.reserve('arbitrage', 30);
    l.reserve('copy-trade', 50);
    const snap = l.snapshot();
    expect(snap.committedByStrategy['arbitrage']).toBe(30);
    expect(snap.committedByStrategy['copy-trade']).toBe(50);
    expect(snap.committedByStrategy['dip-arb']).toBe(0);
  });

  it('emits changed event on reserve, release, and setTotal', () => {
    const l = new Ledger(100);
    const changes: number[] = [];
    l.on('changed', (s) => changes.push(s.committedUsdc));
    l.reserve('arbitrage', 10);
    l.release('arbitrage', 5);
    l.setTotal(200);
    expect(changes.length).toBe(3);
  });
});
