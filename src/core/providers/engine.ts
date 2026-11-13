import {
  buildDiagnosticSnapshot,
  classifyDiagnosticKind,
  sanitizeErrorText,
} from '@core/diagnostics';
import {
  DEFAULT_JSON_BATCH_SYSTEM_PROMPT,
  buildDefaultJsonBatchSystemPrompt,
  getPromptCodec,
  protectGlossaryTokens,
  restoreGlossaryTokens,
} from '@core/prompts';
import { getCapabilityCache, recordModelCapability } from '@shared/storage';
import {
  makeCapabilityKey,
  resolveEffectiveTemperature,
  shouldStripReasoningEffortAndRetry,
  shouldStripTemperatureAndRetry,
} from '@shared/temperature';
import type {
  AssistantConfig,
  BatchItemOutput,
  PromptCodecId,
  ProviderConfig,
  TemperatureTrace,
  TranslationScene,
} from '@shared/types';
import { executeAnthropicMessagesCall } from './anthropic-messages';
import { executeDeepLXCall } from './deeplx';
import {
  resolveDeepLXEndpoints,
  resolveEndpointForProvider,
} from './endpoint';
import { executeGoogleWebCall } from './google-web';
import {
  buildOpenAiChatRequestBody,
  executeOpenAiChatCall,
} from './openai-chat';
import {
  abortableSleep,
  defaultProviderPool,
  resolveRequestPriority,
} from './pool';
import { ProviderTimeoutError } from './timeout';
import {
  type ExecuteBatchOptions,
  type ExecuteBatchResult,
  type ExecuteVisionOptions,
  type ExecuteVisionResult,
  ProviderHttpError,
  type ProviderRuntimeEnv,
} from './types';

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_TRANSIENT_RETRIES = 2;

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'AbortError';
}

function isTransientStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUSES.has(status);
}

function computeBackoffDelayMs(
  retryNumber: number,
  baseDelayMs = 600,
): number {
  if (baseDelayMs <= 0) return 0;
  // retry 1 -> ~600ms, retry 2 -> ~1800ms
  const deterministic = retryNumber === 1 ? baseDelayMs : baseDelayMs * 3;
  return Math.max(0, Math.round(deterministic));
}

function resolveStreamEnabled(
  provider: ProviderConfig,
  requestedStream?: boolean,
): boolean {
  if (
    provider.protocol !== 'openai-chat' &&
    provider.protocol !== 'anthropic-messages'
  ) {
    return false;
  }
  if (!requestedStream) {
    return false;
  }
  return provider.stream !== 'off';
}

interface SelfHealingAiExecutionInput extends ProviderRuntimeEnv {
  scene: TranslationScene | 'service-test';
  codecId: PromptCodecId;
  provider: ProviderConfig;
  assistant?: AssistantConfig;
  systemPrompt: string;
  userPrompt: string;
  imageDataUrl?: string;
  stream: boolean;
  onDelta?: (delta: string) => void;
}

interface SelfHealingAiExecutionOutput {
  ok: boolean;
  content: string;
  httpStatus?: number;
  attempts: number;
  latencyMs: number;
  resolvedEndpoint: string;
  temperatureTrace: TemperatureTrace;
  temperatureSent?: number;
  recoveredFromUnsupportedParam: boolean;
  retryable: boolean;
  rawError?: unknown;
  isNetworkError?: boolean;
}

