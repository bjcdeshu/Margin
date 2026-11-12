import { BRAND } from '@shared/brand';
import { createDefaultMarginConfig } from '@shared/constants';
import {
  isExtensionContextValid,
  requestImageTranslation,
} from '@shared/messaging';
import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import { getMarginConfig, onMarginConfigChanged } from '@shared/storage';
import type {
  HoverModifierKey,
  MarginConfig,
  TabCommandMessage,
} from '@shared/types';
import {
  isUnsupportedBrowserUrl,
  matchesAnyUrlGlob,
} from '@shared/url-match';
import {
  captureImageDataUrl,
  mountVisionImageOverlay,
  type MountedImageOverlayController,
} from './vision-overlay';

export * from './vision-overlay';

const MIN_HOVER_IMG_WIDTH = 200;
const MIN_HOVER_IMG_HEIGHT = 160;

function matchesModifier(e: MouseEvent | PointerEvent, key: HoverModifierKey): boolean {
  switch (key) {
    case 'none':
      return true;
    case 'ctrl':
      return e.ctrlKey;
    case 'alt':
      return e.altKey;
    case 'shift':
      return e.shiftKey;
    case 'meta':
      return e.metaKey;
  }
}

function findMatchingImageOnPage(srcUrl: string): HTMLImageElement | null {
  const images = Array.from(document.querySelectorAll('img'));
  const exact = images.find(
    (img) => img.currentSrc === srcUrl || img.src === srcUrl,
  );
  if (exact) return exact;

  try {
    const normalized = new URL(srcUrl, window.location.href).href;
    const resolved = images.find(
      (img) => img.currentSrc === normalized || img.src === normalized,
    );
    if (resolved) return resolved;
  } catch {
    // Ignore malformed URLs
  }

  // Fallback to largest visible image if context-menu was triggered on a wrapper
  const sorted = images
    .filter((img) => img.width >= 120 && img.height >= 120)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  return sorted[0] ?? null;
}

