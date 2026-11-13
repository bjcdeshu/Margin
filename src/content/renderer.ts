import { resolveProviderIdForScene } from '@shared/constants';
import {
  isEditorialSerifFontFamily,
  normalizeTargetBcp47Lang,
  resolveTargetFontFamilyCss,
  resolveTargetTextDir,
} from '@shared/locale-typography';
import {
  requestBatchTranslation,
  streamBatchTranslation,
  type StreamBatchCallbacks,
} from '@shared/messaging';
import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import type {
  BatchItemOutput,
  DisplayMode,
  GlossaryEntry,
  MarginConfig,
  PageContextPayload,
  RequestPriority,
  TabPageState,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslationScene,
  TranslationTheme,
} from '@shared/types';
import { resolveThemeForUrl } from '@shared/url-match';
import {
  extractFocalThreadContext,
  extractPageContext,
  extractParagraphBlocks,
  findClosestParagraphBlock,
  findFirstDirectBlockBoundaryChild,
  inferDomainStyleGuide,
} from './dom-walker';
import {
  reconstructRichDom,
  stripResidualMarkers,
  tokenizeParagraph,
  type TokenizedParagraph,
} from './rich-text';

export const DEFAULT_LRU_CAPACITY = 2000;
export const VIEWPORT_ROOT_MARGIN = '300px 0px 2200px 0px';
export const SPA_MUTATION_DEBOUNCE_MS = 24;
export const HERO_WAVE_MAX_BLOCKS = 2;
export const HERO_WAVE_MAX_CHARS = 480;
export const SCROLL_EVICTION_THROTTLE_MS = 120;

const STYLE_ELEMENT_ID = 'margin-webpage-styles';

const INLINE_SHORT_CELL_TAGS: ReadonlySet<string> = new Set([
  'TH',
  'TD',
  'DT',
  'SUMMARY',
]);

export const WEBPAGE_INJECTED_CSS = /* css */ `
.margin-orig-source[data-margin-orig-wrap="true"] {
  display: none !important;
}

.margin-trans-root[data-margin-injected="true"],
.margin-trans-block[data-margin-injected="true"] {
  font-size: inherit;
  font-weight: inherit;
  font-style: inherit;
  font-stretch: inherit;
  font-variant: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  color: inherit;
  word-break: break-word;
}

.margin-trans-root[data-margin-injected="true"][dir="ltr"] {
  direction: ltr;
  unicode-bidi: isolate;
}

.margin-trans-root[data-margin-injected="true"][dir="rtl"] {
  direction: rtl;
  unicode-bidi: isolate;
}

.margin-trans-root[data-margin-injected="true"][data-margin-has-target-font="true"],
.margin-trans-root[data-margin-injected="true"][data-margin-has-target-font="true"] :where(span, a, strong, b, em, i, u, s, mark, small, sub, sup, abbr, cite, q, time, del, ins, dfn, bdi, bdo):not(.katex):not(.katex *):not(code *):not(kbd *):not(samp *):not(var *):not(math *):not(mjx-container *) {
  font-family: var(--margin-target-font-family) !important;
}

.margin-trans-root[data-margin-layout="inline"] {
  display: inline;
  margin-inline-start: 0.48em;
}

.margin-trans-root[data-margin-layout="block"] {
  display: block !important;
  margin-top: 0.5em;
  margin-bottom: 0.18em;
  white-space: pre-line;
}

.margin-trans-root[data-margin-layout="replace"] {
  display: inline;
  white-space: pre-line;
}

.margin-trans-root[data-margin-injected="true"] a {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: rgba(140, 90, 33, 0.48);
  text-underline-offset: 2px;
}

.margin-trans-root[data-margin-injected="true"] a:hover {
  text-decoration-color: currentColor;
}

/* Quiet proportional warm-paper breathing shimmer bar */
.margin-trans-loading[data-margin-injected="true"] {
  display: flex !important;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-top: 0.48em;
  margin-bottom: 0.2em;
  user-select: none;
  pointer-events: none;
}

.margin-trans-loading[data-margin-injected="true"][data-margin-layout="inline"] {
  display: inline-flex !important;
  flex-direction: row;
  align-items: center;
  vertical-align: middle;
  margin-top: 0;
  margin-bottom: 0;
  margin-inline-start: 0.48em;
}

.margin-shimmer-line {
  display: block;
  height: 0.9em;
  min-height: 11px;
  max-height: 16px;
  border-radius: 5px;
  background-color: color-mix(in srgb, currentColor 8%, transparent);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(185, 131, 61, 0.16) 50%,
    transparent 100%
  );
  background-size: 220% 100%;
  background-position: 120% 0;
  animation: margin-shimmer-sweep 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

.margin-trans-loading[data-margin-layout="inline"] .margin-shimmer-line {
  display: inline-block;
  width: 3.6em !important;
  height: 0.84em;
  min-height: 10px;
}

@keyframes margin-shimmer-sweep {
  0% {
    background-position: 120% 0;
  }
  100% {
    background-position: -120% 0;
  }
}

/* Theme: mask (Quiet Paper smooth blur reveal) */
.margin-trans-root[data-margin-theme="mask"] {
  filter: blur(5px);
  transition: filter 220ms cubic-bezier(0.2, 0.72, 0.2, 1);
  border-radius: 3px;
  cursor: pointer;
}

.margin-trans-root[data-margin-theme="mask"]:hover,
.margin-trans-root[data-margin-theme="mask"]:focus-within,
.margin-trans-root[data-margin-theme="mask"][data-margin-item-unmasked="true"],
html[data-margin-mask-revealed="true"] .margin-trans-root[data-margin-theme="mask"] {
  filter: none !important;
}

/* Theme: opacity */
.margin-trans-root[data-margin-theme="opacity"] {
  opacity: 0.62;
  transition: opacity 160ms cubic-bezier(0.2, 0.72, 0.2, 1);
}

.margin-trans-root[data-margin-theme="opacity"]:hover,
.margin-trans-root[data-margin-theme="opacity"]:focus-within {
  opacity: 1;
}

/* Theme: weakening */
.margin-trans-root[data-margin-theme="weakening"] {
  opacity: 0.76;
  color: color-mix(in srgb, currentColor 74%, #8d877a 26%);
  transition:
    opacity 160ms cubic-bezier(0.2, 0.72, 0.2, 1),
    color 160ms cubic-bezier(0.2, 0.72, 0.2, 1);
}

.margin-trans-root[data-margin-theme="weakening"]:hover,
.margin-trans-root[data-margin-theme="weakening"]:focus-within {
  opacity: 1;
  color: inherit;
}

/* Quiet inline retry button on failed batch items */
.margin-inline-retry[data-margin-injected="true"] {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-inline-start: 6px;
  padding: 1px 6px;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 12px;
  line-height: 1.35;
  color: #8c5a21;
  background: #fbfaf6;
  border: 1px solid rgba(140, 90, 33, 0.36);
  border-radius: 4px;
  cursor: pointer;
  vertical-align: baseline;
  user-select: none;
  transition: background-color 160ms cubic-bezier(0.2, 0.72, 0.2, 1);
}

.margin-inline-retry[data-margin-injected="true"]:hover {
  background: rgba(140, 90, 33, 0.09);
  color: #6f4417;
}

.margin-inline-retry[data-margin-injected="true"]:focus-visible {
  outline: 2px solid #8c5a21;
  outline-offset: 1px;
}

[data-margin-floating="true"][data-margin-fullscreen-hidden="true"] {
  display: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .margin-trans-root[data-margin-injected="true"],
  .margin-inline-retry[data-margin-injected="true"] {
    transition: none !important;
  }
  .margin-shimmer-line {
    animation: none !important;
    background-image: none !important;
  }
}
`;

const PAGE_STATUS_PILL_CSS = /* css */ `
${SHADOW_HOST_RESET_CSS}

.status-pill,
.margin-status-pill {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483644;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
  padding: 6px 12px;
  background: rgba(251, 250, 246, 0.94);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #1c1914;
  border: 1px solid rgba(28, 25, 20, 0.08);
  border-radius: 999px;
  box-shadow:
    0 6px 20px rgba(28, 25, 20, 0.08),
    0 1px 2px rgba(28, 25, 20, 0.04);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  pointer-events: auto;
  user-select: none;
  transition:
    opacity 180ms cubic-bezier(0.2, 0.72, 0.2, 1),
    padding 180ms cubic-bezier(0.2, 0.72, 0.2, 1),
    border-color 180ms cubic-bezier(0.2, 0.72, 0.2, 1);
}

:host([data-display-mode="night"]) .status-pill {
  background: rgba(23, 21, 18, 0.94);
  color: #ede8df;
  border-color: rgba(244, 239, 228, 0.10);
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.42),
    0 1px 2px rgba(0, 0, 0, 0.24);
}

.status-pill[hidden] {
  display: none !important;
}

.status-pill[data-quiet="true"] {
  padding: 4px 10px;
  opacity: 0.78;
}

.status-pill[data-quiet="true"]:hover {
  opacity: 1;
}

.status-pill[data-tone="error"] {
  border-color: rgba(188, 76, 62, 0.42);
  opacity: 1;
}

.spinner {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #8c5a21;
  box-shadow: 0 0 0 3px rgba(140, 90, 33, 0.16);
  animation: status-pulse 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  flex-shrink: 0;
}

:host([data-display-mode="night"]) .spinner {
  background: #c99455;
  box-shadow: 0 0 0 3px rgba(201, 148, 85, 0.2);
}

.spinner[hidden] {
  display: none !important;
}

@keyframes status-pulse {
  0%, 100% {
    opacity: 0.95;
    transform: scale(1);
  }
  50% {
    opacity: 0.45;
    transform: scale(0.84);
  }
}

.label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

.hint {
  color: var(--muted);
  font-size: 11px;
  flex-shrink: 0;
}

.hint[hidden] {
  display: none !important;
}

.action-btn {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  padding: 2px 8px;
  border-radius: 999px;
  color: #8c5a21;
  border: 1px solid rgba(28, 25, 20, 0.09);
  background: rgba(140, 90, 33, 0.07);
  flex-shrink: 0;
  transition: background-color 150ms ease, border-color 150ms ease;
}

:host([data-display-mode="night"]) .action-btn {
  color: #c99455;
  border-color: rgba(244, 239, 228, 0.11);
  background: rgba(201, 148, 85, 0.11);
}

.action-btn:hover {
  background: rgba(140, 90, 33, 0.14);
  border-color: rgba(140, 90, 33, 0.28);
}

:host([data-display-mode="night"]) .action-btn:hover {
  background: rgba(201, 148, 85, 0.2);
  border-color: rgba(201, 148, 85, 0.34);
}

.action-btn[hidden] {
  display: none !important;
}

.close-btn {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  font-size: 13px;
  line-height: 16px;
  padding: 0 4px;
  color: var(--muted);
  flex-shrink: 0;
}

.close-btn:hover {
  color: var(--ink);
}

.close-btn[hidden] {
  display: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .status-pill,
  .action-btn {
    transition: none !important;
  }
  .spinner {
    animation: none !important;
  }
}
`;

export interface CachedTranslationEntry {
  trans: string;
  fallbackPlain?: boolean;
}

/**
 * O(1) 2000-entry in-memory LRU cache so virtual-scroll feeds (Discourse, X, Reddit)
 * re-attach translations instantaneously without re-calling upstream APIs.
 */
export class LruTranslationCache {
  private readonly store = new Map<string, CachedTranslationEntry>();
  private readonly capacity: number;

