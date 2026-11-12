import { BRAND } from './brand';
import {
  BUILTIN_ASSISTANTS,
  cloneAssistantConfig,
  cloneBuiltinAssistants,
  createDefaultMarginConfig,
} from './constants';
import type {
  AssistantConfig,
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

function clonePlainValue<T>(val: T): T {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => clonePlainValue(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    out[k] = clonePlainValue(v);
  }
  return out as T;
}

async function rawGet<T>(key: string): Promise<T | undefined> {
  if (hasChromeStorage()) {
    const result = await chrome.storage.local.get(key);
    return result[key] as T | undefined;
  }
  const val = memoryFallback.get(key);
  return val !== undefined ? clonePlainValue(val as T) : undefined;
}

async function rawSet(key: string, value: unknown): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [key]: value });
    return;
  }
  memoryFallback.set(key, clonePlainValue(value));
}

function clampSubtitleScale(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(50, Math.min(160, Math.round(n)));
}

function backfillScenePromptsOnAssistant(ast: AssistantConfig): boolean {
  let changed = false;
  let donor: Pick<
    AssistantConfig,
    'inputPrompt' | 'selectionPrompt' | 'subtitlePrompt'
  >;

  if (ast.codec === 'delimiter') {
    donor = BUILTIN_ASSISTANTS['builtin-delimiter'];
  } else if (ast.codec === 'yaml') {
    donor =
      ast.id === 'builtin-yaml-thinking'
        ? BUILTIN_ASSISTANTS['builtin-yaml-thinking']
        : BUILTIN_ASSISTANTS['builtin-yaml'];
  } else if (ast.codec === 'json-batch') {
    donor = {
      inputPrompt:
        '{{glossary_prompt}}Rewrite and translate into concise, idiomatic, native-speaker {{to}} ready to send or post. Respond ONLY with JSON `[{"id":1,"trans":"..."}]`:\n{{json}}',
      selectionPrompt:
        '{{title_prompt}}{{glossary_prompt}}Translate the selected passage into crisp, natural {{to}}. Respond ONLY with JSON `[{"id":1,"trans":"..."}]`:\n{{json}}',
      subtitlePrompt:
        '{{title_prompt}}{{glossary_prompt}}Translate each subtitle cue into natural spoken {{to}} keeping exact cue `id` alignment. Respond ONLY with JSON `[{"id":1,"trans":"..."}]`:\n{{json}}',
    };
  } else {
    donor = {
      inputPrompt: '{{text}}',
      selectionPrompt: '{{text}}',
      subtitlePrompt: '{{text}}',
    };
  }

  if (!ast.inputPrompt?.trim() && donor.inputPrompt) {
    ast.inputPrompt = donor.inputPrompt;
    changed = true;
  }
  if (!ast.selectionPrompt?.trim() && donor.selectionPrompt) {
    ast.selectionPrompt = donor.selectionPrompt;
    changed = true;
  }
  if (!ast.subtitlePrompt?.trim() && donor.subtitlePrompt) {
    ast.subtitlePrompt = donor.subtitlePrompt;
    changed = true;
  }

  return changed;
}

