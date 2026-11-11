import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultMarginConfig } from '@shared/constants';
import {
  resetMemoryStorageForTests,
  saveMarginConfig,
} from '@shared/storage';
import type {
  DiagnosticSnapshot,
  TranslateBatchRequest,
  TranslateBatchResponse,
} from '@shared/types';
import { HoverTranslator } from '../../src/content/hover-translate';
import { MarginContentController } from '../../src/content/index';
import {
  LruTranslationCache,
  WEBPAGE_INJECTED_CSS,
  WebpageRenderer,
  packIntoBatches,
} from '../../src/content/renderer';

function makeMockDiagnostic(): DiagnosticSnapshot {
  return {
    schemaVersion: 1,
    product: 'Margin',
    version: '2.0.0',
    time: new Date().toISOString(),
    scene: 'webpage',
    codec: 'yaml',
    provider: {
      id: 'google-free',
      preset: 'google-free',
      protocol: 'google-web',
      endpointOrigin: 'https://translate.googleapis.com',
      endpointPath: '/translate_a/single',
      model: 'gtx',
    },
    parameters: {
      temperatureTrace: 'omitted-default',
      thinkingMode: 'provider-default',
      stream: false,
    },
    httpStatus: 200,
    kind: 'ok',
    retryable: false,
    attempts: 1,
    latencyMs: 42,
  };
}

