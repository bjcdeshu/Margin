import type { GlossaryEntry } from '@shared/types';

export interface TranslationCacheKeyParams {
  providerId: string;
  model: string;
  assistantId?: string;
  codecId: string;
  fromLang: string;
  toLang: string;
  glossary: readonly GlossaryEntry[];
  sourceText: string;
}

function hashGlossarySignature(glossary: readonly GlossaryEntry[]): string {
  if (glossary.length === 0) return 'g0';
  let hash = 2166136261;
  for (const entry of glossary) {
    const token = `${entry.k}=${entry.v}@${entry.domain ?? ''}:${entry.caseSensitive ? 1 : 0};`;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `g${(hash >>> 0).toString(36)}`;
}

export function makeTranslationCacheKey(
  params: TranslationCacheKeyParams,
): string {
  const gSig = hashGlossarySignature(params.glossary);
  return [
    params.providerId,
    params.model,
    params.assistantId ?? '-',
    params.codecId,
    params.fromLang,
    params.toLang,
    gSig,
    params.sourceText,
  ].join('::');
}

export class TranslationLruCache {
  private readonly maxEntries: number;
  private readonly store = new Map<string, string>();

  constructor(maxEntries = 2000) {
    this.maxEntries = Math.max(16, maxEntries);
  }

  get(key: string): string | undefined {
    const val = this.store.get(key);
    if (val === undefined) return undefined;
    // Refresh recency
    this.store.delete(key);
    this.store.set(key, val);
    return val;
  }

  set(key: string, value: string): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, value);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

export const backgroundTranslationCache = new TranslationLruCache(2000);
