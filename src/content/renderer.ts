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
  clearNativelyHiddenChildrenSnapshot,
  extractFocalThreadContext,
  extractPageContext,
  extractParagraphBlocks,
  findClosestParagraphBlock,
  findFirstDirectBlockBoundaryChild,
  hasNestedBlockChildren,
  inferDomainStyleGuide,
  isAtomicInlineElement,
  isBlockBoundaryElement,
  snapshotNativelyHiddenChildrenBeforeSrcHide,
} from './dom-walker';
import {
  applyEffectiveHostTextStyle,
  resolveEffectiveHostTextStyle,
} from './effective-text-style';
import {
  RecentPrefixStore,
  classifySourceChange,
  isBoundarySegmentExpansion,
  normalizePlainForPrefix,
} from './expansion';
import {
  extractPlainFromTokenized,
  reconstructRichDom,
  refreshClonedLinksAppearance,
  splitTokenizedIntoSegments,
  stripResidualMarkers,
  tokenizeParagraph,
  type RichTokenDescriptor,
  type TokenizedParagraph,
  type TokenizedSegment,
} from './rich-text';

export * from './effective-text-style';

const THEME_OBSERVER_ATTRIBUTES: string[] = [
  'class',
  'style',
  'dark',
  'theme',
  'data-theme',
  'data-color-mode',
  'data-bs-theme',
  'color-scheme',
];

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

[data-margin-src-hidden="true"] > :not([data-margin-injected]):not([data-margin-host]) {
  display: none !important;
}

.margin-trans-seg {
  display: inline;
}

