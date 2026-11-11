import { BRAND } from '@shared/brand';
import { requestImageDataUrlFetch } from '@shared/messaging';
import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import type {
  FetchImageDataUrlRequest,
  FetchImageDataUrlResponse,
  TranslateImageResponse,
  UiColorMode,
  VisionBoxRegion,
} from '@shared/types';

export type CaptureTier = 'canvas' | 'credentialed-fetch' | 'dnr-background';

export interface CaptureImageResult {
  dataUrl: string;
  tier: CaptureTier;
}

export interface CaptureImageDependencies {
  maxEdge?: number;
  quality?: number;
  fetchImpl?: typeof fetch;
  fetchViaBackgroundDnr?: (
    req: FetchImageDataUrlRequest,
  ) => Promise<FetchImageDataUrlResponse>;
}

export interface ScaledPixelBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type ImageOverlayViewMode = 'overlay' | 'compare';

export interface MountedImageOverlayController {
  host: HTMLElement;
  shadowRoot: ShadowRoot;
  getMode: () => ImageOverlayViewMode;
  setMode: (mode: ImageOverlayViewMode) => void;
  updatePosition: () => void;
  destroy: () => void;
}

function clampCoord1000(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1000, val));
}

/**
 * Converts normalized `[ymin, xmin, ymax, xmax]` (`0..1000`) coordinates into
 * rendered pixel geometry (`top`, `left`, `width`, `height`), clamping out-of-range
 * values and repairing inverted coordinates.
 */
export function scaleVisionBoxToPixels(
  box: readonly [number, number, number, number],
  renderWidth: number,
  renderHeight: number,
): ScaledPixelBox {
  const safeW = Math.max(1, renderWidth);
  const safeH = Math.max(1, renderHeight);

  const rawYMin = clampCoord1000(box[0]);
  const rawXMin = clampCoord1000(box[1]);
  const rawYMax = clampCoord1000(box[2]);
  const rawXMax = clampCoord1000(box[3]);

  const y0 = Math.min(rawYMin, rawYMax);
  const y1 = Math.max(rawYMin, rawYMax);
  const x0 = Math.min(rawXMin, rawXMax);
  const x1 = Math.max(rawXMin, rawXMax);

  const left = Math.round((x0 / 1000) * safeW * 100) / 100;
  const top = Math.round((y0 / 1000) * safeH * 100) / 100;

  const minBoxW = Math.min(24, safeW);
  const minBoxH = Math.min(18, safeH);

  const rawPxW = ((x1 - x0) / 1000) * safeW;
  const rawPxH = ((y1 - y0) / 1000) * safeH;

  const width = Math.round(Math.min(safeW - left, Math.max(minBoxW, rawPxW)) * 100) / 100;
  const height = Math.round(Math.min(safeH - top, Math.max(minBoxH, rawPxH)) * 100) / 100;

  return { top, left, width, height };
}

async function blobToDataUrlFallback(blob: Blob): Promise<string> {
  const mime = blob.type || 'image/webp';
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(buf).toString('base64');
  return `data:${mime};base64,${base64}`;
}

async function downscaleBlobToWebp(
  blob: Blob,
  maxEdge: number,
  quality: number,
): Promise<string> {
  if (typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width || 1, bitmap.height || 1));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close?.();
        const dataUrl = canvas.toDataURL('image/webp', quality);
        if (dataUrl.startsWith('data:image/') && dataUrl.length > 32) {
          return dataUrl;
        }
      }
      bitmap.close?.();
    } catch {
      // Fallback to direct base64 encoding below
    }
  }
  return blobToDataUrlFallback(blob);
}

/**
 * 3-Tier Anti-403 Image Capture Pipeline:
 * 1. Zero-network `<canvas>` `drawImage` -> `image/webp` (`<= 1536px`).
 * 2. Content-script `fetch(src, { credentials: 'include' })` carrying cookies & page Referer.
 * 3. Background Service Worker DNR session-rule `Referer` fetch (`requestImageDataUrlFetch`).
 */
