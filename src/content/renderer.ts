import { resolveProviderIdForScene } from '@shared/constants';
import {
  requestBatchTranslation,
  streamBatchTranslation,
  type StreamBatchCallbacks,
} from '@shared/messaging';
import type {
  BatchItemOutput,
  DisplayMode,
  MarginConfig,
  PageContextPayload,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslationScene,
  TranslationTheme,
} from '@shared/types';
import { resolveThemeForUrl } from '@shared/url-match';
import {
  extractPageContext,
  extractParagraphBlocks,
} from './dom-walker';
import {
  reconstructRichDom,
  tokenizeParagraph,
  type TokenizedParagraph,
} from './rich-text';

export const DEFAULT_LRU_CAPACITY = 2000;
export const VIEWPORT_ROOT_MARGIN = '600px 0px';

const STYLE_ELEMENT_ID = 'margin-webpage-styles';

export const WEBPAGE_INJECTED_CSS = /* css */ `
.margin-orig-source[data-margin-orig-wrap="true"] {
  display: none !important;
}

.margin-trans-root[data-margin-injected="true"] {
  font: inherit;
  color: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  word-break: break-word;
}

.margin-trans-root[data-margin-layout="inline"] {
  display: inline;
  margin-inline-start: 0.48em;
}

.margin-trans-root[data-margin-layout="block"] {
  display: block;
  margin-top: 0.38em;
  margin-bottom: 0.12em;
}

.margin-trans-root[data-margin-layout="replace"] {
  display: inline;
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

export function isDocumentFullscreen(doc: Document = document): boolean {
  const anyDoc = doc as Document & { webkitFullscreenElement?: Element | null };
  return Boolean(doc.fullscreenElement || anyDoc.webkitFullscreenElement);
}

/**
 * Syncs `data-margin-fullscreen-hidden="true"` across all floating Margin UI hosts
 * whenever `document.fullscreenElement` changes.
 */
export function syncFullscreenFloatingVisibility(doc: Document = document): boolean {
  const active = isDocumentFullscreen(doc);
  const hosts = doc.querySelectorAll('[data-margin-floating="true"]');
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    if (active) {
      host.setAttribute('data-margin-fullscreen-hidden', 'true');
    } else {
      host.removeAttribute('data-margin-fullscreen-hidden');
    }
  }
  return active;
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

  private active = false;
  private maskRevealedGlobally = false;
  private internalDomDepth = 0;

  private intersectionObserver: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private fullscreenCleanup: (() => void) | null = null;

  private readonly observedBlocks = new WeakSet<HTMLElement>();
  private readonly inFlightBlocks = new WeakSet<HTMLElement>();
  private readonly mountedMeta = new WeakMap<HTMLElement, MountedBlockMeta>();
  private readonly pendingViewportQueue = new Map<HTMLElement, TranslationScene>();

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
      (() => this.doc.location?.href || (typeof location !== 'undefined' ? location.href : ''));
    this.cache = options.cache ?? new LruTranslationCache(DEFAULT_LRU_CAPACITY);
    this.transport = options.transport ?? defaultBatchTransport;
    this.flushDelayMs = options.flushDelayMs ?? 32;

    this.bindFullscreenListener();
  }

  get isActive(): boolean {
    return this.active;
  }

  get isMaskRevealed(): boolean {
    return this.maskRevealedGlobally;
  }

  private runInternalDomMutation<T>(fn: () => T): T {
    this.internalDomDepth += 1;
    try {
      return fn();
    } finally {
      this.internalDomDepth -= 1;
    }
  }

  private ensureStylesInjected(): void {
    if (this.doc.getElementById(STYLE_ELEMENT_ID)) return;
    const parent = this.doc.head || this.doc.documentElement || this.doc.body;
    if (!parent) return;
    this.runInternalDomMutation(() => {
      const style = this.doc.createElement('style');
      style.id = STYLE_ELEMENT_ID;
      style.setAttribute('data-margin-injected', 'true');
      style.textContent = WEBPAGE_INJECTED_CSS;
      parent.appendChild(style);
    });
  }

  private bindFullscreenListener(): void {
    const handler = () => {
      syncFullscreenFloatingVisibility(this.doc);
    };
    this.doc.addEventListener('fullscreenchange', handler);
    this.doc.addEventListener('webkitfullscreenchange', handler);
    syncFullscreenFloatingVisibility(this.doc);
    this.fullscreenCleanup = () => {
      this.doc.removeEventListener('fullscreenchange', handler);
      this.doc.removeEventListener('webkitfullscreenchange', handler);
    };
  }

  resolveEffectiveTheme(): TranslationTheme {
    return resolveThemeForUrl(
      this.getUrl(),
      this.config.webpage.theme,
      this.config.webpage.themePatterns,
    );
  }

  private computeLayoutMode(
    plainTextLength: number,
    displayMode: DisplayMode = this.config.webpage.displayMode,
  ): 'inline' | 'block' | 'replace' {
    if (displayMode === 'target-only') {
      return 'replace';
    }
    const maxInline = this.config.webpage.lineBreakMaxTextCount;
    if (maxInline > 0 && plainTextLength <= maxInline) {
      return 'inline';
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
    const model = this.config.providers[providerId]?.model ?? '';
    return `${providerId}:${model}:${this.config.targetLang}:${enableRichHtml ? '1' : '0'}:${tokenizedText}`;
  }

  private getPageContext(scene: TranslationScene): PageContextPayload | undefined {
    const providerId = resolveProviderIdForScene(
      scene,
      this.config.routing,
      this.config.providers,
    );
    const provider = this.config.providers[providerId];
    if (provider && !provider.enableContext) {
      return undefined;
    }
    const currentUrl = this.getUrl();
    if (this.pageContextCache && this.pageContextCache.url === currentUrl) {
      return this.pageContextCache.payload;
    }
    const extracted = extractPageContext(this.doc);
    this.pageContextCache = { url: currentUrl, payload: extracted };
    return extracted;
  }

  private resolveBatchLimits(scene: TranslationScene): {
    maxBatchCount: number;
    maxCharsPerBatch: number;
    preferStream: boolean;
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

    return {
      maxBatchCount,
      maxCharsPerBatch,
      preferStream,
      providerId,
    };
  }

  hasMountedTranslation(blockEl: HTMLElement): boolean {
    for (let i = 0; i < blockEl.children.length; i++) {
      const child = blockEl.children[i];
      if (
        child.classList.contains('margin-trans-root') &&
        child.getAttribute('data-margin-injected') === 'true'
      ) {
        return true;
      }
    }
    return false;
  }

  private wrapOriginalContentForTargetOnly(blockEl: HTMLElement): void {
    // Check if already wrapped
    for (let i = 0; i < blockEl.children.length; i++) {
      if (blockEl.children[i].getAttribute('data-margin-orig-wrap') === 'true') {
        return;
      }
    }

    const wrapper = this.doc.createElement('span');
    wrapper.className = 'margin-orig-source';
    wrapper.setAttribute('data-margin-orig-wrap', 'true');
    wrapper.hidden = true;
    wrapper.style.setProperty('display', 'none', 'important');

    const nodesToMove: ChildNode[] = [];
    for (let i = 0; i < blockEl.childNodes.length; i++) {
      const child = blockEl.childNodes[i];
      if (
        child.nodeType === Node.ELEMENT_NODE &&
        (child as Element).hasAttribute('data-margin-injected')
      ) {
        continue;
      }
      nodesToMove.push(child);
    }

    for (const node of nodesToMove) {
      wrapper.appendChild(node);
    }

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
      el.remove();
    }
  }

  removeBlockTranslation(blockEl: HTMLElement): void {
    this.runInternalDomMutation(() => {
      this.clearBlockInjectedElements(blockEl);
      this.unwrapOriginalContent(blockEl);
      blockEl.removeAttribute('data-margin-translated');
      this.mountedMeta.delete(blockEl);
    });
  }

  private mountBlockTranslation(
    blockEl: HTMLElement,
    tokenized: TokenizedParagraph,
    translatedText: string,
    options: { forceBilingual?: boolean } = {},
  ): { fallbackPlain: boolean } {
    this.ensureStylesInjected();
    const reconstructed = reconstructRichDom(translatedText, tokenized, this.doc);
    const displayMode: DisplayMode = options.forceBilingual
      ? 'bilingual'
      : this.config.webpage.displayMode;
    const theme = this.resolveEffectiveTheme();
    const layout = this.computeLayoutMode(tokenized.plainTextLength, displayMode);

    this.runInternalDomMutation(() => {
      this.clearBlockInjectedElements(blockEl);

      if (displayMode === 'target-only') {
        this.wrapOriginalContentForTargetOnly(blockEl);
      } else {
        this.unwrapOriginalContent(blockEl);
      }

      const span = this.doc.createElement('span');
      span.className = 'margin-trans-root';
      span.setAttribute('data-margin-injected', 'true');
      span.setAttribute('data-margin-theme', theme);
      span.setAttribute('data-margin-layout', layout);
      if (reconstructed.fallbackPlain) {
        span.setAttribute('data-margin-fallback-plain', 'true');
      }
      span.appendChild(reconstructed.fragment);

      // Allow clicking a masked span directly to toggle individual reveal without breaking links
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

      blockEl.appendChild(span);
      blockEl.setAttribute('data-margin-translated', 'true');
      this.mountedMeta.set(blockEl, {
        plainTextLength: tokenized.plainTextLength,
        fallbackPlain: reconstructed.fallbackPlain,
      });
    });

    return { fallbackPlain: reconstructed.fallbackPlain };
  }

  private mountBatchRetryButtons(
    batchTasks: readonly PreparedBlockTask[],
    errorMessage: string,
    options: { forceBilingual?: boolean } = {},
  ): void {
    this.ensureStylesInjected();
    this.runInternalDomMutation(() => {
      const retryBatch = () => {
        // Clear retry buttons ONLY on this failed batch, never wiping translated siblings!
        this.runInternalDomMutation(() => {
          for (const t of batchTasks) {
            for (let i = t.block.children.length - 1; i >= 0; i--) {
              const child = t.block.children[i];
              if (child.classList.contains('margin-inline-retry')) {
                child.remove();
              }
            }
          }
        });
        void this.executeBatch(batchTasks, options);
      };

      for (const task of batchTasks) {
        if (!task.block.isConnected || this.hasMountedTranslation(task.block)) {
          continue;
        }
        // Remove any prior retry button on this block
        for (let i = task.block.children.length - 1; i >= 0; i--) {
          const child = task.block.children[i];
          if (child.classList.contains('margin-inline-retry')) {
            child.remove();
          }
        }

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
        task.block.appendChild(btn);
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

  private async executeBatch(
    batchTasks: readonly PreparedBlockTask[],
    options: { forceBilingual?: boolean } = {},
  ): Promise<void> {
    if (batchTasks.length === 0) return;

    const scene = batchTasks[0].scene;
    const { preferStream, providerId } = this.resolveBatchLimits(scene);
    const abortController = new AbortController();
    this.activeControllers.add(abortController);

    for (const task of batchTasks) {
      this.inFlightBlocks.add(task.block);
    }

    const slotMap = new Map<number, PreparedBlockTask>();
    const renderedSlots = new Set<number>();

    const requestItems = batchTasks.map((task, idx) => {
      const id = idx + 1;
      slotMap.set(id, task);
      return {
        id,
        text: task.tokenized.text,
        hasRichTags: task.tokenized.hasRichTags,
      };
    });

    const payload: TranslateBatchRequest = {
      requestId: nextRequestId(scene),
      scene,
      providerId,
      fromLang: this.config.sourceLang,
      toLang: this.config.targetLang,
      items: requestItems,
      context: this.getPageContext(scene),
    };

    const applyOutputItem = (item: BatchItemOutput) => {
      if (abortController.signal.aborted) return;
      const task = slotMap.get(item.id);
      if (!task || renderedSlots.has(item.id)) return;
      if (typeof item.trans !== 'string' || !item.trans.trim()) return;

      renderedSlots.add(item.id);
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
    };

    try {
      const response = await this.transport(
        payload,
        {
          onItemReady: (item) => {
            applyOutputItem(item);
          },
        },
        abortController.signal,
        preferStream,
      );

      if (abortController.signal.aborted) return;

      if (!response.ok) {
        const unrendered = batchTasks.filter(
          (_, idx) => !renderedSlots.has(idx + 1),
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
        (_, idx) => !renderedSlots.has(idx + 1),
      );
      if (missingTasks.length > 0) {
        this.mountBatchRetryButtons(
          missingTasks,
          'Incomplete batch response',
          options,
        );
      }
    } catch (err) {
      if (abortController.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      const unrendered = batchTasks.filter(
        (_, idx) => !renderedSlots.has(idx + 1),
      );
      this.mountBatchRetryButtons(unrendered, msg, options);
    } finally {
      this.activeControllers.delete(abortController);
      for (const task of batchTasks) {
        this.inFlightBlocks.delete(task.block);
      }
    }
  }

  /**
   * Translates an explicit list of paragraph blocks immediately (checking LRU cache first,
   * then packing misses into bounded batches).
   */
  async translateBlocks(
    blocks: readonly HTMLElement[],
    scene: TranslationScene = 'webpage',
    options: { forceBilingual?: boolean } = {},
  ): Promise<void> {
    const misses: PreparedBlockTask[] = [];

    for (const block of blocks) {
      if (!block.isConnected) continue;
      if (this.hasMountedTranslation(block) || this.inFlightBlocks.has(block)) {
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

    if (misses.length === 0) return;

    const { maxBatchCount, maxCharsPerBatch } = this.resolveBatchLimits(scene);
    const batches = packIntoBatches(misses, maxBatchCount, maxCharsPerBatch);
    await Promise.all(
      batches.map((batch) => this.executeBatch(batch, options)),
    );
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

  private scheduleFlushViewportQueue(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.active || this.pendingViewportQueue.size === 0) return;
      const entries = Array.from(this.pendingViewportQueue.entries());
      this.pendingViewportQueue.clear();
      const blocks = entries.map(([blk]) => blk);
      const scene = entries[0][1];
      void this.translateBlocks(blocks, scene);
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
            !this.inFlightBlocks.has(target)
          ) {
            this.pendingViewportQueue.set(target, 'webpage');
            added = true;
          }
        }
        if (added) {
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

  private registerBlocksForViewport(blocks: readonly HTMLElement[]): void {
    const missesForObserver: HTMLElement[] = [];

    for (const block of blocks) {
      if (!block.isConnected || this.hasMountedTranslation(block)) continue;

      // Instant zero-API re-attachment if already in 2000-entry LRU cache!
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

      missesForObserver.push(block);
    }

    if (missesForObserver.length === 0) return;

    const io = this.ensureIntersectionObserver();
    if (!io) {
      void this.translateBlocks(missesForObserver, 'webpage');
      return;
    }

    for (const block of missesForObserver) {
      this.observedBlocks.add(block);
      io.observe(block);
    }
  }

  private isMarginInternalNode(node: Node): boolean {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = node as Element;
    return (
      el.hasAttribute('data-margin-injected') ||
      el.hasAttribute('data-margin-orig-wrap') ||
      el.hasAttribute('data-margin-host') ||
      Boolean(
        el.closest?.(
          '[data-margin-injected], [data-margin-orig-wrap], [data-margin-host]',
        ),
      )
    );
  }

  private ensureSpaMutationObserver(): void {
    if (this.mutationObserver || typeof MutationObserver === 'undefined') return;
    const root = this.doc.body || this.doc.documentElement;
    if (!root) return;

    this.mutationObserver = new MutationObserver((mutations) => {
      if (!this.active || this.internalDomDepth > 0) return;

      for (const m of mutations) {
        if (m.type !== 'childList' || m.addedNodes.length === 0) continue;
        if (this.isMarginInternalNode(m.target)) continue;

        let hasExternalAddition = false;
        for (let i = 0; i < m.addedNodes.length; i++) {
          const added = m.addedNodes[i];
          if (this.isMarginInternalNode(added)) continue;
          if (added.nodeType === Node.ELEMENT_NODE) {
            this.pendingSpaRoots.add(added as Element);
            hasExternalAddition = true;
          } else if (
            added.nodeType === Node.TEXT_NODE &&
            added.nodeValue?.trim() &&
            m.target instanceof Element
          ) {
            this.pendingSpaRoots.add(m.target);
            hasExternalAddition = true;
          }
        }

        if (hasExternalAddition && this.spaMutationTimer === null) {
          this.spaMutationTimer = setTimeout(() => {
            this.spaMutationTimer = null;
            if (!this.active || this.pendingSpaRoots.size === 0) return;
            const roots = Array.from(this.pendingSpaRoots);
            this.pendingSpaRoots.clear();

            const discovered = new Set<HTMLElement>();
            for (const r of roots) {
              if (r instanceof Node && !r.isConnected) continue;
              for (const blk of extractParagraphBlocks(r)) {
                discovered.add(blk);
              }
            }
            if (discovered.size > 0) {
              this.registerBlocksForViewport(Array.from(discovered));
            }
          }, 80);
        }
      }
    });

    this.mutationObserver.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * Enables progressive viewport webpage translation + SPA virtual-scroll observer.
   */
  enablePageTranslation(): void {
    this.active = true;
    this.ensureStylesInjected();
    const blocks = extractParagraphBlocks(this.doc.body);
    this.registerBlocksForViewport(blocks);
    this.ensureSpaMutationObserver();
  }

  /**
   * Translates all readable blocks across the entire document immediately (`Alt+W`).
   */
  async translateWholePage(): Promise<void> {
    this.active = true;
    this.ensureStylesInjected();
    this.ensureSpaMutationObserver();
    const blocks = extractParagraphBlocks(this.doc.body);
    await this.translateBlocks(blocks, 'webpage');
  }

  /**
   * Disables webpage translation and cleanly restores the exact original DOM
   * (including unwrapping `target-only` blocks) with zero page reload.
   */
  restorePage(): void {
    this.active = false;

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.spaMutationTimer !== null) {
      clearTimeout(this.spaMutationTimer);
      this.spaMutationTimer = null;
    }
    this.pendingViewportQueue.clear();
    this.pendingSpaRoots.clear();

    for (const ctrl of this.activeControllers) {
      ctrl.abort();
    }
    this.activeControllers.clear();

    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

    this.runInternalDomMutation(() => {
      // Unwrap all reversible target-only wrappers back to exact original DOM nodes
      const wrappers = Array.from(
        this.doc.querySelectorAll('[data-margin-orig-wrap="true"]'),
      );
      for (const wrapper of wrappers) {
        const parent = wrapper.parentElement;
        if (parent) {
          while (wrapper.firstChild) {
            parent.insertBefore(wrapper.firstChild, wrapper);
          }
        }
        wrapper.remove();
      }

      // Remove all injected translation spans and retry buttons (keep stylesheet cached or remove cleanly)
      const injected = Array.from(
        this.doc.querySelectorAll(
          '[data-margin-injected="true"]:not(#margin-webpage-styles)',
        ),
      );
      for (const node of injected) {
        node.remove();
      }

      const markedBlocks = Array.from(
        this.doc.querySelectorAll('[data-margin-translated="true"]'),
      );
      for (const blk of markedBlocks) {
        blk.removeAttribute('data-margin-translated');
      }
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

  /**
   * Applies live configuration changes (`theme`, `displayMode`, `lineBreakMaxTextCount`)
   * onto already-rendered DOM nodes immediately without reloading or re-requesting APIs.
   */
  updateConfig(nextConfig: MarginConfig): void {
    const prevDisplayMode = this.config.webpage.displayMode;
    this.config = nextConfig;

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

        if (prevDisplayMode !== newDisplayMode) {
          if (newDisplayMode === 'target-only') {
            this.wrapOriginalContentForTargetOnly(parentBlock);
          } else {
            this.unwrapOriginalContent(parentBlock);
          }
        }

        const meta = this.mountedMeta.get(parentBlock);
        const plainLen = meta?.plainTextLength ?? (span.textContent?.length ?? 0);
        span.setAttribute(
          'data-margin-layout',
          this.computeLayoutMode(plainLen, newDisplayMode),
        );
      }
    });
  }

  destroy(): void {
    this.restorePage();
    this.fullscreenCleanup?.();
    this.fullscreenCleanup = null;
    this.doc.getElementById(STYLE_ELEMENT_ID)?.remove();
  }
}
