import { resolveProviderIdForScene } from '@shared/constants';
import {
  isExtensionContextValid,
  requestBatchTranslation,
  streamBatchTranslation,
  type StreamBatchCallbacks,
} from '@shared/messaging';
import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import type {
  MarginConfig,
  TranslateBatchRequest,
  TranslateBatchResponse,
} from '@shared/types';
import { isContentEditableNode } from './dom-walker';
import { syncFullscreenFloatingVisibility } from './renderer';

const SUPPORTED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'url',
  'email',
  'tel',
]);

const CJK_CHAR_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/u;
const KANA_CHAR_RE = /[\u3040-\u30FF]/u;
const HANGUL_CHAR_RE = /[\uAC00-\uD7AF]/u;

const INPUT_PILL_CSS = /* css */ `
${SHADOW_HOST_RESET_CSS}

.pill {
  position: fixed;
  z-index: 2147483646;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--rule-strong);
  border-radius: 5px;
  box-shadow: 0 4px 14px rgba(21, 20, 17, 0.12);
  font-size: 12px;
  line-height: 16px;
  user-select: none;
  pointer-events: auto;
}

.pill[hidden] {
  display: none !important;
}

.pill[data-error="true"] {
  border-color: rgba(180, 65, 46, 0.45);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
  flex-shrink: 0;
}

.label {
  color: var(--ink-soft);
  font-weight: 500;
  white-space: nowrap;
}

.cancel-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  font-size: 11px;
  line-height: 14px;
  color: var(--muted);
  background: var(--paper-soft);
  border: 1px solid var(--rule);
  border-radius: 4px;
  cursor: pointer;
}

.cancel-btn:hover {
  color: var(--ink);
  background: var(--state-hover-surface);
  border-color: var(--control-border);
}
`;

/**
 * Traverses nested open ShadowRoots to return the deepest focused element.
 */
export function deepActiveElement(
  root: Document | ShadowRoot = document,
): Element | null {
  let active: Element | null = root.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/**
 * Resolves a candidate element to a supported editable root (`<textarea>`, text-like `<input>`,
 * or outermost `[contenteditable]` container), or `null` if not editable.
 */
export function resolveEditableTarget(candidate: Element | null): HTMLElement | null {
  if (!candidate || !(candidate instanceof HTMLElement)) {
    return null;
  }
  if (candidate.closest?.('[data-margin-host]')) {
    return null;
  }

  const tag = candidate.tagName.toUpperCase();
  if (tag === 'TEXTAREA') {
    const ta = candidate as HTMLTextAreaElement;
    return !ta.disabled && !ta.readOnly ? ta : null;
  }

  if (tag === 'INPUT') {
    const inp = candidate as HTMLInputElement;
    if (inp.disabled || inp.readOnly) return null;
    const inputType = (inp.getAttribute('type') || inp.type || 'text')
      .trim()
      .toLowerCase();
    return SUPPORTED_INPUT_TYPES.has(inputType) ? inp : null;
  }

  if (isContentEditableNode(candidate)) {
    let rootEditable: HTMLElement = candidate;
    while (
      rootEditable.parentElement &&
      isContentEditableNode(rootEditable.parentElement)
    ) {
      rootEditable = rootEditable.parentElement;
    }
    return rootEditable;
  }

  return null;
}

const EDITABLE_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'DIV',
  'P',
  'LI',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'SECTION',
  'ARTICLE',
  'TR',
]);

function extractContentEditableText(root: HTMLElement): string {
  let out = '';
  let pendingBlockBreak = false;

  const flushPendingBreak = () => {
    if (pendingBlockBreak && out.length > 0 && !out.endsWith('\n')) {
      out += '\n';
    }
    pendingBlockBreak = false;
  };

  const walk = (node: Node): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const val = child.nodeValue ?? '';
        if (val.length > 0) {
          flushPendingBreak();
          out += val;
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as HTMLElement;
      const tag = el.tagName.toUpperCase();
      if (tag === 'BR') {
        const isTrailingPlaceholderBr =
          el.nextSibling === null &&
          el.previousSibling !== null &&
          el.previousSibling.nodeName.toUpperCase() !== 'BR' &&
          node !== root &&
          node instanceof HTMLElement &&
          EDITABLE_BLOCK_TAGS.has(node.tagName.toUpperCase());
        if (!isTrailingPlaceholderBr) {
          flushPendingBreak();
          out += '\n';
        }
        continue;
      }

      const isBlock = EDITABLE_BLOCK_TAGS.has(tag);
      if (isBlock && out.length > 0 && !out.endsWith('\n')) {
        pendingBlockBreak = true;
      }
      walk(el);
      if (isBlock && out.length > 0) {
        pendingBlockBreak = true;
      }
    }
  };

  walk(root);
  return out;
}

