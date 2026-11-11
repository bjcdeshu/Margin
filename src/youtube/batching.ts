import { resolveProviderIdForScene } from '@shared/constants';
import type {
  AssistantConfig,
  BatchItemInput,
  BatchItemOutput,
  MarginConfig,
  PageContextPayload,
  ProviderConfig,
  SubtitleCue,
  TranslateBatchRequest,
  TranslateBatchResponse,
} from '@shared/types';

export const DEFAULT_SUBTITLE_BATCH_COUNT = 17;
export const DEFAULT_SUBTITLE_MAX_CHARS = 4_096;
export const SUBTITLE_IMMEDIATE_LOOKBEHIND_MS = 2_000;
export const SUBTITLE_IMMEDIATE_LOOKAHEAD_MS = 35_000;

export const SUBTITLE_ANTI_SPILLOVER_STYLE_GUIDE =
  'Video subtitle translation mode: Keep each translation strictly inside its matching cue `id`. Never merge adjacent cues, never split a single cue, and never let trailing or leading clause words spill into neighboring cue IDs.';

export interface SubtitleBatchLimits {
  maxBatchCount: number;
  maxCharsPerBatch: number;
}

export interface IndexedSubtitleCue {
  cueIndex: number;
  cue: SubtitleCue;
}

export interface BuiltSubtitleBatchRequest {
  request: TranslateBatchRequest;
  idToCueIndex: ReadonlyMap<number, number>;
  cueIndices: number[];
}

export interface BuildSubtitleBatchParams {
  entries: readonly IndexedSubtitleCue[];
  fromLang: string;
  toLang: string;
  providerId?: string;
  pageUrl?: string;
  videoTitle?: string;
  requestId?: string;
}

export interface PlannedSubtitleBatches {
  immediateBatches: IndexedSubtitleCue[][];
  lookaheadBatches: IndexedSubtitleCue[][];
}

export interface SubtitleSchedulerConfig {
  fromLang: string;
  toLang: string;
  providerId?: string;
  preTranslate: boolean;
  maxBatchCount: number;
  maxCharsPerBatch: number;
  pageUrl?: string;
  videoTitle?: string;
}

export interface SubtitleBatchSchedulerOptions {
  translateBatch: (
    request: TranslateBatchRequest,
    signal: AbortSignal,
  ) => Promise<TranslateBatchResponse>;
  onCuesUpdated?: (updatedIndices: number[], cues: readonly SubtitleCue[]) => void;
  onBatchError?: (error: unknown, cueIndices: number[]) => void;
  maxImmediateConcurrency?: number;
}

function toPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const floored = Math.floor(numeric);
  return floored >= 1 ? floored : null;
}

/**
 * P0-2 Independent Subtitle Batch Size Resolver:
 * Resolves `assistant.maxSubtitleBatchCount ?? provider.maxSubtitleBatchCount ?? 17`
 * safely as a positive integer (`>= 1`), completely decoupled from webpage `maxBatchCount`.
 */
export function resolveSubtitleBatchLimits(params: {
  assistant?: Partial<Pick<AssistantConfig, 'maxSubtitleBatchCount' | 'maxCharsPerBatch'>> | null;
  provider?: Partial<Pick<ProviderConfig, 'maxSubtitleBatchCount' | 'maxCharsPerBatch'>> | null;
  fallbackBatchCount?: number;
  fallbackMaxChars?: number;
} = {}): SubtitleBatchLimits {
  const safeFallbackBatch =
    toPositiveInt(params.fallbackBatchCount) ?? DEFAULT_SUBTITLE_BATCH_COUNT;
  const safeFallbackChars =
    toPositiveInt(params.fallbackMaxChars) ?? DEFAULT_SUBTITLE_MAX_CHARS;

  const maxBatchCount =
    toPositiveInt(params.assistant?.maxSubtitleBatchCount) ??
    toPositiveInt(params.provider?.maxSubtitleBatchCount) ??
    safeFallbackBatch;

  const maxCharsPerBatch =
    toPositiveInt(params.assistant?.maxCharsPerBatch) ??
    toPositiveInt(params.provider?.maxCharsPerBatch) ??
    safeFallbackChars;

  return {
    maxBatchCount,
    maxCharsPerBatch,
  };
}

