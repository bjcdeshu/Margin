import { BRAND } from './brand';
import { createDefaultMarginConfig } from './constants';
import type {
  DiagnosticSnapshot,
  MarginConfig,
  ModelCapabilityEntry,
  ModelCapabilityMap,
} from './types';

const CAPABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const memoryFallback = new Map<string, unknown>();
const memoryListeners = new Set<(config: MarginConfig) => void>();

function hasChromeStorage(): boolean {
  try {
    return (
      typeof globalThis.chrome !== 'undefined' &&
      Boolean(globalThis.chrome?.storage?.local)
    );
  } catch {
    return false;
  }
}

async function rawGet<T>(key: string): Promise<T | undefined> {
  if (hasChromeStorage()) {
    const result = await chrome.storage.local.get(key);
    return result[key] as T | undefined;
  }
  const val = memoryFallback.get(key);
  return val !== undefined ? structuredClone(val as T) : undefined;
}

async function rawSet(key: string, value: unknown): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [key]: value });
    return;
  }
  memoryFallback.set(key, structuredClone(value));
}

function clampSubtitleScale(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(50, Math.min(160, Math.round(n)));
}

function backfillStoredConfig(stored: MarginConfig): {
  config: MarginConfig;
  mutated: boolean;
} {
  let mutated = false;
  const defaults = createDefaultMarginConfig();

  if (!stored.subtitles) {
    stored.subtitles = structuredClone(defaults.subtitles);
    mutated = true;
    return { config: stored, mutated };
  }

  const sub = stored.subtitles as Partial<MarginConfig['subtitles']>;
  const legacyTransScale = clampSubtitleScale(sub.fontSizePercent, 70);
  const nextSourceScale = clampSubtitleScale(sub.sourceScalePercent, 100);
  const nextTransScale = clampSubtitleScale(
    sub.translationScalePercent,
    legacyTransScale,
  );
  const nextPreset =
    sub.stylePreset === 'youtube-native' ||
    sub.stylePreset === 'cinema-outline' ||
    sub.stylePreset === 'warm-paper'
      ? sub.stylePreset
      : 'youtube-native';

  if (
    sub.sourceScalePercent !== nextSourceScale ||
    sub.translationScalePercent !== nextTransScale ||
    sub.fontSizePercent !== nextTransScale ||
    sub.stylePreset !== nextPreset
  ) {
    stored.subtitles = {
      ...defaults.subtitles,
      ...sub,
      sourceScalePercent: nextSourceScale,
      translationScalePercent: nextTransScale,
      fontSizePercent: nextTransScale,
      stylePreset: nextPreset,
    };
    mutated = true;
  }

  return { config: stored, mutated };
}

export async function getMarginConfig(): Promise<MarginConfig> {
  const stored = await rawGet<MarginConfig>(BRAND.storageKeyConfig);
  if (!stored || stored.schemaVersion !== 2) {
    const defaults = createDefaultMarginConfig();
    await rawSet(BRAND.storageKeyConfig, defaults);
    return defaults;
  }
  const { config, mutated } = backfillStoredConfig(stored);
  if (mutated) {
    await rawSet(BRAND.storageKeyConfig, config);
  }
  return config;
}

export async function saveMarginConfig(config: MarginConfig): Promise<void> {
  await rawSet(BRAND.storageKeyConfig, config);
  if (!hasChromeStorage()) {
    for (const listener of memoryListeners) {
      listener(structuredClone(config));
    }
  }
}

export async function updateMarginConfig(
  mutator: (draft: MarginConfig) => MarginConfig | void,
): Promise<MarginConfig> {
  const current = await getMarginConfig();
  const draft = structuredClone(current);
  const next = mutator(draft) ?? draft;
  await saveMarginConfig(next);
  return next;
}

export function onMarginConfigChanged(
  listener: (config: MarginConfig) => void,
): () => void {
  if (hasChromeStorage() && chrome.storage.onChanged) {
    const handler = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName === 'local' && changes[BRAND.storageKeyConfig]?.newValue) {
        listener(changes[BRAND.storageKeyConfig].newValue as MarginConfig);
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => {
      try {
        globalThis.chrome?.storage?.onChanged?.removeListener(handler);
      } catch {
        // Ignore removal errors when extension context is invalidated
      }
    };
  }
  memoryListeners.add(listener);
  return () => {
    memoryListeners.delete(listener);
  };
}

export async function getCapabilityCache(): Promise<ModelCapabilityMap> {
  const raw = (await rawGet<ModelCapabilityMap>(BRAND.storageKeyCapabilityCache)) ?? {};
  const now = Date.now();
  const pruned: ModelCapabilityMap = {};
  for (const [k, entry] of Object.entries(raw)) {
    if (entry && now - entry.updatedAt <= CAPABILITY_TTL_MS) {
      pruned[k] = entry;
    }
  }
  return pruned;
}

export async function recordModelCapability(
  capabilityKey: string,
  entry: ModelCapabilityEntry,
): Promise<void> {
  const cache = await getCapabilityCache();
  cache[capabilityKey] = entry;
  await rawSet(BRAND.storageKeyCapabilityCache, cache);
}

export async function clearCapabilityCache(): Promise<void> {
  await rawSet(BRAND.storageKeyCapabilityCache, {});
}

export async function getDiagnosticsLog(): Promise<DiagnosticSnapshot[]> {
  return (await rawGet<DiagnosticSnapshot[]>(BRAND.storageKeyDiagnostics)) ?? [];
}

export async function appendDiagnosticSnapshot(
  snapshot: DiagnosticSnapshot,
  maxEntries = 50,
): Promise<void> {
  const existing = await getDiagnosticsLog();
  const next = [snapshot, ...existing].slice(0, maxEntries);
  await rawSet(BRAND.storageKeyDiagnostics, next);
}

export async function clearDiagnosticsLog(): Promise<void> {
  await rawSet(BRAND.storageKeyDiagnostics, []);
}

/** Test-only helper to reset in-memory storage between unit tests. */
export function resetMemoryStorageForTests(): void {
  memoryFallback.clear();
  memoryListeners.clear();
}
