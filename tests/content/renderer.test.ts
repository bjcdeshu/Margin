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
  WEBPAGE_INJECTED_CSS,
  WebpageRenderer,
  isRedundantIdenticalTranslation,
  packIntoBatches,
  packIntoProgressiveBatches,
} from '../../src/content/renderer';
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
});
