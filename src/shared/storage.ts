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
  return (
    typeof globalThis.chrome !== 'undefined' &&
    Boolean(globalThis.chrome?.storage?.local)
  );
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

export async function getMarginConfig(): Promise<MarginConfig> {
  const stored = await rawGet<MarginConfig>(BRAND.storageKeyConfig);
  if (!stored || stored.schemaVersion !== 2) {
    const defaults = createDefaultMarginConfig();
    await rawSet(BRAND.storageKeyConfig, defaults);
    return defaults;
  }
  return stored;
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
    return () => chrome.storage.onChanged.removeListener(handler);
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
