import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isYoutubeTabUrl,
  sendTabCommand,
  streamBatchTranslation,
} from '@shared/messaging';
import type {
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateStreamPortMessage,
} from '@shared/types';

function createDummyRequest(requestId: string): TranslateBatchRequest {
  return {
    requestId,
    scene: 'webpage',
    fromLang: 'en',
    toLang: 'zh-CN',
    items: [{ id: 1, text: 'Hello' }],
  };
}

function createDummyResponse(requestId: string): TranslateBatchResponse {
  return {
    ok: true,
    requestId,
    providerId: 'openai-main',
    model: 'gpt-4.1-mini',
    items: [{ id: 1, trans: '你好' }],
    diagnostic: {
      schemaVersion: 1,
      product: 'margin',
      version: '2.3.3',
      time: new Date(0).toISOString(),
      scene: 'webpage',
      codec: 'json-batch',
      provider: {
        id: 'openai-main',
        preset: 'openai',
        protocol: 'openai-chat',
        endpointOrigin: 'https://api.openai.com',
        endpointPath: '/v1/chat/completions',
        model: 'gpt-4.1-mini',
      },
      parameters: {
        temperatureTrace: 'omitted-default',
        thinkingMode: 'provider-default',
        stream: true,
      },
      httpStatus: 200,
      kind: 'ok',
      retryable: false,
      attempts: 1,
      latencyMs: 12,
    },
  };
}

describe('streamBatchTranslation abort listener cleanup (#127 #18)', () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;

  afterEach(() => {
    if (originalChrome === undefined) {
      delete (globalThis as { chrome?: unknown }).chrome;
    } else {
      (globalThis as { chrome?: unknown }).chrome = originalChrome;
    }
  });

  it('removes abort listener from shared AbortSignal across done, error, and disconnect lifecycles', async () => {
    let nextOutcome: 'done' | 'error' | 'disconnect' = 'done';
    const postMessages: TranslateStreamPortMessage[] = [];

    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        connect: vi.fn(() => {
          const messageListeners: Array<(msg: unknown) => void> = [];
          const disconnectListeners: Array<() => void> = [];
          return {
            onMessage: {
              addListener: (fn: (msg: unknown) => void) => {
                messageListeners.push(fn);
              },
            },
            onDisconnect: {
              addListener: (fn: () => void) => {
                disconnectListeners.push(fn);
              },
            },
            postMessage: (msg: TranslateStreamPortMessage) => {
              postMessages.push(msg);
              if (msg.type === 'start') {
                queueMicrotask(() => {
                  if (nextOutcome === 'done') {
                    const doneMsg: TranslateStreamPortMessage = {
                      type: 'done',
                      response: createDummyResponse(msg.payload.requestId),
                    };
                    for (const fn of messageListeners) fn(doneMsg);
                  } else if (nextOutcome === 'error') {
                    const errMsg: TranslateStreamPortMessage = {
                      type: 'error',
                      requestId: msg.payload.requestId,
                      error: {
                        code: 'HTTP_ERROR',
                        message: 'Upstream 502',
                        retryable: true,
                      },
                    };
                    for (const fn of messageListeners) fn(errMsg);
                  } else {
                    for (const fn of disconnectListeners) fn();
                  }
                });
              }
            },
            disconnect: vi.fn(),
          };
        }),
      },
    };

    const sharedController = new AbortController();
    const signal = sharedController.signal;
    const addSpy = vi.spyOn(signal, 'addEventListener');
    const removeSpy = vi.spyOn(signal, 'removeEventListener');

    // 1. Normal `done` lifecycle
    nextOutcome = 'done';
    const doneRes = await streamBatchTranslation(
      createDummyRequest('req-done'),
      {},
      signal,
    );
    expect(doneRes.ok).toBe(true);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls[0]?.[1]).toBe(addSpy.mock.calls[0]?.[1]);

    // 2. Port `error` lifecycle
    nextOutcome = 'error';
    await expect(
      streamBatchTranslation(createDummyRequest('req-err'), {}, signal),
    ).rejects.toThrow('Upstream 502');
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy.mock.calls[1]?.[1]).toBe(addSpy.mock.calls[1]?.[1]);

    // 3. Unexpected `onDisconnect` lifecycle
    nextOutcome = 'disconnect';
    await expect(
      streamBatchTranslation(createDummyRequest('req-disc'), {}, signal),
    ).rejects.toThrow(/closed unexpectedly/i);
    expect(addSpy).toHaveBeenCalledTimes(3);
    expect(removeSpy).toHaveBeenCalledTimes(3);
    expect(removeSpy.mock.calls[2]?.[1]).toBe(addSpy.mock.calls[2]?.[1]);

    // Aborting the shared controller afterwards must NOT trigger any stale `cancel` postMessage!
    const countBeforeAbort = postMessages.length;
    sharedController.abort();
    expect(postMessages).toHaveLength(countBeforeAbort);
  });

  it('injects subtitles.js alongside content.js/image-translate.js and injects youtube-main.js (MAIN) on YouTube tabs in sendTabCommand (v2.3.5 Fix #4)', async () => {
    expect(isYoutubeTabUrl('https://www.youtube.com/watch?v=KYHx0DI6mSo')).toBe(true);
    expect(isYoutubeTabUrl('https://youtube.com/shorts/abc1234')).toBe(true);
    expect(isYoutubeTabUrl('https://notyoutube.com/watch?v=1')).toBe(false);

    const scriptCalls: Array<{
      target: { tabId: number };
      files: string[];
      world?: string;
    }> = [];
    let ytSendAttempts = 0;

    (globalThis as { chrome?: unknown }).chrome = {
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url:
            tabId === 77
              ? 'https://www.youtube.com/watch?v=KYHx0DI6mSo'
              : 'https://example.org/article',
        })),
        sendMessage: vi.fn(async (tabId: number) => {
          if (tabId === 77) {
            ytSendAttempts += 1;
            if (ytSendAttempts === 1) {
              throw new Error('Receiving end does not exist.');
            }
            return { ok: true };
          }
          throw new Error('Receiving end does not exist.');
        }),
      },
      scripting: {
        executeScript: vi.fn(
          async (opts: {
            target: { tabId: number };
            files: string[];
            world?: string;
          }) => {
            scriptCalls.push(opts);
            return [];
          },
        ),
      },
    };

    const ytResult = await sendTabCommand(77, {
      type: 'margin:cmd:toggle-page',
    });
    expect(ytResult.ok).toBe(true);
    expect(ytResult.autoInjected).toBe(true);
    expect(scriptCalls).toEqual([
      {
        target: { tabId: 77 },
        files: ['content.js', 'subtitles.js', 'image-translate.js'],
      },
      {
        target: { tabId: 77 },
        world: 'MAIN',
        files: ['youtube-main.js'],
      },
    ]);
  });
});
