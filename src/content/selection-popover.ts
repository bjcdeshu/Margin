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

const MAX_SELECTION_CHARS = 4500;

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
  background: var(--paper);
  color: var(--action-solid);
  border: 1px solid var(--rule-strong);
  border-radius: 5px;
  box-shadow: 0 4px 12px rgba(21, 20, 17, 0.14);
  font-size: 13px;
  font-weight: 700;
  line-height: 16px;
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
}

.trigger-icon:hover {
  background: var(--paper-soft);
  color: var(--action-solid-hover);
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
  background: var(--accent);
  border: 1.5px solid var(--paper);
  box-shadow: 0 2px 8px rgba(21, 20, 17, 0.22);
}

.card {
  position: fixed;
  width: 340px;
  max-width: calc(100vw - 24px);
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--rule);
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(21, 20, 17, 0.16);
  pointer-events: auto;
  overflow: hidden;
}

.card[data-pinned="true"] {
  border-color: var(--rule-strong);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 34px;
  padding: 0px 10px;
  background: var(--paper-soft);
  border-bottom: 1px solid var(--rule);
  cursor: grab;
  user-select: none;
}

.card[data-dragging="true"] .card-header {
  cursor: grabbing;
}

.brand-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.brand-title {
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  color: var(--ink);
}

.lang-pill {
  padding: 1px 5px;
  font-size: 11px;
  line-height: 14px;
  color: var(--muted);
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: 4px;
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
  font-size: 11px;
  line-height: 14px;
  color: var(--muted);
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}

.icon-btn:hover {
  color: var(--ink);
  background: var(--state-hover-surface);
  border-color: var(--rule);
}

.icon-btn[aria-pressed="true"] {
  color: var(--action-solid);
  background: var(--paper-warm);
  border-color: var(--rule-strong);
  font-weight: 600;
}

.icon-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.card-body {
  max-height: 240px;
  overflow-y: auto;
  padding: 10px 12px;
  font-size: 14px;
  line-height: 21px;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
}

.card-body[data-status="loading"] {
  color: var(--muted);
}

.card-body[data-status="error"] {
  color: #b4412e;
  font-size: 13px;
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
  now?: () => number;
  transport?: SelectionTransportFn;
  clipboardWrite?: (text: string) => Promise<void>;
  isUrlExcluded?: () => boolean;
}

let selectionReqSeq = 0;

export class SelectionPopover {
  private config: MarginConfig;
  private readonly doc: Document;
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
  private pinBtn: HTMLButtonElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private bodyEl: HTMLElement | null = null;

  private uiState: 'closed' | 'trigger' | 'card' = 'closed';
  private pinned = false;
  private dragging = false;
  private cardLeft = 24;
  private cardTop = 24;

  private selectedSourceText = '';
  private translatedText = '';
  private activeAbortController: AbortController | null = null;
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  private pointerDownInsideAnchor = false;
  private suppressAnchorClickUntil = 0;
  private hadRuntimeIdAtMount = false;

  private cleanupListeners: (() => void) | null = null;
  private cleanupActiveDrag: (() => void) | null = null;

  constructor(options: SelectionPopoverOptions) {
    this.config = options.config;
    this.doc = options.doc ?? document;
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
    const brandTitle = this.doc.createElement('span');
    brandTitle.className = 'brand-title';
    brandTitle.textContent = 'Margin';
    const langPill = this.doc.createElement('span');
    langPill.className = 'lang-pill';
    langPill.textContent = `→ ${this.config.targetLang}`;
    brandGroup.append(brandTitle, langPill);

    const actions = this.doc.createElement('div');
    actions.className = 'actions';

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

    actions.append(pinBtn, copyBtn, closeBtn);
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
    body.className = 'card-body';
    body.setAttribute('data-part', 'card-body');

    card.append(header, body);
    layer.append(triggerIcon, triggerDot, card);
    shadow.append(style, layer);
    parent.appendChild(host);

    this.hostEl = host;
    this.shadow = shadow;
    this.triggerIconBtn = triggerIcon;
    this.triggerDotBtn = triggerDot;
    this.cardEl = card;
    this.langPillEl = langPill;
    this.pinBtn = pinBtn;
    this.copyBtn = copyBtn;
    this.bodyEl = body;

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

    this.cardLeft = Math.max(8, Math.min(vw - 348, Math.round(left)));
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
    this.bodyEl.setAttribute('data-status', 'loading');
    this.bodyEl.textContent = 'Translating…';
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
      items: [{ id: 1, text: this.selectedSourceText, hasRichTags: false }],
    };

    try {
      const response = await this.transport(
        payload,
        {
          onItemReady: (item) => {
            if (controller.signal.aborted || !this.bodyEl) return;
            if (item.id === 1 && item.trans.trim()) {
              this.translatedText = item.trans.trim();
              this.bodyEl.setAttribute('data-status', 'ready');
              this.bodyEl.textContent = this.translatedText;
            }
          },
        },
        controller.signal,
        preferStream,
      );

      if (controller.signal.aborted || !this.bodyEl) return;

      if (!response.ok || !response.items[0]?.trans?.trim()) {
        this.bodyEl.setAttribute('data-status', 'error');
        this.bodyEl.textContent =
          response.error?.message || 'Translation failed.';
        return;
      }

      this.translatedText = response.items[0].trans.trim();
      this.bodyEl.setAttribute('data-status', 'ready');
      this.bodyEl.textContent = this.translatedText;
    } catch (err) {
      if (controller.signal.aborted || !this.bodyEl) return;
      this.bodyEl.setAttribute('data-status', 'error');
      this.bodyEl.textContent =
        err instanceof Error ? err.message : 'Translation failed.';
    } finally {
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

  close(): void {
    this.cleanupActiveDrag?.();
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.uiState = 'closed';
    this.pinned = false;
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
    this.cleanupListeners?.();
    this.cleanupListeners = null;
    this.hostEl?.remove();
    this.hostEl = null;
    this.shadow = null;
    this.triggerIconBtn = null;
    this.triggerDotBtn = null;
    this.cardEl = null;
    this.langPillEl = null;
    this.pinBtn = null;
    this.copyBtn = null;
    this.bodyEl = null;
  }
}