export async function captureImageDataUrl(params: {
  img?: HTMLImageElement | null;
  srcUrl?: string;
  pageUrl: string;
  deps?: CaptureImageDependencies;
}): Promise<CaptureImageResult> {
  const { img, srcUrl, pageUrl, deps } = params;
  const maxEdge = deps?.maxEdge ?? 1536;
  const quality = deps?.quality ?? 0.86;
  const fetchFn = deps?.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const fetchDnr = deps?.fetchViaBackgroundDnr ?? requestImageDataUrlFetch;

  // Attempt 1: Zero-network Canvas capture
  if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
    try {
      const scale = Math.min(
        1,
        maxEdge / Math.max(img.naturalWidth, img.naturalHeight),
      );
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/webp', quality);
        if (dataUrl && dataUrl.startsWith('data:image/') && dataUrl.length > 32) {
          return { dataUrl, tier: 'canvas' };
        }
      }
    } catch {
      // Cross-origin tainted canvas SecurityError -> fall through to Attempt 2
    }
  }

  const resolvedUrl = String(srcUrl || img?.currentSrc || img?.src || '').trim();
  if (!resolvedUrl) {
    throw new Error('Unable to resolve target image URL for Vision translation.');
  }
  if (resolvedUrl.startsWith('data:image/')) {
    return { dataUrl: resolvedUrl, tier: 'canvas' };
  }

  // Attempt 2: Same-context credentialed fetch
  if (typeof fetchFn === 'function') {
    try {
      const res = await fetchFn(resolvedUrl, { credentials: 'include' });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size > 0) {
          const dataUrl = await downscaleBlobToWebp(blob, maxEdge, quality);
          return { dataUrl, tier: 'credentialed-fetch' };
        }
      }
    } catch {
      // CORS or hotlink 403 -> fall through to Attempt 3
    }
  }

  // Attempt 3: Background DNR Referer session rule fetch
  const dnrRes = await fetchDnr({
    imageUrl: resolvedUrl,
    refererUrl: pageUrl,
  });
  if (dnrRes.ok && dnrRes.dataUrl) {
    return { dataUrl: dnrRes.dataUrl, tier: 'dnr-background' };
  }

  throw new Error(
    dnrRes.error || 'Failed to capture image across canvas, credentialed fetch, and DNR Referer.',
  );
}

const OVERLAY_SCOPED_CSS = /* css */ `
.mv-root {
  position: relative;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.mv-toolbar {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--rule-strong);
  border-radius: 6px;
  pointer-events: auto;
  box-shadow: 0 2px 10px rgba(17, 17, 15, 0.16);
}

.mv-brand {
  font-family: Georgia, "Times New Roman", "Noto Serif SC", serif;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  padding: 0 4px;
}

.mv-btn {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  padding: 4px 7px;
  border-radius: 4px;
  cursor: pointer;
}

.mv-btn:hover {
  color: var(--ink);
  background: var(--state-hover-surface);
}

.mv-btn[data-active="true"] {
  background: var(--action-solid);
  color: var(--action-solid-ink);
}

.mv-region {
  position: absolute;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 3px 5px;
  border-radius: 4px;
  background: rgba(251, 250, 246, 0.94);
  color: #20211f;
  border: 1px solid var(--rule-strong);
  font-size: 13px;
  line-height: 1.35;
  overflow: auto;
  pointer-events: auto;
  word-break: break-word;
}

:host([data-display-mode="night"]) .mv-region {
  background: rgba(21, 20, 17, 0.94);
  color: #ece4d2;
}

.mv-region[data-vertical="true"] {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  align-items: center;
}

.mv-root[data-mode="compare"] .mv-region {
  background: rgba(251, 250, 246, 0.82);
  border-style: dashed;
  writing-mode: horizontal-tb;
}

:host([data-display-mode="night"]) .mv-root[data-mode="compare"] .mv-region {
  background: rgba(21, 20, 17, 0.84);
}

.mv-region-src {
  display: none;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 2px;
  border-bottom: 1px solid var(--rule);
  padding-bottom: 2px;
}

.mv-root[data-mode="compare"] .mv-region-src {
  display: block;
}

.mv-fallback-card {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 10px;
  max-height: 68%;
  overflow-y: auto;
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--rule-strong);
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13.5px;
  line-height: 1.6;
  pointer-events: auto;
  white-space: pre-wrap;
  box-shadow: 0 4px 16px rgba(17, 17, 15, 0.2);
}

.mv-root[data-mode="compare"] .mv-fallback-card {
  opacity: 0.42;
}
`;

export interface MountImageOverlayOptions {
  targetImg: HTMLImageElement;
  response: TranslateImageResponse;
  uiColorMode: UiColorMode;
  interfaceLang: 'zh-CN' | 'en';
  onClose?: () => void;
}

/**
 * Renders a Shadow-isolated (`SHADOW_HOST_RESET_CSS`) Quiet Paper overlay anchored
 * to `targetImg`, supporting `译文覆盖` / `对比原文` / `关闭` and graceful fallback to a
 * pinned bilingual card when `regions` is empty and `fallbackFullText` is returned.
 */
