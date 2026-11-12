import {
  computeMatchedGlossarySignature,
  DEFAULT_JSON_BATCH_SYSTEM_PROMPT,
} from '@core/prompts';
import type {
  AssistantConfig,
  GlossaryEntry,
  TranslationScene,
} from '@shared/types';
import {
  IndexedDbTranslationAdapter,
  type TranslationEntryMeta,
  type TranslationPersistenceAdapter,
  type TranslationPersistenceWriteItem,
} from './translation-db';

export interface TranslationCacheKeyParams {
  providerId: string;
  model: string;
  assistantId?: string;
  codecId: string;
  scene?: TranslationScene | 'service-test';
  fromLang: string;
  toLang: string;
  glossary?: readonly GlossaryEntry[];
  matchedGlossarySig?: string;
  domainOrUrl?: string;
  assistant?: AssistantConfig;
  promptFingerprint?: string;
  styleGuide?: string;
  sourceText: string;
}

function fnv1aHash(prefix: string, input: string): string {
  if (!input) return `${prefix}0`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}${(hash >>> 0).toString(36)}`;
}

export function computeAssistantPromptFingerprint(
  assistant?: AssistantConfig,
  scene: TranslationScene | 'service-test' = 'webpage',
  codecId?: string,
): string {
  const effectiveCodec = codecId ?? assistant?.codec ?? 'json-batch';
  if (effectiveCodec === 'single-text') {
    return 'p0';
  }
  if (!assistant) {
    if (effectiveCodec === 'json-batch') {
      return fnv1aHash('p', `${scene}::${DEFAULT_JSON_BATCH_SYSTEM_PROMPT}`);
    }
    return 'p0';
  }

  const sortedEnv = Object.entries(assistant.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\u0001');

  const payload = [
    scene,
    assistant.codec,
    assistant.systemPrompt ?? '',
    assistant.multipleSystemPrompt ?? '',
    assistant.prompt ?? '',
    assistant.multiplePrompt ?? '',
    assistant.inputPrompt ?? '',
    assistant.selectionPrompt ?? '',
    assistant.subtitlePrompt ?? '',
    assistant.separator ?? '',
    sortedEnv,
  ].join('\u0000');

  return fnv1aHash('p', payload);
}

export function makeTranslationCacheKey(
  params: TranslationCacheKeyParams,
): string {
  const gSig =
    params.matchedGlossarySig ??
    (params.glossary && params.glossary.length > 0
      ? computeMatchedGlossarySignature(
          [params.sourceText],
          params.glossary,
          params.domainOrUrl,
        )
      : 'g0');

  const pSig =
    params.promptFingerprint ??
    (params.assistant || params.codecId === 'json-batch'
      ? computeAssistantPromptFingerprint(
          params.assistant,
          params.scene ?? 'webpage',
          params.codecId,
        )
      : 'p0');

  const trimmedStyle = params.styleGuide?.trim() ?? '';
  const sSig = trimmedStyle ? fnv1aHash('s', trimmedStyle) : 's0';

  return [
    params.providerId,
    params.model,
    params.assistantId ?? params.assistant?.id ?? '-',
    params.codecId,
    params.fromLang,
    params.toLang,
    gSig,
    pSig,
    sSig,
    params.sourceText,
  ].join('::');
}

export class TranslationLruCache {
  private readonly maxEntries: number;
  private readonly store = new Map<string, string>();
  private readonly persistence: TranslationPersistenceAdapter;

  constructor(
    maxEntries = 2000,
    persistenceAdapter: TranslationPersistenceAdapter = new IndexedDbTranslationAdapter(),
  ) {
    this.maxEntries = Math.max(16, maxEntries);
    this.persistence = persistenceAdapter;
  }

  private setMemoryOnly(key: string, value: string): void {
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

  get(key: string): string | undefined {
    const val = this.store.get(key);
    if (val === undefined) return undefined;
    // Refresh recency
    this.store.delete(key);
    this.store.set(key, val);
    return val;
  }

  async getMany(
    keys: readonly string[],
    now?: number,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (keys.length === 0) return result;

    const l1Misses: string[] = [];
    for (const key of keys) {
      const hit = this.get(key);
      if (hit !== undefined) {
        result.set(key, hit);
      } else {
        l1Misses.push(key);
      }
    }

    if (l1Misses.length > 0 && this.persistence.isAvailable) {
      const l2Hits = await this.persistence.getMany(l1Misses, now);
      for (const [k, v] of l2Hits.entries()) {
        this.setMemoryOnly(k, v);
        result.set(k, v);
      }
    }

    return result;
  }

  set(key: string, value: string, meta?: TranslationEntryMeta): void {
    this.setMemoryOnly(key, value);
    if (this.persistence.isAvailable) {
      void this.persistence.putMany([{ key, value, meta }]);
    }
  }

  async setMany(
    entries: readonly TranslationPersistenceWriteItem[],
    now?: number,
  ): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) {
      if (!entry.key) continue;
      this.setMemoryOnly(entry.key, entry.value);
    }
    if (this.persistence.isAvailable) {
      await this.persistence.putMany(entries, now);
    }
  }

  async getStats(now?: number): Promise<{
    memoryEntries: number;
    persistentEntries: number;
    dbAvailable: boolean;
  }> {
    const persistentEntries = this.persistence.isAvailable
      ? await this.persistence.count(now)
      : 0;
    return {
      memoryEntries: this.store.size,
      persistentEntries,
      dbAvailable: this.persistence.isAvailable,
    };
  }

  async clearAll(): Promise<void> {
    this.store.clear();
    if (this.persistence.isAvailable) {
      await this.persistence.clear();
    }
  }

  clear(): void {
    this.store.clear();
    if (this.persistence.isAvailable) {
      void this.persistence.clear();
    }
  }

  /** Simulates an MV3 Service Worker cold restart by dropping L1 RAM while keeping L2 intact. */
  evictMemoryOnly(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

export const backgroundTranslationCache = new TranslationLruCache(2000);
