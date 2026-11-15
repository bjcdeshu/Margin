import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunkTextsForGoogleWeb,
  executeBatchWithProvider,
  executeDeepLXCall,
  executeGoogleWebCall,
  ProviderExecutionPool,
  ProviderTimeoutError,
  readSseStream,
} from '../../src/core/providers';
import { resetMemoryStorageForTests } from '@shared/storage';
import type { ProviderConfig } from '@shared/types';

function makeOpenAiProvider(
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'openai-hardening',
    name: 'OpenAI Hardening',
    preset: 'openai',
    protocol: 'openai-chat',
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    apiKeys: ['sk-TEST_FAKE_KEY'],
    model: 'gpt-4.1-mini',
    models: ['gpt-4.1-mini'],
    enableContext: false,
    enableRichHtml: true,
    stream: 'off',
    rateLimitRps: 50,
    maxConcurrency: 4,
    temperaturePolicy: { mode: 'omit' },
    thinkingPolicy: { mode: 'provider-default' },
    ...overrides,
  };
}

function makeAnthropicProvider(
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'anthropic-hardening',
    name: 'Anthropic Hardening',
    preset: 'anthropic',
    protocol: 'anthropic-messages',
    enabled: true,
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeys: ['sk-ant-TEST_FAKE_KEY'],
    model: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5'],
    enableContext: false,
    enableRichHtml: true,
    stream: 'off',
    rateLimitRps: 50,
    maxConcurrency: 4,
    temperaturePolicy: { mode: 'omit' },
    thinkingPolicy: { mode: 'provider-default' },
    ...overrides,
  };
}

function makeSseResponse(chunks: Array<string | Uint8Array>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ch of chunks) {
        controller.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function wrapBodyAsResponse(body: ReadableStream<Uint8Array>): Response {
  return { body } as unknown as Response;
}

describe('SSE stream reader hardening (#127 #1 & #10)', () => {
  it('rejects with ProviderTimeoutError instead of silently resolving EOF when reader.cancel() resolves pending read()', async () => {
    let resolveRead:
      | ((res: ReadableStreamReadResult<Uint8Array>) => void)
      | null = null;
    const cancelSpy = vi.fn(async () => {
      // Simulate WHATWG Streams spec: cancelling reader synchronously settles pending read() with `{ done: true }`
      resolveRead?.({ value: undefined, done: true });
    });
    const releaseLockSpy = vi.fn();

    const fakeBody = {
      getReader: () => ({
        read: () =>
          new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            resolveRead = resolve;
          }),
        cancel: cancelSpy,
        releaseLock: releaseLockSpy,
      }),
    } as unknown as ReadableStream<Uint8Array>;

    const events: string[] = [];
    await expect(
      readSseStream(
        wrapBodyAsResponse(fakeBody),
        (ev) => {
          events.push(ev.data);
        },
        undefined,
        15,
      ),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);

    expect(events).toEqual([]);
    expect(cancelSpy).toHaveBeenCalled();
    expect(releaseLockSpy).toHaveBeenCalled();
  });

  it('rejects with AbortError when external signal aborts even if reader.cancel() resolves pending read() first', async () => {
    let resolveRead:
      | ((res: ReadableStreamReadResult<Uint8Array>) => void)
      | null = null;
    const cancelSpy = vi.fn(async () => {
      resolveRead?.({ value: undefined, done: true });
    });
    const releaseLockSpy = vi.fn();

    const fakeBody = {
      getReader: () => ({
        read: () =>
          new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            resolveRead = resolve;
          }),
        cancel: cancelSpy,
        releaseLock: releaseLockSpy,
      }),
    } as unknown as ReadableStream<Uint8Array>;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await expect(
      readSseStream(
        wrapBodyAsResponse(fakeBody),
        () => undefined,
        controller.signal,
        5_000,
      ),
    ).rejects.toThrow(/aborted/i);

    expect(cancelSpy).toHaveBeenCalled();
    expect(releaseLockSpy).toHaveBeenCalled();
  });

  it('normalizes CRLF split across chunk boundaries (including empty middle chunks) without emitting phantom blank events', async () => {
    const enc = new TextEncoder();
    const chunks = [
      enc.encode('event: message\r'),
      new Uint8Array(0),
      enc.encode('\ndata: line-one\r'),
      enc.encode('\ndata: line-two\r'),
      enc.encode('\n\r'),
      enc.encode('\ndata: [DONE]\r'),
      enc.encode('\n\r'),
      enc.encode('\n'),
    ];

    let idx = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx < chunks.length) {
          controller.enqueue(chunks[idx++]);
        } else {
          controller.close();
        }
      },
    });

    const events: Array<{ event?: string; data: string }> = [];
    const summary = await readSseStream(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
      (ev) => {
        events.push(ev);
      },
    );

    expect(summary).toEqual({ sawDone: true, stoppedByCallback: false });
    expect(events).toEqual([{ event: 'message', data: 'line-one\nline-two' }]);
  });

  it('cancels the underlying reader before releaseLock when onEvent stops early or throws', async () => {
    const enc = new TextEncoder();
    for (const mode of ['stop-early', 'throw-error'] as const) {
      const order: string[] = [];
      let readCount = 0;
      const fakeBody = {
        getReader: () => ({
          read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
            readCount += 1;
            if (readCount === 1) {
              return {
                value: enc.encode('data: {"chunk":1}\n\n'),
                done: false,
              };
            }
            return { value: undefined, done: true };
          },
          cancel: async () => {
            order.push('cancel');
          },
          releaseLock: () => {
            order.push('releaseLock');
          },
        }),
      } as unknown as ReadableStream<Uint8Array>;

      if (mode === 'stop-early') {
        const summary = await readSseStream(
          wrapBodyAsResponse(fakeBody),
          () => 'stop',
        );
        expect(summary).toEqual({ sawDone: false, stoppedByCallback: true });
      } else {
        await expect(
          readSseStream(wrapBodyAsResponse(fakeBody), () => {
            throw new Error('callback boom');
          }),
        ).rejects.toThrow('callback boom');
      }

      expect(order).toEqual(['cancel', 'releaseLock']);
    }
  });
});

