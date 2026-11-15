import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultMarginConfig } from '@shared/constants';
import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import { resetMemoryStorageForTests, saveMarginConfig } from '@shared/storage';
import type { TranslateImageResponse } from '@shared/types';
import {
  captureImageDataUrl,
  initMarginImageTranslator,
  mountVisionImageOverlay,
  scaleVisionBoxToPixels,
} from '../../src/media/image-entry';

function makeDiagnostic() {
  return {
    schemaVersion: 1 as const,
    product: 'Margin',
    version: '2.0.0',
    time: new Date().toISOString(),
    scene: 'image' as const,
    codec: 'json-batch' as const,
    provider: {
      id: 'openai-1',
      preset: 'openai' as const,
      protocol: 'openai-chat' as const,
      endpointOrigin: 'https://api.example.com',
      endpointPath: '/v1/chat/completions',
      model: 'gpt-6-luna',
    },
    parameters: {
      temperatureTrace: 'omitted-reasoning-guard' as const,
      thinkingMode: 'provider-default' as const,
      stream: false,
    },
    httpStatus: 200,
    kind: 'ok' as const,
    retryable: false,
    attempts: 1,
    latencyMs: 410,
  };
}

describe('Vision-LLM Image Overlay & 3-Tier Anti-403 Capture', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('scales normalized 0..1000 [ymin, xmin, ymax, xmax] coordinates accurately and repairs inverted/out-of-range boxes', () => {
    expect(scaleVisionBoxToPixels([100, 200, 350, 700], 800, 600)).toEqual({
      top: 60,
      left: 160,
      width: 400,
      height: 150,
    });

    // Out-of-bounds + inverted coordinates are clamped and repaired cleanly
    const repaired = scaleVisionBoxToPixels([900, 800, -50, 1200], 500, 400);
    expect(repaired.top).toBe(0);
    expect(repaired.left).toBe(400);
    expect(repaired.width).toBe(100);
    expect(repaired.height).toBe(360);
  });

  it('executes 3-Tier Anti-403 capture in strict order: Canvas -> Credentialed Fetch -> Background DNR', async () => {
    const fetchSpy = vi.fn();
    const dnrSpy = vi.fn();

    // Tier 1: Canvas succeeds with zero network calls
    const cleanImg = document.createElement('img');
    Object.defineProperty(cleanImg, 'complete', { value: true });
    Object.defineProperty(cleanImg, 'naturalWidth', { value: 600 });
    Object.defineProperty(cleanImg, 'naturalHeight', { value: 400 });
    cleanImg.src = 'https://cdn.example.com/comic-1.jpg';

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
    );

    const tier1 = await captureImageDataUrl({
      img: cleanImg,
      pageUrl: 'https://example.com/read',
      deps: { fetchImpl: fetchSpy, fetchViaBackgroundDnr: dnrSpy },
    });
    expect(tier1.tier).toBe('canvas');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dnrSpy).not.toHaveBeenCalled();

    // Tier 2: Canvas throws SecurityError (CORS taint) -> Credentialed Fetch succeeds
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
    });

    const sampleBlob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])], {
      type: 'image/webp',
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      blob: async () => sampleBlob,
    } as Response);

    const tier2 = await captureImageDataUrl({
      img: cleanImg,
      pageUrl: 'https://example.com/read',
      deps: { fetchImpl: fetchSpy, fetchViaBackgroundDnr: dnrSpy },
    });
    expect(tier2.tier).toBe('credentialed-fetch');
    expect(fetchSpy).toHaveBeenCalledWith('https://cdn.example.com/comic-1.jpg', {
      credentials: 'include',
    });
    expect(dnrSpy).not.toHaveBeenCalled();

    // Tier 3: Both Canvas and Credentialed Fetch fail (HTTP 403 hotlink) -> Background DNR succeeds
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 403,
    } as Response);
    dnrSpy.mockResolvedValueOnce({
      ok: true,
      dataUrl: 'data:image/webp;base64,RE5SRkFMTEJBQ0tEQVRBVVJMT0s=',
    });

    const tier3 = await captureImageDataUrl({
      img: cleanImg,
      pageUrl: 'https://pixiv.example.com/artworks/1',
      deps: { fetchImpl: fetchSpy, fetchViaBackgroundDnr: dnrSpy },
    });
    expect(tier3.tier).toBe('dnr-background');
    expect(dnrSpy).toHaveBeenCalledWith({
      imageUrl: 'https://cdn.example.com/comic-1.jpg',
      refererUrl: 'https://pixiv.example.com/artworks/1',
    });
  });

  it('mounts Shadow-isolated bbox overlay with Overlay/Compare/Close controls and fallbackFullText card', () => {
    const img = document.createElement('img');
    document.body.appendChild(img);
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      left: 20,
      width: 500,
      height: 800,
      right: 520,
      bottom: 840,
      x: 20,
      y: 40,
      toJSON: () => ({}),
    });

    const bboxResponse: TranslateImageResponse = {
      ok: true,
      requestId: 'req-1',
      providerId: 'openai-1',
      model: 'gpt-6-luna',
      regions: [
        {
          box: [100, 200, 300, 400],
          src: 'おはようございます',
          trans: '早上好',
          vertical: true,
        },
      ],
      diagnostic: makeDiagnostic(),
    };

    const controller = mountVisionImageOverlay({
      targetImg: img,
      response: bboxResponse,
      uiColorMode: 'night',
      interfaceLang: 'zh-CN',
    });

    expect(controller.host.getAttribute('data-display-mode')).toBe('night');
    const styleText = controller.shadowRoot.querySelector('style')?.textContent ?? '';
    expect(styleText).toContain('all: initial !important');
    expect(SHADOW_HOST_RESET_CSS).toContain('font-size: 16px !important');

    const regionEl = controller.shadowRoot.querySelector('.mv-region') as HTMLElement;
    expect(regionEl).not.toBeNull();
    expect(regionEl.getAttribute('data-vertical')).toBe('true');
    expect(regionEl.style.top).toBe('80px');
    expect(regionEl.style.left).toBe('100px');
    expect(regionEl.style.width).toBe('100px');
    expect(regionEl.style.height).toBe('160px');
    expect(regionEl.textContent).toContain('早上好');

    // Toggle to 对比原文 (compare mode)
    const compareBtn = controller.shadowRoot.querySelector(
      '[data-role="mode-compare"]',
    ) as HTMLButtonElement;
    compareBtn.click();
    expect(controller.getMode()).toBe('compare');
    expect(controller.shadowRoot.querySelector('.mv-root')?.getAttribute('data-mode')).toBe(
      'compare',
    );

    // Close removes host from DOM
    const closeBtn = controller.shadowRoot.querySelector(
      '[data-role="close"]',
    ) as HTMLButtonElement;
    closeBtn.click();
    expect(document.body.contains(controller.host)).toBe(false);

    // Fallback card when regions is empty and fallbackFullText is returned
    const fallbackController = mountVisionImageOverlay({
      targetImg: img,
      response: {
        ...bboxResponse,
        regions: [],
        fallbackFullText: '整图双语摘要译文：这是一页扫描版漫画。',
      },
      uiColorMode: 'paper',
      interfaceLang: 'zh-CN',
    });
    const fallbackCard = fallbackController.shadowRoot.querySelector(
      '[data-margin-fallback-card="true"]',
    );
    expect(fallbackCard?.textContent).toContain('整图双语摘要译文');
    fallbackController.destroy();
  });

  it('registers capturing passive scroll listener and auto-destroys overlay when targetImg disconnects', async () => {
    const addListenerSpy = vi.spyOn(window, 'addEventListener');
    const img = document.createElement('img');
    document.body.appendChild(img);
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
      top: 20,
      left: 10,
      width: 300,
      height: 200,
      right: 310,
      bottom: 220,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });

    const controller = mountVisionImageOverlay({
      targetImg: img,
      response: {
        ok: true,
        requestId: 'req-scroll',
        providerId: 'openai-1',
        model: 'gpt-6-luna',
        regions: [{ box: [100, 100, 300, 500], src: 'Hello', trans: '你好' }],
        diagnostic: makeDiagnostic(),
      },
      uiColorMode: 'paper',
      interfaceLang: 'zh-CN',
    });

    const scrollRegistration = addListenerSpy.mock.calls.find(
      (call) => call[0] === 'scroll',
    );
    expect(scrollRegistration).toBeDefined();
    expect(scrollRegistration?.[2]).toEqual({ capture: true, passive: true });
    expect(document.body.contains(controller.host)).toBe(true);

    // Removing targetImg from DOM automatically tears down the overlay host!
    img.remove();
    await new Promise((r) => setTimeout(r, 10));
    expect(document.body.contains(controller.host)).toBe(false);
  });

  it('blocks window CustomEvent and untrusted senders in production mode, guards concurrent/src-mutated runs, and tears down all overlays on destroyImageTranslator()', async () => {
    resetMemoryStorageForTests();
    await saveMarginConfig(createDefaultMarginConfig());

    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const runtimeMessageListeners = new Set<
      (msg: unknown, sender?: chrome.runtime.MessageSender) => void
    >();
    let imageRpcCalls = 0;
    let holdFirstRpc: (() => void) | null = null;

    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        id: 'ext-trusted-id',
        onMessage: {
          addListener: (
            fn: (msg: unknown, sender?: chrome.runtime.MessageSender) => void,
          ) => runtimeMessageListeners.add(fn),
          removeListener: (
            fn: (msg: unknown, sender?: chrome.runtime.MessageSender) => void,
          ) => runtimeMessageListeners.delete(fn),
        },
        sendMessage: vi.fn(async (msg: { type: string }) => {
          if (msg.type === 'margin:translate-image') {
            imageRpcCalls += 1;
            if (holdFirstRpc) {
              const waitPromise = new Promise<void>((resolve) => {
                const prev = holdFirstRpc!;
                holdFirstRpc = () => {
                  prev();
                  resolve();
                };
              });
              await waitPromise;
            }
            return {
              ok: true,
              requestId: `img-res-${imageRpcCalls}`,
              providerId: 'openai-1',
              model: 'gpt-6-luna',
              regions: [
                {
                  box: [100, 100, 300, 500],
                  src: 'Panel',
                  trans: `译文 #${imageRpcCalls}`,
                },
              ],
              diagnostic: makeDiagnostic(),
            };
          }
          return { ok: true };
        }),
      },
    };

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
    );

    const img = document.createElement('img');
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'naturalWidth', { value: 400 });
    Object.defineProperty(img, 'naturalHeight', { value: 300 });
    img.src = 'https://cdn.example.com/manga-page-1.jpg';
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
      top: 30,
      left: 30,
      width: 400,
      height: 300,
      right: 430,
      bottom: 330,
      x: 30,
      y: 30,
      toJSON: () => ({}),
    });
    document.body.appendChild(img);

    let destroyFn: (() => void) | null = null;
    try {
      destroyFn = initMarginImageTranslator({ forceProductionMode: true });

      // 1. Page-dispatched window CustomEvent MUST be ignored in production mode!
      window.dispatchEvent(
        new CustomEvent('margin:cmd:translate-context-image', {
          detail: { srcUrl: img.src },
        }),
      );
      await new Promise((r) => setTimeout(r, 15));
      expect(imageRpcCalls).toBe(0);

      // 2. Runtime message from untrusted/missing sender.id MUST be rejected in production mode!
      for (const fn of runtimeMessageListeners) {
        fn(
          { type: 'margin:cmd:translate-context-image', srcUrl: img.src },
          { id: 'foreign-extension-id' } as chrome.runtime.MessageSender,
        );
      }
      await new Promise((r) => setTimeout(r, 15));
      expect(imageRpcCalls).toBe(0);

      // 3. Overlapping trusted commands on the same <img> never mount duplicate overlays
      holdFirstRpc = () => {};
      for (const fn of runtimeMessageListeners) {
        fn(
          { type: 'margin:cmd:translate-context-image', srcUrl: img.src },
          { id: 'ext-trusted-id' } as chrome.runtime.MessageSender,
        );
      }
      await new Promise((r) => setTimeout(r, 10));

      const releaseFirst = holdFirstRpc;
      holdFirstRpc = null;
      // Trigger second run on same image before first finishes
      for (const fn of runtimeMessageListeners) {
        fn(
          { type: 'margin:cmd:translate-context-image', srcUrl: img.src },
          { id: 'ext-trusted-id' } as chrome.runtime.MessageSender,
        );
      }
      releaseFirst?.();
      await new Promise((r) => setTimeout(r, 25));

      const mountedOverlays = document.querySelectorAll(
        '[data-margin-injected="image-overlay"]',
      );
      expect(mountedOverlays).toHaveLength(1);

      // 4. destroyImageTranslator() enumerates activeOverlays Map and removes all mounted overlays!
      destroyFn();
      destroyFn = null;
      expect(
        document.querySelectorAll('[data-margin-injected="image-overlay"]'),
      ).toHaveLength(0);
    } finally {
      destroyFn?.();
      (globalThis as Record<string, unknown>).chrome = origChrome;
    }
  });
});
