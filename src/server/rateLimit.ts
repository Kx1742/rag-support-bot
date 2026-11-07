export interface LimitResult {
  allowed: boolean;
  /** Seconds until the next request would be allowed (0 when allowed). */
  retryAfterSec: number;
}

/**
 * Token-bucket rate limiter, one bucket per key (e.g. visitor IP).
 * Allows short bursts up to `capacity`, refilling at `perMinute` tokens per minute.
 * In-memory: fine for one server process. Use Redis when running several.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(options: { capacity: number; perMinute: number; now?: () => number }) {
    this.capacity = options.capacity;
    this.refillPerMs = options.perMinute / 60_000;
    this.now = options.now ?? Date.now;
  }

  take(key: string): LimitResult {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.prune(now);
      return { allowed: true, retryAfterSec: 0 };
    }
    return { allowed: false, retryAfterSec: Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1000) };
  }

  /** Forget buckets that are full again, so memory doesn't grow forever. */
  private prune(now: number): void {
    if (this.buckets.size < 10_000) return;
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.updatedAt) * this.refillPerMs >= this.capacity) this.buckets.delete(key);
    }
  }
}

/** Caps total requests per UTC day across all visitors, protecting the API quota. */
export class DailyCap {
  private day = "";
  private count = 0;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(options: { limit: number; now?: () => number }) {
    this.limit = options.limit;
    this.now = options.now ?? Date.now;
  }

  take(): boolean {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }
}