  constructor(capacity = DEFAULT_LRU_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  get size(): number {
    return this.store.size;
  }

  get(key: string): CachedTranslationEntry | undefined {
    const existing = this.store.get(key);
    if (!existing) return undefined;
    // Refresh recency order
    this.store.delete(key);
    this.store.set(key, existing);
    return existing;
  }

  set(key: string, value: CachedTranslationEntry): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.capacity) {
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
}

export interface BatchPackableItem {
  charCount: number;
}

export function packIntoBatches<T extends BatchPackableItem>(
  items: readonly T[],
  maxBatchCount: number,
  maxCharsPerBatch: number,
): T[][] {
  const safeMaxCount = Math.max(1, Math.floor(maxBatchCount || 17));
  const safeMaxChars = Math.max(64, Math.floor(maxCharsPerBatch || 4096));

  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = Math.max(1, item.charCount);
    const wouldOverflowCount = current.length >= safeMaxCount;
    const wouldOverflowChars =
      current.length > 0 && currentChars + itemChars > safeMaxChars;

    if (wouldOverflowCount || wouldOverflowChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(item);
    currentChars += itemChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/**
 * Packs first-viewport items using progressive wave sizing (`[3/800, 5/1600, 10/max]`)
 * for AI/LLM channels so top-of-screen paragraphs paint 4x-6x faster while saturating
 * `maxConcurrency: 4` parallel streams.
 */
export function packIntoProgressiveBatches<T extends BatchPackableItem>(
  items: readonly T[],
  maxBatchCount: number,
  maxCharsPerBatch: number,
  useProgressiveWaves = true,
): T[][] {
  if (!useProgressiveWaves) {
    return packIntoBatches(items, maxBatchCount, maxCharsPerBatch);
  }

  const globalMaxCount = Math.max(1, Math.floor(maxBatchCount || 17));
  const globalMaxChars = Math.max(64, Math.floor(maxCharsPerBatch || 4096));

  const limitsForBatchIndex = (
    batchIdx: number,
  ): { count: number; chars: number } => {
    if (batchIdx === 0) {
      return {
        count: Math.min(3, globalMaxCount),
        chars: Math.min(800, globalMaxChars),
      };
    }
    if (batchIdx === 1) {
      return {
        count: Math.min(5, globalMaxCount),
        chars: Math.min(1600, globalMaxChars),
      };
    }
    return {
      count: Math.min(10, globalMaxCount),
      chars: globalMaxChars,
    };
  };

  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;
  let activeLimits = limitsForBatchIndex(0);

  for (const item of items) {
    const itemChars = Math.max(1, item.charCount);
    const wouldOverflowCount = current.length >= activeLimits.count;
    const wouldOverflowChars =
      current.length > 0 && currentChars + itemChars > activeLimits.chars;

    if (wouldOverflowCount || wouldOverflowChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
      activeLimits = limitsForBatchIndex(batches.length);
    }

    current.push(item);
    currentChars += itemChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

export function isDocumentFullscreen(doc: Document = document): boolean {
  const anyDoc = doc as Document & { webkitFullscreenElement?: Element | null };
  return Boolean(doc.fullscreenElement || anyDoc.webkitFullscreenElement);
}

/**
 * Hides or restores floating Shadow hosts (`[data-margin-floating="true"]`) when HTML5
 * fullscreen video/slideshows activate so popovers never obstruct fullscreen playback.
 */
export function syncFullscreenFloatingVisibility(doc: Document = document): void {
  const hidden = isDocumentFullscreen(doc);
  const hosts = doc.querySelectorAll<HTMLElement>('[data-margin-floating="true"]');
  for (let i = 0; i < hosts.length; i++) {
    if (hidden) {
      hosts[i].setAttribute('data-margin-fullscreen-hidden', 'true');
    } else {
      hosts[i].removeAttribute('data-margin-fullscreen-hidden');
    }
  }
}

export type BatchTransportFn = (
  payload: TranslateBatchRequest,
  callbacks: StreamBatchCallbacks,
  signal: AbortSignal,
  preferStream: boolean,
) => Promise<TranslateBatchResponse>;

export interface WebpageRendererOptions {
  config: MarginConfig;
  doc?: Document;
  getUrl?: () => string;
  cache?: LruTranslationCache;
  transport?: BatchTransportFn;
  flushDelayMs?: number;
  onManualStop?: () => void;
}

interface PreparedBlockTask {
  block: HTMLElement;
  tokenized: TokenizedParagraph;
  cacheKey: string;
  charCount: number;
  scene: TranslationScene;
}

interface MountedBlockMeta {
  plainTextLength: number;
  fallbackPlain: boolean;
  sourceText: string;
  translatedText: string;
}

const UNCLAMP_TRACKED_PROPS = [
  '-webkit-line-clamp',
  'line-clamp',
  '-webkit-box-orient',
  'max-height',
  'height',
  'overflow',
  'overflow-x',
  'overflow-y',
  'text-overflow',
  'display',
] as const;

const UNCLAMP_LANDMARK_STOP_TAGS: ReadonlySet<string> = new Set([
  'BODY',
  'HTML',
  'MAIN',
  'ARTICLE',
  'SECTION',
  'ASIDE',
  'NAV',
  'HEADER',
  'FOOTER',
  'DIALOG',
  'FORM',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'UL',
  'OL',
  'DL',
]);

interface SavedInlineProperty {
  value: string;
  priority: string;
}

interface SavedUnclampStyle {
  hadStyleAttr: boolean;
  originalStyleAttr: string | null;
  styleAfterUnclamp: string | null;
  props: Record<string, SavedInlineProperty>;
}

function parseCssLengthToApproxPx(raw: string): number {
  const val = raw.trim().toLowerCase();
  if (
    !val ||
    val === 'none' ||
    val === 'auto' ||
    val === 'unset' ||
    val === 'initial' ||
    val === 'inherit' ||
    val === 'max-content' ||
    val === 'min-content' ||
    val === 'fit-content' ||
    val.endsWith('%') ||
    val.endsWith('vh') ||
    val.endsWith('dvh') ||
    val.endsWith('svh') ||
    val.endsWith('vw')
  ) {
    return Number.NaN;
  }
  const num = Number.parseFloat(val);
  if (!Number.isFinite(num)) {
    return Number.NaN;
  }
  if (val.endsWith('rem') || val.endsWith('em')) {
    return num * 16;
  }
  if (val.endsWith('lh')) {
    return num * 22;
  }
  return num;
}

/**
 * Normalizes source/translated strings (stripping `<mN>` markers, collapsing whitespace,
 * NFKC-folding, and trimming outer punctuation/symbols) so redundant identical translations
 * such as `NFL -> NFL` or `<m0>옹발이 ONGBAL</m0> -> <m0>옹발이 ONGBAL</m0>` are cleanly detected.
 */
export function normalizeComparableTranslationText(raw: string): string {
  return stripResidualMarkers(raw)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .trim()
    .toLowerCase();
}

export function isRedundantIdenticalTranslation(
  sourceTokenizedText: string,
  translatedText: string,
): boolean {
  const normSrc = normalizeComparableTranslationText(sourceTokenizedText);
  const normTrans = normalizeComparableTranslationText(translatedText);
  if (!normSrc || !normTrans) {
    return false;
  }
  return normSrc === normTrans;
}

export const isEffectivelyIdenticalTranslation = isRedundantIdenticalTranslation;

/**
 * Strips raw or incomplete inline `<mN>` / `</mN>` markup tags from live partial stream
 * previews so raw tag syntax never flashes mid-sentence before final rich DOM commit.
 */
export function stripPartialInlineMarkers(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<\/?m\d+\b[^>]*\/?>/gi, '')
    .replace(/<\/?m\d*[^>]*$/gi, '')
    .replace(/<\/?$/g, '');
}

function buildBatchTailContext(
  tasks: readonly PreparedBlockTask[],
  maxChars = 220,
): string {
  if (tasks.length === 0 || maxChars <= 0) return '';
  const tailTexts = tasks
    .slice(-2)
    .map((t) =>
      stripResidualMarkers(t.tokenized.text).replace(/\s+/g, ' ').trim(),
    )
    .filter(Boolean);
  if (tailTexts.length === 0) return '';
  if (tailTexts.length === 1) {
    return tailTexts[0].length > maxChars
      ? tailTexts[0].slice(0, maxChars).trim()
      : tailTexts[0];
  }
  const combined = `${tailTexts[0]} ${tailTexts[1]}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  if (tailTexts[1].length >= maxChars - 24) {
    return tailTexts[1].slice(0, maxChars).trim();
  }
  const budget0 = Math.max(0, maxChars - 1 - tailTexts[1].length);
  const prefix0 = tailTexts[0].slice(0, budget0).trim();
  return prefix0
    ? `${prefix0} ${tailTexts[1]}`
    : tailTexts[1].slice(0, maxChars).trim();
}

function nowFrameMs(): number {
  if (
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
  ) {
    return performance.now();
  }
  return Date.now();
}

interface QueuedViewportEntry {
  scene: TranslationScene;
  priority: RequestPriority;
}

interface InFlightP1BatchTracker {
  controller: AbortController;
  tasks: readonly PreparedBlockTask[];
  hasReceivedAnyItem: boolean;
  abortedByFastScroll: boolean;
}

interface SlotStreamState {
  lastPaintAt: number;
  pendingPartialText: string | null;
  cancelScheduled: (() => void) | null;
  streamContainer: HTMLSpanElement | null;
  streamTextNode: Text | null;
}

function hashGlossaryFingerprint(entries: readonly GlossaryEntry[]): string {
  if (!entries || entries.length === 0) return '0';
  let h = 2166136261;
  for (const e of entries) {
    const row = `${e.k}=>${e.v}@${e.domain ?? ''}:${e.caseSensitive ? 1 : 0}:${e.enabled === false ? 0 : 1};`;
    for (let i = 0; i < row.length; i++) {
      h ^= row.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(36);
}

let requestSeq = 0;
function nextRequestId(scene: string): string {
  requestSeq += 1;
  return `margin-${scene}-${Date.now()}-${requestSeq}`;
}

function defaultBatchTransport(
  payload: TranslateBatchRequest,
  callbacks: StreamBatchCallbacks,
  signal: AbortSignal,
  preferStream: boolean,
): Promise<TranslateBatchResponse> {
  if (
    preferStream &&
    typeof globalThis.chrome !== 'undefined' &&
    Boolean(globalThis.chrome?.runtime?.connect)
  ) {
    return streamBatchTranslation(payload, callbacks, signal);
  }
  return requestBatchTranslation(payload);
}

export class WebpageRenderer {
  private config: MarginConfig;
  private readonly doc: Document;
  private readonly getUrl: () => string;
  readonly cache: LruTranslationCache;
  private readonly transport: BatchTransportFn;
  private readonly flushDelayMs: number;
  private readonly onManualStop?: () => void;

  private active = false;
  private maskRevealedGlobally = false;
  private internalDomDepth = 0;

  private intersectionObserver: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private fullscreenCleanup: (() => void) | null = null;
  private scrollCleanup: (() => void) | null = null;
  private scrollThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScrollCheckAt = 0;

  private observedBlocks = new WeakSet<HTMLElement>();
  private readonly inFlightBlocks = new WeakSet<HTMLElement>();
  private readonly inFlightBlockSet = new Set<HTMLElement>();
  private readonly translatedBlockSet = new Set<HTMLElement>();
  private readonly failedBlockTasks = new Map<HTMLElement, PreparedBlockTask>();
  private readonly inFlightBlockPromises = new WeakMap<HTMLElement, Promise<void>>();
  private readonly mountedMeta = new WeakMap<HTMLElement, MountedBlockMeta>();
  private readonly unclampedStyles = new WeakMap<HTMLElement, SavedUnclampStyle>();
  private readonly pendingViewportQueue = new Map<HTMLElement, QueuedViewportEntry>();
  private readonly fallbackOffscreenBlocks = new Set<HTMLElement>();
  private readonly inFlightP1Batches = new Set<InFlightP1BatchTracker>();
  private readonly ownedInjectedNodes = new Set<Element>();
  private readonly ownedOrigWrappers = new Set<Element>();

  private sessionTotalBlocks = 0;
  private sessionDoneBlocks = 0;
  private lastError: string | undefined;
  private lastBatchTailContext = '';

  private statusHost: HTMLElement | null = null;
  private statusPillEl: HTMLElement | null = null;
  private statusSpinnerEl: HTMLElement | null = null;
  private statusLabelEl: HTMLElement | null = null;
  private statusHintEl: HTMLElement | null = null;
  private statusActionBtn: HTMLButtonElement | null = null;
  private statusCloseBtn: HTMLButtonElement | null = null;
  private statusHideTimer: ReturnType<typeof setTimeout> | null = null;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private spaMutationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingSpaRoots = new Set<ParentNode>();
  private readonly activeControllers = new Set<AbortController>();
  private pageContextCache: { url: string; payload: PageContextPayload } | null = null;

  constructor(options: WebpageRendererOptions) {
    this.config = options.config;
    this.doc = options.doc ?? document;
    this.getUrl =
      options.getUrl ??
      (() =>
        this.doc.location?.href ||
        (typeof location !== 'undefined' ? location.href : ''));
    this.cache = options.cache ?? new LruTranslationCache(DEFAULT_LRU_CAPACITY);
    this.transport = options.transport ?? defaultBatchTransport;
    this.flushDelayMs = options.flushDelayMs ?? 16;
    this.onManualStop = options.onManualStop;

    this.bindFullscreenListener();
  }

  get isActive(): boolean {
    return this.active;
  }

  isPageTranslationActive(): boolean {
    return this.active;
  }

  invalidatePageContextCache(): void {
    this.pageContextCache = null;
    this.lastBatchTailContext = '';
  }

  get isMaskRevealed(): boolean {
    return this.maskRevealedGlobally;
  }

  getPageState(): TabPageState {
    for (const blk of Array.from(this.translatedBlockSet)) {
      if (!blk.isConnected || !this.hasMountedTranslation(blk)) {
        this.translatedBlockSet.delete(blk);
      }
    }
    return {
      active: this.active,
      inFlightBlocks: this.inFlightBlockSet.size + this.pendingViewportQueue.size,
      translatedBlocks: this.translatedBlockSet.size,
      maskRevealed: this.maskRevealedGlobally,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  private runInternalDomMutation<T>(fn: () => T): T {
    if (this.internalDomDepth === 0 && this.active && this.mutationObserver) {
      const pendingExternal = this.mutationObserver.takeRecords();
      if (pendingExternal.length > 0) {
        this.processSpaMutations(pendingExternal);
      }
    }
    this.internalDomDepth += 1;
    try {
      return fn();
    } finally {
      if (this.internalDomDepth === 1 && this.mutationObserver) {
        this.mutationObserver.takeRecords();
      }
      this.internalDomDepth -= 1;
    }
  }

  private bindFullscreenListener(): void {
    if (this.fullscreenCleanup) return;
    const onFsChange = () => syncFullscreenFloatingVisibility(this.doc);
    this.doc.addEventListener('fullscreenchange', onFsChange);
    this.doc.addEventListener('webkitfullscreenchange', onFsChange);
    this.fullscreenCleanup = () => {
      this.doc.removeEventListener('fullscreenchange', onFsChange);
      this.doc.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }

  ensureStylesInjected(): void {
    if (this.doc.getElementById(STYLE_ELEMENT_ID)) return;
    const targetParent = this.doc.head ?? this.doc.documentElement;
    if (!targetParent) return;

    this.runInternalDomMutation(() => {
      const style = this.doc.createElement('style');
      style.id = STYLE_ELEMENT_ID;
      style.setAttribute('data-margin-injected', 'true');
      style.textContent = WEBPAGE_INJECTED_CSS;
      targetParent.appendChild(style);
    });
  }

  resolveEffectiveTheme(): TranslationTheme {
    return resolveThemeForUrl(
      this.getUrl(),
      this.config.webpage.theme,
      this.config.webpage.themePatterns,
    );
  }

  applyTargetLocaleTypography(
    containerEl: HTMLElement,
    hostBlockEl: HTMLElement,
  ): void {
    const bcp47 = normalizeTargetBcp47Lang(this.config.targetLang);
    const dir = resolveTargetTextDir(bcp47);

    if (bcp47) {
      containerEl.setAttribute('lang', bcp47);
    } else {
      containerEl.removeAttribute('lang');
    }

    containerEl.setAttribute('dir', dir ?? 'auto');

    let serif = false;
    if (hostBlockEl.isConnected) {
      const view =
        hostBlockEl.ownerDocument?.defaultView ?? this.doc.defaultView;
      if (view && typeof view.getComputedStyle === 'function') {
        try {
          const computedFontFamily =
            view.getComputedStyle(hostBlockEl).fontFamily;
          serif = isEditorialSerifFontFamily(computedFontFamily);
        } catch {
          serif = false;
        }
      }
    }
    if (!serif && hostBlockEl.style?.fontFamily) {
      serif = isEditorialSerifFontFamily(hostBlockEl.style.fontFamily);
    }

    const fontStack = resolveTargetFontFamilyCss(bcp47, { serif });
    containerEl.style.setProperty('--margin-target-font-family', fontStack);
    containerEl.setAttribute('data-margin-has-target-font', 'true');
  }

  private computeLayoutMode(
    blockEl: HTMLElement | null,
    plainTextLength: number,
    displayMode: DisplayMode = this.config.webpage.displayMode,
  ): 'inline' | 'block' | 'replace' {
    if (displayMode === 'target-only') {
      return 'replace';
    }
    const tag = blockEl?.tagName.toUpperCase() ?? 'P';
    if (INLINE_SHORT_CELL_TAGS.has(tag) && plainTextLength <= 20) {
      const text = blockEl?.textContent ?? '';
      if (!/[\n.!?。！？]/.test(text)) {
        return 'inline';
      }
    }
    return 'block';
  }

  private makeCacheKey(
    scene: TranslationScene,
    tokenizedText: string,
    enableRichHtml: boolean,
  ): string {
    const providerId = resolveProviderIdForScene(
      scene,
      this.config.routing,
      this.config.providers,
    );
    const provider = this.config.providers[providerId];
    const model = provider?.model ?? '';
    const assistantId = provider?.assistantId ?? '';
    const glossaryFp = hashGlossaryFingerprint(this.config.glossary);
    const packsFp = (this.config.enabledGlossaryPacks ?? []).join(',');
    return `${providerId}:${model}:${assistantId}:${this.config.sourceLang}->${this.config.targetLang}:${enableRichHtml ? '1' : '0'}:${glossaryFp}:${packsFp}:${tokenizedText}`;
  }

  private getPageContext(
    scene: TranslationScene,
    prevContext?: string,
  ): PageContextPayload | undefined {
    const currentUrl = this.getUrl();
    let domain = '';
    try {
      domain = currentUrl ? new URL(currentUrl).hostname : '';
    } catch {
      domain = '';
    }

    const providerId = resolveProviderIdForScene(
      scene,
      this.config.routing,
      this.config.providers,
    );
    const provider = this.config.providers[providerId];
    if (provider && !provider.enableContext) {
      if (!currentUrl && !domain && !prevContext) return undefined;
      const styleGuide = inferDomainStyleGuide(domain, currentUrl);
      const threadContext = extractFocalThreadContext(this.doc, currentUrl);
      return {
        url: currentUrl,
        domain,
        ...(styleGuide ? { styleGuide } : {}),
        ...(threadContext ? { threadContext } : {}),
        ...(prevContext ? { prevContext } : {}),
      };
    }

    let basePayload: PageContextPayload;
    if (this.pageContextCache && this.pageContextCache.url === currentUrl) {
      basePayload = this.pageContextCache.payload;
      if (!basePayload.threadContext && currentUrl) {
        const lateThread = extractFocalThreadContext(this.doc, currentUrl);
        if (lateThread) {
          basePayload = { ...basePayload, threadContext: lateThread };
          this.pageContextCache = { url: currentUrl, payload: basePayload };
        }
      }
    } else {
      const extracted = extractPageContext(this.doc, currentUrl);
      const resolvedUrl = currentUrl || extracted.url;
      const resolvedDomain = domain || extracted.domain;
      const styleGuide =
        extracted.styleGuide ??
        inferDomainStyleGuide(resolvedDomain, resolvedUrl);
      basePayload = {
        ...extracted,
        url: resolvedUrl,
        domain: resolvedDomain,
        ...(styleGuide ? { styleGuide } : {}),
      };
      this.pageContextCache = { url: currentUrl, payload: basePayload };
    }

    return prevContext ? { ...basePayload, prevContext } : basePayload;
  }

  private resolveBatchLimits(scene: TranslationScene): {
    maxBatchCount: number;
    maxCharsPerBatch: number;
    preferStream: boolean;
    useProgressiveWaves: boolean;
    providerId: string;
  } {
    const providerId = resolveProviderIdForScene(
      scene,
      this.config.routing,
      this.config.providers,
    );
    const provider = this.config.providers[providerId];
    const assistant = provider?.assistantId
      ? this.config.assistants[provider.assistantId]
      : undefined;

    const maxBatchCount =
      provider?.maxBatchCount ?? assistant?.maxBatchCount ?? 17;
    const maxCharsPerBatch =
      provider?.maxCharsPerBatch ?? assistant?.maxCharsPerBatch ?? 4096;
    const preferStream = provider ? provider.stream !== 'off' : false;
    const useProgressiveWaves =
      provider?.protocol === 'openai-chat' ||
      provider?.protocol === 'anthropic-messages';

    return {
      maxBatchCount,
      maxCharsPerBatch,
      preferStream,
      useProgressiveWaves,
      providerId,
    };
  }

  hasMountedTranslation(blockEl: HTMLElement): boolean {
    for (let i = 0; i < blockEl.children.length; i++) {
      const child = blockEl.children[i];
      if (
        child.classList.contains('margin-trans-root') &&
        child.getAttribute('data-margin-injected') === 'true' &&
        child.getAttribute('data-margin-loading') !== '1' &&
        child.getAttribute('data-margin-streaming') !== '1'
      ) {
        return true;
      }
    }
    return false;
  }

  private insertInjectedIntoBlock(blockEl: HTMLElement, node: Element): void {
    const firstNestedBlock = findFirstDirectBlockBoundaryChild(blockEl);
    if (firstNestedBlock && firstNestedBlock.parentElement === blockEl) {
      blockEl.insertBefore(node, firstNestedBlock);
    } else {
      blockEl.appendChild(node);
    }
  }

  private applyUnclampOverrides(
    el: HTMLElement,
    displayVal: string,
    whiteSpaceVal: string,
    hasLineClamp: boolean,
  ): void {
    let snapshot = this.unclampedStyles.get(el);
    let wasUntouchedByHost = true;

    if (!snapshot) {
      const props: Record<string, SavedInlineProperty> = {};
      for (const prop of UNCLAMP_TRACKED_PROPS) {
        props[prop] = {
          value: el.style.getPropertyValue(prop),
          priority: el.style.getPropertyPriority(prop),
        };
      }
      snapshot = {
        hadStyleAttr: el.hasAttribute('style'),
        originalStyleAttr: el.getAttribute('style'),
        styleAfterUnclamp: null,
        props,
      };
      this.unclampedStyles.set(el, snapshot);
    } else {
      wasUntouchedByHost = el.getAttribute('style') === snapshot.styleAfterUnclamp;
    }

    el.setAttribute('data-margin-unclamped', 'true');
    el.style.setProperty('-webkit-line-clamp', 'unset', 'important');
    el.style.setProperty('line-clamp', 'unset', 'important');
    el.style.setProperty('max-height', 'none', 'important');
    el.style.setProperty('height', 'auto', 'important');

    if (whiteSpaceVal === 'nowrap') {
      el.style.setProperty('overflow-x', 'clip', 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
    } else {
      el.style.setProperty('overflow', 'visible', 'important');
    }

    if (
      displayVal === '-webkit-box' ||
      (hasLineClamp && displayVal === 'flow-root')
    ) {
      el.style.setProperty('display', 'block', 'important');
    } else if (displayVal === '-webkit-inline-box') {
      el.style.setProperty('display', 'inline-block', 'important');
    }

    if (wasUntouchedByHost) {
      snapshot.styleAfterUnclamp = el.getAttribute('style');
    }
  }

  /**
   * Inspects `blockEl` and up to 3 tight ancestor wrappers (stopping before landmarks,
   * scroll containers, positioned overlays, or multi-card containers) and reversibly
   * relaxes CSS `-webkit-line-clamp`, tight `max-height`, or vertical overflow clipping
   * so bilingual translations are never sliced in half or hidden below line clamps.
   */
  private unclampForInjectedNode(
    blockEl: HTMLElement,
    injectedEl: HTMLElement,
  ): void {
    const view = this.doc.defaultView;
    let curr: HTMLElement | null = blockEl;

    for (let depth = 0; depth <= 3 && curr; depth++) {
      if (curr === this.doc.body || curr === this.doc.documentElement) {
        break;
      }
      if (curr.hasAttribute('data-margin-host')) {
        break;
      }
      if (curr.getAttribute('data-testid') === 'cellInnerDiv') {
        break;
      }

      const tag = curr.tagName.toUpperCase();
      if (depth > 0 && UNCLAMP_LANDMARK_STOP_TAGS.has(tag)) {
        break;
      }

      let cs: CSSStyleDeclaration | null = null;
      if (curr.isConnected && view && typeof view.getComputedStyle === 'function') {
        try {
          cs = view.getComputedStyle(curr);
        } catch {
          cs = null;
        }
      }

      const rawStyleAttr = curr.getAttribute('style') ?? '';
      const ovY = (
        cs?.overflowY ||
        curr.style.overflowY ||
        curr.style.overflow ||
        ''
      )
        .trim()
        .toLowerCase();
      const ovX = (
        cs?.overflowX ||
        curr.style.overflowX ||
        curr.style.overflow ||
        ''
      )
        .trim()
        .toLowerCase();

      // Never alter scrollable containers
      if (
        ovY === 'auto' ||
        ovY === 'scroll' ||
        ovX === 'auto' ||
        ovX === 'scroll'
      ) {
        break;
      }

      const pos = (cs?.position || curr.style.position || '')
        .trim()
        .toLowerCase();
      if (pos === 'fixed' || pos === 'sticky') {
        break;
      }
      if (depth > 0 && pos === 'absolute') {
        break;
      }

      if (depth > 0) {
        let nonMarginChildren = 0;
        for (let i = 0; i < curr.children.length; i++) {
          const ch = curr.children[i];
          if (
            !ch.hasAttribute('data-margin-injected') &&
            !ch.hasAttribute('data-margin-host') &&
            ch.getAttribute('data-margin-orig-wrap') !== 'true'
          ) {
            nonMarginChildren += 1;
          }
        }
        if (nonMarginChildren > 4) {
          break;
        }
        if (curr.clientHeight > 240) {
          break;
        }
      }

      const inlineClampMatch = rawStyleAttr.match(
        /(?:^|;|\s)(?:-webkit-)?line-clamp\s*:\s*([^;!]+)/i,
      );
      const clampVal = (
        cs?.getPropertyValue('-webkit-line-clamp') ||
        cs?.getPropertyValue('line-clamp') ||
        curr.style.getPropertyValue('-webkit-line-clamp') ||
        curr.style.getPropertyValue('line-clamp') ||
        (curr.style as unknown as Record<string, string>).webkitLineClamp ||
        inlineClampMatch?.[1] ||
        ''
      )
        .trim()
        .toLowerCase();
      const clampNum = Number.parseInt(clampVal, 10);
      const hasLineClamp =
        clampVal !== '' &&
        clampVal !== 'none' &&
        clampVal !== 'unset' &&
        clampVal !== 'initial' &&
        Number.isFinite(clampNum) &&
        clampNum > 0;

      const inlineDisplayMatch = rawStyleAttr.match(
        /(?:^|;|\s)display\s*:\s*([^;!]+)/i,
      );
      const inlineDisplayVal = (inlineDisplayMatch?.[1] ?? '')
        .trim()
        .toLowerCase();
      const computedDisplayVal = (cs?.display || curr.style.display || '')
        .trim()
        .toLowerCase();
      const displayVal =
        inlineDisplayVal === '-webkit-box' ||
        inlineDisplayVal === '-webkit-inline-box'
          ? inlineDisplayVal
          : computedDisplayVal || inlineDisplayVal;

      const clipsY = ovY === 'hidden' || ovY === 'clip';
      const isWebkitBox =
        displayVal === '-webkit-box' || displayVal === '-webkit-inline-box';
      const isWebkitBoxClamp = isWebkitBox && (clipsY || hasLineClamp);

      const maxHRaw = (cs?.maxHeight || curr.style.maxHeight || '').trim();
      const maxHPx = parseCssLengthToApproxPx(maxHRaw);
      const hasTightMaxHeight =
        Number.isFinite(maxHPx) &&
        maxHPx > 0 &&
        maxHPx <= 260 &&
        (clipsY || hasLineClamp);

      const isFlexOrGrid =
        displayVal === 'flex' ||
        displayVal === 'inline-flex' ||
        displayVal === 'grid' ||
        displayVal === 'inline-grid';
      const inlineHeightPx = parseCssLengthToApproxPx(curr.style.height || '');
      const hasTightInlineFixedHeight =
        !isFlexOrGrid &&
        clipsY &&
        Number.isFinite(inlineHeightPx) &&
        inlineHeightPx > 0 &&
        inlineHeightPx <= 120;

      let hasGeometricClip = false;
      if (clipsY && curr.isConnected && injectedEl.isConnected) {
        try {
          const currRect = curr.getBoundingClientRect();
          const injRect = injectedEl.getBoundingClientRect();
          if (currRect.height > 0 && injRect.height > 0) {
            if (
              injRect.bottom > currRect.bottom - 0.5 ||
              injRect.top >= currRect.bottom - 1 ||
              curr.scrollHeight > curr.clientHeight + 1
            ) {
              hasGeometricClip = true;
            }
          }
        } catch {
          // Ignore geometry errors on detached documents
        }
      }

      if (
        hasLineClamp ||
        isWebkitBoxClamp ||
        hasTightMaxHeight ||
        hasTightInlineFixedHeight ||
        hasGeometricClip
      ) {
        const whiteSpaceVal = (cs?.whiteSpace || curr.style.whiteSpace || '')
          .trim()
          .toLowerCase();
        this.applyUnclampOverrides(
          curr,
          displayVal,
          whiteSpaceVal,
          hasLineClamp,
        );
      }

      curr = curr.parentElement;
    }
  }

  private restoreSingleUnclampedElement(el: HTMLElement): void {
    const snapshot = this.unclampedStyles.get(el);
    el.removeAttribute('data-margin-unclamped');
    if (!snapshot) return;

    this.unclampedStyles.delete(el);

    if (
      snapshot.styleAfterUnclamp !== null &&
      el.getAttribute('style') === snapshot.styleAfterUnclamp
    ) {
      if (!snapshot.hadStyleAttr || snapshot.originalStyleAttr === null) {
        el.removeAttribute('style');
      } else {
        el.setAttribute('style', snapshot.originalStyleAttr);
      }
      return;
    }

    for (const prop of UNCLAMP_TRACKED_PROPS) {
      const saved = snapshot.props[prop];
      if (saved && saved.value) {
        el.style.setProperty(prop, saved.value, saved.priority);
      } else {
        el.style.removeProperty(prop);
      }
    }

    if (!snapshot.hadStyleAttr && !el.getAttribute('style')?.trim()) {
      el.removeAttribute('style');
    }
  }

  private restoreUnclampedForBlock(blockEl: HTMLElement): void {
    let curr: HTMLElement | null = blockEl;
    for (let depth = 0; depth <= 3 && curr; depth++) {
      if (curr === this.doc.body || curr === this.doc.documentElement) {
        break;
      }
      if (
        curr.getAttribute('data-margin-unclamped') === 'true' &&
        curr.querySelector('[data-margin-injected="true"]') === null
      ) {
        this.restoreSingleUnclampedElement(curr);
      }
      curr = curr.parentElement;
    }
  }

  private restoreAllUnclampedElements(): void {
    const unclamped = Array.from(
      this.doc.querySelectorAll<HTMLElement>('[data-margin-unclamped="true"]'),
    );
    for (const el of unclamped) {
      this.restoreSingleUnclampedElement(el);
    }
  }

  private mountBlockLoadingIndicator(
    blockEl: HTMLElement,
    approxPlainLen?: number,
  ): void {
    if (!blockEl.isConnected || this.hasMountedTranslation(blockEl)) return;
    for (let i = 0; i < blockEl.children.length; i++) {
      const ch = blockEl.children[i];
      if (
        ch.classList.contains('margin-trans-loading') ||
        ch.getAttribute('data-margin-streaming') === '1'
      ) {
        return;
      }
    }

    const sourceLen =
      approxPlainLen ??
      (blockEl.textContent ?? '').replace(/\s+/g, ' ').trim().length;
    const layout = this.computeLayoutMode(blockEl, sourceLen);

    this.ensureStylesInjected();
    this.runInternalDomMutation(() => {
      const loading = this.doc.createElement('span');
      loading.className = 'margin-trans-block margin-trans-loading';
      loading.setAttribute('data-margin-injected', 'true');
      loading.setAttribute('data-margin-loading', '1');
      loading.setAttribute(
        'data-margin-layout',
        layout === 'inline' ? 'inline' : 'block',
      );
      loading.setAttribute('role', 'status');
      loading.setAttribute('aria-busy', 'true');
      loading.setAttribute(
        'aria-label',
        this.config.interfaceLang === 'en' ? 'Translating' : '正在翻译',
      );

      const line1 = this.doc.createElement('span');
      line1.className = 'margin-shimmer-line';
      line1.setAttribute('aria-hidden', 'true');

      if (layout === 'inline') {
        loading.appendChild(line1);
      } else if (sourceLen < 80) {
        line1.style.width = '58%';
        loading.appendChild(line1);
      } else {
        line1.style.width = '88%';
        const line2 = this.doc.createElement('span');
        line2.className = 'margin-shimmer-line';
        line2.setAttribute('aria-hidden', 'true');
        line2.style.width = '54%';
        loading.append(line1, line2);
      }

      this.ownedInjectedNodes.add(loading);
      this.insertInjectedIntoBlock(blockEl, loading);
      this.unclampForInjectedNode(blockEl, loading);
    });
  }

  private ensureStatusPillMounted(): void {
    if (this.statusHost?.isConnected && this.statusPillEl) return;
    const mountParent = this.doc.body ?? this.doc.documentElement;
    if (!mountParent) return;

    this.runInternalDomMutation(() => {
      const host = this.doc.createElement('div');
      host.setAttribute('data-margin-host', 'page-status');
      host.setAttribute('data-margin-floating', 'true');
      host.setAttribute('data-display-mode', this.config.uiColorMode);
      host.hidden = true;

      const shadow = host.attachShadow({ mode: 'open' });
      const style = this.doc.createElement('style');
      style.textContent = PAGE_STATUS_PILL_CSS;

      const pill = this.doc.createElement('div');
      pill.className = 'status-pill margin-status-pill';
      pill.setAttribute('data-testid', 'margin-status-pill');
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-live', 'polite');
      pill.hidden = true;

      const spinner = this.doc.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');

      const label = this.doc.createElement('span');
      label.className = 'label';

      const hint = this.doc.createElement('span');
      hint.className = 'hint';
      hint.hidden = true;

      const actionBtn = this.doc.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'action-btn';
      actionBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const action = actionBtn.dataset.action;
        if (action === 'stop') {
          this.onManualStop?.();
          this.restorePage();
        } else if (action === 'retry-failed') {
          const failed = Array.from(this.failedBlockTasks.values());
          this.failedBlockTasks.clear();
          this.lastError = undefined;
          if (failed.length > 0) {
            this.runInternalDomMutation(() => {
              for (const task of failed) {
                this.clearBlockInjectedElements(task.block);
                this.mountBlockLoadingIndicator(
                  task.block,
                  task.tokenized.plainTextLength,
                );
              }
            });
            this.sessionTotalBlocks += failed.length;
            this.refreshStatusPill();
            void this.executeBatch(failed, { priority: 0 });
          }
        }
      });

      const closeBtn = this.doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'close-btn';
      closeBtn.textContent = '×';
      closeBtn.setAttribute('aria-label', 'Dismiss');
      closeBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.hideStatusPill();
      });

      pill.append(spinner, label, hint, actionBtn, closeBtn);
      shadow.append(style, pill);
      mountParent.appendChild(host);

      this.statusHost = host;
      this.statusPillEl = pill;
      this.statusSpinnerEl = spinner;
      this.statusLabelEl = label;
      this.statusHintEl = hint;
      this.statusActionBtn = actionBtn;
      this.statusCloseBtn = closeBtn;
      syncFullscreenFloatingVisibility(this.doc);
    });
  }

  private clearStatusHideTimer(): void {
    if (this.statusHideTimer !== null) {
      clearTimeout(this.statusHideTimer);
      this.statusHideTimer = null;
    }
  }

  private hideStatusPill(): void {
    this.clearStatusHideTimer();
    if (this.statusPillEl) {
      this.statusPillEl.hidden = true;
      delete this.statusPillEl.dataset.quiet;
    }
    if (this.statusHost) {
      this.statusHost.hidden = true;
    }
  }

  private refreshStatusPill(): void {
    if (!this.active) {
      this.hideStatusPill();
      return;
    }

    this.ensureStatusPillMounted();
    if (
      !this.statusHost ||
      !this.statusPillEl ||
      !this.statusSpinnerEl ||
      !this.statusLabelEl ||
      !this.statusHintEl ||
      !this.statusActionBtn ||
      !this.statusCloseBtn
    ) {
      return;
    }

    this.statusHost.setAttribute('data-display-mode', this.config.uiColorMode);
    const isEn = this.config.interfaceLang === 'en';
    const inFlight = this.inFlightBlockSet.size + this.pendingViewportQueue.size;
    const effectiveTheme = this.resolveEffectiveTheme();

    if (inFlight > 0) {
      this.clearStatusHideTimer();
      const total = Math.max(
        this.sessionTotalBlocks,
        this.sessionDoneBlocks + inFlight,
      );
      this.statusPillEl.dataset.tone = 'progress';
      delete this.statusPillEl.dataset.quiet;
      this.statusSpinnerEl.hidden = false;
      this.statusLabelEl.textContent = isEn
        ? `Margin · Translating (${this.sessionDoneBlocks}/${total})`
        : `Margin · 正在翻译 (${this.sessionDoneBlocks}/${total})`;
      if (effectiveTheme === 'mask') {
        this.statusHintEl.textContent = isEn ? '(Mask on)' : '(遮罩模式)';
        this.statusHintEl.hidden = false;
      } else {
        this.statusHintEl.hidden = true;
      }
      this.statusActionBtn.dataset.action = 'stop';
      this.statusActionBtn.textContent = isEn ? 'Stop' : '停止';
      this.statusActionBtn.hidden = false;
      this.statusCloseBtn.hidden = true;
      this.statusPillEl.hidden = false;
      this.statusHost.hidden = false;
      return;
    }

    if (this.failedBlockTasks.size > 0 && this.lastError) {
      this.clearStatusHideTimer();
      const shortErr =
        this.lastError.length > 36
          ? `${this.lastError.slice(0, 36)}…`
          : this.lastError;
      this.statusPillEl.dataset.tone = 'error';
      delete this.statusPillEl.dataset.quiet;
      this.statusSpinnerEl.hidden = true;
      this.statusLabelEl.textContent = isEn
        ? `Margin · Error: ${shortErr}`
        : `Margin · 翻译受阻：${shortErr}`;
      this.statusHintEl.hidden = true;
      this.statusActionBtn.dataset.action = 'retry-failed';
      this.statusActionBtn.textContent = isEn ? 'Retry' : '重试失败段落';
      this.statusActionBtn.hidden = false;
      this.statusCloseBtn.hidden = false;
      this.statusPillEl.hidden = false;
      this.statusHost.hidden = false;
      return;
    }

    if (this.sessionDoneBlocks > 0) {
      this.clearStatusHideTimer();
      this.statusPillEl.dataset.tone = 'done';
      this.statusPillEl.dataset.quiet = 'true';
      this.statusSpinnerEl.hidden = true;
      this.statusLabelEl.textContent = isEn
        ? `✓ Translated ${this.sessionDoneBlocks}`
        : `✓ 已译 ${this.sessionDoneBlocks} 段`;
      this.statusHintEl.hidden = effectiveTheme !== 'mask';
      if (effectiveTheme === 'mask') {
        this.statusHintEl.textContent = isEn
          ? '(Hover to reveal)'
          : '(悬停查看遮罩)';
      }
      this.statusActionBtn.hidden = true;
      this.statusCloseBtn.hidden = true;
      this.statusPillEl.hidden = false;
      this.statusHost.hidden = false;
      this.statusHideTimer = setTimeout(() => {
        this.statusHideTimer = null;
        this.hideStatusPill();
      }, 1400);
      return;
    }

    this.hideStatusPill();
  }

  private wrapOriginalContentForTargetOnly(blockEl: HTMLElement): void {
    for (let i = 0; i < blockEl.children.length; i++) {
      if (blockEl.children[i].getAttribute('data-margin-orig-wrap') === 'true') {
        return;
      }
    }

    const firstNestedBlock = findFirstDirectBlockBoundaryChild(blockEl);
    const wrapper = this.doc.createElement('span');
    wrapper.className = 'margin-orig-source';
    wrapper.setAttribute('data-margin-orig-wrap', 'true');
    wrapper.hidden = true;
    wrapper.style.setProperty('display', 'none', 'important');

    const nodesToMove: ChildNode[] = [];
    for (let i = 0; i < blockEl.childNodes.length; i++) {
      const child = blockEl.childNodes[i];
      if (child === firstNestedBlock) {
        break;
      }
      if (
        child.nodeType === Node.ELEMENT_NODE &&
        (child as Element).hasAttribute('data-margin-injected')
      ) {
        continue;
      }
      nodesToMove.push(child);
    }

    if (nodesToMove.length === 0) return;

    for (const node of nodesToMove) {
      wrapper.appendChild(node);
    }

    this.ownedOrigWrappers.add(wrapper);
    blockEl.insertBefore(wrapper, blockEl.firstChild);
  }

  private unwrapOriginalContent(blockEl: HTMLElement): void {
    let wrapper: Element | null = null;
    for (let i = 0; i < blockEl.children.length; i++) {
      if (blockEl.children[i].getAttribute('data-margin-orig-wrap') === 'true') {
        wrapper = blockEl.children[i];
        break;
      }
    }
    if (!wrapper) return;

    while (wrapper.firstChild) {
      blockEl.insertBefore(wrapper.firstChild, wrapper);
    }
    this.ownedOrigWrappers.delete(wrapper);
    wrapper.remove();
  }

  private clearBlockInjectedElements(blockEl: HTMLElement): void {
    const toRemove: Element[] = [];
    for (let i = 0; i < blockEl.children.length; i++) {
      const child = blockEl.children[i];
      if (child.getAttribute('data-margin-injected') === 'true') {
        toRemove.push(child);
      }
    }
    for (const el of toRemove) {
      this.ownedInjectedNodes.delete(el);
      el.remove();
    }
  }

  removeBlockTranslation(blockEl: HTMLElement): void {
    this.runInternalDomMutation(() => {
      this.clearBlockInjectedElements(blockEl);
      this.unwrapOriginalContent(blockEl);
      this.restoreUnclampedForBlock(blockEl);
      blockEl.removeAttribute('data-margin-translated');
      this.mountedMeta.delete(blockEl);
      this.translatedBlockSet.delete(blockEl);
    });
  }

  private mountBlockTranslation(
    blockEl: HTMLElement,
    tokenized: TokenizedParagraph,
    translatedText: string,
    options: { forceBilingual?: boolean } = {},
  ): { fallbackPlain: boolean } {
    this.ensureStylesInjected();
    const displayMode: DisplayMode = options.forceBilingual
      ? 'bilingual'
      : this.config.webpage.displayMode;

    if (
      displayMode === 'bilingual' &&
      isRedundantIdenticalTranslation(tokenized.text, translatedText)
    ) {
      this.runInternalDomMutation(() => {
        this.clearBlockInjectedElements(blockEl);
        this.unwrapOriginalContent(blockEl);
        this.restoreUnclampedForBlock(blockEl);
        blockEl.removeAttribute('data-margin-translated');
        this.mountedMeta.delete(blockEl);
        this.translatedBlockSet.delete(blockEl);
        this.failedBlockTasks.delete(blockEl);
      });
      return { fallbackPlain: false };
    }

    const reconstructed = reconstructRichDom(
      translatedText,
      tokenized,
      this.doc,
      { stripSourceLocaleAttrs: true },
    );
    const theme = this.resolveEffectiveTheme();
    const layout = this.computeLayoutMode(
      blockEl,
      tokenized.plainTextLength,
      displayMode,
    );

    this.runInternalDomMutation(() => {
      this.clearBlockInjectedElements(blockEl);

      if (displayMode === 'target-only') {
        this.wrapOriginalContentForTargetOnly(blockEl);
      } else {
        this.unwrapOriginalContent(blockEl);
      }

      const span = this.doc.createElement('span');
      span.className = 'margin-trans-root margin-trans-block';
      span.setAttribute('data-margin-injected', 'true');
      span.setAttribute('data-margin-theme', theme);
      span.setAttribute('data-margin-layout', layout);
      this.applyTargetLocaleTypography(span, blockEl);
      if (reconstructed.fallbackPlain) {
        span.setAttribute('data-margin-fallback-plain', 'true');
      }
      span.appendChild(reconstructed.fragment);

      span.addEventListener('click', (ev) => {
        if (span.getAttribute('data-margin-theme') !== 'mask') return;
        const target = ev.target as Element | null;
        if (target?.closest?.('a')) return;
        const currentlyUnmasked =
          span.getAttribute('data-margin-item-unmasked') === 'true';
        if (currentlyUnmasked) {
          span.removeAttribute('data-margin-item-unmasked');
        } else {
          span.setAttribute('data-margin-item-unmasked', 'true');
        }
      });

      this.ownedInjectedNodes.add(span);
      this.insertInjectedIntoBlock(blockEl, span);
      this.unclampForInjectedNode(blockEl, span);
      blockEl.setAttribute('data-margin-translated', 'true');
      this.mountedMeta.set(blockEl, {
        plainTextLength: tokenized.plainTextLength,
        fallbackPlain: reconstructed.fallbackPlain,
        sourceText: tokenized.text,
        translatedText,
      });
      this.translatedBlockSet.add(blockEl);
      this.failedBlockTasks.delete(blockEl);
    });

    return { fallbackPlain: reconstructed.fallbackPlain };
  }

  private mountBatchRetryButtons(
    batchTasks: readonly PreparedBlockTask[],
    errorMessage: string,
    options: { forceBilingual?: boolean; priority?: RequestPriority } = {},
  ): void {
    this.ensureStylesInjected();
    if (errorMessage) {
      this.lastError = errorMessage;
    }

    this.runInternalDomMutation(() => {
      const retryBatch = () => {
        this.runInternalDomMutation(() => {
          for (const t of batchTasks) {
            this.failedBlockTasks.delete(t.block);
            this.clearBlockInjectedElements(t.block);
            this.mountBlockLoadingIndicator(
              t.block,
              t.tokenized.plainTextLength,
            );
          }
        });
        this.sessionTotalBlocks += batchTasks.length;
        this.refreshStatusPill();
        void this.executeBatch(batchTasks, { ...options, priority: 0 });
      };

      for (const task of batchTasks) {
        this.observedBlocks.delete(task.block);
        if (!task.block.isConnected || this.hasMountedTranslation(task.block)) {
          continue;
        }
        this.clearBlockInjectedElements(task.block);
        this.failedBlockTasks.set(task.block, task);

        const btn = this.doc.createElement('button');
        btn.type = 'button';
        btn.className = 'margin-inline-retry';
        btn.setAttribute('data-margin-injected', 'true');
        btn.setAttribute('aria-label', 'Retry translation');
        btn.title = errorMessage
          ? `Translation failed (${errorMessage}) — click to retry batch`
          : 'Retry failed translation batch';
        btn.textContent = '↻';
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          retryBatch();
        });
        this.ownedInjectedNodes.add(btn);
        this.insertInjectedIntoBlock(task.block, btn);
        this.unclampForInjectedNode(task.block, btn);
      }
    });
  }

  private prepareBlockTask(
    block: HTMLElement,
    scene: TranslationScene,
  ): PreparedBlockTask | null {
    const enableRichHtml = this.config.webpage.enableRichHtml;
    const tokenized = tokenizeParagraph(block, { enableRichHtml });
    if (!tokenized.text) {
      return null;
    }
    const cacheKey = this.makeCacheKey(scene, tokenized.text, enableRichHtml);
    return {
      block,
      tokenized,
      cacheKey,
      charCount: tokenized.text.length,
      scene,
    };
  }

  private executeBatch(
    batchTasks: readonly PreparedBlockTask[],
    options: { forceBilingual?: boolean; priority?: RequestPriority } = {},
  ): Promise<void> {
    if (batchTasks.length === 0) return Promise.resolve();

    let runPromise!: Promise<void>;
    runPromise = this.executeBatchInternal(
      batchTasks,
      options,
      (p) => {
        for (const task of batchTasks) {
          this.inFlightBlockPromises.set(task.block, p);
        }
      },
    );
    for (const task of batchTasks) {
      if (this.inFlightBlocks.has(task.block)) {
        this.inFlightBlockPromises.set(task.block, runPromise);
      }
    }
    return runPromise;
  }

  private async executeBatchInternal(
    batchTasks: readonly PreparedBlockTask[],
    options: { forceBilingual?: boolean; priority?: RequestPriority } = {},
    _onRegistered?: (p: Promise<void>) => void,
  ): Promise<void> {
    if (batchTasks.length === 0) return;

    const scene = batchTasks[0].scene;
    const resolvedPriority: RequestPriority =
      options.priority ?? (scene === 'hover' ? -1 : 0);
    const { preferStream, providerId } = this.resolveBatchLimits(scene);
    const abortController = new AbortController();
    this.activeControllers.add(abortController);

    let p1Tracker: InFlightP1BatchTracker | null = null;
    if (scene === 'webpage' && resolvedPriority === 1) {
      p1Tracker = {
        controller: abortController,
        tasks: batchTasks,
        hasReceivedAnyItem: false,
        abortedByFastScroll: false,
      };
      this.inFlightP1Batches.add(p1Tracker);
    }

    for (const task of batchTasks) {
      this.inFlightBlocks.add(task.block);
      this.inFlightBlockSet.add(task.block);
      this.mountBlockLoadingIndicator(
        task.block,
        task.tokenized.plainTextLength,
      );
    }
    if (scene === 'webpage') {
      this.refreshStatusPill();
    }

    const slotMap = new Map<number, PreparedBlockTask>();
    const renderedTransBySlot = new Map<number, string>();
    const slotStreams = new Map<number, SlotStreamState>();
    const maskBoundContainers = new WeakSet<Element>();

    const cancelPendingSlotRafs = () => {
      for (const st of slotStreams.values()) {
        st.cancelScheduled?.();
        st.cancelScheduled = null;
        st.pendingPartialText = null;
      }
    };

    const requestItems = batchTasks.map((task, idx) => {
      const id = idx + 1;
      slotMap.set(id, task);
      return {
        id,
        text: task.tokenized.text,
        hasRichTags: task.tokenized.hasRichTags,
      };
    });

    const prevContext =
      scene === 'webpage' && this.lastBatchTailContext
        ? this.lastBatchTailContext
        : undefined;
    const context = this.getPageContext(scene, prevContext);
    if (scene === 'webpage') {
      const nextTail = buildBatchTailContext(batchTasks);
      if (nextTail) {
        this.lastBatchTailContext = nextTail;
      }
    }

    const payload: TranslateBatchRequest = {
      requestId: nextRequestId(scene),
      scene,
      priority: resolvedPriority,
      providerId,
      fromLang: this.config.sourceLang,
      toLang: this.config.targetLang,
      items: requestItems,
      context,
    };

    const staleMidFlightBlocks = new Set<HTMLElement>();

    const scheduleNextFrame = (cb: () => void): (() => void) => {
      const win = this.doc.defaultView;
      const raf =
        win?.requestAnimationFrame?.bind(win) ??
        (typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : null);
      const caf =
        win?.cancelAnimationFrame?.bind(win) ??
        (typeof cancelAnimationFrame === 'function'
          ? cancelAnimationFrame
          : null);
      if (raf) {
        const handle = raf(cb);
        return () => {
          caf?.(handle);
        };
      }
      const timer = setTimeout(cb, 16);
      return () => {
        clearTimeout(timer);
      };
    };

    const paintPartialSlot = (
      slotId: number,
      task: PreparedBlockTask,
      slotState: SlotStreamState,
      previewText: string,
    ): void => {
      if (
        abortController.signal.aborted ||
        renderedTransBySlot.has(slotId) ||
        !task.block.isConnected
      ) {
        return;
      }

      if (
        slotState.streamTextNode &&
        slotState.streamContainer &&
        slotState.streamContainer.isConnected
      ) {
        if (slotState.streamTextNode.nodeValue !== previewText) {
          this.runInternalDomMutation(() => {
            slotState.streamTextNode!.textContent = previewText;
          });
        }
        return;
      }

      this.ensureStylesInjected();
      const displayMode: DisplayMode = options.forceBilingual
        ? 'bilingual'
        : this.config.webpage.displayMode;
      const theme = this.resolveEffectiveTheme();
      const layout = this.computeLayoutMode(
        task.block,
        task.tokenized.plainTextLength,
        displayMode,
      );

      this.runInternalDomMutation(() => {
        if (displayMode === 'target-only') {
          this.wrapOriginalContentForTargetOnly(task.block);
        } else {
          this.unwrapOriginalContent(task.block);
        }

        let container: HTMLSpanElement | null = null;
        for (let i = 0; i < task.block.children.length; i++) {
          const ch = task.block.children[i];
          if (
            ch instanceof HTMLSpanElement &&
            ch.getAttribute('data-margin-injected') === 'true' &&
            ch.classList.contains('margin-trans-block')
          ) {
            container = ch;
            break;
          }
        }

        const isNewContainer = container === null;
        if (!container) {
          container = this.doc.createElement('span');
        }

        container.className = 'margin-trans-root margin-trans-block';
        container.removeAttribute('data-margin-loading');
        container.removeAttribute('aria-busy');
        container.removeAttribute('role');
        container.removeAttribute('aria-label');
        container.style.cssText = '';
        container.setAttribute('data-margin-injected', 'true');
        container.setAttribute('data-margin-streaming', '1');
        container.setAttribute('data-margin-theme', theme);
        container.setAttribute('data-margin-layout', layout);
        this.applyTargetLocaleTypography(container, task.block);

        const textNode = this.doc.createTextNode(previewText);
        container.replaceChildren(textNode);

        if (!maskBoundContainers.has(container)) {
          maskBoundContainers.add(container);
          container.addEventListener('click', (ev) => {
            if (container!.getAttribute('data-margin-theme') !== 'mask') return;
            const target = ev.target as Element | null;
            if (target?.closest?.('a')) return;
            const currentlyUnmasked =
              container!.getAttribute('data-margin-item-unmasked') === 'true';
            if (currentlyUnmasked) {
              container!.removeAttribute('data-margin-item-unmasked');
            } else {
              container!.setAttribute('data-margin-item-unmasked', 'true');
            }
          });
        }

        this.ownedInjectedNodes.add(container);
        if (isNewContainer) {
          this.insertInjectedIntoBlock(task.block, container);
        }
        this.unclampForInjectedNode(task.block, container);
        slotState.streamContainer = container;
        slotState.streamTextNode = textNode;
      });
    };

    const handlePartialOutputItem = (item: BatchItemOutput): void => {
      if (p1Tracker) {
        p1Tracker.hasReceivedAnyItem = true;
      }
      if (abortController.signal.aborted) return;
      if (renderedTransBySlot.has(item.id)) return;
      const task = slotMap.get(item.id);
      if (!task || !task.block.isConnected) return;
      if (typeof item.trans !== 'string') return;

      const previewText = stripPartialInlineMarkers(item.trans);
      if (!previewText.trim()) return;

      let slotState = slotStreams.get(item.id);
      if (!slotState) {
        slotState = {
          lastPaintAt: 0,
          pendingPartialText: null,
          cancelScheduled: null,
          streamContainer: null,
          streamTextNode: null,
        };
        slotStreams.set(item.id, slotState);
      }

      const now = nowFrameMs();
      if (slotState.lastPaintAt === 0 || now - slotState.lastPaintAt >= 16) {
        slotState.cancelScheduled?.();
        slotState.cancelScheduled = null;
        slotState.pendingPartialText = null;
        paintPartialSlot(item.id, task, slotState, previewText);
        slotState.lastPaintAt = now;
        return;
      }

      slotState.pendingPartialText = previewText;
      if (!slotState.cancelScheduled) {
        slotState.cancelScheduled = scheduleNextFrame(() => {
          if (!slotState) return;
          slotState.cancelScheduled = null;
          const latest = slotState.pendingPartialText;
          slotState.pendingPartialText = null;
          if (
            latest !== null &&
            !abortController.signal.aborted &&
            !renderedTransBySlot.has(item.id)
          ) {
            paintPartialSlot(item.id, task, slotState, latest);
            slotState.lastPaintAt = nowFrameMs();
          }
        });
      }
    };

    const applyOutputItem = (item: BatchItemOutput) => {
      if (p1Tracker) {
        p1Tracker.hasReceivedAnyItem = true;
      }
      if (abortController.signal.aborted) return;
      if (item.partial) {
        handlePartialOutputItem(item);
        return;
      }

      const slotState = slotStreams.get(item.id);
      if (slotState) {
        slotState.cancelScheduled?.();
        slotState.cancelScheduled = null;
        slotState.pendingPartialText = null;
      }

      const task = slotMap.get(item.id);
      if (!task) return;
      if (typeof item.trans !== 'string' || !item.trans.trim()) return;

      const prevTrans = renderedTransBySlot.get(item.id);
      if (prevTrans !== undefined && prevTrans === item.trans) {
        return;
      }

      const isFirstRenderForSlot = prevTrans === undefined;
      renderedTransBySlot.set(item.id, item.trans);

      if (!task.block.isConnected) {
        this.cache.set(task.cacheKey, {
          trans: item.trans,
          fallbackPlain: Boolean(item.fallbackPlain),
        });
        if (isFirstRenderForSlot && scene === 'webpage') {
          this.sessionDoneBlocks += 1;
          this.inFlightBlockSet.delete(task.block);
          this.refreshStatusPill();
        }
        return;
      }

      if (scene === 'webpage') {
        const latestPrepared = this.prepareBlockTask(task.block, scene);
        if (
          !latestPrepared ||
          latestPrepared.tokenized.text.trim() !== task.tokenized.text.trim()
        ) {
          this.cache.set(task.cacheKey, {
            trans: item.trans,
            fallbackPlain: Boolean(item.fallbackPlain),
          });
          this.runInternalDomMutation(() => {
            if (!this.hasMountedTranslation(task.block)) {
              this.clearBlockInjectedElements(task.block);
              this.restoreUnclampedForBlock(task.block);
            }
          });
          if (latestPrepared) {
            staleMidFlightBlocks.add(task.block);
          }
          if (isFirstRenderForSlot) {
            this.sessionDoneBlocks += 1;
            this.inFlightBlockSet.delete(task.block);
            this.refreshStatusPill();
          }
          return;
        }
      }

      const { fallbackPlain } = this.mountBlockTranslation(
        task.block,
        task.tokenized,
        item.trans,
        options,
      );
      this.cache.set(task.cacheKey, {
        trans: item.trans,
        fallbackPlain: item.fallbackPlain || fallbackPlain,
      });

      if (isFirstRenderForSlot && scene === 'webpage') {
        this.sessionDoneBlocks += 1;
        this.inFlightBlockSet.delete(task.block);
        this.refreshStatusPill();
      }
    };

    try {
      const response = await this.transport(
        payload,
        {
          onDelta: () => {
            if (p1Tracker) {
              p1Tracker.hasReceivedAnyItem = true;
            }
          },
          onItemReady: (item) => {
            applyOutputItem(item);
          },
        },
        abortController.signal,
        preferStream,
      );

      if (abortController.signal.aborted) return;

      if (!response.ok) {
        cancelPendingSlotRafs();
        const unrendered = batchTasks.filter(
          (_, idx) => !renderedTransBySlot.has(idx + 1),
        );
        this.mountBatchRetryButtons(
          unrendered,
          response.error?.message ?? 'Upstream error',
          options,
        );
        return;
      }

      for (const outItem of response.items) {
        applyOutputItem(outItem);
      }

      const missingTasks = batchTasks.filter(
        (_, idx) => !renderedTransBySlot.has(idx + 1),
      );
      if (missingTasks.length > 0) {
        this.mountBatchRetryButtons(
          missingTasks,
          'Incomplete batch response',
          options,
        );
      }
    } catch (err) {
      cancelPendingSlotRafs();
      if (abortController.signal.aborted) {
        if (p1Tracker?.abortedByFastScroll) {
          return;
        }
        this.runInternalDomMutation(() => {
          for (const task of batchTasks) {
            if (
              !renderedTransBySlot.has(
                requestItems.find((it) => slotMap.get(it.id) === task)?.id ?? -1,
              )
            ) {
              this.observedBlocks.delete(task.block);
              if (!this.hasMountedTranslation(task.block)) {
                this.clearBlockInjectedElements(task.block);
                this.restoreUnclampedForBlock(task.block);
              }
            }
          }
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const unrendered = batchTasks.filter(
        (_, idx) => !renderedTransBySlot.has(idx + 1),
      );
      this.mountBatchRetryButtons(unrendered, msg, options);
    } finally {
      cancelPendingSlotRafs();
      this.activeControllers.delete(abortController);
      if (p1Tracker) {
        this.inFlightP1Batches.delete(p1Tracker);
      }
      for (const task of batchTasks) {
        this.inFlightBlocks.delete(task.block);
        this.inFlightBlockSet.delete(task.block);
        this.inFlightBlockPromises.delete(task.block);
      }
      if (scene === 'webpage') {
        this.refreshStatusPill();
        if (this.active && staleMidFlightBlocks.size > 0) {
          this.scanAndRegisterSpaRoots(Array.from(staleMidFlightBlocks));
        }
      }
    }
  }

  private getViewportHeight(): number {
    const win =
      this.doc.defaultView ?? (typeof window !== 'undefined' ? window : null);
    return win?.innerHeight || this.doc.documentElement?.clientHeight || 800;
  }

  private classifyBlockViewportState(block: HTMLElement): {
    isStrictlyVisible: boolean;
    isWithinLookahead: boolean;
    shouldEvictQueued: boolean;
    shouldEvictInFlightP1: boolean;
  } {
    const vh = this.getViewportHeight();
    try {
      const rect = block.getBoundingClientRect();
      const isZeroLayoutRect =
        rect.top === 0 &&
        rect.bottom === 0 &&
        rect.left === 0 &&
        rect.right === 0 &&
        rect.width === 0 &&
        rect.height === 0;
      if (isZeroLayoutRect) {
        return {
          isStrictlyVisible: true,
          isWithinLookahead: true,
          shouldEvictQueued: false,
          shouldEvictInFlightP1: false,
        };
      }
      const isStrictlyVisible = rect.bottom > 0 && rect.top < vh;
      const isWithinLookahead =
        !isStrictlyVisible && rect.bottom >= -300 && rect.top <= vh + 2200;
      const shouldEvictQueued = rect.bottom < -600 || rect.top > vh + 2600;
      const shouldEvictInFlightP1 =
        rect.bottom < -1200 || rect.top > vh + 3000;
      return {
        isStrictlyVisible,
        isWithinLookahead,
        shouldEvictQueued,
        shouldEvictInFlightP1,
      };
    } catch {
      return {
        isStrictlyVisible: true,
        isWithinLookahead: true,
        shouldEvictQueued: false,
        shouldEvictInFlightP1: false,
      };
    }
  }

  /**
   * Translates an explicit list of paragraph blocks immediately (checking LRU cache first,
   * then packing misses into priority-tiered progressive micro-batches).
   */
  async translateBlocks(
    blocks: readonly HTMLElement[],
    scene: TranslationScene = 'webpage',
    options: { forceBilingual?: boolean; fullPage?: boolean } = {},
  ): Promise<void> {
    const misses: PreparedBlockTask[] = [];
    const existingPromises = new Set<Promise<void>>();

    for (const block of blocks) {
      if (!block.isConnected) continue;
      if (scene === 'webpage') {
        this.pendingViewportQueue.delete(block);
        this.syncStaleBlockBeforeRegister(block, false);
      }
      if (this.hasMountedTranslation(block)) {
        continue;
      }
      if (this.inFlightBlocks.has(block)) {
        const inFlightPromise = this.inFlightBlockPromises.get(block);
        if (inFlightPromise) {
          existingPromises.add(inFlightPromise);
        }
        continue;
      }

      const prepared = this.prepareBlockTask(block, scene);
      if (!prepared) continue;

      const cached = this.cache.get(prepared.cacheKey);
      if (cached) {
        this.mountBlockTranslation(
          block,
          prepared.tokenized,
          cached.trans,
          options,
        );
        continue;
      }

      misses.push(prepared);
    }

    if (misses.length === 0) {
      if (scene === 'webpage') {
        this.refreshStatusPill();
      }
      if (existingPromises.size > 0) {
        await Promise.all(existingPromises);
      }
      return;
    }

    const { maxBatchCount, maxCharsPerBatch, useProgressiveWaves } =
      this.resolveBatchLimits(scene);

    if (scene !== 'webpage') {
      const hoverPriority: RequestPriority = scene === 'hover' ? -1 : 0;
      for (const m of misses) {
        this.mountBlockLoadingIndicator(
          m.block,
          m.tokenized.plainTextLength,
        );
      }
      const batches = packIntoBatches(misses, maxBatchCount, maxCharsPerBatch);
      await Promise.all([
        ...existingPromises,
        ...batches.map((batch) =>
          this.executeBatch(batch, { ...options, priority: hoverPriority }),
        ),
      ]);
      return;
    }

    const p0Misses: PreparedBlockTask[] = [];
    const offscreenMisses: PreparedBlockTask[] = [];

    for (const item of misses) {
      const state = this.classifyBlockViewportState(item.block);
      if (state.isStrictlyVisible) {
        p0Misses.push(item);
      } else {
        offscreenMisses.push(item);
      }
    }

    const allOrdered = [...p0Misses, ...offscreenMisses];
    for (const m of allOrdered) {
      this.mountBlockLoadingIndicator(m.block, m.tokenized.plainTextLength);
    }

    this.sessionTotalBlocks += allOrdered.length;
    this.refreshStatusPill();

    const p0Batches =
      p0Misses.length > 0
        ? packIntoProgressiveBatches(
            p0Misses,
            maxBatchCount,
            maxCharsPerBatch,
            useProgressiveWaves,
          )
        : [];
    const offscreenPriority: RequestPriority = options.fullPage ? 2 : 1;
    const offscreenBatches =
      offscreenMisses.length > 0
        ? packIntoBatches(offscreenMisses, maxBatchCount, maxCharsPerBatch)
        : [];

    await Promise.all([
      ...existingPromises,
      ...p0Batches.map((batch) =>
        this.executeBatch(batch, { ...options, priority: 0 }),
      ),
      ...offscreenBatches.map((batch) =>
        this.executeBatch(batch, { ...options, priority: offscreenPriority }),
      ),
    ]);
  }

  /**
   * Toggles bilingual translation on a single paragraph block (used by Modifier + Hover).
   */
  async toggleSingleBlock(
    block: HTMLElement,
    scene: TranslationScene = 'hover',
  ): Promise<boolean> {
    if (this.hasMountedTranslation(block)) {
      this.removeBlockTranslation(block);
      return false;
    }
    await this.translateBlocks([block], scene, { forceBilingual: true });
    return this.hasMountedTranslation(block);
  }

  private observeOffscreenBlock(block: HTMLElement): void {
    const io = this.ensureIntersectionObserver();
    if (io) {
      this.observedBlocks.add(block);
      io.observe(block);
    } else {
      this.observedBlocks.add(block);
      this.fallbackOffscreenBlocks.add(block);
    }
  }

  private flushViewportQueue(): void {
    if (!this.active || this.pendingViewportQueue.size === 0) return;
    const entries = Array.from(this.pendingViewportQueue.entries());
    this.pendingViewportQueue.clear();

    const p0Tasks: PreparedBlockTask[] = [];
    const p1Tasks: PreparedBlockTask[] = [];
    const evictedBlocks: HTMLElement[] = [];

    for (const [block, meta] of entries) {
      if (!block.isConnected) {
        this.observedBlocks.delete(block);
        continue;
      }
      this.syncStaleBlockBeforeRegister(block, false);
      if (
        this.hasMountedTranslation(block) ||
        this.inFlightBlocks.has(block) ||
        this.failedBlockTasks.has(block)
      ) {
        continue;
      }

      const vpState = this.classifyBlockViewportState(block);
      if (vpState.shouldEvictQueued) {
        evictedBlocks.push(block);
        continue;
      }

      const prepared = this.prepareBlockTask(block, meta.scene);
      if (!prepared) {
        evictedBlocks.push(block);
        continue;
      }

      const cached = this.cache.get(prepared.cacheKey);
      if (cached) {
        this.mountBlockTranslation(block, prepared.tokenized, cached.trans);
        continue;
      }

      if (vpState.isStrictlyVisible) {
        p0Tasks.push(prepared);
      } else {
        p1Tasks.push(prepared);
      }
    }

    if (evictedBlocks.length > 0) {
      this.runInternalDomMutation(() => {
        for (const block of evictedBlocks) {
          if (!this.hasMountedTranslation(block)) {
            this.clearBlockInjectedElements(block);
            this.restoreUnclampedForBlock(block);
          }
          this.observedBlocks.delete(block);
          if (block.isConnected) {
            this.observeOffscreenBlock(block);
          }
        }
      });
    }

    if (p0Tasks.length === 0 && p1Tasks.length === 0) {
      this.refreshStatusPill();
      return;
    }

    const { maxBatchCount, maxCharsPerBatch, useProgressiveWaves } =
      this.resolveBatchLimits('webpage');

    for (const task of p0Tasks) {
      this.mountBlockLoadingIndicator(
        task.block,
        task.tokenized.plainTextLength,
      );
    }
    for (const task of p1Tasks) {
      this.mountBlockLoadingIndicator(
        task.block,
        task.tokenized.plainTextLength,
      );
    }

    this.sessionTotalBlocks += p0Tasks.length + p1Tasks.length;
    this.refreshStatusPill();

    const p0Batches =
      p0Tasks.length > 0
        ? packIntoProgressiveBatches(
            p0Tasks,
            maxBatchCount,
            maxCharsPerBatch,
            useProgressiveWaves,
          )
        : [];
    const p1Batches =
      p1Tasks.length > 0
        ? packIntoBatches(p1Tasks, maxBatchCount, maxCharsPerBatch)
        : [];

    for (const batch of p0Batches) {
      void this.executeBatch(batch, { priority: 0 });
    }
    for (const batch of p1Batches) {
      void this.executeBatch(batch, { priority: 1 });
    }
  }

  private scheduleFlushViewportQueue(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushViewportQueue();
    }, this.flushDelayMs);
  }

  private ensureIntersectionObserver(): IntersectionObserver | null {
    if (this.intersectionObserver) return this.intersectionObserver;
    if (typeof IntersectionObserver === 'undefined') return null;

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (!this.active) return;
        let added = false;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          this.intersectionObserver?.unobserve(target);
          if (
            !this.hasMountedTranslation(target) &&
            !this.inFlightBlocks.has(target) &&
            !this.failedBlockTasks.has(target)
          ) {
            const vpState = this.classifyBlockViewportState(target);
            const tier: RequestPriority = vpState.isStrictlyVisible ? 0 : 1;
            this.pendingViewportQueue.set(target, {
              scene: 'webpage',
              priority: tier,
            });
            this.mountBlockLoadingIndicator(target);
            added = true;
          }
        }
        if (added) {
          this.refreshStatusPill();
          this.scheduleFlushViewportQueue();
        }
      },
      {
        root: null,
        rootMargin: VIEWPORT_ROOT_MARGIN,
        threshold: 0,
      },
    );
    return this.intersectionObserver;
  }

  private evictFarScrolledInFlightP1Batches(): void {
    if (!this.active) return;

    if (this.fallbackOffscreenBlocks.size > 0) {
      const newlyReachable: HTMLElement[] = [];
      for (const blk of Array.from(this.fallbackOffscreenBlocks)) {
        if (!blk.isConnected) {
          this.fallbackOffscreenBlocks.delete(blk);
          this.observedBlocks.delete(blk);
          continue;
        }
        const st = this.classifyBlockViewportState(blk);
        if (st.isStrictlyVisible || st.isWithinLookahead) {
          this.fallbackOffscreenBlocks.delete(blk);
          this.observedBlocks.delete(blk);
          newlyReachable.push(blk);
        }
      }
      if (newlyReachable.length > 0) {
        this.registerBlocksForViewport(newlyReachable);
      }
    }

    if (this.inFlightP1Batches.size === 0) return;

    let didEvictAny = false;
    for (const tracker of Array.from(this.inFlightP1Batches)) {
      if (tracker.hasReceivedAnyItem || tracker.controller.signal.aborted) {
        continue;
      }
      const connectedTasks = tracker.tasks.filter((t) => t.block.isConnected);
      if (connectedTasks.length === 0) continue;

      const allFarAway = connectedTasks.every(
        (t) => this.classifyBlockViewportState(t.block).shouldEvictInFlightP1,
      );
      if (!allFarAway) continue;

      tracker.abortedByFastScroll = true;
      this.inFlightP1Batches.delete(tracker);
      this.sessionTotalBlocks = Math.max(
        this.sessionDoneBlocks,
        this.sessionTotalBlocks - tracker.tasks.length,
      );

      this.runInternalDomMutation(() => {
        for (const task of tracker.tasks) {
          this.inFlightBlocks.delete(task.block);
          this.inFlightBlockSet.delete(task.block);
          this.inFlightBlockPromises.delete(task.block);
          this.observedBlocks.delete(task.block);
          if (!this.hasMountedTranslation(task.block)) {
            this.clearBlockInjectedElements(task.block);
            this.restoreUnclampedForBlock(task.block);
          }
          if (task.block.isConnected && !this.hasMountedTranslation(task.block)) {
            this.observeOffscreenBlock(task.block);
          }
        }
      });

      tracker.controller.abort();
      didEvictAny = true;
    }

    if (didEvictAny) {
      this.refreshStatusPill();
    }
  }

  private ensureScrollEvictionListener(): void {
    if (this.scrollCleanup) return;
    const win =
      this.doc.defaultView ?? (typeof window !== 'undefined' ? window : null);
    if (!win) return;

    const onScroll = () => {
      if (!this.active) return;
      const now = Date.now();
      const elapsed =
        this.lastScrollCheckAt === 0
          ? Number.POSITIVE_INFINITY
          : now - this.lastScrollCheckAt;

      if (elapsed >= SCROLL_EVICTION_THROTTLE_MS && this.scrollThrottleTimer === null) {
        this.lastScrollCheckAt = now;
        this.evictFarScrolledInFlightP1Batches();
        return;
      }

      if (this.scrollThrottleTimer !== null) return;
      const waitMs = Math.max(
        1,
        SCROLL_EVICTION_THROTTLE_MS - Math.max(0, elapsed),
      );
      this.scrollThrottleTimer = setTimeout(() => {
        this.scrollThrottleTimer = null;
        this.lastScrollCheckAt = Date.now();
        this.evictFarScrolledInFlightP1Batches();
      }, waitMs);
    };

    win.addEventListener('scroll', onScroll, { passive: true });
    this.scrollCleanup = () => {
      win.removeEventListener('scroll', onScroll);
      if (this.scrollThrottleTimer !== null) {
        clearTimeout(this.scrollThrottleTimer);
        this.scrollThrottleTimer = null;
      }
      this.lastScrollCheckAt = 0;
    };
  }

  private syncStaleBlockBeforeRegister(
    block: HTMLElement,
    fromSpaRescan: boolean,
  ): void {
    if (this.hasMountedTranslation(block)) {
      const currentSource =
        this.prepareBlockTask(block, 'webpage')?.tokenized.text.trim() ?? '';
      const prevSource = this.mountedMeta.get(block)?.sourceText.trim() ?? '';
      if (!currentSource || currentSource !== prevSource) {
        this.removeBlockTranslation(block);
        this.observedBlocks.delete(block);
        this.fallbackOffscreenBlocks.delete(block);
        this.intersectionObserver?.unobserve(block);
        this.failedBlockTasks.delete(block);
      }
      return;
    }

    if (
      this.mountedMeta.has(block) ||
      block.getAttribute('data-margin-translated') === 'true'
    ) {
      this.removeBlockTranslation(block);
      this.observedBlocks.delete(block);
      this.fallbackOffscreenBlocks.delete(block);
      this.intersectionObserver?.unobserve(block);
    }

    const failedTask = this.failedBlockTasks.get(block);
    if (failedTask) {
      const currentSource =
        this.prepareBlockTask(block, 'webpage')?.tokenized.text.trim() ?? '';
      if (!currentSource || currentSource !== failedTask.tokenized.text.trim()) {
        this.failedBlockTasks.delete(block);
        this.observedBlocks.delete(block);
        this.fallbackOffscreenBlocks.delete(block);
        this.intersectionObserver?.unobserve(block);
        this.runInternalDomMutation(() => {
          this.clearBlockInjectedElements(block);
          this.restoreUnclampedForBlock(block);
        });
      }
      return;
    }

    if (
      fromSpaRescan &&
      !this.inFlightBlocks.has(block) &&
      !this.pendingViewportQueue.has(block) &&
      this.observedBlocks.has(block)
    ) {
      this.observedBlocks.delete(block);
      this.fallbackOffscreenBlocks.delete(block);
      this.intersectionObserver?.unobserve(block);
    }
  }

  private registerBlocksForViewport(
    blocks: readonly HTMLElement[],
    options: { fromSpaRescan?: boolean } = {},
  ): void {
    const missesForObserver: HTMLElement[] = [];
    const candidateP0: PreparedBlockTask[] = [];
    const candidateP1: PreparedBlockTask[] = [];
    const fromSpaRescan = Boolean(options.fromSpaRescan);

    for (const block of blocks) {
      if (!block.isConnected) continue;
      this.syncStaleBlockBeforeRegister(block, fromSpaRescan);
      if (this.hasMountedTranslation(block) || this.failedBlockTasks.has(block)) {
        continue;
      }

      const prepared = this.prepareBlockTask(block, 'webpage');
      if (!prepared) continue;
      const cached = this.cache.get(prepared.cacheKey);
      if (cached) {
        this.mountBlockTranslation(block, prepared.tokenized, cached.trans);
        continue;
      }

      if (this.observedBlocks.has(block) || this.inFlightBlocks.has(block)) {
        continue;
      }

      const vpState = this.classifyBlockViewportState(block);
      if (vpState.isStrictlyVisible) {
        this.observedBlocks.add(block);
        candidateP0.push(prepared);
      } else if (vpState.isWithinLookahead) {
        this.observedBlocks.add(block);
        candidateP1.push(prepared);
      } else {
        missesForObserver.push(block);
      }
    }

    const canFireHeroWave =
      this.translatedBlockSet.size === 0 &&
      this.inFlightBlockSet.size === 0 &&
      this.pendingViewportQueue.size === 0 &&
      candidateP0.length > 0;

    let p0StartIdx = 0;
    if (canFireHeroWave) {
      const { maxBatchCount, maxCharsPerBatch } =
        this.resolveBatchLimits('webpage');
      const heroMaxBlocks = Math.min(
        HERO_WAVE_MAX_BLOCKS,
        Math.max(1, maxBatchCount),
      );
      const heroMaxChars = Math.min(
        HERO_WAVE_MAX_CHARS,
        Math.max(64, maxCharsPerBatch),
      );
      const heroWaveTasks: PreparedBlockTask[] = [];
      let heroChars = 0;

      while (
        p0StartIdx < candidateP0.length &&
        heroWaveTasks.length < heroMaxBlocks
      ) {
        const nextTask = candidateP0[p0StartIdx];
        if (heroChars + nextTask.charCount > heroMaxChars) {
          break;
        }
        heroWaveTasks.push(nextTask);
        heroChars += nextTask.charCount;
        p0StartIdx += 1;
      }

      if (heroWaveTasks.length > 0) {
        for (const task of heroWaveTasks) {
          this.mountBlockLoadingIndicator(
            task.block,
            task.tokenized.plainTextLength,
          );
        }
        this.sessionTotalBlocks += heroWaveTasks.length;
        this.refreshStatusPill();
        void this.executeBatch(heroWaveTasks, { priority: 0 });
      }
    }

    let queuedDeferred = false;
    for (let i = p0StartIdx; i < candidateP0.length; i++) {
      const task = candidateP0[i];
      this.pendingViewportQueue.set(task.block, {
        scene: 'webpage',
        priority: 0,
      });
      this.mountBlockLoadingIndicator(
        task.block,
        task.tokenized.plainTextLength,
      );
      queuedDeferred = true;
    }
    for (const task of candidateP1) {
      this.pendingViewportQueue.set(task.block, {
        scene: 'webpage',
        priority: 1,
      });
      this.mountBlockLoadingIndicator(
        task.block,
        task.tokenized.plainTextLength,
      );
      queuedDeferred = true;
    }

    if (queuedDeferred) {
      this.refreshStatusPill();
      this.scheduleFlushViewportQueue();
    }

    for (const block of missesForObserver) {
      this.observeOffscreenBlock(block);
    }
  }

  private isMarginInternalNode(node: Node): boolean {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = node as Element;
    return (
      el.hasAttribute('data-margin-injected') ||
      el.hasAttribute('data-margin-host') ||
      el.getAttribute('data-margin-orig-wrap') === 'true'
    );
  }

  private isInsideMarginInjectedOrHost(node: Node | null): boolean {
    let curr: Node | null = node;
    while (curr) {
      if (curr.nodeType === Node.ELEMENT_NODE) {
        const el = curr as Element;
        if (
          el.hasAttribute('data-margin-injected') ||
          el.hasAttribute('data-margin-host')
        ) {
          return true;
        }
      }
      curr = curr.parentNode;
    }
    return false;
  }

  private scanAndRegisterSpaRoots(roots: readonly ParentNode[]): void {
    if (typeof Node === 'undefined' || typeof Element === 'undefined') return;
    const discovered = new Set<HTMLElement>();
    const staleCheckCandidates = new Set<HTMLElement>();

    for (const r of roots) {
      if (r instanceof Node && !r.isConnected) continue;

      if (r instanceof Element) {
        const enclosingTranslated = r.closest<HTMLElement>(
          '[data-margin-translated="true"]',
        );
        if (enclosingTranslated) {
          staleCheckCandidates.add(enclosingTranslated);
        }
        const descTranslated = r.querySelectorAll<HTMLElement>(
          '[data-margin-translated="true"]',
        );
        for (let i = 0; i < descTranslated.length; i++) {
          staleCheckCandidates.add(descTranslated[i]);
        }
      } else if (typeof r.querySelectorAll === 'function') {
        const descTranslated = r.querySelectorAll<HTMLElement>(
          '[data-margin-translated="true"]',
        );
        for (let i = 0; i < descTranslated.length; i++) {
          staleCheckCandidates.add(descTranslated[i]);
        }
      }

      for (const blk of staleCheckCandidates) {
        if (blk.isConnected) {
          this.syncStaleBlockBeforeRegister(blk, true);
        }
      }
      staleCheckCandidates.clear();

      for (const blk of extractParagraphBlocks(r, {
        targetLang: this.config.targetLang,
      })) {
        discovered.add(blk);
      }

      if (r instanceof Node) {
        const enclosing = findClosestParagraphBlock(r, {
          targetLang: this.config.targetLang,
        });
        if (enclosing) {
          discovered.add(enclosing);
        }
      }
    }

    if (discovered.size > 0) {
      this.registerBlocksForViewport(Array.from(discovered), {
        fromSpaRescan: true,
      });
    }
  }

  /**
   * Re-scans `root` (defaulting to `doc.body`) during SPA navigations (`yt-navigate-finish`,
   * `popstate`, `hashchange`) to invalidate recycled blocks and queue newly hydrated prose.
   */
  rescanSubtree(root?: ParentNode | null): void {
    if (!this.active) return;
    const targetRoot = root ?? this.doc.body;
    if (!targetRoot) return;
    this.scanAndRegisterSpaRoots([targetRoot]);
  }

  private processSpaMutations(mutations: readonly MutationRecord[]): void {
    if (!this.active || this.internalDomDepth > 0) return;

    let hasExternalMutation = false;

    for (const m of mutations) {
      if (this.isInsideMarginInjectedOrHost(m.target)) continue;

      if (m.type === 'childList') {
        const rawTargetEl = m.target instanceof Element ? m.target : null;
        const effectiveTargetEl =
          rawTargetEl?.getAttribute('data-margin-orig-wrap') === 'true'
            ? rawTargetEl.parentElement
            : rawTargetEl;
        if (effectiveTargetEl && this.isMarginInternalNode(effectiveTargetEl)) {
          continue;
        }

        for (let i = 0; i < m.addedNodes.length; i++) {
          const added = m.addedNodes[i];
          if (this.isMarginInternalNode(added)) continue;
          if (added.nodeType === Node.ELEMENT_NODE) {
            this.pendingSpaRoots.add(
              rawTargetEl !== effectiveTargetEl && effectiveTargetEl
                ? effectiveTargetEl
                : (added as Element),
            );
            hasExternalMutation = true;
          } else if (
            added.nodeType === Node.TEXT_NODE &&
            added.nodeValue?.trim() &&
            effectiveTargetEl
          ) {
            this.pendingSpaRoots.add(effectiveTargetEl);
            hasExternalMutation = true;
          }
        }

        if (m.removedNodes.length > 0 && effectiveTargetEl) {
          for (let i = 0; i < m.removedNodes.length; i++) {
            const removed = m.removedNodes[i];
            if (
              removed.nodeType === Node.ELEMENT_NODE &&
              (removed as Element).getAttribute('data-margin-injected') ===
                'true'
            ) {
              this.pendingSpaRoots.add(effectiveTargetEl);
              hasExternalMutation = true;
              break;
            }
            if (
              effectiveTargetEl.closest('[data-margin-translated="true"]') !==
              null
            ) {
              this.pendingSpaRoots.add(effectiveTargetEl);
              hasExternalMutation = true;
              break;
            }
          }
        }
      } else if (m.type === 'characterData') {
        const rawParent = m.target.parentElement;
        const targetEl =
          rawParent?.getAttribute('data-margin-orig-wrap') === 'true'
            ? rawParent.parentElement
            : rawParent;
        if (
          targetEl &&
          !this.isMarginInternalNode(targetEl) &&
          (m.target.nodeValue?.trim() ||
            targetEl.closest('[data-margin-translated="true"]') !== null)
        ) {
          this.pendingSpaRoots.add(targetEl);
          hasExternalMutation = true;
        }
      } else if (m.type === 'attributes') {
        if (
          !(m.target instanceof Element) ||
          this.isMarginInternalNode(m.target)
        ) {
          continue;
        }
        const attrName = m.attributeName;
        if (
          (attrName === 'is-empty' || attrName === 'hidden') &&
          !m.target.hasAttribute(attrName)
        ) {
          this.pendingSpaRoots.add(m.target);
          hasExternalMutation = true;
        }
      }
    }

    if (hasExternalMutation && this.spaMutationTimer === null) {
      this.spaMutationTimer = setTimeout(() => {
        this.spaMutationTimer = null;
        if (!this.active || this.pendingSpaRoots.size === 0) return;
        const roots = Array.from(this.pendingSpaRoots);
        this.pendingSpaRoots.clear();
        this.scanAndRegisterSpaRoots(roots);
      }, SPA_MUTATION_DEBOUNCE_MS);
    }
  }

  private ensureSpaMutationObserver(): void {
    if (this.mutationObserver || typeof MutationObserver === 'undefined') return;
    const root = this.doc.body;
    if (!root) return;

    this.mutationObserver = new MutationObserver((mutations) => {
      this.processSpaMutations(mutations);
    });

    this.mutationObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['is-empty', 'hidden'],
    });
  }

  /**
   * Enables progressive viewport webpage translation + SPA virtual-scroll observer.
   */
  enablePageTranslation(): void {
    this.active = true;
    this.lastError = undefined;
    this.sessionTotalBlocks = 0;
    this.sessionDoneBlocks = 0;
    this.ensureStylesInjected();
    this.ensureScrollEvictionListener();
    const blocks = extractParagraphBlocks(this.doc.body, {
      targetLang: this.config.targetLang,
    });
    this.registerBlocksForViewport(blocks);
    this.ensureSpaMutationObserver();
  }

  /**
   * Translates all readable blocks across the entire document immediately (`Alt+W`).
   */
  async translateWholePage(): Promise<void> {
    this.active = true;
    this.lastError = undefined;
    this.failedBlockTasks.clear();
    this.sessionTotalBlocks = 0;
    this.sessionDoneBlocks = 0;
    this.ensureStylesInjected();
    this.ensureScrollEvictionListener();
    this.ensureSpaMutationObserver();
    const blocks = extractParagraphBlocks(this.doc.body, {
      targetLang: this.config.targetLang,
    });
    await this.translateBlocks(blocks, 'webpage', { fullPage: true });
  }

  async translateFullPage(): Promise<void> {
    return this.translateWholePage();
  }

  disable(): void {
    this.restorePage();
  }

  /**
   * Disables webpage translation and cleanly restores the exact original DOM
   * (including unwrapping `target-only` blocks) with zero page reload.
   */
  restorePage(options: { onlyOwnedNodes?: boolean } = {}): void {
    const onlyOwned = Boolean(options.onlyOwnedNodes);
    const ownedBlocksSnapshot = new Set<HTMLElement>(this.translatedBlockSet);
    for (const blk of this.failedBlockTasks.keys()) {
      ownedBlocksSnapshot.add(blk);
    }
    for (const blk of this.inFlightBlockSet) {
      ownedBlocksSnapshot.add(blk);
    }

    this.active = false;
    this.lastBatchTailContext = '';

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.spaMutationTimer !== null) {
      clearTimeout(this.spaMutationTimer);
      this.spaMutationTimer = null;
    }
    this.scrollCleanup?.();
    this.scrollCleanup = null;
    this.pendingViewportQueue.clear();
    this.fallbackOffscreenBlocks.clear();
    this.pendingSpaRoots.clear();

    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;

    this.mutationObserver?.disconnect();
    this.mutationObserver = null;

    // Reset observedBlocks so re-enabling page translation or switching language re-observes cleanly!
    this.observedBlocks = new WeakSet<HTMLElement>();

    for (const ctrl of Array.from(this.activeControllers)) {
      ctrl.abort();
    }
    this.activeControllers.clear();
    this.inFlightP1Batches.clear();
    this.inFlightBlockSet.clear();
    this.translatedBlockSet.clear();
    this.failedBlockTasks.clear();
    this.sessionTotalBlocks = 0;
    this.sessionDoneBlocks = 0;
    this.lastError = undefined;
    this.hideStatusPill();

    this.runInternalDomMutation(() => {
      if (onlyOwned) {
        for (const node of Array.from(this.ownedInjectedNodes)) {
          this.ownedInjectedNodes.delete(node);
          node.remove();
        }

        const wrappedBlocks = new Set<HTMLElement>();
        for (const w of Array.from(this.ownedOrigWrappers)) {
          this.ownedOrigWrappers.delete(w);
          if (w.parentElement instanceof HTMLElement) {
            wrappedBlocks.add(w.parentElement);
          } else {
            w.remove();
          }
        }
        for (const blk of wrappedBlocks) {
          this.unwrapOriginalContent(blk);
        }

        for (const blk of ownedBlocksSnapshot) {
          this.mountedMeta.delete(blk);
          if (!this.hasMountedTranslation(blk)) {
            blk.removeAttribute('data-margin-translated');
          }
          this.restoreUnclampedForBlock(blk);
        }
        return;
      }

      const injectedNodes = Array.from(
        this.doc.querySelectorAll('[data-margin-injected="true"]'),
      );
      for (const node of injectedNodes) {
        if (node.id === STYLE_ELEMENT_ID) continue;
        this.ownedInjectedNodes.delete(node);
        node.remove();
      }
      this.ownedInjectedNodes.clear();

      const wrappedBlocks = new Set<HTMLElement>();
      const wrappers = Array.from(
        this.doc.querySelectorAll('[data-margin-orig-wrap="true"]'),
      );
      for (const w of wrappers) {
        if (w.parentElement instanceof HTMLElement) {
          wrappedBlocks.add(w.parentElement);
        }
      }
      for (const blk of wrappedBlocks) {
        this.unwrapOriginalContent(blk);
      }
      this.ownedOrigWrappers.clear();

      const markedBlocks = Array.from(
        this.doc.querySelectorAll<HTMLElement>('[data-margin-translated="true"]'),
      );
      for (const blk of markedBlocks) {
        blk.removeAttribute('data-margin-translated');
      }

      this.restoreAllUnclampedElements();
    });
  }

  /**
   * Toggles page translation ON or OFF (`Alt+A` / `margin:cmd:toggle-page`).
   */
  togglePageTranslation(): boolean {
    if (this.active) {
      this.restorePage();
      return false;
    }
    this.enablePageTranslation();
    return true;
  }

  /**
   * Toggles global `mask` blur reveal across the page (`Alt+M` / `margin:cmd:toggle-mask`).
   */
  toggleGlobalMask(): boolean {
    this.maskRevealedGlobally = !this.maskRevealedGlobally;
    const rootEl = this.doc.documentElement;
    if (rootEl) {
      this.runInternalDomMutation(() => {
        if (this.maskRevealedGlobally) {
          rootEl.setAttribute('data-margin-mask-revealed', 'true');
        } else {
          rootEl.removeAttribute('data-margin-mask-revealed');
        }
      });
    }
    return this.maskRevealedGlobally;
  }

  private computeTranslationConfigSignature(cfg: MarginConfig): string {
    const providerId = resolveProviderIdForScene(
      'webpage',
      cfg.routing,
      cfg.providers,
    );
    const provider = cfg.providers[providerId];
    const assistant = provider?.assistantId
      ? cfg.assistants[provider.assistantId]
      : undefined;
    return JSON.stringify([
      cfg.sourceLang,
      cfg.targetLang,
      cfg.webpage.enableRichHtml,
      providerId,
      provider?.model ?? '',
      provider?.assistantId ?? '',
      assistant?.codec ?? '',
      assistant?.systemPrompt ?? '',
      assistant?.prompt ?? '',
      assistant?.multiplePrompt ?? '',
      hashGlossaryFingerprint(cfg.glossary),
      (cfg.enabledGlossaryPacks ?? []).join(','),
    ]);
  }

  /**
   * Applies live configuration changes:
   * - If `targetLang`, `sourceLang`, active provider/model/assistant, or glossary changed while
   *   page translation is active, cleanly restores and re-runs `enablePageTranslation()`.
   * - Otherwise updates `theme`, `displayMode`, and `uiColorMode` in place with zero API calls.
   */
  updateConfig(nextConfig: MarginConfig): void {
    const prevSig = this.computeTranslationConfigSignature(this.config);
    const nextSig = this.computeTranslationConfigSignature(nextConfig);
    const prevDisplayMode = this.config.webpage.displayMode;
    const prevTargetLang = this.config.targetLang;
    this.config = nextConfig;

    if (this.statusHost) {
      this.statusHost.setAttribute('data-display-mode', nextConfig.uiColorMode);
    }

    if (this.active && prevSig !== nextSig) {
      this.restorePage();
      this.enablePageTranslation();
      return;
    }

    const effectiveTheme = this.resolveEffectiveTheme();
    const newDisplayMode = nextConfig.webpage.displayMode;

    this.runInternalDomMutation(() => {
      const spans = Array.from(
        this.doc.querySelectorAll<HTMLElement>(
          '.margin-trans-root[data-margin-injected="true"]',
        ),
      );
      for (const span of spans) {
        span.setAttribute('data-margin-theme', effectiveTheme);
        const parentBlock = span.parentElement;
        if (!parentBlock) continue;

        if (prevTargetLang !== nextConfig.targetLang) {
          this.applyTargetLocaleTypography(span, parentBlock);
        }

        if (prevDisplayMode !== newDisplayMode) {
          if (newDisplayMode === 'target-only') {
            this.wrapOriginalContentForTargetOnly(parentBlock);
          } else {
            this.unwrapOriginalContent(parentBlock);
          }
        }

        const meta = this.mountedMeta.get(parentBlock);
        if (
          prevDisplayMode !== newDisplayMode &&
          newDisplayMode === 'bilingual' &&
          meta &&
          isRedundantIdenticalTranslation(meta.sourceText, meta.translatedText)
        ) {
          this.clearBlockInjectedElements(parentBlock);
          this.unwrapOriginalContent(parentBlock);
          this.restoreUnclampedForBlock(parentBlock);
          parentBlock.removeAttribute('data-margin-translated');
          this.mountedMeta.delete(parentBlock);
          this.translatedBlockSet.delete(parentBlock);
          continue;
        }

        const plainLen = meta?.plainTextLength ?? (span.textContent?.length ?? 0);
        span.setAttribute(
          'data-margin-layout',
          this.computeLayoutMode(parentBlock, plainLen, newDisplayMode),
        );
        this.unclampForInjectedNode(parentBlock, span);
      }
    });
  }

  destroy(options: { contextInvalidated?: boolean } = {}): void {
    const contextInvalidated = Boolean(options.contextInvalidated);
    this.restorePage({ onlyOwnedNodes: contextInvalidated });
    this.clearStatusHideTimer();
    this.statusHost?.remove();
    this.statusHost = null;
    this.statusPillEl = null;
    this.statusSpinnerEl = null;
    this.statusLabelEl = null;
    this.statusHintEl = null;
    this.statusActionBtn = null;
    this.statusCloseBtn = null;
    this.fullscreenCleanup?.();
    this.fullscreenCleanup = null;
    if (
      !contextInvalidated ||
      !this.doc.querySelector(
        '.margin-trans-root, .margin-trans-loading, .margin-inline-retry',
      )
    ) {
      this.doc.getElementById(STYLE_ELEMENT_ID)?.remove();
    }
  }
}
