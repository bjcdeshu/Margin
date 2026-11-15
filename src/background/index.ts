import { BRAND } from '@shared/brand';
import { getMarginConfig } from '@shared/storage';
import { sweepOrphanedDnrSessionRules } from './dnr-image';
import {
  attachStreamTranslationPort,
  dispatchShortcutCommand,
  handleContextMenuClicked,
  handleRuntimeRpcRequest,
  isRuntimeRpcRequest,
  registerContextMenus,
} from './router';

export * from './translation-db';
export * from './cache';
export * from './vision';
export * from './dnr-image';
export * from './router';

let listenersInitialized = false;

export function isUntrustedExternalSender(
  sender?: chrome.runtime.MessageSender,
): boolean {
  const runtimeId =
    typeof globalThis.chrome !== 'undefined'
      ? globalThis.chrome?.runtime?.id
      : undefined;
  if (!runtimeId) {
    return false;
  }
  if (sender?.id && sender.id !== runtimeId) {
    return true;
  }
  if (
    sender &&
    !sender.id &&
    typeof sender.origin === 'string' &&
    sender.origin !== '' &&
    !sender.origin.startsWith(`chrome-extension://${runtimeId}`)
  ) {
    return true;
  }
  return false;
}

export function resetBackgroundServiceWorkerForTests(): void {
  listenersInitialized = false;
}

export function initializeBackgroundServiceWorker(): void {
  if (listenersInitialized || typeof globalThis.chrome === 'undefined') {
    return;
  }
  listenersInitialized = true;

  void sweepOrphanedDnrSessionRules();

  if (chrome.runtime?.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
      void getMarginConfig();
      void sweepOrphanedDnrSessionRules();
      registerContextMenus();
      console.info(
        `[${BRAND.name}] Service worker initialized (${BRAND.version})`,
      );
    });
  }

  if (chrome.runtime?.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
      void sweepOrphanedDnrSessionRules();
      registerContextMenus();
    });
  }

  if (chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (isUntrustedExternalSender(sender)) {
        return false;
      }
      if (!isRuntimeRpcRequest(message)) {
        return false;
      }
      handleRuntimeRpcRequest(message)
        .then((response) => {
          sendResponse(response);
        })
        .catch((err: unknown) => {
          const fallbackMsg =
            err instanceof Error
              ? err.message
              : 'Unhandled background RPC error.';
          sendResponse({
            ok: false,
            error: fallbackMsg,
          });
        });
      // Keep MV3 message channel open for async `sendResponse`
      return true;
    });
  }

  if (chrome.runtime?.onConnect) {
    chrome.runtime.onConnect.addListener((port) => {
      if (isUntrustedExternalSender(port.sender)) {
        try {
          port.disconnect();
        } catch {
          // Ignore disconnect errors on untrusted ports
        }
        return;
      }
      attachStreamTranslationPort(port);
    });
  }

  if (chrome.commands?.onCommand) {
    chrome.commands.onCommand.addListener((command, tab) => {
      void dispatchShortcutCommand(command, tab);
    });
  }

  if (chrome.contextMenus?.onClicked) {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      void handleContextMenuClicked(info, tab);
    });
  }
}

initializeBackgroundServiceWorker();
