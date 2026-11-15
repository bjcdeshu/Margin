import {
  computeMatchedGlossarySignature,
  DEFAULT_JSON_BATCH_SYSTEM_PROMPT,
} from '@core/prompts';
import { resolveEffectiveTemperature } from '@shared/temperature';
import type {
  AssistantConfig,
  GlossaryEntry,
  TemperaturePolicy,
  ThinkingPolicy,
  TranslationScene,
  WireProtocol,
} from '@shared/types';
import {
  IndexedDbTranslationAdapter,
  type TranslationEntryMeta,
  type TranslationPersistenceAdapter,
  type TranslationPersistenceWriteItem,
} from './translation-db';

export interface TranslationCacheKeyParams {
  providerId: string;
  protocol?: WireProtocol;
  endpoint?: string | readonly string[];
  model: string;
  assistantId?: string;
  codecId: string;
  scene?: TranslationScene | 'service-test';
  fromLang: string;
  toLang: string;
  temperaturePolicy?: TemperaturePolicy;
  thinkingPolicy?: ThinkingPolicy;
  glossary?: readonly GlossaryEntry[];
  matchedGlossarySig?: string;
  domainOrUrl?: string;
  assistant?: AssistantConfig;
  promptFingerprint?: string;
  styleGuide?: string;
  sourceText: string;
}

function fnvHash64(prefix: string, input: string): string {
  if (!input) return `${prefix}0`;
  let h1 = 2166136261;
  let h2 = 2166136261 ^ 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c;
    h2 = Math.imul(h2, 16777619) + 0x85ebca6b;
  }
  return `${prefix}${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}`;
}

function normalizeEndpointSignature(
  endpoint?: string | readonly string[],
): string {
  if (!endpoint) return 'e0';
  const rawList = (Array.isArray(endpoint) ? endpoint : [endpoint])
    .map((u) => String(u ?? '').trim())
    .filter((u) => u.length > 0);
  if (rawList.length === 0) return 'e0';

  const origins = rawList.map((raw) => {
    try {
      return new URL(raw).origin.toLowerCase();
    } catch {
      return 'custom';
    }
  });
  return `${origins.join(',')}#${fnvHash64('e', JSON.stringify(rawList))}`;
}

function normalizeGenerationPolicySignature(params: {
  protocol?: WireProtocol;
  model: string;
  temperaturePolicy?: TemperaturePolicy;
  assistantTemperaturePolicy?: TemperaturePolicy;
  thinkingPolicy?: ThinkingPolicy;
}): { tempSig: string; thinkingSig: string } {
  const {
    protocol,
    model,
    temperaturePolicy,
    assistantTemperaturePolicy,
    thinkingPolicy,
  } = params;

  if (protocol === 'deeplx' || protocol === 'google-web') {
    return { tempSig: 't:none', thinkingSig: 'k:none' };
  }

  const resolvedTemp = resolveEffectiveTemperature({
    model,
    providerPolicy: temperaturePolicy ?? { mode: 'omit' },
    assistantPolicy: assistantTemperaturePolicy,
  });

  const effectiveTempValue =
    protocol === 'anthropic-messages' && thinkingPolicy?.mode === 'enabled'
      ? undefined
      : resolvedTemp.value;

  const tempSig =
    effectiveTempValue !== undefined ? `t:${effectiveTempValue}` : 't:omit';

  let thinkingSig = 'k:provider-default';
  if (thinkingPolicy?.mode === 'disabled') {
    thinkingSig = 'k:disabled';
  } else if (thinkingPolicy?.mode === 'enabled') {
    thinkingSig = `k:enabled:${thinkingPolicy.budgetTokens ?? ''}`;
  }

  return { tempSig, thinkingSig };
}

