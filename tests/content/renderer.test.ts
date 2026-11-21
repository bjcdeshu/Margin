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
import {
  MarginContentController,
  bootstrapMarginContentScript,
} from '../../src/content/index';
import {
  LruTranslationCache,
  VIEWPORT_ROOT_MARGIN,
  WEBPAGE_INJECTED_CSS,
  WebpageRenderer,
  isRedundantIdenticalTranslation,
  packIntoBatches,
  packIntoProgressiveBatches,
  stripPartialInlineMarkers,
} from '../../src/content/renderer';
import { SelectionPopover } from '../../src/content/selection-popover';
import { initMarginImageTranslator } from '../../src/media/image-entry';
import { createSubtitleIsolatedController } from '../../src/youtube/isolated-entry';

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
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dark');
    document.documentElement.removeAttribute('style');
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
    expect(transSpan.getAttribute('data-margin-layout')).toBe('block');

    // Restore page completely: exact original DOM node reference remains intact
    renderer.restorePage();
    expect(p.querySelector('[data-margin-injected="true"]')).toBeNull();
    expect(p.querySelector('[data-margin-orig-wrap="true"]')).toBeNull();
    expect(p.querySelector('a')).toBe(originalLinkInstance);
    expect(p.textContent).toBe('Explore the specification today.');

    renderer.destroy();
  });

  it('uses separated block layout for prose/tweets, inline layout only for short compact table/term cells, and URL themePatterns', async () => {
    const config = createDefaultMarginConfig();
    config.webpage.theme = 'mask';
    config.webpage.themePatterns = [{ pattern: 'https://arxiv.org/*', theme: 'weakening' }];

    const shortP = document.createElement('p');
    shortP.textContent = 'Short concise sentence.';
    const longP = document.createElement('p');
    longP.textContent = 'Long analytical paragraph. '.repeat(14);
    const table = document.createElement('table');
    table.innerHTML = '<tr><th id="th-short">Latency</th></tr>';
    document.body.append(shortP, longP, table);
    const shortTh = document.getElementById('th-short')!;

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
    const thSpan = shortTh.querySelector('.margin-trans-root')!;

    expect(shortSpan.getAttribute('data-margin-theme')).toBe('weakening');
    expect(shortSpan.getAttribute('data-margin-layout')).toBe('block');
    expect(longSpan.getAttribute('data-margin-layout')).toBe('block');
    expect(thSpan.getAttribute('data-margin-layout')).toBe('inline');
    expect(WEBPAGE_INJECTED_CSS).toContain('white-space: pre-line;');

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

  it('packs progressive micro-batches ([3, 5, 10]), shows per-block loading spinner & status pill, overwrites partial stream items on final decode, re-translates on targetLang change, and deduplicates 280ms cold-SW Alt+A', async () => {
    // 1. Progressive micro-batching check
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      charCount: 80,
    }));
    const progressive = packIntoProgressiveBatches(items, 10, 3200);
    expect(progressive.map((b) => b.length)).toEqual([3, 5, 10, 2]);

    // 2. Loading spinner + fuller final overwrite + toggle ON->OFF->ON + live targetLang switch
    const config = createDefaultMarginConfig();
    config.webpage.autoTranslateMode = 'whitelist';
    config.providers['google-free'].stream = 'on';

    const p = document.createElement('p');
    p.textContent = 'Multi-paragraph announcement.\n\nSecond paragraph details.';
    document.body.appendChild(p);

    let releaseBatch!: () => void;
    let barrier = new Promise<void>((r) => {
      releaseBatch = r;
    });
    const seenRequests: TranslateBatchRequest[] = [];

    let fakeNow = 5000;
    const controller = new MarginContentController({
      config,
      now: () => fakeNow,
      getUrl: () => 'https://x.com/ubuntu/status/999',
      transport: async (req, callbacks) => {
        seenRequests.push(req);
        if (req.toLang === 'ja') {
          return {
            ok: true,
            requestId: req.requestId,
            providerId: 'google-free',
            model: 'gtx',
            items: req.items.map((it) => ({ id: it.id, trans: '日本語の翻訳結果' })),
            diagnostic: makeMockDiagnostic(),
          };
        }
        callbacks.onItemReady?.({ id: 1, trans: '第一段局部流式译文' });
        await barrier;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: [
            { id: 1, trans: '第一段局部流式译文\n\n第二段完整收敛译文' },
          ],
          diagnostic: makeMockDiagnostic(),
        };
      },
    });
    controller.mount();

    // Key trigger at t=5000ms, followed by cold-SW Chrome command at t=5280ms (+280ms <= 1200ms) -> MUST NOT undo!
    const firstTogglePromise = controller.handleCommand(
      { type: 'margin:cmd:toggle-page' },
      'key',
    );
    expect(await firstTogglePromise).toBe(true);
    expect(controller.renderer.isActive).toBe(true);

    fakeNow += 280;
    expect(
      await controller.handleCommand({ type: 'margin:cmd:toggle-page' }, 'cmd'),
    ).toBe(false);
    expect(controller.renderer.isActive).toBe(true);

    // Immediate first-viewport queueing starts translating without waiting for IntersectionObserver!
    await vi.waitFor(() => {
      expect(p.querySelector('.margin-trans-root')?.textContent).toBe(
        '第一段局部流式译文',
      );
    });
    expect(seenRequests[0]?.context?.domain).toBe('x.com');

    // Final batch response has fuller multi-paragraph translation -> overwrites partial stream text!
    releaseBatch();
    await vi.waitFor(() => {
      expect(p.querySelector('.margin-trans-root')?.textContent).toBe(
        '第一段局部流式译文\n\n第二段完整收敛译文',
      );
    });

    // Toggle OFF -> ON re-translates cleanly (observedBlocks reset on restorePage)
    fakeNow += 2000;
    await controller.handleCommand({ type: 'margin:cmd:toggle-page' }, 'cmd');
    expect(controller.renderer.isActive).toBe(false);
    expect(p.querySelector('.margin-trans-root')).toBeNull();

    barrier = Promise.resolve();
    await controller.handleCommand({ type: 'margin:cmd:toggle-page' }, 'cmd');
    await vi.waitFor(() => {
      expect(p.querySelector('.margin-trans-root')?.textContent).toContain(
        '第二段完整收敛译文',
      );
    });

    // Live targetLang change ('zh-CN' -> 'ja') automatically re-translates active page!
    const jaCfg = structuredClone(config);
    jaCfg.targetLang = 'ja';
    await saveMarginConfig(jaCfg);
    await vi.waitFor(() => {
      expect(p.querySelector('.margin-trans-root')?.textContent).toBe(
        '日本語の翻訳結果',
      );
    });

    // Adding domain to excludeMatches immediately restores active page!
    const excludedCfg = structuredClone(jaCfg);
    excludedCfg.urlRules.excludeMatches = ['https://x.com/*'];
    await saveMarginConfig(excludedCfg);
    expect(controller.renderer.isActive).toBe(false);
    expect(p.querySelector('.margin-trans-root')).toBeNull();

    controller.destroy();
  });

  it('reversibly unclamps -webkit-line-clamp & tight max-height ancestors, suppresses identical bilingual translations (NFL -> NFL) without stuck spinners, and restores DOM bit-for-bit', async () => {
    expect(isRedundantIdenticalTranslation('NFL', 'NFL')).toBe(true);
    expect(isRedundantIdenticalTranslation('nfl', '“NFL.”')).toBe(true);
    expect(
      isRedundantIdenticalTranslation('<m0>옹발이 ONGBAL</m0>', '<m0>옹발이 ONGBAL</m0>'),
    ).toBe(true);
    expect(isRedundantIdenticalTranslation('Commanders', '指挥官队')).toBe(false);

    const config = createDefaultMarginConfig();
    config.webpage.displayMode = 'bilingual';

    document.body.innerHTML = `
      <main id="content-root">
        <div id="yt-title-wrap" style="max-height: 5.6rem; overflow: hidden;">
          <h1 id="yt-h1" style="max-height: 5.6rem; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;">
            <yt-formatted-string>Yubi, No. 21 Swordfighter Puppet No Damage Hellwalker – Phantom Blade Zero</yt-formatted-string>
          </h1>
        </div>
        <div id="x-news-card">
          <div id="x-news-headline" style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">Comma in Passwords Tip Circulates as CSV Leak Defense...</div>
        </div>
        <div id="scroll-panel" style="max-height: 120px; overflow-y: auto;">
          <p id="inside-scroll">Scrollable container must keep overflow-y: auto untouched.</p>
        </div>
        <h2 id="nfl-header" style="max-height: 32px; overflow: hidden;">NFL</h2>
      </main>
    `;

    const contentRoot = document.getElementById('content-root')!;
    const preContentOuterHtml = contentRoot.outerHTML;
    const preBodyHtml = document.body.innerHTML;
    const ytWrap = document.getElementById('yt-title-wrap')!;
    const ytH1 = document.getElementById('yt-h1')!;
    const xHeadline = document.getElementById('x-news-headline')!;
    const scrollPanel = document.getElementById('scroll-panel')!;
    const nflHeader = document.getElementById('nfl-header')!;

    let apiCalls = 0;
    const renderer = new WebpageRenderer({
      config,
      getUrl: () => 'https://x.com/home',
      transport: async (req) => {
        apiCalls += 1;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => {
            if (it.text.trim() === 'NFL') {
              return { id: it.id, trans: 'NFL' };
            }
            if (it.text.includes('Yubi')) {
              return {
                id: it.id,
                trans: 'Yubi：21号剑士傀儡无伤通关地狱行者难度 – 《影之刃零》',
              };
            }
            return { id: it.id, trans: `中文译文：${it.text}` };
          }),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    await renderer.translateWholePage();
    expect(apiCalls).toBeGreaterThan(0);

    // 1. YouTube H1 and its tight max-height parent wrapper are unclamped
    expect(ytH1.getAttribute('data-margin-unclamped')).toBe('true');
    expect(ytWrap.getAttribute('data-margin-unclamped')).toBe('true');
    expect(ytH1.style.getPropertyValue('max-height')).toBe('none');
    expect(ytH1.style.getPropertyPriority('max-height')).toBe('important');
    expect(ytH1.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
    expect(ytH1.style.getPropertyValue('display')).toBe('block');
    expect(ytH1.style.getPropertyValue('overflow')).toBe('visible');
    expect(ytH1.querySelector('.margin-trans-root')?.textContent).toContain(
      '21号剑士傀儡',
    );

    // 2. X Today's News -webkit-line-clamp: 2 headline is unclamped
    expect(xHeadline.getAttribute('data-margin-unclamped')).toBe('true');
    expect(xHeadline.style.getPropertyValue('display')).toBe('block');
    expect(xHeadline.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
    expect(xHeadline.querySelector('.margin-trans-root')?.textContent).toContain(
      '中文译文：Comma in Passwords',
    );

    // 3. Scrollable container (overflow-y: auto) is NEVER altered
    expect(scrollPanel.hasAttribute('data-margin-unclamped')).toBe(false);
    expect(scrollPanel.style.overflowY).toBe('auto');

    // 4. Identical translation (NFL -> NFL) is suppressed with ZERO stuck spinner and its temporary loading unclamp restored!
    expect(nflHeader.querySelector('.margin-trans-root')).toBeNull();
    expect(nflHeader.querySelector('.margin-trans-loading')).toBeNull();
    expect(nflHeader.hasAttribute('data-margin-translated')).toBe(false);
    expect(nflHeader.hasAttribute('data-margin-unclamped')).toBe(false);
    expect(nflHeader.getAttribute('style')).toBe('max-height: 32px; overflow: hidden;');

    // 5. restorePage() restores the entire content DOM 100% bit-for-bit!
    renderer.restorePage();
    expect(document.querySelectorAll('[data-margin-unclamped]').length).toBe(0);
    expect(document.body.querySelectorAll('[data-margin-injected]').length).toBe(0);
    expect(contentRoot.outerHTML).toBe(preContentOuterHtml);

    renderer.destroy();
    expect(document.body.innerHTML).toBe(preBodyHtml);
  });

  it('discovers ancestor <h1.ytd-watch-metadata> when <yt-formatted-string> hydrates from is-empty, replaces stale Video 1 -> Video 2 singleton <h1> translations across characterData & childList, and handles yt-navigate-finish', async () => {
    const config = createDefaultMarginConfig();
    config.webpage.displayMode = 'bilingual';

    document.body.innerHTML = `
      <ytd-watch-metadata>
        <div id="above-the-fold">
          <div id="title">
            <h1 id="yt-watch-h1" class="style-scope ytd-watch-metadata" style="max-height: 5.6rem; overflow: hidden; display: flow-root; -webkit-line-clamp: 2;">
              <yt-formatted-string id="yt-watch-fmt" force-default-style="" class="style-scope ytd-watch-metadata" is-empty="" style="display: none;"></yt-formatted-string>
            </h1>
          </div>
        </div>
      </ytd-watch-metadata>
    `;

    const ytH1 = document.getElementById('yt-watch-h1')!;
    const ytFmt = document.getElementById('yt-watch-fmt')!;
    let currentUrl = 'https://www.youtube.com/watch?v=AOJwkm3yixU';
    const seenTexts: string[] = [];

    const controller = new MarginContentController({
      config,
      getUrl: () => currentUrl,
      transport: async (req) => {
        for (const it of req.items) {
          seenTexts.push(it.text);
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => {
            if (it.text.includes('Yubi')) {
              return { id: it.id, trans: '译文V1：Yubi 21号剑士傀儡无伤' };
            }
            if (it.text.includes('Shadow of the Erdtree')) {
              return { id: it.id, trans: '译文V2：黄金树幽影无伤攻略' };
            }
            if (it.text.includes('Sekiro')) {
              return { id: it.id, trans: '译文V3：只狼心中的一心无伤' };
            }
            return { id: it.id, trans: `译文：${it.text}` };
          }),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });
    controller.mount();

    // 1. Page translation enabled BEFORE Polymer hydrates Watch H1 (is-empty="", empty text)
    await controller.handleCommand({ type: 'margin:cmd:toggle-page' }, 'cmd');
    expect(controller.renderer.isPageTranslationActive()).toBe(true);
    expect(ytH1.querySelector('.margin-trans-root')).toBeNull();

    // 2. Polymer hydrates Video 1 title inside <yt-formatted-string> and removes `is-empty`
    ytFmt.removeAttribute('is-empty');
    ytFmt.style.display = '';
    const v1TextNode = document.createTextNode(
      'Yubi, No. 21 Swordfighter Puppet No Damage – Phantom Blade Zero',
    );
    ytFmt.appendChild(v1TextNode);

    await vi.waitFor(() => {
      expect(ytH1.querySelector('.margin-trans-root')?.textContent).toBe(
        '译文V1：Yubi 21号剑士傀儡无伤',
      );
    });
    // Mounted directly on <h1> outside <yt-formatted-string>, and max-height 5.6rem unclamped!
    expect(ytFmt.querySelector('.margin-trans-root')).toBeNull();
    expect(ytH1.getAttribute('data-margin-unclamped')).toBe('true');
    expect(ytH1.style.getPropertyValue('max-height')).toBe('none');

    // 3. SPA Video 1 -> Video 2 via characterData mutation on singleton <h1>'s #text node
    currentUrl = 'https://www.youtube.com/watch?v=video2';
    v1TextNode.data = 'Elden Ring Shadow of the Erdtree Boss Guide';

    await vi.waitFor(() => {
      expect(ytH1.querySelector('.margin-trans-root')?.textContent).toBe(
        '译文V2：黄金树幽影无伤攻略',
      );
    });
    expect(ytH1.querySelectorAll('.margin-trans-root')).toHaveLength(1);

    // 4. SPA Video 2 -> Video 3 via childList #text replacement inside <yt-formatted-string>
    currentUrl = 'https://www.youtube.com/watch?v=video3';
    ytFmt.replaceChildren(
      document.createTextNode('Sekiro Inner Isshin No Hit'),
    );

    await vi.waitFor(() => {
      expect(ytH1.querySelector('.margin-trans-root')?.textContent).toBe(
        '译文V3：只狼心中的一心无伤',
      );
    });
    expect(ytH1.querySelectorAll('.margin-trans-root')).toHaveLength(1);

    // 5. If Polymer externally wipes `.margin-trans-root` and fires `yt-navigate-finish`, singleton <h1> is NOT locked out by observedBlocks
    controller.renderer.clearCache();
    ytH1.querySelector('.margin-trans-root')?.remove();
    expect(ytH1.querySelector('.margin-trans-root')).toBeNull();

    document.dispatchEvent(new Event('yt-navigate-finish', { bubbles: true }));
    await vi.waitFor(() => {
      expect(ytH1.querySelector('.margin-trans-root')?.textContent).toBe(
        '译文V3：只狼心中的一心无伤',
      );
    });
    expect(seenTexts.length).toBeGreaterThanOrEqual(4);

    controller.destroy();
  });

  it('translates late-hydrated X.com tweetText <span> children and refreshes recycled virtual-scroll cells in place', async () => {
    const config = createDefaultMarginConfig();

    document.body.innerHTML = `
      <section>
        <div data-testid="cellInnerDiv">
          <article>
            <div id="tweet-late" data-testid="tweetText"></div>
          </article>
        </div>
        <div data-testid="cellInnerDiv">
          <article>
            <div id="tweet-recycled" data-testid="tweetText">
              <span id="recycled-span">Initial virtualized timeline post</span>
            </div>
          </article>
        </div>
      </section>
    `;

    const lateTweet = document.getElementById('tweet-late')!;
    const recycledTweet = document.getElementById('tweet-recycled')!;
    const recycledSpan = document.getElementById('recycled-span')!;

    const renderer = new WebpageRenderer({
      config,
      getUrl: () => 'https://x.com/home',
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: req.items.map((it) => ({
          id: it.id,
          trans: `推文译文：${it.text}`,
        })),
        diagnostic: makeMockDiagnostic(),
      }),
    });

    renderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(recycledTweet.querySelector('.margin-trans-root')?.textContent).toBe(
        '推文译文：Initial virtualized timeline post',
      );
    });
    expect(lateTweet.querySelector('.margin-trans-root')).toBeNull();

    // React hydrates <span> inside empty #tweet-late AND recycles #tweet-recycled in place
    const hydratedSpan = document.createElement('span');
    hydratedSpan.textContent = 'Hydrated suspense tweet content';
    lateTweet.appendChild(hydratedSpan);
    recycledSpan.textContent = 'Brand new recycled cell tweet';

    await vi.waitFor(() => {
      expect(lateTweet.querySelector('.margin-trans-root')?.textContent).toBe(
        '推文译文：Hydrated suspense tweet content',
      );
      expect(recycledTweet.querySelector('.margin-trans-root')?.textContent).toBe(
        '推文译文：Brand new recycled cell tweet',
      );
    });

    renderer.destroy();
  });

  it('self-destroys zombie listeners on invalidated MV3 extension context without preventDefault, and queues early onMessage commands during bootstrap', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const globalBag = globalThis as Record<string, unknown>;
    const bootstrapKey = '__margin_content_controller__';

    type RuntimeMsgListener = (
      msg: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (res?: unknown) => void,
    ) => boolean | undefined;

    const listeners = new Set<RuntimeMsgListener>();
    let runtimeId: string | undefined = 'gdkbmfndollgfmblnielgfdpeoabekbf';
    let releaseConfig!: () => void;
    const configGate = new Promise<void>((r) => {
      releaseConfig = r;
    });

    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        get id() {
          return runtimeId;
        },
        onMessage: {
          addListener: (fn: RuntimeMsgListener) => listeners.add(fn),
          removeListener: (fn: RuntimeMsgListener) => listeners.delete(fn),
        },
      },
      storage: {
        local: {
          get: async () => {
            await configGate;
            return {};
          },
          set: async () => {},
        },
      },
    };

    try {
      const p = document.createElement('p');
      p.textContent = 'Paragraph on pre-existing tab.';
      document.body.appendChild(p);

      // 1. Early chrome.runtime.onMessage registration BEFORE getMarginConfig() resolves
      const bootPromise = bootstrapMarginContentScript();
      expect(listeners.size).toBe(1);

      let earlyResponse: unknown;
      const earlyDone = new Promise<void>((resolve) => {
        for (const fn of Array.from(listeners)) {
          fn(
            { type: 'margin:cmd:get-page-state' },
            {} as chrome.runtime.MessageSender,
            (res) => {
              earlyResponse = res;
              resolve();
            },
          );
        }
      });

      releaseConfig();
      const booted = await bootPromise;
      expect(booted).not.toBeNull();
      await earlyDone;
      expect((earlyResponse as { active: boolean }).active).toBe(false);
      booted?.destroy();
      delete globalBag[bootstrapKey];

      // 2. Orphaned content script self-cleans on extension reload (`chrome.runtime.id` -> undefined)
      let zombieTransportCalls = 0;
      const zombieCfg = createDefaultMarginConfig();
      zombieCfg.webpage.autoTranslateMode = 'whitelist';
      const zombieController = new MarginContentController({
        config: zombieCfg,
        getUrl: () => 'https://x.com/home',
        transport: async () => {
          zombieTransportCalls += 1;
          throw new Error('Extension context invalidated.');
        },
      });
      zombieController.mount();

      // Simulate extension reload invalidating the old isolated world
      runtimeId = undefined;

      const altAEvent = new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(altAEvent);

      expect(altAEvent.defaultPrevented).toBe(false);
      expect(zombieTransportCalls).toBe(0);
      expect(document.querySelectorAll('.margin-inline-retry')).toHaveLength(0);
    } finally {
      delete globalBag[bootstrapKey];
      (globalThis as Record<string, unknown>).chrome = origChrome;
    }
  });

  it('does not loop failed batches via MutationObserver when mounting .margin-inline-retry, while still allowing manual retry or text mutation recovery', async () => {
    const config = createDefaultMarginConfig();
    document.body.innerHTML = `
      <main>
        <p id="fail-target">First attempt fails cleanly without looping.</p>
        <p id="sibling-target">Unrelated sibling block.</p>
      </main>
    `;
    const failTarget = document.getElementById('fail-target')!;

    let shouldFail = true;
    let transportCalls = 0;

    const renderer = new WebpageRenderer({
      config,
      flushDelayMs: 10,
      transport: async (req) => {
        transportCalls += 1;
        if (shouldFail) {
          throw new Error('Simulated HTTP 401 unauthorized');
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `恢复译文：${it.text}`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    renderer.enablePageTranslation();

    await vi.waitFor(() => {
      expect(failTarget.querySelector('.margin-inline-retry')).not.toBeNull();
    });
    expect(transportCalls).toBe(1);

    // Wait > 220ms (past 80ms SPA debounce + flushDelayMs) and trigger an unrelated DOM mutation
    const extraNote = document.createElement('span');
    extraNote.textContent = ' — unrelated update';
    document.getElementById('sibling-target')!.appendChild(extraNote);

    await new Promise((r) => setTimeout(r, 240));
    // sibling-target mutated so it may re-translate once if shouldFail were false,
    // wait: sibling-target is also in failedBlockTasks, and now its source text changed!
    // Verify fail-target NEVER re-triggered while its text stayed unchanged:
    expect(failTarget.querySelector('.margin-inline-retry')).not.toBeNull();

    // Reset counter with no external mutations and verify 0 spontaneous background retries over 240ms
    const callsAfterSettle = transportCalls;
    await new Promise((r) => setTimeout(r, 240));
    expect(transportCalls).toBe(callsAfterSettle);

    // Clicking .margin-inline-retry when backend recovers translates cleanly
    shouldFail = false;
    const retryBtn = failTarget.querySelector<HTMLButtonElement>(
      '.margin-inline-retry',
    )!;
    retryBtn.click();

    await vi.waitFor(() => {
      expect(failTarget.querySelector('.margin-trans-root')?.textContent).toBe(
        '恢复译文：First attempt fails cleanly without looping.',
      );
    });
    expect(failTarget.querySelector('.margin-inline-retry')).toBeNull();

    // Wait another 200ms to confirm mounting .margin-trans-root caused 0 extra MutationObserver batches
    const callsAfterRecovery = transportCalls;
    await new Promise((r) => setTimeout(r, 200));
    expect(transportCalls).toBe(callsAfterRecovery);

    renderer.destroy();
  });

  it('re-translates bare #text characterData mutations inside target-only wrapper without internal feedback loops', async () => {
    const config = createDefaultMarginConfig();
    config.webpage.displayMode = 'target-only';

    document.body.innerHTML = `
      <article>
        <p id="target-only-bare">Initial bare headline text</p>
      </article>
    `;
    const p = document.getElementById('target-only-bare')!;
    let transportCalls = 0;

    const renderer = new WebpageRenderer({
      config,
      flushDelayMs: 10,
      transport: async (req) => {
        transportCalls += 1;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `纯译文：${it.text}`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    renderer.enablePageTranslation();

    await vi.waitFor(() => {
      expect(p.querySelector('.margin-trans-root')?.textContent).toBe(
        '纯译文：Initial bare headline text',
      );
    });
    expect(transportCalls).toBe(1);

    const origWrap = p.querySelector('[data-margin-orig-wrap="true"]')!;
    expect(origWrap).not.toBeNull();
    const bareTextNode = origWrap.firstChild as Text;
    expect(bareTextNode.nodeType).toBe(Node.TEXT_NODE);

    // Mutate characterData directly on the wrapped bare #text node
    bareTextNode.data = 'Updated SPA bare headline text';

    await vi.waitFor(() => {
      expect(p.querySelector('.margin-trans-root')?.textContent).toBe(
        '纯译文：Updated SPA bare headline text',
      );
    });
    expect(transportCalls).toBe(2);

    // Confirm zero internal MutationObserver feedback loops after re-wrapping target-only content
    await new Promise((r) => setTimeout(r, 220));
    expect(transportCalls).toBe(2);

    renderer.destroy();
  });

  it('survives Chrome 136 reload invalidation where both chrome.runtime.id and chrome.storage become undefined across content, image, and subtitle controllers', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const globalBag = globalThis as Record<string, unknown>;
    const imageBootKey = '__margin_image_translator_booted__';

    let invalidated = false;
    const storageListeners = new Set<(...args: unknown[]) => void>();

    (globalThis as Record<string, unknown>).chrome = {
      get runtime() {
        return {
          get id() {
            return invalidated ? undefined : 'gdkbmfndollgfmblnielgfdpeoabekbf';
          },
          onMessage: {
            addListener: () => {},
            removeListener: () => {},
          },
        };
      },
      get storage() {
        if (invalidated) {
          return undefined;
        }
        return {
          local: {
            get: async () => ({}),
            set: async () => {},
          },
          onChanged: {
            addListener: (fn: (...args: unknown[]) => void) =>
              storageListeners.add(fn),
            removeListener: (fn: (...args: unknown[]) => void) =>
              storageListeners.delete(fn),
          },
        };
      },
    };

    try {
      document.body.innerHTML = `
        <main>
          <p id="shared-para">Shared DOM paragraph across isolated worlds.</p>
          <img id="hero-img" src="https://example.com/comic.png" width="400" height="300" />
        </main>
      `;
      const sharedPara = document.getElementById('shared-para')!;

      // Mount World 1 controllers while chrome.runtime.id and chrome.storage.onChanged are live
      const oldCfg = createDefaultMarginConfig();
      oldCfg.webpage.autoTranslateMode = 'whitelist';
      const oldController = new MarginContentController({
        config: oldCfg,
        getUrl: () => 'https://www.youtube.com/watch?v=AOJwkm3yixU',
      });
      oldController.mount();

      delete globalBag[imageBootKey];
      initMarginImageTranslator();
      expect(document.documentElement.dataset.marginImageReady).toBeUndefined();
      expect(globalBag[imageBootKey]).toBe(true);

      const oldSubController = createSubtitleIsolatedController();
      await oldSubController.start();
      expect(storageListeners.size).toBeGreaterThanOrEqual(3);

      // Simulate World 2 already mounting a fresh .margin-trans-root in the shared DOM after reload
      const newWorldTrans = document.createElement('span');
      newWorldTrans.className = 'margin-trans-root';
      newWorldTrans.setAttribute('data-margin-injected', 'true');
      newWorldTrans.textContent = '新隔离世界译文';
      sharedPara.appendChild(newWorldTrans);
      sharedPara.setAttribute('data-margin-translated', 'true');

      // Chrome 136 extension reload invalidates World 1: chrome.runtime.id = undefined AND chrome.storage = undefined!
      invalidated = true;

      // 1. Alt+A in invalidated World 1 must NOT throw TypeError and must NOT delete World 2's translation
      expect(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            code: 'KeyA',
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      }).not.toThrow();
      expect(sharedPara.querySelector('.margin-trans-root')?.textContent).toBe(
        '新隔离世界译文',
      );

      // 2. pointerover in invalidated World 1 image translator must self-clean without throwing
      expect(() => {
        document
          .getElementById('hero-img')!
          .dispatchEvent(new Event('pointerover', { bubbles: true }));
      }).not.toThrow();
      expect(globalBag[imageBootKey]).toBeUndefined();

      // 3. 100ms playhead poll in invalidated World 1 subtitle controller must self-clean without throwing
      await new Promise((r) => setTimeout(r, 150));
      expect(() => oldSubController.destroy()).not.toThrow();
    } finally {
      delete globalBag[imageBootKey];
      (globalThis as Record<string, unknown>).chrome = origChrome;
    }
  });

  it('auto-translates English pages in foreign mode, skips Chinese pages with misleading <html lang="en">, and honors https://linux.do/* exclusion', async () => {
    // 1. English page on GitHub -> auto-translates immediately & populates getPageState() + domain styleGuide
    document.documentElement.setAttribute('lang', 'en');
    document.body.innerHTML = `
      <article>
        <p id="gh-readme">Margin provides calm bilingual reading with zero-flicker Shadow DOM isolation across modern SPAs.</p>
      </article>
    `;

    const seenContexts: Array<TranslateBatchRequest['context']> = [];
    const enController = new MarginContentController({
      config: createDefaultMarginConfig(),
      getUrl: () => 'https://github.com/openai/openai-node',
      transport: async (req) => {
        seenContexts.push(req.context);
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `自动译文：${it.text}`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });
    enController.mount();

    expect(enController.renderer.isActive).toBe(true);
    expect(enController.getPageState()).toMatchObject({
      active: true,
      autoTranslated: true,
      detectedPageLang: 'en',
    });

    await vi.waitFor(() => {
      expect(
        document.getElementById('gh-readme')?.querySelector('.margin-trans-root')
          ?.textContent,
      ).toContain('自动译文：Margin provides calm bilingual reading');
    });
    expect(seenContexts[0]?.domain).toBe('github.com');
    expect(seenContexts[0]?.styleGuide).toContain('Software engineering');
    enController.destroy();

    // 2. Chinese page leaving `<html lang="en">` in index.html -> MUST NOT auto-translate!
    document.documentElement.setAttribute('lang', 'en');
    document.body.innerHTML = `
      <article>
        <p id="zh-article">这是一篇完整的简体中文技术长文，即便模板错误标记了英文语言属性也不应自动触发翻译。</p>
      </article>
    `;
    let zhApiCalls = 0;
    const zhController = new MarginContentController({
      config: createDefaultMarginConfig(),
      getUrl: () => 'https://juejin.cn/post/7390001',
      transport: async (req) => {
        zhApiCalls += 1;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({ id: it.id, trans: it.text })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });
    zhController.mount();

    expect(zhController.renderer.isActive).toBe(false);
    expect(zhController.getPageState()).toMatchObject({
      active: false,
      autoTranslated: false,
      detectedPageLang: 'zh',
    });
    expect(zhApiCalls).toBe(0);
    zhController.destroy();

    // 3. Excluded site (`https://linux.do/*`) with English prose in `foreign` mode -> MUST NOT auto-translate!
    document.documentElement.setAttribute('lang', 'en');
    document.body.innerHTML = `
      <article>
        <p id="linuxdo-en">Even when a post on linux.do is written entirely in English, site exclusion wins.</p>
      </article>
    `;
    let linuxDoCalls = 0;
    const linuxDoController = new MarginContentController({
      config: createDefaultMarginConfig(),
      getUrl: () => 'https://linux.do/t/topic/88888',
      transport: async (req) => {
        linuxDoCalls += 1;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({ id: it.id, trans: it.text })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });
    linuxDoController.mount();

    expect(linuxDoController.renderer.isActive).toBe(false);
    expect(linuxDoController.getPageState().autoTranslated).toBe(false);
    expect(linuxDoCalls).toBe(0);
    linuxDoController.destroy();
  });

  it('auto-translates SPA feeds after post-hydration MutationObserver recheck, enforces Alt+A manuallyDisabledInSession lock across SPA routes, and reacts to permissive/exclusion config updates', async () => {
    document.documentElement.setAttribute('lang', 'en');
    // Initial document_idle on https://x.com/home BEFORE tweets hydrate (only nav/buttons exist)
    document.body.innerHTML = `
      <nav role="navigation"><a href="/home">Home</a><a href="/explore">Explore</a></nav>
      <button type="button">Post</button>
      <main id="timeline-feed"></main>
    `;

    const config = createDefaultMarginConfig();
    await saveMarginConfig(config);

    let currentUrl = 'https://x.com/home';
    let fakeNow = 10_000;
    let apiCalls = 0;

    const controller = new MarginContentController({
      config,
      now: () => fakeNow,
      getUrl: () => currentUrl,
      transport: async (req) => {
        apiCalls += 1;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `推文自动译文：${it.text}`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });
    controller.mount();

    // Before hydration: insufficient prose -> awaiting-content, not active yet
    expect(controller.renderer.isActive).toBe(false);
    expect(apiCalls).toBe(0);

    // Async SPA feed hydration mounts English tweet > 24 chars
    const feed = document.getElementById('timeline-feed')!;
    const tweet1 = document.createElement('article');
    tweet1.innerHTML = `<div id="hydrated-tweet-1" data-testid="tweetText">Anthropic and OpenAI engineers discuss structured YAML streaming latency across modern browsers.</div>`;
    feed.appendChild(tweet1);

    // Hydration MutationObserver (220ms debounce) detects English prose and auto-enables translation!
    await vi.waitFor(
      () => {
        expect(controller.renderer.isActive).toBe(true);
        expect(
          document
            .getElementById('hydrated-tweet-1')
            ?.querySelector('.margin-trans-root')?.textContent,
        ).toContain('推文自动译文：Anthropic and OpenAI');
      },
      { timeout: 1500 },
    );

    expect(controller.getPageState()).toMatchObject({
      active: true,
      autoTranslated: true,
      detectedPageLang: 'en',
    });

    // User manually toggles translation OFF via Alt+A (`margin:cmd:toggle-page`) -> locks session manual-off!
    fakeNow += 2000;
    const toggledOff = await controller.handleCommand(
      { type: 'margin:cmd:toggle-page' },
      'key',
    );
    expect(toggledOff).toBe(false);
    expect(controller.renderer.isActive).toBe(false);
    expect(controller.getPageState().autoTranslated).toBe(false);

    const callsAfterManualOff = apiCalls;

    // SPA route click (`popstate` / `yt-navigate-finish`) + new English tweets MUST NOT re-trigger auto-translation!
    currentUrl = 'https://x.com/explore';
    const tweet2 = document.createElement('article');
    tweet2.innerHTML = `<div id="hydrated-tweet-2" data-testid="tweetText">Another foreign-language post mounted during the same tab session after manual off.</div>`;
    feed.appendChild(tweet2);
    window.dispatchEvent(new Event('popstate'));
    await new Promise((r) => setTimeout(r, 280));

    expect(controller.renderer.isActive).toBe(false);
    expect(apiCalls).toBe(callsAfterManualOff);

    // Making site rules more permissive (`includeMatches: ['*://x.com/*']`) via onMarginConfigChanged resets manual-off lock and auto-translates!
    const permissiveCfg = structuredClone(config);
    permissiveCfg.urlRules.includeMatches = ['*://x.com/*'];
    await saveMarginConfig(permissiveCfg);

    await vi.waitFor(() => {
      expect(controller.renderer.isActive).toBe(true);
      expect(controller.getPageState().autoTranslated).toBe(true);
    });

    // Excluding URL via onMarginConfigChanged while `active && autoTranslated` immediately disables page translation!
    const excludedCfg = structuredClone(permissiveCfg);
    excludedCfg.urlRules.excludeMatches = ['https://linux.do/*', '*://x.com/*'];
    await saveMarginConfig(excludedCfg);

    expect(controller.renderer.isActive).toBe(false);
    expect(controller.getPageState().autoTranslated).toBe(false);
    expect(document.querySelector('.margin-trans-root')).toBeNull();

    controller.destroy();
  });

  it('mounts proportional warm-paper shimmer, streams 60fps partial: true tokens via single Text node with rAF coalescing (never caching partials), and reconstructs rich <mN> DOM on finalize', async () => {
    expect(WEBPAGE_INJECTED_CSS).toContain('.margin-shimmer-line');
    expect(WEBPAGE_INJECTED_CSS).toContain('prefers-reduced-motion: reduce');
    expect(WEBPAGE_INJECTED_CSS).not.toContain('.margin-trans-spinner');
    expect(stripPartialInlineMarkers('你好<m0>世界</m0>！')).toBe('你好世界！');

    const config = createDefaultMarginConfig();
    config.providers['google-free'].stream = 'on';

    document.body.innerHTML = `
      <main>
        <div id="clamped-wrap" style="max-height: 44px; overflow: hidden;">
          <p id="short-block">Concise tweet headline for single-line shimmer.</p>
        </div>
        <p id="long-rich-block">
          Longer editorial paragraph exceeding eighty characters with <a href="https://margin.dev/docs" id="orig-doc-link">complete streaming documentation</a> for live preview testing.
        </p>
      </main>
    `;

    const clampedWrap = document.getElementById('clamped-wrap')!;
    const shortBlock = document.getElementById('short-block')!;
    const longBlock = document.getElementById('long-rich-block')!;

    const rafCallbacks: FrameRequestCallback[] = [];
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
    const cafSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {});

    let fakePerfNow = 1000;
    const perfSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => fakePerfNow);

    let emitStreamItem!: (item: {
      id: number;
      trans: string;
      partial?: boolean;
    }) => void;
    let resolveTransport!: (res: TranslateBatchResponse) => void;
    const cache = new LruTranslationCache(100);

    try {
      const renderer = new WebpageRenderer({
        config,
        cache,
        getUrl: () => 'https://x.com/home',
        transport: (_req, callbacks) => {
          emitStreamItem = (item) => callbacks.onItemReady?.(item);
          return new Promise<TranslateBatchResponse>((resolve) => {
            resolveTransport = resolve;
          });
        },
      });

      renderer.enablePageTranslation();

      // 1. Hero Wave 0 mounts proportional warm-paper shimmer (1 line 58% vs 2 lines 88% + 54%, zero "正在翻译…" text)
      const shortLoading = shortBlock.querySelector(
        '.margin-trans-loading',
      ) as HTMLElement;
      const longLoading = longBlock.querySelector(
        '.margin-trans-loading',
      ) as HTMLElement;
      expect(shortLoading).not.toBeNull();
      expect(longLoading).not.toBeNull();
      expect(shortLoading.getAttribute('data-margin-loading')).toBe('1');
      expect(shortLoading.getAttribute('aria-busy')).toBe('true');
      expect(shortLoading.textContent).toBe('');
      const shortLines = shortLoading.querySelectorAll<HTMLElement>(
        '.margin-shimmer-line',
      );
      const longLines = longLoading.querySelectorAll<HTMLElement>(
        '.margin-shimmer-line',
      );
      expect(shortLines).toHaveLength(1);
      expect(shortLines[0]?.style.width).toBe('58%');
      expect(longLines).toHaveLength(2);
      expect(longLines[0]?.style.width).toBe('88%');
      expect(longLines[1]?.style.width).toBe('54%');

      const pillHost = document.querySelector('[data-margin-host="page-status"]')!;
      const pillEl = pillHost.shadowRoot!.querySelector(
        '[data-testid="margin-status-pill"]',
      )!;
      expect(pillEl.getAttribute('data-quiet')).toBeNull();

      // 2. Leading-edge (0ms) first partial update strips <m0> tags, unclamps ancestor, and mounts a single Text node
      emitStreamItem({
        id: 2,
        trans: '较长编辑段落，附带<m0>完整流式',
        partial: true,
      });

      const streamSpan = longBlock.querySelector(
        '.margin-trans-root',
      ) as HTMLElement;
      expect(streamSpan).not.toBeNull();
      expect(streamSpan.hasAttribute('data-margin-loading')).toBe(false);
      expect(streamSpan.getAttribute('data-margin-streaming')).toBe('1');
      expect(streamSpan.textContent).toBe('较长编辑段落，附带完整流式');
      expect(streamSpan.querySelectorAll('a')).toHaveLength(0);
      expect(streamSpan.childNodes).toHaveLength(1);
      const liveTextNode = streamSpan.firstChild!;
      expect(liveTextNode.nodeType).toBe(Node.TEXT_NODE);

      emitStreamItem({ id: 1, trans: '精炼推文首词', partial: true });
      expect(clampedWrap.getAttribute('data-margin-unclamped')).toBe('true');

      // CRITICAL: Partials MUST NEVER enter LRU cache or increment translatedBlocks!
      expect(cache.size).toBe(0);
      expect(renderer.getPageState().translatedBlocks).toBe(0);

      // 3. Burst partial updates within < 16ms coalesce into a single rAF and mutate the SAME Text node in-place!
      fakePerfNow += 4;
      emitStreamItem({
        id: 2,
        trans: '较长编辑段落，附带<m0>完整流式文档',
        partial: true,
      });
      fakePerfNow += 4;
      emitStreamItem({
        id: 2,
        trans: '较长编辑段落，附带<m0>完整流式文档</m0>预览',
        partial: true,
      });

      expect(rafCallbacks).toHaveLength(1);
      // Still showing previous frame before rAF fires
      expect(streamSpan.textContent).toBe('较长编辑段落，附带完整流式');

      fakePerfNow += 10;
      const flushFrame = rafCallbacks.shift()!;
      flushFrame(fakePerfNow);

      expect(streamSpan.textContent).toBe('较长编辑段落，附带完整流式文档预览');
      expect(streamSpan.firstChild).toBe(liveTextNode);
      expect(cache.size).toBe(0);
      expect(renderer.getPageState().translatedBlocks).toBe(0);

      // 4. Finalized items (!partial) cancel pending rAF, reconstruct rich <m0> -> <a href>, cache, and quiet status pill!
      fakePerfNow += 2;
      emitStreamItem({
        id: 2,
        trans: '较长编辑段落，附带<m0>未刷新的尾帧',
        partial: true,
      });
      expect(rafCallbacks).toHaveLength(1);

      resolveTransport({
        ok: true,
        requestId: 'stream-final',
        providerId: 'google-free',
        model: 'gtx',
        items: [
          { id: 1, trans: '用于单行微光测试的精炼推文标题。' },
          {
            id: 2,
            trans: '超过八十字符的较长编辑段落，附带<m0>完整流式文档</m0>供实时预览测试。',
          },
        ],
        diagnostic: makeMockDiagnostic(),
      });

      await vi.waitFor(() => {
        expect(renderer.getPageState().translatedBlocks).toBe(2);
      });

      const finalSpan = longBlock.querySelector(
        '.margin-trans-root',
      ) as HTMLElement;
      expect(finalSpan.hasAttribute('data-margin-streaming')).toBe(false);
      const richLink = finalSpan.querySelector('a') as HTMLAnchorElement;
      expect(richLink).not.toBeNull();
      expect(richLink.href).toBe('https://margin.dev/docs');
      expect(richLink.textContent).toBe('完整流式文档');
      expect(cache.size).toBe(2);
      expect(pillEl.getAttribute('data-quiet')).toBe('true');

      renderer.destroy();
    } finally {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
      perfSpy.mockRestore();
    }
  });

  it('schedules 4-tier priorities (VIP -1, Hero Wave 0 P0, 2200px P1 lookahead, Alt+W P2) and evicts/aborts fast-scrolled off-screen P1 blocks', async () => {
    vi.useFakeTimers();
    expect(VIEWPORT_ROOT_MARGIN).toBe('300px 0px 2200px 0px');

    const origInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });

    const rectTopById: Record<string, number> = {
      'blk-1': 80,
      'blk-2': 240,
      'blk-3': 420,
      'blk-4': 1400, // P1 lookahead (<= 800 + 2200)
      'blk-5': 1900, // P1 lookahead -> will scroll far away before 16ms flush!
      'blk-6': 4500, // Far off-screen (> 3000px) -> observed only
    };

    document.body.innerHTML = `
      <main>
        <p id="blk-1">First hero viewport paragraph visible immediately at top.</p>
        <p id="blk-2">Second hero viewport paragraph visible right below first.</p>
        <p id="blk-3">Third visible paragraph queued for 16ms P0 flush.</p>
        <p id="blk-4">Fourth lookahead paragraph promoted to P0 on scroll.</p>
        <p id="blk-5">Fifth lookahead paragraph evicted before flush on fast jump.</p>
        <p id="blk-6">Sixth deep off-screen paragraph translated as P2 on Alt+W.</p>
      </main>
    `;

    for (const id of Object.keys(rectTopById)) {
      const el = document.getElementById(id)!;
      vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => {
        const top = rectTopById[id];
        return {
          top,
          bottom: top + 60,
          left: 0,
          right: 600,
          width: 600,
          height: 60,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      });
    }

    const dispatched: Array<{
      priority: number | undefined;
      texts: string[];
      signal: AbortSignal;
    }> = [];
    let holdP1Batch = false;

    try {
      const config = createDefaultMarginConfig();
      const renderer = new WebpageRenderer({
        config,
        flushDelayMs: 16,
        getUrl: () => 'https://example.com/feed',
        transport: (req, _cb, signal) => {
          dispatched.push({
            priority: req.priority,
            texts: req.items.map((i) => i.text),
            signal,
          });
          if (holdP1Batch && req.priority === 1) {
            return new Promise<TranslateBatchResponse>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              });
            });
          }
          return Promise.resolve({
            ok: true,
            requestId: req.requestId,
            providerId: 'google-free',
            model: 'gtx',
            items: req.items.map((it) => ({
              id: it.id,
              trans: `译：${it.text.slice(0, 16)}`,
            })),
            diagnostic: makeMockDiagnostic(),
          });
        },
      });

      // 1. Enable page translation -> Hero Wave 0 dispatches first 2 visible P0 blocks at 0ms synchronously!
      renderer.enablePageTranslation();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.priority).toBe(0);
      expect(dispatched[0]?.texts).toEqual([
        'First hero viewport paragraph visible immediately at top.',
        'Second hero viewport paragraph visible right below first.',
      ]);

      // Before 16ms flush fires: user scrolls so blk-4 enters [0, 800] (promoted P1 -> P0)
      // and blk-5 jumps to top=3600 (> vh + 2600 -> evicted from queue, shimmer cleaned up!)
      rectTopById['blk-4'] = 320;
      rectTopById['blk-5'] = 3600;

      await vi.advanceTimersByTimeAsync(20);

      expect(dispatched).toHaveLength(2);
      expect(dispatched[1]?.priority).toBe(0);
      expect(dispatched[1]?.texts).toEqual([
        'Third visible paragraph queued for 16ms P0 flush.',
        'Fourth lookahead paragraph promoted to P0 on scroll.',
      ]);
      // blk-5 was evicted cleanly with zero loading shimmer left behind!
      expect(
        document.getElementById('blk-5')!.querySelector('.margin-trans-loading'),
      ).toBeNull();

      // 2. Test in-flight P1 fast-scroll abort (120ms throttled scroll listener):
      // Mount a new lookahead block blk-7 at top=1500 (P1), hold its P1 request in-flight without items, then scroll far away!
      holdP1Batch = true;
      const blk7 = document.createElement('p');
      blk7.id = 'blk-7';
      blk7.textContent = 'Seventh lookahead paragraph aborted mid-flight when user jumps far.';
      rectTopById['blk-7'] = 1500;
      vi.spyOn(blk7, 'getBoundingClientRect').mockImplementation(() => {
        const top = rectTopById['blk-7'];
        return {
          top,
          bottom: top + 60,
          left: 0,
          right: 600,
          width: 600,
          height: 60,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      });
      document.querySelector('main')!.appendChild(blk7);
      renderer.rescanSubtree(document.body);
      await vi.advanceTimersByTimeAsync(30);

      const p1Call = dispatched.find((d) => d.priority === 1);
      expect(p1Call).toBeDefined();
      expect(p1Call!.signal.aborted).toBe(false);
      expect(blk7.querySelector('.margin-trans-loading')).not.toBeNull();

      // Fast scroll pushes blk-7 to top=4200 (> 800 + 3000) -> aborts in-flight P1 batch & cleans up shimmer without retry error!
      rectTopById['blk-7'] = 4200;
      window.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(130);

      expect(p1Call!.signal.aborted).toBe(true);
      expect(blk7.querySelector('.margin-trans-loading')).toBeNull();
      expect(blk7.querySelector('.margin-inline-retry')).toBeNull();

      // 3. Alt+W (`translateWholePage`) dispatches off-screen blocks (`blk-5`, `blk-6`, `blk-7`) with P2 (`priority: 2`)
      holdP1Batch = false;
      await renderer.translateWholePage();
      const p2Call = dispatched.find((d) => d.priority === 2);
      expect(p2Call).toBeDefined();
      expect(p2Call!.texts).toContain(
        'Sixth deep off-screen paragraph translated as P2 on Alt+W.',
      );

      // 4. Hover single-paragraph toggle dispatches VIP (`priority: -1`)
      const hoverPara = document.createElement('p');
      hoverPara.textContent = 'Hovered paragraph receives VIP priority minus one.';
      document.querySelector('main')!.appendChild(hoverPara);
      await renderer.toggleSingleBlock(hoverPara, 'hover');
      expect(dispatched[dispatched.length - 1]?.priority).toBe(-1);

      renderer.destroy();
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: origInnerHeight,
      });
    }
  });

  it('populates X /status/ threadContext and forwards sliding prevContext (<= 220 chars) across sequential webpage batches', async () => {
    vi.useFakeTimers();
    const config = createDefaultMarginConfig();
    config.providers['openai-compatible'] = {
      ...config.providers['google-free'],
      id: 'openai-compatible',
      name: 'OpenAI Test',
      preset: 'openai',
      protocol: 'openai-chat',
      enableContext: true,
      maxBatchCount: 2,
      maxCharsPerBatch: 1200,
    };
    config.routing.webpage = 'openai-compatible';

    document.body.innerHTML = `
      <main>
        <article>
          <div id="focal-root" data-testid="tweetText">We open-sourced our deterministic speculative router today with zero head-of-line blocking.</div>
        </article>
        <article>
          <div id="reply-1" data-testid="tweetText">Does it preempt background lookahead requests when the user hovers a paragraph?</div>
        </article>
        <article>
          <div id="reply-2" data-testid="tweetText">Yes, VIP priority minus one jumps directly to the front of ProviderExecutionPool.</div>
        </article>
      </main>
    `;

    const seenRequests: TranslateBatchRequest[] = [];
    const renderer = new WebpageRenderer({
      config,
      flushDelayMs: 16,
      getUrl: () => 'https://x.com/karpathy/status/123456',
      transport: async (req) => {
        seenRequests.push(req);
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'openai-compatible',
          model: 'gpt-4o-mini',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `上下文译文：${it.text.slice(0, 20)}`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    renderer.enablePageTranslation();
    await vi.advanceTimersByTimeAsync(25);

    expect(seenRequests.length).toBeGreaterThanOrEqual(2);
    // Batch 1 (Hero Wave 0): has threadContext from focal tweet, no prevContext yet
    expect(seenRequests[0]?.context?.threadContext).toBe(
      'We open-sourced our deterministic speculative router today with zero head-of-line blocking.',
    );
    expect(seenRequests[0]?.context?.prevContext).toBeUndefined();

    // Batch 2 (16ms flush): carries both threadContext AND sliding prevContext from Batch 1!
    expect(seenRequests[1]?.context?.threadContext).toBe(
      'We open-sourced our deterministic speculative router today with zero head-of-line blocking.',
    );
    expect(seenRequests[1]?.context?.prevContext).toContain(
      'Does it preempt background lookahead requests',
    );
    expect(seenRequests[1]!.context!.prevContext!.length).toBeLessThanOrEqual(
      220,
    );

    // Disabling / resetting page clears sliding prevContext cleanly
    renderer.disable();
    renderer.clearCache();
    renderer.enablePageTranslation();
    expect(seenRequests[seenRequests.length - 1]?.context?.prevContext).toBeUndefined();

    renderer.destroy();
  });

  it('fires requestRuntimeWarmup({ scene: "webpage" }) on translatable URLs and triggers 0ms leading-edge hydration on the very first >= 18-char X tweet (with 60ms throttle)', async () => {
    const config = createDefaultMarginConfig();
    config.webpage.autoTranslateMode = 'foreign';

    // 1. Excluded URL (`https://linux.do/*`) and unsupported browser URL (`chrome://extensions`) MUST NOT call warmup
    let forbiddenWarmupCalls = 0;
    const excludedCtrl = new MarginContentController({
      config,
      getUrl: () => 'https://linux.do/t/topic/999',
      warmup: async () => {
        forbiddenWarmupCalls += 1;
        return { ok: true };
      },
    });
    excludedCtrl.mount();
    excludedCtrl.destroy();

    const chromeCtrl = new MarginContentController({
      config,
      getUrl: () => 'chrome://extensions',
      warmup: async () => {
        forbiddenWarmupCalls += 1;
        return { ok: true };
      },
    });
    chromeCtrl.mount();
    chromeCtrl.destroy();
    expect(forbiddenWarmupCalls).toBe(0);

    // 2. Translatable SPA (`https://x.com/home`) warms runtime at mount() and triggers at 0ms leading edge on first painted tweet!
    const warmupPayloads: Array<{ scene?: string }> = [];
    const batchRequests: TranslateBatchRequest[] = [];

    document.body.innerHTML = `<main id="x-shell"></main>`;

    const controller = new MarginContentController({
      config,
      getUrl: () => 'https://x.com/home',
      warmup: async (payload) => {
        warmupPayloads.push(payload ?? {});
        return { ok: true, warmedProviderId: 'google-free' };
      },
      transport: async (req) => {
        batchRequests.push(req);
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `首推极速译文：${it.text}`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    controller.mount();
    expect(warmupPayloads).toEqual([{ scene: 'webpage' }]);
    expect(controller.renderer.isActive).toBe(false);

    // Mount a single compact tweet (19 letters: >= 18 tweet threshold, < 24 general prose threshold!)
    const shell = document.getElementById('x-shell')!;
    const firstTweet = document.createElement('div');
    firstTweet.setAttribute('data-testid', 'tweetText');
    firstTweet.textContent = 'Shipping streaming UI!';
    const t0 = performance.now();
    shell.appendChild(firstTweet);

    // Yield microtasks first (MutationObserver + Hero Wave 0 fire with zero debounce timer);
    // fall back to a single 0ms macrotask turn if the DOM env queues records on macrotask,
    // and assert well below the legacy 220ms debounce even under parallel CI CPU contention.
    await Promise.resolve();
    await Promise.resolve();
    if (!controller.renderer.isActive) {
      await new Promise((r) => setTimeout(r, 0));
    }

    const triggerElapsedMs = performance.now() - t0;
    expect(triggerElapsedMs).toBeLessThan(180);
    expect(controller.renderer.isActive).toBe(true);
    expect(batchRequests).toHaveLength(1);
    expect(batchRequests[0]?.priority).toBe(0);
    expect(batchRequests[0]?.items[0]?.text).toBe('Shipping streaming UI!');

    controller.destroy();

    // 3. Verify 60ms subsequent hydration throttle when 1st mutation is numeric skeleton noise
    document.body.innerHTML = `<main id="feed-shell"></main>`;
    const skeletonShell = document.getElementById('feed-shell')!;
    let fakeNow = 10_000;
    const throttledCtrl = new MarginContentController({
      config,
      now: () => fakeNow,
      getUrl: () => 'https://news.ycombinator.com/',
      warmup: async () => ({ ok: true }),
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: req.items.map((it) => ({ id: it.id, trans: `译：${it.text}` })),
        diagnostic: makeMockDiagnostic(),
      }),
    });
    throttledCtrl.mount();

    // First mutation at t=10_000ms: numeric skeleton (0ms leading-edge check runs, still awaiting-content)
    const numSpan = document.createElement('span');
    numSpan.textContent = '12345';
    skeletonShell.appendChild(numSpan);
    await new Promise((r) => setTimeout(r, 0));
    expect(throttledCtrl.renderer.isActive).toBe(false);

    // 10ms later (t=10_010ms): English prose arrives (>= 24 chars) -> throttled for remaining 50ms!
    fakeNow += 10;
    const articleP = document.createElement('p');
    articleP.textContent = 'Compact foreign prose sentence triggers hydration check.';
    skeletonShell.appendChild(articleP);
    await new Promise((r) => setTimeout(r, 0));
    // Immediately after MutationObserver delivery, still false because 10ms < 60ms throttle!
    expect(throttledCtrl.renderer.isActive).toBe(false);

    // Wait past the 50ms remaining throttle window -> activates cleanly!
    fakeNow += 55;
    await new Promise((r) => setTimeout(r, 65));
    expect(throttledCtrl.renderer.isActive).toBe(true);

    throttledCtrl.destroy();
  });

  it('prevents CJK Han-Unification ransom-note glyph mixing and RTL inversion across X Japanese emoji tweets, Arabic RTL tweets, editorial serif articles, and SelectionPopover', async () => {
    // 1. Verify WEBPAGE_INJECTED_CSS drops `font: inherit;` in favor of explicit typographic inheritance + target font rule
    expect(WEBPAGE_INJECTED_CSS).not.toContain('font: inherit;');
    expect(WEBPAGE_INJECTED_CSS).toContain(
      'font-size: var(--margin-effective-font-size, inherit);',
    );
    expect(WEBPAGE_INJECTED_CSS).toContain(
      'font-weight: var(--margin-effective-font-weight, inherit);',
    );
    expect(WEBPAGE_INJECTED_CSS).toContain(
      'font-family: var(--margin-target-font-family) !important;',
    );
    expect(WEBPAGE_INJECTED_CSS).toContain(
      ':where(span, a, strong, b, em, i, u, s, mark, small, sub, sup, abbr, cite, q, time, del, ins, dfn, bdi, bdo):not(.katex):not(.katex *)',
    );
    // Ensure atomic inline tags (`code`, `kbd`, `samp`, `var`, `math`, `mjx-container`) are NOT inside `:where(...)`
    const whereClauseMatch = WEBPAGE_INJECTED_CSS.match(/:where\(([^)]+)\)/);
    expect(whereClauseMatch).not.toBeNull();
    const whereTags = whereClauseMatch![1]
      .split(',')
      .map((t) => t.trim().toLowerCase());
    expect(whereTags).toContain('span');
    expect(whereTags).toContain('a');
    for (const excludedAtomic of ['code', 'kbd', 'samp', 'var', 'math', 'mjx-container']) {
      expect(whereTags).not.toContain(excludedAtomic);
    }

    // 2. Simulate X stylesheet setting Meiryo on `.r-1tl8opc`, a Japanese emoji tweet, an Arabic RTL tweet, and an editorial serif paragraph
    const hostStyle = document.createElement('style');
    hostStyle.textContent =
      '.r-1tl8opc { font-family: "Segoe UI", Meiryo, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }';
    document.head.appendChild(hostStyle);

    document.body.innerHTML = `
      <article>
        <div id="ja-tweet" data-testid="tweetText" lang="ja" class="r-1tl8opc"><span lang="ja" class="css-1jxf684 r-1tl8opc">すみません</span><img alt="😭" src="https://abs-0.twimg.com/emoji/v2/svg/1f62d.svg"><span lang="ja" class="css-1jxf684 r-1tl8opc">卒論でWordを使ってる</span></div>
      </article>
      <article>
        <div id="ar-tweet" data-testid="tweetText" lang="ar" dir="rtl"><span lang="ar" dir="rtl" class="css-1jxf684 r-1tl8opc">مرحبا بالعالم في هذا اليوم الجميل</span></div>
      </article>
      <article>
        <p id="serif-para" style="font-family: Georgia, serif;">Long-form literary essay paragraph in Georgia serif typography.</p>
      </article>
    `;

    const jaTweet = document.getElementById('ja-tweet')!;
    const arTweet = document.getElementById('ar-tweet')!;
    const serifPara = document.getElementById('serif-para')!;

    const config = createDefaultMarginConfig();
    config.targetLang = 'zh-CN';
    config.providers['google-free'].stream = 'on';

    let releaseFinal!: () => void;
    const finalBarrier = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });

    const renderer = new WebpageRenderer({
      config,
      getUrl: () => 'https://x.com/i/status/789',
      transport: async (req, callbacks) => {
        for (const it of req.items) {
          if (it.text.includes('すみません')) {
            callbacks.onItemReady?.({
              id: it.id,
              trans: '<m0>不好意思</m0>谁现在还在毕业论文',
              partial: true,
            });
          } else if (it.text.includes('مرحبا')) {
            callbacks.onItemReady?.({
              id: it.id,
              trans: '<m0>在这个美好的一天向世界问好',
              partial: true,
            });
          }
        }
        await finalBarrier;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => {
            if (it.text.includes('すみません')) {
              return {
                id: it.id,
                trans:
                  '<m0>不好意思</m0><m1/><m2>谁现在还在毕业论文里用Word写东西，连图都贴不好。</m2>',
              };
            }
            if (it.text.includes('مرحبا')) {
              return {
                id: it.id,
                trans: '<m0>在这个美好的一天向世界问好！</m0>',
              };
            }
            return {
              id: it.id,
              trans: '采用衬线字体排版的深度文学随笔段落。',
            };
          }),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    const translatePromise = renderer.translateWholePage();

    // Check streaming `partial: true` preview on BOTH Japanese tweet and Arabic RTL tweet!
    await vi.waitFor(() => {
      const jaStream = jaTweet.querySelector(
        '.margin-trans-root[data-margin-streaming="1"]',
      ) as HTMLElement | null;
      const arStream = arTweet.querySelector(
        '.margin-trans-root[data-margin-streaming="1"]',
      ) as HTMLElement | null;
      expect(jaStream).not.toBeNull();
      expect(arStream).not.toBeNull();

      for (const streamEl of [jaStream!, arStream!]) {
        expect(streamEl.getAttribute('lang')).toBe('zh-CN');
        expect(streamEl.getAttribute('dir')).toBe('ltr');
        expect(streamEl.getAttribute('data-margin-has-target-font')).toBe('true');
        const fontVar = streamEl.style.getPropertyValue(
          '--margin-target-font-family',
        );
        expect(fontVar).toContain('PingFang SC');
        expect(fontVar).toContain('Microsoft YaHei');
        expect(fontVar).not.toContain('Meiryo');
        expect(fontVar).not.toContain('Malgun Gothic');
      }
    });

    // Release final rich DOM reconstruction
    releaseFinal();
    await translatePromise;

    const jaFinal = jaTweet.querySelector(
      '.margin-trans-root[data-margin-injected="true"]',
    ) as HTMLElement;
    const arFinal = arTweet.querySelector(
      '.margin-trans-root[data-margin-injected="true"]',
    ) as HTMLElement;
    const serifFinal = serifPara.querySelector(
      '.margin-trans-root[data-margin-injected="true"]',
    ) as HTMLElement;

    for (const finalEl of [jaFinal, arFinal]) {
      expect(finalEl.getAttribute('lang')).toBe('zh-CN');
      expect(finalEl.getAttribute('dir')).toBe('ltr');
      expect(finalEl.getAttribute('data-margin-has-target-font')).toBe('true');
      const fontVar = finalEl.style.getPropertyValue(
        '--margin-target-font-family',
      );
      expect(fontVar).toContain('PingFang SC');
      expect(fontVar).toContain('Microsoft YaHei');
      expect(fontVar).not.toContain('Meiryo');
      expect(fontVar).not.toContain('Malgun Gothic');
    }

    // Verify cloned inner spans stripped source `lang="ja"` / `lang="ar"` & `dir="rtl"` while keeping class and atomic emoji <img>
    const jaInnerSpans = jaFinal.querySelectorAll('span.css-1jxf684.r-1tl8opc');
    expect(jaInnerSpans).toHaveLength(2);
    expect(jaInnerSpans[0]?.hasAttribute('lang')).toBe(false);
    expect(jaInnerSpans[1]?.hasAttribute('lang')).toBe(false);
    const jaEmoji = jaFinal.querySelector('img');
    expect(jaEmoji?.getAttribute('alt')).toBe('😭');

    const arInnerSpan = arFinal.querySelector('span.css-1jxf684.r-1tl8opc')!;
    expect(arInnerSpan).not.toBeNull();
    expect(arInnerSpan.hasAttribute('lang')).toBe(false);
    expect(arInnerSpan.hasAttribute('dir')).toBe(false);
    expect(arInnerSpan.textContent).toBe('在这个美好的一天向世界问好！');

    // Editorial serif host resolves Songti SC / Noto Serif SC stack
    expect(
      serifFinal.style.getPropertyValue('--margin-target-font-family'),
    ).toContain('Songti SC');

    renderer.destroy();

    // 3. SelectionPopover applies target lang, dir, and locale-pure font family on `.mp-sel-body`
    const selCfg = createDefaultMarginConfig();
    selCfg.selection.enabled = true;
    selCfg.selection.triggerMode = 'instant';
    selCfg.targetLang = 'zh-TW';

    const popover = new SelectionPopover({
      config: selCfg,
      transport: async (req, callbacks) => {
        callbacks.onItemReady?.({ id: 1, trans: '畢業論文排版', partial: true });
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: [{ id: 1, trans: '畢業論文排版測試' }],
          diagnostic: makeMockDiagnostic(),
        };
      },
    });
    popover.mount();
    popover.presentForSelection('卒論でWordを使ってる', { x: 40, y: 40 });
    await new Promise((r) => setTimeout(r, 10));

    const selBody = popover
      .getShadowRoot()!
      .querySelector('.mp-sel-body') as HTMLElement;
    expect(selBody.getAttribute('lang')).toBe('zh-TW');
    expect(selBody.getAttribute('dir')).toBe('ltr');
    expect(
      selBody.style.getPropertyValue('--margin-target-font-family'),
    ).toContain('Microsoft JhengHei');
    expect(
      selBody.style.getPropertyValue('--margin-target-font-family'),
    ).not.toContain('Meiryo');

    // Live updateConfig to Arabic RTL updates `.mp-sel-body` lang="ar" and dir="rtl"
    const arSelCfg = structuredClone(selCfg);
    arSelCfg.targetLang = 'ar';
    popover.updateConfig(arSelCfg);
    expect(selBody.getAttribute('lang')).toBe('ar');
    expect(selBody.getAttribute('dir')).toBe('rtl');

    popover.destroy();
  });

  it('inherits effective host text style & preserves link appearance across YouTube Dark Mode cards (shimmer, streaming, bilingual, target-only, Polymer #video-title, Watch H1, LIVE badge), X @mentions, and live Dark <-> Light toggles', async () => {
    // Verify CSS rules for zero-specificity link fallback, preserved link rules, weakening, and dark-friendly inline retry
    expect(WEBPAGE_INJECTED_CSS).not.toContain(
      '.margin-trans-root[data-margin-injected="true"] a {',
    );
    expect(WEBPAGE_INJECTED_CSS).toContain(
      ':where(.margin-trans-root[data-margin-injected="true"]) :where(a)',
    );
    expect(WEBPAGE_INJECTED_CSS).toContain(
      '.margin-trans-root[data-margin-injected="true"] a[data-margin-has-link-color="true"]',
    );
    expect(WEBPAGE_INJECTED_CSS).toContain(
      '.margin-trans-root[data-margin-injected="true"] a[data-margin-no-underline="true"]:not(:hover)',
    );
    expect(WEBPAGE_INJECTED_CSS).toContain(
      'color-mix(in srgb, var(--margin-effective-color, currentColor) 74%, #8d877a 26%)',
    );
    expect(WEBPAGE_INJECTED_CSS).not.toContain('background: #fbfaf6;');

    // Simulate authentic YouTube Dark Mode (`<html dark style="font-size: 10px">`, body with NO color rule)
    document.documentElement.setAttribute('dark', '');
    document.documentElement.style.fontSize = '10px';

    const hostStyle = document.createElement('style');
    hostStyle.textContent = `
      html[dark] { --yt-spec-text-primary: rgb(241, 241, 241); }
      html:not([dark]) { --yt-spec-text-primary: rgb(15, 15, 15); }
      a { color: rgb(62, 166, 255); text-decoration: underline; }
      .yt-lockup-metadata-view-model__heading-reset {
        margin: 0;
        font-size: inherit;
        font-weight: inherit;
      }
      .yt-lockup-metadata-view-model__title {
        color: var(--yt-spec-text-primary);
        font-family: Roboto, Arial, sans-serif;
        font-size: 16px;
        line-height: 22px;
        font-weight: 500;
        text-decoration: none;
      }
      #video-title {
        color: var(--yt-spec-text-primary);
        font-size: 14px;
        line-height: 20px;
        font-weight: 500;
        text-decoration: none;
      }
      h1.watch-h1 {
        font-size: 10px;
        font-weight: 400;
      }
      yt-formatted-string.ytd-watch-metadata {
        color: var(--yt-spec-text-primary);
        font-size: 20px;
        line-height: 28px;
        font-weight: 700;
      }
      .live-badge {
        color: rgb(255, 78, 69);
        font-size: 11px;
        font-weight: 700;
      }
      .x-tweet {
        color: rgb(231, 233, 234);
        font-size: 15px;
      }
      .r-1cvl2hr {
        color: rgb(29, 155, 240);
        text-decoration: none;
      }
      .lead-prose {
        color: rgb(212, 212, 216);
        font-size: 16px;
        font-weight: 400;
      }
      .lead-prose strong {
        font-weight: 700;
        color: rgb(255, 255, 255);
      }
    `;
    document.head.appendChild(hostStyle);

    document.body.innerHTML = `
      <section id="yt-feed">
        <h3 id="yt-card-1" class="yt-lockup-metadata-view-model__heading-reset">
          <a class="yt-lockup-metadata-view-model__title" href="/watch?v=1">
            <span class="yt-core-attributed-string" role="text">Elden Ring Pro Plays Phantom Blade Zero</span>
          </a>
        </h3>
        <h3 id="yt-polymer-card" class="title-and-badge">
          <a id="video-title" class="yt-simple-endpoint" href="/watch?v=2">
            <yt-formatted-string>CYCLING THE WORLD | Award-Winning Adventure Documentary</yt-formatted-string>
          </a>
        </h3>
        <h1 id="yt-watch-h1" class="watch-h1">
          <yt-formatted-string class="ytd-watch-metadata">PHANTOM BLADE Ø DAY 7 | Hellwalker Difficulty</yt-formatted-string>
        </h1>
        <h3 id="yt-live-card" class="yt-lockup-metadata-view-model__heading-reset">
          <span class="live-badge">LIVE</span>
          <a class="yt-lockup-metadata-view-model__title" href="/watch?v=3">How This Man Spent 7 Years Digging a 2-Story Home Inside a Mountain</a>
        </h3>
        <div id="x-dark-tweet" data-testid="tweetText" class="x-tweet">Huge showcase from <a class="r-1cvl2hr" href="https://x.com/FromSoftware">@FromSoftware</a> tonight!</div>
        <p id="lead-para" class="lead-prose"><strong>Lead:</strong> Detailed breakdown of the rendering pipeline.</p>
      </section>
    `;

    const ytCard1 = document.getElementById('yt-card-1')!;
    const ytPolymer = document.getElementById('yt-polymer-card')!;
    const ytWatchH1 = document.getElementById('yt-watch-h1')!;
    const ytLiveCard = document.getElementById('yt-live-card')!;
    const xTweet = document.getElementById('x-dark-tweet')!;
    const leadPara = document.getElementById('lead-para')!;

    const config = createDefaultMarginConfig();
    config.targetLang = 'zh-CN';
    config.webpage.displayMode = 'bilingual';
    config.providers['google-free'].stream = 'on';

    let emitPartial!: () => void;
    const partialGate = new Promise<void>((r) => {
      emitPartial = r;
    });
    let finishStream!: () => void;
    const finishGate = new Promise<void>((r) => {
      finishStream = r;
    });

    const renderer = new WebpageRenderer({
      config,
      getUrl: () => 'https://www.youtube.com/',
      transport: async (req, callbacks) => {
        await partialGate;
        for (const it of req.items) {
          if (it.text.includes('Elden Ring')) {
            callbacks.onItemReady?.({
              id: it.id,
              trans: '<m0>《艾尔登法环》高手挑战',
              partial: true,
            });
          }
        }
        await finishGate;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => {
            if (it.text.includes('Elden Ring')) {
              return { id: it.id, trans: '<m0><m1>《艾尔登法环》高手挑战《影之刃零》</m1></m0>' };
            }
            if (it.text.includes('CYCLING THE WORLD')) {
              return { id: it.id, trans: '<m0>单车环游世界｜获奖探险纪录片</m0>' };
            }
            if (it.text.includes('PHANTOM BLADE')) {
              return { id: it.id, trans: '《影之刃零》第 7 天｜地狱行者难度实况' };
            }
            if (it.text.includes('Digging a 2-Story Home')) {
              return {
                id: it.id,
                trans: '<m0>直播</m0> <m1>这位男子如何花 7 年时间在山体里凿出一栋两层住宅</m1>',
              };
            }
            if (it.text.includes('@FromSoftware')) {
              return { id: it.id, trans: '今晚来自 <m0>@FromSoftware</m0> 的震撼演示！' };
            }
            return { id: it.id, trans: '<m0>导语：</m0>渲染管线的详细解析。' };
          }),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    const translatePromise = renderer.translateWholePage();

    // Stage 1: Loading shimmer inherits effective #f1f1f1 color & 16px font-size instead of 10px black!
    await vi.waitFor(() => {
      const shimmer = ytCard1.querySelector(
        '.margin-trans-loading[data-margin-loading="1"]',
      ) as HTMLElement | null;
      expect(shimmer).not.toBeNull();
      expect(shimmer!.style.getPropertyValue('--margin-effective-color')).toBe(
        'rgb(241, 241, 241)',
      );
      expect(
        shimmer!.style.getPropertyValue('--margin-effective-font-size'),
      ).toBe('16px');
    });

    // Stage 2: Streaming (`paintPartialSlot`) keeps effective #f1f1f1 color & 16px font-size after cssText reset!
    emitPartial();
    await vi.waitFor(() => {
      const streaming = ytCard1.querySelector(
        '.margin-trans-root[data-margin-streaming="1"]',
      ) as HTMLElement | null;
      expect(streaming).not.toBeNull();
      expect(
        streaming!.style.getPropertyValue('--margin-effective-color'),
      ).toBe('rgb(241, 241, 241)');
      expect(
        streaming!.style.getPropertyValue('--margin-effective-font-size'),
      ).toBe('16px');
      expect(
        streaming!.style.getPropertyValue('--margin-effective-line-height'),
      ).toBe('22px');
      expect(
        streaming!.style.getPropertyValue('--margin-effective-font-weight'),
      ).toBe('500');
    });

    // Stage 3: Final rich DOM reconstruction across all card & prose types
    finishStream();
    await translatePromise;

    const card1Root = ytCard1.querySelector('.margin-trans-root') as HTMLElement;
    const card1Link = card1Root.querySelector('a') as HTMLAnchorElement;
    expect(card1Root.style.getPropertyValue('--margin-effective-color')).toBe(
      'rgb(241, 241, 241)',
    );
    expect(
      card1Root.style.getPropertyValue('--margin-effective-font-size'),
    ).toBe('16px');
    expect(card1Link.getAttribute('data-margin-no-underline')).toBe('true');
    expect(card1Link.getAttribute('data-margin-has-link-color')).toBe('true');
    expect(card1Link.style.getPropertyValue('--margin-link-color')).toBe(
      'rgb(241, 241, 241)',
    );

    // Polymer stripped-ID card keeps #f1f1f1 & no-underline instead of global blue `a` rule
    const polymerRoot = ytPolymer.querySelector('.margin-trans-root') as HTMLElement;
    const polymerLink = polymerRoot.querySelector('a') as HTMLAnchorElement;
    expect(polymerLink.hasAttribute('id')).toBe(false);
    expect(polymerLink.getAttribute('data-margin-no-underline')).toBe('true');
    expect(polymerLink.style.getPropertyValue('--margin-link-color')).toBe(
      'rgb(241, 241, 241)',
    );
    expect(
      polymerRoot.style.getPropertyValue('--margin-effective-font-size'),
    ).toBe('14px');

    // Watch H1 > yt-formatted-string
    const watchRoot = ytWatchH1.querySelector('.margin-trans-root') as HTMLElement;
    expect(watchRoot.style.getPropertyValue('--margin-effective-color')).toBe(
      'rgb(241, 241, 241)',
    );
    expect(
      watchRoot.style.getPropertyValue('--margin-effective-font-size'),
    ).toBe('20px');
    expect(
      watchRoot.style.getPropertyValue('--margin-effective-font-weight'),
    ).toBe('700');

    // Sibling LIVE badge + title
    const liveRoot = ytLiveCard.querySelector('.margin-trans-root') as HTMLElement;
    expect(liveRoot.style.getPropertyValue('--margin-effective-color')).toBe(
      'rgb(241, 241, 241)',
    );
    expect(
      liveRoot.style.getPropertyValue('--margin-effective-font-size'),
    ).toBe('16px');

    // X dark tweet with blue @FromSoftware mention + <p><strong>Lead:</strong> body</p>
    const xRoot = xTweet.querySelector('.margin-trans-root') as HTMLElement;
    const xMention = xRoot.querySelector('a') as HTMLAnchorElement;
    expect(xRoot.style.getPropertyValue('--margin-effective-color')).toBe(
      'rgb(231, 233, 234)',
    );
    expect(xMention.style.getPropertyValue('--margin-link-color')).toBe(
      'rgb(29, 155, 240)',
    );
    expect(xMention.getAttribute('data-margin-no-underline')).toBe('true');

    const leadRoot = leadPara.querySelector('.margin-trans-root') as HTMLElement;
    expect(leadRoot.style.getPropertyValue('--margin-effective-color')).toBe(
      'rgb(212, 212, 216)',
    );
    expect(
      leadRoot.style.getPropertyValue('--margin-effective-font-weight'),
    ).toBe('');

    // Switch to `target-only` mode -> still resolves & preserves effective style inside `.margin-orig-source`!
    const targetOnlyCfg = structuredClone(config);
    targetOnlyCfg.webpage.displayMode = 'target-only';
    renderer.updateConfig(targetOnlyCfg);
    expect(card1Root.getAttribute('data-margin-layout')).toBe('replace');
    expect(card1Root.style.getPropertyValue('--margin-effective-color')).toBe(
      'rgb(241, 241, 241)',
    );

    // Live Dark -> Light -> Dark toggle on `html[dark]` updates both effective host color and cloned links!
    document.documentElement.removeAttribute('dark');
    await vi.waitFor(() => {
      expect(card1Root.style.getPropertyValue('--margin-effective-color')).toBe(
        'rgb(15, 15, 15)',
      );
      expect(card1Link.style.getPropertyValue('--margin-link-color')).toBe(
        'rgb(15, 15, 15)',
      );
      expect(polymerLink.style.getPropertyValue('--margin-link-color')).toBe(
        'rgb(15, 15, 15)',
      );
      expect(watchRoot.style.getPropertyValue('--margin-effective-color')).toBe(
        'rgb(15, 15, 15)',
      );
    });

    document.documentElement.setAttribute('dark', '');
    await vi.waitFor(() => {
      expect(card1Root.style.getPropertyValue('--margin-effective-color')).toBe(
        'rgb(241, 241, 241)',
      );
      expect(card1Link.style.getPropertyValue('--margin-link-color')).toBe(
        'rgb(241, 241, 241)',
      );
      expect(polymerLink.style.getPropertyValue('--margin-link-color')).toBe(
        'rgb(241, 241, 241)',
      );
    });

    // Clean stop() / restorePage() removes all injected nodes and disconnects themeObserver
    renderer.stop();
    expect(document.body.querySelectorAll('[data-margin-injected]').length).toBe(0);
    expect(document.body.querySelectorAll('[data-margin-orig-wrap]').length).toBe(0);

    renderer.destroy();
  });

  it('unwraps target-only original text on streaming error, abort, and mid-flight SPA mutation so paragraphs are never left hidden', async () => {
    const config = createDefaultMarginConfig();
    config.webpage.displayMode = 'target-only';
    config.providers['google-free'].stream = 'on';

    // Case A: Streaming emits partial delta (wrapping original text in hidden span), then batch fails -> original text MUST be unwrapped!
    document.body.innerHTML = `<main><p id="err-para">Original paragraph text must remain visible when upstream fails.</p></main>`;
    const errPara = document.getElementById('err-para')!;

    const errRenderer = new WebpageRenderer({
      config,
      transport: async (req, callbacks) => {
        callbacks.onItemReady?.({
          id: req.items[0]!.id,
          trans: '半截流式译文…',
          partial: true,
        });
        // Verify wrapper was mounted during streaming
        expect(errPara.querySelector('[data-margin-orig-wrap="true"]')).not.toBeNull();
        return {
          ok: false,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: [],
          error: {
            code: 'HTTP_502',
            message: 'HTTP 502 Bad Gateway',
            retryable: true,
          },
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    try {
      await errRenderer.translateWholePage();
      expect(errPara.querySelector('[data-margin-orig-wrap="true"]')).toBeNull();
      expect(errPara.textContent).toContain(
        'Original paragraph text must remain visible when upstream fails.',
      );
      expect(errPara.querySelector('.margin-inline-retry')).not.toBeNull();
    } finally {
      errRenderer.destroy();
    }

    // Case B: Streaming emits partial delta, then host SPA mutates source text mid-flight -> stale block unwraps cleanly before re-translation settles!
    document.body.innerHTML = `<main><p id="spa-para">Initial SPA paragraph before client route swap.</p></main>`;
    const spaPara = document.getElementById('spa-para')!;
    let spaPass = 0;
    let resolveSecondSpaPass!: (res: TranslateBatchResponse) => void;

    const spaRenderer = new WebpageRenderer({
      config,
      transport: async (req, callbacks) => {
        spaPass += 1;
        if (spaPass === 1) {
          callbacks.onItemReady?.({
            id: req.items[0]!.id,
            trans: '旧段落流式译文',
            partial: true,
          });
          const origWrap = spaPara.querySelector('[data-margin-orig-wrap="true"]');
          expect(origWrap).not.toBeNull();
          // Simulate SPA mutating underlying text while request #1 is still in-flight
          origWrap!.textContent = 'Updated SPA paragraph after client route swap.';
          return {
            ok: true,
            requestId: req.requestId,
            providerId: 'google-free',
            model: 'gtx',
            items: [{ id: req.items[0]!.id, trans: '旧段落最终译文' }],
            diagnostic: makeMockDiagnostic(),
          };
        }
        return new Promise<TranslateBatchResponse>((resolve) => {
          resolveSecondSpaPass = resolve;
        });
      },
    });

    try {
      await spaRenderer.translateWholePage();
      // Right after stale flight #1 is discarded (and while pass #2 is pending), original updated text MUST be unwrapped and visible!
      expect(spaPara.querySelector('[data-margin-orig-wrap="true"]')).toBeNull();
      expect(spaPara.textContent).toBe('Updated SPA paragraph after client route swap.');

      resolveSecondSpaPass?.({
        ok: true,
        requestId: 'spa-pass-2',
        providerId: 'google-free',
        model: 'gtx',
        items: [{ id: 1, trans: '新路由段落译文' }],
        diagnostic: makeMockDiagnostic(),
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(spaPara.textContent).toContain('新路由段落译文');
    } finally {
      spaRenderer.destroy();
    }
  });

  it('resets inFlightBlocks across restorePage() restarts, wraps trailing inline prose around nested blocks in target-only mode, busts L1 cache on prompt/env edits, and detects pushState URL changes + prunes detached nodes', async () => {
    // 1. Live config restart (`restorePage()` -> `enablePageTranslation()`) while old flight settles asynchronously MUST NOT skip previously in-flight blocks!
    const config = createDefaultMarginConfig();
    config.targetLang = 'zh-CN';
    config.providers['openai-prompt'] = {
      ...config.providers['google-free'],
      id: 'openai-prompt',
      name: 'OpenAI Prompt Test',
      preset: 'openai',
      protocol: 'openai-chat',
      assistantId: 'builtin-yaml',
    };
    config.routing.webpage = 'openai-prompt';

    document.body.innerHTML = `<main><p id="restart-para">Speculative execution requires deterministic generation fencing across restarts.</p></main>`;
    const restartPara = document.getElementById('restart-para')!;

    let callIdx = 0;
    let resolveStaleFlight!: (res: TranslateBatchResponse) => void;
    const seenToLangs: string[] = [];

    const restartRenderer = new WebpageRenderer({
      config,
      transport: (req) => {
        callIdx += 1;
        seenToLangs.push(req.toLang);
        if (callIdx === 1) {
          // Simulate non-streaming request that settles asynchronously AFTER restorePage() + enablePageTranslation()
          return new Promise<TranslateBatchResponse>((resolve) => {
            resolveStaleFlight = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          requestId: req.requestId,
          providerId: 'openai-prompt',
          model: 'gpt-4o-mini',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `[${req.toLang}#${callIdx}] 确定性代际隔离译文`,
          })),
          diagnostic: makeMockDiagnostic(),
        });
      },
    });

    restartRenderer.enablePageTranslation();
    expect(seenToLangs).toEqual(['zh-CN']);

    // Switch targetLang while call #1 is still in-flight -> triggers synchronous restorePage() + enablePageTranslation()
    const jaCfg = structuredClone(config);
    jaCfg.targetLang = 'ja';
    restartRenderer.updateConfig(jaCfg);

    // Block MUST be immediately re-dispatched for `ja` instead of skipped by stale `inFlightBlocks`!
    expect(seenToLangs).toEqual(['zh-CN', 'ja']);
    await new Promise((r) => setTimeout(r, 15));

    // Now settle the stale flight #1 -> sessionGen guard prevents corrupting the active `ja` session!
    resolveStaleFlight({
      ok: true,
      requestId: 'stale-1',
      providerId: 'openai-prompt',
      model: 'gpt-4o-mini',
      items: [{ id: 1, trans: '过期中文译文' }],
      diagnostic: makeMockDiagnostic(),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(restartPara.textContent).toContain('[ja#2] 确定性代际隔离译文');

    // 2. Editing assistant prompt or `env` busts both `computeTranslationConfigSignature` and renderer L1 LRU cache!
    const editedPromptCfg = structuredClone(jaCfg);
    editedPromptCfg.assistants['builtin-yaml'].prompt += '\n# Custom editorial tone';
    editedPromptCfg.assistants['builtin-yaml'].env.custom_macro = 'preserve-idioms';
    restartRenderer.updateConfig(editedPromptCfg);
    await new Promise((r) => setTimeout(r, 15));

    expect(callIdx).toBe(3);
    expect(restartPara.textContent).toContain('[ja#3] 确定性代际隔离译文');
    restartRenderer.destroy();

    // 3. Mixed container `<div>Intro <p>Nested</p> Trailing</div>` in target-only mode wraps BOTH inline runs and restores exact order
    const targetOnlyCfg = createDefaultMarginConfig();
    targetOnlyCfg.webpage.displayMode = 'target-only';
    document.body.innerHTML = `<main><div id="mixed-box">Introductory clause before nested block. <p id="nested-p">Nested child paragraph inside container.</p> Trailing clause after nested block.</div></main>`;
    const mixedBox = document.getElementById('mixed-box')!;

    const mixedRenderer = new WebpageRenderer({
      config: targetOnlyCfg,
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: req.items.map((it) => ({
          id: it.id,
          trans: `替换译文：${it.text.slice(0, 18)}`,
        })),
        diagnostic: makeMockDiagnostic(),
      }),
    });

    await mixedRenderer.translateWholePage();
    const directWrappers = Array.from(mixedBox.children).filter(
      (el) => el.getAttribute('data-margin-orig-wrap') === 'true',
    );
    expect(directWrappers.length).toBeGreaterThanOrEqual(2);
    expect(directWrappers.map((w) => w.textContent?.trim())).toEqual([
      'Introductory clause before nested block.',
      'Trailing clause after nested block.',
    ]);

    mixedRenderer.restorePage();
    expect(mixedBox.querySelectorAll('[data-margin-orig-wrap="true"]')).toHaveLength(0);
    expect(mixedBox.textContent).toBe(
      'Introductory clause before nested block. Nested child paragraph inside container. Trailing clause after nested block.',
    );

    // 4. Virtualized feed DOM removal prunes detached nodes cleanly
    await mixedRenderer.translateWholePage();
    mixedBox.remove();
    expect(mixedRenderer.getPageState().translatedBlocks).toBe(0);
    mixedRenderer.destroy();

    // 5. MarginContentController detects SPA `pushState` URL change to excluded domain without `popstate`
    let simulatedUrl = 'https://x.com/explore';
    document.body.innerHTML = `<main id="spa-feed"><p>Foreign English article paragraph ready for automatic translation.</p></main>`;
    const spaCtrl = new MarginContentController({
      config: createDefaultMarginConfig(),
      getUrl: () => simulatedUrl,
      warmup: async () => ({ ok: true }),
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: req.items.map((it) => ({ id: it.id, trans: `译：${it.text}` })),
        diagnostic: makeMockDiagnostic(),
      }),
    });
    spaCtrl.mount();
    await new Promise((r) => setTimeout(r, 15));
    expect(spaCtrl.renderer.isActive).toBe(true);

    // Simulate SPA forward pushState to an excluded URL + external DOM mutation (no popstate/hashchange!)
    simulatedUrl = 'https://linux.do/t/topic/12345';
    const nextRouteNode = document.createElement('p');
    nextRouteNode.textContent = 'Navigated via pushState to excluded community route.';
    document.getElementById('spa-feed')!.appendChild(nextRouteNode);
    await new Promise((r) => setTimeout(r, 20));

    expect(spaCtrl.renderer.isActive).toBe(false);
    spaCtrl.destroy();
  });

  it('rolls back provisional streamed slots on TRUNCATED_RESPONSE, detects bare #text appended in target-only mode, and honors targetActive idempotency', async () => {
    const config = createDefaultMarginConfig();
    config.webpage.displayMode = 'target-only';
    document.body.innerHTML = `<article><p id="trunc-p">Streaming sentence that drops mid-flight before EOF.</p></article>`;
    const para = document.getElementById('trunc-p')!;

    let attempt = 0;
    const renderer = new WebpageRenderer({
      config,
      getUrl: () => 'https://example.com/article',
      transport: async (req, callbacks) => {
        attempt += 1;
        if (attempt === 1) {
          // Emit item #1 provisionally, then abort stream with TRUNCATED_RESPONSE
          callbacks?.onItemReady?.({ id: 1, trans: '截断前的半截流式译文' });
          return {
            ok: false,
            requestId: req.requestId,
            providerId: 'openai',
            model: 'gpt-4.1-mini',
            items: [],
            error: {
              code: 'TRUNCATED_RESPONSE',
              message: 'SSE stream ended prematurely before completion.',
              retryable: true,
            },
            diagnostic: makeMockDiagnostic(),
          };
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'openai',
          model: 'gpt-4.1-mini',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `完整译文：${it.text}`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    await renderer.translateWholePage();

    // 1. Provisional slot 1 was rolled back (NOT left mounted or poisoned in L1 cache) and retry pill mounted!
    expect(para.querySelector('.margin-trans-root')).toBeNull();
    expect(para.querySelector('[data-margin-orig-wrap="true"]')).toBeNull();
    const retryBtn = para.querySelector(
      'button.margin-inline-retry',
    ) as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();

    // 2. Clicking retry re-fetches upstream (not served from poisoned L1 cache) and mounts full translation!
    retryBtn!.click();
    await vi.waitFor(() => {
      expect(para.querySelector('.margin-trans-root')?.textContent).toBe(
        '完整译文：Streaming sentence that drops mid-flight before EOF.',
      );
    });
    expect(attempt).toBe(2);

    // 3. In `target-only` mode, appending a bare `#text` node directly onto `para` outside `[data-margin-orig-wrap]` is detected!
    renderer.enablePageTranslation();
    para.appendChild(document.createTextNode(' Newly appended live clause.'));
    await vi.waitFor(() => {
      expect(para.querySelector('.margin-trans-root')?.textContent).toBe(
        '完整译文：Streaming sentence that drops mid-flight before EOF. Newly appended live clause.',
      );
    });
    renderer.destroy();

    // 4. `margin:cmd:toggle-page` with `targetActive: true` is an idempotent no-op when already active!
    document.body.innerHTML = `<main><p>Idempotent targetActive paragraph for site rule verification.</p></main>`;
    const ctrl = new MarginContentController({
      config: createDefaultMarginConfig(),
      getUrl: () => 'https://news.ycombinator.com/item?id=1',
      warmup: async () => ({ ok: true }),
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: req.items.map((it) => ({ id: it.id, trans: `译：${it.text}` })),
        diagnostic: makeMockDiagnostic(),
      }),
    });
    ctrl.mount();
    await ctrl.handleCommand(
      { type: 'margin:cmd:toggle-page', targetActive: true },
      'cmd',
    );
    expect(ctrl.renderer.isActive).toBe(true);
    // Second `targetActive: true` MUST keep page active (never toggle OFF!)
    const secondRes = await ctrl.handleCommand(
      { type: 'margin:cmd:toggle-page', targetActive: true },
      'cmd',
    );
    expect(secondRes).toBe(true);
    expect(ctrl.renderer.isActive).toBe(true);
    ctrl.destroy();
  });

  it('v2.3.6: hides X tweetText in target-only via CSS without reparenting host children (zero NotFoundError on React removeChild/insertBefore) and keeps bilingual root last after appends', async () => {
    const config = createDefaultMarginConfig();
    config.webpage.displayMode = 'target-only';

    expect(WEBPAGE_INJECTED_CSS).toContain(
      '[data-margin-src-hidden="true"] > :not([data-margin-injected]):not([data-margin-host])',
    );

    const tweet = document.createElement('div');
    tweet.setAttribute('data-testid', 'tweetText');
    tweet.style.whiteSpace = 'pre-wrap';

    const spanIntro = document.createElement('span');
    spanIntro.textContent = 'We partnered with ';
    const mentionDiv = document.createElement('div');
    mentionDiv.className = 'css-175oi2r r-xoduu5';
    mentionDiv.innerHTML =
      '<span class="css-1jxf684"><a role="link" href="/AnthropicAI">@AnthropicAI</a></span>';
    const spanTail = document.createElement('span');
    spanTail.textContent =
      ' to eliminate React reconciliation crashes when expanding truncated posts…';

    tweet.append(spanIntro, mentionDiv, spanTail);
    document.body.appendChild(tweet);

    const renderer = new WebpageRenderer({
      config,
      getUrl: () => 'https://x.com/home',
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: req.items.map((it) => ({
          id: it.id,
          trans: it.text.includes('expanded')
            ? '<m0>我们与 </m0><m1><m2>@AnthropicAI</m2></m1><m3> 合作彻底消除了展开长帖时的 React 节点重排异常，并完整展示全文。</m3>'
            : '<m0>我们与 </m0><m1><m2>@AnthropicAI</m2></m1><m3> 合作消除了展开截断帖子时的异常……</m3>',
        })),
        diagnostic: makeMockDiagnostic(),
      }),
    });

    renderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(tweet.querySelector('.margin-trans-root')?.textContent).toContain(
        '@AnthropicAI',
      );
    });

    // 1. Zero reparenting: every host child keeps `parentNode === tweet`
    expect(tweet.getAttribute('data-margin-src-hidden')).toBe('true');
    expect(tweet.querySelector('[data-margin-orig-wrap="true"]')).toBeNull();
    expect(spanIntro.parentNode).toBe(tweet);
    expect(mentionDiv.parentNode).toBe(tweet);
    expect(spanTail.parentNode).toBe(tweet);

    // 2. React Fiber reconciliation: removeChild(spanTail), insertBefore, and appendChild NEVER throw NotFoundError!
    const expandedSpan = document.createElement('span');
    expandedSpan.textContent =
      ' to eliminate React reconciliation crashes when expanding truncated posts into full essays.';
    expect(() => {
      tweet.removeChild(spanTail);
      tweet.insertBefore(expandedSpan, tweet.querySelector('.margin-trans-root'));
    }).not.toThrow();

    const appendedAfterRoot = document.createElement('span');
    appendedAfterRoot.textContent = ' Bonus expanded tail.';
    tweet.appendChild(appendedAfterRoot);
    expect(
      appendedAfterRoot.matches(
        '[data-margin-src-hidden="true"] > :not([data-margin-injected]):not([data-margin-host])',
      ),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(tweet.querySelector('.margin-trans-root')?.textContent).toContain(
        '并完整展示全文',
      );
    });

    // 3. Switch to bilingual -> root is asserted as last child even after React-style appends!
    const biCfg = structuredClone(config);
    biCfg.webpage.displayMode = 'bilingual';
    renderer.updateConfig(biCfg);
    expect(tweet.hasAttribute('data-margin-src-hidden')).toBe(false);
    const rootAfterBi = tweet.querySelector('.margin-trans-root')!;
    expect(tweet.lastElementChild).toBe(rootAfterBi);

    renderer.destroy();
  });

  it('v2.3.6: reuses completed P1 with zero network items & preserved node identity, pins mid-paragraph boundary with zero blank flash and monotonic overtake, and never caches visual pins', async () => {
    const config = createDefaultMarginConfig();
    config.providers['google-free'].stream = 'on';

    const p1Text =
      'First complete paragraph on timeline describing deterministic per-segment cache keys.';
    const p2Collapsed =
      'Second boundary paragraph starts with a detailed architectural overview of streaming monotonic handoff…';
    const p2Expanded =
      'Second boundary paragraph starts with a detailed architectural overview of streaming monotonic handoff across 600-character segments so the reader never witnesses a single blank frame or shrinking partial delta while reading long essays, with clickable <a href="https://margin.dev/spec">full specification</a> and benchmarks proving sub-frame stability under continuous load and high-concurrency token delivery across modern browsers, desktop viewports, and virtualized social timelines worldwide today in production environments operating at global scale with deterministic segment-level caching.';
    const p3Expanded =
      'Third newly revealed paragraph appended below the boundary segment after Show more.';

    const tweet = document.createElement('div');
    tweet.setAttribute('data-testid', 'tweetText');
    tweet.style.whiteSpace = 'pre-wrap';
    tweet.innerHTML = `<span>${p1Text}</span>\n\n<span>${p2Collapsed}</span>`;
    document.body.appendChild(tweet);

    const requestedBatches: string[][] = [];
    let releaseExpanded!: () => void;
    const expandedGate = new Promise<void>((resolve) => {
      releaseExpanded = resolve;
    });
    let capturedCallbacks: Parameters<
      NonNullable<ConstructorParameters<typeof WebpageRenderer>[0]['transport']>
    >[1] | null = null;

    const renderer = new WebpageRenderer({
      config,
      getUrl: () => 'https://x.com/home',
      isUserActivationActive: () => true,
      transport: async (req, callbacks) => {
        requestedBatches.push(req.items.map((i) => i.text));
        const isExpandedWave = req.items.some(
          (i) => i.text.includes('600-character') || i.text.includes('Third newly'),
        );
        if (!isExpandedWave) {
          return {
            ok: true,
            requestId: req.requestId,
            providerId: 'google-free',
            model: 'gtx',
            items: req.items.map((it) => ({
              id: it.id,
              trans: it.text.includes('First complete')
                ? '<m0>第一段完整时间线译文：确定性分段缓存键。</m0>'
                : '<m0>第二段截断预览译文：流式单调接力架构概述……</m0>',
            })),
            diagnostic: makeMockDiagnostic(),
          };
        }

        if (req.items.some((i) => i.text.includes('600-character'))) {
          capturedCallbacks = callbacks;
        }
        await expandedGate;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: it.text.includes('600-character')
              ? '<m0>第二段完整展开译文：流式单调接力架构横跨六百字符长段落，读者全程零闪白并可点击<m1>完整技术规范</m1>查看基准测试。</m0>'
              : '<m0>第三段新展开译文：紧随边界段之后顺滑向下揭露。</m0>',
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    renderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(tweet.querySelectorAll('.margin-trans-seg')).toHaveLength(2);
    });

    const root = tweet.querySelector('.margin-trans-root') as HTMLElement;
    const [seg0Before, seg1Before] = Array.from(
      root.querySelectorAll<HTMLElement>('.margin-trans-seg'),
    );
    expect(seg0Before.textContent).toBe(
      '第一段完整时间线译文：确定性分段缓存键。',
    );
    expect(seg1Before.textContent).toBe(
      '第二段截断预览译文：流式单调接力架构概述……',
    );
    const pinnedLen = seg1Before.textContent!.length;

    // Attach MutationObserver on `root` BEFORE clicking Show more to verify zero blank & monotonic length!
    let sawEmptyRoot = false;
    let sawLoadingNode = false;
    const observedSeg1Lengths: number[] = [];
    const rootMo = new MutationObserver(() => {
      if (!(root.textContent ?? '').trim()) {
        sawEmptyRoot = true;
      }
      if (tweet.querySelector('.margin-trans-loading')) {
        sawLoadingNode = true;
      }
      const curSeg1 = root.querySelectorAll('.margin-trans-seg')[1];
      if (curSeg1) {
        observedSeg1Lengths.push((curSeg1.textContent ?? '').length);
      }
    });
    rootMo.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    requestedBatches.length = 0;

    // Simulate X in-place Show more expanding P2 (> 480 chars) and appending P3
    tweet.innerHTML = `<span>${p1Text}</span>\n\n<span>${p2Expanded}</span>\n\n<span>${p3Expanded}</span>`;
    tweet.appendChild(root); // Keep existing root attached as React mutates sibling spans

    await vi.waitFor(() => {
      expect(capturedCallbacks).not.toBeNull();
    });

    // 1. P1 sent ZERO network items, and P1's exact DOM node identity is preserved!
    const allExpandedRequestedTexts = requestedBatches.flat();
    expect(
      allExpandedRequestedTexts.some((t) => t.includes('First complete')),
    ).toBe(false);
    const seg0DuringPin = root.querySelectorAll('.margin-trans-seg')[0];
    expect(seg0DuringPin).toBe(seg0Before);
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('.margin-trans-tail-shimmer')).not.toBeNull();
    expect(tweet.lastElementChild).toBe(root);

    // 2. Partials shorter than `pinnedPlain.length + 6` MUST be ignored (DOM untouched!)
    const seg1DuringPin = root.querySelectorAll('.margin-trans-seg')[1]!;
    expect(seg1DuringPin.textContent).toBe(
      '第二段截断预览译文：流式单调接力架构概述……',
    );
    capturedCallbacks!.onItemReady?.({
      id: 1,
      trans: '第二段完整',
      partial: true,
    });
    expect(seg1DuringPin.textContent).toBe(
      '第二段截断预览译文：流式单调接力架构概述……',
    );

    // 3. Overtake past `pinnedLen + 6` updates segment, and subsequent shorter partial is dropped!
    const overtakePartial =
      '第二段完整展开译文：流式单调接力架构横跨六百字符长段落，已经超越旧截断点的流式预览文本';
    expect(overtakePartial.length).toBeGreaterThanOrEqual(pinnedLen + 6);
    capturedCallbacks!.onItemReady?.({
      id: 1,
      trans: overtakePartial,
      partial: true,
    });
    expect(seg1DuringPin.textContent).toBe(overtakePartial);

    // Emit shorter partial after overtake -> MUST NOT shrink painted text!
    capturedCallbacks!.onItemReady?.({
      id: 1,
      trans: overtakePartial.slice(0, overtakePartial.length - 8),
      partial: true,
    });
    expect(seg1DuringPin.textContent).toBe(overtakePartial);

    // 4. Release final response -> rich clickable `<a>` hydrated, P3 revealed in order, tail shimmer removed!
    releaseExpanded();
    await vi.waitFor(() => {
      expect(root.querySelectorAll('.margin-trans-seg')).toHaveLength(3);
      expect(root.hasAttribute('aria-busy')).toBe(false);
    });
    rootMo.disconnect();

    expect(sawEmptyRoot).toBe(false);
    expect(sawLoadingNode).toBe(false);
    for (let i = 1; i < observedSeg1Lengths.length; i++) {
      // Only allow non-decreasing length during overtake/streaming before final rich commit
      if (i < observedSeg1Lengths.length - 1) {
        expect(observedSeg1Lengths[i]).toBeGreaterThanOrEqual(
          observedSeg1Lengths[i - 1]!,
        );
      }
    }

    expect(root.querySelector('.margin-trans-tail-shimmer')).toBeNull();
    const specLink = root.querySelector('a');
    expect(specLink?.getAttribute('href')).toBe('https://margin.dev/spec');
    expect(specLink?.textContent).toBe('完整技术规范');
    expect(root.textContent).toContain('\n\n第三段新展开译文');

    renderer.destroy();
  });

  it('v2.3.6: gates Wave 0 VIP priority (-1) on user activation, aborts exclusive superseded batches while caching late shared-batch items, and streams 30-paragraph 12,000-char essays in order', async () => {
    // Part A: Priority gating (-1 with user activation vs 0 without user activation)
    let userActivated = true;
    const recordedPriorities: number[] = [];
    const cfg = createDefaultMarginConfig();

    const prioTweet = document.createElement('div');
    prioTweet.setAttribute('data-testid', 'tweetText');
    prioTweet.style.whiteSpace = 'pre-wrap';
    const previewA =
      'Opening preview paragraph before user clicks Show more on timeline…';
    prioTweet.innerHTML = `<span>${previewA}</span>`;
    document.body.appendChild(prioTweet);

    const prioRenderer = new WebpageRenderer({
      config: cfg,
      isUserActivationActive: () => userActivated,
      transport: async (req) => {
        recordedPriorities.push(req.priority ?? 0);
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({ id: it.id, trans: `译：${it.text}` })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    prioRenderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(prioTweet.querySelector('.margin-trans-root')).not.toBeNull();
    });
    recordedPriorities.length = 0;

    // Expand into 6 paragraphs (> 800 chars across multiple progressive waves) WITH user activation -> Wave 0 is `-1`, Wave 1+ is `0`!
    const sixParas = Array.from(
      { length: 6 },
      (_, idx) =>
        idx === 0
          ? 'Opening preview paragraph before user clicks Show more on timeline, now expanded with 320 chars of detailed benchmark data. '.repeat(
              2,
            )
          : `Expanded paragraph #${idx + 1} with 280 characters of technical explanation for multi-wave batching verification. `.repeat(
              2,
            ),
    );
    prioTweet.innerHTML = sixParas.map((p) => `<span>${p}</span>`).join('\n\n');

    await vi.waitFor(() => {
      expect(
        prioTweet.querySelectorAll('.margin-trans-seg').length,
      ).toBe(6);
    });
    expect(recordedPriorities.length).toBeGreaterThanOrEqual(2);
    expect(recordedPriorities[0]).toBe(-1);
    expect(recordedPriorities.slice(1).every((p) => p === 0)).toBe(true);

    // Expand AGAIN with `userActivated = false` (e.g. live AI stream growth) -> ALL waves go at `0`!
    userActivated = false;
    recordedPriorities.length = 0;
    const eightParas = [
      ...sixParas.slice(0, 5),
      `${sixParas[5]} Additional live-streamed sentence appended automatically without click.`,
      'Seventh live-streamed paragraph arriving without user gesture.',
      'Eighth live-streamed paragraph arriving without user gesture.',
    ];
    prioTweet.innerHTML = eightParas.map((p) => `<span>${p}</span>`).join('\n\n');
    await vi.waitFor(() => {
      expect(
        prioTweet.querySelectorAll('.margin-trans-seg').length,
      ).toBe(8);
    });
    expect(recordedPriorities.length).toBeGreaterThanOrEqual(1);
    expect(recordedPriorities.every((p) => p === 0)).toBe(true);
    prioRenderer.destroy();

    // Part B: Supersede aborts exclusive batches while letting shared batches finish & cache without painting stale DOM
    document.body.innerHTML = '';
    const sharedTweetA = document.createElement('div');
    sharedTweetA.setAttribute('data-testid', 'tweetText');
    sharedTweetA.style.whiteSpace = 'pre-wrap';
    const sharedOrigTextA =
      'Shared batch tweet A collapsed preview text before immediate expansion…';
    sharedTweetA.innerHTML = `<span>${sharedOrigTextA}</span>`;

    const sharedTweetB = document.createElement('div');
    sharedTweetB.setAttribute('data-testid', 'tweetText');
    sharedTweetB.style.whiteSpace = 'pre-wrap';
    sharedTweetB.innerHTML =
      '<span>Shared batch tweet B independent post that must still finish cleanly.</span>';
    document.body.append(sharedTweetA, sharedTweetB);

    let sharedSignal!: AbortSignal;
    let resolveSharedBatch!: (res: TranslateBatchResponse) => void;
    let exclusivePlanSignal!: AbortSignal;
    let resolveExclusivePlanBatch!: (res: TranslateBatchResponse) => void;
    let supCall = 0;

    const supRenderer = new WebpageRenderer({
      config: createDefaultMarginConfig(),
      transport: (req, _cb, signal) => {
        supCall += 1;
        if (supCall === 1) {
          // Shared batch containing [sharedTweetA, sharedTweetB]
          sharedSignal = signal;
          return new Promise<TranslateBatchResponse>((resolve) => {
            resolveSharedBatch = resolve;
          });
        }
        if (supCall === 2) {
          // Exclusive batch for sharedTweetA's first expansion plan
          exclusivePlanSignal = signal;
          return new Promise<TranslateBatchResponse>((resolve) => {
            resolveExclusivePlanBatch = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `最终二次展开译文：${it.text.slice(0, 24)}`,
          })),
          diagnostic: makeMockDiagnostic(),
        });
      },
    });

    const initialSupPromise = supRenderer.translateBlocks(
      [sharedTweetA, sharedTweetB],
      'webpage',
    );
    expect(supCall).toBe(1);

    // 1. Expand sharedTweetA while shared batch #1 ([A, B]) is in flight -> sharedSignal MUST NOT abort!
    sharedTweetA.innerHTML =
      '<span>Shared batch tweet A collapsed preview text before immediate expansion into two paragraphs.</span>\n\n<span>Paragraph two of first expansion.</span>';
    void supRenderer.translateBlocks([sharedTweetA], 'webpage');
    expect(sharedSignal.aborted).toBe(false);
    expect(supCall).toBe(2);

    // 2. Expand sharedTweetA a SECOND time while exclusive plan batch #2 is in flight -> exclusivePlanSignal MUST abort!
    sharedTweetA.innerHTML =
      '<span>Shared batch tweet A collapsed preview text before immediate expansion into two paragraphs and further details.</span>\n\n<span>Paragraph two of second expansion.</span>\n\n<span>Paragraph three of second expansion.</span>';
    await supRenderer.translateBlocks([sharedTweetA], 'webpage');
    expect(exclusivePlanSignal.aborted).toBe(true);
    resolveExclusivePlanBatch({
      ok: false,
      requestId: 'aborted-2',
      providerId: 'google-free',
      model: 'gtx',
      items: [],
      diagnostic: makeMockDiagnostic(),
    });

    // 3. Now resolve shared batch #1 late: tweetB paints, tweetA's old preview is cached in L1 but NEVER overwrites tweetA's expanded DOM!
    const cacheSizeBeforeLate = supRenderer.cache.size;
    resolveSharedBatch({
      ok: true,
      requestId: 'shared-1',
      providerId: 'google-free',
      model: 'gtx',
      items: [
        { id: 1, trans: '迟到的旧预览译文（绝不能覆盖已展开DOM）' },
        { id: 2, trans: '共享批次推文 B 正常渲染译文' },
      ],
      diagnostic: makeMockDiagnostic(),
    });
    await initialSupPromise;

    expect(sharedTweetB.querySelector('.margin-trans-root')?.textContent).toBe(
      '共享批次推文 B 正常渲染译文',
    );
    expect(
      sharedTweetA.querySelector('.margin-trans-root')?.textContent,
    ).not.toContain('迟到的旧预览译文');
    expect(
      sharedTweetA.querySelectorAll('.margin-trans-seg'),
    ).toHaveLength(3);
    expect(supRenderer.cache.size).toBeGreaterThan(cacheSizeBeforeLate);
    supRenderer.destroy();

    // Part C: 30-paragraph, >12,000-char X Essay progressive batching & strict in-order reveal
    document.body.innerHTML = '';
    const essayCfg = createDefaultMarginConfig();
    essayCfg.providers['google-free'].maxCharsPerBatch = 2600;
    const essay = document.createElement('div');
    essay.setAttribute('data-testid', 'tweetText');
    essay.style.whiteSpace = 'pre-wrap';
    const essayParas = Array.from({ length: 30 }, (_, idx) => {
      const filler = `Essay section ${idx + 1} explores distributed consensus, speculative decoding, and zero-flicker DOM reconciliation in browser extensions. `;
      return filler.repeat(4).trim(); // ~540 chars * 30 = ~16,200 chars (> 12,000 chars)
    });
    essay.innerHTML = essayParas.map((p) => `<span>${p}</span>`).join('\n\n');
    document.body.appendChild(essay);
    expect(essay.textContent!.length).toBeGreaterThan(12000);

    const essayBatchSizes: number[] = [];
    let batchCounter = 0;
    let releaseFirstBatch!: () => void;
    const firstBatchGate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });

    const essayRenderer = new WebpageRenderer({
      config: essayCfg,
      transport: async (req) => {
        batchCounter += 1;
        const thisBatchIdx = batchCounter;
        const totalChars = req.items.reduce((s, i) => s + i.text.length, 0);
        essayBatchSizes.push(totalChars);
        if (thisBatchIdx === 1) {
          // Hold Wave 0 so Wave 1+ finishes EARLIER out-of-order!
          await firstBatchGate;
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => {
            const matchNum = /Essay section (\d+)/.exec(it.text);
            return {
              id: it.id,
              trans: `<m0>长文第 ${matchNum?.[1] ?? '?'} 段译文。</m0>`,
            };
          }),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    const essayDonePromise = essayRenderer.translateWholePage();
    await new Promise((r) => setTimeout(r, 20));

    // Multiple batches dispatched, each strictly <= maxCharsPerBatch (2600)
    expect(essayBatchSizes.length).toBeGreaterThanOrEqual(6);
    for (const chars of essayBatchSizes) {
      expect(chars).toBeLessThanOrEqual(2600);
    }

    // While Batch 1 (Wave 0: sections 1..) is held, later sections MUST NOT appear out-of-order!
    expect(essay.querySelectorAll('.margin-trans-seg')).toHaveLength(0);

    releaseFirstBatch();
    await essayDonePromise;

    const renderedSegs = Array.from(
      essay.querySelectorAll('.margin-trans-seg'),
    ).map((el) => el.textContent);
    expect(renderedSegs).toHaveLength(30);
    expect(renderedSegs[0]).toBe('长文第 1 段译文。');
    expect(renderedSegs[29]).toBe('长文第 30 段译文。');

    const pillHost = document.querySelector('[data-margin-host="page-status"]');
    const pillLabel =
      pillHost?.shadowRoot?.querySelector('.label')?.textContent ?? '';
    expect(pillLabel).toContain('30');

    essayRenderer.destroy();
  });

  it('v2.3.6: handles partial failure (done segments stay, single retry button, target-only un-hides source), cross-route /home -> /status carryover, display-mode flip & hover toggle during pin across all 4 themes', async () => {
    // Part A: Partial failure in target-only mode
    const failCfg = createDefaultMarginConfig();
    failCfg.webpage.displayMode = 'target-only';
    failCfg.providers['google-free'].maxBatchCount = 1; // 1 segment per batch

    const failTweet = document.createElement('div');
    failTweet.setAttribute('data-testid', 'tweetText');
    failTweet.style.whiteSpace = 'pre-wrap';
    failTweet.innerHTML =
      '<span>First segment succeeds cleanly on initial pass.</span>\n\n<span>Second segment fails once with 503 then recovers on retry.</span>';
    document.body.appendChild(failTweet);

    let seg2Tries = 0;
    const failRequests: string[][] = [];
    const failRenderer = new WebpageRenderer({
      config: failCfg,
      transport: async (req) => {
        failRequests.push(req.items.map((i) => i.text));
        if (req.items[0]?.text.includes('Second segment')) {
          seg2Tries += 1;
          if (seg2Tries === 1) {
            return {
              ok: false,
              requestId: req.requestId,
              providerId: 'google-free',
              model: 'gtx',
              items: [],
              error: {
                code: 'HTTP_503',
                message: 'Overloaded',
                retryable: true,
              },
              diagnostic: makeMockDiagnostic(),
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
            trans: `<m0>已译：${it.text.slice(4, 24)}</m0>`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    await failRenderer.translateWholePage();

    // Segment 1 stays rendered; ONE retry button inside root; `target-only` un-hid source!
    const failRoot = failTweet.querySelector('.margin-trans-root')!;
    expect(failRoot.querySelectorAll('.margin-trans-seg')).toHaveLength(1);
    expect(failRoot.querySelectorAll('button.margin-inline-retry')).toHaveLength(
      1,
    );
    expect(failTweet.hasAttribute('data-margin-src-hidden')).toBe(false);

    // Click retry -> re-dispatches ONLY failed Segment 2 at priority 0, then re-hides source in target-only!
    failRequests.length = 0;
    (failRoot.querySelector('button.margin-inline-retry') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(failRoot.querySelectorAll('.margin-trans-seg')).toHaveLength(2);
    });
    expect(failRequests).toHaveLength(1);
    expect(failRequests[0]?.[0]).toContain('Second segment');
    expect(failRoot.querySelector('button.margin-inline-retry')).toBeNull();
    expect(failTweet.getAttribute('data-margin-src-hidden')).toBe('true');
    failRenderer.destroy();

    // Part B: Cross-route `/home` -> `/status/<id>` carryover + mid-pin display-mode flip + all 4 themes + hover toggle + restorePage
    document.body.innerHTML = '';
    let currentUrl = 'https://x.com/home';
    const routeCfg = createDefaultMarginConfig();
    routeCfg.webpage.displayMode = 'bilingual';

    const homePreviewText =
      'Cross-route timeline post from @AnthropicAI introducing deterministic segment caching, prefix-pinned monotonic handoff, and React-safe CSS source hiding across long-form threads…';
    const statusFullSeg1 =
      'Cross-route timeline post from @AnthropicAI introducing deterministic segment caching, prefix-pinned monotonic handoff, and React-safe CSS source hiding across long-form threads and status detail views.';
    const statusFullSeg2 =
      'Second paragraph on the /status/98765 detail route explaining zero-network display-mode toggles.';

    const homeTweet = document.createElement('div');
    homeTweet.setAttribute('data-testid', 'tweetText');
    homeTweet.style.whiteSpace = 'pre-wrap';
    homeTweet.innerHTML = `<span>${homePreviewText}</span>`;
    document.body.appendChild(homeTweet);

    let releaseStatusTransport!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatusTransport = resolve;
    });

    const routeRenderer = new WebpageRenderer({
      config: routeCfg,
      getUrl: () => currentUrl,
      transport: async (req) => {
        if (currentUrl.includes('/status/')) {
          await statusGate;
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: it.text.includes('Second paragraph')
              ? '<m0>详情页第二段完整译文。</m0>'
              : it.text.includes('status detail views')
                ? '<m0>跨路由详情页首段完整译文。</m0>'
                : '<m0>主页时间线截断预览译文……</m0>',
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    routeRenderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(homeTweet.querySelector('.margin-trans-root')?.textContent).toBe(
        '主页时间线截断预览译文……',
      );
    });

    // Navigate SPA to `/AnthropicAI/status/98765` — mount brand-new DOM node while transport is gated!
    currentUrl = 'https://x.com/AnthropicAI/status/98765';
    homeTweet.remove();
    const statusTweet = document.createElement('div');
    statusTweet.setAttribute('data-testid', 'tweetText');
    statusTweet.style.whiteSpace = 'pre-wrap';
    statusTweet.innerHTML = `<span>${statusFullSeg1}</span>\n\n<span>${statusFullSeg2}</span>`;
    document.body.appendChild(statusTweet);
    routeRenderer.rescanSubtree(document.body);

    // BEFORE `statusGate` resolves, the new `/status/98765` element MUST already display the pinned `/home` translation!
    await vi.waitFor(() => {
      expect(statusTweet.querySelector('.margin-trans-root')?.textContent).toBe(
        '主页时间线截断预览译文……',
      );
    });
    const statusRoot = statusTweet.querySelector(
      '.margin-trans-root',
    ) as HTMLElement;
    expect(statusRoot.getAttribute('aria-busy')).toBe('true');

    // Flip displayMode (`bilingual` -> `target-only` -> `bilingual`) AND cycle all 4 themes mid-revalidation!
    for (const theme of ['none', 'mask', 'opacity', 'weakening'] as const) {
      const next = structuredClone(routeCfg);
      next.webpage.theme = theme;
      next.webpage.displayMode =
        theme === 'mask' || theme === 'opacity' ? 'target-only' : 'bilingual';
      routeRenderer.updateConfig(next);
      expect(statusRoot.getAttribute('data-margin-theme')).toBe(theme);
      if (next.webpage.displayMode === 'target-only') {
        expect(statusTweet.getAttribute('data-margin-src-hidden')).toBe('true');
      } else {
        expect(statusTweet.hasAttribute('data-margin-src-hidden')).toBe(false);
      }
    }

    // Release `/status/98765` transport -> settles cleanly into 2 rich segments
    releaseStatusTransport();
    await vi.waitFor(() => {
      expect(statusRoot.querySelectorAll('.margin-trans-seg')).toHaveLength(2);
    });
    expect(statusRoot.textContent).toBe(
      '跨路由详情页首段完整译文。\n\n详情页第二段完整译文。',
    );

    // Hover toggle (`toggleSingleBlock`) removes translation cleanly even on segmented blocks
    const toggledOff = await routeRenderer.toggleSingleBlock(
      statusTweet,
      'hover',
    );
    expect(toggledOff).toBe(false);
    expect(statusTweet.querySelector('.margin-trans-root')).toBeNull();

    // Re-translate and verify `restorePage()` clears plans, hidden attributes, and prefix store
    await routeRenderer.translateBlocks([statusTweet], 'webpage');
    expect(statusTweet.querySelectorAll('.margin-trans-seg')).toHaveLength(2);
    routeRenderer.restorePage();
    expect(statusTweet.querySelector('[data-margin-injected]')).toBeNull();
    expect(statusTweet.hasAttribute('data-margin-src-hidden')).toBe(false);
    expect(statusTweet.hasAttribute('data-margin-translated')).toBe(false);

    routeRenderer.destroy();
  });

  it('v2.3.6: holds short boundary segments (<= 480 chars) until final atomic rich-to-rich swap and preserves expansion prefix alignment with inline <code> atomics', async () => {
    const cfg = createDefaultMarginConfig();
    cfg.providers['google-free'].stream = 'on';

    const tweet = document.createElement('div');
    tweet.setAttribute('data-testid', 'tweetText');
    tweet.style.whiteSpace = 'pre-wrap';
    tweet.innerHTML =
      '<span>Execute </span><code>cargo bench --all-targets</code><span> to reproduce our latency profile…</span>';
    document.body.appendChild(tweet);

    let shortGateRelease!: () => void;
    const shortGate = new Promise<void>((resolve) => {
      shortGateRelease = resolve;
    });
    let shortCallbacks: Parameters<
      NonNullable<ConstructorParameters<typeof WebpageRenderer>[0]['transport']>
    >[1] | null = null;

    const renderer = new WebpageRenderer({
      config: cfg,
      transport: async (req, callbacks) => {
        if (req.items[0]?.text.includes('flamegraph')) {
          shortCallbacks = callbacks;
          await shortGate;
          return {
            ok: true,
            requestId: req.requestId,
            providerId: 'google-free',
            model: 'gtx',
            items: [
              {
                id: 1,
                trans:
                  '<m0>执行 </m0><m1/><m2> 即可复现完整延迟剖析与<m3>火焰图报告</m3>。</m2>',
              },
            ],
            diagnostic: makeMockDiagnostic(),
          };
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: [
            {
              id: 1,
              trans: '<m0>执行 </m0><m1/><m2> 即可复现延迟剖析……</m2>',
            },
          ],
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    renderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(tweet.querySelector('.margin-trans-root code')?.textContent).toBe(
        'cargo bench --all-targets',
      );
    });

    // Expand to a <= 480-char single-paragraph post with a rich link
    const root = tweet.querySelector('.margin-trans-root')!;
    tweet.innerHTML =
      '<span>Execute </span><code>cargo bench --all-targets</code><span> to reproduce our latency profile and inspect the <a href="https://margin.dev/flamegraph">flamegraph</a>.</span>';
    tweet.appendChild(root);

    await vi.waitFor(() => {
      expect(shortCallbacks).not.toBeNull();
    });

    // Even when streaming emits a long partial > pinnedLen + 6, <= 480-char segment holds its rich `<code>` pin!
    shortCallbacks!.onItemReady?.({
      id: 1,
      trans:
        '执行 cargo bench --all-targets 即可复现完整延迟剖析与很长很长的中间流式文本预览但短段绝不中途降级纯文本',
      partial: true,
    });
    expect(root.querySelector('code')?.textContent).toBe(
      'cargo bench --all-targets',
    );
    expect(root.textContent).toBe(
      '执行 cargo bench --all-targets 即可复现延迟剖析……',
    );

    // Final arrives -> atomic rich-to-rich swap preserving `<code>` + hydrating `<a>`!
    shortGateRelease();
    await vi.waitFor(() => {
      expect(root.querySelector('a')?.getAttribute('href')).toBe(
        'https://margin.dev/flamegraph',
      );
    });
    expect(root.querySelector('code')?.textContent).toBe(
      'cargo bench --all-targets',
    );
    expect(root.querySelector('a')?.textContent).toBe('火焰图报告');

    renderer.destroy();
  });

  it('v2.3.6 Round-2 (P1-1, P1-2, P1-3, P2-5): paces continuous streaming growth by round-trip without request storms, self-heals settled target-only plans on root removal, keeps later paragraphs visible during holdUntilFinal P1 revalidation, and preserves stylesheet-hidden exclusions across displayMode flips', async () => {
    // Part 1 (P1-1): Continuous text growth (AI chat stream) paces by round-trip with 0 aborts & 0 storm
    const growthCfg = createDefaultMarginConfig();
    const growthPara = document.createElement('p');
    growthPara.textContent =
      'Streaming assistant response opening sentence with initial architectural overview.';
    document.body.appendChild(growthPara);

    let growthTransportCalls = 0;
    let abortedCount = 0;
    let releaseFirstGrowthBatch!: () => void;
    const firstGrowthGate = new Promise<void>((resolve) => {
      releaseFirstGrowthBatch = resolve;
    });
    let releaseSecondGrowthBatch!: () => void;
    const secondGrowthGate = new Promise<void>((resolve) => {
      releaseSecondGrowthBatch = resolve;
    });

    const growthRenderer = new WebpageRenderer({
      config: growthCfg,
      isUserActivationActive: () => false,
      transport: async (req, _cb, signal) => {
        growthTransportCalls += 1;
        const callNo = growthTransportCalls;
        signal.addEventListener('abort', () => {
          abortedCount += 1;
        });
        if (callNo === 2) {
          await firstGrowthGate;
        } else if (callNo === 3) {
          await secondGrowthGate;
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `流式轮次#${callNo}译文（长度${it.text.length}）`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    growthRenderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(growthPara.querySelector('.margin-trans-root')?.textContent).toContain(
        '流式轮次#1译文',
      );
    });
    expect(growthTransportCalls).toBe(1);

    // Tick 1 triggers Call #2 (`isExpansionFromPrior = true`, held in flight by `firstGrowthGate`)
    const tick1StreamText = `${growthPara.textContent} Token chunk 1 adds consensus safety invariants.`;
    let currentStreamText = tick1StreamText;
    growthPara.firstChild!.nodeValue = currentStreamText;
    await vi.waitFor(() => {
      expect(growthTransportCalls).toBe(2);
    });

    // Ticks 2..6 fire rapidly while Call #2 is in flight -> MUST NOT supersede, abort, or storm!
    for (let tick = 2; tick <= 6; tick++) {
      currentStreamText += ` Token chunk ${tick} extends live streaming output.`;
      growthPara.firstChild!.nodeValue = currentStreamText;
      await new Promise((r) => setTimeout(r, 35));
    }
    expect(growthTransportCalls).toBe(2);
    expect(abortedCount).toBe(0);

    // Release Call #2 -> `staleSettledTrans` from Call #2 MUST advance visible pinned DOM on screen while Call #3 runs!
    releaseFirstGrowthBatch();
    await vi.waitFor(() => {
      expect(growthTransportCalls).toBe(3);
      expect(growthPara.querySelector('.margin-trans-root')?.textContent).toContain(
        `流式轮次#2译文（长度${tick1StreamText.length}）`,
      );
    });

    releaseSecondGrowthBatch();
    await vi.waitFor(() => {
      expect(growthPara.querySelector('.margin-trans-root')?.textContent).toContain(
        `流式轮次#3译文（长度${currentStreamText.length}）`,
      );
    });
    expect(abortedCount).toBe(0);
    growthRenderer.destroy();

    // Part 1b (P1-1 tail): Unmounted single-segment `<p>` whose initial Call #1 is still in flight (0 partials) grows 5 times -> 1 call, 0 aborts!
    document.body.innerHTML = '';
    const coldPara = document.createElement('p');
    let coldText = 'Cold streaming paragraph initial sentence before first byte arrives.';
    coldPara.textContent = coldText;
    document.body.appendChild(coldPara);

    let coldCalls = 0;
    let coldAborts = 0;
    let releaseColdFirstCall!: () => void;
    const coldFirstGate = new Promise<void>((resolve) => {
      releaseColdFirstCall = resolve;
    });

    const coldRenderer = new WebpageRenderer({
      config: createDefaultMarginConfig(),
      isUserActivationActive: () => false,
      transport: async (req, _cb, signal) => {
        coldCalls += 1;
        const callIdx = coldCalls;
        signal.addEventListener('abort', () => {
          coldAborts += 1;
        });
        if (callIdx === 1) {
          await coldFirstGate;
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `首轮未挂载增长轮次#${callIdx}译文（长度${it.text.length}）`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    coldRenderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(coldCalls).toBe(1);
    });

    // Grow 5 times rapidly while Call #1 has NOT emitted any partial -> `transport` MUST stay at 1 with 0 aborts!
    for (let tick = 1; tick <= 5; tick++) {
      coldText += ` Appended streaming delta #${tick} before initial response resolves.`;
      coldPara.firstChild!.nodeValue = coldText;
      await new Promise((r) => setTimeout(r, 35));
    }
    expect(coldCalls).toBe(1);
    expect(coldAborts).toBe(0);

    // Release Call #1 -> stale check triggers Call #2 and renders final grown text!
    releaseColdFirstCall();
    await vi.waitFor(() => {
      expect(coldCalls).toBe(2);
      expect(coldPara.querySelector('.margin-trans-root')?.textContent).toBe(
        `首轮未挂载增长轮次#2译文（长度${coldText.length}）`,
      );
    });
    expect(coldAborts).toBe(0);
    coldRenderer.destroy();

    // Part 2 (P1-2 & P2-5): Settled `target-only` plan self-heals on host `innerHTML` re-render + stylesheet-hidden child stays excluded
    document.body.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `.x-native-hidden { display: none; }`;
    document.head.appendChild(style);

    const healCfg = createDefaultMarginConfig();
    healCfg.webpage.displayMode = 'bilingual';

    const healMarkup =
      '<span>First settled paragraph in target-only self-heal verification.</span>\n\n<span>Second settled paragraph surviving host innerHTML replacement.</span><span class="x-native-hidden">Secret hidden span text</span>';
    const healTweet = document.createElement('div');
    healTweet.setAttribute('data-testid', 'tweetText');
    healTweet.style.whiteSpace = 'pre-wrap';
    healTweet.innerHTML = healMarkup;
    document.body.appendChild(healTweet);

    let healCalls = 0;
    const healSentTexts: string[] = [];
    const healRenderer = new WebpageRenderer({
      config: healCfg,
      transport: async (req) => {
        healCalls += 1;
        for (const it of req.items) {
          healSentTexts.push(it.text);
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it, idx) => ({
            id: it.id,
            trans: `<m0>自愈段落${idx + 1}译文</m0>`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    healRenderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(healTweet.querySelectorAll('.margin-trans-seg')).toHaveLength(2);
    });
    expect(healCalls).toBe(1);
    expect(healSentTexts.join(' ')).not.toContain('Secret hidden span text');

    // Flip `bilingual -> target-only` (P2-5: snapshots `.x-native-hidden` before setting `data-margin-src-hidden="true"`)
    const targetOnlyCfg = structuredClone(healCfg);
    targetOnlyCfg.webpage.displayMode = 'target-only';
    healRenderer.updateConfig(targetOnlyCfg);
    expect(healTweet.getAttribute('data-margin-src-hidden')).toBe('true');
    healRenderer.rescanSubtree(document.body);
    expect(healCalls).toBe(1); // Zero spurious re-translation from `.x-native-hidden`!

    // Host re-renders `healTweet.innerHTML` with identical markup, dropping `.margin-trans-root` (P1-2)
    healTweet.innerHTML = healMarkup;
    expect(healTweet.querySelector('.margin-trans-root')).toBeNull();

    await vi.waitFor(() => {
      expect(healTweet.querySelectorAll('.margin-trans-seg')).toHaveLength(2);
    });
    expect(healCalls).toBe(1); // Self-healed from live plan with ZERO network calls!
    expect(healTweet.getAttribute('data-margin-src-hidden')).toBe('true');
    expect(healTweet.querySelector('.margin-trans-root')?.textContent).toBe(
      '自愈段落1译文\n\n自愈段落2译文',
    );
    healRenderer.destroy();
    style.remove();

    // Part 3 (P1-3): Markup-only change on P1 (`holdUntilFinal` pin) NEVER hides already-visible P2 & P3 during revalidation
    document.body.innerHTML = '';
    const p13Tweet = document.createElement('div');
    p13Tweet.setAttribute('data-testid', 'tweetText');
    p13Tweet.style.whiteSpace = 'pre-wrap';
    const p1Plain = 'Opening paragraph whose plain text stays identical while markup changes.';
    const p2Plain = 'Middle paragraph already translated and cached in full.';
    const p3Preview = 'Third paragraph preview before full expansion on timeline…';
    const p3Full =
      'Third paragraph preview before full expansion on timeline with complete benchmark conclusions.';
    p13Tweet.innerHTML = `<span>${p1Plain}</span>\n\n<span>${p2Plain}</span>\n\n<span>${p3Preview}</span>`;
    document.body.appendChild(p13Tweet);

    let releaseP13Reval!: () => void;
    const p13Gate = new Promise<void>((resolve) => {
      releaseP13Reval = resolve;
    });
    let p13Call = 0;

    const p13Renderer = new WebpageRenderer({
      config: createDefaultMarginConfig(),
      transport: async (req) => {
        p13Call += 1;
        if (p13Call === 2) {
          await p13Gate;
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: it.text.includes('Opening paragraph')
              ? it.text.includes('<m1>')
                ? '<m0>首段含<m1>加粗标记</m1>重验译文。</m0>'
                : '<m0>首段初始译文。</m0>'
              : it.text.includes('Middle paragraph')
                ? '<m0>第二段稳定缓存译文。</m0>'
                : it.text.includes('complete benchmark')
                  ? '<m0>第三段完整展开译文。</m0>'
                  : '<m0>第三段截断预览译文……</m0>',
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    p13Renderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(p13Tweet.querySelectorAll('.margin-trans-seg')).toHaveLength(3);
    });
    const seg1NodeBefore = p13Tweet.querySelectorAll('.margin-trans-seg')[1]!;

    // Mutate P1 markup (`<strong>` added, plain text identical!) + expand P3 while keeping P2 identical
    const p13Root = p13Tweet.querySelector('.margin-trans-root')!;
    p13Tweet.innerHTML = `<span>Opening paragraph whose <strong>plain text</strong> stays identical while markup changes.</span>\n\n<span>${p2Plain}</span>\n\n<span>${p3Full}</span>`;
    p13Tweet.appendChild(p13Root);

    await vi.waitFor(() => {
      expect(p13Call).toBe(2);
    });

    // While P1 (`pinned` + `holdUntilFinal`) & P3 (`pinned`) are revalidating in flight, ALL 3 segments stay visible and P2 keeps its DOM node!
    const segsDuringReval = p13Tweet.querySelectorAll('.margin-trans-seg');
    expect(segsDuringReval).toHaveLength(3);
    expect(segsDuringReval[0]?.textContent).toBe('首段初始译文。');
    expect(segsDuringReval[1]).toBe(seg1NodeBefore);
    expect(segsDuringReval[2]?.textContent).toBe('第三段截断预览译文……');

    releaseP13Reval();
    await vi.waitFor(() => {
      expect(p13Tweet.querySelector('.margin-trans-root strong')?.textContent).toBe(
        '加粗标记',
      );
      expect(
        p13Tweet.querySelectorAll('.margin-trans-seg')[2]?.textContent,
      ).toBe('第三段完整展开译文。');
    });
    p13Renderer.destroy();
  });

  it('v2.3.6 Round-2 (P2-1, P2-2, P2-3, P2-4, P2-6): preserves empty CJK sentence-split separators, skips out-of-prefix partial renderPlan calls, keeps failed pinned segments across failure & retry without duplicating sibling batches, guards fast-scroll inFlightBatches, and reconciles early-return roots', async () => {
    // Part 1 (P2-1): >2,500-char CJK single paragraph splits on `。` with `sepBefore === ""` (zero spurious `\n\n` injected!)
    const cjkCfg = createDefaultMarginConfig();
    cjkCfg.targetLang = 'en';
    const cjkSentence =
      '分布式浏览器扩展在流式渲染超长自然段时必须保持标点边界紧凑衔接且绝不凭空插入多余空行。';
    const longSingleCjkPara = cjkSentence.repeat(62); // ~2,604 chars > 2,400 hardMaxChars, zero whitespace!
    const cjkBlock = document.createElement('div');
    cjkBlock.setAttribute('data-testid', 'tweetText');
    cjkBlock.style.whiteSpace = 'pre-wrap';
    cjkBlock.innerHTML = `<span>${longSingleCjkPara}</span>`;
    document.body.appendChild(cjkBlock);

    const cjkRenderer = new WebpageRenderer({
      config: cjkCfg,
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: req.items.map((it, idx) => ({
          id: it.id,
          trans: `<m0>Translated CJK slice ${idx + 1}.</m0>`,
        })),
        diagnostic: makeMockDiagnostic(),
      }),
    });

    await cjkRenderer.translateBlocks([cjkBlock], 'webpage');
    const cjkRoot = cjkBlock.querySelector('.margin-trans-root')!;
    expect(cjkRoot.querySelectorAll('.margin-trans-seg').length).toBeGreaterThanOrEqual(
      2,
    );
    expect(cjkRoot.textContent).not.toContain('\n\n');
    cjkRenderer.destroy();

    // Part 2 (P2-3): Out-of-prefix streaming partials on Wave 1 do NOT trigger full `renderPlan` while Wave 0 is pending
    document.body.innerHTML = '';
    const p23Cfg = createDefaultMarginConfig();
    p23Cfg.providers['google-free'].stream = 'on';
    p23Cfg.providers['google-free'].maxCharsPerBatch = 700;

    const p23Block = document.createElement('div');
    p23Block.setAttribute('data-testid', 'tweetText');
    p23Block.style.whiteSpace = 'pre-wrap';
    const wave0Para = 'Wave zero opening paragraph awaiting upstream completion. '.repeat(9).trim();
    const wave1Para = 'Wave one secondary paragraph streaming partials early. '.repeat(9).trim();
    p23Block.innerHTML = `<span>${wave0Para}</span>\n\n<span>${wave1Para}</span>`;
    document.body.appendChild(p23Block);

    let releaseWave0!: () => void;
    const wave0Gate = new Promise<void>((resolve) => {
      releaseWave0 = resolve;
    });
    let wave1Callbacks: Parameters<
      NonNullable<ConstructorParameters<typeof WebpageRenderer>[0]['transport']>
    >[1] | null = null;
    let releaseWave1!: () => void;
    const wave1Gate = new Promise<void>((resolve) => {
      releaseWave1 = resolve;
    });

    const p23Renderer = new WebpageRenderer({
      config: p23Cfg,
      transport: async (req, callbacks) => {
        if (req.items[0]?.text.includes('Wave zero')) {
          await wave0Gate;
          return {
            ok: true,
            requestId: req.requestId,
            providerId: 'google-free',
            model: 'gtx',
            items: [{ id: 1, trans: '<m0>第零波完成译文。</m0>' }],
            diagnostic: makeMockDiagnostic(),
          };
        }
        wave1Callbacks = callbacks;
        await wave1Gate;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: [{ id: 1, trans: '<m0>第一波完成译文。</m0>' }],
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    const p23Promise = p23Renderer.translateBlocks([p23Block], 'webpage');
    await vi.waitFor(() => {
      expect(wave1Callbacks).not.toBeNull();
    });

    let blockDomMutationsDuringOutOfPrefix = 0;
    const p23Mo = new MutationObserver(() => {
      blockDomMutationsDuringOutOfPrefix += 1;
    });
    p23Mo.observe(p23Block, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    wave1Callbacks!.onItemReady?.({
      id: 1,
      trans: '第一波提前到达但尚未轮到揭露的流式片段一',
      partial: true,
    });
    await new Promise((r) => setTimeout(r, 25));
    wave1Callbacks!.onItemReady?.({
      id: 1,
      trans: '第一波提前到达但尚未轮到揭露的流式片段二更长内容',
      partial: true,
    });
    expect(blockDomMutationsDuringOutOfPrefix).toBe(0);
    p23Mo.disconnect();

    // Once Wave 0 settles, both Wave 0 (done) and Wave 1's buffered stream immediately appear in order!
    releaseWave0();
    await vi.waitFor(() => {
      expect(p23Block.querySelectorAll('.margin-trans-seg')).toHaveLength(2);
    });
    expect(p23Block.querySelectorAll('.margin-trans-seg')[1]?.textContent).toBe(
      '第一波提前到达但尚未轮到揭露的流式片段二更长内容',
    );
    releaseWave1();
    await p23Promise;
    p23Renderer.destroy();

    // Part 3 (P2-4 & P2-2): Failed pinned segment stays visible next to `↻`, stays pinned on retry, and retry skips sibling in-flight segment!
    document.body.innerHTML = '';
    const pinFailCfg = createDefaultMarginConfig();
    pinFailCfg.webpage.displayMode = 'target-only';
    pinFailCfg.providers['google-free'].maxCharsPerBatch = 650;

    const pinFailTweet = document.createElement('div');
    pinFailTweet.setAttribute('data-testid', 'tweetText');
    pinFailTweet.style.whiteSpace = 'pre-wrap';
    const pfCollapsed =
      'Pinned failure resilience preview paragraph before timeline expansion into multiple waves…';
    pinFailTweet.innerHTML = `<span>${pfCollapsed}</span>`;
    document.body.appendChild(pinFailTweet);

    let wave0Attempt = 0;
    let wave1Dispatches = 0;
    let releaseSiblingWave1!: () => void;
    const siblingWave1Gate = new Promise<void>((resolve) => {
      releaseSiblingWave1 = resolve;
    });

    const pinFailRenderer = new WebpageRenderer({
      config: pinFailCfg,
      transport: async (req) => {
        const text0 = req.items[0]?.text ?? '';
        if (text0.includes('into multiple waves…')) {
          return {
            ok: true,
            requestId: req.requestId,
            providerId: 'google-free',
            model: 'gtx',
            items: [{ id: 1, trans: '<m0>旧截断锚定译文（失败及重试期间绝不消失）……</m0>' }],
            diagnostic: makeMockDiagnostic(),
          };
        }
        if (text0.includes('Pinned failure resilience preview')) {
          wave0Attempt += 1;
          if (wave0Attempt === 1) {
            return {
              ok: false,
              requestId: req.requestId,
              providerId: 'google-free',
              model: 'gtx',
              items: [],
              error: {
                code: 'HTTP_502',
                message: 'Bad Gateway',
                retryable: true,
              },
              diagnostic: makeMockDiagnostic(),
            };
          }
          return {
            ok: true,
            requestId: req.requestId,
            providerId: 'google-free',
            model: 'gtx',
            items: [{ id: 1, trans: '<m0>重试成功后首段完整译文。</m0>' }],
            diagnostic: makeMockDiagnostic(),
          };
        }
        wave1Dispatches += 1;
        await siblingWave1Gate;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: [{ id: 1, trans: '<m0>兄弟批次第二段译文。</m0>' }],
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    pinFailRenderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(pinFailTweet.querySelector('.margin-trans-root')?.textContent).toContain(
        '旧截断锚定译文',
      );
    });

    // Expand into 2 ~550-char paragraphs so Wave 0 (seg 0) and Wave 1 (seg 1) run in separate batches
    const pfRoot = pinFailTweet.querySelector('.margin-trans-root')!;
    const pfSeg0Full = `${pfCollapsed.slice(0, -1)} ${'with extended benchmarking details '.repeat(13).trim()}.`;
    const pfSeg1Full = `Sibling batch second paragraph running concurrently while first batch fails. `.repeat(
      7,
    ).trim();
    pinFailTweet.innerHTML = `<span>${pfSeg0Full}</span>\n\n<span>${pfSeg1Full}</span>`;
    pinFailTweet.appendChild(pfRoot);

    await vi.waitFor(() => {
      expect(
        pinFailTweet.querySelector('button.margin-inline-retry'),
      ).not.toBeNull();
    });

    // P2-4: Even though seg 0 failed, its pinned translation remains visible next to `↻` (while target-only un-hid source)!
    expect(pinFailTweet.hasAttribute('data-margin-src-hidden')).toBe(false);
    expect(
      pinFailTweet.querySelectorAll('.margin-trans-seg')[0]?.textContent,
    ).toContain('旧截断锚定译文');
    expect(wave1Dispatches).toBe(1);

    // Click `↻` while sibling Wave 1 is STILL in flight -> P2-2: Wave 1 MUST NOT be dispatched a second time!
    (
      pinFailTweet.querySelector('button.margin-inline-retry') as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(wave0Attempt).toBe(2);
      expect(
        pinFailTweet.querySelectorAll('.margin-trans-seg')[0]?.textContent,
      ).toBe('重试成功后首段完整译文。');
    });
    expect(wave1Dispatches).toBe(1); // Zero duplicate dispatch of live sibling segment!

    releaseSiblingWave1();
    await vi.waitFor(() => {
      expect(pinFailTweet.querySelectorAll('.margin-trans-seg')).toHaveLength(2);
      expect(pinFailTweet.getAttribute('data-margin-src-hidden')).toBe('true');
    });
    pinFailRenderer.destroy();

    // Part 4 (P2-2 fast-scroll eviction): Offscreen P1 plan evicted on fast scroll does not double-decrement `inFlightBatches`
    document.body.innerHTML = '';
    const scrollCfg = createDefaultMarginConfig();
    scrollCfg.providers['google-free'].maxCharsPerBatch = 600;
    const scrollTweet = document.createElement('div');
    scrollTweet.setAttribute('data-testid', 'tweetText');
    scrollTweet.style.whiteSpace = 'pre-wrap';
    scrollTweet.innerHTML = `<span>${'Offscreen lookahead paragraph one for fast scroll eviction test. '.repeat(8).trim()}</span>\n\n<span>${'Offscreen lookahead paragraph two for fast scroll eviction test. '.repeat(8).trim()}</span>`;
    document.body.appendChild(scrollTweet);

    let scrollTopVal = 1500; // Strictly offscreen (`vh = 800`), within lookahead (`<= 3000`) -> P1!
    scrollTweet.getBoundingClientRect = () =>
      ({
        top: scrollTopVal,
        bottom: scrollTopVal + 120,
        left: 0,
        right: 600,
        width: 600,
        height: 120,
        x: 0,
        y: scrollTopVal,
        toJSON: () => ({}),
      }) as DOMRect;

    let scrollBatchCalls = 0;
    let holdEvictedBatches = true;
    const scrollRenderer = new WebpageRenderer({
      config: scrollCfg,
      transport: (req, _cb, signal) => {
        scrollBatchCalls += 1;
        if (holdEvictedBatches) {
          return new Promise<TranslateBatchResponse>((resolve) => {
            signal.addEventListener('abort', () => {
              resolve({
                ok: false,
                requestId: req.requestId,
                providerId: 'google-free',
                model: 'gtx',
                items: [],
                diagnostic: makeMockDiagnostic(),
              });
            });
          });
        }
        return Promise.resolve({
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it, idx) => ({
            id: it.id,
            trans: `<m0>滚回视口恢复译文${idx + 1}</m0>`,
          })),
          diagnostic: makeMockDiagnostic(),
        });
      },
    });

    scrollRenderer.enablePageTranslation();
    await vi.waitFor(() => {
      expect(scrollBatchCalls).toBe(2);
    });

    // Scroll far away (`top = 5000 > vh + 3000`) -> evicts P1 batches cleanly
    scrollTopVal = 5000;
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));

    // Scroll back into visible viewport (`top = 100`) -> resumes cleanly and translates both segments once!
    holdEvictedBatches = false;
    scrollTopVal = 100;
    scrollRenderer.rescanSubtree(document.body);
    await vi.waitFor(() => {
      expect(scrollTweet.querySelectorAll('.margin-trans-seg')).toHaveLength(2);
    });
    expect(scrollBatchCalls).toBe(4); // 2 evicted + 2 resumed (no duplicate extra dispatches!)
    scrollRenderer.destroy();

    // Part 5 (P2-6): Early-return root reconciliation removes stale retry button on seg-0 retry & removes leftover identity root on bilingual flip
    document.body.innerHTML = '';
    const p26Cfg = createDefaultMarginConfig();
    p26Cfg.webpage.displayMode = 'target-only';
    const p26Tweet = document.createElement('div');
    p26Tweet.setAttribute('data-testid', 'tweetText');
    p26Tweet.style.whiteSpace = 'pre-wrap';
    p26Tweet.innerHTML =
      '<span>First unpinned paragraph that fails initially.</span>\n\n<span>Second unpinned paragraph.</span>';
    document.body.appendChild(p26Tweet);

    let p26FailFirst = true;
    let releaseP26Retry!: () => void;
    const p26RetryGate = new Promise<void>((resolve) => {
      releaseP26Retry = resolve;
    });

    const p26Renderer = new WebpageRenderer({
      config: p26Cfg,
      transport: async (req) => {
        if (p26FailFirst) {
          p26FailFirst = false;
          return {
            ok: false,
            requestId: req.requestId,
            providerId: 'google-free',
            model: 'gtx',
            items: [],
            error: { code: 'HTTP_500', message: 'Boom', retryable: true },
            diagnostic: makeMockDiagnostic(),
          };
        }
        await p26RetryGate;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it, idx) => ({
            id: it.id,
            trans: `<m0>P26恢复译文${idx + 1}</m0>`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    await p26Renderer.translateBlocks([p26Tweet], 'webpage');
    expect(p26Tweet.querySelector('button.margin-inline-retry')).not.toBeNull();

    // Click retry -> while pending in flight (`visibleIndices = []`), stale retry button & root MUST be gone and loading shimmer mounted!
    (
      p26Tweet.querySelector('button.margin-inline-retry') as HTMLButtonElement
    ).click();
    expect(p26Tweet.querySelector('button.margin-inline-retry')).toBeNull();
    expect(p26Tweet.querySelector('.margin-trans-root')).toBeNull();
    expect(p26Tweet.querySelector('.margin-trans-loading')).not.toBeNull();

    releaseP26Retry();
    await vi.waitFor(() => {
      expect(p26Tweet.querySelectorAll('.margin-trans-seg')).toHaveLength(2);
    });
    p26Renderer.destroy();

    // Subcase B of P2-6: Identity seg 0 + pending seg 1 in `target-only` -> flip to `bilingual` removes leftover identity `.margin-trans-root`!
    document.body.innerHTML = '';
    const idCfg = createDefaultMarginConfig();
    idCfg.webpage.displayMode = 'target-only';
    const idTweet = document.createElement('div');
    idTweet.setAttribute('data-testid', 'tweetText');
    idTweet.style.whiteSpace = 'pre-wrap';
    idTweet.innerHTML =
      '<span>2026 — 99.99%</span>\n\n<span>Second prose paragraph still pending upstream translation.</span>';
    document.body.appendChild(idTweet);

    let releaseIdPending!: () => void;
    const idPendingGate = new Promise<void>((resolve) => {
      releaseIdPending = resolve;
    });

    const idRenderer = new WebpageRenderer({
      config: idCfg,
      transport: async (req) => {
        await idPendingGate;
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: req.items.map((it) => ({
            id: it.id,
            trans: `<m0>第二段已完成译文。</m0>`,
          })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    const idPromise = idRenderer.translateBlocks([idTweet], 'webpage');
    await vi.waitFor(() => {
      expect(idTweet.querySelector('.margin-trans-root')?.textContent).toContain(
        '2026 — 99.99%',
      );
    });
    expect(idTweet.getAttribute('data-margin-src-hidden')).toBe('true');

    // Flip to `bilingual` while seg 1 is still pending -> `visibleIndices` becomes `[]`, so leftover identity root MUST be reconciled away!
    const idBilingualCfg = structuredClone(idCfg);
    idBilingualCfg.webpage.displayMode = 'bilingual';
    idRenderer.updateConfig(idBilingualCfg);
    expect(idTweet.querySelector('.margin-trans-root')).toBeNull();
    expect(idTweet.hasAttribute('data-margin-src-hidden')).toBe(false);
    expect(idTweet.querySelector('.margin-trans-loading')).not.toBeNull();

    releaseIdPending();
    await idPromise;
    expect(idTweet.querySelector('.margin-trans-root')?.textContent).toBe(
      '第二段已完成译文。',
    );
    idRenderer.destroy();
  });
});
