import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachStreamTranslationPort,
  computeAssistantPromptFingerprint,
  DEFAULT_PERSISTENT_TTL_MS,
  handleRuntimeRpcRequest,
  IndexedDbTranslationAdapter,
  InMemoryPersistenceAdapter,
  makeTranslationCacheKey,
  TranslationLruCache,
  type TranslationDbRecord,
  type TranslationPersistenceAdapter,
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

  it('serializes makeTranslationCacheKey unambiguously across :: delimiters, endpoint/protocol, temperature/thinking policies, and single-text AI assistant prompts (#127 #13)', () => {
    const baseParams = {
      providerId: 'prov',
      protocol: 'openai-chat' as const,
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4.1-mini',
      codecId: 'yaml',
      scene: 'webpage' as const,
      fromLang: 'en',
      toLang: 'zh-CN',
      sourceText: 'Hello :: world',
    };

    // 1. Delimiter collision prevention (`::` inside fields never produces identical keys)
    const kDelimA = makeTranslationCacheKey({
      ...baseParams,
      providerId: 'prov::x',
      model: 'm1',
    });
    const kDelimB = makeTranslationCacheKey({
      ...baseParams,
      providerId: 'prov',
      model: 'x::m1',
    });
    expect(kDelimA).not.toBe(kDelimB);
    expect(() => JSON.parse(kDelimA)).not.toThrow();

    // 2. Endpoint & protocol changes invalidate cache key
    const kDifferentEndpoint = makeTranslationCacheKey({
      ...baseParams,
      endpoint: 'https://proxy.example.org/v1/chat/completions',
    });
    const kDifferentProtocol = makeTranslationCacheKey({
      ...baseParams,
      protocol: 'anthropic-messages',
    });
    expect(kDifferentEndpoint).not.toBe(makeTranslationCacheKey(baseParams));
    expect(kDifferentProtocol).not.toBe(makeTranslationCacheKey(baseParams));

    // 3. Temperature & thinking policy changes invalidate cache key
    const kTempCustom = makeTranslationCacheKey({
      ...baseParams,
      temperaturePolicy: { mode: 'custom', value: 0.7 },
    });
    const kThinkingEnabled = makeTranslationCacheKey({
      ...baseParams,
      thinkingPolicy: { mode: 'enabled', budgetTokens: 2048 },
    });
    const kThinkingBudgetChanged = makeTranslationCacheKey({
      ...baseParams,
      thinkingPolicy: { mode: 'enabled', budgetTokens: 4096 },
    });
    expect(kTempCustom).not.toBe(makeTranslationCacheKey(baseParams));
    expect(kThinkingEnabled).not.toBe(makeTranslationCacheKey(baseParams));
    expect(kThinkingBudgetChanged).not.toBe(kThinkingEnabled);

    // 4. Custom AI assistant prompts on `single-text` codec produce distinct fingerprints (not hardcoded `p0`)
    const cfg = createDefaultMarginConfig();
    const singleTextAstA = {
      ...structuredClone(cfg.assistants['builtin-yaml']),
      id: 'ast-single',
      codec: 'single-text' as const,
      systemPrompt: 'Translate poetically.',
      prompt: '{{text}}',
    };
    const singleTextAstB = {
      ...singleTextAstA,
      systemPrompt: 'Translate literally for legal review.',
    };

    const fpA = computeAssistantPromptFingerprint(
      singleTextAstA,
      'webpage',
      'single-text',
    );
    const fpB = computeAssistantPromptFingerprint(
      singleTextAstB,
      'webpage',
      'single-text',
    );
    expect(fpA).not.toBe('p0');
    expect(fpA).not.toBe(fpB);
    expect(computeAssistantPromptFingerprint(undefined, 'webpage', 'single-text')).toBe(
      'p0',
    );

    expect(
      makeTranslationCacheKey({
        ...baseParams,
        codecId: 'single-text',
        assistant: singleTextAstA,
      }),
    ).not.toBe(
      makeTranslationCacheKey({
        ...baseParams,
        codecId: 'single-text',
        assistant: singleTextAstB,
      }),
    );
  });

  it('fences L2 getMany promotions and pre-clear upstream setMany writes via monotonic clearEpoch (#127 #13)', async () => {
    let releaseL2Get!: () => void;
    const l2GetGate = new Promise<void>((r) => {
      releaseL2Get = r;
    });

    const slowBacking = new Map<string, string>([['k-stale', '旧译文']]);
    const slowAdapter: TranslationPersistenceAdapter = {
      isAvailable: true,
      async getMany(keys) {
        await l2GetGate;
        const out = new Map<string, string>();
        for (const k of keys) {
          const v = slowBacking.get(k);
          if (v !== undefined) out.set(k, v);
        }
        return out;
      },
      async putMany(entries) {
        for (const e of entries) {
          slowBacking.set(e.key, e.value);
        }
      },
      async count() {
        return slowBacking.size;
      },
      async clear() {
        slowBacking.clear();
      },
    };

    const cache = new TranslationLruCache(32, slowAdapter);

    // 1. Start `getMany` before `clearAll()`, then clear while L2 read is still suspended
    const pendingRead = cache.getMany(['k-stale']);
    await cache.clearAll();
    // Simulate stale snapshot already read before clear resolving after `clearAll()`
    slowBacking.set('k-stale', '旧译文');
    const staleSnapshot = await (async () => {
      releaseL2Get();
      return pendingRead;
    })();
    slowBacking.clear();

    expect(staleSnapshot.size).toBe(0);
    expect(cache.size).toBe(0);
    expect(cache.get('k-stale')).toBeUndefined();

    // 2. Start an upstream `margin:translate-batch` BEFORE `margin:clear-translation-cache`, finish fetch AFTER clear
    const memAdapter = new InMemoryPersistenceAdapter();
    const rpcCache = new TranslationLruCache(32, memAdapter);
    const config = createDefaultMarginConfig();
    config.providers['slow-ai'] = {
      id: 'slow-ai',
      name: 'Slow AI',
      preset: 'openai',
      protocol: 'openai-chat',
      enabled: true,
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      apiKeys: ['sk-TEST'],
      model: 'gpt-4.1-mini',
      models: ['gpt-4.1-mini'],
      assistantId: 'builtin-yaml',
      enableContext: false,
      enableRichHtml: true,
      stream: 'off',
      rateLimitRps: 50,
      maxConcurrency: 4,
      temperaturePolicy: { mode: 'omit' },
      thinkingPolicy: { mode: 'provider-default' },
    };
    config.routing.webpage = 'slow-ai';
    await saveMarginConfig(config);

    let releaseUpstream!: () => void;
    const upstreamGate = new Promise<void>((r) => {
      releaseUpstream = r;
    });
    const fetchMock = vi.fn(async () => {
      await upstreamGate;
      return jsonResponse({
        choices: [
          {
            message: {
              content: '<yaml>\n- id: 1\n  trans: 清空前的在途译文\n</yaml>',
            },
          },
        ],
      });
    });

    const env = {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pool: new ProviderExecutionPool(),
      translationCache: rpcCache,
    };

    const inFlightBatch = handleRuntimeRpcRequest(
      {
        type: 'margin:translate-batch',
        payload: {
          requestId: 'pre-clear-batch',
          scene: 'webpage',
          fromLang: 'en',
          toLang: 'zh-CN',
          items: [{ id: 1, text: 'In-flight before clear' }],
        },
      },
      env,
    ) as Promise<TranslateBatchResponse>;

    await new Promise((r) => setTimeout(r, 15));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Clear cache while upstream call is mid-flight!
    await handleRuntimeRpcRequest(
      { type: 'margin:clear-translation-cache' },
      env,
    );

    releaseUpstream();
    const batchResp = await inFlightBatch;
    // Live caller still gets its translation, while cleared L1 + L2 are NEVER repopulated!
    expect(batchResp.ok).toBe(true);
    expect(batchResp.items).toEqual([{ id: 1, trans: '清空前的在途译文' }]);
    expect(await rpcCache.getStats()).toEqual({
      memoryEntries: 0,
      persistentEntries: 0,
      dbAvailable: true,
    });
  });

  it('registers IndexedDB txDone before awaiting requests and prevents cursor error default tx abort (#127 #7)', async () => {
    const records = new Map<string, TranslationDbRecord>();
    let simulateCursorErrorOnExpiry = true;

    // Mock IDB where `tx.oncomplete` fires synchronously inside the final request's `onsuccess`
    // (BEFORE any `await idbRequestToPromise(...)` continuation resumes) AND uncanceled `onerror` aborts `tx`!
    const fakeDb = {
      objectStoreNames: { contains: () => true },
      onversionchange: null as (() => void) | null,
      close: vi.fn(),
      transaction: (_storeName: string, _mode: IDBTransactionMode) => {
        let pendingRequests = 0;
        let aborted = false;
        const tx: Record<string, unknown> = {
          error: null,
          oncomplete: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onabort: null as (() => void) | null,
        };

        const finishRequest = () => {
          pendingRequests--;
          if (pendingRequests === 0 && !aborted) {
            queueMicrotask(() => {
              if (pendingRequests === 0 && !aborted) {
                (tx.oncomplete as (() => void) | null)?.();
              }
            });
          }
        };

        const makeReq = <T>(compute: () => T) => {
          pendingRequests++;
          const req: Record<string, unknown> = {
            result: undefined as unknown as T,
            error: null,
            onsuccess: null as (() => void) | null,
            onerror: null as ((ev: Event) => void) | null,
          };
          queueMicrotask(() => {
            req.result = compute();
            (req.onsuccess as (() => void) | null)?.();
            finishRequest();
          });
          return req as unknown as IDBRequest<T>;
        };

        tx.objectStore = () => ({
          indexNames: {
            contains: (name: string) =>
              name === 'byExpiresAt' || name === 'byUpdatedAt',
          },
          get: (k: string) => makeReq(() => records.get(k)),
          put: (rec: TranslationDbRecord) =>
            makeReq(() => {
              records.set(rec.key, rec);
              return rec.key;
            }),
          delete: (k: string) =>
            makeReq(() => {
              records.delete(k);
            }),
          clear: () =>
            makeReq(() => {
              records.clear();
            }),
          count: () => makeReq(() => records.size),
          index: (indexName: string) => ({
            count: () => makeReq(() => records.size),
            openCursor: () => {
              pendingRequests++;
              const req: Record<string, unknown> = {
                result: null,
                error: new Error('Transient cursor failure'),
                onsuccess: null as (() => void) | null,
                onerror: null as ((ev: Event) => void) | null,
              };
              queueMicrotask(() => {
                if (
                  indexName === 'byExpiresAt' &&
                  simulateCursorErrorOnExpiry
                ) {
                  let defaultPrevented = false;
                  const ev = {
                    preventDefault: () => {
                      defaultPrevented = true;
                    },
                  } as unknown as Event;
                  (req.onerror as ((e: Event) => void) | null)?.(ev);
                  pendingRequests--;
                  if (!defaultPrevented) {
                    aborted = true;
                    tx.error = new Error('Uncanceled cursor error aborted tx');
                    (tx.onabort as (() => void) | null)?.();
                    return;
                  }
                  if (pendingRequests === 0 && !aborted) {
                    (tx.oncomplete as (() => void) | null)?.();
                  }
                  return;
                }
                (req.onsuccess as (() => void) | null)?.();
                finishRequest();
              });
              return req as unknown as IDBRequest<IDBCursorWithValue | null>;
            },
          }),
        });

        return tx as unknown as IDBTransaction;
      },
    };

    const fakeFactory = {
      open: () => {
        const openReq: Record<string, unknown> = {
          result: fakeDb,
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          onblocked: null,
        };
        queueMicrotask(() => {
          (openReq.onsuccess as (() => void) | null)?.();
        });
        return openReq as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;

    // Ensure `IDBKeyRange` exists in Node test environment so `pruneStoreIfNeeded` & `count` exercise index branches
    const origKeyRange = (globalThis as Record<string, unknown>).IDBKeyRange;
    (globalThis as Record<string, unknown>).IDBKeyRange = {
      upperBound: (v: number) => ({ upper: v }),
      lowerBound: (v: number) => ({ lower: v }),
    };

    try {
      const idbAdapter = new IndexedDbTranslationAdapter({
        idbFactory: fakeFactory,
        maxEntries: 5,
      });

      // None of `putMany` (including `pruneStoreIfNeeded` with cursor error + `total <= maxEntries`), `getMany`, `count`, or `clear` may hang!
      await Promise.race([
        (async () => {
          await idbAdapter.putMany([{ key: 'idb-1', value: '持久化译文' }], 1000);
          const got = await idbAdapter.getMany(['idb-1'], 1001);
          expect(got.get('idb-1')).toBe('持久化译文');
          simulateCursorErrorOnExpiry = false;
          expect(await idbAdapter.count(1001)).toBe(1);
          await idbAdapter.clear();
          expect(await idbAdapter.count(1001)).toBe(0);
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('IndexedDB adapter hung on txDone!')),
            500,
          ),
        ),
      ]);
    } finally {
      (globalThis as Record<string, unknown>).IDBKeyRange = origKeyRange;
    }
  });

  it('serializes persistence writes and clearAll in FIFO order so slow pre-clear putMany never clobbers post-clear entries', async () => {
    const store = new Map<string, string>();
    let releaseFirstPut!: () => void;
    const firstPutGate = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    let putCallCount = 0;

    const slowAdapter: TranslationPersistenceAdapter = {
      isAvailable: true,
      async getMany(keys) {
        const out = new Map<string, string>();
        for (const k of keys) {
          const v = store.get(k);
          if (v !== undefined) out.set(k, v);
        }
        return out;
      },
      async putMany(entries) {
        putCallCount += 1;
        if (putCallCount === 1) {
          await firstPutGate;
        }
        for (const e of entries) {
          store.set(e.key, e.value);
        }
      },
      async clear() {
        store.clear();
      },
      async count() {
        return store.size;
      },
    };

    const cache = new TranslationLruCache(16, slowAdapter);

    // 1. Start slow pre-clear write, then immediately call clearAll() + post-clear setMany()
    const preClearPromise = cache.setMany([{ key: 'k-stale', value: '旧译文' }]);
    const clearPromise = cache.clearAll();
    const postClearPromise = cache.setMany([{ key: 'k-fresh', value: '新译文' }]);

    // Release slow pre-clear putMany: FIFO queue ensures `put(stale) -> clear() -> put(fresh)`!
    releaseFirstPut();
    await Promise.all([preClearPromise, clearPromise, postClearPromise]);

    expect(store.has('k-stale')).toBe(false);
    expect(store.get('k-fresh')).toBe('新译文');
    cache.evictMemoryOnly();
    const hydrated = await cache.getMany(['k-stale', 'k-fresh']);
    expect(hydrated.has('k-stale')).toBe(false);
    expect(hydrated.get('k-fresh')).toBe('新译文');
  });
});
