/**
 * Simple in-memory cache with TTL support
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const SWEEP_EVERY_N_SETS = 200;

export class Cache {
  private store: Map<string, CacheEntry<unknown>> = new Map();
  private setsSinceSweep = 0;

  /**
   * Get a cached value
   */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /**
   * Set a cached value with TTL
   */
  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });

    // get() only evicts expired entries lazily, on lookup of that exact key.
    // Keys that are set once and never looked up again (e.g. markets that
    // rotate out) would otherwise accumulate forever, so sweep periodically.
    this.setsSinceSweep++;
    if (this.setsSinceSweep >= SWEEP_EVERY_N_SETS) {
      this.setsSinceSweep = 0;
      this.sweepExpired();
    }
  }

  /**
   * Remove all expired entries
   */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Get a cached value or set it if not present
   */
  async getOrSet<T>(
    key: string,
    ttlMs: number,
    factory: () => Promise<T>
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    this.set(key, value, ttlMs);
    return value;
  }

  /**
   * Invalidate all keys matching a pattern
   */
  invalidate(pattern: string): void {
    for (const key of this.store.keys()) {
      if (key.includes(pattern)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Clear all cached values
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get the number of cached entries
   */
  size(): number {
    return this.store.size;
  }
}

/**
 * Cache TTL constants (in milliseconds)
 */
export const CACHE_TTL = {
  MARKET_INFO: 60 * 1000, // 1 minute
  WALLET_POSITIONS: 5 * 60 * 1000, // 5 minutes
  LEADERBOARD: 60 * 60 * 1000, // 1 hour
  TICK_SIZE: 24 * 60 * 60 * 1000, // 24 hours
  ACTIVITY: 2 * 60 * 1000, // 2 minutes (wallet activity data)
  // Binance K-line cache (historical data doesn't change)
  BINANCE_KLINE: 60 * 1000, // 1 minute
  // Binance current price cache (more volatile)
  BINANCE_PRICE: 5 * 1000, // 5 seconds
};