async function runSelfHealingAiCompletion(
  input: SelfHealingAiExecutionInput,
): Promise<SelfHealingAiExecutionOutput> {
  const {
    scene,
    provider,
    assistant,
    systemPrompt,
    userPrompt,
    imageDataUrl,
    stream,
    onDelta,
    fetchImpl = globalThis.fetch.bind(globalThis),
    pool = defaultProviderPool,
    retryBaseDelayMs = 600,
    requestTimeoutMs,
    streamIdleTimeoutMs,
    signal,
    priority,
  } = input;

  const effectivePriority = resolveRequestPriority(scene, priority);
  const t0 = Date.now();
  const resolvedEndpoint = resolveEndpointForProvider(provider);
  const capabilityKey = makeCapabilityKey(resolvedEndpoint, provider.model);
  const capabilityCache = await getCapabilityCache();
  const cachedCapability = capabilityCache[capabilityKey];

  const resolvedTemp = resolveEffectiveTemperature({
    model: provider.model,
    providerPolicy: provider.temperaturePolicy,
    assistantPolicy: assistant?.temperaturePolicy,
    cachedCapability,
  });

  let currentTemperature: number | undefined = resolvedTemp.value;
  let currentTrace: TemperatureTrace = resolvedTemp.trace;
  let omitReasoningEffort = cachedCapability?.supportsReasoningEffort === false;

  // Anthropic extended thinking forbids custom temperature
  if (
    provider.protocol === 'anthropic-messages' &&
    provider.thinkingPolicy.mode === 'enabled' &&
    currentTemperature !== undefined
  ) {
    currentTemperature = undefined;
    currentTrace = 'omitted-reasoning-guard';
  }

  let attempts = 0;
  let transientRetriesUsed = 0;
  let strippedTemperature = false;
  let strippedReasoningEffort = false;
  let recoveredFromUnsupportedParam = false;

  while (true) {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    attempts++;
    let deltasEmittedThisAttempt = 0;
    const wrappedOnDelta = onDelta
      ? (delta: string) => {
          deltasEmittedThisAttempt++;
          onDelta(delta);
        }
      : undefined;

    const sentReasoningEffort =
      provider.protocol === 'openai-chat' &&
      !omitReasoningEffort &&
      buildOpenAiChatRequestBody({
        provider,
        scene,
        systemPrompt: '',
        userPrompt: '',
        effectiveTemperature: currentTemperature,
        omitReasoningEffort,
        stream,
      }).reasoning_effort !== undefined;

    const apiKey = pool.acquireApiKey(provider.id, provider.apiKeys);

    try {
      const callResult = await pool.schedule(
        provider,
        signal,
        async () => {
          if (provider.protocol === 'anthropic-messages') {
            return executeAnthropicMessagesCall({
              provider,
              scene,
              endpoint: resolvedEndpoint,
              apiKey,
              systemPrompt,
              userPrompt,
              imageDataUrl,
              effectiveTemperature: currentTemperature,
              stream,
              onDelta: wrappedOnDelta,
              fetchImpl,
              requestTimeoutMs,
              streamIdleTimeoutMs,
              signal,
            });
          }
          return executeOpenAiChatCall({
            provider,
            scene,
            endpoint: resolvedEndpoint,
            apiKey,
            systemPrompt,
            userPrompt,
            imageDataUrl,
            effectiveTemperature: currentTemperature,
            omitReasoningEffort,
            stream,
            onDelta: wrappedOnDelta,
            fetchImpl,
            requestTimeoutMs,
            streamIdleTimeoutMs,
            signal,
          });
        },
        effectivePriority,
      );

      return {
        ok: true,
        content: callResult.content,
        httpStatus: callResult.httpStatus,
        attempts,
        latencyMs: Date.now() - t0,
        resolvedEndpoint,
        temperatureTrace: currentTrace,
        temperatureSent: currentTemperature,
        recoveredFromUnsupportedParam,
        retryable: false,
      };
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        throw err;
      }

      if (err instanceof ProviderHttpError) {
        const status = err.status;

        // Defense 4a: Automatic HTTP 400/422 unsupported `temperature` strip-and-retry + capability cache!
        if (
          !strippedTemperature &&
          shouldStripTemperatureAndRetry(
            status,
            err.bodyText,
            currentTemperature !== undefined,
          )
        ) {
          strippedTemperature = true;
          currentTemperature = undefined;
          currentTrace = 'retried-after-400';
          recoveredFromUnsupportedParam = true;

          await recordModelCapability(capabilityKey, {
            supportsTemperature: false,
            learnedFromStatus: status,
            updatedAt: Date.now(),
          });

          // 1 immediate transparent retry without `temperature`
          continue;
        }

        // Defense 4b: Automatic HTTP 400/422 unsupported `reasoning_effort` strip-and-retry + capability cache!
        if (
          !strippedReasoningEffort &&
          shouldStripReasoningEffortAndRetry(
            status,
            err.bodyText,
            sentReasoningEffort,
          )
        ) {
          strippedReasoningEffort = true;
          omitReasoningEffort = true;
          recoveredFromUnsupportedParam = true;

          await recordModelCapability(capabilityKey, {
            supportsReasoningEffort: false,
            learnedFromStatus: status,
            updatedAt: Date.now(),
          });

          // 1 immediate transparent retry without `reasoning_effort`
          continue;
        }

        if (status === 429) {
          pool.markKeyRateLimited(provider.id, err.usedApiKey);
        }

        // Transient HTTP error (`408`, `429`, `500`, `502`, `503`, `504`): retry up to 2 times
        if (
          isTransientStatus(status) &&
          transientRetriesUsed < MAX_TRANSIENT_RETRIES &&
          deltasEmittedThisAttempt === 0
        ) {
          transientRetriesUsed++;
          const waitMs = computeBackoffDelayMs(
            transientRetriesUsed,
            retryBaseDelayMs,
          );
          await abortableSleep(waitMs, signal);
          continue;
        }

        // Non-retryable HTTP errors (`400`, `401`, `403`, `404`, `422`) fail fast (`attempts: 1`, `retryable: false`)
        return {
          ok: false,
          content: '',
          httpStatus: status,
          attempts,
          latencyMs: Date.now() - t0,
          resolvedEndpoint,
          temperatureTrace: currentTrace,
          temperatureSent: currentTemperature,
          recoveredFromUnsupportedParam,
          retryable: isTransientStatus(status),
          rawError: err,
        };
      }

      // Request / SSE idle timeout fails fast without multiplying wait time by 3x
      const isTimeout = err instanceof ProviderTimeoutError;
      if (
        !isTimeout &&
        transientRetriesUsed < MAX_TRANSIENT_RETRIES &&
        deltasEmittedThisAttempt === 0
      ) {
        transientRetriesUsed++;
        const waitMs = computeBackoffDelayMs(
          transientRetriesUsed,
          retryBaseDelayMs,
        );
        await abortableSleep(waitMs, signal);
        continue;
      }

      return {
        ok: false,
        content: '',
        attempts,
        latencyMs: Date.now() - t0,
        resolvedEndpoint,
        temperatureTrace: currentTrace,
        temperatureSent: currentTemperature,
        recoveredFromUnsupportedParam,
        retryable: true,
        rawError: err,
        isNetworkError: true,
      };
    }
  }
}

