import { BRAND } from './brand';
import type {
  FetchImageDataUrlRequest,
  FetchImageDataUrlResponse,
  RuntimeRpcRequest,
  TabCommandMessage,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateImageRequest,
  TranslateImageResponse,
  TranslateStreamPortMessage,
} from './types';

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

export async function sendTabCommand(
  tabId: number,
  command: TabCommandMessage,
): Promise<void> {
  if (typeof globalThis.chrome === 'undefined' || !chrome.tabs?.sendMessage) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, command);
  } catch {
    // Ignore tabs without content script (e.g. chrome:// pages)
  }
}
