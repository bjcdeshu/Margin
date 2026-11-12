import { BRAND } from './brand';
import type {
  AnyTabMessage,
  FetchImageDataUrlRequest,
  FetchImageDataUrlResponse,
  RuntimeRpcRequest,
  TabCommandDispatchResult,
  TabPageState,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateImageRequest,
  TranslateImageResponse,
  TranslateStreamPortMessage,
} from './types';

export function isExtensionContextValid(hadRuntimeIdAtMount = false): boolean {
  try {
    if (typeof globalThis.chrome === 'undefined' || !globalThis.chrome?.runtime) {
      return !hadRuntimeIdAtMount;
    }
    return Boolean(globalThis.chrome.runtime.id);
  } catch {
    return false;
  }
}

export async function sendRuntimeMessage<TResponse>(
  request: RuntimeRpcRequest,
): Promise<TResponse> {
  if (typeof globalThis.chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    throw new Error('Extension runtime messaging is unavailable in this context.');
  }
  return (await chrome.runtime.sendMessage(request)) as TResponse;
}

export function requestBatchTranslation(
  payload: TranslateBatchRequest,
): Promise<TranslateBatchResponse> {
  return sendRuntimeMessage<TranslateBatchResponse>({
    type: 'margin:translate-batch',
    payload,
  });
}

export function requestImageTranslation(
  payload: TranslateImageRequest,
): Promise<TranslateImageResponse> {
  return sendRuntimeMessage<TranslateImageResponse>({
    type: 'margin:translate-image',
    payload,
  });
}

export function requestImageDataUrlFetch(
  payload: FetchImageDataUrlRequest,
): Promise<FetchImageDataUrlResponse> {
  return sendRuntimeMessage<FetchImageDataUrlResponse>({
    type: 'margin:fetch-image-data-url',
    payload,
  });
}

export function requestProviderTest(
  providerId: string,
): Promise<TranslateBatchResponse> {
  return sendRuntimeMessage<TranslateBatchResponse>({
    type: 'margin:test-provider',
    payload: { providerId },
  });
}

export interface StreamBatchCallbacks {
  onItemReady?: (item: TranslateBatchResponse['items'][number]) => void;
  onDelta?: (delta: string) => void;
}

export function streamBatchTranslation(
  payload: TranslateBatchRequest,
  callbacks: StreamBatchCallbacks = {},
  signal?: AbortSignal,
): Promise<TranslateBatchResponse> {
  if (typeof globalThis.chrome === 'undefined' || !chrome.runtime?.connect) {
    return requestBatchTranslation(payload);
  }

  return new Promise<TranslateBatchResponse>((resolve, reject) => {
    const port = chrome.runtime.connect({ name: BRAND.streamPortName });
    let settled = false;

    const cleanup = () => {
      try {
        port.disconnect();
      } catch {
        // Ignore already-disconnected port
      }
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          if (settled) return;
          settled = true;
          try {
            const msg: TranslateStreamPortMessage = {
              type: 'cancel',
              requestId: payload.requestId,
            };
            port.postMessage(msg);
          } catch {
            // Ignore post after disconnect
          }
          cleanup();
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    }

    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as TranslateStreamPortMessage;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'item-ready' && msg.requestId === payload.requestId) {
        callbacks.onItemReady?.(msg.item);
      } else if (msg.type === 'delta' && msg.requestId === payload.requestId) {
        callbacks.onDelta?.(msg.rawDelta);
      } else if (msg.type === 'done' && msg.response.requestId === payload.requestId) {
        settled = true;
        cleanup();
        resolve(msg.response);
      } else if (msg.type === 'error' && msg.requestId === payload.requestId) {
        settled = true;
        cleanup();
        reject(new Error(msg.error.message));
      }
    });

    port.onDisconnect.addListener(() => {
      if (!settled) {
        settled = true;
        const lastErr = chrome.runtime.lastError?.message;
        reject(new Error(lastErr || 'Translation stream port closed unexpectedly.'));
      }
    });

    const startMsg: TranslateStreamPortMessage = { type: 'start', payload };
    port.postMessage(startMsg);
  });
}

function isMissingReceiverError(message: string): boolean {
  return /Receiving end does not exist|Could not establish connection|message port closed/i.test(
    message,
  );
}

function isRestrictedBrowserPageError(message: string): boolean {
  return /Cannot access|chrome:\/\/|edge:\/\/|about:|chrome-extension:\/\/|extensions gallery|webstore/i.test(
    message,
  );
}

export async function sendTabCommand(
  tabId: number,
  command: AnyTabMessage,
): Promise<TabCommandDispatchResult> {
  if (typeof globalThis.chrome === 'undefined' || !chrome.tabs?.sendMessage) {
    return {
      ok: false,
      error: 'Browser tab messaging is unavailable in this context.',
    };
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, command);
    return { ok: true, result };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    if (isRestrictedBrowserPageError(errMsg)) {
      return {
        ok: false,
        unsupportedPage: true,
        error: errMsg,
      };
    }

    if (isMissingReceiverError(errMsg)) {
      // Passive state read or cache flush on an uninjected tab needs no script injection
      if (command.type === 'margin:cmd:get-page-state') {
        const idleState: TabPageState = {
          active: false,
          inFlightBlocks: 0,
          translatedBlocks: 0,
          maskRevealed: false,
        };
        return { ok: true, result: idleState };
      }
      if (command.type === 'margin:cmd:clear-page-cache') {
        return { ok: true };
      }

      // Actionable user command on a pre-existing tab: dynamically inject content scripts and retry with backoff!
      if (typeof chrome.scripting?.executeScript === 'function') {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js', 'image-translate.js'],
          });
          const retryDelaysMs = [50, 120, 250];
          let lastRetryErr: unknown;
          for (const delayMs of retryDelaysMs) {
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            try {
              const retryResult = await chrome.tabs.sendMessage(tabId, command);
              return { ok: true, autoInjected: true, result: retryResult };
            } catch (retryErr) {
              lastRetryErr = retryErr;
              const retryMsg =
                retryErr instanceof Error ? retryErr.message : String(retryErr);
              if (!isMissingReceiverError(retryMsg)) {
                throw retryErr;
              }
            }
          }
          throw (
            lastRetryErr ??
            new Error('Content script receiver did not respond after injection.')
          );
        } catch (injectErr) {
          const injectMsg =
            injectErr instanceof Error ? injectErr.message : String(injectErr);
          return {
            ok: false,
            unsupportedPage: true,
            error: injectMsg,
          };
        }
      }

      return {
        ok: false,
        unsupportedPage: true,
        error: errMsg,
      };
    }

    return {
      ok: false,
      unsupportedPage: isRestrictedBrowserPageError(errMsg),
      error: errMsg,
    };
  }
}
