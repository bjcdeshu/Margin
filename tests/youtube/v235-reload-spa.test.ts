import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND } from '@shared/brand';
import { createDefaultMarginConfig } from '@shared/constants';
import type { MarginConfig, YoutubeMainBridgeMessage } from '@shared/types';
import {
  bootSubtitleIsolatedEntry,
  createSubtitleIsolatedController,
  ISOLATED_CONTROLLER_KEY,
  NATIVE_YT_HIDE_STYLE_ID,
  OVERLAY_OWNER_ATTR,
  SUBTITLE_OVERLAY_HOST_ID,
} from '../../src/youtube/isolated-entry';
import {
  bootYoutubeMainEntry,
  createYoutubeMainController,
  MAIN_CONTROLLER_KEY,
  SUBTITLE_TOGGLE_BUTTON_ID,
} from '../../src/youtube/main-entry';
import type { PipCapableVideoElement } from '../../src/youtube/pip-player';

function createMockVideo(
  overrides: Partial<PipCapableVideoElement> = {},
): PipCapableVideoElement {
  const video = document.createElement('video') as PipCapableVideoElement;
  video.className = 'html5-main-video';
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'videoWidth', { value: 1920, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 1080, configurable: true });
  Object.defineProperty(video, 'duration', { value: 180, configurable: true });
  video.play = vi.fn().mockResolvedValue(undefined);
  video.pause = vi.fn();
  Object.assign(video, overrides);
  return video;
}

function setHappyUrl(url: string): void {
  const happyWin = window as unknown as {
    happyDOM?: { setURL: (targetUrl: string) => void };
  };
  if (happyWin.happyDOM?.setURL) {
    happyWin.happyDOM.setURL(url);
  } else {
    Object.defineProperty(window, 'location', {
      value: new URL(url),
      configurable: true,
    });
  }
}

function createMockTranslateFn(prefix = '译:') {
  return vi.fn(
    async (req: {
      requestId: string;
      items: Array<{ id: number; text: string }>;
    }) => ({
      ok: true,
      requestId: req.requestId,
      providerId: 'mock',
      model: 'mock',
      items: req.items.map((it) => ({
        id: it.id,
        trans: `${prefix}${it.text}`,
      })),
      diagnostic: {} as never,
    }),
  );
}