.margin-trans-root[data-margin-injected="true"],
.margin-trans-block[data-margin-injected="true"] {
  font-size: var(--margin-effective-font-size, inherit);
  font-weight: var(--margin-effective-font-weight, inherit);
  font-style: inherit;
  font-stretch: inherit;
  font-variant: inherit;
  line-height: var(--margin-effective-line-height, inherit);
  letter-spacing: var(--margin-effective-letter-spacing, inherit);
  color: var(--margin-effective-color, inherit);
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

:where(.margin-trans-root[data-margin-injected="true"]) :where(a) {
  color: var(--margin-link-color, var(--margin-effective-color, inherit));
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
  text-underline-offset: 2px;
}

:where(.margin-trans-root[data-margin-injected="true"]) :where(a):hover {
  text-decoration-color: currentColor;
}

.margin-trans-root[data-margin-injected="true"] a[data-margin-has-link-color="true"] {
  color: var(--margin-link-color);
}

.margin-trans-root[data-margin-injected="true"] a[data-margin-no-underline="true"]:not(:hover) {
  text-decoration: none;
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
  color: color-mix(in srgb, var(--margin-effective-color, currentColor) 74%, #8d877a 26%);
  transition:
    opacity 160ms cubic-bezier(0.2, 0.72, 0.2, 1),
    color 160ms cubic-bezier(0.2, 0.72, 0.2, 1);
}

.margin-trans-root[data-margin-theme="weakening"]:hover,
.margin-trans-root[data-margin-theme="weakening"]:focus-within {
  opacity: 1;
  color: var(--margin-effective-color, inherit);
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
  color: color-mix(in srgb, #c99455 64%, var(--margin-effective-color, currentColor) 36%);
  background: color-mix(in srgb, #c99455 12%, transparent);
  border: 1px solid color-mix(in srgb, #c99455 40%, transparent);
  border-radius: 4px;
  cursor: pointer;
  vertical-align: baseline;
  user-select: none;
  transition:
    background-color 160ms cubic-bezier(0.2, 0.72, 0.2, 1),
    border-color 160ms cubic-bezier(0.2, 0.72, 0.2, 1);
}

.margin-inline-retry[data-margin-injected="true"]:hover {
  background: color-mix(in srgb, #c99455 22%, transparent);
  border-color: color-mix(in srgb, #c99455 58%, transparent);
  color: color-mix(in srgb, #c99455 78%, var(--margin-effective-color, currentColor) 22%);
}

.margin-inline-retry[data-margin-injected="true"]:focus-visible {
  outline: 2px solid #c99455;
  outline-offset: 1px;
}

[data-margin-floating="true"][data-margin-fullscreen-hidden="true"] {
  display: none !important;
}

.margin-trans-tail-shimmer[data-margin-injected="true"] {
  display: inline-block;
  width: 2.4em;
  height: 0.78em;
  min-height: 9px;
  max-height: 14px;
  margin-inline-start: 0.38em;
  vertical-align: -0.08em;
  border-radius: 4px;
  background-color: color-mix(in srgb, currentColor 8%, transparent);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(185, 131, 61, 0.18) 50%,
    transparent 100%
  );
  background-size: 220% 100%;
  background-position: 120% 0;
  animation: margin-shimmer-sweep 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  user-select: none;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .margin-trans-root[data-margin-injected="true"],
  .margin-inline-retry[data-margin-injected="true"] {
    transition: none !important;
  }
  .margin-shimmer-line,
  .margin-trans-tail-shimmer[data-margin-injected="true"] {
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

  delete(key: string): boolean {
    return this.store.delete(key);
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
  isUserActivationActive?: () => boolean;
}

type SegState =
  | 'pending'
  | 'pinned'
  | 'streaming'
  | 'done'
  | 'failed'
  | 'identity';

interface PriorSegmentSnapshot {
  sourceText: string;
  plain: string;
  translatedText: string;
}

interface PriorBlockSnapshot {
  blockPlain: string;
  segments: PriorSegmentSnapshot[];
}

interface PlanSegment extends TokenizedSegment {
  cacheKey: string;
  state: SegState;
  trans?: string;
  fallbackPlain?: boolean;
  hadPinnedTrans?: boolean;
  pinnedPlainLen?: number;
  pinnedRichTokenized?: TokenizedParagraph;
  pinnedSourceText?: string;
  pinnedSourcePlain?: string;
  staleSettledTrans?: string;
  holdUntilFinal?: boolean;
  lastPaintLen: number;
  domEl?: HTMLSpanElement;
  streamTextNode?: Text;
}

interface BlockPlan {
  block: HTMLElement;
  scene: TranslationScene;
  blockSourceText: string;
  blockPlain: string;
  segments: PlanSegment[];
  controllers: Set<AbortController>;
  batchPromises: Set<Promise<void>>;
  inFlightBatches: number;
  superseded: boolean;
  forceBilingual: boolean;
  isExpansionFromPrior: boolean;
  hasPendingGrowth?: boolean;
}

interface PreparedBlockTask {
  block: HTMLElement;
  tokenized: TokenizedParagraph;
  cacheKey: string;
  charCount: number;
  scene: TranslationScene;
  seg?: { plan: BlockPlan; index: number };
  superseded?: boolean;
  controller?: AbortController;
  settled?: boolean;
}

interface MountedBlockMeta {
  plainTextLength: number;
  plain: string;
  fallbackPlain: boolean;
  sourceText: string;
  translatedText: string;
  segments?: PriorSegmentSnapshot[];
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

function hashAssistantFingerprint(
  assistant: MarginConfig['assistants'][string] | undefined,
): string {
  if (!assistant) return '0';
  const envEntries = assistant.env
    ? Object.entries(assistant.env).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )
    : [];
  const payload = JSON.stringify([
    assistant.codec ?? '',
    assistant.separator ?? '',
    assistant.temperaturePolicy ?? null,
    assistant.systemPrompt ?? '',
    assistant.multipleSystemPrompt ?? '',
    assistant.prompt ?? '',
    assistant.multiplePrompt ?? '',
    assistant.inputPrompt ?? '',
    assistant.selectionPrompt ?? '',
    assistant.subtitlePrompt ?? '',
    envEntries,
  ]);
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
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
  private themeObserver: MutationObserver | null = null;
  private themeObservedBody: Element | null = null;
  private themeMediaCleanup: (() => void) | null = null;
  private cancelScheduledThemeSync: (() => void) | null = null;
  private fullscreenCleanup: (() => void) | null = null;
  private scrollCleanup: (() => void) | null = null;
  private scrollThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScrollCheckAt = 0;

  private observedBlocks = new WeakSet<HTMLElement>();
  private inFlightBlocks = new WeakSet<HTMLElement>();
  private readonly inFlightBlockSet = new Set<HTMLElement>();
  private readonly translatedBlockSet = new Set<HTMLElement>();
  private readonly failedBlockTasks = new Map<HTMLElement, PreparedBlockTask>();
  private inFlightBlockPromises = new WeakMap<HTMLElement, Promise<void>>();
  private sessionGen = 0;
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

  private readonly customIsUserActivationActive?: () => boolean;
  private userInteractionCleanup: (() => void) | null = null;
  private lastUserInteractionAt = 0;

  private readonly blockPlans = new Map<HTMLElement, BlockPlan>();
  private readonly recentPrefixes = new RecentPrefixStore();
  private readonly hiddenSourceBlocks = new Set<HTMLElement>();
  private readonly batchTasksByController = new Map<
    AbortController,
    readonly PreparedBlockTask[]
  >();
  private readonly inFlightTasksByBlock = new Map<
    HTMLElement,
    Set<PreparedBlockTask>
  >();
  private readonly maskClickBoundRoots = new WeakSet<Element>();

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
    this.customIsUserActivationActive = options.isUserActivationActive;

    this.bindFullscreenListener();
    this.bindUserInteractionListener();
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

  private pruneDisconnectedNodes(): void {
    for (const node of Array.from(this.ownedInjectedNodes)) {
      if (!node.isConnected) {
        this.ownedInjectedNodes.delete(node);
      }
    }
    for (const wrapper of Array.from(this.ownedOrigWrappers)) {
      if (!wrapper.isConnected) {
        this.ownedOrigWrappers.delete(wrapper);
      }
    }
    for (const blk of Array.from(this.failedBlockTasks.keys())) {
      if (!blk.isConnected) {
        this.failedBlockTasks.delete(blk);
      }
    }
    for (const blk of Array.from(this.translatedBlockSet)) {
      if (!blk.isConnected || !this.hasMountedTranslation(blk)) {
        this.translatedBlockSet.delete(blk);
      }
    }
    for (const [blk, plan] of Array.from(this.blockPlans.entries())) {
      if (!blk.isConnected) {
        this.supersedePlan(plan);
        this.blockPlans.delete(blk);
      }
    }
    for (const blk of Array.from(this.hiddenSourceBlocks)) {
      if (!blk.isConnected) {
        this.hiddenSourceBlocks.delete(blk);
      }
    }
    for (const blk of Array.from(this.inFlightBlockSet)) {
      if (!blk.isConnected) {
        this.inFlightBlockSet.delete(blk);
      }
    }
  }

  getPageState(): TabPageState {
    this.pruneDisconnectedNodes();
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
    this.recentPrefixes.clear();
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

  private bindUserInteractionListener(): void {
    if (this.userInteractionCleanup) return;
    const onInteract = () => {
      this.lastUserInteractionAt = Date.now();
    };
    this.doc.addEventListener('pointerdown', onInteract, {
      capture: true,
      passive: true,
    });
    this.doc.addEventListener('keydown', onInteract, {
      capture: true,
      passive: true,
    });
    this.doc.addEventListener('click', onInteract, {
      capture: true,
      passive: true,
    });
    this.userInteractionCleanup = () => {
      this.doc.removeEventListener('pointerdown', onInteract, true);
      this.doc.removeEventListener('keydown', onInteract, true);
      this.doc.removeEventListener('click', onInteract, true);
    };
  }

  private isUserInitiatedNow(): boolean {
    if (this.customIsUserActivationActive) {
      return Boolean(this.customIsUserActivationActive());
    }
    const nav = (
      this.doc.defaultView?.navigator ??
      (typeof navigator !== 'undefined' ? navigator : undefined)
    ) as (Navigator & { userActivation?: { isActive?: boolean } }) | undefined;
    if (nav?.userActivation?.isActive) {
      return true;
    }
    return (
      this.lastUserInteractionAt > 0 &&
      Date.now() - this.lastUserInteractionAt <= 1500
    );
  }

  private bindMaskClickToggle(container: HTMLElement): void {
    if (this.maskClickBoundRoots.has(container)) return;
    this.maskClickBoundRoots.add(container);
    container.addEventListener('click', (ev) => {
      if (container.getAttribute('data-margin-theme') !== 'mask') return;
      const target = ev.target as Element | null;
      if (target?.closest?.('a, button')) return;
      const currentlyUnmasked =
        container.getAttribute('data-margin-item-unmasked') === 'true';
      if (currentlyUnmasked) {
        container.removeAttribute('data-margin-item-unmasked');
      } else {
        container.setAttribute('data-margin-item-unmasked', 'true');
      }
    });
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
    const assistant = assistantId
      ? this.config.assistants[assistantId]
      : undefined;
    const assistantFp = hashAssistantFingerprint(assistant);
    const glossaryFp = hashGlossaryFingerprint(this.config.glossary);
    const packsFp = (this.config.enabledGlossaryPacks ?? []).join(',');
    return `${providerId}:${model}:${assistantId}:${assistantFp}:${this.config.sourceLang}->${this.config.targetLang}:${enableRichHtml ? '1' : '0'}:${glossaryFp}:${packsFp}:${tokenizedText}`;
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

  private findDirectInjectedRoot(blockEl: Element): HTMLSpanElement | null {
    for (let i = 0; i < blockEl.children.length; i++) {
      const child = blockEl.children[i];
      if (
        child instanceof HTMLSpanElement &&
        child.classList.contains('margin-trans-root') &&
        child.getAttribute('data-margin-injected') === 'true'
      ) {
        return child;
      }
    }
    return null;
  }

  private insertInjectedIntoBlock(blockEl: HTMLElement, node: Element): void {
    const firstNestedBlock = findFirstDirectBlockBoundaryChild(blockEl);
    if (firstNestedBlock && firstNestedBlock.parentElement === blockEl) {
      blockEl.insertBefore(node, firstNestedBlock);
    } else {
      blockEl.appendChild(node);
    }
  }

  private ensureInjectedRootAtEnd(blockEl: HTMLElement, root: Element): void {
    const firstNestedBlock = findFirstDirectBlockBoundaryChild(blockEl);
    if (firstNestedBlock && firstNestedBlock.parentElement === blockEl) {
      if (root.nextElementSibling !== firstNestedBlock) {
        blockEl.insertBefore(root, firstNestedBlock);
      }
      return;
    }
    if (root.parentElement !== blockEl) {
      blockEl.appendChild(root);
      return;
    }
    let sib = root.nextSibling;
    while (sib) {
      if (sib.nodeType === Node.TEXT_NODE && sib.nodeValue?.trim()) {
        blockEl.appendChild(root);
        return;
      }
      if (sib.nodeType === Node.ELEMENT_NODE) {
        const sibEl = sib as Element;
        if (
          !sibEl.hasAttribute('data-margin-injected') &&
          !sibEl.hasAttribute('data-margin-host')
        ) {
          blockEl.appendChild(root);
          return;
        }
      }
      sib = sib.nextSibling;
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
    const effectiveStyle = resolveEffectiveHostTextStyle(blockEl);

    this.ensureStylesInjected();
    this.ensureThemeObserver();
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
      applyEffectiveHostTextStyle(loading, effectiveStyle);

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
          const legacyFailed: PreparedBlockTask[] = [];
          const plansToRetry = new Set<BlockPlan>();
          for (const task of failed) {
            const activePlan = this.blockPlans.get(task.block);
            if (activePlan && !activePlan.superseded) {
              plansToRetry.add(activePlan);
            } else if (!task.seg) {
              legacyFailed.push(task);
            }
          }
          for (const plan of plansToRetry) {
            this.retryFailedPlan(plan);
          }
          if (legacyFailed.length > 0) {
            this.runInternalDomMutation(() => {
              for (const task of legacyFailed) {
                this.clearBlockInjectedElements(task.block);
                this.setSourceHidden(task.block, false);
                this.mountBlockLoadingIndicator(
                  task.block,
                  task.tokenized.plainTextLength,
                );
              }
            });
            this.sessionTotalBlocks += legacyFailed.length;
            this.refreshStatusPill();
            void this.executeBatch(legacyFailed, { priority: 0 });
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
    const childSnapshot = Array.from(blockEl.childNodes);
    const runs: ChildNode[][] = [];
    let currentRun: ChildNode[] = [];

    const flushRun = () => {
      if (currentRun.length === 0) return;
      const hasMeaningfulNode = currentRun.some(
        (n) =>
          n.nodeType === Node.ELEMENT_NODE ||
          (n.nodeType === Node.TEXT_NODE && Boolean(n.nodeValue?.trim())),
      );
      if (hasMeaningfulNode) {
        runs.push(currentRun);
      }
      currentRun = [];
    };

    for (const child of childSnapshot) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (
          el.hasAttribute('data-margin-injected') ||
          el.hasAttribute('data-margin-host') ||
          el.getAttribute('data-margin-orig-wrap') === 'true'
        ) {
          flushRun();
          continue;
        }
        if (
          !isAtomicInlineElement(el, { insideParagraph: true }) &&
          (isBlockBoundaryElement(el) || hasNestedBlockChildren(el))
        ) {
          flushRun();
          continue;
        }
      }
      currentRun.push(child);
    }
    flushRun();

    for (const run of runs) {
      const anchor = run[0];
      if (!anchor || anchor.parentNode !== blockEl) continue;
      const wrapper = this.doc.createElement('span');
      wrapper.className = 'margin-orig-source';
      wrapper.setAttribute('data-margin-orig-wrap', 'true');
      wrapper.hidden = true;
      wrapper.style.setProperty('display', 'none', 'important');

      blockEl.insertBefore(wrapper, anchor);
      for (const node of run) {
        wrapper.appendChild(node);
      }
      this.ownedOrigWrappers.add(wrapper);
    }
  }

  private unwrapOriginalContent(blockEl: HTMLElement): void {
    const wrappers: Element[] = [];
    for (let i = 0; i < blockEl.children.length; i++) {
      if (blockEl.children[i].getAttribute('data-margin-orig-wrap') === 'true') {
        wrappers.push(blockEl.children[i]);
      }
    }
    if (wrappers.length === 0) return;

    for (const wrapper of wrappers) {
      while (wrapper.firstChild) {
        blockEl.insertBefore(wrapper.firstChild, wrapper);
      }
      this.ownedOrigWrappers.delete(wrapper);
      wrapper.remove();
    }
  }

  private canHideSourceByCss(blockEl: HTMLElement): boolean {
    for (let i = 0; i < blockEl.childNodes.length; i++) {
      const child = blockEl.childNodes[i];
      if (child.nodeType === Node.TEXT_NODE) {
        if ((child.nodeValue ?? '').trim().length > 0) {
          return false;
        }
        continue;
      }
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (el.getAttribute('data-margin-orig-wrap') === 'true') {
          return false;
        }
      }
    }
    return findFirstDirectBlockBoundaryChild(blockEl) === null;
  }

  private setSourceHidden(blockEl: HTMLElement, hidden: boolean): void {
    if (!hidden) {
      if (blockEl.hasAttribute('data-margin-src-hidden')) {
        blockEl.removeAttribute('data-margin-src-hidden');
      }
      clearNativelyHiddenChildrenSnapshot(blockEl);
      this.hiddenSourceBlocks.delete(blockEl);
      this.unwrapOriginalContent(blockEl);
      return;
    }

    if (this.canHideSourceByCss(blockEl)) {
      snapshotNativelyHiddenChildrenBeforeSrcHide(blockEl);
      if (blockEl.getAttribute('data-margin-src-hidden') !== 'true') {
        blockEl.setAttribute('data-margin-src-hidden', 'true');
      }
      this.hiddenSourceBlocks.add(blockEl);
      return;
    }

    if (blockEl.hasAttribute('data-margin-src-hidden')) {
      blockEl.removeAttribute('data-margin-src-hidden');
      this.hiddenSourceBlocks.delete(blockEl);
    }
    clearNativelyHiddenChildrenSnapshot(blockEl);
    this.wrapOriginalContentForTargetOnly(blockEl);
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
    const existingPlan = this.blockPlans.get(blockEl);
    if (existingPlan) {
      this.supersedePlan(existingPlan);
      this.blockPlans.delete(blockEl);
    } else {
      this.supersedeBlockInFlight(blockEl);
    }
    this.runInternalDomMutation(() => {
      this.clearBlockInjectedElements(blockEl);
      this.setSourceHidden(blockEl, false);
      this.restoreUnclampedForBlock(blockEl);
      blockEl.removeAttribute('data-margin-translated');
      this.mountedMeta.delete(blockEl);
      this.translatedBlockSet.delete(blockEl);
      this.failedBlockTasks.delete(blockEl);
    });
  }

  private recordRecentPrefixIfEligible(
    blockPlain: string,
    lastSegPlain: string,
    lastSegSourceText: string,
    lastSegTranslated: string,
    preservesNewlines: boolean,
    forceBilingual: boolean,
  ): void {
    if (forceBilingual || !preservesNewlines) return;
    if (blockPlain.length < 160) return;
    const configSig = this.computeTranslationConfigSignature(this.config);
    this.recentPrefixes.record({
      configSig,
      blockPlain,
      lastSegPlain,
      lastSegSourceText,
      lastSegTranslated,
      at: Date.now(),
    });
  }

  private mountBlockTranslation(
    blockEl: HTMLElement,
    tokenized: TokenizedParagraph,
    translatedText: string,
    options: { forceBilingual?: boolean } = {},
  ): { fallbackPlain: boolean } {
    const oldPlan = this.blockPlans.get(blockEl);
    if (oldPlan) {
      this.supersedePlan(oldPlan);
      this.blockPlans.delete(blockEl);
    }
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
        this.setSourceHidden(blockEl, false);
        this.restoreUnclampedForBlock(blockEl);
        blockEl.removeAttribute('data-margin-translated');
        this.mountedMeta.delete(blockEl);
        this.translatedBlockSet.delete(blockEl);
        this.failedBlockTasks.delete(blockEl);
      });
      return { fallbackPlain: false };
    }

    const effectiveStyle = resolveEffectiveHostTextStyle(blockEl);
    const reconstructed = reconstructRichDom(
      translatedText,
      tokenized,
      this.doc,
      { stripSourceLocaleAttrs: true, preserveLinkAppearance: true },
    );
    const theme = this.resolveEffectiveTheme();
    const layout = this.computeLayoutMode(
      blockEl,
      tokenized.plainTextLength,
      displayMode,
    );
    const normalizedPlain = normalizePlainForPrefix(
      extractPlainFromTokenized(tokenized),
    );

    this.ensureThemeObserver();
    this.runInternalDomMutation(() => {
      this.clearBlockInjectedElements(blockEl);
      this.setSourceHidden(blockEl, displayMode === 'target-only');

      const span = this.doc.createElement('span');
      span.className = 'margin-trans-root margin-trans-block';
      span.setAttribute('data-margin-injected', 'true');
      span.setAttribute('data-margin-theme', theme);
      span.setAttribute('data-margin-layout', layout);
      this.applyTargetLocaleTypography(span, blockEl);
      applyEffectiveHostTextStyle(span, effectiveStyle);
      if (reconstructed.fallbackPlain) {
        span.setAttribute('data-margin-fallback-plain', 'true');
      }
      span.appendChild(reconstructed.fragment);
      this.bindMaskClickToggle(span);

      this.ownedInjectedNodes.add(span);
      this.insertInjectedIntoBlock(blockEl, span);
      this.ensureInjectedRootAtEnd(blockEl, span);
      this.unclampForInjectedNode(blockEl, span);
      blockEl.setAttribute('data-margin-translated', 'true');
      this.mountedMeta.set(blockEl, {
        plainTextLength: tokenized.plainTextLength,
        plain: normalizedPlain,
        fallbackPlain: reconstructed.fallbackPlain,
        sourceText: tokenized.text,
        translatedText,
      });
      this.translatedBlockSet.add(blockEl);
      this.failedBlockTasks.delete(blockEl);
    });

    this.recordRecentPrefixIfEligible(
      normalizedPlain,
      normalizedPlain,
      tokenized.text,
      translatedText,
      Boolean(tokenized.preservesNewlines),
      Boolean(options.forceBilingual),
    );

    return { fallbackPlain: reconstructed.fallbackPlain };
  }

  private tryBindPriorRichTokens(
    oldSourceText: string,
    oldTranslatedText: string,
    newSeg: TokenizedSegment,
  ): TokenizedParagraph | undefined {
    if (!oldSourceText || !/<\/?m\d+/i.test(oldTranslatedText)) {
      return undefined;
    }
    const oldOpenRe = /<m(\d+)(\/)?>/g;
    const oldMarkers: Array<{ id: number; kind: 'paired' | 'atomic' }> = [];
    let m: RegExpExecArray | null;
    while ((m = oldOpenRe.exec(oldSourceText)) !== null) {
      oldMarkers.push({
        id: Number(m[1]),
        kind: m[2] ? 'atomic' : 'paired',
      });
    }
    if (oldMarkers.length === 0) {
      return undefined;
    }

    const oldCore = oldSourceText.replace(
      /(?:<\/m\d+>|\s|\u2026|\.{3})+$/gu,
      '',
    );
    let lastTagEnd = 0;
    const anyTagRe = /<\/?m\d+\/?>/g;
    while ((m = anyTagRe.exec(oldCore)) !== null) {
      lastTagEnd = m.index + m[0].length;
    }
    const safePrefixLen = Math.max(lastTagEnd, oldCore.length - 16);
    const safePrefix = oldCore.slice(0, safePrefixLen);
    if (!safePrefix || !newSeg.text.startsWith(safePrefix)) {
      return undefined;
    }

    for (const marker of oldMarkers) {
      const newDesc = newSeg.tokens.get(marker.id);
      if (!newDesc || newDesc.kind !== marker.kind) {
        return undefined;
      }
    }

    const transIds = new Set<number>();
    const transMarkerRe = /<m(\d+)(?:\s*\/)?>/g;
    while ((m = transMarkerRe.exec(oldTranslatedText)) !== null) {
      transIds.add(Number(m[1]));
    }
    if (transIds.size === 0) {
      return undefined;
    }

    const boundTokens = new Map<number, RichTokenDescriptor>();
    for (const id of transIds) {
      const desc = newSeg.tokens.get(id);
      if (!desc) return undefined;
      boundTokens.set(id, desc);
    }

    return {
      text: oldSourceText,
      hasRichTags: boundTokens.size > 0,
      plainTextLength: newSeg.plainTextLength,
      tokens: boundTokens,
      preservesNewlines: newSeg.preservesNewlines,
    };
  }

  private hasPinnedFallback(seg: PlanSegment): boolean {
    return seg.state === 'failed' && Boolean(seg.hadPinnedTrans && seg.trans);
  }

  private isPlanSegmentCurrentlyRevealable(
    plan: BlockPlan,
    index: number,
  ): boolean {
    for (let k = 0; k < index; k++) {
      const prev = plan.segments[k];
      if (!prev) return false;
      const st = prev.state;
      if (st === 'done' || st === 'identity') continue;
      if (st === 'pinned' && prev.holdUntilFinal) continue;
      if (this.hasPinnedFallback(prev) && prev.holdUntilFinal) continue;
      return false;
    }
    return true;
  }

  private extractPriorSnapshot(
    block: HTMLElement,
    activePlan: BlockPlan | undefined,
    meta: MountedBlockMeta | undefined,
  ): PriorBlockSnapshot | null {
    if (activePlan) {
      const segSnaps: PriorSegmentSnapshot[] = [];
      for (const s of activePlan.segments) {
        if (s.staleSettledTrans) {
          segSnaps.push({
            sourceText: s.text,
            plain: s.plain,
            translatedText: s.staleSettledTrans,
          });
          continue;
        }
        if (
          (s.state === 'done' ||
            s.state === 'identity' ||
            s.state === 'pinned' ||
            this.hasPinnedFallback(s)) &&
          s.trans
        ) {
          const fromPin = s.state === 'pinned' || this.hasPinnedFallback(s);
          segSnaps.push({
            sourceText: fromPin ? (s.pinnedSourceText ?? s.text) : s.text,
            plain: fromPin ? (s.pinnedSourcePlain ?? s.plain) : s.plain,
            translatedText: s.trans,
          });
        } else if (s.state === 'streaming' && s.trans) {
          segSnaps.push({
            sourceText: s.text,
            plain: s.plain,
            translatedText: s.trans,
          });
          break;
        } else {
          break;
        }
      }
      if (segSnaps.length > 0) {
        return {
          blockPlain: activePlan.blockPlain,
          segments: segSnaps,
        };
      }
    }

    if (meta) {
      if (meta.segments && meta.segments.length > 0) {
        return {
          blockPlain: meta.plain,
          segments: meta.segments,
        };
      }
      if (meta.translatedText) {
        return {
          blockPlain: meta.plain,
          segments: [
            {
              sourceText: meta.sourceText,
              plain: meta.plain,
              translatedText: meta.translatedText,
            },
          ],
        };
      }
    }

    // Check if an initial single-block stream is currently displaying partial text on `block`
    for (let i = 0; i < block.children.length; i++) {
      const ch = block.children[i];
      if (
        ch.classList.contains('margin-trans-root') &&
        ch.getAttribute('data-margin-streaming') === '1'
      ) {
        const partialTxt = ch.textContent?.trim() ?? '';
        const tasks = this.inFlightTasksByBlock.get(block);
        const firstTask = tasks ? Array.from(tasks)[0] : undefined;
        if (partialTxt && firstTask) {
          const oldPlain = normalizePlainForPrefix(
            extractPlainFromTokenized(firstTask.tokenized),
          );
          return {
            blockPlain: oldPlain,
            segments: [
              {
                sourceText: firstTask.tokenized.text,
                plain: oldPlain,
                translatedText: partialTxt,
              },
            ],
          };
        }
      }
    }

    return null;
  }

  private carryOverPlanDomNodes(
    oldPlan: BlockPlan | undefined,
    nextPlan: BlockPlan,
    block: HTMLElement,
  ): void {
    if (oldPlan) {
      for (let i = 0; i < nextPlan.segments.length; i++) {
        const nextSeg = nextPlan.segments[i];
        const oldSeg = oldPlan.segments[i];
        if (!oldSeg?.domEl || !oldSeg.domEl.isConnected) {
          break;
        }
        if (
          nextSeg.state === 'done' &&
          oldSeg.state === 'done' &&
          oldSeg.cacheKey === nextSeg.cacheKey
        ) {
          nextSeg.domEl = oldSeg.domEl;
          continue;
        }
        if (
          nextSeg.state === 'pinned' &&
          (oldSeg.state === 'done' ||
            oldSeg.state === 'pinned' ||
            this.hasPinnedFallback(oldSeg))
        ) {
          if (!oldSeg.staleSettledTrans) {
            nextSeg.domEl = oldSeg.domEl;
          }
          if (nextSeg.holdUntilFinal) {
            continue;
          }
          break;
        }
        break;
      }
      return;
    }

    const firstSeg = nextPlan.segments[0];
    if (
      !firstSeg ||
      (firstSeg.state !== 'done' && firstSeg.state !== 'pinned')
    ) {
      return;
    }

    let legacyRoot: HTMLElement | null = null;
    for (let i = 0; i < block.children.length; i++) {
      const ch = block.children[i];
      if (
        ch instanceof HTMLElement &&
        ch.classList.contains('margin-trans-root') &&
        ch.getAttribute('data-margin-injected') === 'true' &&
        ch.getAttribute('data-margin-segmented') !== '1'
      ) {
        legacyRoot = ch;
        break;
      }
    }
    if (!legacyRoot || legacyRoot.childNodes.length === 0) {
      return;
    }

    this.runInternalDomMutation(() => {
      const segSpan = this.doc.createElement('span');
      segSpan.className = 'margin-trans-seg';
      segSpan.setAttribute('data-margin-seg-index', '0');
      while (legacyRoot!.firstChild) {
        const node = legacyRoot!.firstChild;
        if (
          node instanceof Element &&
          (node.classList.contains('margin-inline-retry') ||
            node.classList.contains('margin-trans-tail-shimmer'))
        ) {
          this.ownedInjectedNodes.delete(node);
          node.remove();
          continue;
        }
        segSpan.appendChild(node);
      }
      legacyRoot!.removeAttribute('data-margin-streaming');
      legacyRoot!.setAttribute('data-margin-segmented', '1');
      legacyRoot!.appendChild(segSpan);
      firstSeg.domEl = segSpan;
    });
  }

  private planBlock(
    prepared: PreparedBlockTask,
    prior?: PriorBlockSnapshot,
    forceBilingual = false,
  ): BlockPlan | null {
    const enableRichHtml = this.config.webpage.enableRichHtml;
    const { maxCharsPerBatch } = this.resolveBatchLimits(prepared.scene);
    const softMaxChars = 1200;
    const hardMaxChars = Math.max(256, Math.min(maxCharsPerBatch || 4096, 2400));
    const rawSegments = splitTokenizedIntoSegments(prepared.tokenized, {
      softMaxChars,
      hardMaxChars,
    });
    const blockPlain = normalizePlainForPrefix(
      extractPlainFromTokenized(prepared.tokenized),
    );

    const configSig = this.computeTranslationConfigSignature(this.config);
    const crossRouteSnap =
      !prior && prepared.scene === 'webpage' && !forceBilingual
        ? this.recentPrefixes.match(blockPlain, configSig)
        : null;

    if (rawSegments.length <= 1 && !prior && !crossRouteSnap) {
      return null;
    }

    const planSegments: PlanSegment[] = [];
    let boundaryPinned = false;
    let canAlignWithPrior = true;

    for (let i = 0; i < rawSegments.length; i++) {
      const seg = rawSegments[i];
      const cacheKey = this.makeCacheKey(
        prepared.scene,
        seg.text,
        enableRichHtml,
      );

      if (!/\p{L}/u.test(seg.plain)) {
        planSegments.push({
          ...seg,
          cacheKey,
          state: 'identity',
          trans: seg.text,
          lastPaintLen: 0,
        });
        continue;
      }

      const cached = this.cache.get(cacheKey);
      if (cached) {
        const redundant = isRedundantIdenticalTranslation(seg.text, cached.trans);
        planSegments.push({
          ...seg,
          cacheKey,
          state: redundant ? 'identity' : 'done',
          trans: cached.trans,
          fallbackPlain: cached.fallbackPlain,
          lastPaintLen: stripResidualMarkers(cached.trans).length,
        });
        continue;
      }

      if (canAlignWithPrior && !boundaryPinned) {
        if (prior && i < prior.segments.length) {
          const priorSeg = prior.segments[i];
          const prevSegNorm = normalizePlainForPrefix(priorSeg.plain);
          const nextSegNorm = normalizePlainForPrefix(seg.plain);

          if (prevSegNorm && prevSegNorm === nextSegNorm) {
            const cleanPin = stripResidualMarkers(priorSeg.translatedText);
            planSegments.push({
              ...seg,
              cacheKey,
              state: 'pinned',
              trans: priorSeg.translatedText,
              hadPinnedTrans: true,
              pinnedPlainLen: cleanPin.length,
              pinnedRichTokenized: this.tryBindPriorRichTokens(
                priorSeg.sourceText,
                priorSeg.translatedText,
                seg,
              ),
              pinnedSourceText: priorSeg.sourceText,
              pinnedSourcePlain: priorSeg.plain,
              holdUntilFinal: true,
              lastPaintLen: cleanPin.length,
            });
            continue;
          }

          if (isBoundarySegmentExpansion(priorSeg.plain, seg.plain)) {
            const cleanPin = stripResidualMarkers(priorSeg.translatedText);
            planSegments.push({
              ...seg,
              cacheKey,
              state: 'pinned',
              trans: priorSeg.translatedText,
              hadPinnedTrans: true,
              pinnedPlainLen: cleanPin.length,
              pinnedRichTokenized: this.tryBindPriorRichTokens(
                priorSeg.sourceText,
                priorSeg.translatedText,
                seg,
              ),
              pinnedSourceText: priorSeg.sourceText,
              pinnedSourcePlain: priorSeg.plain,
              holdUntilFinal: seg.plainTextLength <= 480,
              lastPaintLen: cleanPin.length,
            });
            boundaryPinned = true;
            canAlignWithPrior = false;
            continue;
          }
        } else if (crossRouteSnap) {
          const prevSegNorm = normalizePlainForPrefix(
            crossRouteSnap.lastSegPlain,
          );
          const nextSegNorm = normalizePlainForPrefix(seg.plain);
          if (
            (prevSegNorm && prevSegNorm === nextSegNorm) ||
            isBoundarySegmentExpansion(crossRouteSnap.lastSegPlain, seg.plain)
          ) {
            const samePlain = prevSegNorm === nextSegNorm;
            const cleanPin = stripResidualMarkers(
              crossRouteSnap.lastSegTranslated,
            );
            planSegments.push({
              ...seg,
              cacheKey,
              state: 'pinned',
              trans: crossRouteSnap.lastSegTranslated,
              hadPinnedTrans: true,
              pinnedPlainLen: cleanPin.length,
              pinnedRichTokenized: this.tryBindPriorRichTokens(
                crossRouteSnap.lastSegSourceText,
                crossRouteSnap.lastSegTranslated,
                seg,
              ),
              pinnedSourceText: crossRouteSnap.lastSegSourceText,
              pinnedSourcePlain: crossRouteSnap.lastSegPlain,
              holdUntilFinal: samePlain || seg.plainTextLength <= 480,
              lastPaintLen: cleanPin.length,
            });
            boundaryPinned = true;
            canAlignWithPrior = false;
            continue;
          }
        }
      }

      canAlignWithPrior = false;
      planSegments.push({
        ...seg,
        cacheKey,
        state: 'pending',
        lastPaintLen: 0,
      });
    }

    return {
      block: prepared.block,
      scene: prepared.scene,
      blockSourceText: prepared.tokenized.text,
      blockPlain,
      segments: planSegments,
      controllers: new Set(),
      batchPromises: new Set(),
      inFlightBatches: 0,
      superseded: false,
      forceBilingual,
      isExpansionFromPrior: Boolean(prior || crossRouteSnap),
    };
  }

  private renderPlan(plan: BlockPlan): void {
    if (plan.superseded || !plan.block.isConnected) return;

    this.ensureStylesInjected();
    this.ensureThemeObserver();

    const displayMode: DisplayMode = plan.forceBilingual
      ? 'bilingual'
      : this.config.webpage.displayMode;
    const allSettled = plan.segments.every(
      (s) => s.state === 'done' || s.state === 'identity',
    );
    const allRedundant =
      allSettled &&
      plan.segments.every(
        (s) =>
          s.state === 'identity' ||
          isRedundantIdenticalTranslation(s.text, s.trans ?? ''),
      );

    if (displayMode === 'bilingual' && allRedundant) {
      this.runInternalDomMutation(() => {
        this.clearBlockInjectedElements(plan.block);
        this.setSourceHidden(plan.block, false);
        this.restoreUnclampedForBlock(plan.block);
        plan.block.removeAttribute('data-margin-translated');
        this.mountedMeta.delete(plan.block);
        this.translatedBlockSet.delete(plan.block);
        this.failedBlockTasks.delete(plan.block);
        this.blockPlans.delete(plan.block);
      });
      return;
    }

    // Determine ordered reveal prefix
    const revealedIndices: number[] = [];
    for (let i = 0; i < plan.segments.length; i++) {
      const seg = plan.segments[i];
      const st = seg.state;
      if (st === 'done' || st === 'identity') {
        revealedIndices.push(i);
        continue;
      }
      if (st === 'pinned' && seg.holdUntilFinal) {
        revealedIndices.push(i);
        continue;
      }
      if (st === 'pinned' || st === 'streaming') {
        revealedIndices.push(i);
        break;
      }
      if (this.hasPinnedFallback(seg)) {
        revealedIndices.push(i);
        if (seg.holdUntilFinal) {
          continue;
        }
        break;
      }
      break;
    }

    const visibleIndices = revealedIndices.filter((idx) => {
      const s = plan.segments[idx];
      if (displayMode === 'bilingual') {
        if (
          s.state === 'identity' ||
          (s.state === 'done' &&
            isRedundantIdenticalTranslation(s.text, s.trans ?? ''))
        ) {
          return false;
        }
      }
      return true;
    });

    const hasAnyFailed = plan.segments.some((s) => s.state === 'failed');
    const hasUnsettled = plan.segments.some(
      (s) =>
        s.state === 'pending' || s.state === 'pinned' || s.state === 'streaming',
    );

    // If nothing can be displayed yet and no failure has happened yet, reconcile stale root & keep/mount loading shimmer
    if (visibleIndices.length === 0 && !hasAnyFailed) {
      this.runInternalDomMutation(() => {
        for (const s of plan.segments) {
          s.domEl = undefined;
          s.streamTextNode = undefined;
        }
        const toRemove: Element[] = [];
        for (let i = 0; i < plan.block.children.length; i++) {
          const ch = plan.block.children[i];
          if (ch.getAttribute('data-margin-injected') !== 'true') continue;
          if (hasUnsettled && ch.getAttribute('data-margin-loading') === '1') {
            continue;
          }
          toRemove.push(ch);
        }
        for (const el of toRemove) {
          this.ownedInjectedNodes.delete(el);
          el.remove();
        }
        this.setSourceHidden(plan.block, false);
        if (!hasUnsettled) {
          this.restoreUnclampedForBlock(plan.block);
        }
        plan.block.removeAttribute('data-margin-translated');
        this.translatedBlockSet.delete(plan.block);
        this.mountedMeta.delete(plan.block);
      });
      if (hasUnsettled) {
        this.mountBlockLoadingIndicator(plan.block, plan.blockPlain.length);
      }
      return;
    }

    const effectiveStyle = resolveEffectiveHostTextStyle(plan.block);
    const theme = this.resolveEffectiveTheme();
    const layout = this.computeLayoutMode(
      plan.block,
      plan.blockPlain.length,
      displayMode,
    );

    this.runInternalDomMutation(() => {
      const shouldHideSource =
        displayMode === 'target-only' &&
        !hasAnyFailed &&
        visibleIndices.length > 0;
      this.setSourceHidden(plan.block, shouldHideSource);

      // Reuse existing `.margin-trans-root` or convert `.margin-trans-loading`
      let root: HTMLSpanElement | null = null;
      const strayInjected: Element[] = [];
      for (let i = 0; i < plan.block.children.length; i++) {
        const ch = plan.block.children[i];
        if (ch.getAttribute('data-margin-injected') !== 'true') continue;
        if (!root && ch instanceof HTMLSpanElement && ch.classList.contains('margin-trans-block')) {
          root = ch;
        } else {
          strayInjected.push(ch);
        }
      }
      for (const stray of strayInjected) {
        this.ownedInjectedNodes.delete(stray);
        stray.remove();
      }

      const isNewRoot = root === null;
      if (!root) {
        root = this.doc.createElement('span');
      }

      const hasDoneOrPinned = visibleIndices.some((idx) => {
        const seg = plan.segments[idx];
        return (
          seg.state === 'done' ||
          seg.state === 'pinned' ||
          seg.state === 'identity' ||
          this.hasPinnedFallback(seg)
        );
      });

      root.className = 'margin-trans-root margin-trans-block';
      root.removeAttribute('data-margin-loading');
      root.removeAttribute('role');
      root.removeAttribute('aria-label');
      root.setAttribute('data-margin-injected', 'true');
      root.setAttribute('data-margin-segmented', '1');
      root.setAttribute('data-margin-theme', theme);
      root.setAttribute('data-margin-layout', layout);
      if (hasUnsettled) {
        root.setAttribute('aria-busy', 'true');
      } else {
        root.removeAttribute('aria-busy');
      }
      if (!hasDoneOrPinned && visibleIndices.length > 0) {
        root.setAttribute('data-margin-streaming', '1');
      } else {
        root.removeAttribute('data-margin-streaming');
      }
      this.applyTargetLocaleTypography(root, plan.block);
      applyEffectiveHostTextStyle(root, effectiveStyle);
      this.bindMaskClickToggle(root);

      const desiredNodes: Node[] = [];
      for (let pos = 0; pos < visibleIndices.length; pos++) {
        const idx = visibleIndices[pos];
        const seg = plan.segments[idx];

        let segEl = seg.domEl;
        if (!segEl) {
          segEl = this.doc.createElement('span');
          segEl.className = 'margin-trans-seg';
          segEl.setAttribute('data-margin-seg-index', String(idx));

          if (seg.state === 'done') {
            const rec = reconstructRichDom(seg.trans ?? '', seg, this.doc, {
              stripSourceLocaleAttrs: true,
              preserveLinkAppearance: true,
            });
            seg.fallbackPlain = rec.fallbackPlain;
            segEl.appendChild(rec.fragment);
          } else if (seg.state === 'identity') {
            const rec = reconstructRichDom(seg.text, seg, this.doc, {
              stripSourceLocaleAttrs: true,
              preserveLinkAppearance: true,
            });
            segEl.appendChild(rec.fragment);
          } else if (seg.state === 'pinned' || this.hasPinnedFallback(seg)) {
            if (seg.pinnedRichTokenized) {
              const rec = reconstructRichDom(
                seg.trans ?? '',
                seg.pinnedRichTokenized,
                this.doc,
                { stripSourceLocaleAttrs: true, preserveLinkAppearance: true },
              );
              segEl.appendChild(rec.fragment);
            } else {
              segEl.textContent = stripResidualMarkers(seg.trans ?? '');
            }
          } else if (seg.state === 'streaming') {
            const tn = this.doc.createTextNode(seg.trans ?? '');
            seg.streamTextNode = tn;
            segEl.appendChild(tn);
          }
          seg.domEl = segEl;
        } else {
          segEl.setAttribute('data-margin-seg-index', String(idx));
          // If transitioning displayMode or refreshing an identity segment with empty domEl
          if (seg.state === 'identity' && segEl.childNodes.length === 0) {
            const rec = reconstructRichDom(seg.text, seg, this.doc, {
              stripSourceLocaleAttrs: true,
              preserveLinkAppearance: true,
            });
            segEl.appendChild(rec.fragment);
          }
        }

        if (pos > 0) {
          const prevIdx = visibleIndices[pos - 1];
          let sepText = seg.sepBefore;
          if (prevIdx + 1 < idx) {
            const rank = (sep: string): number =>
              sep === '\n\n' ? 3 : sep === '\n' ? 2 : sep === ' ' ? 1 : 0;
            for (let k = prevIdx + 1; k <= idx; k++) {
              const cand = plan.segments[k]?.sepBefore ?? '';
              if (rank(cand) > rank(sepText)) {
                sepText = cand;
              }
            }
          }
          if (sepText.length > 0) {
            const prevSib = segEl.previousSibling;
            if (
              prevSib &&
              prevSib.parentNode === root &&
              prevSib.nodeType === Node.TEXT_NODE &&
              prevSib.nodeValue === sepText
            ) {
              desiredNodes.push(prevSib);
            } else {
              desiredNodes.push(this.doc.createTextNode(sepText));
            }
          }
        }
        desiredNodes.push(segEl);
      }

      if (hasUnsettled) {
        let tailShimmer: HTMLSpanElement | null = null;
        for (let i = 0; i < root.children.length; i++) {
          const ch = root.children[i];
          if (
            ch instanceof HTMLSpanElement &&
            ch.classList.contains('margin-trans-tail-shimmer')
          ) {
            tailShimmer = ch;
            break;
          }
        }
        if (!tailShimmer) {
          tailShimmer = this.doc.createElement('span');
          tailShimmer.className = 'margin-trans-tail-shimmer';
          tailShimmer.setAttribute('data-margin-injected', 'true');
          tailShimmer.setAttribute('aria-hidden', 'true');
          this.ownedInjectedNodes.add(tailShimmer);
        }
        desiredNodes.push(tailShimmer);
      }

      if (hasAnyFailed) {
        let retryBtn: HTMLButtonElement | null = null;
        for (let i = 0; i < root.children.length; i++) {
          const ch = root.children[i];
          if (
            ch instanceof HTMLButtonElement &&
            ch.classList.contains('margin-inline-retry')
          ) {
            retryBtn = ch;
            break;
          }
        }
        if (!retryBtn) {
          retryBtn = this.doc.createElement('button');
          retryBtn.type = 'button';
          retryBtn.className = 'margin-inline-retry';
          retryBtn.setAttribute('data-margin-injected', 'true');
          retryBtn.setAttribute('aria-label', 'Retry translation');
          retryBtn.title = this.lastError
            ? `Translation failed (${this.lastError}) — click to retry`
            : 'Retry failed paragraphs';
          retryBtn.textContent = '↻';
          retryBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.retryFailedPlan(plan);
          });
          this.ownedInjectedNodes.add(retryBtn);
        }
        applyEffectiveHostTextStyle(retryBtn, effectiveStyle);
        desiredNodes.push(retryBtn);
      }

      const desiredSet = new Set<Node>(desiredNodes);
      let cursor: ChildNode | null = root.firstChild;
      for (const desired of desiredNodes) {
        if (cursor === desired) {
          cursor = cursor.nextSibling;
          continue;
        }
        while (cursor && !desiredSet.has(cursor)) {
          const obsolete = cursor;
          cursor = cursor.nextSibling;
          if (obsolete instanceof Element) {
            this.ownedInjectedNodes.delete(obsolete);
          }
          obsolete.remove();
        }
        if (cursor === desired) {
          cursor = cursor.nextSibling;
        } else {
          root.insertBefore(desired, cursor);
        }
      }
      while (cursor) {
        const obsolete = cursor;
        cursor = cursor.nextSibling;
        if (obsolete instanceof Element) {
          this.ownedInjectedNodes.delete(obsolete);
        }
        obsolete.remove();
      }

      const anyFallbackPlain = plan.segments.some((s) => Boolean(s.fallbackPlain));
      if (anyFallbackPlain) {
        root.setAttribute('data-margin-fallback-plain', 'true');
      } else {
        root.removeAttribute('data-margin-fallback-plain');
      }

      this.ownedInjectedNodes.add(root);
      if (isNewRoot) {
        this.insertInjectedIntoBlock(plan.block, root);
      }
      this.ensureInjectedRootAtEnd(plan.block, root);
      this.unclampForInjectedNode(plan.block, root);
      refreshClonedLinksAppearance(root);

      if (hasDoneOrPinned) {
        plan.block.setAttribute('data-margin-translated', 'true');
        this.translatedBlockSet.add(plan.block);

        const settledSnapshots: PriorSegmentSnapshot[] = [];
        for (const s of plan.segments) {
          if (
            (s.state === 'done' ||
              s.state === 'identity' ||
              s.state === 'pinned' ||
              this.hasPinnedFallback(s)) &&
            s.trans
          ) {
            const fromPin = s.state === 'pinned' || this.hasPinnedFallback(s);
            settledSnapshots.push({
              sourceText: fromPin ? (s.pinnedSourceText ?? s.text) : s.text,
              plain: fromPin ? (s.pinnedSourcePlain ?? s.plain) : s.plain,
              translatedText: s.trans,
            });
          } else {
            break;
          }
        }

        const joinedTranslated = settledSnapshots
          .map((s, idx) =>
            idx === 0
              ? s.translatedText
              : `${plan.segments[idx]?.sepBefore ?? ''}${s.translatedText}`,
          )
          .join('');

        this.mountedMeta.set(plan.block, {
          plainTextLength: plan.blockPlain.length,
          plain: plan.blockPlain,
          fallbackPlain: anyFallbackPlain,
          sourceText: plan.blockSourceText,
          translatedText: joinedTranslated,
          segments: settledSnapshots,
        });
      }

      if (!hasAnyFailed) {
        this.failedBlockTasks.delete(plan.block);
      }
    });

    if (allSettled && plan.segments.length > 0) {
      const lastSeg = plan.segments[plan.segments.length - 1];
      this.recordRecentPrefixIfEligible(
        plan.blockPlain,
        lastSeg.plain,
        lastSeg.text,
        lastSeg.trans ?? lastSeg.text,
        Boolean(lastSeg.preservesNewlines),
        plan.forceBilingual,
      );
    }
  }

  private dispatchPlan(
    plan: BlockPlan,
    basePriority: RequestPriority,
  ): Promise<void> {
    if (plan.superseded || !plan.block.isConnected) {
      return Promise.resolve();
    }

    const liveSegIndices = new Set<number>();
    const activeBlockTasks = this.inFlightTasksByBlock.get(plan.block);
    if (activeBlockTasks) {
      for (const activeTask of activeBlockTasks) {
        if (
          activeTask.seg?.plan === plan &&
          !activeTask.superseded &&
          !activeTask.settled &&
          !activeTask.controller?.signal.aborted
        ) {
          liveSegIndices.add(activeTask.seg.index);
        }
      }
    }

    const tasks: PreparedBlockTask[] = [];
    for (let idx = 0; idx < plan.segments.length; idx++) {
      if (liveSegIndices.has(idx)) {
        continue;
      }
      const seg = plan.segments[idx];
      if (seg.state === 'pending' || seg.state === 'pinned') {
        tasks.push({
          block: plan.block,
          tokenized: seg,
          cacheKey: seg.cacheKey,
          charCount: seg.text.length,
          scene: plan.scene,
          seg: { plan, index: idx },
        });
      }
    }

    if (tasks.length === 0) {
      if (plan.inFlightBatches === 0) {
        this.inFlightBlocks.delete(plan.block);
        this.inFlightBlockSet.delete(plan.block);
        this.inFlightBlockPromises.delete(plan.block);
      }
      if (plan.scene === 'webpage') {
        this.refreshStatusPill();
      }
      return plan.batchPromises.size > 0
        ? Promise.all(Array.from(plan.batchPromises)).then(() => {})
        : Promise.resolve();
    }

    const { maxBatchCount, maxCharsPerBatch } = this.resolveBatchLimits(
      plan.scene,
    );
    const batches = packIntoProgressiveBatches(
      tasks,
      maxBatchCount,
      maxCharsPerBatch,
      true,
    );

    const wave0Vip =
      plan.scene === 'webpage' &&
      plan.isExpansionFromPrior &&
      this.classifyBlockViewportState(plan.block).isStrictlyVisible &&
      this.isUserInitiatedNow();

    this.observedBlocks.add(plan.block);
    this.inFlightBlocks.add(plan.block);
    this.inFlightBlockSet.add(plan.block);
    if (plan.scene === 'webpage') {
      this.sessionTotalBlocks += tasks.length;
    }

    const promises = batches.map((batch, batchIdx) => {
      const prio: RequestPriority =
        plan.scene === 'hover'
          ? -1
          : batchIdx === 0 && wave0Vip
            ? -1
            : wave0Vip
              ? 0
              : basePriority;
      const p = this.executeBatch(batch, {
        forceBilingual: plan.forceBilingual,
        priority: prio,
      });
      plan.batchPromises.add(p);
      void p.finally(() => {
        plan.batchPromises.delete(p);
      });
      return p;
    });

    const combined = Promise.all(Array.from(plan.batchPromises)).then(() => {});
    this.inFlightBlockPromises.set(plan.block, combined);
    if (plan.scene === 'webpage') {
      this.refreshStatusPill();
    }
    return combined;
  }

  private supersedeBlockInFlight(block: HTMLElement): void {
    const activeTasks = this.inFlightTasksByBlock.get(block);
    if (!activeTasks || activeTasks.size === 0) {
      this.inFlightBlocks.delete(block);
      this.inFlightBlockSet.delete(block);
      this.inFlightBlockPromises.delete(block);
      return;
    }

    let unsettledWebpageCount = 0;
    const touchedControllers = new Set<AbortController>();
    for (const task of activeTasks) {
      if (!task.superseded && !task.settled && task.scene === 'webpage') {
        unsettledWebpageCount += 1;
      }
      task.superseded = true;
      if (task.controller) {
        touchedControllers.add(task.controller);
      }
    }

    if (unsettledWebpageCount > 0) {
      this.sessionTotalBlocks = Math.max(
        this.sessionDoneBlocks,
        this.sessionTotalBlocks - unsettledWebpageCount,
      );
    }

    this.inFlightBlocks.delete(block);
    this.inFlightBlockSet.delete(block);
    this.inFlightBlockPromises.delete(block);

    for (const ctrl of touchedControllers) {
      const ctrlTasks = this.batchTasksByController.get(ctrl);
      if (
        ctrlTasks &&
        ctrlTasks.length > 0 &&
        ctrlTasks.every((t) => Boolean(t.superseded || t.seg?.plan.superseded))
      ) {
        ctrl.abort();
      }
    }
  }

  private supersedePlan(plan: BlockPlan): void {
    if (plan.superseded) return;
    plan.superseded = true;
    if (this.blockPlans.get(plan.block) === plan) {
      this.blockPlans.delete(plan.block);
    }

    const activeTasks = this.inFlightTasksByBlock.get(plan.block);
    let unsettledCount = 0;
    const touchedControllers = new Set<AbortController>(plan.controllers);

    if (activeTasks) {
      for (const task of activeTasks) {
        if (task.seg?.plan === plan) {
          if (!task.superseded && !task.settled && task.scene === 'webpage') {
            unsettledCount += 1;
          }
          task.superseded = true;
          if (task.controller) {
            touchedControllers.add(task.controller);
          }
        }
      }
    }

    if (plan.scene === 'webpage' && unsettledCount > 0) {
      this.sessionTotalBlocks = Math.max(
        this.sessionDoneBlocks,
        this.sessionTotalBlocks - unsettledCount,
      );
    }

    this.inFlightBlocks.delete(plan.block);
    this.inFlightBlockSet.delete(plan.block);
    this.inFlightBlockPromises.delete(plan.block);

    for (const ctrl of touchedControllers) {
      const ctrlTasks = this.batchTasksByController.get(ctrl);
      if (
        ctrlTasks &&
        ctrlTasks.length > 0 &&
        ctrlTasks.every((t) => Boolean(t.superseded || t.seg?.plan.superseded))
      ) {
        ctrl.abort();
      }
    }
  }

  private retryFailedPlan(plan: BlockPlan): void {
    if (plan.superseded || !plan.block.isConnected) return;
    let resetCount = 0;
    for (const seg of plan.segments) {
      if (seg.state === 'failed') {
        if (seg.hadPinnedTrans && seg.trans) {
          seg.state = 'pinned';
          seg.streamTextNode = undefined;
          seg.lastPaintLen =
            seg.pinnedPlainLen ?? stripResidualMarkers(seg.trans).length;
        } else {
          seg.state = 'pending';
          seg.domEl = undefined;
          seg.streamTextNode = undefined;
          seg.lastPaintLen = 0;
        }
        resetCount += 1;
      }
    }
    this.failedBlockTasks.delete(plan.block);
    this.lastError = undefined;
    if (resetCount === 0) {
      this.refreshStatusPill();
      return;
    }
    if (plan.scene === 'webpage') {
      this.sessionTotalBlocks = Math.max(
        this.sessionDoneBlocks,
        this.sessionTotalBlocks - resetCount,
      );
    }
    this.renderPlan(plan);
    void this.dispatchPlan(plan, 0);
  }

  private mountBatchRetryButtons(
    batchTasks: readonly PreparedBlockTask[],
    errorMessage: string,
    options: { forceBilingual?: boolean; priority?: RequestPriority } = {},
  ): void {
    this.ensureStylesInjected();
    this.ensureThemeObserver();
    if (errorMessage) {
      this.lastError = errorMessage;
    }

    const segTasks: PreparedBlockTask[] = [];
    const legacyTasks: PreparedBlockTask[] = [];
    for (const task of batchTasks) {
      if (task.superseded || task.seg?.plan.superseded) {
        continue;
      }
      if (task.seg) {
        segTasks.push(task);
      } else {
        legacyTasks.push(task);
      }
    }

    if (segTasks.length > 0) {
      const affectedPlans = new Map<BlockPlan, PreparedBlockTask>();
      for (const task of segTasks) {
        const { plan, index } = task.seg!;
        if (
          plan.superseded ||
          this.blockPlans.get(plan.block) !== plan ||
          !plan.block.isConnected
        ) {
          continue;
        }
        const seg = plan.segments[index];
        if (seg && seg.state !== 'done' && seg.state !== 'identity') {
          seg.state = 'failed';
          seg.streamTextNode = undefined;
          if (!seg.hadPinnedTrans) {
            seg.domEl = undefined;
          }
        }
        if (!affectedPlans.has(plan)) {
          affectedPlans.set(plan, task);
        }
      }

      for (const [plan, repTask] of affectedPlans.entries()) {
        this.observedBlocks.delete(plan.block);
        this.failedBlockTasks.set(plan.block, repTask);
        this.renderPlan(plan);
      }
    }

    if (legacyTasks.length === 0) {
      return;
    }

    this.runInternalDomMutation(() => {
      const retryBatch = () => {
        this.runInternalDomMutation(() => {
          for (const t of legacyTasks) {
            this.failedBlockTasks.delete(t.block);
            this.clearBlockInjectedElements(t.block);
            this.setSourceHidden(t.block, false);
            this.mountBlockLoadingIndicator(
              t.block,
              t.tokenized.plainTextLength,
            );
          }
        });
        this.sessionTotalBlocks += legacyTasks.length;
        this.refreshStatusPill();
        void this.executeBatch(legacyTasks, { ...options, priority: 0 });
      };

      for (const task of legacyTasks) {
        this.observedBlocks.delete(task.block);
        if (!task.block.isConnected || this.hasMountedTranslation(task.block)) {
          continue;
        }
        this.clearBlockInjectedElements(task.block);
        this.setSourceHidden(task.block, false);
        const effectiveStyle = resolveEffectiveHostTextStyle(task.block);
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
        applyEffectiveHostTextStyle(btn, effectiveStyle);
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

    const batchSessionGen = this.sessionGen;
    const scene = batchTasks[0].scene;
    const resolvedPriority: RequestPriority =
      options.priority ?? (scene === 'hover' ? -1 : 0);
    const { preferStream, providerId } = this.resolveBatchLimits(scene);
    const abortController = new AbortController();
    this.activeControllers.add(abortController);
    this.batchTasksByController.set(abortController, batchTasks);

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

    const batchPlans = new Set<BlockPlan>();
    for (const task of batchTasks) {
      task.controller = abortController;
      let blockTaskSet = this.inFlightTasksByBlock.get(task.block);
      if (!blockTaskSet) {
        blockTaskSet = new Set();
        this.inFlightTasksByBlock.set(task.block, blockTaskSet);
      }
      blockTaskSet.add(task);

      this.inFlightBlocks.add(task.block);
      this.inFlightBlockSet.add(task.block);

      if (task.seg) {
        batchPlans.add(task.seg.plan);
        task.seg.plan.controllers.add(abortController);
        const hasRootAlready = Boolean(this.findDirectInjectedRoot(task.block));
        if (!hasRootAlready) {
          this.mountBlockLoadingIndicator(
            task.block,
            task.tokenized.plainTextLength,
          );
        }
      } else {
        this.mountBlockLoadingIndicator(
          task.block,
          task.tokenized.plainTextLength,
        );
      }
    }
    for (const p of batchPlans) {
      p.inFlightBatches += 1;
    }
    if (scene === 'webpage') {
      this.refreshStatusPill();
    }

    const slotMap = new Map<number, PreparedBlockTask>();
    const renderedTransBySlot = new Map<number, string>();
    const slotStreams = new Map<number, SlotStreamState>();

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
    ): boolean => {
      if (
        abortController.signal.aborted ||
        renderedTransBySlot.has(slotId) ||
        task.superseded ||
        !task.block.isConnected
      ) {
        return false;
      }

      if (task.seg) {
        const { plan, index } = task.seg;
        if (plan.superseded || this.blockPlans.get(plan.block) !== plan) {
          return false;
        }
        const seg = plan.segments[index];
        if (!seg || seg.state === 'done' || seg.state === 'identity') {
          return false;
        }

        if (seg.state === 'pinned') {
          if (seg.holdUntilFinal || seg.plainTextLength <= 480) {
            return false;
          }
          const minOvertakeLen = (seg.pinnedPlainLen ?? 0) + 6;
          if (previewText.length < minOvertakeLen) {
            return false;
          }
          seg.state = 'streaming';
          seg.hadPinnedTrans = false;
          seg.pinnedRichTokenized = undefined;
          seg.trans = previewText;
          seg.lastPaintLen = previewText.length;
          if (seg.domEl && seg.domEl.isConnected) {
            this.runInternalDomMutation(() => {
              const tn = this.doc.createTextNode(previewText);
              seg.domEl!.replaceChildren(tn);
              seg.streamTextNode = tn;
            });
          } else if (this.isPlanSegmentCurrentlyRevealable(plan, index)) {
            this.renderPlan(plan);
          }
          return true;
        }

        if (seg.state === 'pending') {
          seg.state = 'streaming';
          seg.trans = previewText;
          seg.lastPaintLen = previewText.length;
          if (this.isPlanSegmentCurrentlyRevealable(plan, index)) {
            this.renderPlan(plan);
          }
          return true;
        }

        if (seg.state === 'streaming') {
          if (previewText.length < seg.lastPaintLen) {
            return false;
          }
          seg.trans = previewText;
          seg.lastPaintLen = previewText.length;
          if (seg.streamTextNode && seg.domEl?.isConnected) {
            if (seg.streamTextNode.nodeValue !== previewText) {
              this.runInternalDomMutation(() => {
                seg.streamTextNode!.textContent = previewText;
              });
            }
          } else if (this.isPlanSegmentCurrentlyRevealable(plan, index)) {
            this.renderPlan(plan);
          }
          return true;
        }
        return false;
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
        return true;
      }

      this.ensureStylesInjected();
      this.ensureThemeObserver();
      const effectiveStyle = resolveEffectiveHostTextStyle(task.block);
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
        this.setSourceHidden(task.block, displayMode === 'target-only');

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
        applyEffectiveHostTextStyle(container, effectiveStyle);

        const textNode = this.doc.createTextNode(previewText);
        container.replaceChildren(textNode);
        this.bindMaskClickToggle(container);

        this.ownedInjectedNodes.add(container);
        if (isNewContainer) {
          this.insertInjectedIntoBlock(task.block, container);
        }
        this.ensureInjectedRootAtEnd(task.block, container);
        this.unclampForInjectedNode(task.block, container);
        slotState.streamContainer = container;
        slotState.streamTextNode = textNode;
      });
      return true;
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
        if (paintPartialSlot(item.id, task, slotState, previewText)) {
          slotState.lastPaintAt = now;
        }
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
            if (paintPartialSlot(item.id, task, slotState, latest)) {
              slotState.lastPaintAt = nowFrameMs();
            }
          }
        });
      }
    };

    let transportSettled = false;
    const provisionalStreamedSlots = new Set<number>();

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
      if (isFirstRenderForSlot) {
        task.settled = true;
      }
      if (!transportSettled) {
        provisionalStreamedSlots.add(item.id);
      }

      if (task.superseded || task.seg?.plan.superseded) {
        this.cache.set(task.cacheKey, {
          trans: item.trans,
          fallbackPlain: Boolean(item.fallbackPlain),
        });
        return;
      }

      if (task.seg) {
        const { plan, index } = task.seg;
        const seg = plan.segments[index];
        if (
          !seg ||
          !plan.block.isConnected ||
          this.blockPlans.get(plan.block) !== plan
        ) {
          this.cache.set(task.cacheKey, {
            trans: item.trans,
            fallbackPlain: Boolean(item.fallbackPlain),
          });
          if (isFirstRenderForSlot && scene === 'webpage' && !plan.block.isConnected) {
            this.sessionDoneBlocks += 1;
            this.inFlightBlockSet.delete(plan.block);
            this.refreshStatusPill();
          }
          return;
        }

        if (scene === 'webpage') {
          const latestPrepared = this.prepareBlockTask(plan.block, scene);
          if (
            !latestPrepared ||
            latestPrepared.tokenized.text.trim() !== plan.blockSourceText.trim()
          ) {
            this.cache.set(task.cacheKey, {
              trans: item.trans,
              fallbackPlain: Boolean(item.fallbackPlain),
            });
            seg.staleSettledTrans = item.trans;
            if (latestPrepared) {
              staleMidFlightBlocks.add(plan.block);
            }
            if (isFirstRenderForSlot) {
              this.sessionDoneBlocks += 1;
              this.refreshStatusPill();
            }
            return;
          }
        }

        const isRedundant = isRedundantIdenticalTranslation(
          seg.text,
          item.trans,
        );
        seg.trans = item.trans;
        seg.hadPinnedTrans = false;
        seg.staleSettledTrans = undefined;
        seg.streamTextNode = undefined;
        seg.state = isRedundant ? 'identity' : 'done';

        const displayMode: DisplayMode = plan.forceBilingual
          ? 'bilingual'
          : this.config.webpage.displayMode;
        const rec = reconstructRichDom(
          isRedundant ? seg.text : item.trans,
          seg,
          this.doc,
          { stripSourceLocaleAttrs: true, preserveLinkAppearance: true },
        );
        seg.fallbackPlain = isRedundant ? false : rec.fallbackPlain;

        if (isRedundant && displayMode === 'bilingual') {
          seg.domEl = undefined;
        } else if (seg.domEl && seg.domEl.isConnected) {
          this.runInternalDomMutation(() => {
            seg.domEl!.replaceChildren(rec.fragment);
          });
        }

        this.cache.set(task.cacheKey, {
          trans: item.trans,
          fallbackPlain: Boolean(item.fallbackPlain || seg.fallbackPlain),
        });
        this.renderPlan(plan);

        if (isFirstRenderForSlot && scene === 'webpage') {
          this.sessionDoneBlocks += 1;
          const stillUnsettled = plan.segments.some(
            (s) =>
              s.state === 'pending' ||
              s.state === 'pinned' ||
              s.state === 'streaming',
          );
          if (!stillUnsettled) {
            this.inFlightBlockSet.delete(plan.block);
          }
          this.refreshStatusPill();
        }
        return;
      }

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
              this.setSourceHidden(task.block, false);
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

    const cleanupAbortedBatchTasks = () => {
      cancelPendingSlotRafs();
      if (p1Tracker?.abortedByFastScroll || batchSessionGen !== this.sessionGen) {
        return;
      }
      this.runInternalDomMutation(() => {
        for (const task of batchTasks) {
          if (task.superseded || task.seg?.plan.superseded) {
            continue;
          }
          if (
            !renderedTransBySlot.has(
              requestItems.find((it) => slotMap.get(it.id) === task)?.id ?? -1,
            )
          ) {
            this.observedBlocks.delete(task.block);
            if (task.seg) {
              const { plan } = task.seg;
              if (this.blockPlans.get(plan.block) === plan) {
                const anyMountedSeg = plan.segments.some(
                  (s) => s.state === 'done' || s.state === 'pinned',
                );
                if (!anyMountedSeg) {
                  this.clearBlockInjectedElements(plan.block);
                  this.setSourceHidden(plan.block, false);
                  this.restoreUnclampedForBlock(plan.block);
                } else {
                  this.renderPlan(plan);
                }
              }
            } else if (!this.hasMountedTranslation(task.block)) {
              this.clearBlockInjectedElements(task.block);
              this.setSourceHidden(task.block, false);
              this.restoreUnclampedForBlock(task.block);
            }
          }
        }
      });
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
      transportSettled = true;

      if (abortController.signal.aborted) {
        cleanupAbortedBatchTasks();
        return;
      }

      if (!response.ok) {
        cancelPendingSlotRafs();
        if (
          response.error?.code === 'TRUNCATED_RESPONSE' &&
          provisionalStreamedSlots.size > 0
        ) {
          this.runInternalDomMutation(() => {
            for (const slotId of provisionalStreamedSlots) {
              renderedTransBySlot.delete(slotId);
              const task = slotMap.get(slotId);
              if (!task) continue;
              task.settled = false;
              this.cache.delete(task.cacheKey);
              if (
                scene === 'webpage' &&
                !task.superseded &&
                !task.seg?.plan.superseded &&
                this.sessionDoneBlocks > 0
              ) {
                this.sessionDoneBlocks -= 1;
              }
              if (task.seg) {
                const { plan, index } = task.seg;
                const seg = plan.segments[index];
                if (seg) {
                  seg.state = 'pending';
                  seg.trans = undefined;
                  seg.domEl = undefined;
                  seg.streamTextNode = undefined;
                  seg.lastPaintLen = 0;
                }
              } else if (task.block.isConnected) {
                this.clearBlockInjectedElements(task.block);
                this.setSourceHidden(task.block, false);
                this.restoreUnclampedForBlock(task.block);
              }
            }
          });
          provisionalStreamedSlots.clear();
        }
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
      if (abortController.signal.aborted) {
        cleanupAbortedBatchTasks();
        return;
      }
      cancelPendingSlotRafs();
      if (batchSessionGen !== this.sessionGen) {
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
      this.batchTasksByController.delete(abortController);
      for (const p of batchPlans) {
        if (!p1Tracker?.abortedByFastScroll) {
          p.inFlightBatches = Math.max(0, p.inFlightBatches - 1);
        }
        p.controllers.delete(abortController);
        if (
          !p.superseded &&
          p.hasPendingGrowth &&
          p.inFlightBatches === 0 &&
          p.block.isConnected
        ) {
          p.hasPendingGrowth = false;
          staleMidFlightBlocks.add(p.block);
        }
      }
      for (const task of batchTasks) {
        const blockSet = this.inFlightTasksByBlock.get(task.block);
        if (blockSet) {
          blockSet.delete(task);
          if (blockSet.size === 0) {
            this.inFlightTasksByBlock.delete(task.block);
          }
        }
      }
      if (batchSessionGen === this.sessionGen) {
        if (p1Tracker) {
          this.inFlightP1Batches.delete(p1Tracker);
        }
        for (const task of batchTasks) {
          const activePlan = this.blockPlans.get(task.block);
          const remainingTasks =
            this.inFlightTasksByBlock.get(task.block)?.size ?? 0;
          const planInFlight = activePlan
            ? activePlan.inFlightBatches > 0
            : false;
          if (!planInFlight && remainingTasks === 0) {
            this.inFlightBlocks.delete(task.block);
            this.inFlightBlockSet.delete(task.block);
            this.inFlightBlockPromises.delete(task.block);
          }
        }
        if (scene === 'webpage') {
          this.refreshStatusPill();
          if (this.active && staleMidFlightBlocks.size > 0) {
            this.scanAndRegisterSpaRoots(Array.from(staleMidFlightBlocks));
          }
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
      if (this.inFlightBlocks.has(block)) {
        const inFlightPromise = this.inFlightBlockPromises.get(block);
        if (inFlightPromise) {
          existingPromises.add(inFlightPromise);
        }
        continue;
      }
      if (this.hasMountedTranslation(block)) {
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

      const plan = this.planBlock(
        prepared,
        undefined,
        Boolean(options.forceBilingual),
      );
      if (plan) {
        this.blockPlans.set(block, plan);
        this.renderPlan(plan);
        const vpState = this.classifyBlockViewportState(block);
        const prio: RequestPriority =
          scene === 'hover'
            ? -1
            : vpState.isStrictlyVisible
              ? 0
              : options.fullPage
                ? 2
                : 1;
        existingPromises.add(this.dispatchPlan(plan, prio));
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

      const plan = this.planBlock(prepared);
      if (plan) {
        this.blockPlans.set(block, plan);
        this.renderPlan(plan);
        void this.dispatchPlan(plan, vpState.isStrictlyVisible ? 0 : 1);
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
            this.setSourceHidden(block, false);
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
          const targetPlan = this.blockPlans.get(target);
          const needsPlanResume =
            targetPlan !== undefined &&
            !targetPlan.superseded &&
            targetPlan.inFlightBatches === 0 &&
            targetPlan.segments.some(
              (s) =>
                s.state === 'pending' ||
                s.state === 'pinned' ||
                s.state === 'streaming',
            );
          if (
            (needsPlanResume || !this.hasMountedTranslation(target)) &&
            !this.inFlightBlocks.has(target) &&
            !this.failedBlockTasks.has(target)
          ) {
            const vpState = this.classifyBlockViewportState(target);
            const tier: RequestPriority = vpState.isStrictlyVisible ? 0 : 1;
            this.pendingViewportQueue.set(target, {
              scene: 'webpage',
              priority: tier,
            });
            if (!needsPlanResume) {
              this.mountBlockLoadingIndicator(target);
            }
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

      const evictedPlans = new Set<BlockPlan>();
      for (const task of tracker.tasks) {
        if (task.seg) {
          evictedPlans.add(task.seg.plan);
        }
      }
      for (const p of evictedPlans) {
        p.inFlightBatches = Math.max(0, p.inFlightBatches - 1);
        p.controllers.delete(tracker.controller);
      }

      this.runInternalDomMutation(() => {
        for (const task of tracker.tasks) {
          const blockSet = this.inFlightTasksByBlock.get(task.block);
          blockSet?.delete(task);
          if (blockSet && blockSet.size === 0) {
            this.inFlightTasksByBlock.delete(task.block);
          }

          const activePlan = this.blockPlans.get(task.block);
          if (activePlan && activePlan.inFlightBatches > 0) {
            continue;
          }

          this.inFlightBlocks.delete(task.block);
          this.inFlightBlockSet.delete(task.block);
          this.inFlightBlockPromises.delete(task.block);
          this.observedBlocks.delete(task.block);
          if (!this.hasMountedTranslation(task.block)) {
            this.clearBlockInjectedElements(task.block);
            this.setSourceHidden(task.block, false);
            this.restoreUnclampedForBlock(task.block);
          }
          if (task.block.isConnected) {
            const hasUnsettledPlan =
              activePlan !== undefined &&
              activePlan.segments.some(
                (s) =>
                  s.state === 'pending' ||
                  s.state === 'pinned' ||
                  s.state === 'streaming',
              );
            if (!this.hasMountedTranslation(task.block) || hasUnsettledPlan) {
              this.observeOffscreenBlock(task.block);
            }
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
    const activePlan = this.blockPlans.get(block);
    const meta = this.mountedMeta.get(block);
    const hasMounted = this.hasMountedTranslation(block);
    const hasTranslatedAttr = block.getAttribute('data-margin-translated') === 'true';

    if (activePlan || hasMounted || meta || hasTranslatedAttr) {
      const currentPrepared = this.prepareBlockTask(block, 'webpage');
      const currentSource = currentPrepared?.tokenized.text.trim() ?? '';
      const prevSource = (
        activePlan?.blockSourceText ??
        meta?.sourceText ??
        ''
      ).trim();

      if (!currentPrepared || !currentSource) {
        this.removeBlockTranslation(block);
        this.observedBlocks.delete(block);
        this.fallbackOffscreenBlocks.delete(block);
        this.intersectionObserver?.unobserve(block);
        this.failedBlockTasks.delete(block);
        return;
      }

      if (currentSource === prevSource) {
        if (!hasMounted && !activePlan) {
          // Root was externally removed while meta remained with identical source -> clean and allow re-mount
          this.removeBlockTranslation(block);
          this.observedBlocks.delete(block);
          this.fallbackOffscreenBlocks.delete(block);
          this.intersectionObserver?.unobserve(block);
          return;
        }
        // Re-assert bilingual root last if host appended non-prose sibling, or self-heal if host wiped root on a live plan
        const existingRoot = this.findDirectInjectedRoot(block);
        if (existingRoot) {
          this.runInternalDomMutation(() => {
            this.ensureInjectedRootAtEnd(block, existingRoot);
          });
        } else if (activePlan && !activePlan.superseded) {
          for (const s of activePlan.segments) {
            s.domEl = undefined;
            s.streamTextNode = undefined;
          }
          this.runInternalDomMutation(() => {
            this.setSourceHidden(block, false);
          });
          this.renderPlan(activePlan);
        }
        // Resume unsettled plan with no live requests (e.g. after fast-scroll eviction)
        if (
          activePlan &&
          !activePlan.superseded &&
          activePlan.inFlightBatches === 0 &&
          !this.failedBlockTasks.has(block) &&
          activePlan.segments.some(
            (s) =>
              s.state === 'pending' ||
              s.state === 'pinned' ||
              s.state === 'streaming',
          )
        ) {
          this.renderPlan(activePlan);
          const vp = this.classifyBlockViewportState(block);
          void this.dispatchPlan(activePlan, vp.isStrictlyVisible ? 0 : 1);
        }
        return;
      }

      const prevPlain =
        activePlan?.blockPlain ??
        meta?.plain ??
        normalizePlainForPrefix(prevSource);
      const nextPlain = normalizePlainForPrefix(
        extractPlainFromTokenized(currentPrepared.tokenized),
      );
      const changeKind = classifySourceChange(prevPlain, nextPlain);

      if (changeKind === 'same' || changeKind === 'expansion') {
        if (
          changeKind === 'expansion' &&
          activePlan &&
          !activePlan.superseded &&
          activePlan.isExpansionFromPrior &&
          activePlan.inFlightBatches > 0
        ) {
          activePlan.hasPendingGrowth = true;
          const existingRoot = this.findDirectInjectedRoot(block);
          if (existingRoot) {
            this.runInternalDomMutation(() => {
              this.ensureInjectedRootAtEnd(block, existingRoot);
            });
          }
          return;
        }

        const prior = this.extractPriorSnapshot(block, activePlan, meta);
        if (activePlan) {
          this.supersedePlan(activePlan);
        } else {
          this.supersedeBlockInFlight(block);
        }
        this.failedBlockTasks.delete(block);
        this.pendingViewportQueue.delete(block);
        this.fallbackOffscreenBlocks.delete(block);
        this.intersectionObserver?.unobserve(block);

        const cachedWhole = this.cache.get(currentPrepared.cacheKey);
        if (cachedWhole) {
          this.mountBlockTranslation(
            block,
            currentPrepared.tokenized,
            cachedWhole.trans,
          );
          return;
        }

        const nextPlan = this.planBlock(currentPrepared, prior ?? undefined);
        if (nextPlan) {
          nextPlan.isExpansionFromPrior = changeKind === 'expansion';
          this.carryOverPlanDomNodes(activePlan, nextPlan, block);
          this.blockPlans.set(block, nextPlan);
          this.renderPlan(nextPlan);
          const vp = this.classifyBlockViewportState(block);
          void this.dispatchPlan(nextPlan, vp.isStrictlyVisible ? 0 : 1);
          return;
        }
      }

      // Unrelated source change (e.g. virtual-scroll cell recycle or shrink) -> wipe synchronously
      this.removeBlockTranslation(block);
      this.observedBlocks.delete(block);
      this.fallbackOffscreenBlocks.delete(block);
      this.intersectionObserver?.unobserve(block);
      this.failedBlockTasks.delete(block);
      return;
    }

    // Handle mid-flight legacy single-block tasks whose source mutated before final mount
    const inFlightSet = this.inFlightTasksByBlock.get(block);
    if (inFlightSet && inFlightSet.size > 0) {
      const firstInFlight = Array.from(inFlightSet)[0];
      const currentPrepared = this.prepareBlockTask(block, 'webpage');
      const currentSource = currentPrepared?.tokenized.text.trim() ?? '';
      if (
        firstInFlight &&
        (!currentPrepared ||
          currentSource !== firstInFlight.tokenized.text.trim())
      ) {
        if (!currentPrepared || !currentSource) {
          this.removeBlockTranslation(block);
          this.observedBlocks.delete(block);
          return;
        }
        const prevPlain = normalizePlainForPrefix(
          extractPlainFromTokenized(firstInFlight.tokenized),
        );
        const nextPlain = normalizePlainForPrefix(
          extractPlainFromTokenized(currentPrepared.tokenized),
        );
        const changeKind = classifySourceChange(prevPlain, nextPlain);
        if (changeKind === 'expansion') {
          const prior = this.extractPriorSnapshot(block, undefined, undefined);
          const nextPlan = this.planBlock(currentPrepared, prior ?? undefined);
          if (!nextPlan) {
            return;
          }
          this.supersedeBlockInFlight(block);
          this.pendingViewportQueue.delete(block);
          nextPlan.isExpansionFromPrior = true;
          this.carryOverPlanDomNodes(undefined, nextPlan, block);
          this.blockPlans.set(block, nextPlan);
          this.renderPlan(nextPlan);
          const vp = this.classifyBlockViewportState(block);
          void this.dispatchPlan(nextPlan, vp.isStrictlyVisible ? 0 : 1);
          return;
        }
      }
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
          this.setSourceHidden(block, false);
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
      if (
        this.blockPlans.has(block) ||
        this.hasMountedTranslation(block) ||
        this.failedBlockTasks.has(block)
      ) {
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
      if (!vpState.isStrictlyVisible && !vpState.isWithinLookahead) {
        missesForObserver.push(block);
        continue;
      }

      const plan = this.planBlock(prepared);
      if (plan) {
        this.observedBlocks.add(block);
        this.blockPlans.set(block, plan);
        this.renderPlan(plan);
        void this.dispatchPlan(plan, vpState.isStrictlyVisible ? 0 : 1);
        continue;
      }

      if (vpState.isStrictlyVisible) {
        this.observedBlocks.add(block);
        candidateP0.push(prepared);
      } else {
        this.observedBlocks.add(block);
        candidateP1.push(prepared);
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
    this.pruneDisconnectedNodes();
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

      for (const planBlock of this.blockPlans.keys()) {
        if (
          planBlock.isConnected &&
          (r === planBlock ||
            r.contains(planBlock) ||
            (r instanceof Node && planBlock.contains(r)))
        ) {
          staleCheckCandidates.add(planBlock);
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

        if (m.removedNodes.length > 0) {
          for (let i = 0; i < m.removedNodes.length; i++) {
            const removed = m.removedNodes[i];
            if (removed.nodeType === Node.ELEMENT_NODE) {
              hasExternalMutation = true;
            }
            if (
              effectiveTargetEl &&
              removed.nodeType === Node.ELEMENT_NODE &&
              (removed as Element).getAttribute('data-margin-injected') ===
                'true'
            ) {
              this.pendingSpaRoots.add(effectiveTargetEl);
              hasExternalMutation = true;
              break;
            }
            if (
              effectiveTargetEl &&
              (effectiveTargetEl.closest('[data-margin-translated="true"]') !==
                null ||
                effectiveTargetEl.closest('[data-margin-src-hidden="true"]') !==
                  null)
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
            targetEl.closest('[data-margin-translated="true"]') !== null ||
            targetEl.closest('[data-margin-src-hidden="true"]') !== null)
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
        if (!this.active) return;
        this.pruneDisconnectedNodes();
        if (this.pendingSpaRoots.size === 0) return;
        const roots = Array.from(this.pendingSpaRoots);
        this.pendingSpaRoots.clear();
        this.scanAndRegisterSpaRoots(roots);
      }, SPA_MUTATION_DEBOUNCE_MS);
    }
  }

  private syncHostThemeStyles(): void {
    const blocksToSync = new Set<HTMLElement>();
    for (const blk of Array.from(this.translatedBlockSet)) {
      if (blk.isConnected) {
        blocksToSync.add(blk);
      } else {
        this.translatedBlockSet.delete(blk);
      }
    }
    for (const blk of this.inFlightBlockSet) {
      if (blk.isConnected) {
        blocksToSync.add(blk);
      }
    }
    for (const blk of this.failedBlockTasks.keys()) {
      if (blk.isConnected) {
        blocksToSync.add(blk);
      }
    }
    for (const blk of this.blockPlans.keys()) {
      if (blk.isConnected) {
        blocksToSync.add(blk);
      }
    }
    if (blocksToSync.size === 0) return;

    this.runInternalDomMutation(() => {
      for (const blockEl of blocksToSync) {
        const effectiveStyle = resolveEffectiveHostTextStyle(blockEl);
        for (let i = 0; i < blockEl.children.length; i++) {
          const child = blockEl.children[i];
          if (
            child instanceof HTMLElement &&
            child.getAttribute('data-margin-injected') === 'true'
          ) {
            applyEffectiveHostTextStyle(child, effectiveStyle);
            if (child.classList.contains('margin-trans-root')) {
              refreshClonedLinksAppearance(child);
            }
          }
        }
      }
    });
  }

  private scheduleHostThemeSync(): void {
    if (this.cancelScheduledThemeSync !== null) return;
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

    let settled = false;
    let rafHandle: number | null = null;
    let timerHandle: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (settled) return;
      settled = true;
      if (rafHandle !== null) {
        caf?.(rafHandle);
        rafHandle = null;
      }
      if (timerHandle !== null) {
        clearTimeout(timerHandle);
        timerHandle = null;
      }
      this.cancelScheduledThemeSync = null;
      this.syncHostThemeStyles();
    };

    if (raf) {
      rafHandle = raf(flush);
    }
    timerHandle = setTimeout(flush, 16);

    this.cancelScheduledThemeSync = () => {
      settled = true;
      if (rafHandle !== null) {
        caf?.(rafHandle);
        rafHandle = null;
      }
      if (timerHandle !== null) {
        clearTimeout(timerHandle);
        timerHandle = null;
      }
    };
  }

  private ensureThemeObserver(): void {
    if (
      typeof MutationObserver !== 'undefined' &&
      !this.themeObserver
    ) {
      this.themeObserver = new MutationObserver((mutations) => {
        if (this.internalDomDepth > 0) return;
        for (const m of mutations) {
          if (m.type === 'attributes') {
            this.scheduleHostThemeSync();
            break;
          }
        }
      });

      const docEl = this.doc.documentElement;
      if (docEl) {
        this.themeObserver.observe(docEl, {
          attributes: true,
          attributeFilter: THEME_OBSERVER_ATTRIBUTES,
        });
      }
      this.themeObservedBody = null;
    }

    if (
      this.themeObserver &&
      this.doc.body &&
      this.doc.body !== this.doc.documentElement &&
      this.themeObservedBody !== this.doc.body
    ) {
      this.themeObserver.observe(this.doc.body, {
        attributes: true,
        attributeFilter: THEME_OBSERVER_ATTRIBUTES,
      });
      this.themeObservedBody = this.doc.body;
    }

    if (!this.themeMediaCleanup) {
      const win =
        this.doc.defaultView ??
        (typeof window !== 'undefined' ? window : null);
      if (win && typeof win.matchMedia === 'function') {
        try {
          const mql = win.matchMedia('(prefers-color-scheme: dark)');
          const onMediaChange = () => {
            this.scheduleHostThemeSync();
          };
          if (typeof mql.addEventListener === 'function') {
            mql.addEventListener('change', onMediaChange);
            this.themeMediaCleanup = () => {
              mql.removeEventListener('change', onMediaChange);
            };
          } else if (typeof mql.addListener === 'function') {
            mql.addListener(onMediaChange);
            this.themeMediaCleanup = () => {
              mql.removeListener(onMediaChange);
            };
          }
        } catch {
          // Ignore matchMedia errors in restricted environments
        }
      }
    }
  }

  private cleanupThemeObserver(): void {
    this.cancelScheduledThemeSync?.();
    this.cancelScheduledThemeSync = null;
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.themeObservedBody = null;
    this.themeMediaCleanup?.();
    this.themeMediaCleanup = null;
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
    this.ensureThemeObserver();
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
    this.ensureThemeObserver();
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

  stop(): void {
    this.cleanupThemeObserver();
    this.restorePage();
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
    this.cleanupThemeObserver();
    const ownedBlocksSnapshot = new Set<HTMLElement>(this.translatedBlockSet);
    for (const blk of this.failedBlockTasks.keys()) {
      ownedBlocksSnapshot.add(blk);
    }
    for (const blk of this.inFlightBlockSet) {
      ownedBlocksSnapshot.add(blk);
    }
    for (const [blk, plan] of this.blockPlans.entries()) {
      plan.superseded = true;
      ownedBlocksSnapshot.add(blk);
    }
    for (const blk of this.hiddenSourceBlocks) {
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

    // Reset observedBlocks & in-flight maps + advance sessionGen so re-enabling page translation or switching language re-observes cleanly!
    this.sessionGen += 1;
    this.observedBlocks = new WeakSet<HTMLElement>();
    this.inFlightBlocks = new WeakSet<HTMLElement>();
    this.inFlightBlockPromises = new WeakMap<HTMLElement, Promise<void>>();

    for (const ctrl of Array.from(this.activeControllers)) {
      ctrl.abort();
    }
    this.activeControllers.clear();
    this.batchTasksByController.clear();
    this.inFlightTasksByBlock.clear();
    this.blockPlans.clear();
    this.recentPrefixes.clear();
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
        for (const blk of Array.from(this.hiddenSourceBlocks)) {
          this.hiddenSourceBlocks.delete(blk);
          blk.removeAttribute('data-margin-src-hidden');
          clearNativelyHiddenChildrenSnapshot(blk);
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

      for (const blk of Array.from(this.hiddenSourceBlocks)) {
        blk.removeAttribute('data-margin-src-hidden');
        clearNativelyHiddenChildrenSnapshot(blk);
      }
      this.hiddenSourceBlocks.clear();
      const hiddenBlocks = Array.from(
        this.doc.querySelectorAll<HTMLElement>('[data-margin-src-hidden="true"]'),
      );
      for (const blk of hiddenBlocks) {
        blk.removeAttribute('data-margin-src-hidden');
        clearNativelyHiddenChildrenSnapshot(blk);
      }

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
      hashAssistantFingerprint(assistant),
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

    if (prevSig !== nextSig) {
      this.recentPrefixes.clear();
      if (this.active) {
        this.restorePage();
        this.enablePageTranslation();
        return;
      }
    }

    const effectiveTheme = this.resolveEffectiveTheme();
    const newDisplayMode = nextConfig.webpage.displayMode;

    // Re-render segmented BlockPlans in place (including mid-revalidation pins & identity segments) with zero network
    for (const [blk, plan] of Array.from(this.blockPlans.entries())) {
      if (!blk.isConnected) {
        this.supersedePlan(plan);
        this.blockPlans.delete(blk);
        continue;
      }
      this.renderPlan(plan);
    }

    this.runInternalDomMutation(() => {
      const spans = Array.from(
        this.doc.querySelectorAll<HTMLElement>(
          '.margin-trans-root[data-margin-injected="true"]',
        ),
      );
      for (const span of spans) {
        const parentBlock = span.parentElement;
        if (!parentBlock) continue;
        if (this.blockPlans.has(parentBlock)) {
          continue;
        }

        span.setAttribute('data-margin-theme', effectiveTheme);

        if (prevTargetLang !== nextConfig.targetLang) {
          this.applyTargetLocaleTypography(span, parentBlock);
        }

        if (prevDisplayMode !== newDisplayMode) {
          if (newDisplayMode === 'target-only') {
            const effectiveStyle = resolveEffectiveHostTextStyle(parentBlock);
            this.setSourceHidden(parentBlock, true);
            applyEffectiveHostTextStyle(span, effectiveStyle);
          } else {
            this.setSourceHidden(parentBlock, false);
            applyEffectiveHostTextStyle(
              span,
              resolveEffectiveHostTextStyle(parentBlock),
            );
          }
          refreshClonedLinksAppearance(span);
        }

        const meta = this.mountedMeta.get(parentBlock);
        if (
          prevDisplayMode !== newDisplayMode &&
          newDisplayMode === 'bilingual' &&
          meta &&
          isRedundantIdenticalTranslation(meta.sourceText, meta.translatedText)
        ) {
          this.clearBlockInjectedElements(parentBlock);
          this.setSourceHidden(parentBlock, false);
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
        this.ensureInjectedRootAtEnd(parentBlock, span);
        this.unclampForInjectedNode(parentBlock, span);
      }
    });
  }

  destroy(options: { contextInvalidated?: boolean } = {}): void {
    const contextInvalidated = Boolean(options.contextInvalidated);
    this.cleanupThemeObserver();
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
    this.userInteractionCleanup?.();
    this.userInteractionCleanup = null;
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
