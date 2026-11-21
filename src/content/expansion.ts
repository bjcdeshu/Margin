import { stripResidualMarkers } from './rich-text';

export const DEFAULT_RECENT_PREFIX_CAPACITY = 64;
export const DEFAULT_RECENT_PREFIX_TTL_MS = 600_000;
const BUCKET_HEAD_LEN = 24;

export type SourceChangeKind = 'same' | 'expansion' | 'unrelated';

export interface PrefixSnapshot {
  configSig: string;
  blockPlain: string;
  lastSegPlain: string;
  lastSegSourceText: string;
  lastSegTranslated: string;
  at: number;
}

export interface RecentPrefixStoreOptions {
  capacity?: number;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Strips residual `<mN>` markers, applies Unicode NFKC normalization, and collapses
 * runs of whitespace to single spaces for plain-text prefix comparison.
 */
export function normalizePlainForPrefix(raw: string): string {
  if (!raw) return '';
  return stripResidualMarkers(raw)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripTrailingTruncationEllipsis(normalizedPlain: string): string {
  return normalizedPlain.replace(/(?:\u2026|\.{3}|\s)+$/u, '').trim();
}

export function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) {
    i += 1;
  }
  if (i > 0) {
    const prevCode = a.charCodeAt(i - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      i -= 1;
    }
  }
  return i;
}

/**
 * Classifies how a block's plain text changed between `prevPlain` and `nextPlain`:
 * - `'same'`: normalized plain texts are identical (e.g. only inline markers changed)
 * - `'expansion'`: `nextPlain` extends `prevPlain` (tolerating trailing `…`/`...` and up to
 *   16 chars of half-word or truncated-URL slack at the cut point, with `lcp >= 24`)
 * - `'unrelated'`: recycled virtual-scroll cell, shrink, or short accidental prefix
 */
export function classifySourceChange(
  prevPlain: string,
  nextPlain: string,
): SourceChangeKind {
  const prevNorm = normalizePlainForPrefix(prevPlain);
  const nextNorm = normalizePlainForPrefix(nextPlain);
  if (!prevNorm || !nextNorm) {
    return 'unrelated';
  }
  if (prevNorm === nextNorm) {
    return 'same';
  }

  const core = stripTrailingTruncationEllipsis(prevNorm);
  if (!core) {
    return 'unrelated';
  }

  const lcp = commonPrefixLength(core, nextNorm);
  if (
    lcp >= 24 &&
    lcp >= core.length - 16 &&
    nextNorm.length > lcp &&
    nextNorm.length > core.length
  ) {
    return 'expansion';
  }

  return 'unrelated';
}

/**
 * Used within an already-verified block-level expansion (`lcp >= 24`) to check whether
 * a boundary segment `nextSegPlain` grew from `prevSegPlain` (including when X's ~280-char
 * preview cut landed `< 24` chars into a newly started paragraph).
 */
export function isBoundarySegmentExpansion(
  prevSegPlain: string,
  nextSegPlain: string,
): boolean {
  if (classifySourceChange(prevSegPlain, nextSegPlain) === 'expansion') {
    return true;
  }
  const prevNorm = normalizePlainForPrefix(prevSegPlain);
  const nextNorm = normalizePlainForPrefix(nextSegPlain);
  if (!prevNorm || !nextNorm || prevNorm === nextNorm) {
    return false;
  }
  const core = stripTrailingTruncationEllipsis(prevNorm);
  if (core.length < 4) {
    return false;
  }
  const lcp = commonPrefixLength(core, nextNorm);
  const slack = core.length >= 20 ? 16 : Math.min(6, Math.floor(core.length / 2));
  return (
    lcp >= Math.max(4, core.length - slack) &&
    nextNorm.length > lcp &&
    nextNorm.length > core.length
  );
}

interface StoredPrefixRecord {
  headKey: string;
  core: string;
  snapshot: PrefixSnapshot;
}

/**
 * Bounded RAM-only prefix index (LRU 64, TTL 10 min) carrying the boundary segment's
 * preview translation across SPA route transitions (e.g. X `/home` -> `/user/status/<id>`).
 * Holds strings only and zero DOM references; never persisted to L1 or IndexedDB caches.
 */
export class RecentPrefixStore {
  private readonly entries = new Map<string, StoredPrefixRecord>();
  private readonly buckets = new Map<string, Set<string>>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;
  private activeConfigSig: string | null = null;

