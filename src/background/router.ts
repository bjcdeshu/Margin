import { buildDiagnosticSnapshot } from '@core/diagnostics';
import {
  computeMatchedGlossarySignature,
  resolveEffectiveGlossary,
} from '@core/prompts';
import {
  executeBatchWithProvider,
  executeVisionWithProvider,
  type ProviderRuntimeEnv,
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

  const cachedOutputs = new Map<number, BatchItemOutput>();
  const uncachedItems: BatchItemInput[] = [];
  const cacheKeysByItemId = new Map<number, string>();

  if (useCache && request.items.length > 0) {
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

    const hitsMap = await cache.getMany(requestedKeys);
    for (const item of request.items) {
      const key = cacheKeysByItemId.get(item.id);
      const hit = key !== undefined ? hitsMap.get(key) : undefined;
      if (hit !== undefined) {
        const outItem: BatchItemOutput = { id: item.id, trans: hit };
        cachedOutputs.set(item.id, outItem);
        streamCallbacks?.onItemReady?.(outItem);
      } else {
        uncachedItems.push(item);
      }
    }
  } else {
    uncachedItems.push(...request.items);
  }

  if (uncachedItems.length === 0 && request.items.length > 0) {
    const orderedCached = request.items
      .map((it) => cachedOutputs.get(it.id))
      .filter((it): it is BatchItemOutput => it !== undefined);
    const diagnostic = buildDiagnosticSnapshot({
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

    return {
      ok: true,
      requestId: request.requestId,
      providerId: provider.id,
      model: provider.model,
      items: orderedCached,
      diagnostic,
    };
  }

  const result = await executeBatchWithProvider({
    scene: request.scene,
    provider,
    assistant,
    fromLang: request.fromLang,
    toLang: request.toLang,
    items: uncachedItems,
    context: effectiveContext,
    glossary: configForRun.glossary,
    stream: streamCallbacks?.stream ?? false,
    onDelta: streamCallbacks?.onDelta,
    onItemReady: streamCallbacks?.onItemReady,
    fetchImpl: env.fetchImpl,
    pool: env.pool,
    retryBaseDelayMs: env.retryBaseDelayMs,
    requestTimeoutMs: env.requestTimeoutMs,
    streamIdleTimeoutMs: env.streamIdleTimeoutMs,
    signal: env.signal,
  });

  await appendDiagnosticSnapshot(result.diagnostic);

  if (result.ok && useCache) {
    const uncachedById = new Map(uncachedItems.map((it) => [it.id, it]));
    const writeBatch: TranslationPersistenceWriteItem[] = [];
    for (const outItem of result.items) {
      const srcItem = uncachedById.get(outItem.id);
      if (srcItem && outItem.trans.trim() !== '') {
        const key =
          cacheKeysByItemId.get(outItem.id) ??
          makeTranslationCacheKey({
            providerId: provider.id,
            model: provider.model,
            assistantId: assistant?.id,
            codecId,
            scene: request.scene,
            fromLang: request.fromLang,
            toLang: request.toLang,
            matchedGlossarySig: computeMatchedGlossarySignature(
              [srcItem.text],
              effectiveGlossary,
              domainOrUrl,
            ),
            promptFingerprint,
            styleGuide: effectiveStyleGuide,
            sourceText: srcItem.text,
          });
        writeBatch.push({
          key,
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
  }

  if (!result.ok) {
    return {
      ok: false,
      requestId: request.requestId,
      providerId: provider.id,
      model: provider.model,
      items: [],
      diagnostic: result.diagnostic,
      error: result.error,
    };
  }

  // Merge cached + freshly translated outputs preserving original `request.items` slot order
  const freshById = new Map(result.items.map((it) => [it.id, it]));
  const mergedItems: BatchItemOutput[] = [];
  for (const reqItem of request.items) {
    const hit = freshById.get(reqItem.id) ?? cachedOutputs.get(reqItem.id);
    if (hit) {
      mergedItems.push(hit);
    }
  }

  return {
    ok: true,
    requestId: request.requestId,
    providerId: provider.id,
    model: provider.model,
    items: mergedItems,
    diagnostic: result.diagnostic,
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
    t === 'margin:clear-translation-cache'
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
