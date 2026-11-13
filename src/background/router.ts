import { buildDiagnosticSnapshot } from '@core/diagnostics';
import {
  computeMatchedGlossarySignature,
  resolveEffectiveGlossary,
} from '@core/prompts';
import {
  executeBatchWithProvider,
  executeVisionWithProvider,
  type ExecuteBatchResult,
  type ProviderRuntimeEnv,
  resolveDeepLXEndpoints,
  resolveEndpointForProvider,
} from '@core/providers';
import { BRAND } from '@shared/brand';
import { resolveProviderIdForScene } from '@shared/constants';
import { sendTabCommand } from '@shared/messaging';
import { appendDiagnosticSnapshot, getMarginConfig } from '@shared/storage';
import type {
  BatchItemInput,
  BatchItemOutput,
  MarginConfig,
  PageContextPayload,
  ProviderConfig,
  RuntimeRpcRequest,
  RuntimeRpcResponse,
  TabCommandMessage,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateImageRequest,
  TranslateImageResponse,
  TranslateStreamPortMessage,
} from '@shared/types';
import {
  backgroundTranslationCache,
  computeAssistantPromptFingerprint,
  makeTranslationCacheKey,
  type TranslationLruCache,
} from './cache';
import type { TranslationPersistenceWriteItem } from './translation-db';
import {
  type DnrFetchDependencies,
  fetchImageDataUrlWithDnr,
} from './dnr-image';
import {
  buildVisionTranslationPrompts,
  parseVisionTranslationOutput,
} from './vision';

export const CONTEXT_MENU_IDS = {
  translatePage: 'margin:ctx:translate-page',
  translateImage: 'margin:ctx:translate-image',
  openPdf: 'margin:ctx:open-pdf',
} as const;

export const SERVICE_TEST_SAMPLE_TEXT =
  'Quiet paper makes bilingual reading effortless.';

export interface BackgroundRouterEnv
  extends ProviderRuntimeEnv,
    DnrFetchDependencies {
  translationCache?: TranslationLruCache;
}

export interface SingleflightTranslationResult {
  trans: string;
  thinking?: string;
  fallbackPlain?: boolean;
}

export const inFlightTranslations = new Map<
  string,
  Promise<SingleflightTranslationResult>
>();

type SingleflightStreamListener = (update: {
  trans: string;
  thinking?: string;
  fallbackPlain?: boolean;
  partial?: boolean;
}) => void;

const inFlightStreamListeners = new Map<
  string,
  Set<SingleflightStreamListener>
>();

const WARMUP_ORIGIN_THROTTLE_MS = 45_000;
const lastWarmupByOrigin = new Map<string, number>();