/**
 * Resolves effective subtitle provider ID and independent subtitle batch limits from `MarginConfig`.
 */
export function resolveSubtitleLimitsFromConfig(
  config: MarginConfig,
  explicitProviderId?: string,
): SubtitleBatchLimits & { providerId: string } {
  const providerId = resolveProviderIdForScene(
    'subtitle',
    config.routing,
    config.providers,
    explicitProviderId,
  );
  const provider = config.providers[providerId];
  const assistant = provider?.assistantId
    ? config.assistants[provider.assistantId]
    : undefined;

  const limits = resolveSubtitleBatchLimits({ assistant, provider });
  return {
    providerId,
    ...limits,
  };
}

/**
 * Partitions indexed cues into batches bounded by `maxBatchCount` and `maxCharsPerBatch`.
 */
export function partitionCuesIntoBatches(
  entries: readonly IndexedSubtitleCue[],
  limits: SubtitleBatchLimits,
): IndexedSubtitleCue[][] {
  const maxCount = toPositiveInt(limits.maxBatchCount) ?? DEFAULT_SUBTITLE_BATCH_COUNT;
  const maxChars = toPositiveInt(limits.maxCharsPerBatch) ?? DEFAULT_SUBTITLE_MAX_CHARS;

  const batches: IndexedSubtitleCue[][] = [];
  let currentBatch: IndexedSubtitleCue[] = [];
  let currentChars = 0;

  for (const entry of entries) {
    const text = entry.cue.text?.trim() ?? '';
    if (!text) continue;

    const itemChars = text.length;
    const exceedsCount = currentBatch.length >= maxCount;
    const exceedsChars = currentBatch.length > 0 && currentChars + itemChars > maxChars;

    if (exceedsCount || exceedsChars) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(entry);
    currentChars += itemChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

let subtitleReqSeq = 0;

function nextSubtitleRequestId(): string {
  subtitleReqSeq += 1;
  return `margin-sub-${Date.now()}-${subtitleReqSeq}`;
}

function safeDomainFromUrl(rawUrl?: string): string {
  if (!rawUrl) return 'youtube.com';
  try {
    return new URL(rawUrl).hostname || 'youtube.com';
  } catch {
    return 'youtube.com';
  }
}

/**
 * Builds an `id`-locked `TranslateBatchRequest` (`scene: 'subtitle'`) with anti-spillover context.
 */
export function buildSubtitleBatchRequest(
  params: BuildSubtitleBatchParams,
): BuiltSubtitleBatchRequest {
  const idToCueIndex = new Map<number, number>();
  const cueIndices: number[] = [];
  const items: BatchItemInput[] = [];

  for (let i = 0; i < params.entries.length; i += 1) {
    const entry = params.entries[i];
    const id = i + 1;
    idToCueIndex.set(id, entry.cueIndex);
    cueIndices.push(entry.cueIndex);
    items.push({
      id,
      text: entry.cue.text,
      hasRichTags: false,
    });
  }

  const pageUrl = params.pageUrl || 'https://www.youtube.com/';
  const context: PageContextPayload = {
    url: pageUrl,
    domain: safeDomainFromUrl(pageUrl),
    title: params.videoTitle,
    styleGuide: SUBTITLE_ANTI_SPILLOVER_STYLE_GUIDE,
  };

  const request: TranslateBatchRequest = {
    requestId: params.requestId ?? nextSubtitleRequestId(),
    scene: 'subtitle',
    providerId: params.providerId,
    fromLang: params.fromLang,
    toLang: params.toLang,
    items,
    context,
  };

  return {
    request,
    idToCueIndex,
    cueIndices,
  };
}

function cleanTranslatedCueText(raw: string): string {
  return String(raw ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/[\t\f\v ]+/g, ' ')
    .trim();
}

/**
 * Maps `TranslateBatchResponse.items` back to `cues` **strictly by numeric `id`**.
 * Out-of-order items map to their exact `cueIndex`; missing or unknown IDs never shift neighbors.
 */
export function applySubtitleBatchResponse(
  cues: SubtitleCue[],
  response: Pick<TranslateBatchResponse, 'ok' | 'items'> | { ok?: boolean; items: readonly BatchItemOutput[] },
  idToCueIndex: ReadonlyMap<number, number>,
): number[] {
  if (response.ok === false || !Array.isArray(response.items)) {
    return [];
  }

  const updatedIndices: number[] = [];
  const seenIds = new Set<number>();

  for (const item of response.items) {
    if (!item || typeof item.id !== 'number' || !Number.isInteger(item.id)) continue;
    if (seenIds.has(item.id)) continue;

    const targetCueIndex = idToCueIndex.get(item.id);
    if (targetCueIndex === undefined) continue;
    if (targetCueIndex < 0 || targetCueIndex >= cues.length) continue;

    const cleaned = cleanTranslatedCueText(item.trans);
    if (!cleaned) continue;

    seenIds.add(item.id);
    cues[targetCueIndex] = {
      ...cues[targetCueIndex],
      trans: cleaned,
    };
    updatedIndices.push(targetCueIndex);
  }

  return updatedIndices;
}

/**
 * Checks whether a cue overlaps the high-priority playhead window
 * `[currentTimeMs - 2000, currentTimeMs + 35000]`.
 */
export function isCueInImmediateWindow(
  cue: Pick<SubtitleCue, 'tStartMs' | 'dDurationMs'>,
  currentTimeMs: number,
  lookbehindMs: number = SUBTITLE_IMMEDIATE_LOOKBEHIND_MS,
  lookaheadMs: number = SUBTITLE_IMMEDIATE_LOOKAHEAD_MS,
): boolean {
  const safeNow = Math.max(0, Number.isFinite(currentTimeMs) ? currentTimeMs : 0);
  const windowStart = Math.max(0, safeNow - lookbehindMs);
  const windowEnd = safeNow + lookaheadMs;
  const cueEnd = cue.tStartMs + Math.max(0, cue.dDurationMs);
  return cueEnd >= windowStart && cue.tStartMs <= windowEnd;
}

/**
 * Plans immediate window batches `[currentTimeMs - 2s, currentTimeMs + 35s]` first,
 * followed (when `preTranslate: true`) by chronological lookahead batches ahead of playhead.
 */
export function planSubtitleBatches(params: {
  cues: readonly SubtitleCue[];
  currentTimeMs: number;
  preTranslate: boolean;
  limits: SubtitleBatchLimits;
  excludeCueIndices?: ReadonlySet<number>;
}): PlannedSubtitleBatches {
  const { cues, currentTimeMs, preTranslate, limits, excludeCueIndices } = params;
  const safeNow = Math.max(0, Number.isFinite(currentTimeMs) ? currentTimeMs : 0);

  const immediateEntries: IndexedSubtitleCue[] = [];
  const aheadEntries: IndexedSubtitleCue[] = [];
  const behindEntries: IndexedSubtitleCue[] = [];

  for (let cueIndex = 0; cueIndex < cues.length; cueIndex += 1) {
    if (excludeCueIndices?.has(cueIndex)) continue;
    const cue = cues[cueIndex];
    if (!cue?.text?.trim() || cue.trans) continue;

    if (isCueInImmediateWindow(cue, safeNow)) {
      immediateEntries.push({ cueIndex, cue });
    } else if (cue.tStartMs > safeNow + SUBTITLE_IMMEDIATE_LOOKAHEAD_MS) {
      aheadEntries.push({ cueIndex, cue });
    } else {
      behindEntries.push({ cueIndex, cue });
    }
  }

  const immediateBatches = partitionCuesIntoBatches(immediateEntries, limits);
  const lookaheadBatches = preTranslate
    ? [
        ...partitionCuesIntoBatches(aheadEntries, limits),
        ...partitionCuesIntoBatches(behindEntries, limits),
      ]
    : [];

  return {
    immediateBatches,
    lookaheadBatches,
  };
}

type CueDispatchStatus = 'pending' | 'inflight' | 'done' | 'failed';

/**
 * Stateful playhead-priority subtitle translation scheduler:
 * - Dispatches `[currentTimeMs - 2000, currentTimeMs + 35000]` immediately on video load or seek.
 * - Pre-translates upcoming batches sequentially (`1` in-flight lookahead at a time) when `preTranslate: true`.
 * - Immediately cancels stale in-flight requests on navigation or `cancelAll()`.
 */
export class SubtitleBatchScheduler {
  private readonly translateBatch: SubtitleBatchSchedulerOptions['translateBatch'];
  private readonly onCuesUpdated?: SubtitleBatchSchedulerOptions['onCuesUpdated'];
  private readonly onBatchError?: SubtitleBatchSchedulerOptions['onBatchError'];
  private readonly maxImmediateConcurrency: number;

  private config: SubtitleSchedulerConfig = {
    fromLang: 'auto',
    toLang: 'zh-CN',
    preTranslate: true,
    maxBatchCount: DEFAULT_SUBTITLE_BATCH_COUNT,
    maxCharsPerBatch: DEFAULT_SUBTITLE_MAX_CHARS,
  };

  private sessionId = 0;
  private videoKey = '';
  private cues: SubtitleCue[] = [];
  private statuses: CueDispatchStatus[] = [];
  private playheadMs = 0;
  private abortController: AbortController = new AbortController();
  private inflightImmediate = 0;
  private inflightLookahead = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(options: SubtitleBatchSchedulerOptions) {
    this.translateBatch = options.translateBatch;
    this.onCuesUpdated = options.onCuesUpdated;
    this.onBatchError = options.onBatchError;
    this.maxImmediateConcurrency = Math.max(1, options.maxImmediateConcurrency ?? 2);
  }

  public configure(next: Partial<SubtitleSchedulerConfig>): void {
    const prevToLang = this.config.toLang;
    const prevProviderId = this.config.providerId;
    this.config = {
      ...this.config,
      ...next,
      maxBatchCount:
        toPositiveInt(next.maxBatchCount ?? this.config.maxBatchCount) ??
        DEFAULT_SUBTITLE_BATCH_COUNT,
      maxCharsPerBatch:
        toPositiveInt(next.maxCharsPerBatch ?? this.config.maxCharsPerBatch) ??
        DEFAULT_SUBTITLE_MAX_CHARS,
    };

    // If target language or provider changed mid-video, re-translate current cues
    if (
      this.cues.length > 0 &&
      ((next.toLang && next.toLang !== prevToLang) ||
        (next.providerId !== undefined && next.providerId !== prevProviderId))
    ) {
      const stripped = this.cues.map(({ trans: _ignored, ...rest }) => ({ ...rest }));
      this.loadCues(this.videoKey, stripped, this.playheadMs);
      return;
    }

    this.pump();
  }

  public loadCues(
    videoKey: string,
    cues: readonly SubtitleCue[],
    initialTimeMs = 0,
  ): void {
    this.cancelAll();
    this.videoKey = videoKey;
    this.cues = cues.map((c) => ({ ...c }));
    this.statuses = this.cues.map((c) => (c.trans ? 'done' : 'pending'));
    this.playheadMs = Math.max(0, Number.isFinite(initialTimeMs) ? initialTimeMs : 0);
    this.pump();
  }

  public updatePlayhead(currentTimeMs: number): void {
    if (!Number.isFinite(currentTimeMs) || currentTimeMs < 0) return;
    this.playheadMs = currentTimeMs;
    // Allow previously failed cues inside the immediate playhead window to retry on explicit seek
    this.pump();
  }

  public cancelAll(): void {
    this.sessionId += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
    this.inflightImmediate = 0;
    this.inflightLookahead = 0;
    for (let i = 0; i < this.statuses.length; i += 1) {
      if (this.statuses[i] === 'inflight') {
        this.statuses[i] = this.cues[i]?.trans ? 'done' : 'pending';
      }
    }
    this.checkIdle();
  }

  public getCues(): readonly SubtitleCue[] {
    return this.cues;
  }

  public getVideoKey(): string {
    return this.videoKey;
  }

  public isIdle(): boolean {
    return this.inflightImmediate === 0 && this.inflightLookahead === 0;
  }

  public waitForIdle(): Promise<void> {
    this.pump();
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private checkIdle(): void {
    if (!this.isIdle()) return;
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private buildExcludedSet(): Set<number> {
    const excluded = new Set<number>();
    for (let i = 0; i < this.statuses.length; i += 1) {
      const st = this.statuses[i];
      if (st === 'inflight' || st === 'done' || st === 'failed') {
        excluded.add(i);
      }
    }
    return excluded;
  }

  private pump(): void {
    if (this.cues.length === 0) {
      this.checkIdle();
      return;
    }

    const limits: SubtitleBatchLimits = {
      maxBatchCount: this.config.maxBatchCount,
      maxCharsPerBatch: this.config.maxCharsPerBatch,
    };

    // 1. Dispatch immediate playhead window batches at highest priority
    while (this.inflightImmediate < this.maxImmediateConcurrency) {
      const excluded = this.buildExcludedSet();
      const plan = planSubtitleBatches({
        cues: this.cues,
        currentTimeMs: this.playheadMs,
        preTranslate: false,
        limits,
        excludeCueIndices: excluded,
      });
      const nextImmediate = plan.immediateBatches[0];
      if (!nextImmediate || nextImmediate.length === 0) break;
      this.dispatchBatch(nextImmediate, 'immediate');
    }

    // 2. Only when immediate batches are clear, sequentially pre-translate 1 lookahead batch at a time
    if (
      this.config.preTranslate &&
      this.inflightImmediate === 0 &&
      this.inflightLookahead === 0
    ) {
      const excluded = this.buildExcludedSet();
      const plan = planSubtitleBatches({
        cues: this.cues,
        currentTimeMs: this.playheadMs,
        preTranslate: true,
        limits,
        excludeCueIndices: excluded,
      });
      const nextLookahead =
        plan.immediateBatches[0] ?? plan.lookaheadBatches[0];
      if (nextLookahead && nextLookahead.length > 0) {
        this.dispatchBatch(nextLookahead, 'lookahead');
      }
    }

    this.checkIdle();
  }

  private dispatchBatch(
    entries: IndexedSubtitleCue[],
    priority: 'immediate' | 'lookahead',
  ): void {
    const activeSession = this.sessionId;
    const signal = this.abortController.signal;

    const built = buildSubtitleBatchRequest({
      entries,
      fromLang: this.config.fromLang,
      toLang: this.config.toLang,
      providerId: this.config.providerId,
      pageUrl: this.config.pageUrl,
      videoTitle: this.config.videoTitle,
    });

    for (const idx of built.cueIndices) {
      this.statuses[idx] = 'inflight';
    }

    if (priority === 'immediate') {
      this.inflightImmediate += 1;
    } else {
      this.inflightLookahead += 1;
    }

    void this.translateBatch(built.request, signal)
      .then((response) => {
        if (activeSession !== this.sessionId || signal.aborted) return;

        const updated = applySubtitleBatchResponse(
          this.cues,
          response,
          built.idToCueIndex,
        );
        const updatedSet = new Set(updated);

        for (const idx of built.cueIndices) {
          if (updatedSet.has(idx) || this.cues[idx]?.trans) {
            this.statuses[idx] = 'done';
          } else {
            // Prevent infinite spin on permanently empty/rejected cue slots
            this.statuses[idx] = 'failed';
          }
        }

        if (!response.ok) {
          this.onBatchError?.(
            response.error ?? new Error('Subtitle batch failed'),
            built.cueIndices,
          );
        } else if (updated.length > 0) {
          this.onCuesUpdated?.(updated, this.cues);
        }
      })
      .catch((err: unknown) => {
        if (activeSession !== this.sessionId || signal.aborted) return;
        for (const idx of built.cueIndices) {
          this.statuses[idx] = 'failed';
        }
        this.onBatchError?.(err, built.cueIndices);
      })
      .finally(() => {
        if (activeSession !== this.sessionId) return;
        if (priority === 'immediate') {
          this.inflightImmediate = Math.max(0, this.inflightImmediate - 1);
        } else {
          this.inflightLookahead = Math.max(0, this.inflightLookahead - 1);
        }
        this.pump();
      });
  }
}
