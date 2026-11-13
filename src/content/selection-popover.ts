import { resolveProviderIdForScene } from '@shared/constants';
import {
  isExtensionContextValid,
  requestBatchTranslation,
  streamBatchTranslation,
  type StreamBatchCallbacks,
} from '@shared/messaging';
import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import { updateMarginConfig } from '@shared/storage';
import type {
  MarginConfig,
  TranslateBatchRequest,
  TranslateBatchResponse,
} from '@shared/types';
import { extractPageContext, isContentEditableNode } from './dom-walker';
import {
  stripPartialInlineMarkers,
  syncFullscreenFloatingVisibility,
} from './renderer';

const MAX_SELECTION_CHARS = 4500;
export const MAX_GLOSSARY_TERM_CHARS = 80;

export const SELECTION_POPOVER_CSS = /* css */ `
${SHADOW_HOST_RESET_CSS}

.layer {
  position: fixed;
  inset: 0px;
  pointer-events: none;
  z-index: 2147483646;
}

.trigger-icon {
  all: unset;
  box-sizing: border-box;
  position: fixed;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #fbfaf6;
  color: #8c5a21;
  border: 1px solid rgba(28, 25, 20, 0.12);
  border-radius: 7px;
  box-shadow:
    0 4px 14px rgba(28, 25, 20, 0.12),
    0 1px 2px rgba(28, 25, 20, 0.05);
  font-size: 13px;
  font-weight: 700;
  line-height: 16px;
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
}

:host([data-display-mode="night"]) .trigger-icon {
  background: #171512;
  color: #c99455;
  border-color: rgba(244, 239, 228, 0.14);
  box-shadow:
    0 6px 18px rgba(0, 0, 0, 0.44),
    0 1px 2px rgba(0, 0, 0, 0.24);
}

.trigger-icon:hover {
  background: #f4f1ea;
  border-color: rgba(140, 90, 33, 0.34);
}

:host([data-display-mode="night"]) .trigger-icon:hover {
  background: #201d19;
  border-color: rgba(201, 148, 85, 0.38);
}

.trigger-dot {
  all: unset;
  box-sizing: border-box;
  position: fixed;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
}

.trigger-dot-core {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #8c5a21;
  border: 1.5px solid #fbfaf6;
  box-shadow: 0 2px 8px rgba(28, 25, 20, 0.22);
}

:host([data-display-mode="night"]) .trigger-dot-core {
  background: #c99455;
  border-color: #171512;
}

.card {
  position: fixed;
  width: 364px;
  max-width: calc(100vw - 24px);
  background: #fbfaf6;
  color: #1c1914;
  border: 1px solid rgba(28, 25, 20, 0.08);
  border-radius: 10px;
  box-shadow:
    0 12px 32px rgba(28, 25, 20, 0.13),
    0 2px 6px rgba(28, 25, 20, 0.05);
  font-variant-numeric: tabular-nums;
  pointer-events: auto;
  overflow: hidden;
}

:host([data-display-mode="night"]) .card {
  background: #171512;
  color: #ede8df;
  border-color: rgba(244, 239, 228, 0.10);
  box-shadow:
    0 14px 36px rgba(0, 0, 0, 0.48),
    0 2px 6px rgba(0, 0, 0, 0.28);
}

.card[data-pinned="true"] {
  border-color: rgba(140, 90, 33, 0.36);
}

:host([data-display-mode="night"]) .card[data-pinned="true"] {
  border-color: rgba(201, 148, 85, 0.40);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  padding: 0px 11px;
  background: rgba(28, 25, 20, 0.025);
  border-bottom: 1px solid rgba(28, 25, 20, 0.08);
  cursor: grab;
  user-select: none;
}

:host([data-display-mode="night"]) .card-header {
  background: rgba(244, 239, 228, 0.03);
  border-bottom-color: rgba(244, 239, 228, 0.08);
}

.card[data-dragging="true"] .card-header {
  cursor: grabbing;
}

.brand-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.brand-mark {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #8c5a21;
  flex-shrink: 0;
}

:host([data-display-mode="night"]) .brand-mark {
  background: #c99455;
}

.brand-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1px;
  line-height: 16px;
  color: inherit;
}

.lang-pill {
  padding: 1px 6px;
  font-size: 11px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  background: rgba(28, 25, 20, 0.035);
  border: 1px solid rgba(28, 25, 20, 0.08);
  border-radius: 5px;
}

:host([data-display-mode="night"]) .lang-pill {
  background: rgba(244, 239, 228, 0.045);
  border-color: rgba(244, 239, 228, 0.09);
}

.actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.icon-btn {
  all: unset;
  box-sizing: border-box;
  height: 24px;
  padding: 0px 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
  color: var(--muted);
  border: 1px solid transparent;
  border-radius: 5px;
  cursor: pointer;
  user-select: none;
  transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
}

.icon-btn:hover {
  color: var(--ink);
  background: rgba(28, 25, 20, 0.05);
  border-color: rgba(28, 25, 20, 0.08);
}

:host([data-display-mode="night"]) .icon-btn:hover {
  background: rgba(244, 239, 228, 0.07);
  border-color: rgba(244, 239, 228, 0.10);
}

.icon-btn[aria-pressed="true"] {
  color: #8c5a21;
  background: rgba(140, 90, 33, 0.10);
  border-color: rgba(140, 90, 33, 0.26);
  font-weight: 600;
}

:host([data-display-mode="night"]) .icon-btn[aria-pressed="true"] {
  color: #c99455;
  background: rgba(201, 148, 85, 0.14);
  border-color: rgba(201, 148, 85, 0.30);
}

.icon-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.card-body,
.mp-sel-body {
  max-height: 248px;
  overflow-y: auto;
  padding: 12px 14px;
  font-size: 14px;
  line-height: 22px;
  font-variant-numeric: tabular-nums;
  color: inherit;
  white-space: pre-wrap;
  word-break: break-word;
}

.card-body[data-status="loading"] {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 14px;
}

.sel-shimmer-line {
  display: block;
  height: 13px;
  border-radius: 5px;
  background-color: color-mix(in srgb, currentColor 8%, transparent);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(185, 131, 61, 0.16) 50%,
    transparent 100%
  );
  background-size: 220% 100%;
  background-position: 120% 0px;
  animation: sel-shimmer-sweep 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

@keyframes sel-shimmer-sweep {
  0% {
    background-position: 120% 0px;
  }
  100% {
    background-position: -120% 0px;
  }
}

.card-body[data-status="error"] {
  color: #b4412e;
  font-size: 13px;
}

:host([data-display-mode="night"]) .card-body[data-status="error"] {
  color: #e27a68;
}

.icon-btn[data-saved="true"],
.icon-btn[data-copied="true"] {
  color: #8c5a21;
  font-weight: 600;
}

:host([data-display-mode="night"]) .icon-btn[data-saved="true"],
:host([data-display-mode="night"]) .icon-btn[data-copied="true"] {
  color: #c99455;
}

.glossary-editor {
  padding: 10px 12px 12px;
  background: rgba(28, 25, 20, 0.025);
  border-top: 1px solid rgba(28, 25, 20, 0.08);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

:host([data-display-mode="night"]) .glossary-editor {
  background: rgba(244, 239, 228, 0.03);
  border-top-color: rgba(244, 239, 228, 0.08);
}

.glossary-editor[hidden] {
  display: none !important;
}

.glossary-top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.glossary-source-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0px;
  overflow: hidden;
}

.glossary-source-tag {
  font-size: 11px;
  line-height: 14px;
  color: var(--muted);
  flex-shrink: 0;
}

.glossary-source-term {
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  color: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.glossary-pill-btn {
  all: unset;
  box-sizing: border-box;
  height: 22px;
  padding: 0px 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 14px;
  color: var(--muted);
  background: #fbfaf6;
  border: 1px solid rgba(28, 25, 20, 0.09);
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}

:host([data-display-mode="night"]) .glossary-pill-btn {
  background: #1e1b17;
  border-color: rgba(244, 239, 228, 0.11);
}

.glossary-pill-btn:hover {
  color: var(--ink);
  border-color: rgba(140, 90, 33, 0.30);
}

.glossary-pill-btn[aria-pressed="true"] {
  color: #8c5a21;
  background: rgba(140, 90, 33, 0.10);
  border-color: rgba(140, 90, 33, 0.32);
  font-weight: 600;
}

:host([data-display-mode="night"]) .glossary-pill-btn[aria-pressed="true"] {
  color: #c99455;
  background: rgba(201, 148, 85, 0.15);
  border-color: rgba(201, 148, 85, 0.35);
}

.glossary-controls-row {
  display: flex;
  align-items: center;
  gap: 7px;
}

.glossary-target-input {
  all: unset;
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0px;
  height: 28px;
  padding: 0px 9px;
  font-size: 12px;
  line-height: 18px;
  color: inherit;
  background: #ffffff;
  border: 1px solid rgba(28, 25, 20, 0.12);
  border-radius: 6px;
}

:host([data-display-mode="night"]) .glossary-target-input {
  background: #12100e;
  border-color: rgba(244, 239, 228, 0.12);
}

.glossary-target-input::placeholder {
  color: var(--muted-soft);
}

.glossary-target-input:focus {
  border-color: #8c5a21;
  outline: 1px solid rgba(140, 90, 33, 0.25);
}

:host([data-display-mode="night"]) .glossary-target-input:focus {
  border-color: #c99455;
  outline-color: rgba(201, 148, 85, 0.28);
}

.glossary-save-btn {
  all: unset;
  box-sizing: border-box;
  height: 28px;
  padding: 0px 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  color: #fffdf9;
  background: #8c5a21;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  transition: background-color 140ms ease;
}

:host([data-display-mode="night"]) .glossary-save-btn {
  color: #171512;
  background: #c99455;
}

.glossary-save-btn:hover {
  background: #734818;
}

:host([data-display-mode="night"]) .glossary-save-btn:hover {
  background: #d6a468;
}

.glossary-status {
  font-size: 11px;
  line-height: 15px;
  color: #8c5a21;
  font-weight: 500;
}

:host([data-display-mode="night"]) .glossary-status {
  color: #c99455;
}

.glossary-status[hidden] {
  display: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .trigger-icon,
  .icon-btn,
  .glossary-save-btn {
    transition: none !important;
  }
  .sel-shimmer-line {
    animation: none !important;
    background-image: none !important;
  }
}
`;