export function resetRouterTransientStateForTests(): void {
  inFlightTranslations.clear();
  inFlightStreamListeners.clear();
  lastWarmupByOrigin.clear();
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      new DOMException('The operation was aborted.', 'AbortError'),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function filterContextForProvider(
  provider: ProviderConfig,
  context?: PageContextPayload,
): PageContextPayload | undefined {
  if (!context) return undefined;
  if (provider.enableContext) {
    return context;
  }
  // Even when prose context (`title`/`summary`) is disabled, keep `url`/`domain` for domain-scoped glossaries
  // and `styleGuide` for subtitle anti-spillover rules.
  return {
    url: context.url,
    domain: context.domain,
    ...(context.styleGuide ? { styleGuide: context.styleGuide } : {}),
  };
}

function shouldUseTranslationCache(
  scene: TranslateBatchRequest['scene'],
): boolean {
  return scene !== 'service-test' && scene !== 'input';
}

function buildMissingProviderBatchResponse(
  request: TranslateBatchRequest,
  attemptedProviderId: string,
  errorCode: 'PROVIDER_NOT_FOUND' | 'PROVIDER_DISABLED' = 'PROVIDER_NOT_FOUND',
): TranslateBatchResponse {
  const msg =
    errorCode === 'PROVIDER_DISABLED'
      ? `Provider "${attemptedProviderId}" is currently disabled.`
      : `Provider "${attemptedProviderId}" is not configured or enabled.`;
  const diagnostic = buildDiagnosticSnapshot({
    scene: request.scene,
    codec: 'json-batch',
    provider: {
      id: attemptedProviderId || 'unknown',
      preset: 'custom',
      protocol: 'openai-chat',
      resolvedEndpoint: 'https://invalid.local/',
      model: 'unknown',
    },
    parameters: {
      temperatureTrace: 'omitted-default',
      thinkingMode: 'provider-default',
      stream: false,
    },
    kind: 'bad-request',
    retryable: false,
    attempts: 1,
    latencyMs: 0,
    rawError: msg,
  });

  return {
    ok: false,
    requestId: request.requestId,
    providerId: attemptedProviderId,
    model: '',
    items: [],
    diagnostic,
    error: {
      code: errorCode,
      message: msg,
      retryable: false,
    },
  };
}

export async function handleTranslateBatch(
  request: TranslateBatchRequest,
  config: MarginConfig,
  env: BackgroundRouterEnv = {},
  streamCallbacks?: {
    stream: boolean;
    onDelta?: (delta: string) => void;
    onItemReady?: (item: BatchItemOutput) => void;
  },
): Promise<TranslateBatchResponse> {
  if (request.providerId && request.scene !== 'service-test') {
    const explicit = config.providers[request.providerId];
    if (!explicit || !explicit.enabled) {
      const missingResp = buildMissingProviderBatchResponse(
        request,
        request.providerId,
        explicit ? 'PROVIDER_DISABLED' : 'PROVIDER_NOT_FOUND',
      );
      await appendDiagnosticSnapshot(missingResp.diagnostic);
      return missingResp;
    }
  }

  const providerId = resolveProviderIdForScene(
    request.scene,
    config.routing,
    config.providers,
    request.providerId,
  );
  const provider = config.providers[providerId];
  if (!provider || (request.scene !== 'service-test' && !provider.enabled)) {
    const missingResp = buildMissingProviderBatchResponse(
      request,
      providerId,
      provider ? 'PROVIDER_DISABLED' : 'PROVIDER_NOT_FOUND',
    );
    await appendDiagnosticSnapshot(missingResp.diagnostic);
    return missingResp;
  }

  const assistant = provider.assistantId
    ? config.assistants[provider.assistantId]
    : undefined;
  const codecId =
    provider.protocol === 'deeplx' || provider.protocol === 'google-web'
      ? 'single-text'
      : (assistant?.codec ?? 'json-batch');

  const effectiveGlossary = resolveEffectiveGlossary(config);
  const configForRun: MarginConfig = {
    ...config,
    glossary: effectiveGlossary,
  };
  const effectiveContext = filterContextForProvider(provider, request.context);
  const domainOrUrl = request.context?.domain || request.context?.url;
  const effectiveStyleGuide = effectiveContext?.styleGuide;
  const promptFingerprint = computeAssistantPromptFingerprint(
    assistant,
    request.scene,
    codecId,
  );

  const cache = env.translationCache ?? backgroundTranslationCache;
  const useCache = shouldUseTranslationCache(request.scene);

  const finalizedEmittedIds = new Set<number>();
  const lastPartialEmittedById = new Map<number, string>();
  const emitItemReady = (item: BatchItemOutput): void => {
    if (!streamCallbacks?.onItemReady || env.signal?.aborted) return;
    if (item.partial) {
      if (finalizedEmittedIds.has(item.id)) return;
      if (lastPartialEmittedById.get(item.id) === item.trans) return;
      lastPartialEmittedById.set(item.id, item.trans);
      streamCallbacks.onItemReady(item);
      return;
    }
    if (finalizedEmittedIds.has(item.id)) return;
    finalizedEmittedIds.add(item.id);
    streamCallbacks.onItemReady(item);
  };

  if (!useCache || request.items.length === 0) {
    const directResult = await executeBatchWithProvider({
      scene: request.scene,
      priority: request.priority ?? env.priority,
      provider,
      assistant,
      fromLang: request.fromLang,
      toLang: request.toLang,
      items: request.items,
      context: effectiveContext,
      glossary: configForRun.glossary,
      stream: streamCallbacks?.stream ?? false,
      onDelta: streamCallbacks?.onDelta,
      onItemReady: streamCallbacks?.onItemReady ? emitItemReady : undefined,
      fetchImpl: env.fetchImpl,
      pool: env.pool,
      retryBaseDelayMs: env.retryBaseDelayMs,
      requestTimeoutMs: env.requestTimeoutMs,
      streamIdleTimeoutMs: env.streamIdleTimeoutMs,
      signal: env.signal,
    });

    await appendDiagnosticSnapshot(directResult.diagnostic);

    if (!directResult.ok) {
      return {
        ok: false,
        requestId: request.requestId,
        providerId: provider.id,
        model: provider.model,
        items: [],
        diagnostic: directResult.diagnostic,
        error: directResult.error,
      };
    }

    return {
      ok: true,
      requestId: request.requestId,
      providerId: provider.id,
      model: provider.model,
      items: directResult.items.filter((it) => !it.partial),
      diagnostic: directResult.diagnostic,
    };
  }

  const resolvedOutputs = new Map<number, BatchItemOutput>();
  const cacheKeysByItemId = new Map<number, string>();
  const requestedKeys: string[] = [];

  for (const item of request.items) {
    const matchedGlossarySig = computeMatchedGlossarySignature(
      [item.text],
      effectiveGlossary,
      domainOrUrl,
    );
    const key = makeTranslationCacheKey({
      providerId: provider.id,
      model: provider.model,
      assistantId: assistant?.id,
      codecId,
      scene: request.scene,
      fromLang: request.fromLang,
      toLang: request.toLang,
      matchedGlossarySig,
      promptFingerprint,
      styleGuide: effectiveStyleGuide,
      sourceText: item.text,
    });
    cacheKeysByItemId.set(item.id, key);
    requestedKeys.push(key);
  }

  // 1. L1 + IndexedDB cache lookup
  const hitsMap = await cache.getMany(requestedKeys);
  const missGroupsByKey = new Map<string, BatchItemInput[]>();

  for (const item of request.items) {
    const key = cacheKeysByItemId.get(item.id)!;
    const hit = hitsMap.get(key);
    if (hit !== undefined) {
      const outItem: BatchItemOutput = { id: item.id, trans: hit };
      resolvedOutputs.set(item.id, outItem);
      emitItemReady(outItem);
    } else {
      let group = missGroupsByKey.get(key);
      if (!group) {
        group = [];
        missGroupsByKey.set(key, group);
      }
      group.push(item);
    }
  }

  const buildSyntheticSuccessDiagnostic = () =>
    buildDiagnosticSnapshot({
      scene: request.scene,
      codec: codecId,
      provider: {
        id: provider.id,
        preset: provider.preset,
        protocol: provider.protocol,
        resolvedEndpoint: provider.baseUrl,
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
      knownSecrets: provider.apiKeys,
    });

  if (missGroupsByKey.size === 0) {
    const orderedCached = request.items
      .map((it) => resolvedOutputs.get(it.id))
      .filter((it): it is BatchItemOutput => it !== undefined);
    return {
      ok: true,
      requestId: request.requestId,
      providerId: provider.id,
      model: provider.model,
      items: orderedCached,
      diagnostic: buildSyntheticSuccessDiagnostic(),
    };
  }

  // 2. Partition cache misses into Cross-Request Singleflight subscribers vs Intra-Batch deduplicated representatives
  interface OwnedFlightEntry {
    key: string;
    representative: BatchItemInput;
    dupItems: BatchItemInput[];
    resolve: (value: SingleflightTranslationResult) => void;
    reject: (reason?: unknown) => void;
  }

  interface SubscribedFlightEntry {
    key: string;
    dupItems: BatchItemInput[];
    promise: Promise<SingleflightTranslationResult>;
    unsubscribeStream?: () => void;
  }

  const registerOwnedGroups = (
    groups: ReadonlyArray< readonly [string, BatchItemInput[]] >,
  ): OwnedFlightEntry[] => {
    const entries: OwnedFlightEntry[] = [];
    for (const [key, dupItems] of groups) {
      let resolveFn!: (value: SingleflightTranslationResult) => void;
      let rejectFn!: (reason?: unknown) => void;
      const promise = new Promise<SingleflightTranslationResult>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      // Prevent unhandled rejection warnings when 0 external requests subscribe to this key
      promise.catch(() => undefined);

      inFlightTranslations.set(key, promise);
      inFlightStreamListeners.set(key, new Set());
      entries.push({
        key,
        representative: dupItems[0],
        dupItems,
        resolve: resolveFn,
        reject: rejectFn,
      });
    }
    return entries;
  };

  const executeOwnedEntries = async (
    ownedEntries: readonly OwnedFlightEntry[],
  ): Promise<ExecuteBatchResult> => {
    const entryByRepId = new Map<number, OwnedFlightEntry>(
      ownedEntries.map((e) => [e.representative.id, e]),
    );
    const reps = ownedEntries.map((e) => e.representative);

    try {
      const execResult = await executeBatchWithProvider({
        scene: request.scene,
        priority: request.priority ?? env.priority,
        provider,
        assistant,
        fromLang: request.fromLang,
        toLang: request.toLang,
        items: reps,
        context: effectiveContext,
        glossary: configForRun.glossary,
        stream: streamCallbacks?.stream ?? false,
        onDelta: streamCallbacks?.onDelta,
        onItemReady: (repItem) => {
          const entry = entryByRepId.get(repItem.id);
          if (!entry) return;

          // Fan out partial & final streaming events to ALL matching duplicate item IDs in this batch
          for (const dup of entry.dupItems) {
            emitItemReady({
              ...repItem,
              id: dup.id,
            });
          }

          // Fan out to any cross-request singleflight stream subscribers
          const listeners = inFlightStreamListeners.get(entry.key);
          if (listeners && listeners.size > 0) {
            for (const listener of listeners) {
              listener({
                trans: repItem.trans,
                thinking: repItem.thinking,
                fallbackPlain: repItem.fallbackPlain,
                partial: repItem.partial,
              });
            }
          }
        },
        fetchImpl: env.fetchImpl,
        pool: env.pool,
        retryBaseDelayMs: env.retryBaseDelayMs,
        requestTimeoutMs: env.requestTimeoutMs,
        streamIdleTimeoutMs: env.streamIdleTimeoutMs,
        signal: env.signal,
      });

      await appendDiagnosticSnapshot(execResult.diagnostic);

      if (!execResult.ok) {
        const upstreamErr = new Error(
          execResult.error?.message || 'Upstream batch translation failed.',
        );
        for (const entry of ownedEntries) {
          inFlightTranslations.delete(entry.key);
          inFlightStreamListeners.delete(entry.key);
          entry.reject(upstreamErr);
        }
        return execResult;
      }

      // Strictly persist ONLY finalized (`!partial`) and non-empty translations!
      const finalizedRepMap = new Map<number, BatchItemOutput>();
      const writeBatch: TranslationPersistenceWriteItem[] = [];

      for (const outItem of execResult.items) {
        if (outItem.partial) continue;
        finalizedRepMap.set(outItem.id, outItem);
        const entry = entryByRepId.get(outItem.id);
        if (entry && outItem.trans.trim() !== '') {
          writeBatch.push({
            key: entry.key,
            value: outItem.trans,
            meta: {
              providerId: provider.id,
              model: provider.model,
              fromLang: request.fromLang,
              toLang: request.toLang,
              scene: request.scene,
            },
          });
        }
      }

      if (writeBatch.length > 0) {
        await cache.setMany(writeBatch);
      }

      for (const entry of ownedEntries) {
        inFlightTranslations.delete(entry.key);
        inFlightStreamListeners.delete(entry.key);
        const repOut = finalizedRepMap.get(entry.representative.id);
        if (repOut) {
          const sfValue: SingleflightTranslationResult = {
            trans: repOut.trans,
            ...(repOut.thinking ? { thinking: repOut.thinking } : {}),
            ...(repOut.fallbackPlain
              ? { fallbackPlain: repOut.fallbackPlain }
              : {}),
          };
          for (const dup of entry.dupItems) {
            const dupOut: BatchItemOutput = {
              id: dup.id,
              ...sfValue,
            };
            resolvedOutputs.set(dup.id, dupOut);
            emitItemReady(dupOut);
          }
          entry.resolve(sfValue);
        } else {
          entry.reject(new Error('Translation omitted by provider.'));
        }
      }

      return execResult;
    } catch (err) {
      for (const entry of ownedEntries) {
        inFlightTranslations.delete(entry.key);
        inFlightStreamListeners.delete(entry.key);
        entry.reject(err);
      }
      throw err;
    }
  };

  const subscribedFlights: SubscribedFlightEntry[] = [];
  const initialOwnedGroups: Array<readonly [string, BatchItemInput[]]> = [];

  for (const [key, dupItems] of missGroupsByKey.entries()) {
    const existingPromise = inFlightTranslations.get(key);
    if (existingPromise) {
      let unsubscribeStream: (() => void) | undefined;
      const listenerSet = inFlightStreamListeners.get(key);
      if (listenerSet && streamCallbacks?.onItemReady) {
        const streamListener: SingleflightStreamListener = (upd) => {
          for (const dup of dupItems) {
            emitItemReady({
              id: dup.id,
              trans: upd.trans,
              ...(upd.thinking ? { thinking: upd.thinking } : {}),
              ...(upd.fallbackPlain
                ? { fallbackPlain: upd.fallbackPlain }
                : {}),
              ...(upd.partial ? { partial: true } : {}),
            });
          }
        };
        listenerSet.add(streamListener);
        unsubscribeStream = () => {
          listenerSet.delete(streamListener);
        };
      }
      subscribedFlights.push({
        key,
        dupItems,
        promise: existingPromise,
        unsubscribeStream,
      });
    } else {
      initialOwnedGroups.push([key, dupItems]);
    }
  }

  const ownedEntries = registerOwnedGroups(initialOwnedGroups);
  let lastExecResult: ExecuteBatchResult | null = null;

  const ownedRunPromise =
    ownedEntries.length > 0
      ? executeOwnedEntries(ownedEntries)
      : Promise.resolve(null);

  const orphanedGroups: Array<readonly [string, BatchItemInput[]]> = [];
  const subscribePromise = (async () => {
    for (const sub of subscribedFlights) {
      try {
        const sfVal = await raceWithAbort(sub.promise, env.signal);
        for (const dup of sub.dupItems) {
          const dupOut: BatchItemOutput = {
            id: dup.id,
            trans: sfVal.trans,
            ...(sfVal.thinking ? { thinking: sfVal.thinking } : {}),
            ...(sfVal.fallbackPlain
              ? { fallbackPlain: sfVal.fallbackPlain }
              : {}),
          };
          resolvedOutputs.set(dup.id, dupOut);
          emitItemReady(dupOut);
        }
      } catch (err) {
        if (env.signal?.aborted) {
          throw err;
        }
        // Peer request cancelled or failed while this request is still alive: check cache or rescue
        const lateCached = cache.get(sub.key);
        if (lateCached !== undefined) {
          for (const dup of sub.dupItems) {
            const dupOut: BatchItemOutput = { id: dup.id, trans: lateCached };
            resolvedOutputs.set(dup.id, dupOut);
            emitItemReady(dupOut);
          }
        } else {
          orphanedGroups.push([sub.key, sub.dupItems]);
        }
      } finally {
        sub.unsubscribeStream?.();
      }
    }
  })();

  try {
    const [ownedOut] = await Promise.all([ownedRunPromise, subscribePromise]);
    lastExecResult = ownedOut;
  } finally {
    for (const sub of subscribedFlights) {
      sub.unsubscribeStream?.();
    }
  }

  if (lastExecResult && !lastExecResult.ok) {
    return {
      ok: false,
      requestId: request.requestId,
      providerId: provider.id,
      model: provider.model,
      items: [],
      diagnostic: lastExecResult.diagnostic,
      error: lastExecResult.error,
    };
  }

  if (orphanedGroups.length > 0 && !env.signal?.aborted) {
    const rescueEntries = registerOwnedGroups(orphanedGroups);
    const rescueResult = await executeOwnedEntries(rescueEntries);
    lastExecResult = rescueResult;
    if (!rescueResult.ok && resolvedOutputs.size === 0) {
      return {
        ok: false,
        requestId: request.requestId,
        providerId: provider.id,
        model: provider.model,
        items: [],
        diagnostic: rescueResult.diagnostic,
        error: rescueResult.error,
      };
    }
  }

  // Merge cached + singleflight-coalesced + freshly translated outputs preserving original `request.items` slot order
  const mergedItems: BatchItemOutput[] = [];
  for (const reqItem of request.items) {
    const hit = resolvedOutputs.get(reqItem.id);
    if (hit && !hit.partial) {
      mergedItems.push(hit);
    }
  }

  return {
    ok: true,
    requestId: request.requestId,
    providerId: provider.id,
    model: provider.model,
    items: mergedItems,
    diagnostic: lastExecResult?.diagnostic ?? buildSyntheticSuccessDiagnostic(),
  };
}

export async function handleTranslateImage(
  request: TranslateImageRequest,
  config: MarginConfig,
  env: BackgroundRouterEnv = {},
): Promise<TranslateImageResponse> {
  const resolvedId = resolveProviderIdForScene(
    'image',
    config.routing,
    config.providers,
    request.providerId,
  );
  const providerId =
    request.providerId && config.providers[request.providerId]?.enabled === false
      ? request.providerId
      : resolvedId;
  const provider = request.providerId
    ? config.providers[request.providerId]
    : config.providers[providerId];

  if (!provider || !provider.enabled) {
    const targetId = request.providerId ?? providerId;
    const errCode = provider ? 'PROVIDER_DISABLED' : 'PROVIDER_NOT_FOUND';
    const msg =
      errCode === 'PROVIDER_DISABLED'
        ? `Provider "${targetId}" is currently disabled for Image translation.`
        : `Provider "${targetId}" is not configured or enabled for Image translation.`;
    const diagnostic = buildDiagnosticSnapshot({
      scene: 'image',
      codec: 'json-batch',
      provider: {
        id: targetId || 'unknown',
        preset: 'custom',
        protocol: 'openai-chat',
        resolvedEndpoint: 'https://invalid.local/',
        model: 'unknown',
      },
      parameters: {
        temperatureTrace: 'omitted-default',
        thinkingMode: 'provider-default',
        stream: false,
      },
      kind: 'bad-request',
      retryable: false,
      attempts: 1,
      latencyMs: 0,
      rawError: msg,
    });
    await appendDiagnosticSnapshot(diagnostic);
    return {
      ok: false,
      requestId: request.requestId,
      providerId: targetId,
      model: '',
      regions: [],
      diagnostic,
      error: {
        code: errCode,
        message: msg,
        retryable: false,
      },
    };
  }

  const assistant = provider.assistantId
    ? config.assistants[provider.assistantId]
    : undefined;

  const effectiveGlossary = resolveEffectiveGlossary(config);

  const { systemPrompt, userPrompt } = buildVisionTranslationPrompts({
    fromLang: request.fromLang,
    toLang: request.toLang,
    glossary: effectiveGlossary,
    pageUrl: request.pageUrl,
  });

  const visionExec = await executeVisionWithProvider({
    provider,
    assistant,
    systemPrompt,
    userPrompt,
    imageDataUrl: request.imageDataUrl,
    fetchImpl: env.fetchImpl,
    pool: env.pool,
    retryBaseDelayMs: env.retryBaseDelayMs,
    requestTimeoutMs: env.requestTimeoutMs,
    streamIdleTimeoutMs: env.streamIdleTimeoutMs,
    signal: env.signal,
  });

  await appendDiagnosticSnapshot(visionExec.diagnostic);

  if (!visionExec.ok) {
    return {
      ok: false,
      requestId: request.requestId,
      providerId: provider.id,
      model: provider.model,
      regions: [],
      diagnostic: visionExec.diagnostic,
      error: visionExec.error,
    };
  }

  const parsed = parseVisionTranslationOutput(visionExec.rawText);

  return {
    ok: true,
    requestId: request.requestId,
    providerId: provider.id,
    model: provider.model,
    regions: parsed.regions,
    ...(parsed.fallbackFullText
      ? { fallbackFullText: parsed.fallbackFullText }
      : {}),
    diagnostic: visionExec.diagnostic,
  };
}

export async function handleRuntimeRpcRequest(
  request: RuntimeRpcRequest,
  env: BackgroundRouterEnv = {},
): Promise<RuntimeRpcResponse> {
  switch (request.type) {
    case 'margin:translate-batch': {
      const config = await getMarginConfig();
      return handleTranslateBatch(request.payload, config, env);
    }

    case 'margin:translate-image': {
      const config = await getMarginConfig();
      return handleTranslateImage(request.payload, config, env);
    }

    case 'margin:fetch-image-data-url': {
      return fetchImageDataUrlWithDnr(request.payload, {
        fetchImpl: env.fetchImpl,
        dnrApi: env.dnrApi,
      });
    }

    case 'margin:test-provider': {
      const config = await getMarginConfig();
      const testBatch: TranslateBatchRequest = {
        requestId: `service-test-${Date.now()}`,
        scene: 'service-test',
        providerId: request.payload.providerId,
        fromLang: 'en',
        toLang: config.targetLang || 'zh-CN',
        items: [{ id: 1, text: SERVICE_TEST_SAMPLE_TEXT }],
      };
      return handleTranslateBatch(testBatch, config, env);
    }

    case 'margin:get-translation-cache-stats': {
      const cache = env.translationCache ?? backgroundTranslationCache;
      const stats = await cache.getStats();
      return {
        ok: true,
        memoryEntries: stats.memoryEntries,
        persistentEntries: stats.persistentEntries,
        dbAvailable: stats.dbAvailable,
      };
    }

    case 'margin:clear-translation-cache': {
      const cache = env.translationCache ?? backgroundTranslationCache;
      await cache.clearAll();
      if (
        typeof globalThis.chrome !== 'undefined' &&
        typeof chrome.tabs?.query === 'function' &&
        typeof chrome.tabs?.sendMessage === 'function'
      ) {
        try {
          const tabs = await chrome.tabs.query({});
          await Promise.all(
            tabs.map(async (tab) => {
              if (tab.id === undefined) return;
              try {
                await chrome.tabs.sendMessage(tab.id, {
                  type: 'margin:cmd:clear-page-cache',
                });
              } catch {
                // Ignore tabs without active content script
              }
            }),
          );
        } catch {
          // Ignore tab enumeration errors
        }
      }
      return { ok: true };
    }

    case 'margin:warmup': {
      const cache = env.translationCache ?? backgroundTranslationCache;
      void cache.getStats().catch(() => {});

      try {
        const config = await getMarginConfig();
        const targetScene = request.payload?.scene ?? 'webpage';
        const provId = resolveProviderIdForScene(
          targetScene,
          config.routing,
          config.providers,
          request.payload?.providerId,
        );
        const prov = config.providers[provId];
        if (
          prov &&
          prov.enabled &&
          (prov.protocol === 'openai-chat' ||
            prov.protocol === 'anthropic-messages' ||
            prov.protocol === 'deeplx')
        ) {
          const endpoint =
            prov.protocol === 'deeplx'
              ? resolveDeepLXEndpoints(prov)[0]
              : resolveEndpointForProvider(prov);
          const origin = new URL(endpoint).origin;
          const now = Date.now();
          const lastWarmupAt = lastWarmupByOrigin.get(origin) ?? 0;
          if (now - lastWarmupAt >= WARMUP_ORIGIN_THROTTLE_MS) {
            lastWarmupByOrigin.set(origin, now);
            const fetchFn =
              env.fetchImpl ??
              (typeof globalThis.fetch === 'function'
                ? globalThis.fetch.bind(globalThis)
                : undefined);
            if (fetchFn) {
              const timeoutSignal =
                typeof AbortSignal !== 'undefined' &&
                typeof AbortSignal.timeout === 'function'
                  ? AbortSignal.timeout(2000)
                  : undefined;
              void Promise.resolve(
                fetchFn(origin, {
                  method: 'HEAD',
                  mode: 'no-cors',
                  ...(timeoutSignal ? { signal: timeoutSignal } : {}),
                }),
              ).catch(() => {});
            }
          }
        }
      } catch {
        // Warmup is strictly best-effort and never fails
      }

      return { ok: true };
    }
  }
}

export function isRuntimeRpcRequest(msg: unknown): msg is RuntimeRpcRequest {
  if (!msg || typeof msg !== 'object') return false;
  const t = (msg as { type?: unknown }).type;
  return (
    t === 'margin:translate-batch' ||
    t === 'margin:translate-image' ||
    t === 'margin:fetch-image-data-url' ||
    t === 'margin:test-provider' ||
    t === 'margin:get-translation-cache-stats' ||
    t === 'margin:clear-translation-cache' ||
    t === 'margin:warmup'
  );
}

/**
 * Handles progressive SSE streaming ports (`chrome.runtime.onConnect` with
 * `port.name === BRAND.streamPortName` = `'margin:translate-stream'`).
 */
export function attachStreamTranslationPort(
  port: Pick<
    chrome.runtime.Port,
    'name' | 'postMessage' | 'onMessage' | 'onDisconnect' | 'disconnect'
  >,
  env: BackgroundRouterEnv = {},
): void {
  if (port.name !== BRAND.streamPortName) {
    return;
  }

  const activeControllers = new Map<string, AbortController>();
  let portDisconnected = false;

  const safePost = (message: TranslateStreamPortMessage) => {
    if (portDisconnected) return;
    try {
      port.postMessage(message);
    } catch {
      portDisconnected = true;
    }
  };

  port.onDisconnect.addListener(() => {
    portDisconnected = true;
    for (const controller of activeControllers.values()) {
      controller.abort();
    }
    activeControllers.clear();
  });

  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as TranslateStreamPortMessage;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'cancel') {
      const ctrl = activeControllers.get(msg.requestId);
      if (ctrl) {
        ctrl.abort();
        activeControllers.delete(msg.requestId);
      }
      return;
    }

    if (msg.type === 'start') {
      const payload = msg.payload;
      const controller = new AbortController();
      activeControllers.set(payload.requestId, controller);

      void (async () => {
        try {
          const config = await getMarginConfig();
          const response = await handleTranslateBatch(
            payload,
            config,
            {
              ...env,
              signal: controller.signal,
            },
            {
              stream: true,
              onDelta: (rawDelta) => {
                safePost({
                  type: 'delta',
                  requestId: payload.requestId,
                  rawDelta,
                });
              },
              onItemReady: (item) => {
                safePost({
                  type: 'item-ready',
                  requestId: payload.requestId,
                  item,
                });
              },
            },
          );

          if (controller.signal.aborted || portDisconnected) {
            return;
          }

          if (!response.ok && response.error) {
            safePost({
              type: 'error',
              requestId: payload.requestId,
              error: response.error,
              diagnostic: response.diagnostic,
            });
          } else {
            safePost({
              type: 'done',
              response,
            });
          }
        } catch (err) {
          if (controller.signal.aborted || portDisconnected) {
            return;
          }
          const message =
            err instanceof Error ? err.message : 'Stream translation failed.';
          safePost({
            type: 'error',
            requestId: payload.requestId,
            error: {
              code: 'STREAM_FAILED',
              message,
              retryable: true,
            },
          });
        } finally {
          activeControllers.delete(payload.requestId);
        }
      })();
    }
  });
}