export function mountVisionImageOverlay(
  options: MountImageOverlayOptions,
): MountedImageOverlayController {
  const { targetImg, response, uiColorMode, interfaceLang: lang, onClose } = options;
  const doc = targetImg.ownerDocument || document;

  const host = doc.createElement('div');
  host.setAttribute(`${BRAND.domAttrPrefix}-injected`, 'image-overlay');
  host.setAttribute('data-display-mode', uiColorMode);
  host.style.cssText =
    'position:absolute;z-index:2147483640;pointer-events:none;margin:0;padding:0;border:0;';

  const shadowRoot = host.attachShadow({ mode: 'open' });

  const styleEl = doc.createElement('style');
  styleEl.textContent = `${SHADOW_HOST_RESET_CSS}\n${OVERLAY_SCOPED_CSS}`;
  shadowRoot.appendChild(styleEl);

  const root = doc.createElement('div');
  root.className = 'mv-root';
  let currentMode: ImageOverlayViewMode = 'overlay';
  root.setAttribute('data-mode', currentMode);

  // Toolbar: 译文覆盖 / 对比原文 / 关闭
  const toolbar = doc.createElement('div');
  toolbar.className = 'mv-toolbar';

  const brandSpan = doc.createElement('span');
  brandSpan.className = 'mv-brand';
  brandSpan.textContent = BRAND.name;
  toolbar.appendChild(brandSpan);

  const btnOverlay = doc.createElement('button');
  btnOverlay.type = 'button';
  btnOverlay.className = 'mv-btn';
  btnOverlay.setAttribute('data-role', 'mode-overlay');
  btnOverlay.setAttribute('data-active', 'true');
  btnOverlay.textContent = lang === 'en' ? 'Overlay' : '译文覆盖';

  const btnCompare = doc.createElement('button');
  btnCompare.type = 'button';
  btnCompare.className = 'mv-btn';
  btnCompare.setAttribute('data-role', 'mode-compare');
  btnCompare.setAttribute('data-active', 'false');
  btnCompare.textContent = lang === 'en' ? 'Compare' : '对比原文';

  const btnClose = doc.createElement('button');
  btnClose.type = 'button';
  btnClose.className = 'mv-btn';
  btnClose.setAttribute('data-role', 'close');
  btnClose.textContent = lang === 'en' ? 'Close' : '关闭';

  const setMode = (next: ImageOverlayViewMode) => {
    currentMode = next;
    root.setAttribute('data-mode', next);
    btnOverlay.setAttribute('data-active', next === 'overlay' ? 'true' : 'false');
    btnCompare.setAttribute('data-active', next === 'compare' ? 'true' : 'false');
  };

  btnOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    setMode('overlay');
  });
  btnCompare.addEventListener('click', (e) => {
    e.stopPropagation();
    setMode('compare');
  });

  toolbar.append(btnOverlay, btnCompare, btnClose);
  root.appendChild(toolbar);

  const regionNodes: Array<{ el: HTMLElement; region: VisionBoxRegion }> = [];

  if (response.regions && response.regions.length > 0) {
    for (const region of response.regions) {
      const boxEl = doc.createElement('div');
      boxEl.className = 'mv-region';
      if (region.vertical) {
        boxEl.setAttribute('data-vertical', 'true');
      }

      if (region.src) {
        const srcEl = doc.createElement('div');
        srcEl.className = 'mv-region-src';
        srcEl.textContent = region.src;
        boxEl.appendChild(srcEl);
      }

      const transEl = doc.createElement('div');
      transEl.className = 'mv-region-trans';
      transEl.textContent = region.trans;
      boxEl.appendChild(transEl);

      root.appendChild(boxEl);
      regionNodes.push({ el: boxEl, region });
    }
  } else if (response.fallbackFullText) {
    const card = doc.createElement('div');
    card.className = 'mv-fallback-card';
    card.setAttribute('data-margin-fallback-card', 'true');
    card.textContent = response.fallbackFullText;
    root.appendChild(card);
  }

  shadowRoot.appendChild(root);
  doc.body.appendChild(host);

  const updatePosition = () => {
    const rect = targetImg.getBoundingClientRect();
    const win = doc.defaultView || window;
    const width = rect.width || targetImg.width || targetImg.naturalWidth || 320;
    const height = rect.height || targetImg.height || targetImg.naturalHeight || 240;

    host.style.top = `${Math.round(rect.top + (win.scrollY || 0))}px`;
    host.style.left = `${Math.round(rect.left + (win.scrollX || 0))}px`;
    host.style.width = `${Math.round(width)}px`;
    host.style.height = `${Math.round(height)}px`;

    for (const item of regionNodes) {
      const px = scaleVisionBoxToPixels(item.region.box, width, height);
      item.el.style.top = `${px.top}px`;
      item.el.style.left = `${px.left}px`;
      item.el.style.width = `${px.width}px`;
      item.el.style.height = `${px.height}px`;
    }
  };

  updatePosition();

  const win = doc.defaultView || window;
  const onViewportChange = () => updatePosition();
  win.addEventListener('resize', onViewportChange, { passive: true });
  win.addEventListener('scroll', onViewportChange, { passive: true });

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => updatePosition());
    resizeObserver.observe(targetImg);
  }

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    win.removeEventListener('resize', onViewportChange);
    win.removeEventListener('scroll', onViewportChange);
    resizeObserver?.disconnect();
    host.remove();
    onClose?.();
  };

  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    destroy();
  });

  return {
    host,
    shadowRoot,
    getMode: () => currentMode,
    setMode,
    updatePosition,
    destroy,
  };
}
