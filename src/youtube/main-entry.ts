import { BRAND } from '@shared/brand';
import type {
  SubtitleSettings,
  YoutubeMainBridgeMessage,
  YoutubeRawJson3Event,
} from '@shared/types';
import { YoutubePipPlayer, type PipCapableVideoElement } from './pip-player';
import {
  extractYoutubeVideoId,
  isTimedTextUrl,
  PIP_BUTTON_ID,
  SUBTITLE_TOGGLE_BUTTON_ID,
  type YoutubeExtendedBridgeMessage,
} from './shared';
import { parseYoutubeTimedTextPayload } from './timeline';

export {
  extractYoutubeVideoId,
  isTimedTextUrl,
  SUBTITLE_TOGGLE_BUTTON_ID,
  type YoutubeExtendedBridgeMessage,
};

const MAIN_CONTROLLER_KEY = '__marginYoutubeMainControllerV2__';

interface CapturedTrackRecord {
  videoId: string;
  langCode: string;
  trackUrl: string;
  events: YoutubeRawJson3Event[];
}

function extractLangFromTimedTextUrl(trackUrl: string): string {
  try {
    const parsed = new URL(trackUrl, 'https://www.youtube.com');
    return (
      parsed.searchParams.get('tlang') ||
      parsed.searchParams.get('lang') ||
      'auto'
    );
  } catch {
    return 'auto';
  }
}

export interface YoutubeMainController {
  start(): void;
  refresh(): void;
  destroy(): void;
  getPipPlayer(): YoutubePipPlayer;
}

export interface YoutubeMainControllerOptions {
  hostWindow?: Window;
  hostDocument?: Document;
}

