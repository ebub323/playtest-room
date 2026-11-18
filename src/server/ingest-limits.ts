/**
 * Token buckets for the ingest gate (src/server/ingest.ts).
 *
 * Kept free of Durable Object and platform imports so the limits can be unit
 * tested directly.
 */

export type BucketConfig = { capacity: number; refillPerSec: number }
export type Bucket = { tokens: number; at: number }

export function newBucket(cfg: BucketConfig, now: number): Bucket {
  return { tokens: cfg.capacity, at: now }
}

/** Refill by elapsed time, then spend one token. False when empty. */
export function take(bucket: Bucket, cfg: BucketConfig, now: number): boolean {
  bucket.tokens = Math.min(cfg.capacity, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * cfg.refillPerSec)
  bucket.at = now
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

/**
 * One bucket per key (session id, client IP), bounded in size. When full,
 * the least recently used key is dropped; a dropped key comes back with a
 * full bucket, so the bound trades a little leniency for bounded memory.
 */
export class BucketMap {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly cfg: BucketConfig,
    private readonly maxEntries: number,
  ) {}

  take(key: string, now: number): boolean {
    let bucket = this.buckets.get(key)
    if (bucket) {
      this.buckets.delete(key) // re-insert below: Map order is LRU order
    } else {
      if (this.buckets.size >= this.maxEntries) {
        const oldest = this.buckets.keys().next().value
        if (oldest !== undefined) this.buckets.delete(oldest)
      }
      bucket = newBucket(this.cfg, now)
    }
    this.buckets.set(key, bucket)
    return take(bucket, this.cfg, now)
  }

  get size(): number {
    return this.buckets.size
  }
}
