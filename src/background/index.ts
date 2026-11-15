import { BRAND } from '@shared/brand';
import { isYoutubeTabUrl } from '@shared/messaging';
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

const DEFAULT_REINJECT_PROBE_TIMEOUT_MS = 250;
const DEFAULT_REINJECT_SCRIPT_TIMEOUT_MS = 2500;

export interface ReinjectOpenTabsOptions {
  probeTimeoutMs?: number;
  scriptTimeoutMs?: number;
}

function withReinjectTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Reinject operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

async function isTabContentScriptAlive(
  tabId: number,
  timeoutMs: number,
): Promise<boolean> {
  if (typeof chrome.tabs?.sendMessage !== 'function') {
    return false;
  }
  try {
    const resp = await withReinjectTimeout(
      Promise.resolve().then(() =>
        chrome.tabs.sendMessage(tabId, {
          type: 'margin:cmd:get-page-state',
        }),
      ),
      timeoutMs,
    );
    return Boolean(
      resp &&
        typeof resp === 'object' &&
        typeof (resp as { active?: unknown }).active === 'boolean',
    );
  } catch {
    return false;
  }
}

export async function reinjectContentScriptsIntoOpenTabs(
  options: ReinjectOpenTabsOptions = {},
): Promise<void> {
  if (
    typeof globalThis.chrome === 'undefined' ||
    typeof chrome.tabs?.query !== 'function' ||
    typeof chrome.scripting?.executeScript !== 'function'
  ) {
    return;
  }

  const probeTimeoutMs =
    options.probeTimeoutMs ?? DEFAULT_REINJECT_PROBE_TIMEOUT_MS;
  const scriptTimeoutMs =
    options.scriptTimeoutMs ?? DEFAULT_REINJECT_SCRIPT_TIMEOUT_MS;

  let openTabs: chrome.tabs.Tab[] = [];
  try {
    openTabs = await chrome.tabs.query({
      url: ['http://*/*', 'https://*/*'],
    });
  } catch {
    return;
  }

  const eligibleTabs = openTabs.filter(
    (tab): tab is chrome.tabs.Tab & { id: number } =>
      typeof tab?.id === 'number' &&
      !tab.discarded &&
      (tab.status as string | undefined) !== 'unloaded',
  );

  await Promise.allSettled(
    eligibleTabs.map(async (tab) => {
      const tabId = tab.id;
      try {
        if (await isTabContentScriptAlive(tabId, probeTimeoutMs)) {
          return;
        }
        await withReinjectTimeout(
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js', 'subtitles.js', 'image-translate.js'],
            injectImmediately: true,
          }),
          scriptTimeoutMs,
        );
        if (isYoutubeTabUrl(tab.url)) {
          await withReinjectTimeout(
            chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              files: ['youtube-main.js'],
              injectImmediately: true,
            }),
            scriptTimeoutMs,
          );
        }
      } catch {
        // Ignore restricted, discarded, hung, or concurrently closed tabs
      }
    }),
  );
}

export function initializeBackgroundServiceWorker(): void {
  if (listenersInitialized || typeof globalThis.chrome === 'undefined') {
    return;
  }
  listenersInitialized = true;

  void sweepOrphanedDnrSessionRules();

  if (chrome.runtime?.onInstalled) {
    chrome.runtime.onInstalled.addListener(
      (details?: chrome.runtime.InstalledDetails) => {
        void getMarginConfig();
        void sweepOrphanedDnrSessionRules();
        registerContextMenus();
        if (
          !details?.reason ||
          details.reason === 'install' ||
          details.reason === 'update'
        ) {
          void reinjectContentScriptsIntoOpenTabs();
        }
        console.info(
          `[${BRAND.name}] Service worker initialized (${BRAND.version})`,
        );
      },
    );
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