export type SelectionTransportFn = (
  payload: TranslateBatchRequest,
  callbacks: StreamBatchCallbacks,
  signal: AbortSignal,
  preferStream: boolean,
) => Promise<TranslateBatchResponse>;

function defaultSelectionTransport(
  payload: TranslateBatchRequest,
  callbacks: StreamBatchCallbacks,
  signal: AbortSignal,
  _preferStream: boolean,
): Promise<TranslateBatchResponse> {
  if (
    typeof globalThis.chrome !== 'undefined' &&
    typeof globalThis.chrome?.runtime?.connect === 'function'
  ) {
    return streamBatchTranslation(payload, callbacks, signal);
  }
  return requestBatchTranslation(payload);
}

function isNodeInsideAnchor(node: Node | null): boolean {
  if (!node) return false;
  const el =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(el?.closest?.('a[href]'));
}

function isNodeInsideEditable(node: Node | null): boolean {
  if (!node) return false;
  const el =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  let curr: Element | null = el;
  while (curr) {
    if (isContentEditableNode(curr)) return true;
    curr = curr.parentElement;
  }
  return false;
}

export interface SelectionPopoverOptions {
  config: MarginConfig;
  doc?: Document;
  getUrl?: () => string;
  now?: () => number;
  transport?: SelectionTransportFn;
  clipboardWrite?: (text: string) => Promise<void>;
  isUrlExcluded?: () => boolean;
}

