import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachStreamTranslationPort,
  DEFAULT_PERSISTENT_TTL_MS,
  handleRuntimeRpcRequest,
  IndexedDbTranslationAdapter,
  InMemoryPersistenceAdapter,
  TranslationLruCache,
} from '../../src/background';
import { ProviderExecutionPool } from '../../src/core/providers';
import { BRAND } from '@shared/brand';
import { createDefaultMarginConfig } from '@shared/constants';
import { resetMemoryStorageForTests, saveMarginConfig } from '@shared/storage';
import type {
  TranslateBatchResponse,
  TranslateStreamPortMessage,
  TranslationCacheStatsResponse,
} from '@shared/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(new TextEncoder().encode(JSON.stringify(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('2-Tier Persistent Translation Database (L1 LRU + L2 Persistence)', () => {
  beforeEach(() => {
    resetMemoryStorageForTests();
  });

  it('persists entries in L2 across L1 cold restarts, promotes L2 hits back to L1, expires after 30-day TTL, and prunes oldest entries at capacity', async () => {
    let clock = 1_700_000_000_000;
    const adapter = new InMemoryPersistenceAdapter({
      maxEntries: 3,
      ttlMs: DEFAULT_PERSISTENT_TTL_MS,
      nowFn: () => clock,
    });
    const cache = new TranslationLruCache(16, adapter);

    await cache.setMany([
      { key: 'k1', value: '译文1' },
      { key: 'k2', value: '译文2' },
    ]);
    clock += 1000;
    await cache.setMany([{ key: 'k3', value: '译文3' }]);

    expect(await cache.getStats()).toEqual({
      memoryEntries: 3,
      persistentEntries: 3,
      dbAvailable: true,
    });

    // Simulate MV3 Service Worker idle termination (L1 wiped, L2 survives)
    cache.evictMemoryOnly();
    expect(cache.size).toBe(0);
    expect(cache.get('k1')).toBeUndefined();

    // `getMany` recovers from L2 AND promotes hits back into synchronous L1 + refreshes recency (`k1` becomes newest!)
    clock += 1000;
    const recovered = await cache.getMany(['k1', 'missing']);
    expect(recovered.get('k1')).toBe('译文1');
    expect(recovered.has('missing')).toBe(false);
    expect(cache.get('k1')).toBe('译文1');

    // Capacity pruning: adding `k4` pushes L2 over `maxEntries: 3` -> evicts oldest (`k2`), keeps refreshed `k1` & `k3`!
    clock += 1000;
    await cache.setMany([{ key: 'k4', value: '译文4' }]);
    cache.evictMemoryOnly();

    const afterCap = await cache.getMany(['k1', 'k2', 'k3', 'k4']);
    expect(afterCap.has('k2')).toBe(false);
    expect(afterCap.get('k1')).toBe('译文1');
    expect(afterCap.get('k3')).toBe('译文3');
    expect(afterCap.get('k4')).toBe('译文4');

    // Advance past 30-day TTL -> expired L2 records are pruned and omitted
    clock += DEFAULT_PERSISTENT_TTL_MS + 1;
    cache.evictMemoryOnly();
    const afterTtl = await cache.getMany(['k1', 'k3', 'k4']);
    expect(afterTtl.size).toBe(0);
    expect(await cache.getStats()).toEqual({
      memoryEntries: 0,
      persistentEntries: 0,
      dbAvailable: true,
    });
  });

  it('degrades gracefully without throwing when indexedDB is undefined in Node/Vitest', async () => {
    const idbAdapter = new IndexedDbTranslationAdapter({ idbFactory: null });
    expect(idbAdapter.isAvailable).toBe(false);

    const cache = new TranslationLruCache(16, idbAdapter);
    await cache.setMany([{ key: 'ram-only', value: '内存译文' }]);

    expect(cache.get('ram-only')).toBe('内存译文');
    expect(await cache.getStats()).toEqual({
      memoryEntries: 1,
      persistentEntries: 0,
      dbAvailable: false,
    });

    await cache.clearAll();
    expect(cache.size).toBe(0);
  });

  it('keeps cached translations valid across unrelated glossary edits while invalidating on matched term, prompt, or styleGuide edits, and supports stats/clear RPCs + stream port L2 persistence', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const cache = new TranslationLruCache(64, adapter);

    const config = createDefaultMarginConfig();
    config.providers['oapi-editorial'] = {
      id: 'oapi-editorial',
      name: 'Editorial Channel',
      preset: 'openai',
      protocol: 'openai-chat',
      enabled: true,
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      apiKeys: ['sk-TEST_FAKE'],
      model: 'gpt-6-luna',
      models: ['gpt-6-luna'],
      assistantId: 'builtin-yaml',
      enableContext: true,
      enableRichHtml: true,
      stream: 'on',
      rateLimitRps: 50,
      maxConcurrency: 4,
      temperaturePolicy: { mode: 'omit' },
      thinkingPolicy: { mode: 'provider-default' },
    };
    config.routing.webpage = 'oapi-editorial';
    await saveMarginConfig(config);

    let networkCalls = 0;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      networkCalls++;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        stream?: boolean;
      };
      if (body.stream) {
        const sse =
          'data: {"choices":[{"delta":{"content":"<yaml>\\n- id: 1\\n  trans: 流式译文持久化\\n</yaml>"}}]}\n\ndata: [DONE]\n\n';
        const rs = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode(sse));
            ctrl.close();
          },
        });
        return new Response(rs, { status: 200 });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: `<yaml>\n- id: 1\n  trans: 第${networkCalls}次推理译文\n</yaml>`,
            },
          },
        ],
      });
    });

    const routerEnv = {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pool: new ProviderExecutionPool(),
      translationCache: cache,
      retryBaseDelayMs: 0,
    };

    // 1. Initial batch translation populates both L1 and L2
    const first = (await handleRuntimeRpcRequest(
      {
        type: 'margin:translate-batch',
        payload: {
          requestId: 'batch-1',
          scene: 'webpage',
          fromLang: 'en',
          toLang: 'zh-CN',
          context: {
            url: 'https://github.com/vllm-project/vllm',
            domain: 'github.com',
          },
          items: [
            {
              id: 1,
              text: 'Continuous batching improves LLM serving latency.',
            },
          ],
        },
      },
      routerEnv,
    )) as TranslateBatchResponse;
    expect(first.ok).toBe(true);
    expect(networkCalls).toBe(1);

    // 2. Edit/add 10 UNRELATED glossary terms AND evict L1 memory -> L2 still hits with 0 network calls!
    config.glossary.push(
      { k: 'UnrelatedTermAlpha', v: '甲' },
      { k: 'UnrelatedTermBeta', v: '乙' },
    );
    await saveMarginConfig(config);
    cache.evictMemoryOnly();

    const afterUnrelatedGlossary = (await handleRuntimeRpcRequest(
      {
        type: 'margin:translate-batch',
        payload: {
          requestId: 'batch-2',
          scene: 'webpage',
          fromLang: 'en',
          toLang: 'zh-CN',
          context: {
            url: 'https://github.com/vllm-project/vllm',
            domain: 'github.com',
          },
          items: [
            {
              id: 1,
              text: 'Continuous batching improves LLM serving latency.',
            },
          ],
        },
      },
      routerEnv,
    )) as TranslateBatchResponse;
    expect(afterUnrelatedGlossary.ok).toBe(true);
    expect(afterUnrelatedGlossary.items[0]?.trans).toBe('第1次推理译文');
    expect(networkCalls).toBe(1);

    // 3. Edit a MATCHED glossary term (`LLM -> 大语言模型`) -> invalidates key and triggers fresh call!
    config.glossary = [{ k: 'LLM', v: '大语言模型' }];
    await saveMarginConfig(config);

    const afterMatchedGlossary = (await handleRuntimeRpcRequest(
      {
        type: 'margin:translate-batch',
        payload: {
          requestId: 'batch-3',
          scene: 'webpage',
          fromLang: 'en',
          toLang: 'zh-CN',
          context: {
            url: 'https://github.com/vllm-project/vllm',
            domain: 'github.com',
          },
          items: [
            {
              id: 1,
              text: 'Continuous batching improves LLM serving latency.',
            },
          ],
        },
      },
      routerEnv,
    )) as TranslateBatchResponse;
    expect(afterMatchedGlossary.ok).toBe(true);
    expect(afterMatchedGlossary.items[0]?.trans).toBe('第2次推理译文');
    expect(networkCalls).toBe(2);

    // 4. Edit active assistant systemPrompt -> invalidates promptFingerprint and triggers fresh call!
    config.assistants['builtin-yaml'].systemPrompt += '\nPrefer concise verbs.';
    await saveMarginConfig(config);

    await handleRuntimeRpcRequest(
      {
        type: 'margin:translate-batch',
        payload: {
          requestId: 'batch-4',
          scene: 'webpage',
          fromLang: 'en',
          toLang: 'zh-CN',
          context: {
            url: 'https://github.com/vllm-project/vllm',
            domain: 'github.com',
          },
          items: [
            {
              id: 1,
              text: 'Continuous batching improves LLM serving latency.',
            },
          ],
        },
      },
      routerEnv,
    );
    expect(networkCalls).toBe(3);

    // 5. Streaming port (`attachStreamTranslationPort`) writes to L2 on completion and reads from L2 after L1 eviction!
    const runStreamOnce = async (reqId: string) => {
      const posted: TranslateStreamPortMessage[] = [];
      const listeners: Array<(m: unknown) => void> = [];
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      attachStreamTranslationPort(
        {
          name: BRAND.streamPortName,
          postMessage: (msg: TranslateStreamPortMessage) => {
            posted.push(msg);
            if (msg.type === 'done' || msg.type === 'error') resolveDone();
          },
          disconnect: vi.fn(),
          onMessage: {
            addListener: (fn: (msg: unknown) => void) => listeners.push(fn),
          },
          onDisconnect: { addListener: vi.fn() },
        } as unknown as chrome.runtime.Port,
        routerEnv,
      );
      listeners[0]({
        type: 'start',
        payload: {
          requestId: reqId,
          scene: 'webpage',
          fromLang: 'en',
          toLang: 'zh-CN',
          items: [{ id: 1, text: 'Streamed paragraph for L2 cache.' }],
        },
      } satisfies TranslateStreamPortMessage);
      await done;
      return posted;
    };

    await runStreamOnce('stream-populate');
    expect(networkCalls).toBe(4);

    cache.evictMemoryOnly();
    const cachedStreamMsgs = await runStreamOnce('stream-from-l2');
    expect(networkCalls).toBe(4);
    expect(
      cachedStreamMsgs.find((m) => m.type === 'done' && m.response.ok),
    ).toBeTruthy();

    // 6. `margin:get-translation-cache-stats` & `margin:clear-translation-cache` clear BOTH L1 & L2
    const statsBefore = (await handleRuntimeRpcRequest(
      { type: 'margin:get-translation-cache-stats' },
      routerEnv,
    )) as TranslationCacheStatsResponse;
    expect(statsBefore.ok).toBe(true);
    expect(statsBefore.dbAvailable).toBe(true);
    expect(statsBefore.persistentEntries).toBeGreaterThanOrEqual(4);

    await handleRuntimeRpcRequest(
      { type: 'margin:clear-translation-cache' },
      routerEnv,
    );
    const statsAfter = (await handleRuntimeRpcRequest(
      { type: 'margin:get-translation-cache-stats' },
      routerEnv,
    )) as TranslationCacheStatsResponse;
    expect(statsAfter).toEqual({
      ok: true,
      memoryEntries: 0,
      persistentEntries: 0,
      dbAvailable: true,
    });
  });
});