export function initMarginImageTranslator(): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const globalBag = globalThis as Record<string, unknown>;
  const bootKey = `__${BRAND.slug}_image_translator_booted__`;
  if (globalBag[bootKey] === true) {
    return;
  }
  globalBag[bootKey] = true;
  // Clear legacy v2.1.1 cross-world DOM dataset flag if present on `<html>`
  delete document.documentElement.dataset.marginImageReady;

  const hadRuntimeIdAtMount = Boolean(globalThis.chrome?.runtime?.id);
  let destroyed = false;
  let config: MarginConfig = createDefaultMarginConfig();
  const activeOverlays = new WeakMap<HTMLImageElement, MountedImageOverlayController>();

  void getMarginConfig()
    .then((loaded) => {
      if (!destroyed) {
        config = loaded;
      }
    })
    .catch(() => {});
  let unsubscribeConfig: (() => void) | null = onMarginConfigChanged((next) => {
    if (destroyed) return;
    config = next;
    if (matchesAnyUrlGlob(window.location.href, next.urlRules.excludeMatches)) {
      hideHoverPill();
    }
  });

  // Subtle Shadow-isolated hover action pill for large comic / article images
  let hoverPillHost: HTMLElement | null = null;
  let hoveredImg: HTMLImageElement | null = null;
  let pillLabelEl: HTMLButtonElement | null = null;
  let isTranslatingImage = false;
  let hoverHideTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHoverHideTimer = () => {
    if (hoverHideTimer !== null) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
  };

  const scheduleHoverPillHide = () => {
    clearHoverHideTimer();
    hoverHideTimer = setTimeout(() => {
      hoverHideTimer = null;
      if (!isTranslatingImage) {
        hideHoverPill();
      }
    }, 160);
  };

  const ensureHoverPill = () => {
    if (hoverPillHost && pillLabelEl) return;
    hoverPillHost = document.createElement('div');
    hoverPillHost.setAttribute(`${BRAND.domAttrPrefix}-injected`, 'image-hover-pill');
    hoverPillHost.setAttribute('data-margin-host', 'image-hover-pill');
    hoverPillHost.hidden = true;
    hoverPillHost.style.cssText =
      'position:absolute !important;z-index:2147483639 !important;display:none;margin:0 !important;padding:0 !important;border:0 !important;';
    const shadow = hoverPillHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${SHADOW_HOST_RESET_CSS}
      :host {
        position: absolute !important;
        display: block !important;
        top: var(--margin-pill-top, 0px) !important;
        left: var(--margin-pill-left, 0px) !important;
        z-index: 2147483639 !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        pointer-events: auto !important;
      }
      :host([hidden]) {
        display: none !important;
      }
      .pill {
        appearance: none;
        border: 1px solid var(--rule-strong);
        background: var(--paper);
        color: var(--ink);
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(17, 17, 15, 0.16);
      }
      .pill[hidden] {
        display: none !important;
      }
      .pill:hover {
        background: var(--action-solid);
        color: var(--action-solid-ink);
        border-color: var(--action-solid);
      }
    `;
    pillLabelEl = document.createElement('button');
    pillLabelEl.type = 'button';
    pillLabelEl.className = 'pill';
    pillLabelEl.hidden = true;
    pillLabelEl.addEventListener('pointerenter', () => {
      clearHoverHideTimer();
    });
    pillLabelEl.addEventListener('pointerleave', () => {
      scheduleHoverPillHide();
    });
    pillLabelEl.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (hoveredImg) {
        const target = hoveredImg;
        hideHoverPill();
        void translateTargetImage(target, target.currentSrc || target.src);
      }
    });
    shadow.append(style, pillLabelEl);
    document.body.appendChild(hoverPillHost);
  };

  const showHoverPillAt = (top: number, left: number, label: string) => {
    ensureHoverPill();
    if (!hoverPillHost || !pillLabelEl) return;
    clearHoverHideTimer();
    const topPx = `${Math.round(top)}px`;
    const leftPx = `${Math.round(left)}px`;
    hoverPillHost.setAttribute('data-display-mode', config.uiColorMode);
    hoverPillHost.style.setProperty('--margin-pill-top', topPx);
    hoverPillHost.style.setProperty('--margin-pill-left', leftPx);
    hoverPillHost.style.setProperty('top', topPx, 'important');
    hoverPillHost.style.setProperty('left', leftPx, 'important');
    hoverPillHost.hidden = false;
    hoverPillHost.style.display = 'block';
    pillLabelEl.hidden = false;
    pillLabelEl.textContent = label;
  };

  const hideHoverPill = () => {
    clearHoverHideTimer();
    if (pillLabelEl) {
      pillLabelEl.hidden = true;
    }
    if (hoverPillHost) {
      hoverPillHost.hidden = true;
      hoverPillHost.style.display = 'none';
    }
  };

  const translateTargetImage = async (
    targetImg: HTMLImageElement | null,
    srcUrl: string,
  ) => {
    if (targetImg) {
      const existing = activeOverlays.get(targetImg);
      existing?.destroy();
      activeOverlays.delete(targetImg);
    }

    isTranslatingImage = true;
    if (targetImg) {
      const rect = targetImg.getBoundingClientRect();
      showHoverPillAt(
        rect.top + window.scrollY + 8,
        Math.max(8, rect.right + window.scrollX - 118),
        config.interfaceLang === 'en' ? 'Margin · Translating…' : 'Margin · 识图中…',
      );
    }

    try {
      const captured = await captureImageDataUrl({
        img: targetImg,
        srcUrl,
        pageUrl: window.location.href,
      });

      const res = await requestImageTranslation({
        requestId: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        imageDataUrl: captured.dataUrl,
        fromLang: config.sourceLang,
        toLang: config.targetLang,
        pageUrl: window.location.href,
      });

      isTranslatingImage = false;
      hideHoverPill();
      if (!res.ok) return;

      if (targetImg) {
        const controller = mountVisionImageOverlay({
          targetImg,
          response: res,
          uiColorMode: config.uiColorMode,
          interfaceLang: config.interfaceLang,
          onClose: () => {
            activeOverlays.delete(targetImg);
          },
        });
        activeOverlays.set(targetImg, controller);
      }
    } catch {
      isTranslatingImage = false;
      hideHoverPill();
    }
  };

  const onPointerOver = (e: PointerEvent) => {
    if (!isExtensionContextValid(hadRuntimeIdAtMount)) {
      destroyImageTranslator();
      return;
    }
    if (
      isUnsupportedBrowserUrl(window.location.href) ||
      matchesAnyUrlGlob(window.location.href, config.urlRules.excludeMatches)
    ) {
      return;
    }
    const target = e.target;
    if (
      hoverPillHost &&
      (target === hoverPillHost ||
        (typeof e.composedPath === 'function' && e.composedPath().includes(hoverPillHost)))
    ) {
      clearHoverHideTimer();
      return;
    }
    if (!(target instanceof HTMLImageElement)) return;
    if (target.closest(`[${BRAND.domAttrPrefix}-injected]`)) return;
    if (activeOverlays.has(target)) return;

    const rect = target.getBoundingClientRect();
    if (rect.width < MIN_HOVER_IMG_WIDTH || rect.height < MIN_HOVER_IMG_HEIGHT) {
      return;
    }

    const modifierHeld =
      config.hover.modifierKey !== 'none' &&
      matchesModifier(e, config.hover.modifierKey);
    const allowHoverPill = config.hover.enabled
      ? matchesModifier(e, config.hover.modifierKey)
      : modifierHeld;

    if (!allowHoverPill) return;

    hoveredImg = target;
    showHoverPillAt(
      rect.top + window.scrollY + 8,
      Math.max(8, rect.right + window.scrollX - 126),
      config.interfaceLang === 'en' ? 'Translate Image' : '翻译图片 · Margin',
    );
  };

  const onPointerOut = (e: PointerEvent) => {
    if (!isExtensionContextValid(hadRuntimeIdAtMount)) {
      destroyImageTranslator();
      return;
    }
    if (!hoveredImg || isTranslatingImage) return;
    if (e.target === hoveredImg) {
      scheduleHoverPillHide();
    }
  };

  const onRuntimeMessage = (raw: unknown) => {
    if (destroyed) return;
    const msg = raw as TabCommandMessage;
    if (msg && msg.type === 'margin:cmd:translate-context-image' && msg.srcUrl) {
      const img = findMatchingImageOnPage(msg.srcUrl);
      void translateTargetImage(img, msg.srcUrl);
    }
  };

  const onWindowTranslateCmd = (ev: Event) => {
    if (!isExtensionContextValid(hadRuntimeIdAtMount)) {
      destroyImageTranslator();
      return;
    }
    const detail = (ev as CustomEvent<{ srcUrl?: string }>).detail;
    if (detail?.srcUrl) {
      const img = findMatchingImageOnPage(detail.srcUrl);
      void translateTargetImage(img, detail.srcUrl);
    }
  };

  function destroyImageTranslator(): void {
    if (destroyed) return;
    destroyed = true;
    document.removeEventListener('pointerover', onPointerOver);
    document.removeEventListener('pointerout', onPointerOut);
    window.removeEventListener(
      'margin:cmd:translate-context-image',
      onWindowTranslateCmd,
    );
    try {
      unsubscribeConfig?.();
    } catch {
      // Ignore storage unsubscribe errors when extension context is invalidated
    }
    unsubscribeConfig = null;
    try {
      globalThis.chrome?.runtime?.onMessage?.removeListener(onRuntimeMessage);
    } catch {
      // Ignore runtime message cleanup errors when extension context is invalidated
    }
    clearHoverHideTimer();
    hoverPillHost?.remove();
    hoverPillHost = null;
    pillLabelEl = null;
    hoveredImg = null;
    delete globalBag[bootKey];
  }

  document.addEventListener('pointerover', onPointerOver, { passive: true });
  document.addEventListener('pointerout', onPointerOut, { passive: true });

  // Runtime message listener for context-menu image translation
  if (
    typeof globalThis.chrome !== 'undefined' &&
    globalThis.chrome?.runtime?.onMessage
  ) {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  }

  // Also listen for custom DOM event dispatch (handy for local integration / tests)
  window.addEventListener(
    'margin:cmd:translate-context-image',
    onWindowTranslateCmd,
  );
}

// Auto-initialize in browser content-script environment (skip automatic hook in Vitest unit runner)
if (
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  !(globalThis as Record<string, unknown>).__VITEST_WORKER_ID__
) {
  initMarginImageTranslator();
}