let selectionReqSeq = 0;

export class SelectionPopover {
  private config: MarginConfig;
  private readonly doc: Document;
  private readonly getUrl?: () => string;
  private readonly now: () => number;
  private readonly transport: SelectionTransportFn;
  private readonly clipboardWrite: (text: string) => Promise<void>;
  private readonly isUrlExcluded?: () => boolean;

  private hostEl: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private triggerIconBtn: HTMLButtonElement | null = null;
  private triggerDotBtn: HTMLButtonElement | null = null;
  private cardEl: HTMLElement | null = null;
  private langPillEl: HTMLElement | null = null;
  private glossaryBtn: HTMLButtonElement | null = null;
  private pinBtn: HTMLButtonElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private glossaryEditorEl: HTMLElement | null = null;
  private glossarySourceEl: HTMLElement | null = null;
  private glossaryKeepOrigBtn: HTMLButtonElement | null = null;
  private glossaryTargetInput: HTMLInputElement | null = null;
  private glossaryStatusEl: HTMLElement | null = null;

  private uiState: 'closed' | 'trigger' | 'card' = 'closed';
  private pinned = false;
  private dragging = false;
  private glossaryEditorOpen = false;
  private glossaryTargetTouched = false;
  private cardLeft = 24;
  private cardTop = 24;

  private selectedSourceText = '';
  private translatedText = '';
  private activeAbortController: AbortController | null = null;
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private glossaryFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  private pointerDownInsideAnchor = false;
  private suppressAnchorClickUntil = 0;
  private hadRuntimeIdAtMount = false;

  private cleanupListeners: (() => void) | null = null;
  private cleanupActiveDrag: (() => void) | null = null;