describe('Truncated / filtered response rejection & stream termination (#127 #2)', () => {
  beforeEach(() => {
    resetMemoryStorageForTests();
  });

  it('rejects OpenAI length / content_filter and premature SSE EOF while accepting [DONE]-less stop or stop-less [DONE]', async () => {
    // 1. Non-streaming finish_reason: "length" / "content_filter" -> TRUNCATED_RESPONSE
    for (const reason of ['length', 'content_filter'] as const) {
      const res = await executeBatchWithProvider({
        scene: 'webpage',
        provider: makeOpenAiProvider({ stream: 'off' }),
        fromLang: 'en',
        toLang: 'zh-CN',
        items: [{ id: 1, text: 'Hello' }],
        retryBaseDelayMs: 0,
        pool: new ProviderExecutionPool(),
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: reason,
                  message: { content: '[{"id":1,"trans":"半截译文"}]' },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )) as unknown as typeof fetch,
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('TRUNCATED_RESPONSE');
    }

    // 2. Streaming premature mid-stream drop (neither [DONE] nor finish_reason: 'stop') -> TRUNCATED_RESPONSE
    const droppedStreamRes = await executeBatchWithProvider({
      scene: 'webpage',
      provider: makeOpenAiProvider({ stream: 'on' }),
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Hello' }],
      stream: true,
      retryBaseDelayMs: 0,
      pool: new ProviderExecutionPool(),
      fetchImpl: (async () =>
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"[{\\"id\\":1,\\"trans\\":\\"你好\\"}]"}}]}\n\n',
        ])) as unknown as typeof fetch,
    });
    expect(droppedStreamRes.ok).toBe(false);
    expect(droppedStreamRes.error?.code).toBe('TRUNCATED_RESPONSE');

    // 3. Gateway omitting `data: [DONE]` after sending `finish_reason: "stop"` -> SUCCEEDS
    const stopWithoutDoneRes = await executeBatchWithProvider({
      scene: 'webpage',
      provider: makeOpenAiProvider({ stream: 'on' }),
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Hello' }],
      stream: true,
      pool: new ProviderExecutionPool(),
      fetchImpl: (async () =>
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"[{\\"id\\":1,\\"trans\\":\\"你好\\"}]"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        ])) as unknown as typeof fetch,
    });
    expect(stopWithoutDoneRes.ok).toBe(true);
    expect(stopWithoutDoneRes.items).toEqual([{ id: 1, trans: '你好' }]);

    // 4. Gateway sending `data: [DONE]` with `finish_reason: null` -> SUCCEEDS
    const doneWithoutStopRes = await executeBatchWithProvider({
      scene: 'webpage',
      provider: makeOpenAiProvider({ stream: 'on' }),
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Hello' }],
      stream: true,
      pool: new ProviderExecutionPool(),
      fetchImpl: (async () =>
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"[{\\"id\\":1,\\"trans\\":\\"世界\\"}]"},"finish_reason":null}]}\n\n',
          'data: [DONE]\n\n',
        ])) as unknown as typeof fetch,
    });
    expect(doneWithoutStopRes.ok).toBe(true);
    expect(doneWithoutStopRes.items).toEqual([{ id: 1, trans: '世界' }]);
  });

  it('rejects Anthropic max_tokens / refusal and premature SSE EOF', async () => {
    for (const stopReason of ['max_tokens', 'refusal'] as const) {
      const res = await executeBatchWithProvider({
        scene: 'webpage',
        provider: makeAnthropicProvider({ stream: 'off' }),
        fromLang: 'en',
        toLang: 'zh-CN',
        items: [{ id: 1, text: 'Hello' }],
        retryBaseDelayMs: 0,
        pool: new ProviderExecutionPool(),
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              stop_reason: stopReason,
              content: [{ type: 'text', text: '[{"id":1,"trans":"截断"}]' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )) as unknown as typeof fetch,
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('TRUNCATED_RESPONSE');
    }

    const prematureAnthropicSse = await executeBatchWithProvider({
      scene: 'webpage',
      provider: makeAnthropicProvider({ stream: 'on' }),
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Hello' }],
      stream: true,
      retryBaseDelayMs: 0,
      pool: new ProviderExecutionPool(),
      fetchImpl: (async () =>
        makeSseResponse([
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"[{\\"id\\":1,\\"trans\\":\\"未完成\\"}]"}}\n\n',
        ])) as unknown as typeof fetch,
    });
    expect(prematureAnthropicSse.ok).toBe(false);
    expect(prematureAnthropicSse.error?.code).toBe('TRUNCATED_RESPONSE');
  });
});

