import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeBackgroundServiceWorker,
  reinjectContentScriptsIntoOpenTabs,
  resetBackgroundServiceWorkerForTests,
} from '../../src/background';

describe('MV3 onInstalled Open-Tab Content Script Re-Injection (v2.3.5 Fix #4)', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    resetBackgroundServiceWorkerForTests();
  });

  afterEach(() => {
    resetBackgroundServiceWorkerForTests();
    globalThis.chrome = originalChrome;
  });

  it('re-injects ISOLATED scripts into open web tabs and MAIN youtube-main.js into YouTube tabs while skipping discarded/unloaded/restricted tabs', async () => {
    const installedListeners: Array<
      (details?: chrome.runtime.InstalledDetails) => void
    > = [];
    const executeScriptCalls: Array<{
      target: { tabId: number };
      files?: string[];
      world?: string;
      injectImmediately?: boolean;
    }> = [];

    const querySpy = vi.fn(async () => [
      {
        id: 101,
        url: 'https://news.ycombinator.com/item?id=1',
        discarded: false,
        status: 'complete',
      },
      {
        id: 102,
        url: 'https://www.youtube.com/watch?v=KYHx0DI6mSo',
        discarded: false,
        status: 'complete',
      },
      {
        id: 103,
        url: 'https://chromewebstore.google.com/detail/xyz',
        discarded: false,
        status: 'complete',
      },
      {
        id: 104,
        url: 'https://m.youtube.com/watch?v=mobileVid',
        discarded: true,
        status: 'complete',
      },
      {
        id: 105,
        url: 'https://music.youtube.com/watch?v=musicVid',
        discarded: false,
        status: 'complete',
      },
      {
        id: 106,
        url: 'https://www.youtube.com/watch?v=lazyRestoredTab',
        discarded: false,
        status: 'unloaded',
      },
    ]);

    const executeScriptSpy = vi.fn(
      async (opts: {
        target: { tabId: number };
        files?: string[];
        world?: string;
        injectImmediately?: boolean;
      }) => {
        if (opts.target.tabId === 103) {
          throw new Error('Cannot access contents of the extensions gallery');
        }
        executeScriptCalls.push(opts);
        return [];
      },
    );

    globalThis.chrome = {
      runtime: {
        id: 'gdkbmfndollgfmblnielgfdpeoabekbf',
        onInstalled: {
          addListener: (
            cb: (details?: chrome.runtime.InstalledDetails) => void,
          ) => {
            installedListeners.push(cb);
          },
        },
      },
      tabs: {
        query: querySpy,
      },
      scripting: {
        executeScript: executeScriptSpy,
      },
      contextMenus: {
        removeAll: (cb?: () => void) => cb?.(),
        create: vi.fn(),
      },
    } as unknown as typeof chrome;

    initializeBackgroundServiceWorker();
    expect(installedListeners).toHaveLength(1);

    // Fire onInstalled listener (supports undefined details as well as install/update)
    installedListeners[0]!();
    await new Promise((r) => setTimeout(r, 40));

    expect(querySpy).toHaveBeenCalledWith({
      url: ['http://*/*', 'https://*/*'],
    });

    // Tab 101 (HN): ISOLATED only
    // Tab 102 (www.youtube.com): ISOLATED + MAIN youtube-main.js
    // Tab 103 (Web Store): threw restricted error -> caught & ignored
    // Tab 104 (discarded YouTube): skipped
    // Tab 105 (music.youtube.com): ISOLATED + MAIN youtube-main.js
    // Tab 106 (status === 'unloaded'): skipped
    expect(executeScriptCalls).toEqual([
      {
        target: { tabId: 101 },
        files: ['content.js', 'subtitles.js', 'image-translate.js'],
        injectImmediately: true,
      },
      {
        target: { tabId: 102 },
        files: ['content.js', 'subtitles.js', 'image-translate.js'],
        injectImmediately: true,
      },
      {
        target: { tabId: 105 },
        files: ['content.js', 'subtitles.js', 'image-translate.js'],
        injectImmediately: true,
      },
      {
        target: { tabId: 102 },
        world: 'MAIN',
        files: ['youtube-main.js'],
        injectImmediately: true,
      },
      {
        target: { tabId: 105 },
        world: 'MAIN',
        files: ['youtube-main.js'],
        injectImmediately: true,
      },
    ]);

    // Direct call when tabs.query rejects must also swallow safely
    querySpy.mockRejectedValueOnce(new Error('Tabs API unavailable'));
    await expect(reinjectContentScriptsIntoOpenTabs()).resolves.toBeUndefined();
  });

  it('skips reinjection on chrome_update / shared_module_update while firing on install / update', async () => {
    const installedListeners: Array<
      (details?: chrome.runtime.InstalledDetails) => void
    > = [];
    const querySpy = vi.fn(async () => []);

    globalThis.chrome = {
      runtime: {
        id: 'gdkbmfndollgfmblnielgfdpeoabekbf',
        onInstalled: {
          addListener: (
            cb: (details?: chrome.runtime.InstalledDetails) => void,
          ) => {
            installedListeners.push(cb);
          },
        },
      },
      tabs: {
        query: querySpy,
      },
      scripting: {
        executeScript: vi.fn(async () => []),
      },
      contextMenus: {
        removeAll: (cb?: () => void) => cb?.(),
        create: vi.fn(),
      },
    } as unknown as typeof chrome;

    initializeBackgroundServiceWorker();

    installedListeners[0]!({
      reason: 'chrome_update' as chrome.runtime.OnInstalledReason,
    });
    installedListeners[0]!({
      reason: 'shared_module_update' as chrome.runtime.OnInstalledReason,
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(querySpy).not.toHaveBeenCalled();

    installedListeners[0]!({
      reason: 'update' as chrome.runtime.OnInstalledReason,
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(querySpy).toHaveBeenCalledTimes(1);

    installedListeners[0]!({
      reason: 'install' as chrome.runtime.OnInstalledReason,
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  it('skips healthy tabs responding with TabPageState to liveness probe and does not let a hung executeScript on Tab 1 block Tab 2', async () => {
    const injectedTabWorlds: string[] = [];

    const querySpy = vi.fn(async () => [
      {
        id: 201,
        url: 'https://slow-hanging-site.example.com/',
        discarded: false,
        status: 'loading',
      },
      {
        id: 202,
        url: 'https://www.youtube.com/watch?v=liveTarget',
        discarded: false,
        status: 'complete',
      },
      {
        id: 203,
        url: 'https://www.youtube.com/watch?v=alreadyHealthy',
        discarded: false,
        status: 'complete',
      },
    ]);

    const sendMessageSpy = vi.fn(async (tabId: number) => {
      if (tabId === 203) {
        return {
          active: false,
          inFlightBlocks: 0,
          translatedBlocks: 0,
          maskRevealed: false,
        };
      }
      if (tabId === 201) {
        // Simulate hung probe on Tab 201 -> times out via probeTimeoutMs without blocking
        return new Promise<never>(() => {});
      }
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });

    const executeScriptSpy = vi.fn(
      (opts: { target: { tabId: number }; world?: string }) => {
        if (opts.target.tabId === 201) {
          // Simulate hung executeScript on Tab 201 -> never resolves!
          return new Promise<never>(() => {});
        }
        injectedTabWorlds.push(
          `${opts.target.tabId}:${opts.world ?? 'ISOLATED'}`,
        );
        return Promise.resolve([]);
      },
    );

    globalThis.chrome = {
      runtime: { id: 'gdkbmfndollgfmblnielgfdpeoabekbf' },
      tabs: {
        query: querySpy,
        sendMessage: sendMessageSpy,
      },
      scripting: {
        executeScript: executeScriptSpy,
      },
    } as unknown as typeof chrome;

    const reinjectPromise = reinjectContentScriptsIntoOpenTabs({
      probeTimeoutMs: 25,
      scriptTimeoutMs: 60,
    });

    // Tab 202 MUST be injected immediately (~5ms) while Tab 201 is still hung!
    await new Promise((r) => setTimeout(r, 15));
    expect(injectedTabWorlds).toEqual(['202:ISOLATED', '202:MAIN']);

    // And the overall reinjectPromise settles cleanly once scriptTimeoutMs expires
    await expect(reinjectPromise).resolves.toBeUndefined();
    // Healthy Tab 203 was never re-injected
    expect(
      injectedTabWorlds.some((entry) => entry.startsWith('203:')),
    ).toBe(false);
  });
});