  constructor(options: SelectionPopoverOptions) {
    this.config = options.config;
    this.doc = options.doc ?? document;
    this.getUrl = options.getUrl;
    this.now = options.now ?? (() => Date.now());
    this.transport = options.transport ?? defaultSelectionTransport;
    this.clipboardWrite =
      options.clipboardWrite ??
      (async (text: string) => {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        }
      });
    this.isUrlExcluded = options.isUrlExcluded;
  }

  get state(): 'closed' | 'trigger' | 'card' {
    return this.uiState;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  get currentTranslation(): string {
    return this.translatedText;
  }

  getShadowRoot(): ShadowRoot | null {
    return this.shadow;
  }

  mount(): void {
    if (this.cleanupListeners) return;
    this.hadRuntimeIdAtMount = Boolean(globalThis.chrome?.runtime?.id);
    const win = this.doc.defaultView ?? window;

    const onPointerDown = (ev: PointerEvent | MouseEvent) => {
      if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
        this.destroy();
        return;
      }
      if (this.isEventFromSelf(ev)) return;

      this.pointerDownInsideAnchor = isNodeInsideAnchor(ev.target as Node | null);

      // Dismiss unpinned trigger or card when clicking outside on the page
      if (this.uiState !== 'closed' && !this.pinned) {
        this.close();
      }
    };

    const onPointerUp = (ev: PointerEvent | MouseEvent) => {
      if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
        this.destroy();
        return;
      }
      if (this.isEventFromSelf(ev)) return;
      this.evaluateBrowserSelection(ev);
    };

    const onClickCapture = (ev: MouseEvent) => {
      if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
        this.destroy();
        return;
      }
      if (this.isEventFromSelf(ev)) return;
      // Suppress synthetic navigation click when user dragged to select text inside an <a href>
      if (
        this.suppressAnchorClickUntil > 0 &&
        this.now() <= this.suppressAnchorClickUntil &&
        isNodeInsideAnchor(ev.target as Node | null)
      ) {
        this.suppressAnchorClickUntil = 0;
        ev.preventDefault();
        ev.stopPropagation();
      }
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
        this.destroy();
        return;
      }
      if (ev.key === 'Escape' && this.uiState !== 'closed' && !this.pinned) {
        this.close();
      }
    };

    // NOTE: Intentionally NO `window.blur` listener closing the popover!
    win.addEventListener('pointerdown', onPointerDown, true);
    win.addEventListener('pointerup', onPointerUp, false);
    win.addEventListener('click', onClickCapture, true);
    win.addEventListener('keydown', onKeyDown, true);

    this.cleanupListeners = () => {
      win.removeEventListener('pointerdown', onPointerDown, true);
      win.removeEventListener('pointerup', onPointerUp, false);
      win.removeEventListener('click', onClickCapture, true);
      win.removeEventListener('keydown', onKeyDown, true);
    };
  }

  private isEventFromSelf(ev: Event): boolean {
    if (!this.hostEl) return false;
    if (ev.target === this.hostEl) return true;
    if (ev.target instanceof Node && this.shadow?.contains(ev.target)) {
      return true;
    }
    if (typeof ev.composedPath === 'function') {
      return ev.composedPath().includes(this.hostEl);
    }
    return false;
  }

  private isFeatureEnabled(): boolean {
    return (
      this.config.selection.enabled &&
      this.config.selection.triggerMode !== 'off' &&
      !this.isUrlExcluded?.()
    );
  }

  private evaluateBrowserSelection(ev: PointerEvent | MouseEvent): void {
    if (!this.isFeatureEnabled()) return;

    const win = this.doc.defaultView ?? window;
    const sel = win.getSelection?.() ?? this.doc.getSelection?.();
    if (!sel || sel.isCollapsed) {
      this.pointerDownInsideAnchor = false;
      return;
    }

    const rawText = sel.toString().trim();
    if (!rawText || rawText.length > MAX_SELECTION_CHARS) {
      this.pointerDownInsideAnchor = false;
      return;
    }

    if (
      isNodeInsideEditable(sel.anchorNode) ||
      isNodeInsideEditable(sel.focusNode)
    ) {
      this.pointerDownInsideAnchor = false;
      return;
    }

    const selectionTouchesAnchor =
      this.pointerDownInsideAnchor ||
      isNodeInsideAnchor(sel.anchorNode) ||
      isNodeInsideAnchor(sel.focusNode) ||
      isNodeInsideAnchor(ev.target as Node | null);
    this.pointerDownInsideAnchor = false;

    if (selectionTouchesAnchor) {
      this.suppressAnchorClickUntil = this.now() + 400;
    }

    let anchorX = ev.clientX || 60;
    let anchorY = ev.clientY || 60;
    if (sel.rangeCount > 0) {
      try {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          anchorX = rect.right;
          anchorY = rect.bottom;
        }
      } catch {
        // Fallback to pointer coordinates
      }
    }

    this.presentForSelection(rawText, { x: anchorX, y: anchorY });
  }

  /**
   * Programmatically or interactively presents the selection trigger or instant card.
   */
  presentForSelection(
    text: string,
    coords: { x: number; y: number },
  ): void {
    if (!this.isFeatureEnabled()) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    this.selectedSourceText = trimmed;
    this.ensureDomMounted();

    // If card is already pinned open, update translation directly in place!
    if (this.pinned && this.uiState === 'card') {
      void this.openCardAndTranslate(coords, true);
      return;
    }

    const mode = this.config.selection.triggerMode;
    if (mode === 'instant') {
      void this.openCardAndTranslate(coords, false);
      return;
    }

    this.showTrigger(mode === 'dot' ? 'dot' : 'icon', coords);
  }

  private ensureDomMounted(): void {
    if (this.hostEl && this.hostEl.isConnected) return;

    const parent = this.doc.body || this.doc.documentElement;
    if (!parent) return;

    const host = this.doc.createElement('div');
    host.setAttribute('data-margin-host', 'selection-popover');
    host.setAttribute('data-margin-floating', 'true');
    host.setAttribute('data-display-mode', this.config.uiColorMode);
    host.hidden = true;
    host.style.display = 'none';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = this.doc.createElement('style');
    style.textContent = SELECTION_POPOVER_CSS;

    const layer = this.doc.createElement('div');
    layer.className = 'layer';

    // 1. Icon trigger
    const triggerIcon = this.doc.createElement('button');
    triggerIcon.type = 'button';
    triggerIcon.className = 'trigger-icon';
    triggerIcon.setAttribute('data-part', 'trigger-icon');
    triggerIcon.setAttribute('aria-label', 'Translate selection with Margin');
    triggerIcon.textContent = 'M';
    triggerIcon.style.display = 'none';

    // 2. Dot trigger
    const triggerDot = this.doc.createElement('button');
    triggerDot.type = 'button';
    triggerDot.className = 'trigger-dot';
    triggerDot.setAttribute('data-part', 'trigger-dot');
    triggerDot.setAttribute('aria-label', 'Translate selection with Margin');
    triggerDot.style.display = 'none';
    const dotCore = this.doc.createElement('span');
    dotCore.className = 'trigger-dot-core';
    triggerDot.appendChild(dotCore);

    const onTriggerActivate = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const btn = ev.currentTarget as HTMLElement;
      const rect = btn.getBoundingClientRect();
      void this.openCardAndTranslate(
        {
          x: rect.left || parseFloat(btn.style.left) || 40,
          y: rect.top || parseFloat(btn.style.top) || 40,
        },
        false,
      );
    };

    for (const btn of [triggerIcon, triggerDot]) {
      btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      btn.addEventListener('click', onTriggerActivate);
    }

    // 3. Quiet Paper Translation Card
    const card = this.doc.createElement('div');
    card.className = 'card';
    card.setAttribute('data-part', 'card');
    card.setAttribute('data-pinned', 'false');
    card.setAttribute('data-dragging', 'false');
    card.style.display = 'none';
    card.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    card.addEventListener('click', (ev) => ev.stopPropagation());

    const header = this.doc.createElement('div');
    header.className = 'card-header';
    header.setAttribute('data-part', 'card-header');

    const brandGroup = this.doc.createElement('div');
    brandGroup.className = 'brand-group';
    const brandMark = this.doc.createElement('span');
    brandMark.className = 'brand-mark';
    brandMark.setAttribute('aria-hidden', 'true');
    const brandTitle = this.doc.createElement('span');
    brandTitle.className = 'brand-title';
    brandTitle.textContent = 'Margin';
    const langPill = this.doc.createElement('span');
    langPill.className = 'lang-pill';
    langPill.textContent = `→ ${this.config.targetLang}`;
    brandGroup.append(brandMark, brandTitle, langPill);

    const actions = this.doc.createElement('div');
    actions.className = 'actions';

    const glossaryBtn = this.doc.createElement('button');
    glossaryBtn.type = 'button';
    glossaryBtn.className = 'icon-btn';
    glossaryBtn.setAttribute('data-action', 'collect-glossary');
    glossaryBtn.setAttribute('aria-pressed', 'false');
    glossaryBtn.setAttribute('aria-expanded', 'false');
    glossaryBtn.title = '存入自定义术语库';
    glossaryBtn.textContent = '+ 存术语';
    glossaryBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.toggleGlossaryEditor();
    });

    const pinBtn = this.doc.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'icon-btn';
    pinBtn.setAttribute('data-action', 'pin');
    pinBtn.setAttribute('aria-pressed', 'false');
    pinBtn.title = 'Pin card open';
    pinBtn.textContent = 'Pin';
    pinBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.togglePin();
    });

    const copyBtn = this.doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'icon-btn';
    copyBtn.setAttribute('data-action', 'copy');
    copyBtn.title = 'Copy translation';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.copyTranslation();
    });

    const closeBtn = this.doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'icon-btn';
    closeBtn.setAttribute('data-action', 'close');
    closeBtn.title = 'Close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.pinned = false;
      this.close();
    });

    actions.append(glossaryBtn, pinBtn, copyBtn, closeBtn);
    header.append(brandGroup, actions);

    // Header drag support — releases cleanly on window `pointerup` AND `pointercancel`
    header.addEventListener('pointerdown', (ev: PointerEvent) => {
      const target = ev.target as Element | null;
      if (target?.closest?.('button')) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.beginHeaderDrag(ev.clientX, ev.clientY);
    });

    const body = this.doc.createElement('div');
    body.className = 'card-body mp-sel-body';
    body.setAttribute('data-part', 'card-body');

    const glossaryEditor = this.doc.createElement('div');
    glossaryEditor.className = 'glossary-editor';
    glossaryEditor.setAttribute('data-part', 'glossary-editor');
    glossaryEditor.hidden = true;

    const glossaryTopRow = this.doc.createElement('div');
    glossaryTopRow.className = 'glossary-top-row';

    const glossarySourceWrap = this.doc.createElement('div');
    glossarySourceWrap.className = 'glossary-source-wrap';
    const glossarySourceTag = this.doc.createElement('span');
    glossarySourceTag.className = 'glossary-source-tag';
    glossarySourceTag.textContent = '术语';
    const glossarySourceTerm = this.doc.createElement('span');
    glossarySourceTerm.className = 'glossary-source-term';
    glossarySourceTerm.setAttribute('data-part', 'glossary-source');
    glossarySourceWrap.append(glossarySourceTag, glossarySourceTerm);

    const keepOrigBtn = this.doc.createElement('button');
    keepOrigBtn.type = 'button';
    keepOrigBtn.className = 'glossary-pill-btn';
    keepOrigBtn.setAttribute('data-action', 'glossary-keep-original');
    keepOrigBtn.setAttribute('aria-pressed', 'false');
    keepOrigBtn.textContent = '保留原文';
    keepOrigBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (this.glossaryTargetInput) {
        this.glossaryTargetInput.value = '';
        this.glossaryTargetTouched = true;
        this.syncKeepOriginalPillState();
      }
    });

    glossaryTopRow.append(glossarySourceWrap, keepOrigBtn);

    const glossaryControlsRow = this.doc.createElement('div');
    glossaryControlsRow.className = 'glossary-controls-row';

    const targetInput = this.doc.createElement('input');
    targetInput.type = 'text';
    targetInput.className = 'glossary-target-input';
    targetInput.setAttribute('data-part', 'glossary-target-input');
    targetInput.placeholder = '留空即保留原文不翻译';
    targetInput.addEventListener('input', () => {
      this.glossaryTargetTouched = true;
      this.syncKeepOriginalPillState();
    });
    targetInput.addEventListener('keydown', (ev: KeyboardEvent) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void this.saveGlossaryEntry();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.setGlossaryEditorOpen(false);
      }
    });

    const saveBtn = this.doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'glossary-save-btn';
    saveBtn.setAttribute('data-action', 'glossary-save');
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.saveGlossaryEntry();
    });

    glossaryControlsRow.append(targetInput, saveBtn);

    const glossaryStatus = this.doc.createElement('div');
    glossaryStatus.className = 'glossary-status';
    glossaryStatus.setAttribute('data-part', 'glossary-status');
    glossaryStatus.hidden = true;

    glossaryEditor.append(glossaryTopRow, glossaryControlsRow, glossaryStatus);

    card.append(header, body, glossaryEditor);
    layer.append(triggerIcon, triggerDot, card);
    shadow.append(style, layer);
    parent.appendChild(host);

    this.hostEl = host;
    this.shadow = shadow;
    this.triggerIconBtn = triggerIcon;
    this.triggerDotBtn = triggerDot;
    this.cardEl = card;
    this.langPillEl = langPill;
    this.glossaryBtn = glossaryBtn;
    this.pinBtn = pinBtn;
    this.copyBtn = copyBtn;
    this.bodyEl = body;
    this.glossaryEditorEl = glossaryEditor;
    this.glossarySourceEl = glossarySourceTerm;
    this.glossaryKeepOrigBtn = keepOrigBtn;
    this.glossaryTargetInput = targetInput;
    this.glossaryStatusEl = glossaryStatus;

    syncFullscreenFloatingVisibility(this.doc);
  }

  private beginHeaderDrag(startClientX: number, startClientY: number): void {
    this.cleanupActiveDrag?.();
    const win = this.doc.defaultView ?? window;

    this.dragging = true;
    this.cardEl?.setAttribute('data-dragging', 'true');

    const initialLeft = this.cardLeft;
    const initialTop = this.cardTop;

    const onMove = (ev: PointerEvent) => {
      if (!this.dragging) return;
      const dx = ev.clientX - startClientX;
      const dy = ev.clientY - startClientY;
      this.setCardPosition(initialLeft + dx, initialTop + dy);
    };

    const endDrag = () => {
      this.dragging = false;
      this.cardEl?.setAttribute('data-dragging', 'false');
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerup', endDrag);
      win.removeEventListener('pointercancel', endDrag);
      this.cleanupActiveDrag = null;
    };

    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', endDrag);
    win.addEventListener('pointercancel', endDrag);

    this.cleanupActiveDrag = endDrag;
  }

  private setCardPosition(left: number, top: number): void {
    const vw =
      this.doc.defaultView?.innerWidth ||
      this.doc.documentElement?.clientWidth ||
      1024;
    const vh =
      this.doc.defaultView?.innerHeight ||
      this.doc.documentElement?.clientHeight ||
      768;

    this.cardLeft = Math.max(8, Math.min(vw - 364, Math.round(left)));
    this.cardTop = Math.max(8, Math.min(vh - 96, Math.round(top)));

    if (this.cardEl) {
      this.cardEl.style.left = `${this.cardLeft}px`;
      this.cardEl.style.top = `${this.cardTop}px`;
    }
  }

  private showTrigger(
    kind: 'icon' | 'dot',
    coords: { x: number; y: number },
  ): void {
    if (!this.hostEl || !this.triggerIconBtn || !this.triggerDotBtn || !this.cardEl) {
      return;
    }

    this.activeAbortController?.abort();
    this.activeAbortController = null;

    this.uiState = 'trigger';
    this.hostEl.hidden = false;
    this.hostEl.style.display = 'block';
    this.cardEl.style.display = 'none';

    const vw =
      this.doc.defaultView?.innerWidth ||
      this.doc.documentElement?.clientWidth ||
      1024;
    const vh =
      this.doc.defaultView?.innerHeight ||
      this.doc.documentElement?.clientHeight ||
      768;

    const left = Math.max(8, Math.min(vw - 36, Math.round(coords.x + 6)));
    const top = Math.max(8, Math.min(vh - 36, Math.round(coords.y + 6)));

    if (kind === 'icon') {
      this.triggerIconBtn.style.left = `${left}px`;
      this.triggerIconBtn.style.top = `${top}px`;
      this.triggerIconBtn.style.display = 'inline-flex';
      this.triggerDotBtn.style.display = 'none';
    } else {
      this.triggerDotBtn.style.left = `${left}px`;
      this.triggerDotBtn.style.top = `${top}px`;
      this.triggerDotBtn.style.display = 'inline-flex';
      this.triggerIconBtn.style.display = 'none';
    }

    syncFullscreenFloatingVisibility(this.doc);
  }

  async openCardAndTranslate(
    coords: { x: number; y: number },
    keepExistingPosition = false,
  ): Promise<void> {
    this.ensureDomMounted();
    if (!this.hostEl || !this.cardEl || !this.bodyEl || !this.langPillEl) return;

    this.activeAbortController?.abort();
    const controller = new AbortController();
    this.activeAbortController = controller;

    this.uiState = 'card';
    this.hostEl.hidden = false;
    this.hostEl.style.display = 'block';
    if (this.triggerIconBtn) this.triggerIconBtn.style.display = 'none';
    if (this.triggerDotBtn) this.triggerDotBtn.style.display = 'none';

    this.langPillEl.textContent = `→ ${this.config.targetLang}`;
    this.cardEl.style.display = 'block';

    if (!keepExistingPosition) {
      this.setCardPosition(coords.x, coords.y + 8);
    }

    this.translatedText = '';
    this.resetGlossaryQuickCollectForSelection();
    this.bodyEl.setAttribute('data-status', 'loading');
    this.bodyEl.setAttribute('aria-busy', 'true');
    const shimmerLine1 = this.doc.createElement('span');
    shimmerLine1.className = 'sel-shimmer-line';
    const isLongSelection = this.selectedSourceText.trim().length >= 80;
    shimmerLine1.style.width = isLongSelection ? '88%' : '62%';
    if (isLongSelection) {
      const shimmerLine2 = this.doc.createElement('span');
      shimmerLine2.className = 'sel-shimmer-line';
      shimmerLine2.style.width = '56%';
      this.bodyEl.replaceChildren(shimmerLine1, shimmerLine2);
    } else {
      this.bodyEl.replaceChildren(shimmerLine1);
    }
    syncFullscreenFloatingVisibility(this.doc);

    const providerId = resolveProviderIdForScene(
      'selection',
      this.config.routing,
      this.config.providers,
    );
    const provider = this.config.providers[providerId];
    const preferStream = provider ? provider.stream !== 'off' : false;

    selectionReqSeq += 1;
    const payload: TranslateBatchRequest = {
      requestId: `margin-selection-${Date.now()}-${selectionReqSeq}`,
      scene: 'selection',
      providerId,
      fromLang: this.config.sourceLang,
      toLang: this.config.targetLang,
      priority: -1,
      items: [{ id: 1, text: this.selectedSourceText, hasRichTags: false }],
      context: extractPageContext(this.doc, this.getUrl?.()),
    };

    const perfNow = () =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const win = this.doc.defaultView;
    const raf =
      typeof win?.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame.bind(win)
        : typeof globalThis.requestAnimationFrame === 'function'
          ? globalThis.requestAnimationFrame.bind(globalThis)
          : null;
    const caf =
      typeof win?.cancelAnimationFrame === 'function'
        ? win.cancelAnimationFrame.bind(win)
        : typeof globalThis.cancelAnimationFrame === 'function'
          ? globalThis.cancelAnimationFrame.bind(globalThis)
          : null;

    let partialTextNode: Text | null = null;
    let pendingPartialText: string | null = null;
    let partialFrameId: number | ReturnType<typeof setTimeout> | null = null;
    let partialUsingTimeout = false;
    let lastPartialPaintAt = 0;

    const cancelPendingPartial = () => {
      if (partialFrameId !== null) {
        if (partialUsingTimeout) {
          clearTimeout(partialFrameId as ReturnType<typeof setTimeout>);
        } else if (caf) {
          caf(partialFrameId as number);
        }
        partialFrameId = null;
      }
      pendingPartialText = null;
    };

    controller.signal.addEventListener('abort', cancelPendingPartial, {
      once: true,
    });

    const syncGlossaryDraftIfUntouched = (text: string) => {
      if (
        this.glossaryEditorOpen &&
        !this.glossaryTargetTouched &&
        this.glossaryTargetInput
      ) {
        this.glossaryTargetInput.value = text;
        this.syncKeepOriginalPillState();
      }
    };

    const paintPartialPreview = (text: string) => {
      if (controller.signal.aborted || !this.bodyEl) return;
      this.translatedText = text;
      this.bodyEl.setAttribute('data-status', 'streaming');
      this.bodyEl.setAttribute('aria-busy', 'true');
      if (!partialTextNode || partialTextNode.parentNode !== this.bodyEl) {
        partialTextNode = this.doc.createTextNode(text);
        this.bodyEl.replaceChildren(partialTextNode);
      } else {
        partialTextNode.textContent = text;
      }
      lastPartialPaintAt = perfNow();
      syncGlossaryDraftIfUntouched(text);
    };

    const commitFinalBody = (rawText: string) => {
      cancelPendingPartial();
      if (controller.signal.aborted || !this.bodyEl) return;
      const finalText = stripPartialInlineMarkers(rawText).trim();
      if (!finalText) return;
      this.translatedText = finalText;
      this.bodyEl.setAttribute('data-status', 'ready');
      this.bodyEl.removeAttribute('aria-busy');
      if (partialTextNode && partialTextNode.parentNode === this.bodyEl) {
        partialTextNode.textContent = finalText;
      } else {
        this.bodyEl.textContent = finalText;
      }
      syncGlossaryDraftIfUntouched(finalText);
    };

    try {
      const response = await this.transport(
        payload,
        {
          onItemReady: (item) => {
            if (controller.signal.aborted || !this.bodyEl || item.id !== 1) {
              return;
            }
            if (item.partial) {
              const cleaned = stripPartialInlineMarkers(item.trans).trim();
              if (!cleaned) return;
              const elapsed = perfNow() - lastPartialPaintAt;
              if (lastPartialPaintAt === 0 || elapsed >= 16) {
                cancelPendingPartial();
                paintPartialPreview(cleaned);
              } else {
                pendingPartialText = cleaned;
                if (partialFrameId === null) {
                  if (raf) {
                    partialUsingTimeout = false;
                    partialFrameId = raf(() => {
                      partialFrameId = null;
                      const next = pendingPartialText;
                      pendingPartialText = null;
                      if (next) paintPartialPreview(next);
                    });
                  } else {
                    partialUsingTimeout = true;
                    partialFrameId = setTimeout(() => {
                      partialFrameId = null;
                      const next = pendingPartialText;
                      pendingPartialText = null;
                      if (next) paintPartialPreview(next);
                    }, Math.max(1, 16 - Math.floor(elapsed)));
                  }
                }
              }
              return;
            }
            commitFinalBody(item.trans);
          },
        },
        controller.signal,
        preferStream,
      );

      cancelPendingPartial();
      if (controller.signal.aborted || !this.bodyEl) return;

      if (!response.ok || !response.items[0]?.trans?.trim()) {
        this.bodyEl.setAttribute('data-status', 'error');
        this.bodyEl.removeAttribute('aria-busy');
        this.bodyEl.textContent =
          response.error?.message || 'Translation failed.';
        return;
      }

      commitFinalBody(response.items[0].trans);
    } catch (err) {
      cancelPendingPartial();
      if (controller.signal.aborted || !this.bodyEl) return;
      this.bodyEl.setAttribute('data-status', 'error');
      this.bodyEl.removeAttribute('aria-busy');
      this.bodyEl.textContent =
        err instanceof Error ? err.message : 'Translation failed.';
    } finally {
      cancelPendingPartial();
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }
  }

  togglePin(): boolean {
    this.pinned = !this.pinned;
    if (this.cardEl) {
      this.cardEl.setAttribute('data-pinned', this.pinned ? 'true' : 'false');
    }
    if (this.pinBtn) {
      this.pinBtn.setAttribute('aria-pressed', this.pinned ? 'true' : 'false');
      this.pinBtn.textContent = this.pinned ? 'Pinned' : 'Pin';
    }
    return this.pinned;
  }

  async copyTranslation(): Promise<boolean> {
    if (!this.translatedText) return false;
    try {
      await this.clipboardWrite(this.translatedText);
      if (this.copyBtn) {
        this.copyBtn.textContent = 'Copied';
        this.copyBtn.setAttribute('data-copied', 'true');
        if (this.copyFeedbackTimer !== null) {
          clearTimeout(this.copyFeedbackTimer);
        }
        this.copyFeedbackTimer = setTimeout(() => {
          this.copyFeedbackTimer = null;
          if (this.copyBtn) {
            this.copyBtn.textContent = 'Copy';
            this.copyBtn.removeAttribute('data-copied');
          }
        }, 1400);
      }
      return true;
    } catch {
      return false;
    }
  }

  private clearGlossaryFeedbackTimer(): void {
    if (this.glossaryFeedbackTimer !== null) {
      clearTimeout(this.glossaryFeedbackTimer);
      this.glossaryFeedbackTimer = null;
    }
  }

  private isEligibleForGlossaryCollect(): boolean {
    const len = this.selectedSourceText.trim().length;
    return len > 0 && len <= MAX_GLOSSARY_TERM_CHARS;
  }

  private resetGlossaryQuickCollectForSelection(): void {
    this.clearGlossaryFeedbackTimer();
    this.glossaryTargetTouched = false;
    this.setGlossaryEditorOpen(false);
    const eligible = this.isEligibleForGlossaryCollect();
    if (this.glossaryBtn) {
      this.glossaryBtn.textContent = '+ 存术语';
      this.glossaryBtn.removeAttribute('data-saved');
      this.glossaryBtn.hidden = !eligible;
      this.glossaryBtn.style.display = eligible ? 'inline-flex' : 'none';
    }
    if (this.glossaryStatusEl) {
      this.glossaryStatusEl.textContent = '';
      this.glossaryStatusEl.hidden = true;
    }
  }

  private syncKeepOriginalPillState(): void {
    if (!this.glossaryKeepOrigBtn || !this.glossaryTargetInput) return;
    const isKeepOriginal = this.glossaryTargetInput.value.trim() === '';
    this.glossaryKeepOrigBtn.setAttribute(
      'aria-pressed',
      isKeepOriginal ? 'true' : 'false',
    );
  }

  private setGlossaryEditorOpen(open: boolean): void {
    const canOpen = open && this.isEligibleForGlossaryCollect();
    this.glossaryEditorOpen = canOpen;
    if (this.glossaryEditorEl) {
      this.glossaryEditorEl.hidden = !canOpen;
    }
    if (this.glossaryBtn) {
      this.glossaryBtn.setAttribute('aria-pressed', canOpen ? 'true' : 'false');
      this.glossaryBtn.setAttribute(
        'aria-expanded',
        canOpen ? 'true' : 'false',
      );
    }
    if (canOpen) {
      if (this.glossarySourceEl) {
        this.glossarySourceEl.textContent = this.selectedSourceText.trim();
      }
      if (this.glossaryTargetInput) {
        this.glossaryTargetTouched = false;
        this.glossaryTargetInput.value = this.translatedText;
        this.syncKeepOriginalPillState();
      }
      if (this.glossaryStatusEl) {
        this.glossaryStatusEl.textContent = '';
        this.glossaryStatusEl.hidden = true;
      }
    }
  }

  toggleGlossaryEditor(): boolean {
    if (!this.isEligibleForGlossaryCollect()) {
      this.setGlossaryEditorOpen(false);
      return false;
    }
    this.setGlossaryEditorOpen(!this.glossaryEditorOpen);
    return this.glossaryEditorOpen;
  }

  async saveGlossaryEntry(): Promise<boolean> {
    if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
      this.destroy();
      return false;
    }
    const k = this.selectedSourceText.trim();
    if (!k || k.length > MAX_GLOSSARY_TERM_CHARS) {
      return false;
    }
    const v = (this.glossaryTargetInput?.value ?? '').trim();

    try {
      const updated = await updateMarginConfig((draft) => {
        if (!Array.isArray(draft.glossary)) {
          draft.glossary = [];
        }
        const lowerK = k.toLowerCase();
        const existingIdx = draft.glossary.findIndex(
          (entry) =>
            entry.k.trim().toLowerCase() === lowerK && !entry.domain?.trim(),
        );
        if (existingIdx >= 0) {
          draft.glossary[existingIdx] = {
            ...draft.glossary[existingIdx],
            k,
            v,
            enabled: true,
            group: draft.glossary[existingIdx].group || 'custom',
          };
        } else {
          draft.glossary.unshift({
            k,
            v,
            enabled: true,
            group: 'custom',
          });
        }
      });

      this.config = updated;

      if (this.glossaryStatusEl) {
        this.glossaryStatusEl.textContent = '已存入术语库 ✓';
        this.glossaryStatusEl.hidden = false;
      }
      if (this.glossaryBtn) {
        this.glossaryBtn.textContent = '已存入术语库 ✓';
        this.glossaryBtn.setAttribute('data-saved', 'true');
      }

      this.clearGlossaryFeedbackTimer();
      this.glossaryFeedbackTimer = setTimeout(() => {
        this.glossaryFeedbackTimer = null;
        if (this.glossaryBtn) {
          this.glossaryBtn.textContent = '+ 存术语';
          this.glossaryBtn.removeAttribute('data-saved');
        }
        if (this.glossaryStatusEl) {
          this.glossaryStatusEl.textContent = '';
          this.glossaryStatusEl.hidden = true;
        }
        this.setGlossaryEditorOpen(false);
      }, 1800);

      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.cleanupActiveDrag?.();
    this.clearGlossaryFeedbackTimer();
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.uiState = 'closed';
    this.pinned = false;
    this.setGlossaryEditorOpen(false);
    if (this.glossaryBtn) {
      this.glossaryBtn.textContent = '+ 存术语';
      this.glossaryBtn.removeAttribute('data-saved');
    }
    if (this.cardEl) {
      this.cardEl.style.display = 'none';
      this.cardEl.setAttribute('data-pinned', 'false');
    }
    if (this.pinBtn) {
      this.pinBtn.setAttribute('aria-pressed', 'false');
      this.pinBtn.textContent = 'Pin';
    }
    if (this.triggerIconBtn) this.triggerIconBtn.style.display = 'none';
    if (this.triggerDotBtn) this.triggerDotBtn.style.display = 'none';
    if (this.hostEl) {
      this.hostEl.hidden = true;
      this.hostEl.style.display = 'none';
    }
  }

  updateConfig(nextConfig: MarginConfig): void {
    this.config = nextConfig;
    if (this.hostEl) {
      this.hostEl.setAttribute('data-display-mode', nextConfig.uiColorMode);
    }
    if (this.langPillEl) {
      this.langPillEl.textContent = `→ ${nextConfig.targetLang}`;
    }
    if (!this.isFeatureEnabled() && !this.pinned) {
      this.close();
    }
  }

  destroy(): void {
    this.close();
    if (this.copyFeedbackTimer !== null) {
      clearTimeout(this.copyFeedbackTimer);
      this.copyFeedbackTimer = null;
    }
    this.clearGlossaryFeedbackTimer();
    this.cleanupListeners?.();
    this.cleanupListeners = null;
    this.hostEl?.remove();
    this.hostEl = null;
    this.shadow = null;
    this.triggerIconBtn = null;
    this.triggerDotBtn = null;
    this.cardEl = null;
    this.langPillEl = null;
    this.glossaryBtn = null;
    this.pinBtn = null;
    this.copyBtn = null;
    this.bodyEl = null;
    this.glossaryEditorEl = null;
    this.glossarySourceEl = null;
    this.glossaryKeepOrigBtn = null;
    this.glossaryTargetInput = null;
    this.glossaryStatusEl = null;
  }
}
