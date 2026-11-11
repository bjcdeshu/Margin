import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeBatchWithProvider,
  ProviderExecutionPool,
} from '../../src/core/providers';
import { BUILTIN_ASSISTANTS } from '@shared/constants';
import {
  getCapabilityCache,
  resetMemoryStorageForTests,
} from '@shared/storage';
import {
  makeCapabilityKey,
  normalizeTemperaturePolicy,
  resolveEffectiveTemperature,
} from '@shared/temperature';
import type { AssistantConfig, ProviderConfig } from '@shared/types';

function createMockOpenAiProvider(
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'openai-bytb6BIB',
    name: 'Unbow Gateway',
    preset: 'openai',
    protocol: 'openai-chat',
    enabled: true,
    baseUrl: 'https://gateway.example.com/v1',
    apiKeys: ['sk-TEST_FAKE_KEY_ONE', 'sk-TEST_FAKE_KEY_TWO'],
    model: 'gpt-6-luna',
    models: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-4.1-mini'],
    assistantId: 'custom',
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

const aloxafAssistant: AssistantConfig = {
  ...structuredClone(BUILTIN_ASSISTANTS['builtin-yaml']),
  id: 'custom',
  temperaturePolicy: { mode: 'custom', value: 0.3 },
};

function jsonResponse(body: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('4-Defense Temperature Engine & All 5 Legacy Bug Scenarios', () => {
  beforeEach(() => {
    resetMemoryStorageForTests();
  });

  it('Scenario 1 & 2 (Layers 1 & 2): undefined, null, and "" always normalize to omit and never send temperature: 0', async () => {
    expect(normalizeTemperaturePolicy(undefined)).toEqual({ mode: 'omit' });
    expect(normalizeTemperaturePolicy(null)).toEqual({ mode: 'omit' });
    expect(normalizeTemperaturePolicy('')).toEqual({ mode: 'omit' });
    expect(normalizeTemperaturePolicy('   ')).toEqual({ mode: 'omit' });

    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      return jsonResponse({
        choices: [
          {
            message: {
              content: '<yaml>\n- id: 1\n  trans: 你好\n</yaml>',
            },
          },
        ],
      });
    });

    const provider = createMockOpenAiProvider({
      model: 'gpt-4.1-mini',
      assistantId: undefined,
      temperaturePolicy: normalizeTemperaturePolicy(undefined),
    });

    const res = await executeBatchWithProvider({
      scene: 'webpage',
      provider,
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Hello' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      pool: new ProviderExecutionPool(),
    });

    // Note: without assistantId, default codec is `json-batch`
    expect(capturedBody).not.toHaveProperty('temperature');
    expect(res.diagnostic.parameters.temperatureTrace).toBe('omitted-default');
  });

  it('Scenario 3 & 4 (Layers 3 & 4): Reasoning Guard omits Aloxaf 0.3 on gpt-6-luna, gpt-5.6-luna, and deepseek-extended gpt-5.3-codex-spark while keeping 0.3 on glm-4.7 & deepseek-chat (no 0.01 clobber!)', async () => {
    // 1. Reasoning / Codex models MUST omit assistant 0.3 regardless of preset (`openai` or `deepseek`)
    for (const [preset, model] of [
      ['openai', 'gpt-6-luna'],
      ['openai', 'gpt-5.6-luna'],
      ['deepseek', 'gpt-5.3-codex-spark'],
      ['openai', 'o3-mini-high'],
      ['deepseek', 'deepseek-reasoner'],
    ] as const) {
      const resolved = resolveEffectiveTemperature({
        model,
        providerPolicy: { mode: 'omit' },
        assistantPolicy: aloxafAssistant.temperaturePolicy,
      });
      expect(resolved).toEqual({
        value: undefined,
        trace: 'omitted-reasoning-guard',
      });

      let sentBody: Record<string, unknown> = {};
      const fetchMock = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({
          choices: [
            { message: { content: '<yaml>\n- id: 1\n  trans: 译文\n</yaml>' } },
          ],
        });
      });

      const out = await executeBatchWithProvider({
        scene: 'webpage',
        provider: createMockOpenAiProvider({ preset, model }),
        assistant: aloxafAssistant,
        fromLang: 'en',
        toLang: 'zh-CN',
        items: [{ id: 1, text: 'Source' }],
        fetchImpl: fetchMock as unknown as typeof fetch,
        pool: new ProviderExecutionPool(),
      });

      expect(out.ok).toBe(true);
      expect(sentBody).not.toHaveProperty('temperature');
      expect(out.diagnostic.parameters.temperatureTrace).toBe(
        'omitted-reasoning-guard',
      );
    }

    // 2. Zhipu `glm-4.7` and `deepseek-chat` inherit Aloxaf's `0.3` cleanly WITHOUT Zhipu `0.01` clobbering
    let zhipuBody: Record<string, unknown> = {};
    const zhipuFetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      zhipuBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return jsonResponse({
        choices: [
          { message: { content: '<yaml>\n- id: 1\n  trans: 智谱译文\n</yaml>' } },
        ],
      });
    });

    const zhipuRes = await executeBatchWithProvider({
      scene: 'webpage',
      provider: createMockOpenAiProvider({
        id: 'zhipu-custom',
        preset: 'zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        model: 'glm-4.7',
        thinkingPolicy: { mode: 'disabled' },
      }),
      assistant: aloxafAssistant,
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Hello GLM' }],
      fetchImpl: zhipuFetch as unknown as typeof fetch,
      pool: new ProviderExecutionPool(),
    });

    expect(zhipuRes.ok).toBe(true);
    expect(zhipuBody.temperature).toBe(0.3);
    expect(zhipuBody.thinking).toEqual({ type: 'disabled' });
    expect(zhipuRes.diagnostic.parameters.temperatureTrace).toBe(
      'sent-assistant-custom',
    );
    expect(zhipuRes.diagnostic.parameters.temperatureSent).toBe(0.3);
  });

  it('Scenario 5 (Defense 4): HTTP 400 unsupported temperature strips temperature, caches capability, retries transparently once, and skips temperature on next request', async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      sentPayloads.push(parsed);

      if (parsed.temperature !== undefined) {
        return jsonResponse(
          {
            error: {
              message:
                "Unsupported parameter: 'temperature' is not supported with this model.",
              type: 'invalid_request_error',
              param: 'temperature',
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
    });

    // Unknown custom vendor alias not matching static regex
    const provider = createMockOpenAiProvider({
      model: 'aurora-x1-preview',
    });
    const pool = new ProviderExecutionPool();

    // First batch: sends temperature 0.3 -> gets HTTP 400 -> strips & caches -> retries immediately -> succeeds!
    const first = await executeBatchWithProvider({
      scene: 'webpage',
      provider,
      assistant: aloxafAssistant,
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Self healing' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      pool,
      retryBaseDelayMs: 0,
    });

    expect(first.ok).toBe(true);
    expect(first.items).toEqual([{ id: 1, trans: '自愈成功' }]);
    expect(first.diagnostic.attempts).toBe(2);
    expect(first.diagnostic.kind).toBe('unsupported-param-recovered');
    expect(first.diagnostic.parameters.temperatureTrace).toBe('retried-after-400');
    expect(first.diagnostic.parameters.temperatureSent).toBeUndefined();
    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[0].temperature).toBe(0.3);
    expect(sentPayloads[1]).not.toHaveProperty('temperature');

    // Verify capabilityCache persisted `(origin, model)` -> `supportsTemperature: false`
    const cache = await getCapabilityCache();
    const capKey = makeCapabilityKey(
      'https://gateway.example.com',
      'aurora-x1-preview',
    );
    expect(cache[capKey]?.supportsTemperature).toBe(false);
    expect(cache[capKey]?.learnedFromStatus).toBe(400);

    // Second batch: hits capabilityCache -> omits temperature on attempt 1 (zero HTTP 400!)
    const second = await executeBatchWithProvider({
      scene: 'webpage',
      provider,
      assistant: aloxafAssistant,
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Second call' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      pool,
      retryBaseDelayMs: 0,
    });

    expect(second.ok).toBe(true);
    expect(second.diagnostic.attempts).toBe(1);
    expect(second.diagnostic.kind).toBe('ok');
    expect(second.diagnostic.parameters.temperatureTrace).toBe(
      'omitted-capability-cache',
    );
    expect(sentPayloads).toHaveLength(3);
    expect(sentPayloads[2]).not.toHaveProperty('temperature');
  });

  it('never blind-retries non-temperature HTTP 400/401/403/404, while retrying 429/503 with key rotation up to 2 times', async () => {
    // 1. Non-temperature HTTP 400 fails immediately (`attempts: 1`, `retryable: false`)
    const badReqFetch = vi.fn(async () =>
      jsonResponse({ error: { message: 'Context length exceeded' } }, 400),
    );
    const res400 = await executeBatchWithProvider({
      scene: 'webpage',
      provider: createMockOpenAiProvider({ model: 'gpt-4.1-mini' }),
      assistant: aloxafAssistant,
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Too long' }],
      fetchImpl: badReqFetch as unknown as typeof fetch,
      pool: new ProviderExecutionPool(),
      retryBaseDelayMs: 0,
    });
    expect(res400.ok).toBe(false);
    expect(res400.diagnostic.attempts).toBe(1);
    expect(res400.diagnostic.retryable).toBe(false);
    expect(res400.diagnostic.kind).toBe('bad-request');
    expect(badReqFetch).toHaveBeenCalledTimes(1);

    // 2. HTTP 401 fails immediately (`attempts: 1`, `kind: 'auth-error'`)
    const authFetch = vi.fn(async () =>
      jsonResponse({ error: { message: 'Invalid API key sk-TEST_FAKE_KEY_ONE' } }, 401),
    );
    const res401 = await executeBatchWithProvider({
      scene: 'webpage',
      provider: createMockOpenAiProvider(),
      assistant: aloxafAssistant,
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Auth test' }],
      fetchImpl: authFetch as unknown as typeof fetch,
      pool: new ProviderExecutionPool(),
      retryBaseDelayMs: 0,
    });
    expect(res401.ok).toBe(false);
    expect(res401.diagnostic.attempts).toBe(1);
    expect(res401.diagnostic.retryable).toBe(false);
    expect(res401.diagnostic.kind).toBe('auth-error');
    expect(res401.diagnostic.sanitizedError).not.toContain('sk-TEST_FAKE_KEY_ONE');

    // 3. HTTP 429 cools down key #1, rotates to key #2 on immediate retry, and succeeds!
    const authHeadersSeen: string[] = [];
    const rateLimitFetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      authHeadersSeen.push(hdrs.Authorization ?? '');
      if (authHeadersSeen.length === 1) {
        return jsonResponse({ error: { message: 'Rate limit reached' } }, 429);
      }
      return jsonResponse({
        choices: [
          { message: { content: '<yaml>\n- id: 1\n  trans: 轮换成功\n</yaml>' } },
        ],
      });
    });

    const res429 = await executeBatchWithProvider({
      scene: 'webpage',
      provider: createMockOpenAiProvider(),
      assistant: aloxafAssistant,
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Key rotation' }],
      fetchImpl: rateLimitFetch as unknown as typeof fetch,
      pool: new ProviderExecutionPool(),
      retryBaseDelayMs: 0,
    });
    expect(res429.ok).toBe(true);
    expect(res429.diagnostic.attempts).toBe(2);
    expect(authHeadersSeen).toEqual([
      'Bearer sk-TEST_FAKE_KEY_ONE',
      'Bearer sk-TEST_FAKE_KEY_TWO',
    ]);
  });

  it('decodes multi-byte CJK UTF-8 SSE chunks split mid-character via TextDecoder("utf-8") and supports Anthropic Messages SSE', async () => {
    const ssePayload = [
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"[{\\"id\\":1,\\"trans\\":\\""}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"春眠不觉晓\\"}]"}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ].join('');

    const fullBytes = new TextEncoder().encode(ssePayload);
    // Deliberately split right inside a 3-byte Chinese UTF-8 sequence!
    const midSplit = fullBytes.indexOf(0xe6); // first byte of a CJK char
    const chunk1 = fullBytes.slice(0, midSplit + 1);
    const chunk2 = fullBytes.slice(midSplit + 1);

    let capturedHeaders: Record<string, string> = {};
    let capturedAnthropicBody: Record<string, unknown> = {};

    const streamFetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedAnthropicBody = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk1);
          controller.enqueue(chunk2);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=iso-8859-1' },
      });
    });

    const deltas: string[] = [];
    const anthropicProvider: ProviderConfig = {
      id: 'anthropic-main',
      name: 'Anthropic Claude',
      preset: 'anthropic',
      protocol: 'anthropic-messages',
      enabled: true,
      baseUrl: 'https://api.anthropic.com/v1',
      apiKeys: ['TEST_FAKE_ANTHROPIC_KEY_DO_NOT_USE'],
      model: 'claude-sonnet-4-5',
      models: ['claude-sonnet-4-5'],
      enableContext: false,
      enableRichHtml: true,
      stream: 'on',
      rateLimitRps: 20,
      maxConcurrency: 4,
      temperaturePolicy: { mode: 'custom', value: 0.2 },
      thinkingPolicy: { mode: 'provider-default' },
    };

    const result = await executeBatchWithProvider({
      scene: 'webpage',
      provider: anthropicProvider,
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Spring slumber' }],
      stream: true,
      onDelta: (d) => deltas.push(d),
      fetchImpl: streamFetch as unknown as typeof fetch,
      pool: new ProviderExecutionPool(),
    });

    expect(result.ok).toBe(true);
    expect(result.items).toEqual([{ id: 1, trans: '春眠不觉晓' }]);
    expect(deltas.join('')).toContain('春眠不觉晓');
    expect(capturedHeaders['x-api-key']).toBe(
      'TEST_FAKE_ANTHROPIC_KEY_DO_NOT_USE',
    );
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    expect(typeof capturedAnthropicBody.system).toBe('string');
    expect(capturedAnthropicBody.max_tokens).toBe(4096);
    expect(capturedAnthropicBody.temperature).toBe(0.2);
  });
});