export function mapCommandNameToTabMessage(
  command: string,
): TabCommandMessage | null {
  switch (command) {
    case 'toggleTranslatePage':
      return { type: 'margin:cmd:toggle-page' };
    case 'toggleTranslateWholePage':
      return { type: 'margin:cmd:translate-whole-page' };
    case 'toggleTranslationMask':
      return { type: 'margin:cmd:toggle-mask' };
    case 'translateInputBox':
      return { type: 'margin:cmd:translate-input' };
    default:
      return null;
  }
}

export async function dispatchShortcutCommand(
  command: string,
  tab?: Pick<chrome.tabs.Tab, 'id'>,
): Promise<boolean> {
  const message = mapCommandNameToTabMessage(command);
  if (!message) return false;

  let tabId = tab?.id;
  if (
    tabId === undefined &&
    typeof globalThis.chrome !== 'undefined' &&
    chrome.tabs?.query
  ) {
    const activeTabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    tabId = activeTabs[0]?.id;
  }

  if (tabId === undefined) {
    return false;
  }

  const dispatchResult = await sendTabCommand(tabId, message);
  return dispatchResult.ok;
}

export function registerContextMenus(): void {
  if (typeof globalThis.chrome === 'undefined' || !chrome.contextMenus) {
    return;
  }

  chrome.contextMenus.removeAll(() => {
    // Ignore lastError if menus were empty
    void chrome.runtime?.lastError;

    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.translatePage,
      title: '使用 Margin 双语翻译当前网页 (Alt+A)',
      contexts: ['page', 'selection'],
    });

    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.translateImage,
      title: '使用 Margin 翻译此图片',
      contexts: ['image'],
    });

    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.openPdf,
      title: '在 Margin 双语阅读器中打开 PDF',
      contexts: ['page', 'link'],
    });
  });
}