export function computeAssistantPromptFingerprint(
  assistant?: AssistantConfig,
  scene: TranslationScene | 'service-test' = 'webpage',
  codecId?: string,
): string {
  const effectiveCodec = codecId ?? assistant?.codec ?? 'json-batch';
  if (!assistant) {
    if (effectiveCodec === 'json-batch') {
      return fnvHash64('p', `${scene}::${DEFAULT_JSON_BATCH_SYSTEM_PROMPT}`);
    }
    return 'p0';
  }

  const sortedEnv = Object.entries(assistant.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify([k, v]))
    .join('\u0001');

  const payload = JSON.stringify([
    scene,
    effectiveCodec,
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
  ]);

  return fnvHash64('p', payload);
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
    computeAssistantPromptFingerprint(
      params.assistant,
      params.scene ?? 'webpage',
      params.codecId,
    );

  const trimmedStyle = params.styleGuide?.trim() ?? '';
  const sSig = trimmedStyle ? fnvHash64('s', trimmedStyle) : 's0';

  const endpointSig = normalizeEndpointSignature(params.endpoint);
  const { tempSig, thinkingSig } = normalizeGenerationPolicySignature({
    protocol: params.protocol,
    model: params.model,
    temperaturePolicy: params.temperaturePolicy,
    assistantTemperaturePolicy: params.assistant?.temperaturePolicy,
    thinkingPolicy: params.thinkingPolicy,
  });

  return JSON.stringify([
    params.providerId,
    params.protocol ?? '',
    endpointSig,
    params.model,
    params.assistantId ?? params.assistant?.id ?? '-',
    params.codecId,
    params.scene ?? 'webpage',
    params.fromLang,
    params.toLang,
    tempSig,
    thinkingSig,
    gSig,
    pSig,
    sSig,
    params.sourceText,
  ]);
}

export class TranslationLruCache {
  private readonly maxEntries: number;
  private readonly store = new Map<string, string>();
  private readonly persistence: TranslationPersistenceAdapter;
  private clearEpoch = 0;
  private persistenceQueue: Promise<void> = Promise.resolve();

  private enqueuePersistenceOp(task: () => Promise<void>): Promise<void> {
    const next = this.persistenceQueue.then(task, task);
    this.persistenceQueue = next.catch(() => {});
    return next;
  }

  constructor(
    maxEntries = 2000,
    persistenceAdapter: TranslationPersistenceAdapter = new IndexedDbTranslationAdapter(),
  ) {
    this.maxEntries = Math.max(16, maxEntries);
    this.persistence = persistenceAdapter;
  }

  getClearEpoch(): number {
    return this.clearEpoch;
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

    const epochAtStart = this.clearEpoch;
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
      if (this.clearEpoch !== epochAtStart) {
        return new Map();
      }
      for (const [k, v] of l2Hits.entries()) {
        this.setMemoryOnly(k, v);
        result.set(k, v);
      }
    }

    return result;
  }

  set(
    key: string,
    value: string,
    meta?: TranslationEntryMeta,
    expectedEpoch?: number,
  ): void {
    const epoch = expectedEpoch ?? this.clearEpoch;
    if (epoch !== this.clearEpoch) return;
    this.setMemoryOnly(key, value);
    if (this.persistence.isAvailable) {
      void this.enqueuePersistenceOp(async () => {
        if (this.clearEpoch !== epoch) return;
        await this.persistence.putMany([{ key, value, meta }]);
      }).catch(() => {});
    }
  }

  async setMany(
    entries: readonly TranslationPersistenceWriteItem[],
    now?: number,
    expectedEpoch?: number,
  ): Promise<void> {
    if (entries.length === 0) return;
    const epoch = expectedEpoch ?? this.clearEpoch;
    if (epoch !== this.clearEpoch) return;

    for (const entry of entries) {
      if (!entry.key) continue;
      this.setMemoryOnly(entry.key, entry.value);
    }
    if (this.persistence.isAvailable) {
      await this.enqueuePersistenceOp(async () => {
        if (this.clearEpoch !== epoch) return;
        await this.persistence.putMany(entries, now);
      });
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
    this.clearEpoch++;
    this.store.clear();
    if (this.persistence.isAvailable) {
      await this.enqueuePersistenceOp(async () => {
        await this.persistence.clear();
      });
    }
  }

  clear(): void {
    this.clearEpoch++;
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