describe('renderer & content orchestrator: themes, reversible target-only, retry, LRU & URL exclusion', () => {
  beforeEach(() => {
    resetMemoryStorageForTests();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-margin-mask-revealed');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders rich clickable links in both bilingual and target-only modes and restores exact original DOM nodes on toggle', async () => {
    const config = createDefaultMarginConfig();
    config.webpage.displayMode = 'target-only';
    config.webpage.theme = 'mask';

    const p = document.createElement('p');
    p.innerHTML =
      'Explore <a href="https://margin.dev/spec" target="_blank">the specification</a> today.';
    document.body.appendChild(p);
    const originalLinkInstance = p.querySelector('a')!;

    let transportCalls = 0;
    const renderer = new WebpageRenderer({
      config,
      getUrl: () => 'https://news.ycombinator.com/item?id=100',
      transport: async (req: TranslateBatchRequest): Promise<TranslateBatchResponse> => {
        transportCalls += 1;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: '立即浏览<m0>技术规范</m0>。',
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    await renderer.translateWholePage();
    expect(transportCalls).toBe(1);

    // Target-only mode wraps original nodes cleanly in a hidden reversible wrapper
    const origWrapper = p.querySelector('[data-margin-orig-wrap="true"]') as HTMLElement;
    expect(origWrapper).not.toBeNull();
    expect(origWrapper.hidden).toBe(true);
    expect(origWrapper.contains(originalLinkInstance)).toBe(true);

    const transSpan = p.querySelector(
      '.margin-trans-root[data-margin-injected="true"]',
    ) as HTMLElement;
    expect(transSpan).not.toBeNull();
    expect(transSpan.getAttribute('data-margin-theme')).toBe('mask');
    expect(transSpan.getAttribute('data-margin-layout')).toBe('replace');
    expect(WEBPAGE_INJECTED_CSS).toContain('filter: blur(5px)');

    // Rich clickable link is preserved in target-only mode too!
    const transLink = transSpan.querySelector('a')!;
    expect(transLink).not.toBeNull();
    expect(transLink.getAttribute('href')).toBe('https://margin.dev/spec');
    expect(transLink.textContent).toBe('技术规范');

    // Global Alt+M toggle reveals and re-masks blur
    expect(renderer.toggleGlobalMask()).toBe(true);
    expect(document.documentElement.getAttribute('data-margin-mask-revealed')).toBe('true');
    expect(renderer.toggleGlobalMask()).toBe(false);
    expect(document.documentElement.hasAttribute('data-margin-mask-revealed')).toBe(false);

    // Live switch from target-only -> bilingual unwraps original nodes with ZERO extra API calls
    const bilingualCfg = structuredClone(config);
    bilingualCfg.webpage.displayMode = 'bilingual';
    bilingualCfg.webpage.theme = 'opacity';
    renderer.updateConfig(bilingualCfg);
    expect(transportCalls).toBe(1);
    expect(p.querySelector('[data-margin-orig-wrap="true"]')).toBeNull();
    expect(p.querySelector('a')).toBe(originalLinkInstance);
    expect(transSpan.getAttribute('data-margin-theme')).toBe('opacity');
    expect(transSpan.getAttribute('data-margin-layout')).toBe('inline');

    // Restore page completely: exact original DOM node reference remains intact
    renderer.restorePage();
    expect(p.querySelector('[data-margin-injected="true"]')).toBeNull();
    expect(p.querySelector('[data-margin-orig-wrap="true"]')).toBeNull();
    expect(p.querySelector('a')).toBe(originalLinkInstance);
    expect(p.textContent).toBe('Explore the specification today.');

    renderer.destroy();
  });

  it('applies lineBreakMaxTextCount (<= 280 inline vs > 280 block) and URL themePatterns', async () => {
    const config = createDefaultMarginConfig();
    config.webpage.theme = 'mask';
    config.webpage.themePatterns = [{ pattern: 'https://arxiv.org/*', theme: 'weakening' }];
    config.webpage.lineBreakMaxTextCount = 280;

    const shortP = document.createElement('p');
    shortP.textContent = 'Short concise sentence.';
    const longP = document.createElement('p');
    longP.textContent = 'Long analytical paragraph. '.repeat(14); // > 280 chars
    document.body.append(shortP, longP);

    const renderer = new WebpageRenderer({
      config,
      getUrl: () => 'https://arxiv.org/abs/2502.12345',
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: req.items.map((it) => ({ id: it.id, trans: `译文 ${it.id}` })),
        diagnostic: makeMockDiagnostic(),
      }),
    });

    await renderer.translateWholePage();

    const shortSpan = shortP.querySelector('.margin-trans-root')!;
    const longSpan = longP.querySelector('.margin-trans-root')!;

    expect(shortSpan.getAttribute('data-margin-theme')).toBe('weakening');
    expect(shortSpan.getAttribute('data-margin-layout')).toBe('inline');
    expect(longSpan.getAttribute('data-margin-layout')).toBe('block');

    renderer.destroy();
  });

  it('renders an inline retry button (↻) on failed batches without wiping succeeded batches, and retries ONLY the failed batch', async () => {
    const config = createDefaultMarginConfig();
    config.providers['google-free'].maxBatchCount = 1; // Force 2 separate batches

    const p1 = document.createElement('p');
    p1.textContent = 'First batch paragraph succeeds immediately.';
    const p2 = document.createElement('p');
    p2.textContent = 'Second batch paragraph encounters transient 503.';
    document.body.append(p1, p2);

    let batch2Attempts = 0;
    const requestedTexts: string[][] = [];

    const renderer = new WebpageRenderer({
      config,
      transport: async (req) => {
        requestedTexts.push(req.items.map((i) => i.text));
        const firstText = req.items[0]?.text ?? '';
        if (firstText.includes('Second batch')) {
          batch2Attempts += 1;
          if (batch2Attempts === 1) {
            return {
              ok: false,
              requestId: req.requestId,
              providerId: 'google-free',
              model: 'gtx',
              items: [],
              diagnostic: makeMockDiagnostic(),
              error: {
                code: 'UPSTREAM_503',
                message: 'Service temporarily overloaded',
                retryable: true,
              },
            };
          }
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `已翻译：${it.text}`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    await renderer.translateWholePage();

    // Batch 1 succeeded and remains rendered
    expect(p1.querySelector('.margin-trans-root')?.textContent).toContain(
      '已翻译：First batch',
    );
    // Batch 2 failed -> quiet inline ↻ button, zero center-screen modal
    const retryBtn = p2.querySelector(
      'button.margin-inline-retry',
    ) as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.textContent).toBe('↻');

    // Click ↻ -> retries ONLY batch 2!
    retryBtn.click();
    await vi.waitFor(() => {
      expect(p2.querySelector('.margin-trans-root')?.textContent).toContain(
        '已翻译：Second batch',
      );
    });
    expect(p2.querySelector('button.margin-inline-retry')).toBeNull();
    expect(requestedTexts).toHaveLength(3);
    expect(requestedTexts[2]).toEqual([
      'Second batch paragraph encounters transient 503.',
    ]);

    renderer.destroy();
  });

  it('packs batches within maxBatchCount/maxCharsPerBatch and re-attaches virtual-scroll nodes from 2000-entry LRU cache with 0 API calls', async () => {
    const packed = packIntoBatches(
      [
        { id: 1, charCount: 40 },
        { id: 2, charCount: 45 },
        { id: 3, charCount: 50 },
      ],
      5,
      90,
    );
    expect(packed).toHaveLength(2);
    expect(packed[0]?.map((x) => x.id)).toEqual([1, 2]);
    expect(packed[1]?.map((x) => x.id)).toEqual([3]);

    const cache = new LruTranslationCache(2);
    cache.set('a', { trans: 'A' });
    cache.set('b', { trans: 'B' });
    expect(cache.get('a')?.trans).toBe('A'); // refreshes 'a'
    cache.set('c', { trans: 'C' }); // evicts 'b'
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.trans).toBe('A');

    const config = createDefaultMarginConfig();
    let apiCalls = 0;
    const renderer = new WebpageRenderer({
      config,
      transport: async (req) => {
        apiCalls += 1;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: '缓存复用译文 <m0>链接</m0>',
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    const pOriginal = document.createElement('p');
    pOriginal.innerHTML = 'Virtual scroll post with <a href="https://x.com/1">link</a>';
    document.body.appendChild(pOriginal);

    await renderer.translateBlocks([pOriginal], 'webpage');
    expect(apiCalls).toBe(1);

    // Simulate Discourse/X virtual scroll destroying DOM node and mounting a brand-new element with identical prose
    pOriginal.remove();
    const pRecycled = document.createElement('p');
    pRecycled.innerHTML = 'Virtual scroll post with <a href="https://x.com/1">link</a>';
    document.body.appendChild(pRecycled);

    await renderer.translateBlocks([pRecycled], 'webpage');
    expect(apiCalls).toBe(1); // Zero additional API call!
    expect(
      pRecycled.querySelector('.margin-trans-root a')?.getAttribute('href'),
    ).toBe('https://x.com/1');

    renderer.destroy();
  });

  it('enforces URL exclusion (https://linux.do/t/topic/123) in MarginContentController and supports Modifier+Hover single-paragraph toggle', async () => {
    vi.useFakeTimers();
    const config = createDefaultMarginConfig();
    config.webpage.autoTranslateMatches = true;
    config.urlRules.includeMatches = ['<all_urls>'];
    config.urlRules.excludeMatches = ['https://linux.do/*'];
    config.hover.enabled = true;
    config.hover.modifierKey = 'ctrl';
    config.hover.delayMs = 180;

    const p = document.createElement('p');
    p.textContent = 'Linux.do community discussion post.';
    document.body.appendChild(p);

    let apiCalls = 0;
    const controller = new MarginContentController({
      config,
      getUrl: () => 'https://linux.do/t/topic/123',
      transport: async (req) => {
        apiCalls += 1;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({ id: it.id, trans: '悬停单段翻译' })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    controller.mount();

    // Auto-translation MUST be blocked on https://linux.do/t/topic/123
    expect(controller.isCurrentUrlExcluded()).toBe(true);
    expect(controller.shouldAutoTranslateCurrentUrl()).toBe(false);
    expect(controller.renderer.isActive).toBe(false);
    expect(apiCalls).toBe(0);

    // Modifier + Hover (Ctrl + 180ms dwell) translates ONLY that hovered paragraph
    const hover = new HoverTranslator({
      config,
      renderer: controller.renderer,
      doc: document,
    });
    hover.mount();

    p.dispatchEvent(
      new MouseEvent('mouseover', {
        bubbles: true,
        ctrlKey: true,
      }),
    );

    vi.advanceTimersByTime(170);
    expect(apiCalls).toBe(0);

    vi.advanceTimersByTime(20);
    await vi.runAllTimersAsync();
    expect(apiCalls).toBe(1);
    expect(p.querySelector('.margin-trans-root')?.textContent).toBe('悬停单段翻译');

    hover.destroy();
    controller.destroy();
  });

  it('streams progressive batch items onto the DOM via onItemReady before the batch settles and reacts to TabCommandMessages & onMarginConfigChanged', async () => {
    const config = createDefaultMarginConfig();
    config.providers['google-free'].stream = 'on';

    const p1 = document.createElement('p');
    p1.textContent = 'First streaming paragraph.';
    const p2 = document.createElement('p');
    p2.textContent = 'Second streaming paragraph.';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = '快速翻译输入框指令';
    document.body.append(p1, p2, input);

    let finishSecondItem!: () => void;
    const secondItemBarrier = new Promise<void>((resolve) => {
      finishSecondItem = resolve;
    });

    const controller = new MarginContentController({
      config,
      getUrl: () => 'https://example.org/post/42',
      transport: async (req, callbacks) => {
        if (req.scene === 'input') {
          return {
            ok: true,
            requestId: req.requestId,
            providerId: 'google-free',
            model: 'gtx',
            items: [{ id: 1, trans: 'Quick input command translated' }],
            diagnostic: makeMockDiagnostic(),
          };
        }

        // Emit item 1 progressively BEFORE batch completes!
        callbacks.onItemReady?.({ id: 1, trans: '第一段流式先出' });
        await secondItemBarrier;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: [
            { id: 1, trans: '第一段流式先出' },
            { id: 2, trans: '第二段随后完成' },
          ],
          diagnostic: makeMockDiagnostic(),
        };
      },
    });
    controller.mount();

    const wholePagePromise = controller.handleCommand({
      type: 'margin:cmd:translate-whole-page',
    });

    // Item 1 is ALREADY painted on DOM before secondItemBarrier resolves!
    await vi.waitFor(() => {
      expect(p1.querySelector('.margin-trans-root')?.textContent).toBe(
        '第一段流式先出',
      );
    });
    expect(p2.querySelector('.margin-trans-root')).toBeNull();

    finishSecondItem();
    await wholePagePromise;
    expect(p2.querySelector('.margin-trans-root')?.textContent).toBe(
      '第二段随后完成',
    );

    // Reactive storage config update changes live theme to `mask`
    const updatedCfg = structuredClone(config);
    updatedCfg.webpage.theme = 'mask';
    await saveMarginConfig(updatedCfg);
    expect(
      p1.querySelector('.margin-trans-root')?.getAttribute('data-margin-theme'),
    ).toBe('mask');

    // TabCommandMessages: toggle-mask, translate-input, toggle-page (OFF)
    expect(
      await controller.handleCommand({ type: 'margin:cmd:toggle-mask' }),
    ).toBe(true);
    expect(
      document.documentElement.getAttribute('data-margin-mask-revealed'),
    ).toBe('true');

    input.focus();
    expect(
      await controller.handleCommand({ type: 'margin:cmd:translate-input' }),
    ).toBe(true);
    expect(input.value).toBe('Quick input command translated');

    expect(
      await controller.handleCommand({ type: 'margin:cmd:toggle-page' }),
    ).toBe(false);
    expect(p1.querySelector('.margin-trans-root')).toBeNull();

    controller.destroy();
  });
});