export function readEditableText(target: HTMLElement): string {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return target.value;
  }
  return extractContentEditableText(target);
}

/**
 * Computes the fraction (`0..1`) of non-whitespace characters that are CJK ideographs/kana/hangul.
 */
export function computeCjkRatio(text: string): number {
  const compact = Array.from(text.replace(/\s+/g, ''));
  if (compact.length === 0) return 0;
  let cjkCount = 0;
  for (const ch of compact) {
    if (CJK_CHAR_RE.test(ch)) {
      cjkCount += 1;
    }
  }
  return cjkCount / compact.length;
}

/**
 * Smart language direction resolver for Input-Box Quick Translation:
 * - If draft has >= 15% CJK chars, translates to `input.targetLang` (`'en'`), unless `input.targetLang`
 *   itself matches the CJK language, in which case it translates to `fallbackTargetLang` (`'zh-CN'`).
 * - If draft is already in `input.targetLang` (e.g. English when `input.targetLang === 'en'`),
 *   translates to `input.fallbackTargetLang || config.targetLang` (`'zh-CN'`).
 */
export function resolveInputTargetLanguage(
  text: string,
  config: MarginConfig,
): string {
  const primaryTarget = config.input.targetLang || 'en';
  const fallbackTarget =
    config.input.fallbackTargetLang || config.targetLang || 'zh-CN';
  const cjkRatio = computeCjkRatio(text);

  if (cjkRatio >= 0.15) {
    if (/^zh\b/i.test(primaryTarget) && !KANA_CHAR_RE.test(text) && !HANGUL_CHAR_RE.test(text)) {
      return fallbackTarget;
    }
    if (/^ja\b/i.test(primaryTarget) && KANA_CHAR_RE.test(text)) {
      return fallbackTarget;
    }
    if (/^ko\b/i.test(primaryTarget) && HANGUL_CHAR_RE.test(text)) {
      return fallbackTarget;
    }
    return primaryTarget;
  }

  // < 15% CJK: check if text is already in `primaryTarget`
  if (/^en\b/i.test(primaryTarget) && /[a-zA-Z]/.test(text)) {
    return fallbackTarget;
  }
  if (/^ru\b/i.test(primaryTarget) && /[\u0400-\u04FF]/.test(text)) {
    return fallbackTarget;
  }
  if (/^ar\b/i.test(primaryTarget) && /[\u0600-\u06FF]/.test(text)) {
    return fallbackTarget;
  }

  return primaryTarget;
}

function setFormControlValueWithEvents(
  el: HTMLInputElement | HTMLTextAreaElement,
  nextValue: string,
  inputType: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(el, nextValue);
  } else {
    el.value = nextValue;
  }

  const inputEv =
    typeof InputEvent === 'function'
      ? new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          composed: true,
          data: nextValue,
          inputType,
        })
      : new Event('input', { bubbles: true, composed: true });
  el.dispatchEvent(inputEv);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setContentEditableValueWithEvents(
  el: HTMLElement,
  nextValue: string,
  inputType: string,
): void {
  if (typeof InputEvent === 'function') {
    const beforeEv = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      composed: true,
      data: nextValue,
      inputType: 'insertReplacementText',
    });
    el.dispatchEvent(beforeEv);
  }

  if (readEditableText(el) !== nextValue) {
    if (nextValue.includes('\n')) {
      const doc = el.ownerDocument || document;
      const frag = doc.createDocumentFragment();
      const lines = nextValue.split('\n');
      lines.forEach((line, idx) => {
        if (idx > 0) {
          frag.appendChild(doc.createElement('br'));
        }
        if (line.length > 0) {
          frag.appendChild(doc.createTextNode(line));
        }
      });
      el.replaceChildren(frag);
    } else {
      el.textContent = nextValue;
    }
    const inputEv =
      typeof InputEvent === 'function'
        ? new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            composed: true,
            data: nextValue,
            inputType,
          })
        : new Event('input', { bubbles: true, composed: true });
    el.dispatchEvent(inputEv);
  }
}