export function backfillStoredConfig(stored: MarginConfig): {
  config: MarginConfig;
  mutated: boolean;
} {
  let mutated = false;
  const defaults = createDefaultMarginConfig();

  // 1. Subtitle scales & preset backfill
  if (!stored.subtitles) {
    stored.subtitles = structuredClone(defaults.subtitles);
    mutated = true;
  } else {
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
  }

  // 2. Webpage auto-translate mode & language list backfill (v2.2.0 default: `'foreign'`)
  if (!stored.webpage) {
    stored.webpage = structuredClone(defaults.webpage);
    mutated = true;
  } else {
    const wp = stored.webpage as Partial<MarginConfig['webpage']>;
    const hasValidMode =
      wp.autoTranslateMode === 'off' ||
      wp.autoTranslateMode === 'whitelist' ||
      wp.autoTranslateMode === 'foreign';
    if (!hasValidMode) {
      stored.webpage.autoTranslateMode = 'foreign';
      stored.webpage.autoTranslateMatches = true;
      stored.webpage.autoTranslateLanguages ??= [];
      mutated = true;
    } else if (!Array.isArray(stored.webpage.autoTranslateLanguages)) {
      stored.webpage.autoTranslateLanguages = [];
      mutated = true;
    }
  }

  // 3. Enabled built-in glossary packs backfill
  if (!Array.isArray(stored.enabledGlossaryPacks)) {
    stored.enabledGlossaryPacks = [...(defaults.enabledGlossaryPacks ?? [])];
    mutated = true;
  }

  // 4. Ensure `assistants` map & `builtin-yaml-thinking` preset exist
  if (!stored.assistants || typeof stored.assistants !== 'object') {
    stored.assistants = cloneBuiltinAssistants();
    mutated = true;
  } else if (!stored.assistants['builtin-yaml-thinking']) {
    stored.assistants['builtin-yaml-thinking'] = cloneAssistantConfig(
      BUILTIN_ASSISTANTS['builtin-yaml-thinking'],
    );
    mutated = true;
  }

  // 5. Prompt System v2 Editorial Upgrade & stock Aloxaf `custom` channel migration
  if ((stored.promptSystemVersion ?? 1) < 2) {
    const customAst = stored.assistants['custom'];
    const customPromptBody = customAst
      ? `${customAst.multiplePrompt ?? customAst.prompt ?? ''}\n${customAst.systemPrompt ?? ''}\n${customAst.multipleSystemPrompt ?? ''}`
      : '';
    const isStockAloxafCustom = Boolean(
      customAst &&
        customAst.name?.includes('泛用翻译大师') &&
        ((customAst.multiplePrompt ?? customAst.prompt ?? '').includes('thinking:') ||
          /\bthinking\s*:|\bthinking\b[\s\S]*?\btrans\b/i.test(customPromptBody)),
    );

    stored.assistants['builtin-yaml'] = cloneAssistantConfig(
      BUILTIN_ASSISTANTS['builtin-yaml'],
    );
    stored.assistants['builtin-yaml-thinking'] = cloneAssistantConfig(
      BUILTIN_ASSISTANTS['builtin-yaml-thinking'],
    );
    stored.assistants['builtin-delimiter'] = cloneAssistantConfig(
      BUILTIN_ASSISTANTS['builtin-delimiter'],
    );

    for (const ast of Object.values(stored.assistants)) {
      if (ast && typeof ast === 'object') {
        backfillScenePromptsOnAssistant(ast);
      }
    }

    if (isStockAloxafCustom && stored.providers) {
      for (const prov of Object.values(stored.providers)) {
        if (prov && prov.assistantId === 'custom') {
          prov.assistantId = 'builtin-yaml';
        }
      }
    }

    stored.promptSystemVersion = 2;
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
      listener(clonePlainValue(config));
    }
  }
}

export async function updateMarginConfig(
  mutator: (draft: MarginConfig) => MarginConfig | void,
): Promise<MarginConfig> {
  const current = await getMarginConfig();
  const draft = clonePlainValue(current);
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

function pinHappyDomMutationObserverCallbacksForTests(): void {
  const win = (globalThis as unknown as { window?: Record<string, unknown> })
    .window;
  if (!win || !('happyDOM' in win) || typeof MutationObserver === 'undefined') {
    return;
  }
  const proto = MutationObserver.prototype as unknown as {
    observe: (target: Node, options?: MutationObserverInit) => void;
    __marginWeakRefPinned?: boolean;
  };
  if (proto.__marginWeakRefPinned) return;
  const origObserve = proto.observe;
  proto.observe = function patchedObserve(
    this: MutationObserver,
    target: Node,
    options?: MutationObserverInit,
  ) {
    origObserve.call(this, target, options);
    if (target && typeof target === 'object') {
      const mlSym = Object.getOwnPropertySymbols(target).find(
        (s) => s.description === 'mutationListeners',
      );
      const list = mlSym
        ? (target as unknown as Record<symbol, unknown>)[mlSym]
        : undefined;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item === 'object') {
            const rec = item as {
              callback?: WeakRef<(...args: unknown[]) => void>;
              __strongCallback?: (...args: unknown[]) => void;
            };
            if (rec.callback instanceof WeakRef && !rec.__strongCallback) {
              rec.__strongCallback = rec.callback.deref();
            }
          }
        }
      }
    }
  };
  proto.__marginWeakRefPinned = true;
}

/** Test-only helper to reset in-memory storage between unit tests. */
export function resetMemoryStorageForTests(): void {
  memoryFallback.clear();
  memoryListeners.clear();
  pinHappyDomMutationObserverCallbacksForTests();
}
