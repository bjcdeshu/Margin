import type { MarginConfig } from '@shared/types';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface SaveTrackerState {
  status: SaveStatus;
  savedAt: number | null;
  errorMessage?: string;
}

export type SaveTrackerListener = (state: SaveTrackerState) => void;

function trimDedupeStrings(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const item = String(raw ?? '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function stableCloneValue(val: unknown): unknown {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(stableCloneValue);
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const v = obj[key];
    if (v !== undefined) {
      out[key] = stableCloneValue(v);
    }
  }
  return out;
}

/**
 * Normalizes user-editable lists (URL exclusion/inclusion globs, API key pools,
 * glossary keys) using the same trim/dedupe semantics applied on save so that
 * persisted host snapshots compare deterministically.
 */
export function normalizeConfigForSave(config: MarginConfig): MarginConfig {
  const next = structuredClone(config);

  next.urlRules.includeMatches = trimDedupeStrings(next.urlRules.includeMatches);
  next.urlRules.excludeMatches = trimDedupeStrings(next.urlRules.excludeMatches);

  next.webpage.themePatterns = next.webpage.themePatterns
    .map((rule) => ({
      pattern: String(rule.pattern ?? '').trim(),
      theme: rule.theme,
    }))
    .filter((rule) => rule.pattern.length > 0);

  next.glossary = next.glossary
    .map((entry) => ({
      k: String(entry.k ?? '').trim(),
      v: String(entry.v ?? ''),
      ...(entry.domain?.trim() ? { domain: entry.domain.trim() } : {}),
      ...(entry.caseSensitive ? { caseSensitive: true } : {}),
    }))
    .filter((entry) => entry.k.length > 0);

  for (const provider of Object.values(next.providers)) {
    provider.name = String(provider.name ?? '').trim() || provider.id;
    provider.baseUrl = String(provider.baseUrl ?? '').trim();
    provider.model = String(provider.model ?? '').trim();
    provider.apiKeys = trimDedupeStrings(provider.apiKeys);
    provider.models = trimDedupeStrings(provider.models);
    if (provider.endpoints) {
      provider.endpoints = trimDedupeStrings(provider.endpoints);
    }
    if (provider.assistantId !== undefined && !provider.assistantId.trim()) {
      delete provider.assistantId;
    }
  }

  const clampSubScale = (value: unknown, fallback: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(50, Math.min(160, Math.round(n)));
  };
  next.subtitles.sourceScalePercent = clampSubScale(
    next.subtitles.sourceScalePercent,
    100,
  );
  next.subtitles.translationScalePercent = clampSubScale(
    next.subtitles.translationScalePercent ?? next.subtitles.fontSizePercent,
    70,
  );
  next.subtitles.fontSizePercent = next.subtitles.translationScalePercent;
  if (
    next.subtitles.stylePreset !== 'youtube-native' &&
    next.subtitles.stylePreset !== 'cinema-outline' &&
    next.subtitles.stylePreset !== 'warm-paper'
  ) {
    next.subtitles.stylePreset = 'youtube-native';
  }

  return next;
}

export function canonicalizeConfigSnapshot(config: MarginConfig): string {
  const normalized = normalizeConfigForSave(config);
  return JSON.stringify(stableCloneValue(normalized));
}

/**
 * Snapshot-Verified Save State Tracker (`DESIGN_REDESIGN_20261104.md` invariant):
 *
 * 1. Initial read-only hydration (`hydrateReadOnly`) NEVER shows `'saved'`.
 * 2. External/background `onMarginConfigChanged` sync without a matching pending
 *    user save NEVER flashes `'saved'`.
 * 3. While `'saving'`, an unrelated/stale readback (`snapshot !== pendingSnapshot`)
 *    does NOT confirm early or unlock concurrent saves.
 * 4. `'saved'` is emitted ONLY when a user-initiated write snapshot matches the
 *    persisted config snapshot.
 * 5. Errors (`failSave`) and page teardown (`dispose`) release `pendingSnapshot`.
 */