export async function handleContextMenuClicked(
  info: {
    menuItemId: string | number;
    srcUrl?: string;
    linkUrl?: string;
    pageUrl?: string;
  },
  tab?: Pick<chrome.tabs.Tab, 'id' | 'url'>,
): Promise<void> {
  switch (info.menuItemId) {
    case CONTEXT_MENU_IDS.translatePage: {
      if (tab?.id !== undefined) {
        await sendTabCommand(tab.id, { type: 'margin:cmd:toggle-page' });
      }
      break;
    }

    case CONTEXT_MENU_IDS.translateImage: {
      if (tab?.id !== undefined && info.srcUrl) {
        await sendTabCommand(tab.id, {
          type: 'margin:cmd:translate-context-image',
          srcUrl: info.srcUrl,
        });
      }
      break;
    }

    case CONTEXT_MENU_IDS.openPdf: {
      if (typeof globalThis.chrome === 'undefined' || !chrome.runtime?.getURL) {
        return;
      }
      const baseViewer = chrome.runtime.getURL('pdf.html');
      const candidateUrl = info.linkUrl || info.pageUrl || tab?.url || '';
      const isLoadablePdfCandidate =
        /^https?:\/\/|^file:\/\//i.test(candidateUrl) &&
        (/\.pdf(?:$|[?#])/i.test(candidateUrl) || Boolean(info.linkUrl));

      const targetUrl = isLoadablePdfCandidate
        ? `${baseViewer}?file=${encodeURIComponent(candidateUrl)}`
        : baseViewer;

      if (chrome.tabs?.create) {
        await chrome.tabs.create({ url: targetUrl });
      }
      break;
    }
  }
}