export async function executeBatchWithProvider(
  options: ExecuteBatchOptions,
): Promise<ExecuteBatchResult> {
  const {
    scene,
    provider,
    assistant,
    fromLang,
    toLang,
    items,
    context,
    glossary = [],
    stream: requestedStream = false,
    onDelta,
    onItemReady,
    fetchImpl = globalThis.fetch.bind(globalThis),
    pool = defaultProviderPool,
    retryBaseDelayMs = 600,
    requestTimeoutMs,
    streamIdleTimeoutMs,
    signal,
    priority,
  } = options;

  const effectivePriority = resolveRequestPriority(scene, priority);

  const knownSecrets: string[] = [
    ...provider.apiKeys,
    ...(provider.endpoints ?? []),
    ...Object.values(provider.extraHeaders ?? {}),
  ];

  // Non-AI MT Protocols (`deeplx`, `google-web`) with `<m-g id="0"/>` glossary protection
  if (provider.protocol === 'deeplx' || provider.protocol === 'google-web') {
    const t0 = Date.now();
    const codecId: PromptCodecId = 'single-text';

    if (items.length === 0) {
      const resolvedEndpoint =
        provider.protocol === 'deeplx'
          ? resolveDeepLXEndpoints(provider)[0]
          : resolveEndpointForProvider(provider);
      const diagnostic = buildDiagnosticSnapshot({
        scene,
        codec: codecId,
        provider: {
          id: provider.id,
          preset: provider.preset,
          protocol: provider.protocol,
          resolvedEndpoint,
          model: provider.model,
        },
        parameters: {
          temperatureTrace: 'omitted-default',
          thinkingMode: provider.thinkingPolicy.mode,
          stream: false,
        },
        httpStatus: 200,
        kind: 'ok',
        retryable: false,
        attempts: 1,
        latencyMs: 0,
        knownSecrets,
      });
      return { ok: true, items: [], diagnostic };
    }

    const domainOrUrl = context?.url || context?.domain;
    const { texts: protectedTexts, placeholderMap } = protectGlossaryTokens(
      items.map((it) => it.text),
      glossary,
      domainOrUrl,
    );

    const deeplxEndpoints =
      provider.protocol === 'deeplx' ? resolveDeepLXEndpoints(provider) : [];

    let attempts = 0;
    let transientRetriesUsed = 0;
    let lastEndpoint =
      provider.protocol === 'deeplx'
        ? deeplxEndpoints[0]
        : resolveEndpointForProvider(provider);

    while (true) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      attempts++;

      const apiKey = pool.acquireApiKey(provider.id, provider.apiKeys);
      const currentEndpoint =
        provider.protocol === 'deeplx'
          ? pool.acquireEndpoint(provider.id, deeplxEndpoints)
          : lastEndpoint;
      lastEndpoint = currentEndpoint;

      try {
        const mtResult = await pool.schedule(
          provider,
          signal,
          async () => {
            if (provider.protocol === 'deeplx') {
              return executeDeepLXCall({
                provider,
                endpoint: currentEndpoint,
                apiKey,
                texts: protectedTexts,
                fromLang,
                toLang,
                fetchImpl,
                requestTimeoutMs,
                signal,
              });
            }
            return executeGoogleWebCall({
              provider,
              endpoint: currentEndpoint,
              texts: protectedTexts,
              fromLang,
              toLang,
              fetchImpl,
              requestTimeoutMs,
              signal,
              maxCharsPerChunk: provider.maxCharsPerBatch,
            });
          },
          effectivePriority,
        );

        const outputs: BatchItemOutput[] = [];
        for (
          let i = 0;
          i < Math.min(items.length, mtResult.translations.length);
          i++
        ) {
          const restored = restoreGlossaryTokens(
            mtResult.translations[i] ?? '',
            placeholderMap,
          );
          const itemOut: BatchItemOutput = {
            id: items[i].id,
            trans: restored,
          };
          outputs.push(itemOut);
          onItemReady?.(itemOut);
        }

        const diagnostic = buildDiagnosticSnapshot({
          scene,
          codec: codecId,
          provider: {
            id: provider.id,
            preset: provider.preset,
            protocol: provider.protocol,
            resolvedEndpoint: currentEndpoint,
            model: provider.model,
          },
          parameters: {
            temperatureTrace: 'omitted-default',
            thinkingMode: provider.thinkingPolicy.mode,
            stream: false,
          },
          httpStatus: mtResult.httpStatus,
          kind: 'ok',
          retryable: false,
          attempts,
          latencyMs: Date.now() - t0,
          knownSecrets,
        });

        return {
          ok: true,
          items: outputs,
          diagnostic,
        };
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          throw err;
        }

        if (err instanceof ProviderHttpError) {
          if (err.status === 429) {
            pool.markKeyRateLimited(provider.id, err.usedApiKey);
          }
          if (
            provider.protocol === 'deeplx' &&
            (err.status === 429 || err.status >= 500)
          ) {
            pool.markEndpointUnhealthy(provider.id, currentEndpoint);
          }

          if (
            isTransientStatus(err.status) &&
            transientRetriesUsed < MAX_TRANSIENT_RETRIES
          ) {
            transientRetriesUsed++;
            await abortableSleep(
              computeBackoffDelayMs(transientRetriesUsed, retryBaseDelayMs),
              signal,
            );
            continue;
          }

          const kind = classifyDiagnosticKind({
            ok: false,
            httpStatus: err.status,
          });
          const retryable = isTransientStatus(err.status);
          const diagnostic = buildDiagnosticSnapshot({
            scene,
            codec: codecId,
            provider: {
              id: provider.id,
              preset: provider.preset,
              protocol: provider.protocol,
              resolvedEndpoint: currentEndpoint,
              model: provider.model,
            },
            parameters: {
              temperatureTrace: 'omitted-default',
              thinkingMode: provider.thinkingPolicy.mode,
              stream: false,
            },
            httpStatus: err.status,
            kind,
            retryable,
            attempts,
            latencyMs: Date.now() - t0,
            rawError: err,
            knownSecrets,
          });

          return {
            ok: false,
            items: [],
            diagnostic,
            error: {
              code: `HTTP_${err.status}`,
              message:
                diagnostic.sanitizedError || `HTTP ${err.status} upstream error`,
              retryable,
            },
          };
        }

        if (provider.protocol === 'deeplx') {
          pool.markEndpointUnhealthy(provider.id, currentEndpoint);
        }

        const isTimeout = err instanceof ProviderTimeoutError;
        const maxNetworkRetries = isTimeout
          ? provider.protocol === 'deeplx' && deeplxEndpoints.length > 1
            ? 1
            : 0
          : MAX_TRANSIENT_RETRIES;

        if (transientRetriesUsed < maxNetworkRetries) {
          transientRetriesUsed++;
          await abortableSleep(
            computeBackoffDelayMs(transientRetriesUsed, retryBaseDelayMs),
            signal,
          );
          continue;
        }

        const isParseFailure =
          err instanceof Error &&
          /Invalid JSON|Unexpected Google|missing translated/i.test(err.message);
        const kind = classifyDiagnosticKind({
          ok: false,
          isNetworkError: !isParseFailure,
          isInvalidResponse: isParseFailure,
        });
        const sanitized = sanitizeErrorText(err, knownSecrets);
        const diagnostic = buildDiagnosticSnapshot({
          scene,
          codec: codecId,
          provider: {
            id: provider.id,
            preset: provider.preset,
            protocol: provider.protocol,
            resolvedEndpoint: currentEndpoint,
            model: provider.model,
          },
          parameters: {
            temperatureTrace: 'omitted-default',
            thinkingMode: provider.thinkingPolicy.mode,
            stream: false,
          },
          kind,
          retryable: !isParseFailure,
          attempts,
          latencyMs: Date.now() - t0,
          rawError: err,
          knownSecrets,
        });

        return {
          ok: false,
          items: [],
          diagnostic,
          error: {
            code: isParseFailure ? 'INVALID_RESPONSE' : 'NETWORK_ERROR',
            message: sanitized || 'Network request failed.',
            retryable: !isParseFailure,
          },
        };
      }
    }
  }

  // AI Protocols (`openai-chat`, `anthropic-messages`)
  const codecId: PromptCodecId = assistant?.codec ?? 'json-batch';
  const codec = getPromptCodec(codecId);
  const useStream = resolveStreamEnabled(provider, requestedStream);

  if (items.length === 0) {
    const resolvedEndpoint = resolveEndpointForProvider(provider);
    const diagnostic = buildDiagnosticSnapshot({
      scene,
      codec: codecId,
      provider: {
        id: provider.id,
        preset: provider.preset,
        protocol: provider.protocol,
        resolvedEndpoint,
        model: provider.model,
      },
      parameters: {
        temperatureTrace: 'omitted-default',
        thinkingMode: provider.thinkingPolicy.mode,
        stream: useStream,
      },
      httpStatus: 200,
      kind: 'ok',
      retryable: false,
      attempts: 1,
      latencyMs: 0,
      knownSecrets,
    });
    return { ok: true, items: [], diagnostic };
  }

  const domainOrUrl = context?.url || context?.domain;
  const { placeholderMap } = protectGlossaryTokens(
    items.map((it) => it.text),
    glossary,
    domainOrUrl,
  );
  const restoreItemGlossary = (item: BatchItemOutput): BatchItemOutput => {
    if (placeholderMap.size === 0 || !item.trans) return item;
    const restored = restoreGlossaryTokens(item.trans, placeholderMap);
    return restored === item.trans ? item : { ...item, trans: restored };
  };

  const { systemPrompt, userPrompt } = codec.encode({
    scene,
    fromLang,
    toLang,
    items,
    assistant,
    context,
    glossary,
  });

  const streamParser = useStream
    ? codec.createStreamParser(items, { scene, assistant })
    : null;

  const execOut = await runSelfHealingAiCompletion({
    scene,
    codecId,
    provider,
    assistant,
    systemPrompt,
    userPrompt,
    stream: useStream,
    onDelta: useStream
      ? (delta: string) => {
          onDelta?.(delta);
          if (streamParser) {
            const readyItems = streamParser.push(delta);
            if (onItemReady) {
              for (const item of readyItems) {
                onItemReady(restoreItemGlossary(item));
              }
            }
          }
        }
      : undefined,
    fetchImpl,
    pool,
    retryBaseDelayMs,
    requestTimeoutMs,
    streamIdleTimeoutMs,
    signal,
    priority: effectivePriority,
  });

  if (!execOut.ok) {
    const isParseFailure =
      execOut.rawError instanceof Error &&
      /Invalid JSON/i.test(execOut.rawError.message);
    const kind = classifyDiagnosticKind({
      ok: false,
      httpStatus: execOut.httpStatus,
      isNetworkError: execOut.isNetworkError && !isParseFailure,
      isInvalidResponse: isParseFailure,
    });
    const diagnostic = buildDiagnosticSnapshot({
      scene,
      codec: codecId,
      provider: {
        id: provider.id,
        preset: provider.preset,
        protocol: provider.protocol,
        resolvedEndpoint: execOut.resolvedEndpoint,
        model: provider.model,
      },
      parameters: {
        temperatureTrace: execOut.temperatureTrace,
        temperatureSent: execOut.temperatureSent,
        thinkingMode: provider.thinkingPolicy.mode,
        stream: useStream,
      },
      httpStatus: execOut.httpStatus,
      kind,
      retryable: execOut.retryable,
      attempts: execOut.attempts,
      latencyMs: execOut.latencyMs,
      rawError: execOut.rawError,
      knownSecrets,
    });

    return {
      ok: false,
      items: [],
      diagnostic,
      error: {
        code: execOut.httpStatus
          ? `HTTP_${execOut.httpStatus}`
          : isParseFailure
            ? 'INVALID_RESPONSE'
            : 'NETWORK_ERROR',
        message: diagnostic.sanitizedError || 'Upstream provider request failed.',
        retryable: execOut.retryable,
      },
    };
  }

  let decodedItems: BatchItemOutput[];
  if (streamParser) {
    const finalized = streamParser.finish();
    decodedItems = finalized.allItems
      .filter((it) => !it.partial)
      .map(restoreItemGlossary);
    if (onItemReady) {
      for (const item of finalized.newlyReady) {
        onItemReady(restoreItemGlossary(item));
      }
    }
  } else {
    decodedItems = codec
      .decode(execOut.content, items, { scene, assistant })
      .filter((it) => !it.partial)
      .map(restoreItemGlossary);
    if (onItemReady) {
      for (const item of decodedItems) {
        onItemReady(item);
      }
    }
  }

  // If input had non-empty items and LLM returned 0 parseable items, surface invalid-response
  const hasNonEmptyInput = items.some((it) => it.text.trim() !== '');
  if (hasNonEmptyInput && decodedItems.length === 0) {
    const diagnostic = buildDiagnosticSnapshot({
      scene,
      codec: codecId,
      provider: {
        id: provider.id,
        preset: provider.preset,
        protocol: provider.protocol,
        resolvedEndpoint: execOut.resolvedEndpoint,
        model: provider.model,
      },
      parameters: {
        temperatureTrace: execOut.temperatureTrace,
        temperatureSent: execOut.temperatureSent,
        thinkingMode: provider.thinkingPolicy.mode,
        stream: useStream,
      },
      httpStatus: execOut.httpStatus,
      kind: 'invalid-response',
      retryable: true,
      attempts: execOut.attempts,
      latencyMs: execOut.latencyMs,
      rawError: `Failed to parse ${codecId} output from model response: ${execOut.content.slice(0, 180)}`,
      knownSecrets,
    });

    return {
      ok: false,
      items: [],
      diagnostic,
      error: {
        code: 'INVALID_CODEC_OUTPUT',
        message:
          diagnostic.sanitizedError ||
          `Model output did not match expected ${codecId} format.`,
        retryable: true,
      },
    };
  }

  const kind = classifyDiagnosticKind({
    ok: true,
    httpStatus: execOut.httpStatus,
    recoveredFromUnsupportedParam: execOut.recoveredFromUnsupportedParam,
  });

  const diagnostic = buildDiagnosticSnapshot({
    scene,
    codec: codecId,
    provider: {
      id: provider.id,
      preset: provider.preset,
      protocol: provider.protocol,
      resolvedEndpoint: execOut.resolvedEndpoint,
      model: provider.model,
    },
    parameters: {
      temperatureTrace: execOut.temperatureTrace,
      temperatureSent: execOut.temperatureSent,
      thinkingMode: provider.thinkingPolicy.mode,
      stream: useStream,
    },
    httpStatus: execOut.httpStatus,
    kind,
    retryable: false,
    attempts: execOut.attempts,
    latencyMs: execOut.latencyMs,
    knownSecrets,
  });

  return {
    ok: true,
    items: decodedItems,
    diagnostic,
  };
}

