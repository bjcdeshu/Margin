import { BRAND } from '@shared/brand';
import { createDefaultMarginConfig } from '@shared/constants';
import { requestImageTranslation } from '@shared/messaging';
import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import { getMarginConfig, onMarginConfigChanged } from '@shared/storage';
import type {
  HoverModifierKey,
  MarginConfig,
  TabCommandMessage,
} from '@shared/types';
import { isUrlExcluded } from '@shared/url-match';
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
  if (document.documentElement.dataset.marginImageReady === '1') return;
  document.documentElement.dataset.marginImageReady = '1';

  let config: MarginConfig = createDefaultMarginConfig();
  const activeOverlays = new WeakMap<HTMLImageElement, MountedImageOverlayController>();

  void getMarginConfig().then((loaded) => {
    config = loaded;
  });
  onMarginConfigChanged((next) => {
    config = next;
  });

  // Subtle Shadow-isolated hover action pill for large comic / article images
  let hoverPillHost: HTMLElement | null = null;
  let hoveredImg: HTMLImageElement | null = null;
  let pillLabelEl: HTMLButtonElement | null = null;

  const ensureHoverPill = () => {
    if (hoverPillHost && pillLabelEl) return;
    hoverPillHost = document.createElement('div');
    hoverPillHost.setAttribute(`${BRAND.domAttrPrefix}-injected`, 'image-hover-pill');
    hoverPillHost.style.cssText =
      'position:absolute;z-index:2147483639;display:none;margin:0;padding:0;border:0;';
    const shadow = hoverPillHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${SHADOW_HOST_RESET_CSS}
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
      .pill:hover {
        background: var(--action-solid);
        color: var(--action-solid-ink);
        border-color: var(--action-solid);
      }
    `;
    pillLabelEl = document.createElement('button');
    pillLabelEl.type = 'button';
    pillLabelEl.className = 'pill';
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

  const hideHoverPill = () => {
    if (hoverPillHost) {
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

    ensureHoverPill();
    if (targetImg && hoverPillHost && pillLabelEl) {
      const rect = targetImg.getBoundingClientRect();
      hoverPillHost.setAttribute('data-display-mode', config.uiColorMode);
      hoverPillHost.style.top = `${Math.round(rect.top + window.scrollY + 8)}px`;
      hoverPillHost.style.left = `${Math.round(rect.right + window.scrollX - 118)}px`;
      hoverPillHost.style.display = 'block';
      pillLabelEl.textContent =
        config.interfaceLang === 'en' ? 'Margin · Translating…' : 'Margin · 识图中…';
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
      hideHoverPill();
    }
  };

  document.addEventListener(
    'pointerover',
    (e: PointerEvent) => {
      if (isUrlExcluded(window.location.href, config.urlRules)) return;
      const target = e.target;
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
      ensureHoverPill();
      if (hoverPillHost && pillLabelEl) {
        hoverPillHost.setAttribute('data-display-mode', config.uiColorMode);
        pillLabelEl.textContent =
          config.interfaceLang === 'en' ? 'Translate Image' : '翻译图片 · Margin';
        hoverPillHost.style.top = `${Math.round(rect.top + window.scrollY + 8)}px`;
        hoverPillHost.style.left = `${Math.round(Math.max(8, rect.right + window.scrollX - 126))}px`;
        hoverPillHost.style.display = 'block';
      }
    },
    { passive: true },
  );

  // Runtime message listener for context-menu image translation
  if (
    typeof globalThis.chrome !== 'undefined' &&
    chrome.runtime?.onMessage
  ) {
    chrome.runtime.onMessage.addListener((raw: unknown) => {
      const msg = raw as TabCommandMessage;
      if (msg && msg.type === 'margin:cmd:translate-context-image' && msg.srcUrl) {
        const img = findMatchingImageOnPage(msg.srcUrl);
        void translateTargetImage(img, msg.srcUrl);
      }
    });
  }

  // Also listen for custom DOM event dispatch (handy for local integration / tests)
  window.addEventListener('margin:cmd:translate-context-image', (ev: Event) => {
    const detail = (ev as CustomEvent<{ srcUrl?: string }>).detail;
    if (detail?.srcUrl) {
      const img = findMatchingImageOnPage(detail.srcUrl);
      void translateTargetImage(img, detail.srcUrl);
    }
  });
}

// Auto-initialize in browser content-script environment (skip automatic hook in Vitest unit runner)
if (
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  !(globalThis as Record<string, unknown>).__VITEST_WORKER_ID__
) {
  initMarginImageTranslator();
}