describe('Zero user/model prose in parse-failure diagnostics (#127 #17)', () => {
  beforeEach(() => {
    resetMemoryStorageForTests();
  });

  it('strips raw prose from OpenAI, Anthropic, DeepLX, Google Web, and codec parse-failure errors', async () => {
    const SENSITIVE_PROSE = 'CONFIDENTIAL_MEDICAL_RECORD_PATIENT_99182';

    // 1. OpenAI invalid JSON 200 body
    const openAiBadJson = await executeBatchWithProvider({
      scene: 'webpage',
      provider: makeOpenAiProvider(),
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: SENSITIVE_PROSE }],
      retryBaseDelayMs: 0,
      pool: new ProviderExecutionPool(),
      fetchImpl: (async () =>
        new Response(`<html>Gateway error echoing ${SENSITIVE_PROSE}</html>`, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch,
    });
    expect(openAiBadJson.ok).toBe(false);
    expect(openAiBadJson.error?.message).not.toContain(SENSITIVE_PROSE);
    expect(openAiBadJson.diagnostic.sanitizedError).not.toContain(SENSITIVE_PROSE);
    expect(openAiBadJson.diagnostic.sanitizedError).toContain('chars=');

    // 2. Anthropic invalid JSON 200 body
    const anthropicBadJson = await executeBatchWithProvider({
      scene: 'webpage',
      provider: makeAnthropicProvider(),
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: SENSITIVE_PROSE }],
      retryBaseDelayMs: 0,
      pool: new ProviderExecutionPool(),
      fetchImpl: (async () =>
        new Response(`Upstream proxy splash: ${SENSITIVE_PROSE}`, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })) as unknown as typeof fetch,
    });
    expect(anthropicBadJson.ok).toBe(false);
    expect(anthropicBadJson.error?.message).not.toContain(SENSITIVE_PROSE);
    expect(anthropicBadJson.diagnostic.sanitizedError).not.toContain(SENSITIVE_PROSE);

    // 3. Engine INVALID_CODEC_OUTPUT when LLM echoes prose without valid JSON/YAML items
    const codecFail = await executeBatchWithProvider({
      scene: 'webpage',
      provider: makeOpenAiProvider(),
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: SENSITIVE_PROSE }],
      retryBaseDelayMs: 0,
      pool: new ProviderExecutionPool(),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: `Sorry, I cannot translate: ${SENSITIVE_PROSE}`,
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    });
    expect(codecFail.ok).toBe(false);
    expect(codecFail.error?.code).toBe('INVALID_CODEC_OUTPUT');
    expect(codecFail.error?.message).not.toContain(SENSITIVE_PROSE);
    expect(codecFail.diagnostic.sanitizedError).not.toContain(SENSITIVE_PROSE);
    expect(codecFail.error?.message).toContain('json-batch');
    expect(codecFail.error?.message).toContain('markers=none');

    // 4. DeepLX missing field & invalid JSON
    const deeplxProvider: ProviderConfig = makeOpenAiProvider({
      id: 'deeplx-test',
      preset: 'deeplx',
      protocol: 'deeplx',
      baseUrl: 'https://deeplx.example.test/translate',
    });
    await expect(
      executeDeepLXCall({
        provider: deeplxProvider,
        endpoint: deeplxProvider.baseUrl,
        texts: [SENSITIVE_PROSE],
        fromLang: 'en',
        toLang: 'zh-CN',
        fetchImpl: (async () =>
          new Response(JSON.stringify({ echo: SENSITIVE_PROSE, code: 200 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toSatisfy((err: Error) => !err.message.includes(SENSITIVE_PROSE));

    // 5. Google Web invalid JSON
    const googleProvider: ProviderConfig = makeOpenAiProvider({
      id: 'google-test',
      preset: 'google-free',
      protocol: 'google-web',
      baseUrl: 'https://translate.googleapis.com/translate_a/single',
    });
    await expect(
      executeGoogleWebCall({
        provider: googleProvider,
        endpoint: googleProvider.baseUrl,
        texts: [SENSITIVE_PROSE],
        fromLang: 'en',
        toLang: 'zh-CN',
        fetchImpl: (async () =>
          new Response(`Captcha page ${SENSITIVE_PROSE}`, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toSatisfy((err: Error) => !err.message.includes(SENSITIVE_PROSE));
  });
});

describe('Google Web & DeepLX count-mismatch fallback + UTF-8 query budgeting (#127 #6)', () => {
  it('budgets UTF-8 encodeURIComponent length in chunkTextsForGoogleWeb and splits/reassembles oversized single CJK items cleanly', async () => {
    // 200 CJK chars = 1800 URL-encoded bytes (`%XX` * 3 * 200 = 1800), so two 200-char CJK strings (3600 + overhead > 2800) must split!
    const cjkA = '春眠不觉晓'.repeat(40); // 200 chars -> 1800 encoded bytes
    const cjkB = '处处闻啼鸟'.repeat(40); // 200 chars -> 1800 encoded bytes
    const chunks = chunkTextsForGoogleWeb([cjkA, cjkB], 2800);
    expect(chunks).toHaveLength(2);

    // Oversized single CJK item (> 2800 encoded bytes) with inline `<m1>` tags splits across multiple GET requests and reassembles into 1 aligned item
    const hugeSingle = `${'这是一段包含<m1>重点术语</m1>的超长中文段落。'.repeat(30)}`;
    expect(encodeURIComponent(hugeSingle).length).toBeGreaterThan(2800);

    const requestQueries: string[] = [];
    const googleProvider: ProviderConfig = makeOpenAiProvider({
      id: 'google-free',
      preset: 'google-free',
      protocol: 'google-web',
      baseUrl: 'https://translate.googleapis.com/translate_a/single',
    });

    const out = await executeGoogleWebCall({
      provider: googleProvider,
      endpoint: googleProvider.baseUrl,
      texts: [hugeSingle, 'Short second item'],
      fromLang: 'zh-CN',
      toLang: 'en',
      fetchImpl: (async (url: RequestInfo | URL) => {
        const u = new URL(String(url));
        const q = u.searchParams.get('q') ?? '';
        requestQueries.push(q);
        expect(encodeURIComponent(q).length).toBeLessThanOrEqual(2800);
        return new Response(JSON.stringify([[[`[EN:${q}]`, q]]]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    expect(requestQueries.length).toBeGreaterThanOrEqual(3);
    expect(out.translations).toHaveLength(2);
    expect(out.translations[0]).toContain('<m1>');
    expect(out.translations[0]).toContain('</m1>');
    expect(out.translations[1]).toBe('[EN:Short second item]');
  });

  it('falls back to 1-to-1 per-item requests when Google Web or DeepLX collapses batch separators, preventing positional ID shifting', async () => {
    // 1. Google Web collapses `\n\n` in batch call -> falls back to individual calls and aligns IDs 10, 20, 30
    const googleProvider = makeOpenAiProvider({
      id: 'google-free',
      preset: 'google-free',
      protocol: 'google-web',
      baseUrl: 'https://translate.googleapis.com/translate_a/single',
    });

    let googleCalls = 0;
    const googleRes = await executeBatchWithProvider({
      scene: 'webpage',
      provider: googleProvider,
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [
        { id: 10, text: 'Alpha' },
        { id: 20, text: 'Beta' },
        { id: 30, text: 'Gamma' },
      ],
      pool: new ProviderExecutionPool(),
      fetchImpl: (async (url: RequestInfo | URL) => {
        googleCalls += 1;
        const q = new URL(String(url)).searchParams.get('q') ?? '';
        if (q.includes('\n\n')) {
          // Simulate collapsed separator (only 2 segments returned for 3 items!)
          return new Response(JSON.stringify([[['阿尔法 贝塔\n\n伽马', q]]]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const map: Record<string, string> = {
          Alpha: '阿尔法',
          Beta: '贝塔',
          Gamma: '伽马',
        };
        return new Response(JSON.stringify([[[map[q] ?? q, q]]]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    expect(googleRes.ok).toBe(true);
    expect(googleCalls).toBe(4); // 1 batch attempt + 3 individual fallback calls
    expect(googleRes.items).toEqual([
      { id: 10, trans: '阿尔法' },
      { id: 20, trans: '贝塔' },
      { id: 30, trans: '伽马' },
    ]);

    // 2. DeepLX drops `[[#2]]` marker in indexed-marker mode -> falls back to 1-to-1 per-item calls without ID shift
    const deeplxProvider = makeOpenAiProvider({
      id: 'deeplx-main',
      preset: 'deeplx',
      protocol: 'deeplx',
      baseUrl: 'https://deeplx.example.test/translate',
    });

    let deeplxCalls = 0;
    const deeplxRes = await executeBatchWithProvider({
      scene: 'webpage',
      provider: deeplxProvider,
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [
        { id: 1, text: 'First para\n\nwith blank line' },
        { id: 2, text: 'Second item' },
        { id: 3, text: 'Third item' },
      ],
      pool: new ProviderExecutionPool(),
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        deeplxCalls += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as { text: string };
        if (body.text.includes('[[#1]]')) {
          // Simulate DeepLX mangling [[#2]] marker so only 2 markers remain
          return new Response(
            JSON.stringify({
              code: 200,
              data: '[[#1]] 第一段合并了第二段\n[[#3]] 第三项',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ code: 200, data: `译:${body.text}` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    expect(deeplxRes.ok).toBe(true);
    expect(deeplxCalls).toBe(4); // 1 batch attempt + 3 individual fallback calls
    expect(deeplxRes.items).toEqual([
      { id: 1, trans: '译:First para\n\nwith blank line' },
      { id: 2, trans: '译:Second item' },
      { id: 3, trans: '译:Third item' },
    ]);
  });

  it('preserves inter-sentence horizontal spaces when splitting oversized items in Google Web for Latin target languages', async () => {
    const googleProvider = makeOpenAiProvider({
      id: 'google-free',
      preset: 'google-free',
      protocol: 'google-web',
      baseUrl: 'https://translate.googleapis.com',
    });
    const sentenceA = `${'Alpha word '.repeat(220).trim()}.`; // ~2420 chars
    const sentenceB = `${'Beta clause '.repeat(200).trim()}.`; // ~2400 chars
    const oversizedSource = `${sentenceA} ${sentenceB}`;
    expect(oversizedSource.length).toBeGreaterThan(4200);

    const pieceQueries: string[] = [];
    const res = await executeGoogleWebCall({
      provider: googleProvider,
      endpoint: 'https://translate.googleapis.com',
      texts: [oversizedSource],
      fromLang: 'fr',
      toLang: 'en',
      fetchImpl: (async (input: RequestInfo | URL) => {
        const parsed = new URL(String(input));
        const q = parsed.searchParams.get('q') ?? '';
        pieceQueries.push(q);
        return new Response(JSON.stringify([[[q, q, null, null, 10]]]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    expect(pieceQueries.length).toBeGreaterThanOrEqual(2);
    expect(res.translations).toHaveLength(1);
    expect(res.translations[0]).toBe(`${sentenceA} ${sentenceB}`);
    expect(res.translations[0]).not.toContain('word.Beta');
  });
});
