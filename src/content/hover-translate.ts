import type { HoverModifierKey, MarginConfig } from '@shared/types';
import { findClosestParagraphBlock } from './dom-walker';
import type { WebpageRenderer } from './renderer';

const PURE_MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Control',
  'Alt',
  'Shift',
  'Meta',
]);

export function matchesHoverModifier(
  modifier: HoverModifierKey,
  state: {
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  },
): boolean {
  switch (modifier) {
    case 'none':
      return true;
    case 'ctrl':
      return state.ctrlKey && !state.altKey && !state.metaKey;
    case 'alt':
      return state.altKey && !state.ctrlKey && !state.metaKey;
    case 'shift':
      return state.shiftKey && !state.ctrlKey && !state.altKey && !state.metaKey;
    case 'meta':
      return state.metaKey && !state.ctrlKey && !state.altKey;
  }
}

export interface HoverTranslatorOptions {
  config: MarginConfig;
  renderer: WebpageRenderer;
  doc?: Document;
}

export class HoverTranslator {
  private config: MarginConfig;
  private readonly renderer: WebpageRenderer;
  private readonly doc: Document;

  private hoveredTarget: EventTarget | null = null;
  private currentBlock: HTMLElement | null = null;
  private dwellTriggeredBlock: HTMLElement | null = null;
  private modifierState = {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  };
  private comboTainted = false;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupListeners: (() => void) | null = null;

  constructor(options: HoverTranslatorOptions) {
    this.config = options.config;
    this.renderer = options.renderer;
    this.doc = options.doc ?? document;
  }

  mount(): void {
    if (this.cleanupListeners) return;
    const win = this.doc.defaultView ?? window;

    const onPointerMove = (ev: PointerEvent | MouseEvent) => {
      this.hoveredTarget = ev.target;
      this.modifierState = {
        ctrlKey: ev.ctrlKey,
        altKey: ev.altKey,
        shiftKey: ev.shiftKey,
        metaKey: ev.metaKey,
      };
      const nextBlock = findClosestParagraphBlock(ev.target as Node | null);
      if (nextBlock !== this.currentBlock) {
        this.currentBlock = nextBlock;
        this.dwellTriggeredBlock = null;
        this.scheduleOrCancelHover();
      } else if (
        nextBlock &&
        this.dwellTriggeredBlock !== nextBlock &&
        this.hoverTimer === null
      ) {
        this.scheduleOrCancelHover();
      }
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      this.modifierState = {
        ctrlKey: ev.ctrlKey,
        altKey: ev.altKey,
        shiftKey: ev.shiftKey,
        metaKey: ev.metaKey,
      };

      if (!PURE_MODIFIER_KEYS.has(ev.key)) {
        // User pressed a shortcut combo like Ctrl+C or Alt+A — cancel hover trigger!
        this.comboTainted = true;
        this.clearHoverTimer();
        return;
      }

      if (!ev.repeat) {
        this.comboTainted = false;
        this.scheduleOrCancelHover();
      }
    };

    const onKeyUp = (ev: KeyboardEvent) => {
      this.modifierState = {
        ctrlKey: ev.ctrlKey,
        altKey: ev.altKey,
        shiftKey: ev.shiftKey,
        metaKey: ev.metaKey,
      };
      if (
        !this.modifierState.ctrlKey &&
        !this.modifierState.altKey &&
        !this.modifierState.shiftKey &&
        !this.modifierState.metaKey
      ) {
        this.comboTainted = false;
      }
      if (!matchesHoverModifier(this.config.hover.modifierKey, this.modifierState)) {
        this.clearHoverTimer();
        // Reset dwell lock so pressing the modifier again on the same block toggles it back
        this.dwellTriggeredBlock = null;
      }
    };

    const onWindowBlur = () => {
      this.modifierState = {
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      };
      this.comboTainted = false;
      this.clearHoverTimer();
    };

    win.addEventListener('pointermove', onPointerMove, { passive: true });
    win.addEventListener('mouseover', onPointerMove, { passive: true });
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('keyup', onKeyUp, true);
    win.addEventListener('blur', onWindowBlur);

    this.cleanupListeners = () => {
      win.removeEventListener('pointermove', onPointerMove);
      win.removeEventListener('mouseover', onPointerMove);
      win.removeEventListener('keydown', onKeyDown, true);
      win.removeEventListener('keyup', onKeyUp, true);
      win.removeEventListener('blur', onWindowBlur);
    };
  }

  private clearHoverTimer(): void {
    if (this.hoverTimer !== null) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  private scheduleOrCancelHover(): void {
    this.clearHoverTimer();

    if (!this.config.hover.enabled) return;
    if (this.comboTainted) return;

    const block =
      this.currentBlock ??
      findClosestParagraphBlock(this.hoveredTarget as Node | null);
    this.currentBlock = block;

    if (!block || !block.isConnected) return;
    if (this.dwellTriggeredBlock === block) return;
    if (!matchesHoverModifier(this.config.hover.modifierKey, this.modifierState)) {
      return;
    }

    const delayMs = Math.max(40, this.config.hover.delayMs ?? 180);
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      if (!this.config.hover.enabled || this.comboTainted) return;
      if (!block.isConnected) return;
      if (!matchesHoverModifier(this.config.hover.modifierKey, this.modifierState)) {
        return;
      }
      this.dwellTriggeredBlock = block;
      void this.renderer.toggleSingleBlock(block, 'hover');
    }, delayMs);
  }

  updateConfig(nextConfig: MarginConfig): void {
    this.config = nextConfig;
    if (!nextConfig.hover.enabled) {
      this.clearHoverTimer();
    }
  }

  destroy(): void {
    this.clearHoverTimer();
    this.cleanupListeners?.();
    this.cleanupListeners = null;
    this.hoveredTarget = null;
    this.currentBlock = null;
    this.dwellTriggeredBlock = null;
  }
}