export async function executeVisionWithProvider(
  options: ExecuteVisionOptions,
): Promise<ExecuteVisionResult> {
  const {
    provider,
    assistant,
    systemPrompt,
    userPrompt,
    imageDataUrl,
    fetchImpl = globalThis.fetch.bind(globalThis),
    pool = defaultProviderPool,
    retryBaseDelayMs = 600,
    requestTimeoutMs,
    streamIdleTimeoutMs,
    signal,
    priority,
  } = options;

  const effectivePriority = resolveRequestPriority('image', priority);

  const knownSecrets: string[] = [
    ...provider.apiKeys,
    ...(provider.endpoints ?? []),
    ...Object.values(provider.extraHeaders ?? {}),
  ];

  if (
    provider.protocol !== 'openai-chat' &&
    provider.protocol !== 'anthropic-messages'
  ) {
    const resolvedEndpoint = resolveEndpointForProvider(provider);
    const msg = `Provider "${provider.name}" (${provider.protocol}) does not support multimodal image vision. Route Image scene to an OpenAI-compatible or Anthropic vision model.`;
    const diagnostic = buildDiagnosticSnapshot({
      scene: 'image',
      codec: 'json-batch',
      provider: {
        id: provider.id,
        preset: provider.preset,
        protocol: provider.protocol,
        resolvedEndpoint,
        model: provider.model,
      },
      parameters: {
        temperatureTrace: 'omitted-default',
        thinkingMode: provider.thinkingPolicy.mode,
        stream: false,
      },
      kind: 'bad-request',
      retryable: false,
      attempts: 1,
      latencyMs: 0,
      rawError: msg,
      knownSecrets,
    });
    return {
      ok: false,
      rawText: '',
      diagnostic,
      error: {
        code: 'VISION_UNSUPPORTED_PROTOCOL',
        message: msg,
        retryable: false,
      },
    };
  }

  const execOut = await runSelfHealingAiCompletion({
    scene: 'image',
    codecId: 'json-batch',
    provider,
    assistant,
    systemPrompt,
    userPrompt,
    imageDataUrl,
    stream: false,
    fetchImpl,
    pool,
    retryBaseDelayMs,
    requestTimeoutMs,
    streamIdleTimeoutMs,
    signal,
    priority,
  });

  if (!execOut.ok) {
    const kind = classifyDiagnosticKind({
      ok: false,
      httpStatus: execOut.httpStatus,
      isNetworkError: execOut.isNetworkError,
    });
    const diagnostic = buildDiagnosticSnapshot({
      scene: 'image',
      codec: 'json-batch',
      provider: {
        id: provider.id,
        preset: provider.preset,
        protocol: provider.protocol,
        resolvedEndpoint: execOut.resolvedEndpoint,
        model: provider.model,
      },
      parameters: {
        temperatureTrace: execOut.temperatureTrace,
        temperatureSent: execOut.temperatureSent,
        thinkingMode: provider.thinkingPolicy.mode,
        stream: false,
      },
      httpStatus: execOut.httpStatus,
      kind,
      retryable: execOut.retryable,
      attempts: execOut.attempts,
      latencyMs: execOut.latencyMs,
      rawError: execOut.rawError,
      knownSecrets,
    });

    return {
      ok: false,
      rawText: '',
      diagnostic,
      error: {
        code: execOut.httpStatus ? `HTTP_${execOut.httpStatus}` : 'NETWORK_ERROR',
        message: diagnostic.sanitizedError || 'Vision translation request failed.',
        retryable: execOut.retryable,
      },
    };
  }

  const kind = classifyDiagnosticKind({
    ok: true,
    httpStatus: execOut.httpStatus,
    recoveredFromUnsupportedParam: execOut.recoveredFromUnsupportedParam,
  });

  const diagnostic = buildDiagnosticSnapshot({
    scene: 'image',
    codec: 'json-batch',
    provider: {
      id: provider.id,
      preset: provider.preset,
      protocol: provider.protocol,
      resolvedEndpoint: execOut.resolvedEndpoint,
      model: provider.model,
    },
    parameters: {
      temperatureTrace: execOut.temperatureTrace,
      temperatureSent: execOut.temperatureSent,
      thinkingMode: provider.thinkingPolicy.mode,
      stream: false,
    },
    httpStatus: execOut.httpStatus,
    kind,
    retryable: false,
    attempts: execOut.attempts,
    latencyMs: execOut.latencyMs,
    knownSecrets,
  });

  return {
    ok: true,
    rawText: execOut.content,
    diagnostic,
  };
}

export { DEFAULT_JSON_BATCH_SYSTEM_PROMPT, buildDefaultJsonBatchSystemPrompt };
export type { AssistantConfig };
