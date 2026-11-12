import { BRAND } from '@shared/brand';
import { getMarginConfig } from '@shared/storage';
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

export function initializeBackgroundServiceWorker(): void {
  if (listenersInitialized || typeof globalThis.chrome === 'undefined') {
    return;
  }
  listenersInitialized = true;

  if (chrome.runtime?.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
      void getMarginConfig();
      registerContextMenus();
      console.info(`[${BRAND.name}] Service worker initialized (${BRAND.version})`);
    });
  }

  if (chrome.runtime?.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
      registerContextMenus();
    });
  }

  if (chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