/**
 * Replaces the full contents of an editable field via `document.execCommand('insertText', false, text)`
 * (falling back to native prototype value setter + `InputEvent('input', { bubbles: true })`),
 * returning `{ usedExecCommand }` so `Ctrl+Z` / `Cmd+Z` undo works reliably across browsers & JSDOM/happy-dom.
 */
export function replaceEditableText(
  target: HTMLElement,
  translatedText: string,
  doc: Document = document,
): { usedExecCommand: boolean } {
  target.focus({ preventScroll: true });

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    target.select();
    try {
      target.setSelectionRange(0, target.value.length);
    } catch {
      // `<input type="email">` does not support setSelectionRange; `select()` suffices
    }

    let execSucceeded = false;
    if (typeof doc.execCommand === 'function') {
      try {
        execSucceeded =
          doc.execCommand('insertText', false, translatedText) === true &&
          target.value === translatedText;
      } catch {
        execSucceeded = false;
      }
    }

    if (!execSucceeded) {
      setFormControlValueWithEvents(target, translatedText, 'insertText');
    }

    try {
      const len = target.value.length;
      target.setSelectionRange(len, len);
    } catch {
      // Ignore types without selection range support
    }

    return { usedExecCommand: execSucceeded };
  }

  // `[contenteditable]` rich editor
  const rootNode = target.getRootNode() as Document | (ShadowRoot & { getSelection?: () => Selection | null });
  const selection =
    ('getSelection' in rootNode && typeof rootNode.getSelection === 'function'
      ? rootNode.getSelection()
      : null) ??
    doc.getSelection?.() ??
    (typeof window !== 'undefined' ? window.getSelection?.() : null);

  if (selection) {
    try {
      const range = doc.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Ignore selection range errors in synthetic DOMs
    }
  }

  let execSucceeded = false;
  if (typeof doc.execCommand === 'function') {
    try {
      execSucceeded =
        doc.execCommand('insertText', false, translatedText) === true &&
        readEditableText(target) === translatedText;
    } catch {
      execSucceeded = false;
    }
  }

  if (!execSucceeded) {
    setContentEditableValueWithEvents(target, translatedText, 'insertText');
  }

  return { usedExecCommand: execSucceeded };
}

export type InputBatchTransportFn = (
  payload: TranslateBatchRequest,
  callbacks: StreamBatchCallbacks,
  signal: AbortSignal,
  preferStream: boolean,
) => Promise<TranslateBatchResponse>;