describe('v2.3.5 YouTube Reload Resilience, Suppress Leak Prevention & SPA Stash Replay', () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;
  const originalFetch = window.fetch;

  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>)[ISOLATED_CONTROLLER_KEY];
    delete (window as unknown as Record<string, unknown>)[MAIN_CONTROLLER_KEY];
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalChrome === undefined) {
      delete (globalThis as { chrome?: unknown }).chrome;
    } else {
      (globalThis as { chrome?: unknown }).chrome = originalChrome;
    }
    window.fetch = originalFetch;
    delete (window as unknown as Record<string, unknown>)[ISOLATED_CONTROLLER_KEY];
    delete (window as unknown as Record<string, unknown>)[MAIN_CONTROLLER_KEY];
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('never injects #margin-yt-native-caption-suppress before #movie_player exists, and suppresses only after overlay mounts (Fix #1)', async () => {
    setHappyUrl('https://www.youtube.com/watch?v=noPlayerYet01');

    const cfg: MarginConfig = createDefaultMarginConfig();
    const isolated = createSubtitleIsolatedController({
      loadConfig: async () => cfg,
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn(),
    });
    await isolated.start();

    // Deliver cues + playhead tick BEFORE #movie_player is mounted in DOM
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'caption-track-captured',
        videoId: 'noPlayerYet01',
        langCode: 'en',
        trackUrl: 'https://www.youtube.com/api/timedtext?v=noPlayerYet01&lang=en&fmt=json3',
        events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Wait for player' }] }],
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'noPlayerYet01',
        currentTimeMs: 500,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 35));

    // Must NOT hide native captions while overlay host cannot mount!
    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).toBeNull();
    expect(document.getElementById(NATIVE_YT_HIDE_STYLE_ID)).toBeNull();

    // Now mount #movie_player and send next playhead tick -> overlay mounts AND suppress style activates
    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    playerEl.className = 'html5-video-player';
    document.body.appendChild(playerEl);

    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'noPlayerYet01',
        currentTimeMs: 700,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 25));

    const host = document.getElementById(SUBTITLE_OVERLAY_HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.getAttribute(OVERLAY_OWNER_ATTR)).toMatch(/^margin-iso-/);
    expect(document.getElementById(NATIVE_YT_HIDE_STYLE_ID)).not.toBeNull();

    isolated.destroy();
    expect(document.getElementById(NATIVE_YT_HIDE_STYLE_ID)).toBeNull();
  });

  it('removes #margin-yt-native-caption-suppress on contextInvalidated even if ownedOverlayHost detached, while sparing a newer live owner (Fix #1)', async () => {
    setHappyUrl('https://www.youtube.com/watch?v=ctxInvalidVid');

    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    playerEl.className = 'html5-video-player';
    const video = createMockVideo();
    video.currentTime = 0.6;
    playerEl.appendChild(video);
    document.body.appendChild(playerEl);

    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: BRAND.pinnedExtensionId },
    };

    // Orphan suppress style before any cues exist -> cleaned on start()
    const orphanStyle = document.createElement('style');
    orphanStyle.id = NATIVE_YT_HIDE_STYLE_ID;
    document.head.appendChild(orphanStyle);

    const bridgeMessages: unknown[] = [];
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.source === BRAND.ytBridgeSourceIsolated) {
        bridgeMessages.push(ev.data);
      }
    };
    window.addEventListener('message', onMsg);

    const ctrlOld = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn(),
    });
    await ctrlOld.start();

    // Orphan style must have been swept immediately on start()!
    expect(document.getElementById(NATIVE_YT_HIDE_STYLE_ID)).toBeNull();

    // Render active cue on ctrlOld
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'caption-track-captured',
        videoId: 'ctxInvalidVid',
        langCode: 'en',
        trackUrl: 'https://www.youtube.com/api/timedtext?v=ctxInvalidVid&lang=en&fmt=json3',
        events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Old instance cue' }] }],
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'ctxInvalidVid',
        currentTimeMs: 600,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 35));

    const hostOld = document.getElementById(SUBTITLE_OVERLAY_HOST_ID);
    expect(hostOld).not.toBeNull();
    expect(document.getElementById(NATIVE_YT_HIDE_STYLE_ID)).not.toBeNull();

    // Simulate YouTube detaching #margin-subtitle-overlay-host during player rebuild BEFORE extension invalidation!
    hostOld?.remove();
    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).toBeNull();
    expect(document.getElementById(NATIVE_YT_HIDE_STYLE_ID)).not.toBeNull();

    // Invalidate extension context -> next bridge message triggers destroy({ contextInvalidated: true })
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: undefined } };
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'ctxInvalidVid',
        currentTimeMs: 800,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 25));

    // Suppress style MUST be deleted even though existingHost !== ownedOverlayHost!
    expect(document.getElementById(NATIVE_YT_HIDE_STYLE_ID)).toBeNull();
    expect(
      bridgeMessages.some(
        (m) =>
          (m as { type?: string }).type === 'isolated-context-invalidated',
      ),
    ).toBe(true);

    // Subcase B: When a newer live instance owns the mounted host, old invalidated teardown MUST spare it!
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: BRAND.pinnedExtensionId },
    };
    const ctrlA = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn('A:'),
    });
    await ctrlA.start();

    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'caption-track-captured',
        videoId: 'ctxInvalidVid',
        langCode: 'en',
        trackUrl: 'https://www.youtube.com/api/timedtext?v=ctxInvalidVid&lang=en&fmt=json3',
        events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Shared cue' }] }],
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'ctxInvalidVid',
        currentTimeMs: 600,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 35));
    const ownerA = document
      .getElementById(SUBTITLE_OVERLAY_HOST_ID)
      ?.getAttribute(OVERLAY_OWNER_ATTR);
    expect(ownerA).toBeTruthy();

    // New instance ctrlB mounts and takes ownership before ctrlA notices context invalidation
    const ctrlB = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn('B:'),
    });
    await ctrlB.start();
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'caption-track-captured',
        videoId: 'ctxInvalidVid',
        langCode: 'en',
        trackUrl: 'https://www.youtube.com/api/timedtext?v=ctxInvalidVid&lang=en&fmt=json3',
        events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Shared cue' }] }],
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'ctxInvalidVid',
        currentTimeMs: 700,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 35));

    const ownerB = document
      .getElementById(SUBTITLE_OVERLAY_HOST_ID)
      ?.getAttribute(OVERLAY_OWNER_ATTR);
    expect(ownerB).toBeTruthy();
    expect(ownerB).not.toBe(ownerA);

    // Stop ctrlB from listening to the next message so ONLY ctrlA processes invalidation
    ctrlB.destroy();
    // Re-mount a simulated new live instance C via bootSubtitleIsolatedEntry (also tests same-world replacement)
    const ctrlC1 = bootSubtitleIsolatedEntry(window, {
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn('C1:'),
    });
    const destroyC1Spy = vi.spyOn(ctrlC1, 'destroy');
    const ctrlC2 = bootSubtitleIsolatedEntry(window, {
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn('C2:'),
    });
    expect(destroyC1Spy).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 20));

    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'caption-track-captured',
        videoId: 'ctxInvalidVid',
        langCode: 'en',
        trackUrl: 'https://www.youtube.com/api/timedtext?v=ctxInvalidVid&lang=en&fmt=json3',
        events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Live C2 cue' }] }],
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'ctxInvalidVid',
        currentTimeMs: 750,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 35));
    const ownerC2 = document
      .getElementById(SUBTITLE_OVERLAY_HOST_ID)
      ?.getAttribute(OVERLAY_OWNER_ATTR);
    expect(ownerC2).toBeTruthy();

    // Simulate ctrlA invalidating while C2's host is mounted in DOM (detach C2's listener first by pausing runtime invalidation only for ctrlA via fullscreenchange)
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: undefined } };
    // Temporarily protect C2 from the same mock global chrome invalidation by spoofing C2's owner on DOM and destroying ctrlA via fullscreenchange:
    // Note both ctrlA and ctrlC2 share globalThis.chrome in single-realm Vitest, so place an external live owner marker to verify ctrlA's guard directly:
    const externalLiveHost = document.getElementById(SUBTITLE_OVERLAY_HOST_ID)!;
    externalLiveHost.setAttribute(OVERLAY_OWNER_ATTR, 'margin-iso-external-live-999');
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).toBe(externalLiveHost);
    expect(document.getElementById(NATIVE_YT_HIDE_STYLE_ID)).not.toBeNull();

    ctrlC2.destroy();
    ctrlA.destroy();
    window.removeEventListener('message', onMsg);
  });

  it('stashes early SPA timedtext responses before URL updates and replays them immediately once active video switches (Fix #2)', async () => {
    setHappyUrl('https://www.youtube.com/watch?v=initialVidA');

    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    playerEl.className = 'html5-video-player';
    const rightControls = document.createElement('div');
    rightControls.className = 'ytp-right-controls';
    const video = createMockVideo();
    video.currentTime = 0.5;
    playerEl.append(video, rightControls);
    document.body.appendChild(playerEl);

    window.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('v=KYHx0DI6mSo')) {
        return new Response(
          JSON.stringify({
            events: [
              {
                tStartMs: 0,
                dDurationMs: 3500,
                segs: [{ utf8: '<b>Breaking</b> SPA barriers' }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          events: [{ tStartMs: 0, dDurationMs: 3500, segs: [{ utf8: 'Initial video A' }] }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const mainCtrl = createYoutubeMainController();
    const isolatedCtrl = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn('中文:'),
    });

    mainCtrl.start();
    await isolatedCtrl.start();
    await new Promise((r) => setTimeout(r, 25));

    // Load initialVidA first
    await window.fetch(
      'https://www.youtube.com/api/timedtext?v=initialVidA&lang=en&fmt=json3',
    );
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'initialVidA',
        currentTimeMs: 400,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 35));
    expect(isolatedCtrl.getCues()[0]?.text).toBe('Initial video A');

    // CRITICAL RACE: YouTube fetches next video `KYHx0DI6mSo` timedtext BEFORE history.pushState updates window.location!
    await window.fetch(
      'https://www.youtube.com/api/timedtext?v=KYHx0DI6mSo&lang=en&pot=earlyPotToken&fmt=json3',
    );
    await new Promise((r) => setTimeout(r, 25));

    // While URL is still initialVidA, current cues stay on initialVidA (not clobbered prematurely)
    expect(isolatedCtrl.getCues()[0]?.text).toBe('Initial video A');
    // Snapshot already includes stashed KYHx0DI6mSo!
    expect(
      mainCtrl
        .getCapturedTracksSnapshot()
        .some((rec) => rec.videoId === 'KYHx0DI6mSo'),
    ).toBe(true);

    // Also test ISOLATED-side stashing when caption-track-captured arrives before page URL updates
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'caption-track-captured',
        videoId: 'thirdSpaVid',
        langCode: 'en',
        trackUrl: 'https://www.youtube.com/api/timedtext?v=thirdSpaVid&lang=en&fmt=json3',
        events: [{ tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: '<i>Third</i> SPA cue' }] }],
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    expect(isolatedCtrl.getCues()[0]?.text).toBe('Initial video A');

    // Now URL updates to KYHx0DI6mSo and yt-navigate-finish fires -> MAIN promotes stashed track & replays!
    setHappyUrl('https://www.youtube.com/watch?v=KYHx0DI6mSo');
    window.dispatchEvent(new Event('yt-navigate-finish'));
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'KYHx0DI6mSo',
        currentTimeMs: 500,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 40));

    expect(isolatedCtrl.getCues()[0]).toMatchObject({
      text: 'Breaking SPA barriers',
      trans: '中文:Breaking SPA barriers',
    });
    const overlayHost = document.getElementById(SUBTITLE_OVERLAY_HOST_ID);
    expect(
      overlayHost?.shadowRoot?.getElementById('margin-sub-original')?.textContent,
    ).toBe('Breaking SPA barriers');
    expect(
      overlayHost?.shadowRoot?.getElementById('margin-sub-translated')?.textContent,
    ).toBe('中文:Breaking SPA barriers');

    // Now switch URL to thirdSpaVid -> ISOLATED drains its stashed capture on playhead-tick!
    setHappyUrl('https://www.youtube.com/watch?v=thirdSpaVid');
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'thirdSpaVid',
        currentTimeMs: 300,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(isolatedCtrl.getCues()[0]).toMatchObject({
      text: 'Third SPA cue',
      trans: '中文:Third SPA cue',
    });

    isolatedCtrl.destroy();
    mainCtrl.destroy();
  });

  it('recovers signed pot= timedtext URLs from PerformanceResourceTiming and falls back to moviePlayer.getOption("captions", "track") (Fix #2)', async () => {
    // Subcase A: PerformanceResourceTiming with `pot=` token
    setHappyUrl('https://www.youtube.com/watch?v=potRecoveryVid');

    const signedPotUrl =
      'https://www.youtube.com/api/timedtext?v=potRecoveryVid&lang=en&kind=asr&expire=1999999999&signature=SIG123&pot=MnSignedPotToken_XYZ&fmt=json3';
    const translatedTlangUrl =
      'https://www.youtube.com/api/timedtext?v=potRecoveryVid&lang=en&tlang=fr&pot=MnSignedPotToken_XYZ&fmt=json3';

    const getEntriesSpy = vi
      .spyOn(window.performance, 'getEntriesByType')
      .mockReturnValue([
        { name: 'https://www.youtube.com/api/timedtext?v=olderVid&lang=en&pot=OLD&fmt=json3' },
        { name: signedPotUrl },
        { name: translatedTlangUrl }, // must skip tlang entries!
      ] as unknown as PerformanceEntryList);

    const unhookedFetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === signedPotUrl && init?.credentials === 'include') {
        return new Response(
          JSON.stringify({
            events: [
              { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Recovered with POT' }] },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('', { status: 200 });
    });
    window.fetch = unhookedFetchSpy as unknown as typeof fetch;

    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    playerEl.className = 'html5-video-player';
    const rightControls = document.createElement('div');
    rightControls.className = 'ytp-right-controls';
    const video = createMockVideo({ currentTime: 0.4 });
    playerEl.append(video, rightControls);
    document.body.appendChild(playerEl);

    const mainA = createYoutubeMainController();
    const isoA = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn('POT译:'),
    });

    mainA.start();
    await isoA.start();
    await new Promise((r) => setTimeout(r, 45));

    expect(unhookedFetchSpy).toHaveBeenCalledWith(signedPotUrl, {
      credentials: 'include',
    });
    expect(isoA.getCues()[0]).toMatchObject({
      text: 'Recovered with POT',
      trans: 'POT译:Recovered with POT',
    });

    isoA.destroy();
    mainA.destroy();

    // Subcase B: Empty PerformanceResourceTiming -> falls back to playerResponse matching active `getOption('captions', 'track')`
    getEntriesSpy.mockReturnValue([]);
    setHappyUrl('https://www.youtube.com/watch?v=optionTrackVid');

    const requestedUrls: string[] = [];
    window.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(
        JSON.stringify({
          events: [{ tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'Selected EN CC' }] }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    Object.assign(playerEl, {
      getOption: (mod: string, opt: string) =>
        mod === 'captions' && opt === 'track'
          ? { vss_id: '.en', languageCode: 'en' }
          : null,
      getPlayerResponse: () => ({
        videoDetails: { videoId: 'optionTrackVid' },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: 'https://www.youtube.com/api/timedtext?v=optionTrackVid&lang=fr&vss_id=.fr',
                languageCode: 'fr',
                vssId: '.fr',
              },
              {
                baseUrl: 'https://www.youtube.com/api/timedtext?v=optionTrackVid&lang=en&kind=asr&vss_id=a.en',
                languageCode: 'en',
                kind: 'asr',
                vssId: 'a.en',
              },
              {
                baseUrl: 'https://www.youtube.com/api/timedtext?v=optionTrackVid&lang=en&vss_id=.en',
                languageCode: 'en',
                vssId: '.en',
              },
            ],
          },
        },
      }),
    });

    const mainB = createYoutubeMainController();
    const isoB = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn('选轨:'),
    });
    mainB.start();
    await isoB.start();
    await new Promise((r) => setTimeout(r, 45));

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('vss_id=.en');
    expect(requestedUrls[0]).not.toContain('vss_id=.fr');
    expect(isoB.getCues()[0]?.text).toBe('Selected EN CC');

    isoB.destroy();
    mainB.destroy();
    getEntriesSpy.mockRestore();
  });

  it('deactivates zombie player button on isolated-context-invalidated while preserving captured tracks across MAIN hot-replacement (Fix #3)', async () => {
    setHappyUrl('https://www.youtube.com/watch?v=hotSwapVid');

    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    playerEl.className = 'html5-video-player';
    const rightControls = document.createElement('div');
    rightControls.className = 'ytp-right-controls';
    const video = createMockVideo({ currentTime: 0.5 });
    playerEl.append(video, rightControls);
    document.body.appendChild(playerEl);

    let networkFetchCount = 0;
    const baseFetch = vi.fn(async () => {
      networkFetchCount += 1;
      return new Response(
        JSON.stringify({
          events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Hot swap survives' }] }],
        }),
        { status: 200 },
      );
    });
    window.fetch = baseFetch as unknown as typeof fetch;

    const mainV1 = bootYoutubeMainEntry(window);
    const destroyV1Spy = vi.spyOn(mainV1, 'destroy');
    const isoV1 = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn('V1:'),
    });
    await isoV1.start();
    await new Promise((r) => setTimeout(r, 25));

    // Capture timedtext once under V1
    await window.fetch(
      'https://www.youtube.com/api/timedtext?v=hotSwapVid&lang=en&fmt=json3',
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(networkFetchCount).toBe(1);

    const subBtnBefore = document.getElementById(
      SUBTITLE_TOGGLE_BUTTON_ID,
    ) as HTMLButtonElement;
    expect(subBtnBefore.getAttribute('aria-pressed')).toBe('true');

    // Destroy old ISOLATED world -> sends `isolated-context-invalidated` -> button turns inactive, tracks kept!
    isoV1.destroy();
    await new Promise((r) => setTimeout(r, 20));
    expect(subBtnBefore.getAttribute('aria-pressed')).toBe('false');
    expect(mainV1.getCapturedTracksSnapshot()).toHaveLength(1);

    // Clicking zombie button while invalidated (before new ISOLATED connects) MUST NOT flip red; emits main-controller-ready instead!
    const readyPings: unknown[] = [];
    const onMainReady = (ev: MessageEvent) => {
      if (
        ev.data?.source === BRAND.ytBridgeSourceMain &&
        ev.data?.type === 'main-controller-ready'
      ) {
        readyPings.push(ev.data);
      }
    };
    window.addEventListener('message', onMainReady);
    subBtnBefore.click();
    await new Promise((r) => setTimeout(r, 15));
    expect(subBtnBefore.getAttribute('aria-pressed')).toBe('false');
    expect(readyPings.length).toBeGreaterThanOrEqual(1);
    window.removeEventListener('message', onMainReady);

    // Hot re-inject `youtube-main.js` (`bootYoutubeMainEntry`) -> destroys mainV1, restores baseFetch, inherits snapshot!
    const mainV2 = bootYoutubeMainEntry(window);
    expect(destroyV1Spy).toHaveBeenCalledTimes(1);
    expect(mainV2).not.toBe(mainV1);
    expect(mainV2.getCapturedTracksSnapshot()).toHaveLength(1);

    // New ISOLATED world boots -> handshakes with mainV2 -> button re-activates & replays inherited track with 0 extra fetches!
    const isoV2 = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn('V2:'),
    });
    await isoV2.start();
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceMain,
        type: 'playhead-tick',
        videoId: 'hotSwapVid',
        currentTimeMs: 500,
        paused: false,
      } satisfies YoutubeMainBridgeMessage,
      '*',
    );
    await new Promise((r) => setTimeout(r, 40));

    expect(networkFetchCount).toBe(1);
    const subBtnAfter = document.getElementById(
      SUBTITLE_TOGGLE_BUTTON_ID,
    ) as HTMLButtonElement;
    expect(subBtnAfter.getAttribute('aria-pressed')).toBe('true');
    expect(isoV2.getCues()[0]).toMatchObject({
      text: 'Hot swap survives',
      trans: 'V2:Hot swap survives',
    });

    isoV2.destroy();
    mainV2.destroy();
    expect(window.fetch).toBe(baseFetch);
  });

  it('keeps live bootSubtitleIsolatedEntry(window) idempotent, prefers pot= over newer unsigned perf entries, bounds dead perf retries, and guards storage/menu invalidation', async () => {
    // 1. Same-world live re-injection without options returns existing controller idempotently
    setHappyUrl('https://www.youtube.com/watch?v=idemPotVid');
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: BRAND.pinnedExtensionId },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    };

    const firstLive = bootSubtitleIsolatedEntry(window);
    const firstDestroySpy = vi.spyOn(firstLive, 'destroy');
    const secondLive = bootSubtitleIsolatedEntry(window);
    expect(secondLive).toBe(firstLive);
    expect(firstDestroySpy).not.toHaveBeenCalled();

    // Context invalidation via storage event triggers clean destroy({ contextInvalidated: true })
    await new Promise((r) => setTimeout(r, 20));
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: undefined } };
    window.dispatchEvent(new StorageEvent('storage', { key: 'yt-player-caption-display-settings' }));
    expect(firstLive.isDestroyed?.()).toBe(true);

    // Also verify handlePlayerMenuInteraction context-invalidation guard
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: BRAND.pinnedExtensionId },
    };
    const menuGuardCtrl = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: createMockTranslateFn(),
    });
    await menuGuardCtrl.start();
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: undefined } };
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(menuGuardCtrl.isDestroyed?.()).toBe(true);

    // 2. PerformanceResourceTiming prefers signed `pot=` entry even if a newer unsigned entry exists later,
    //    and bounds retries when both perf URL and playerResponse fail/have no tracks!
    const signedPotUrl =
      'https://www.youtube.com/api/timedtext?v=idemPotVid&lang=en&pot=SignedPotPreferred123&fmt=json3';
    const newerUnsignedUrl =
      'https://www.youtube.com/api/timedtext?v=idemPotVid&lang=en&fmt=json3';

    const perfSpy = vi
      .spyOn(window.performance, 'getEntriesByType')
      .mockReturnValue([
        { name: signedPotUrl },
        { name: newerUnsignedUrl }, // newer unsigned entry MUST NOT shadow signedPotUrl!
      ] as unknown as PerformanceEntryList);

    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    playerEl.className = 'html5-video-player';
    Object.assign(playerEl, {
      getPlayerResponse: () => ({
        videoDetails: { videoId: 'idemPotVid' },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [], // trackless video fallback
          },
        },
      }),
    });
    document.body.appendChild(playerEl);

    const fetchedPerfUrls: string[] = [];
    window.fetch = vi.fn(async (input: RequestInfo | URL) => {
      fetchedPerfUrls.push(String(input));
      // Simulate non-empty `{}` response with 0 events to verify handleCapturedTimedText boolean fallback & retry bounding!
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const mainBounded = createYoutubeMainController();
    mainBounded.start();
    await new Promise((r) => setTimeout(r, 30));

    // Must have chosen signedPotUrl (NOT newerUnsignedUrl)
    expect(fetchedPerfUrls).toEqual([signedPotUrl]);

    // Repeated `request-active-captions` / `refresh()` for the same video MUST NOT loop dead perf URLs!
    window.postMessage(
      {
        source: BRAND.ytBridgeSourceIsolated,
        type: 'request-active-captions',
        videoId: 'idemPotVid',
      },
      '*',
    );
    mainBounded.refresh();
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchedPerfUrls).toHaveLength(1);

    mainBounded.destroy();
    perfSpy.mockRestore();
  });
});
