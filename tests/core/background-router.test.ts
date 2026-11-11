import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachStreamTranslationPort,
  backgroundTranslationCache,
  CONTEXT_MENU_IDS,
  dispatchShortcutCommand,
  handleContextMenuClicked,
  handleRuntimeRpcRequest,
  parseVisionTranslationOutput,
} from '../../src/background';
import {
  buildDiagnosticSnapshot,
  sanitizeErrorText,
} from '../../src/core/diagnostics';
import { ProviderExecutionPool } from '../../src/core/providers';
import { BRAND } from '@shared/brand';
import { createDefaultMarginConfig } from '@shared/constants';
import {
  getDiagnosticsLog,
  resetMemoryStorageForTests,
  saveMarginConfig,
} from '@shared/storage';
import type {
  ProviderConfig,
  TranslateBatchResponse,
  TranslateImageResponse,
  TranslateStreamPortMessage,
} from '@shared/types';

function jsonResponse(body: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Zero-Secret Diagnostics & Sanitizer', () => {
  it('redacts sk- keys, Bearer tokens, Zhipu JWT keys, URL credentials, and DeepLX path tokens', () => {
    const fakeSk = ['sk', 'TEST_FAKE_KEY_DO_NOT_USE_987654'].join('-');
    const fakeBearer = ['Bearer', 'TEST_FAKE_BEARER_DO_NOT_USE_123456'].join(' ');
    const fakeZhipu = `${'a1b2c3d4e5f6a1b2c3d4e5f6'}.${'TESTFAKEZHIPU1234'}`;
    const dirtyError = `Request to https://user:${'TEST_FAKE_PASS'}@api.deeplx.org/TEST_FAKE_PATH_TOKEN_12345/translate?api_key=TEST_FAKE_QUERY_KEY failed with Authorization: ${fakeBearer} and key ${fakeSk} and zhipu ${fakeZhipu}`;

    const clean = sanitizeErrorText(dirtyError, ['customRawSecretToken']);
    expect(clean).not.toContain('TEST_FAKE_PASS');
    expect(clean).not.toContain('TEST_FAKE_PATH_TOKEN_12345');
    expect(clean).not.toContain('TEST_FAKE_QUERY_KEY');
    expect(clean).not.toContain('TEST_FAKE_BEARER_DO_NOT_USE_123456');
    expect(clean).not.toContain('TEST_FAKE_KEY_DO_NOT_USE_987654');
    expect(clean).not.toContain('TESTFAKEZHIPU1234');

    const snapshot = buildDiagnosticSnapshot({
      scene: 'webpage',
      codec: 'single-text',
      provider: {
        id: 'deeplx-custom',
        preset: 'deeplx',
        protocol: 'deeplx',
        resolvedEndpoint:
          'https://api.deeplx.org/SecretToken123456/translate?token=hideMe',
        model: 'deeplx',
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
      latencyMs: 120,
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.product).toBe('Margin');
    expect(snapshot.provider.endpointOrigin).toBe('https://api.deeplx.org');
    expect(snapshot.provider.endpointPath).toBe('/[REDACTED]/translate');
  });
});

describe('MV3 Background Router, Vision BBox Parser, DNR Anti-403, Stream Port & Commands', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    resetMemoryStorageForTests();
    backgroundTranslationCache.clear();
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
  });

  it('parses Vision JSON [ymin, xmin, ymax, xmax] bounding boxes, rescues 0..1 floats, and falls back to plain text', () => {
    const mangaJson = `
<think>Detecting vertical speech bubbles...</think>
\`\`\`json
[
  {"box": [120, 680, 460, 910], "src": "行くぞ、LLM！", "trans": "出发吧，LLM！", "vertical": true},
  {"box": [0.55, 0.10, 0.75, 0.45], "src": "Roger!", "trans": "收到！"}
]
\`\`\`
`;
    const parsed = parseVisionTranslationOutput(mangaJson);
    expect(parsed.fallbackFullText).toBeUndefined();
    expect(parsed.regions).toEqual([
      {
        box: [120, 680, 460, 910],
        src: '行くぞ、LLM！',
        trans: '出发吧，LLM！',
        vertical: true,
      },
      {
        box: [550, 100, 750, 450],
        src: 'Roger!',
        trans: '收到！',
      },
    ]);

    // Prose fallback when Vision LLM returns non-JSON summary/translation
    const fallback = parseVisionTranslationOutput(
      '第一段：欢迎来到静纸阅读器。\n第二段：支持扫描版 PDF。',
    );
    expect(fallback.regions).toEqual([]);
    expect(fallback.fallbackFullText).toContain('欢迎来到静纸阅读器');
  });

  it('routes "inherit" scenes dynamically to webpage provider, supports DeepLX multi-URL rotation & Google Web, and clears cache', async () => {
    const config = createDefaultMarginConfig();
    const unbowProvider: ProviderConfig = {
      id: 'openai-bytb6BIB',
      name: 'Unbow GPT-6',
      preset: 'openai',
      protocol: 'openai-chat',
      enabled: true,
      baseUrl: 'https://gateway.example.com/v1',
      apiKeys: ['sk-TEST_FAKE'],
      model: 'gpt-6-luna',
      models: ['gpt-6-luna'],
      assistantId: 'builtin-yaml',
      enableContext: true,
      enableRichHtml: true,
      stream: 'off',
      rateLimitRps: 50,
      maxConcurrency: 4,
      temperaturePolicy: { mode: 'omit' },
      thinkingPolicy: { mode: 'provider-default' },
    };
    const deeplxProvider: ProviderConfig = {
      id: 'deeplx-pool',
      name: 'DeepLX Pool',
      preset: 'deeplx',
      protocol: 'deeplx',
      enabled: true,
      baseUrl: 'https://d1.example.com/translate, https://d2.example.com/translate',
      endpoints: [
        'https://d1.example.com/translate',
        'https://d2.example.com/translate',
      ],
      apiKeys: [],
      model: 'deeplx',
      models: ['deeplx'],
      enableContext: false,
      enableRichHtml: true,
      stream: 'off',
      rateLimitRps: 20,
      maxConcurrency: 4,
      temperaturePolicy: { mode: 'omit' },
      thinkingPolicy: { mode: 'provider-default' },
    };

    config.providers['openai-bytb6BIB'] = unbowProvider;
    config.providers['deeplx-pool'] = deeplxProvider;
    config.routing.webpage = 'openai-bytb6BIB';
    config.routing.input = 'inherit';
    await saveMarginConfig(config);

    let fetchCount = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      fetchCount++;
      const urlStr = String(url);
      if (urlStr.includes('d1.example.com')) {
        return jsonResponse({ message: 'Too many requests' }, 429);
      }
      if (urlStr.includes('d2.example.com')) {
        return jsonResponse({ code: 200, data: '来自第二个 <m-g id="0"/> 节点的译文' });
      }
      if (urlStr.includes('translate.googleapis.com')) {
        return jsonResponse([
          [['谷歌免费 <m-g id="0"/> 翻译', 'Google free LLM translation']],
          null,
          'en',
        ]);
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: '<yaml>\n- id: 1\n  trans: 输入框继承路由成功\n</yaml>',
            },
          },
        ],
      });
    });

    const pool = new ProviderExecutionPool();

    // 1. `scene: 'input'` with `routing.input = 'inherit'` resolves to `openai-bytb6BIB` (`gpt-6-luna`)!
    const inputResp = (await handleRuntimeRpcRequest(
      {
        type: 'margin:translate-batch',
        payload: {
          requestId: 'req-input-1',
          scene: 'input',
          fromLang: 'zh-CN',
          toLang: 'en',
          items: [{ id: 1, text: '测试继承路由' }],
        },
      },
      { fetchImpl: fetchMock as unknown as typeof fetch, pool, retryBaseDelayMs: 0 },
    )) as TranslateBatchResponse;

    expect(inputResp.ok).toBe(true);
    expect(inputResp.providerId).toBe('openai-bytb6BIB');
    expect(inputResp.model).toBe('gpt-6-luna');
    expect(inputResp.items).toEqual([{ id: 1, trans: '输入框继承路由成功' }]);

    // 2. DeepLX fails on `d1.example.com` (429) -> rotates to `d2.example.com` + preserves `LLM` glossary!
    const deeplxResp = (await handleRuntimeRpcRequest(
      {
        type: 'margin:translate-batch',
        payload: {
          requestId: 'req-deeplx-1',
          scene: 'webpage',
          providerId: 'deeplx-pool',
          fromLang: 'en',
          toLang: 'zh-CN',
          items: [{ id: 1, text: 'Translation from second LLM node' }],
        },
      },
      { fetchImpl: fetchMock as unknown as typeof fetch, pool, retryBaseDelayMs: 0 },
    )) as TranslateBatchResponse;

    expect(deeplxResp.ok).toBe(true);
    expect(deeplxResp.items).toEqual([
      { id: 1, trans: '来自第二个 LLM 节点的译文' },
    ]);

    // Repeat identical webpage request -> hits background LRU cache with 0 new network calls!
    const countBeforeCached = fetchCount;
    const cachedResp = (await handleRuntimeRpcRequest(
      {
        type: 'margin:translate-batch',
        payload: {
          requestId: 'req-deeplx-cached',
          scene: 'webpage',
          providerId: 'deeplx-pool',
          fromLang: 'en',
          toLang: 'zh-CN',
          items: [{ id: 1, text: 'Translation from second LLM node' }],
        },
      },
      { fetchImpl: fetchMock as unknown as typeof fetch, pool, retryBaseDelayMs: 0 },
    )) as TranslateBatchResponse;
    expect(cachedResp.ok).toBe(true);
    expect(fetchCount).toBe(countBeforeCached);

    // Clear translation cache via RPC
    const clearResp = await handleRuntimeRpcRequest({
      type: 'margin:clear-translation-cache',
    });
    expect(clearResp).toEqual({ ok: true });
    expect(backgroundTranslationCache.size).toBe(0);

    // 3. Google Free with `<m-g>` glossary protection
    const googleResp = (await handleRuntimeRpcRequest(
      {
        type: 'margin:translate-batch',
        payload: {
          requestId: 'req-google-1',
          scene: 'webpage',
          providerId: 'google-free',
          fromLang: 'en',
          toLang: 'zh-CN',
          items: [{ id: 1, text: 'Google free LLM translation' }],
        },
      },
      { fetchImpl: fetchMock as unknown as typeof fetch, pool, retryBaseDelayMs: 0 },
    )) as TranslateBatchResponse;

    expect(googleResp.ok).toBe(true);
    expect(googleResp.items).toEqual([{ id: 1, trans: '谷歌免费 LLM 翻译' }]);

    // 4. Test `margin:test-provider` RPC (bypasses translation cache, records service-test diagnostic)
    const testProvResp = (await handleRuntimeRpcRequest(
      {
        type: 'margin:test-provider',
        payload: { providerId: 'openai-bytb6BIB' },
      },
      { fetchImpl: fetchMock as unknown as typeof fetch, pool, retryBaseDelayMs: 0 },
    )) as TranslateBatchResponse;
    expect(testProvResp.ok).toBe(true);
    expect(testProvResp.diagnostic.scene).toBe('service-test');
    expect(testProvResp.diagnostic.parameters.temperatureTrace).toBe(
      'omitted-reasoning-guard',
    );

    // Diagnostics log was recorded
    const diagLog = await getDiagnosticsLog();
    expect(diagLog.length).toBeGreaterThanOrEqual(4);
  });

  it('handles margin:translate-image and margin:fetch-image-data-url with temporary DNR Referer + Origin session rules', async () => {
    const config = createDefaultMarginConfig();
    config.providers['vision-oapi'] = {
      id: 'vision-oapi',
      name: 'Vision OAPI',
      preset: 'openai',
      protocol: 'openai-chat',
      enabled: true,
      baseUrl: 'https://gateway.example.com/v1',
      apiKeys: ['sk-VISION_FAKE'],
      model: 'gpt-4.1-mini',
      models: ['gpt-4.1-mini'],
      enableContext: false,
      enableRichHtml: false,
      stream: 'off',
      rateLimitRps: 20,
      maxConcurrency: 2,
      temperaturePolicy: { mode: 'omit' },
      thinkingPolicy: { mode: 'provider-default' },
    };
    config.routing.webpage = 'vision-oapi';
    config.routing.image = 'inherit';
    await saveMarginConfig(config);

    // 1. Test `margin:fetch-image-data-url` DNR session rule lifecycle (install before fetch, remove in finally)
    const eventsOrder: string[] = [];
    let addedRuleHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
    let installedRuleId = -1;
    let removedRuleIds: number[] = [];

    const dnrMock = {
      updateSessionRules: vi.fn(
        async (options: chrome.declarativeNetRequest.UpdateRuleOptions) => {
          if (options.addRules && options.addRules.length > 0) {
            eventsOrder.push('dnr-install');
            installedRuleId = options.addRules[0].id;
            addedRuleHeaders = options.addRules[0].action.requestHeaders ?? [];
          } else if (options.removeRuleIds) {
            eventsOrder.push('dnr-remove');
            removedRuleIds = options.removeRuleIds;
          }
        },
      ),
    };

    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
    ]);
    const imageFetchMock = vi.fn(async () => {
      eventsOrder.push('fetch');
      return new Response(pngBytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    });

    const dnrResp = await handleRuntimeRpcRequest(
      {
        type: 'margin:fetch-image-data-url',
        payload: {
          imageUrl: 'https://i.pximg.net/img-original/img/2026/01/01/test_p0.png',
          refererUrl: 'https://www.pixiv.net/artworks/123456',
        },
      },
      {
        fetchImpl: imageFetchMock as unknown as typeof fetch,
        dnrApi: dnrMock,
      },
    );

    expect(dnrResp).toMatchObject({
      ok: true,
      mimeType: 'image/png',
    });
    expect(eventsOrder).toEqual(['dnr-install', 'fetch', 'dnr-remove']);
    expect(removedRuleIds).toEqual([installedRuleId]);
    expect(addedRuleHeaders).toEqual([
      {
        header: 'Referer',
        operation: 'set',
        value: 'https://www.pixiv.net/artworks/123456',
      },
      {
        header: 'Origin',
        operation: 'set',
        value: 'https://www.pixiv.net',
      },
    ]);

    // 2. Test `margin:translate-image` RPC end-to-end
    const visionFetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content:
                '[{"box":[100,200,300,600],"src":"Hello Comic","trans":"你好漫画"}]',
            },
          },
        ],
      }),
    );

    const imgTransResp = (await handleRuntimeRpcRequest(
      {
        type: 'margin:translate-image',
        payload: {
          requestId: 'img-req-1',
          imageDataUrl: 'data:image/webp;base64,UklGRg==',
          fromLang: 'en',
          toLang: 'zh-CN',
          pageUrl: 'https://www.pixiv.net/artworks/123456',
        },
      },
      {
        fetchImpl: visionFetchMock as unknown as typeof fetch,
        pool: new ProviderExecutionPool(),
      },
    )) as TranslateImageResponse;

    expect(imgTransResp.ok).toBe(true);
    expect(imgTransResp.providerId).toBe('vision-oapi');
    expect(imgTransResp.regions).toEqual([
      { box: [100, 200, 300, 600], src: 'Hello Comic', trans: '你好漫画' },
    ]);
  });

  it('streams item-ready and done over margin:translate-stream port and routes keyboard shortcuts & context menus', async () => {
    const config = createDefaultMarginConfig();
    config.providers['stream-oapi'] = {
      id: 'stream-oapi',
      name: 'Stream OAPI',
      preset: 'openai',
      protocol: 'openai-chat',
      enabled: true,
      baseUrl: 'https://gateway.example.com/v1',
      apiKeys: ['sk-STREAM_FAKE'],
      model: 'gpt-4.1-mini',
      models: ['gpt-4.1-mini'],
      assistantId: 'builtin-delimiter',
      enableContext: false,
      enableRichHtml: true,
      stream: 'on',
      rateLimitRps: 50,
      maxConcurrency: 4,
      temperaturePolicy: { mode: 'omit' },
      thinkingPolicy: { mode: 'provider-default' },
    };
    config.routing.webpage = 'stream-oapi';
    await saveMarginConfig(config);

    const sseFrames = [
      'data: {"choices":[{"delta":{"content":"第一段渐进译文\\n\\n%%\\n\\n"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"第二段最终译文"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const sseFetch = vi.fn(async () => {
      const enc = new TextEncoder();
      const rs = new ReadableStream<Uint8Array>({
        start(ctrl) {
          for (const f of sseFrames) ctrl.enqueue(enc.encode(f));
          ctrl.close();
        },
      });
      return new Response(rs, { status: 200 });
    });

    const postedMessages: TranslateStreamPortMessage[] = [];
    const messageListeners: Array<(msg: unknown) => void> = [];
    const disconnectListeners: Array<() => void> = [];

    let resolveDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const fakePort = {
      name: BRAND.streamPortName,
      postMessage: (msg: TranslateStreamPortMessage) => {
        postedMessages.push(msg);
        if (msg.type === 'done' || msg.type === 'error') {
          resolveDone();
        }
      },
      disconnect: vi.fn(),
      onMessage: {
        addListener: (fn: (msg: unknown) => void) => messageListeners.push(fn),
      },
      onDisconnect: {
        addListener: (fn: () => void) => disconnectListeners.push(fn),
      },
    };

    attachStreamTranslationPort(
      fakePort as unknown as chrome.runtime.Port,
      {
        fetchImpl: sseFetch as unknown as typeof fetch,
        pool: new ProviderExecutionPool(),
      },
    );

    messageListeners[0]({
      type: 'start',
      payload: {
        requestId: 'stream-1',
        scene: 'webpage',
        fromLang: 'en',
        toLang: 'zh-CN',
        items: [
          { id: 1, text: 'First' },
          { id: 2, text: 'Second' },
        ],
      },
    } satisfies TranslateStreamPortMessage);

    await donePromise;

    const itemReadyMsgs = postedMessages.filter((m) => m.type === 'item-ready');
    expect(itemReadyMsgs).toEqual([
      {
        type: 'item-ready',
        requestId: 'stream-1',
        item: { id: 1, trans: '第一段渐进译文' },
      },
      {
        type: 'item-ready',
        requestId: 'stream-1',
        item: { id: 2, trans: '第二段最终译文' },
      },
    ]);

    const doneMsg = postedMessages.find((m) => m.type === 'done');
    expect(doneMsg?.type).toBe('done');

    // Verify Shortcut Commands (`Alt+A`, `Alt+W`, `Alt+M`, `Alt+I`) & Context Menus
    const sentTabMessages: Array<{ tabId: number; msg: unknown }> = [];
    const createdTabs: Array<{ url?: string }> = [];

    globalThis.chrome = {
      tabs: {
        sendMessage: vi.fn(async (tabId: number, msg: unknown) => {
          sentTabMessages.push({ tabId, msg });
        }),
        create: vi.fn(async (props: { url?: string }) => {
          createdTabs.push(props);
          return {} as chrome.tabs.Tab;
        }),
      },
      runtime: {
        getURL: (path: string) => `chrome-extension://${BRAND.pinnedExtensionId}/${path}`,
      },
    } as unknown as typeof chrome;

    await dispatchShortcutCommand('toggleTranslatePage', { id: 7 });
    await dispatchShortcutCommand('toggleTranslateWholePage', { id: 7 });
    await dispatchShortcutCommand('toggleTranslationMask', { id: 7 });
    await dispatchShortcutCommand('translateInputBox', { id: 7 });

    expect(sentTabMessages.map((x) => x.msg)).toEqual([
      { type: 'margin:cmd:toggle-page' },
      { type: 'margin:cmd:translate-whole-page' },
      { type: 'margin:cmd:toggle-mask' },
      { type: 'margin:cmd:translate-input' },
    ]);

    await handleContextMenuClicked(
      {
        menuItemId: CONTEXT_MENU_IDS.translateImage,
        srcUrl: 'https://cdn.example.com/comic.webp',
      },
      { id: 9 },
    );
    expect(sentTabMessages[sentTabMessages.length - 1]).toEqual({
      tabId: 9,
      msg: {
        type: 'margin:cmd:translate-context-image',
        srcUrl: 'https://cdn.example.com/comic.webp',
      },
    });

    await handleContextMenuClicked(
      {
        menuItemId: CONTEXT_MENU_IDS.openPdf,
        linkUrl: 'https://arxiv.org/pdf/2501.00001.pdf',
      },
      { id: 9 },
    );
    expect(createdTabs).toEqual([
      {
        url: `chrome-extension://${BRAND.pinnedExtensionId}/pdf.html?file=${encodeURIComponent(
          'https://arxiv.org/pdf/2501.00001.pdf',
        )}`,
      },
    ]);
  });
});