export function createYoutubeMainController(
  options: YoutubeMainControllerOptions = {},
): YoutubeMainController {
  const win = options.hostWindow ?? window;
  const doc = options.hostDocument ?? document;

  let subtitlesEnabled = true;
  let currentVideoId = '';
  let scanPending = false;
  let destroyed = false;
  let autoFetchAttemptedForVideo = '';

  const capturedTracksByUrl = new Map<string, CapturedTrackRecord>();
  const cleanupFns: Array<() => void> = [];
  let boundVideo: HTMLVideoElement | null = null;
  let detachVideoListeners: (() => void) | null = null;
  let playerObserver: MutationObserver | null = null;

  const pipPlayer = new YoutubePipPlayer({
    hostWindow: win,
    hostDocument: doc,
    onActiveChange: () => {
      syncPlayerButtons();
    },
  });

  function postBridgeMessage(msg: YoutubeExtendedBridgeMessage): void {
    try {
      win.postMessage(msg, '*');
    } catch {
      // Ignore detached window postMessage errors
    }
  }

  function isPlaybackPage(): boolean {
    const pathname = win.location?.pathname ?? '';
    return (
      pathname === '/watch' ||
      pathname.startsWith('/live/') ||
      pathname.startsWith('/shorts/') ||
      pathname.startsWith('/embed/')
    );
  }

  function handleCapturedTimedText(trackUrl: string, rawBody: string): void {
    if (destroyed || !rawBody) return;
    const events = parseYoutubeTimedTextPayload(rawBody);
    if (events.length === 0) return;

    const videoId =
      extractYoutubeVideoId(trackUrl) ||
      extractYoutubeVideoId(win.location?.href ?? '') ||
      currentVideoId;
    if (!videoId) return;

    const langCode = extractLangFromTimedTextUrl(trackUrl);
    const record: CapturedTrackRecord = {
      videoId,
      langCode,
      trackUrl,
      events,
    };

    // Prune tracks from older videos
    for (const [key, existing] of capturedTracksByUrl.entries()) {
      if (existing.videoId !== videoId) {
        capturedTracksByUrl.delete(key);
      }
    }
    capturedTracksByUrl.set(trackUrl, record);

    postBridgeMessage({
      source: BRAND.ytBridgeSourceMain,
      type: 'caption-track-captured',
      videoId,
      langCode,
      trackUrl,
      events,
    });
  }

  function installNetworkHooks(): void {
    const originalFetch = win.fetch;
    if (typeof originalFetch === 'function') {
      const hookedFetch: typeof fetch = async function marginHookedFetch(
        this: unknown,
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        const response = await originalFetch.call(this, input, init);
        try {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input?.url ?? '';
          if (isTimedTextUrl(url)) {
            const cloned = response.clone();
            void cloned
              .text()
              .then((bodyText) => {
                handleCapturedTimedText(url, bodyText);
              })
              .catch(() => {});
          }
        } catch {
          // Never interfere with host fetch
        }
        return response;
      };

      win.fetch = hookedFetch;
      cleanupFns.push(() => {
        if (win.fetch === hookedFetch) {
          win.fetch = originalFetch;
        }
      });
    }

    const XhrProto = (win as Window & typeof globalThis).XMLHttpRequest?.prototype;
    if (XhrProto) {
      const xhrUrls = new WeakMap<XMLHttpRequest, string>();
      const origOpen = XhrProto.open;
      const origSend = XhrProto.send;

      const hookedOpen = function marginHookedOpen(
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        async?: boolean,
        username?: string | null,
        password?: string | null,
      ): void {
        try {
          xhrUrls.set(this, typeof url === 'string' ? url : String(url));
        } catch {
          // Ignore WeakMap error
        }
        origOpen.call(this, method, url, async ?? true, username, password);
      };

      const hookedSend = function marginHookedSend(
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null,
      ): void {
        const trackedUrl = xhrUrls.get(this) ?? '';
        if (isTimedTextUrl(trackedUrl)) {
          this.addEventListener(
            'load',
            () => {
              try {
                if (this.responseType === '' || this.responseType === 'text') {
                  if (this.responseText) {
                    handleCapturedTimedText(trackedUrl, this.responseText);
                  }
                } else if (this.responseType === 'json' && this.response) {
                  handleCapturedTimedText(
                    trackedUrl,
                    JSON.stringify(this.response),
                  );
                }
              } catch {
                // Ignore XHR inspect failures
              }
            },
            { once: true },
          );
        }
        origSend.call(this, body);
      };

      XhrProto.open = hookedOpen;
      XhrProto.send = hookedSend;

      cleanupFns.push(() => {
        if (XhrProto.open === hookedOpen) {
          XhrProto.open = origOpen;
        }
        if (XhrProto.send === hookedSend) {
          XhrProto.send = origSend;
        }
      });
    }
  }

  function tryFetchInitialCaptionTrackIfMissing(videoId: string): void {
    if (!subtitlesEnabled || !videoId || autoFetchAttemptedForVideo === videoId) {
      return;
    }
    const hasCapturedForVideo = Array.from(capturedTracksByUrl.values()).some(
      (rec) => rec.videoId === videoId,
    );
    if (hasCapturedForVideo) return;

    type YtPlayerElement = HTMLElement & {
      getPlayerResponse?: () => {
        videoDetails?: { videoId?: string };
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: Array<{ baseUrl?: string; languageCode?: string }>;
          };
        };
      };
    };

    const moviePlayer = doc.getElementById('movie_player') as YtPlayerElement | null;
    const playerResp =
      moviePlayer?.getPlayerResponse?.() ??
      (
        win as Window & {
          ytInitialPlayerResponse?: ReturnType<
            NonNullable<YtPlayerElement['getPlayerResponse']>
          >;
        }
      ).ytInitialPlayerResponse;

    if (
      playerResp?.videoDetails?.videoId &&
      playerResp.videoDetails.videoId !== videoId
    ) {
      return;
    }

    const tracks =
      playerResp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) return;

    const firstTrack = tracks.find((t) => Boolean(t?.baseUrl));
    if (!firstTrack?.baseUrl) return;

    autoFetchAttemptedForVideo = videoId;
    try {
      const urlObj = new URL(firstTrack.baseUrl, win.location.origin);
      urlObj.searchParams.set('fmt', 'json3');
      void win.fetch(urlObj.toString(), { credentials: 'same-origin' }).catch(() => {});
    } catch {
      // Ignore fallback track fetch error
    }
  }

  function emitPlayheadTick(video: HTMLVideoElement): void {
    const vid = extractYoutubeVideoId(win.location?.href ?? '') || currentVideoId;
    if (!vid) return;
    postBridgeMessage({
      source: BRAND.ytBridgeSourceMain,
      type: 'playhead-tick',
      videoId: vid,
      currentTimeMs: Math.max(0, Math.round((video.currentTime || 0) * 1000)),
      paused: Boolean(video.paused),
    });
  }

  function bindActiveVideo(): void {
    const candidate =
      doc.querySelector<PipCapableVideoElement>('video.html5-main-video') ??
      doc.querySelector<PipCapableVideoElement>('video');
    if (candidate === boundVideo) return;

    detachVideoListeners?.();
    detachVideoListeners = null;
    boundVideo = candidate;
    if (!candidate) return;

    const onMediaEvent = () => emitPlayheadTick(candidate);
    const events = ['timeupdate', 'seeking', 'seeked', 'play', 'pause', 'loadedmetadata'];
    for (const evt of events) {
      candidate.addEventListener(evt, onMediaEvent);
    }
    detachVideoListeners = () => {
      for (const evt of events) {
        candidate.removeEventListener(evt, onMediaEvent);
      }
    };
    emitPlayheadTick(candidate);
  }

  function createPipButtonIcon(active: boolean): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const stroke = active ? '#c99455' : '#ffffff';
    const svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('aria-hidden', 'true');
    Object.assign(svg.style, {
      width: '22px',
      height: '22px',
      display: 'block',
      pointerEvents: 'none',
    });

    const frame = doc.createElementNS(ns, 'rect');
    frame.setAttribute('x', '5');
    frame.setAttribute('y', '8');
    frame.setAttribute('width', '26');
    frame.setAttribute('height', '20');
    frame.setAttribute('rx', '2.5');
    frame.setAttribute('fill', 'none');
    frame.setAttribute('stroke', stroke);
    frame.setAttribute('stroke-width', '2');

    const inset = doc.createElementNS(ns, 'rect');
    inset.setAttribute('x', '18.5');
    inset.setAttribute('y', '17.5');
    inset.setAttribute('width', '10');
    inset.setAttribute('height', '7.5');
    inset.setAttribute('rx', '1.4');
    inset.setAttribute('fill', stroke);

    const lines = doc.createElementNS(ns, 'path');
    lines.setAttribute('d', 'M9 14h7.5M9 18h6');
    lines.setAttribute('stroke', stroke);
    lines.setAttribute('stroke-width', '1.8');
    lines.setAttribute('stroke-linecap', 'round');

    svg.append(frame, inset, lines);
    return svg;
  }

  function createSubtitleToggleIcon(active: boolean): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const stroke = active ? '#c99455' : '#ffffff';
    const svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('aria-hidden', 'true');
    Object.assign(svg.style, {
      width: '22px',
      height: '22px',
      display: 'block',
      pointerEvents: 'none',
    });

    const box = doc.createElementNS(ns, 'rect');
    box.setAttribute('x', '5');
    box.setAttribute('y', '8');
    box.setAttribute('width', '26');
    box.setAttribute('height', '20');
    box.setAttribute('rx', '2.5');
    box.setAttribute('fill', 'none');
    box.setAttribute('stroke', stroke);
    box.setAttribute('stroke-width', '2');

    const line1 = doc.createElementNS(ns, 'path');
    line1.setAttribute('d', 'M9.5 15h17');
    line1.setAttribute('stroke', stroke);
    line1.setAttribute('stroke-width', '2');
    line1.setAttribute('stroke-linecap', 'round');

    const line2 = doc.createElementNS(ns, 'path');
    line2.setAttribute('d', 'M9.5 21h12');
    line2.setAttribute('stroke', active ? '#c99455' : 'rgba(255,255,255,0.72)');
    line2.setAttribute('stroke-width', '2');
    line2.setAttribute('stroke-linecap', 'round');

    svg.append(box, line1, line2);
    return svg;
  }

  function styleYtpControlButton(button: HTMLButtonElement): void {
    button.className = 'ytp-button';
    button.type = 'button';
    Object.assign(button.style, {
      appearance: 'none',
      background: 'transparent',
      border: 'none',
      outline: 'none',
      cursor: 'pointer',
      width: '36px',
      flex: '0 0 36px',
      height: '100%',
      padding: '0',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxSizing: 'border-box',
      verticalAlign: 'top',
    });
  }

  function ensurePlayerButtons(): void {
    if (!isPlaybackPage()) return;
    const rightControls = doc.querySelector<HTMLElement>('.ytp-right-controls');
    if (!rightControls) return;

    const targetContainer =
      rightControls.querySelector<HTMLElement>('.ytp-right-controls-left') ??
      rightControls;

    let subBtn = doc.getElementById(
      SUBTITLE_TOGGLE_BUTTON_ID,
    ) as HTMLButtonElement | null;
    if (!subBtn) {
      subBtn = doc.createElement('button');
      subBtn.id = SUBTITLE_TOGGLE_BUTTON_ID;
      styleYtpControlButton(subBtn);
      subBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        subtitlesEnabled = !subtitlesEnabled;
        syncPlayerButtons();
        postBridgeMessage({
          source: BRAND.ytBridgeSourceMain,
          type: 'subtitle-toggle-request',
          enabled: subtitlesEnabled,
        });
        if (subtitlesEnabled && currentVideoId) {
          tryFetchInitialCaptionTrackIfMissing(currentVideoId);
        }
      });
    }

    let pipBtn = doc.getElementById(PIP_BUTTON_ID) as HTMLButtonElement | null;
    if (!pipBtn) {
      pipBtn = doc.createElement('button');
      pipBtn.id = PIP_BUTTON_ID;
      styleYtpControlButton(pipBtn);
      pipBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void pipPlayer.toggle();
      });
    }

    if (subBtn.parentElement !== targetContainer) {
      targetContainer.insertBefore(subBtn, targetContainer.firstElementChild);
    }
    if (pipBtn.parentElement !== targetContainer || pipBtn.previousElementSibling !== subBtn) {
      targetContainer.insertBefore(pipBtn, subBtn.nextElementSibling);
    }

    syncPlayerButtons();
  }

  function syncPlayerButtons(): void {
    const isZh = (doc.documentElement.lang || 'en').toLowerCase().startsWith('zh');

    const subBtn = doc.getElementById(
      SUBTITLE_TOGGLE_BUTTON_ID,
    ) as HTMLButtonElement | null;
    if (subBtn) {
      const flag = subtitlesEnabled ? 'true' : 'false';
      if (subBtn.dataset.marginActive !== flag) {
        subBtn.dataset.marginActive = flag;
        subBtn.setAttribute('aria-pressed', flag);
        const label = isZh
          ? subtitlesEnabled
            ? 'Margin 双语字幕：已开启'
            : 'Margin 双语字幕：已关闭'
          : subtitlesEnabled
            ? 'Margin Bilingual Subtitles: On'
            : 'Margin Bilingual Subtitles: Off';
        subBtn.title = label;
        subBtn.setAttribute('aria-label', label);
        subBtn.replaceChildren(createSubtitleToggleIcon(subtitlesEnabled));
      }
    }

    const pipBtn = doc.getElementById(PIP_BUTTON_ID) as HTMLButtonElement | null;
    if (pipBtn) {
      const pipActive = pipPlayer.isActive();
      const flag = pipActive ? 'true' : 'false';
      if (pipBtn.dataset.marginPipActive !== flag) {
        pipBtn.dataset.marginPipActive = flag;
        pipBtn.setAttribute('aria-pressed', flag);
        const label = isZh
          ? pipActive
            ? '关闭 Margin 双语画中画'
            : '开启 Margin 双语画中画'
          : pipActive
            ? 'Close Margin Bilingual PiP'
            : 'Open Margin Bilingual PiP';
        pipBtn.title = label;
        pipBtn.setAttribute('aria-label', label);
        pipBtn.replaceChildren(createPipButtonIcon(pipActive));
      }
    }
  }

  function scanPage(): void {
    if (destroyed) return;
    const nextVideoId = extractYoutubeVideoId(win.location?.href ?? '');
    if (nextVideoId && nextVideoId !== currentVideoId) {
      currentVideoId = nextVideoId;
      autoFetchAttemptedForVideo = '';
      pipPlayer.clearCueImmediately();
    }

    ensurePlayerButtons();
    bindActiveVideo();
    pipPlayer.handleVideoCheck();

    if (subtitlesEnabled && currentVideoId) {
      setTimeout(() => {
        if (!destroyed && currentVideoId === nextVideoId) {
          tryFetchInitialCaptionTrackIfMissing(currentVideoId);
        }
      }, 900);
    }
  }

  function scheduleScan(): void {
    if (destroyed || scanPending) return;
    scanPending = true;
    const raf =
      win.requestAnimationFrame?.bind(win) ??
      ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16));
    raf(() => {
      scanPending = false;
      scanPage();
    });
  }

  function handleNavigation(): void {
    const nextVideoId = extractYoutubeVideoId(win.location?.href ?? '');
    if (nextVideoId !== currentVideoId && pipPlayer.isActive()) {
      void pipPlayer.close();
    }
    pipPlayer.clearCueImmediately();
    scheduleScan();
    setTimeout(scheduleScan, 450);
  }

  function isSameWindowMessage(event: MessageEvent): boolean {
    if (!event.source || event.source === win) return true;
    try {
      return (event.source as Window).document === doc;
    } catch {
      return false;
    }
  }

  function handleWindowMessage(event: MessageEvent): void {
    if (destroyed || !isSameWindowMessage(event)) return;
    const data = event.data as Partial<YoutubeMainBridgeMessage> | null;
    if (!data || typeof data !== 'object') return;
    if (data.source !== BRAND.ytBridgeSourceIsolated) return;

    if (data.type === 'active-cue-update' && data.cue) {
      pipPlayer.updateCue(data.cue);
      return;
    }

    if (data.type === 'subtitle-config-update' && data.settings) {
      const settings: SubtitleSettings = data.settings;
      subtitlesEnabled = Boolean(settings.youtubeAutoEnable);
      pipPlayer.updateSettings(settings);
      syncPlayerButtons();

      // Replay any early `document_start` captured caption tracks for the active video
      const activeVid =
        extractYoutubeVideoId(win.location?.href ?? '') || currentVideoId;
      for (const record of capturedTracksByUrl.values()) {
        if (!activeVid || record.videoId === activeVid) {
          postBridgeMessage({
            source: BRAND.ytBridgeSourceMain,
            type: 'caption-track-captured',
            videoId: record.videoId,
            langCode: record.langCode,
            trackUrl: record.trackUrl,
            events: record.events,
          });
        }
      }

      if (subtitlesEnabled && activeVid) {
        tryFetchInitialCaptionTrackIfMissing(activeVid);
      }
    }
  }

  function start(): void {
    if (destroyed) return;
    installNetworkHooks();

    win.addEventListener('message', handleWindowMessage);
    win.addEventListener('yt-navigate-finish', handleNavigation);
    win.addEventListener('yt-page-data-updated', scheduleScan);
    win.addEventListener('popstate', handleNavigation);

    cleanupFns.push(() => {
      win.removeEventListener('message', handleWindowMessage);
      win.removeEventListener('yt-navigate-finish', handleNavigation);
      win.removeEventListener('yt-page-data-updated', scheduleScan);
      win.removeEventListener('popstate', handleNavigation);
    });

    const attachObserver = () => {
      if (destroyed || playerObserver || !doc.documentElement) return;
      playerObserver = new MutationObserver(() => {
        if (!doc.getElementById(PIP_BUTTON_ID) || !boundVideo?.isConnected) {
          scheduleScan();
        }
      });
      playerObserver.observe(doc.documentElement, {
        childList: true,
        subtree: true,
      });
    };

    if (doc.readyState === 'loading') {
      doc.addEventListener(
        'DOMContentLoaded',
        () => {
          attachObserver();
          scheduleScan();
        },
        { once: true },
      );
    } else {
      attachObserver();
    }

    scheduleScan();
  }

  function refresh(): void {
    scheduleScan();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    playerObserver?.disconnect();
    playerObserver = null;
    detachVideoListeners?.();
    detachVideoListeners = null;
    boundVideo = null;
    for (const fn of cleanupFns.splice(0)) {
      try {
        fn();
      } catch {
        // Ignore cleanup failure
      }
    }
    doc.getElementById(SUBTITLE_TOGGLE_BUTTON_ID)?.remove();
    doc.getElementById(PIP_BUTTON_ID)?.remove();
    pipPlayer.destroy();
  }

  return {
    start,
    refresh,
    destroy,
    getPipPlayer: () => pipPlayer,
  };
}

export function shouldAutoBootMainEntry(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined,
  chromeRef: { runtime?: { id?: string } } | undefined = typeof globalThis.chrome !==
  'undefined'
    ? globalThis.chrome
    : undefined,
): boolean {
  if (!win || typeof document === 'undefined') {
    return false;
  }
  // Never auto-boot MAIN-world controller inside ISOLATED content-script world
  if (Boolean(chromeRef?.runtime?.id)) {
    return false;
  }
  if (win.top !== win) return false;
  const host = win.location?.hostname?.toLowerCase() ?? '';
  return host === 'youtube.com' || host.endsWith('.youtube.com');
}

if (shouldAutoBootMainEntry()) {
  const winRecord = window as unknown as Record<string, YoutubeMainController | undefined>;
  const existing = winRecord[MAIN_CONTROLLER_KEY];
  if (existing) {
    existing.refresh();
  } else {
    const controller = createYoutubeMainController();
    Object.defineProperty(window, MAIN_CONTROLLER_KEY, {
      configurable: true,
      enumerable: false,
      value: controller,
    });
    controller.start();
  }
}