function defaultInputTransport(
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

interface UndoSnapshot {
  originalText: string;
  translatedText: string;
  usedExecCommand: boolean;
}

export interface InputQuickTranslatorOptions {
  config: MarginConfig;
  doc?: Document;
  now?: () => number;
  transport?: InputBatchTransportFn;
  isUrlExcluded?: () => boolean;
}

let inputReqCounter = 0;

export class InputQuickTranslator {
  private config: MarginConfig;
  private readonly doc: Document;
  private readonly now: () => number;
  private readonly transport: InputBatchTransportFn;
  private readonly isUrlExcluded?: () => boolean;

  private spaceTimestamps: number[] = [];
  private lastSpaceTarget: HTMLElement | null = null;
  private activeAbortController: AbortController | null = null;
  private readonly undoSnapshots = new WeakMap<HTMLElement, UndoSnapshot>();

  private pillHost: HTMLElement | null = null;
  private pillShadow: ShadowRoot | null = null;
  private pillRootEl: HTMLElement | null = null;
  private pillLabelEl: HTMLElement | null = null;
  private pillCancelBtn: HTMLButtonElement | null = null;
  private errorDismissTimer: ReturnType<typeof setTimeout> | null = null;

  private cleanupListeners: (() => void) | null = null;
  private hadRuntimeIdAtMount = false;

  constructor(options: InputQuickTranslatorOptions) {
    this.config = options.config;
    this.doc = options.doc ?? document;
    this.now = options.now ?? (() => Date.now());
    this.transport = options.transport ?? defaultInputTransport;
    this.isUrlExcluded = options.isUrlExcluded;
  }

  mount(): void {
    if (this.cleanupListeners) return;
    this.hadRuntimeIdAtMount = Boolean(globalThis.chrome?.runtime?.id);

    const win = this.doc.defaultView ?? window;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
        this.destroy();
        return;
      }
      this.handleKeyDown(ev);
    };
    const onPointerDown = () => {
      if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
        this.destroy();
        return;
      }
      this.spaceTimestamps = [];
    };

    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('pointerdown', onPointerDown, true);

    this.cleanupListeners = () => {
      win.removeEventListener('keydown', onKeyDown, true);
      win.removeEventListener('pointerdown', onPointerDown, true);
    };
  }

  updateConfig(nextConfig: MarginConfig): void {
    this.config = nextConfig;
    if (this.pillHost) {
      this.pillHost.setAttribute('data-display-mode', nextConfig.uiColorMode);
    }
  }

  cancelInFlight(): boolean {
    if (!this.activeAbortController) return false;
    this.activeAbortController.abort();
    this.activeAbortController = null;
    this.hidePill();
    return true;
  }

  private resolveCurrentEditableFromEvent(ev?: KeyboardEvent): HTMLElement | null {
    if (ev && typeof ev.composedPath === 'function') {
      const path = ev.composedPath();
      for (const item of path) {
        if (item instanceof HTMLElement) {
          const resolved = resolveEditableTarget(item);
          if (resolved) return resolved;
        }
      }
    }
    return resolveEditableTarget(deepActiveElement(this.doc));
  }

  private handleKeyDown(ev: KeyboardEvent): void {
    // 1. Esc cancels in-flight input translation or dismisses visible status/error pill without touching draft
    if (
      ev.key === 'Escape' &&
      (this.activeAbortController || (this.pillHost && !this.pillHost.hidden))
    ) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!this.cancelInFlight()) {
        this.hidePill();
      }
      return;
    }

    // 2. Ctrl+Z / Cmd+Z undo guarantee (fallback when execCommand wasn't native or controlled input overwrote undo)
    if (
      (ev.ctrlKey || ev.metaKey) &&
      !ev.shiftKey &&
      !ev.altKey &&
      ev.key.toLowerCase() === 'z'
    ) {
      const editable = this.resolveCurrentEditableFromEvent(ev);
      if (editable) {
        const snapshot = this.undoSnapshots.get(editable);
        if (snapshot && readEditableText(editable) === snapshot.translatedText) {
          this.undoSnapshots.delete(editable);
          if (!snapshot.usedExecCommand) {
            ev.preventDefault();
            ev.stopPropagation();
            this.restoreUndoSnapshot(editable, snapshot.originalText);
            return;
          }
          // Native execCommand succeeded: let native undo fire first, verify in microtask
          queueMicrotask(() => {
            if (readEditableText(editable) === snapshot.translatedText) {
              this.restoreUndoSnapshot(editable, snapshot.originalText);
            }
          });
        }
      }
      this.spaceTimestamps = [];
      return;
    }

    // Ignore IME composition keys completely
    if (ev.isComposing || ev.keyCode === 229) {
      this.spaceTimestamps = [];
      return;
    }

    // 3. Triple-Space detection
    const isPlainSpace =
      (ev.key === ' ' || ev.code === 'Space') &&
      !ev.ctrlKey &&
      !ev.altKey &&
      !ev.metaKey &&
      !ev.shiftKey &&
      !ev.repeat;

    if (!isPlainSpace) {
      this.spaceTimestamps = [];
      return;
    }

    if (
      !this.config.input.enabled ||
      !this.config.input.tripleSpaceTrigger ||
      this.isUrlExcluded?.()
    ) {
      this.spaceTimestamps = [];
      return;
    }

    const editable = this.resolveCurrentEditableFromEvent(ev);
    if (!editable) {
      this.spaceTimestamps = [];
      this.lastSpaceTarget = null;
      return;
    }

    const windowMs = Math.max(150, this.config.input.tripleSpaceWindowMs || 650);
    const currentNow = this.now();

    if (this.lastSpaceTarget !== editable) {
      this.lastSpaceTarget = editable;
      this.spaceTimestamps = [];
    }

    this.spaceTimestamps = this.spaceTimestamps.filter(
      (ts) => currentNow - ts <= windowMs,
    );
    this.spaceTimestamps.push(currentNow);

    if (this.spaceTimestamps.length >= 3) {
      this.spaceTimestamps = [];
      const currentRaw = readEditableText(editable);
      if (!currentRaw.trim()) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const cleanedDraft = currentRaw.replace(/ {1,3}$/, '').trim() || currentRaw.trim();
      void this.translateTarget(editable, cleanedDraft);
    }
  }

  private restoreUndoSnapshot(editable: HTMLElement, originalText: string): void {
    if (
      editable instanceof HTMLInputElement ||
      editable instanceof HTMLTextAreaElement
    ) {
      setFormControlValueWithEvents(editable, originalText, 'historyUndo');
    } else {
      setContentEditableValueWithEvents(editable, originalText, 'historyUndo');
    }
  }

  /**
   * Translates the currently focused editable field (`Alt+I` / `margin:cmd:translate-input`).
   */
  async translateActiveElement(): Promise<boolean> {
    if (!this.config.input.enabled || this.isUrlExcluded?.()) return false;
    const editable = resolveEditableTarget(deepActiveElement(this.doc));
    if (!editable) return false;
    const raw = readEditableText(editable);
    const trimmed = raw.trim();
    if (!trimmed) return false;
    return this.translateTarget(editable, trimmed);
  }

  async translateTarget(
    editable: HTMLElement,
    explicitSourceText?: string,
  ): Promise<boolean> {
    if (!this.config.input.enabled || this.isUrlExcluded?.()) return false;

    const rawText = explicitSourceText ?? readEditableText(editable);
    const sourceText = rawText.trim();
    if (!sourceText) return false;

    // Cancel any previous in-flight input translation
    if (this.activeAbortController) {
      this.activeAbortController.abort();
    }

    const controller = new AbortController();
    this.activeAbortController = controller;

    this.showPill(editable, 'Margin · Translating…', false);

    const providerId = resolveProviderIdForScene(
      'input',
      this.config.routing,
      this.config.providers,
    );
    const provider = this.config.providers[providerId];
    const preferStream = provider ? provider.stream !== 'off' : false;
    const toLang = resolveInputTargetLanguage(sourceText, this.config);

    inputReqCounter += 1;
    const payload: TranslateBatchRequest = {
      requestId: `margin-input-${Date.now()}-${inputReqCounter}`,
      scene: 'input',
      providerId,
      fromLang: 'auto',
      toLang,
      items: [{ id: 1, text: sourceText, hasRichTags: false }],
    };

    try {
      const response = await this.transport(
        payload,
        {},
        controller.signal,
        preferStream,
      );

      if (controller.signal.aborted) {
        return false;
      }

      if (!response.ok || !response.items[0]?.trans?.trim()) {
        this.showTransientError(
          editable,
          response.error?.message || 'Translation failed',
        );
        return false;
      }

      const translated = response.items[0].trans.trim();
      const { usedExecCommand } = replaceEditableText(
        editable,
        translated,
        this.doc,
      );

      this.undoSnapshots.set(editable, {
        originalText: sourceText,
        translatedText: translated,
        usedExecCommand,
      });

      this.hidePill();
      return true;
    } catch (err) {
      if (controller.signal.aborted) {
        return false;
      }
      const message = err instanceof Error ? err.message : 'Translation failed';
      this.showTransientError(editable, message);
      return false;
    } finally {
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }
  }

  private ensurePillMounted(): void {
    if (this.pillHost && this.pillHost.isConnected) return;

    const parent = this.doc.body || this.doc.documentElement;
    if (!parent) return;

    const host = this.doc.createElement('div');
    host.setAttribute('data-margin-host', 'input-pill');
    host.setAttribute('data-margin-floating', 'true');
    host.setAttribute('data-display-mode', this.config.uiColorMode);
    host.hidden = true;
    host.style.display = 'none';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = this.doc.createElement('style');
    style.textContent = INPUT_PILL_CSS;

    const pill = this.doc.createElement('div');
    pill.className = 'pill';
    pill.hidden = true;
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');

    const dot = this.doc.createElement('span');
    dot.className = 'dot';

    const label = this.doc.createElement('span');
    label.className = 'label';

    const cancelBtn = this.doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'cancel-btn';
    cancelBtn.textContent = 'Esc';
    cancelBtn.title = 'Cancel input translation (Esc)';
    // Prevent stealing focus from the user's active input!
    cancelBtn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    cancelBtn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    cancelBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!this.cancelInFlight()) {
        this.hidePill();
      }
    });

    pill.append(dot, label, cancelBtn);
    shadow.append(style, pill);
    parent.appendChild(host);

    this.pillHost = host;
    this.pillShadow = shadow;
    this.pillRootEl = pill;
    this.pillLabelEl = label;
    this.pillCancelBtn = cancelBtn;

    syncFullscreenFloatingVisibility(this.doc);
  }

  private positionPillNearTarget(target: HTMLElement): void {
    if (!this.pillRootEl) return;
    const rect = target.getBoundingClientRect();
    const vw =
      this.doc.defaultView?.innerWidth ||
      this.doc.documentElement?.clientWidth ||
      1024;
    const vh =
      this.doc.defaultView?.innerHeight ||
      this.doc.documentElement?.clientHeight ||
      768;

    const top = Math.min(vh - 38, Math.max(8, rect.bottom + 6));
    const left = Math.min(vw - 200, Math.max(8, rect.right - 188));

    this.pillRootEl.style.top = `${Math.round(top)}px`;
    this.pillRootEl.style.left = `${Math.round(left)}px`;
  }

  private showPill(
    target: HTMLElement,
    text: string,
    isError: boolean,
  ): void {
    if (this.errorDismissTimer !== null) {
      clearTimeout(this.errorDismissTimer);
      this.errorDismissTimer = null;
    }
    this.ensurePillMounted();
    if (!this.pillHost || !this.pillRootEl || !this.pillLabelEl || !this.pillCancelBtn) {
      return;
    }
    this.pillHost.hidden = false;
    this.pillHost.style.display = 'block';
    this.pillRootEl.hidden = false;
    if (isError) {
      this.pillRootEl.setAttribute('data-error', 'true');
      this.pillCancelBtn.style.display = 'none';
    } else {
      this.pillRootEl.removeAttribute('data-error');
      this.pillCancelBtn.style.display = 'inline-flex';
    }
    this.pillLabelEl.textContent = text;
    this.positionPillNearTarget(target);
    syncFullscreenFloatingVisibility(this.doc);
  }

  private showTransientError(target: HTMLElement, message: string): void {
    const concise =
      message.length > 44 ? `${message.slice(0, 41)}…` : message;
    this.showPill(target, `Margin · ${concise}`, true);
    this.errorDismissTimer = setTimeout(() => {
      this.errorDismissTimer = null;
      this.hidePill();
    }, 2200);
  }

  hidePill(): void {
    if (this.errorDismissTimer !== null) {
      clearTimeout(this.errorDismissTimer);
      this.errorDismissTimer = null;
    }
    if (this.pillRootEl) {
      this.pillRootEl.hidden = true;
    }
    if (this.pillHost) {
      this.pillHost.hidden = true;
      this.pillHost.style.display = 'none';
    }
  }

  getPillShadowRoot(): ShadowRoot | null {
    return this.pillShadow;
  }

  destroy(): void {
    this.cancelInFlight();
    this.cleanupListeners?.();
    this.cleanupListeners = null;
    this.pillHost?.remove();
    this.pillHost = null;
    this.pillShadow = null;
    this.pillRootEl = null;
    this.pillLabelEl = null;
    this.pillCancelBtn = null;
  }
}