export class SaveTracker {
  private state: SaveTrackerState = { status: 'idle', savedAt: null };
  private pendingSnapshot: string | null = null;
  private baselineSnapshot: string | null = null;
  private readonly listeners = new Set<SaveTrackerListener>();

  getState(): SaveTrackerState {
    return { ...this.state };
  }

  isSaving(): boolean {
    return this.pendingSnapshot !== null && this.state.status === 'saving';
  }

  getBaselineSnapshot(): string | null {
    return this.baselineSnapshot;
  }

  isDirty(candidate: MarginConfig): boolean {
    if (this.baselineSnapshot === null) return false;
    return canonicalizeConfigSnapshot(candidate) !== this.baselineSnapshot;
  }

  subscribe(listener: SaveTrackerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Records initial load or read-only refresh baseline.
   * Never transitions into `'saved'`.
   */
  hydrateReadOnly(config: MarginConfig): void {
    const snap = canonicalizeConfigSnapshot(config);
    this.baselineSnapshot = snap;

    // If a save is currently in flight, check whether this read matches it;
    // otherwise keep waiting without unlocking or showing Saved prematurely.
    if (this.pendingSnapshot !== null) {
      if (snap === this.pendingSnapshot) {
        this.pendingSnapshot = null;
        this.setState({ status: 'saved', savedAt: Date.now() });
      }
      return;
    }

    if (this.state.status !== 'idle') {
      this.setState({ status: 'idle', savedAt: this.state.savedAt });
    }
  }

  /**
   * Starts or supersedes a user-initiated save transaction for `targetConfig`.
   * Always returns the normalized config to persist and updates `pendingSnapshot`
   * to the latest write so rapid consecutive edits coalesce without ever dropping
   * user saves or confirming stale earlier readbacks prematurely.
   */
  beginUserSave(targetConfig: MarginConfig): MarginConfig {
    const normalized = normalizeConfigForSave(targetConfig);
    this.pendingSnapshot = JSON.stringify(stableCloneValue(normalized));
    this.setState({ status: 'saving', savedAt: this.state.savedAt });
    return normalized;
  }

  /**
   * Observes a config snapshot returned from storage or `onMarginConfigChanged`.
   * Transitions to `'saved'` if and only if an active user save matches `persistedConfig`.
   */
  observePersisted(persistedConfig: MarginConfig): boolean {
    const incomingSnap = canonicalizeConfigSnapshot(persistedConfig);

    if (this.pendingSnapshot !== null) {
      if (incomingSnap === this.pendingSnapshot) {
        this.pendingSnapshot = null;
        this.baselineSnapshot = incomingSnap;
        this.setState({ status: 'saved', savedAt: Date.now() });
        return true;
      }
      // Unrelated GET or stale event while saving: ignore without confirming or unlocking.
      return false;
    }

    // Background / external sync when no user save was initiated:
    // update baseline quietly and NEVER transition idle -> saved.
    // Only reset an already-confirmed 'saved' state if external storage actually changed.
    const changedFromBaseline = incomingSnap !== this.baselineSnapshot;
    this.baselineSnapshot = incomingSnap;
    if (changedFromBaseline && this.state.status === 'saved') {
      this.setState({ status: 'idle', savedAt: this.state.savedAt });
    }
    return false;
  }

  /**
   * Releases in-flight snapshot when a save fails.
   */
  failSave(message: string): void {
    this.pendingSnapshot = null;
    this.setState({
      status: 'error',
      savedAt: this.state.savedAt,
      errorMessage: message,
    });
  }

  /**
   * Releases snapshot and listeners on component/window teardown.
   */
  dispose(): void {
    this.pendingSnapshot = null;
    this.state = { status: 'idle', savedAt: null };
    this.listeners.clear();
  }

  private setState(next: SaveTrackerState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener({ ...this.state });
    }
  }
}

export function createSaveTracker(): SaveTracker {
  return new SaveTracker();
}
