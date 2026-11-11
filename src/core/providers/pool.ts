import type { ProviderConfig } from '@shared/types';

export const DEFAULT_KEY_COOLDOWN_MS = 30_000;

export function normalizeApiKeys(rawKeys: readonly string[] | undefined): string[] {
  if (!Array.isArray(rawKeys)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawKeys) {
    for (const part of String(raw ?? '').split(/[,\r\n]+/)) {
      const trimmed = part.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }
  return result;
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface ProviderBucketState {
  keyCursor: number;
  endpointCursor: number;
  keyCooldownUntil: Map<string, number>;
  endpointCooldownUntil: Map<string, number>;
  activeCount: number;
  waitQueue: Array<() => void>;
  requestTimestamps: number[];
}

export interface PoolClockOptions {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Manages per-provider:
 * 1. Round-robin multi-key rotation with 30s per-key cooldown on HTTP `429`.
 * 2. Round-robin multi-URL rotation (e.g. DeepLX endpoints) with per-URL cooldown.
 * 3. Max concurrency semaphore (`maxConcurrency`).
 * 4. Sliding-window 1000ms requests-per-second rate limiter (`rateLimitRps`).
 */
export class ProviderExecutionPool {
  private readonly buckets = new Map<string, ProviderBucketState>();
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: PoolClockOptions = {}) {
    this.nowFn = options.now ?? (() => Date.now());
    this.sleepFn = options.sleep ?? abortableSleep;
  }

  private getBucket(providerId: string): ProviderBucketState {
    let bucket = this.buckets.get(providerId);
    if (!bucket) {
      bucket = {
        keyCursor: 0,
        endpointCursor: 0,
        keyCooldownUntil: new Map(),
        endpointCooldownUntil: new Map(),
        activeCount: 0,
        waitQueue: [],
        requestTimestamps: [],
      };
      this.buckets.set(providerId, bucket);
    }
    return bucket;
  }

  acquireApiKey(
    providerId: string,
    rawKeys: readonly string[] | undefined,
  ): string | undefined {
    const keys = normalizeApiKeys(rawKeys);
    if (keys.length === 0) return undefined;

    const bucket = this.getBucket(providerId);
    const now = this.nowFn();

    // Scan starting at round-robin cursor for the first uncooled key
    for (let offset = 0; offset < keys.length; offset++) {
      const idx = (bucket.keyCursor + offset) % keys.length;
      const candidate = keys[idx];
      const cooldownUntil = bucket.keyCooldownUntil.get(candidate) ?? 0;
      if (cooldownUntil <= now) {
        if (cooldownUntil > 0) {
          bucket.keyCooldownUntil.delete(candidate);
        }
        bucket.keyCursor = (idx + 1) % keys.length;
        return candidate;
      }
    }

    // Fallback when ALL keys are currently cooling down: pick the one expiring soonest
    let bestIdx = bucket.keyCursor % keys.length;
    let earliestUntil = Infinity;
    for (let i = 0; i < keys.length; i++) {
      const until = bucket.keyCooldownUntil.get(keys[i]) ?? 0;
      if (until < earliestUntil) {
        earliestUntil = until;
        bestIdx = i;
      }
    }
    bucket.keyCursor = (bestIdx + 1) % keys.length;
    return keys[bestIdx];
  }

  markKeyRateLimited(
    providerId: string,
    apiKey: string | undefined,
    cooldownMs = DEFAULT_KEY_COOLDOWN_MS,
  ): void {
    if (!apiKey) return;
    const bucket = this.getBucket(providerId);
    bucket.keyCooldownUntil.set(apiKey, this.nowFn() + Math.max(0, cooldownMs));
  }

  isKeyCoolingDown(providerId: string, apiKey: string): boolean {
    const bucket = this.buckets.get(providerId);
    if (!bucket) return false;
    return (bucket.keyCooldownUntil.get(apiKey) ?? 0) > this.nowFn();
  }

  acquireEndpoint(providerId: string, endpoints: readonly string[]): string {
    if (endpoints.length === 0) {
      throw new Error(`Provider "${providerId}" has no configured endpoints.`);
    }
    if (endpoints.length === 1) {
      return endpoints[0];
    }

    const bucket = this.getBucket(providerId);
    const now = this.nowFn();

    for (let offset = 0; offset < endpoints.length; offset++) {
      const idx = (bucket.endpointCursor + offset) % endpoints.length;
      const candidate = endpoints[idx];
      const cooldownUntil = bucket.endpointCooldownUntil.get(candidate) ?? 0;
      if (cooldownUntil <= now) {
        if (cooldownUntil > 0) {
          bucket.endpointCooldownUntil.delete(candidate);
        }
        bucket.endpointCursor = (idx + 1) % endpoints.length;
        return candidate;
      }
    }

    let bestIdx = bucket.endpointCursor % endpoints.length;
    let earliestUntil = Infinity;
    for (let i = 0; i < endpoints.length; i++) {
      const until = bucket.endpointCooldownUntil.get(endpoints[i]) ?? 0;
      if (until < earliestUntil) {
        earliestUntil = until;
        bestIdx = i;
      }
    }
    bucket.endpointCursor = (bestIdx + 1) % endpoints.length;
    return endpoints[bestIdx];
  }

  markEndpointUnhealthy(
    providerId: string,
    endpoint: string,
    cooldownMs = DEFAULT_KEY_COOLDOWN_MS,
  ): void {
    const bucket = this.getBucket(providerId);
    bucket.endpointCooldownUntil.set(
      endpoint,
      this.nowFn() + Math.max(0, cooldownMs),
    );
  }

  private async acquireConcurrencySlot(
    bucket: ProviderBucketState,
    maxConcurrency: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      throw createAbortError();
    }
    const limit =
      Number.isFinite(maxConcurrency) && maxConcurrency >= 1
        ? Math.floor(maxConcurrency)
        : 4;

    if (bucket.activeCount < limit) {
      bucket.activeCount++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let granted = false;
      const grant = () => {
        if (granted) return;
        granted = true;
        signal?.removeEventListener('abort', onAbort);
        bucket.activeCount++;
        resolve();
      };
      const onAbort = () => {
        if (granted) return;
        const idx = bucket.waitQueue.indexOf(grant);
        if (idx !== -1) {
          bucket.waitQueue.splice(idx, 1);
        }
        reject(createAbortError());
      };
      bucket.waitQueue.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaseConcurrencySlot(bucket: ProviderBucketState): void {
    bucket.activeCount = Math.max(0, bucket.activeCount - 1);
    const next = bucket.waitQueue.shift();
    if (next) {
      next();
    }
  }

  private async enforceSlidingWindowRps(
    bucket: ProviderBucketState,
    rateLimitRps: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isFinite(rateLimitRps) || rateLimitRps <= 0) {
      return;
    }
    const maxPerSecond = Math.max(1, Math.floor(rateLimitRps));

    while (true) {
      if (signal?.aborted) {
        throw createAbortError();
      }
      const now = this.nowFn();
      const windowStart = now - 1000;
      while (
        bucket.requestTimestamps.length > 0 &&
        bucket.requestTimestamps[0] <= windowStart
      ) {
        bucket.requestTimestamps.shift();
      }

      if (bucket.requestTimestamps.length < maxPerSecond) {
        bucket.requestTimestamps.push(now);
        return;
      }

      const oldest = bucket.requestTimestamps[0];
      const waitMs = Math.max(1, 1000 - (now - oldest) + 1);
      await this.sleepFn(waitMs, signal);
    }
  }

  async schedule<T>(
    provider: Pick<ProviderConfig, 'id' | 'maxConcurrency' | 'rateLimitRps'>,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const bucket = this.getBucket(provider.id);
    await this.acquireConcurrencySlot(bucket, provider.maxConcurrency, signal);
    try {
      await this.enforceSlidingWindowRps(bucket, provider.rateLimitRps, signal);
      return await task();
    } finally {
      this.releaseConcurrencySlot(bucket);
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}

export const defaultProviderPool = new ProviderExecutionPool();
