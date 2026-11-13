import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenAiChatRequestBody,
  executeBatchWithProvider,
  ProviderExecutionPool,
  resolveRequestPriority,
} from '../../src/core/providers';
import { BUILTIN_ASSISTANTS } from '@shared/constants';
import {
  getCapabilityCache,
  recordModelCapability,
  resetMemoryStorageForTests,
} from '@shared/storage';
import {
  isOpenAiLightReasoningModel,
  makeCapabilityKey,
  shouldStripReasoningEffortAndRetry,
} from '@shared/temperature';
import type { ProviderConfig } from '@shared/types';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createOpenAiProvider(
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'openai-v23',
    name: 'OpenAI v2.3',
    preset: 'openai',
    protocol: 'openai-chat',
    enabled: true,
    baseUrl: 'https://api.example.com/v1',
    apiKeys: ['sk-TEST_FAKE_KEY'],
    model: 'gpt-6-luna',
    models: ['gpt-6-luna', 'gpt-5-mini', 'o3-mini', 'gpt-4o-mini'],
    assistantId: 'builtin-yaml',
    enableContext: true,
    enableRichHtml: true,
    stream: 'off',
    rateLimitRps: 50,
    maxConcurrency: 4,
    temperaturePolicy: { mode: 'omit' },
    thinkingPolicy: { mode: 'provider-default' },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(new TextEncoder().encode(JSON.stringify(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('4-Tier Preemptive Priority Queue & Scene-Aware Light Reasoning', () => {
  beforeEach(() => {
    resetMemoryStorageForTests();
  });

  it('executes queued waiters strictly in ascending priority order (-1 > 0 > 1 > 2) with FIFO within equal priority', async () => {
    const pool = new ProviderExecutionPool();
    const provider = { id: 'prov-prio', maxConcurrency: 1, rateLimitRps: 0 };

    const blocker = createDeferred<void>();
    const executionOrder: string[] = [];

    const pBlocker = pool.schedule(
      provider,
      undefined,
      async () => {
        executionOrder.push('active-slot');
        await blocker.promise;
      },
      0,
    );

    // Enqueue in mixed priority order while slot is occupied
    const pP2a = pool.schedule(
      provider,
      undefined,
      async () => {
        executionOrder.push('p2-a');
      },
      2,
    );
    const pP1a = pool.schedule(
      provider,
      undefined,
      async () => {
        executionOrder.push('p1-a');
      },
      1,
    );
    const pP0a = pool.schedule(
      provider,
      undefined,
      async () => {
        executionOrder.push('p0-a');
      },
      0,
    );
    const pVipa = pool.schedule(
      provider,
      undefined,
      async () => {
        executionOrder.push('vip-a');
      },
      -1,
    );
    const pP1b = pool.schedule(
      provider,
      undefined,
      async () => {
        executionOrder.push('p1-b');
      },
      1,
    );
    const pVipb = pool.schedule(
      provider,
      undefined,
      async () => {
        executionOrder.push('vip-b');
      },
      -1,
    );
    const pP0b = pool.schedule(
      provider,
      undefined,
      async () => {
        executionOrder.push('p0-b');
      },
      0,
    );
    const pP2b = pool.schedule(
      provider,
      undefined,
      async () => {
        executionOrder.push('p2-b');
      },
      2,
    );

    expect(pool.getPendingCount('prov-prio')).toBe(8);

    blocker.resolve();
    await Promise.all([
      pBlocker,
      pP2a,
      pP1a,
      pP0a,
      pVipa,
      pP1b,
      pVipb,
      pP0b,
      pP2b,
    ]);

    expect(pool.getPendingCount('prov-prio')).toBe(0);
    expect(executionOrder).toEqual([
      'active-slot',
      'vip-a',
      'vip-b',
      'p0-a',
      'p0-b',
      'p1-a',
      'p1-b',
      'p2-a',
      'p2-b',
    ]);
  });

  it('splices out aborted queued waiters immediately without consuming a concurrency slot or RPS token', async () => {
    let nowMs = 10_000;
    const sleepCalls: number[] = [];
    const pool = new ProviderExecutionPool({
      now: () => nowMs,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        nowMs += ms;
      },
    });
    const provider = { id: 'prov-abort', maxConcurrency: 1, rateLimitRps: 1 };

    const blocker = createDeferred<void>();
    const activeDone = pool.schedule(
      provider,
      undefined,
      async () => {
        await blocker.promise;
      },
      0,
    );

    const abortCtrl = new AbortController();
    const abortedRan = vi.fn();
    const abortedPromise = pool.schedule(
      provider,
      abortCtrl.signal,
      async () => {
        abortedRan();
      },
      -1,
    );

    const survivorRan = vi.fn();
    const survivorPromise = pool.schedule(
      provider,
      undefined,
      async () => {
        survivorRan();
      },
      1,
    );

    expect(pool.getPendingCount('prov-abort')).toBe(2);

    // Abort the queued VIP waiter while blocker is still holding the slot
    abortCtrl.abort();
    expect(pool.getPendingCount('prov-abort')).toBe(1);
    await expect(abortedPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedRan).not.toHaveBeenCalled();

    // Advance time past the 1s RPS window of the active slot, release slot -> survivor runs with zero extra RPS sleep!
    nowMs += 1_100;
    sleepCalls.length = 0;
    blocker.resolve();
    await Promise.all([activeDone, survivorPromise]);

    expect(survivorRan).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toEqual([]);
    expect(pool.getPendingCount('prov-abort')).toBe(0);
  });

  it('maps resolveRequestPriority across scenes and explicit overrides', () => {
    expect(resolveRequestPriority('selection')).toBe(-1);
    expect(resolveRequestPriority('input')).toBe(-1);
    expect(resolveRequestPriority('hover')).toBe(-1);
    expect(resolveRequestPriority('subtitle')).toBe(0);
    expect(resolveRequestPriority('webpage')).toBe(0);
    expect(resolveRequestPriority('webpage', -1)).toBe(-1);
    expect(resolveRequestPriority('webpage', 1)).toBe(1);
    expect(resolveRequestPriority('webpage', 2)).toBe(2);
    expect(resolveRequestPriority('pdf')).toBe(1);
  });

  it('sets reasoning_effort: "low" for provider-default reasoning models on webpage/hover/subtitle and omits on selection or gpt-4o-mini', () => {
    expect(isOpenAiLightReasoningModel('gpt-6-luna')).toBe(true);
    expect(isOpenAiLightReasoningModel('gpt-5-mini')).toBe(true);
    expect(isOpenAiLightReasoningModel('o3-mini')).toBe(true);
    expect(isOpenAiLightReasoningModel('gpt-4o-mini')).toBe(false);
    expect(isOpenAiLightReasoningModel('gpt-5.3-codex-spark')).toBe(false);

    for (const model of ['gpt-6-luna', 'gpt-5-mini', 'o3-mini']) {
      for (const scene of ['webpage', 'hover', 'subtitle'] as const) {
        const body = buildOpenAiChatRequestBody({
          provider: createOpenAiProvider({
            model,
            thinkingPolicy: { mode: 'provider-default' },
          }),
          scene,
          systemPrompt: 'sys',
          userPrompt: 'usr',
          stream: false,
        });
        expect(body.reasoning_effort).toBe('low');
      }

      // Selection scene omits reasoning_effort
      const selectionBody = buildOpenAiChatRequestBody({
        provider: createOpenAiProvider({
          model,
          thinkingPolicy: { mode: 'provider-default' },
        }),
        scene: 'selection',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        stream: false,
      });
      expect(selectionBody).not.toHaveProperty('reasoning_effort');
    }

    // Non-reasoning model omits reasoning_effort even on webpage/hover/subtitle
    const nonReasoningBody = buildOpenAiChatRequestBody({
      provider: createOpenAiProvider({
        model: 'gpt-4o-mini',
        thinkingPolicy: { mode: 'provider-default' },
      }),
      scene: 'webpage',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      stream: false,
    });
    expect(nonReasoningBody).not.toHaveProperty('reasoning_effort');
  });

  it('recovers from HTTP 400 unsupported reasoning_effort by stripping, retrying once cleanly, and merging supportsReasoningEffort: false while preserving supportsTemperature', async () => {
    expect(
      shouldStripReasoningEffortAndRetry(
        400,
        `{"error":{"message":"Unsupported parameter: 'reasoning_effort'"}}`,
        true,
      ),
    ).toBe(true);
    expect(
      shouldStripReasoningEffortAndRetry(
        400,
        `{"error":{"message":"Unsupported parameter: 'reasoning_effort'"}}`,
        false,
      ),
    ).toBe(false);

    const provider = createOpenAiProvider({
      baseUrl: 'https://gateway.example.com/v1/chat/completions',
      model: 'gpt-6-luna',
      thinkingPolicy: { mode: 'provider-default' },
    });
    const capKey = makeCapabilityKey(provider.baseUrl, provider.model);

    // Pre-seed existing supportsTemperature field to verify non-destructive capability merge!
    await recordModelCapability(capKey, {
      supportsTemperature: false,
      learnedFromStatus: 400,
      updatedAt: Date.now() - 1000,
    });

    const sentPayloads: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<
          string,
          unknown
        >;
        sentPayloads.push(body);

        if (body.reasoning_effort !== undefined) {
          return jsonResponse(
            {
              error: {
                message: "Unsupported parameter: 'reasoning_effort'",
                type: 'invalid_request_error',
              },
            },
            400,
          );
        }

        return jsonResponse({
          choices: [
            {
              message: {
                content: '<yaml>\n- id: 1\n  trans: 自愈成功\n</yaml>',
              },
            },
          ],
        });
      },
    );

    const pool = new ProviderExecutionPool();
    const firstRes = await executeBatchWithProvider({
      scene: 'webpage',
      provider,
      assistant: BUILTIN_ASSISTANTS['builtin-yaml'],
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Self-heal reasoning effort' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      pool,
      retryBaseDelayMs: 0,
    });

    expect(firstRes.ok).toBe(true);
    expect(firstRes.items).toEqual([{ id: 1, trans: '自愈成功' }]);
    expect(firstRes.diagnostic.attempts).toBe(2);
    expect(firstRes.diagnostic.kind).toBe('unsupported-param-recovered');
    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[0].reasoning_effort).toBe('low');
    expect(sentPayloads[1]).not.toHaveProperty('reasoning_effort');

    const cacheAfter = await getCapabilityCache();
    expect(cacheAfter[capKey]).toMatchObject({
      supportsTemperature: false,
      supportsReasoningEffort: false,
      learnedFromStatus: 400,
    });

    // Second request uses cached supportsReasoningEffort: false -> omits reasoning_effort on attempt 1
    sentPayloads.length = 0;
    const secondRes = await executeBatchWithProvider({
      scene: 'hover',
      provider,
      assistant: BUILTIN_ASSISTANTS['builtin-yaml'],
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Cached capability check' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      pool,
      retryBaseDelayMs: 0,
    });
    expect(secondRes.ok).toBe(true);
    expect(secondRes.diagnostic.attempts).toBe(1);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]).not.toHaveProperty('reasoning_effort');
  });
});