  constructor(options: RecentPrefixStoreOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_RECENT_PREFIX_CAPACITY);
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_RECENT_PREFIX_TTL_MS);
    this.nowFn = options.now ?? (() => Date.now());
  }

  get size(): number {
    this.evictExpired(this.nowFn());
    return this.entries.size;
  }

  private removeKey(normBlockKey: string): void {
    const existing = this.entries.get(normBlockKey);
    if (!existing) return;
    this.entries.delete(normBlockKey);
    const bucket = this.buckets.get(existing.headKey);
    if (bucket) {
      bucket.delete(normBlockKey);
      if (bucket.size === 0) {
        this.buckets.delete(existing.headKey);
      }
    }
  }

  private evictExpired(nowMs: number): void {
    for (const [key, rec] of Array.from(this.entries.entries())) {
      if (nowMs - rec.snapshot.at > this.ttlMs) {
        this.removeKey(key);
      } else {
        // Entries are ordered oldest-first by insertion/touch recency, except custom `at`
        // timestamps may differ in tests — scan bounded <= 64 map completely for exactness.
      }
    }
  }

  invalidateIfSignatureChanged(configSig: string): void {
    if (this.activeConfigSig !== null && this.activeConfigSig !== configSig) {
      this.clear();
    }
    this.activeConfigSig = configSig;
  }

  record(snapshot: PrefixSnapshot): void {
    const nowMs = this.nowFn();
    this.invalidateIfSignatureChanged(snapshot.configSig);
    this.evictExpired(nowMs);

    const normBlock = normalizePlainForPrefix(snapshot.blockPlain);
    const core = stripTrailingTruncationEllipsis(normBlock);
    if (core.length < BUCKET_HEAD_LEN) {
      return;
    }

    const headKey = core.slice(0, BUCKET_HEAD_LEN);
    const storedSnapshot: PrefixSnapshot = {
      configSig: snapshot.configSig,
      blockPlain: normBlock,
      lastSegPlain: normalizePlainForPrefix(snapshot.lastSegPlain),
      lastSegSourceText: snapshot.lastSegSourceText,
      lastSegTranslated: snapshot.lastSegTranslated,
      at: snapshot.at ?? nowMs,
    };

    if (nowMs - storedSnapshot.at > this.ttlMs) {
      return;
    }

    if (this.entries.has(normBlock)) {
      this.removeKey(normBlock);
    } else {
      while (this.entries.size >= this.capacity) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey === undefined) break;
        this.removeKey(oldestKey);
      }
    }

    this.entries.set(normBlock, {
      headKey,
      core,
      snapshot: storedSnapshot,
    });
    let bucket = this.buckets.get(headKey);
    if (!bucket) {
      bucket = new Set<string>();
      this.buckets.set(headKey, bucket);
    }
    bucket.add(normBlock);
  }

  match(
    nextBlockPlain: string,
    configSig: string,
    nowOverrideMs?: number,
  ): PrefixSnapshot | null {
    if (this.activeConfigSig !== null && this.activeConfigSig !== configSig) {
      this.clear();
      return null;
    }

    const nowMs = nowOverrideMs ?? this.nowFn();
    this.evictExpired(nowMs);

    const nextNorm = normalizePlainForPrefix(nextBlockPlain);
    if (nextNorm.length <= BUCKET_HEAD_LEN) {
      return null;
    }

    const headKey = nextNorm.slice(0, BUCKET_HEAD_LEN);
    const bucket = this.buckets.get(headKey);
    if (!bucket || bucket.size === 0) {
      return null;
    }

    let bestKey: string | null = null;
    let bestRecord: StoredPrefixRecord | null = null;
    let bestLcp = -1;

    for (const key of bucket) {
      const rec = this.entries.get(key);
      if (!rec || rec.snapshot.configSig !== configSig) continue;
      if (classifySourceChange(rec.snapshot.blockPlain, nextNorm) !== 'expansion') {
        continue;
      }
      const lcp = commonPrefixLength(rec.core, nextNorm);
      if (lcp >= bestLcp) {
        bestLcp = lcp;
        bestKey = key;
        bestRecord = rec;
      }
    }

    if (!bestKey || !bestRecord) {
      return null;
    }

    // Refresh LRU recency on hit
    this.entries.delete(bestKey);
    this.entries.set(bestKey, bestRecord);

    return { ...bestRecord.snapshot };
  }

  clear(): void {
    this.entries.clear();
    this.buckets.clear();
    this.activeConfigSig = null;
  }
}
