import { BRAND } from '@shared/brand';
import type {
  SubtitleSettings,
  YoutubeMainBridgeMessage,
  YoutubeNativeCaptionTheme,
  YoutubeRawJson3Event,
} from '@shared/types';
import { YoutubePipPlayer, type PipCapableVideoElement } from './pip-player';
import {
  areYoutubeNativeThemesEqual,
  extractYoutubeVideoId,
  isTimedTextUrl,
  PIP_BUTTON_ID,
  readLocalYoutubeCaptionTheme,
  SUBTITLE_TOGGLE_BUTTON_ID,
  YOUTUBE_CAPTION_STORAGE_KEY,
  YOUTUBE_CONTROLS_STYLE_ID,
  type YoutubeExtendedBridgeMessage,
} from './shared';
import { parseYoutubeTimedTextPayload } from './timeline';

export {
  extractYoutubeVideoId,
  isTimedTextUrl,
  SUBTITLE_TOGGLE_BUTTON_ID,
  YOUTUBE_CONTROLS_STYLE_ID,
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
  let lastBroadcastedTheme: YoutubeNativeCaptionTheme | null = null;
  let pendingThemeTimer: ReturnType<typeof setTimeout> | null = null;

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

  function createActiveUnderlineBar(): SVGRectElement {
    const ns = 'http://www.w3.org/2000/svg';
    const bar = doc.createElementNS(ns, 'rect');
    bar.setAttribute('data-margin-active-bar', 'true');
    bar.setAttribute('x', '5');
    bar.setAttribute('y', '24.2');
    bar.setAttribute('width', '18');
    bar.setAttribute('height', '2.6');
    bar.setAttribute('rx', '1.3');
    bar.setAttribute('fill', '#ff0033');
    return bar;
  }

  function applyNativeIconSvgSizing(svg: SVGSVGElement): void {
    svg.setAttribute('viewBox', '0 0 28 28');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', '28');
    svg.setAttribute('aria-hidden', 'true');
    Object.assign(svg.style, {
      width: '28px',
      height: '28px',
      minWidth: '28px',
      minHeight: '28px',
      padding: '0px',
      margin: '0px',
      display: 'block',
      overflow: 'visible',
      pointerEvents: 'none',
    });
  }

  function createPipButtonIcon(active: boolean): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(ns, 'svg');
    applyNativeIconSvgSizing(svg);

    const frame = doc.createElementNS(ns, 'rect');
    frame.setAttribute('x', '3.5');
    frame.setAttribute('y', '5.5');
    frame.setAttribute('width', '21');
    frame.setAttribute('height', '16');
    frame.setAttribute('rx', '2.4');
    frame.setAttribute('fill', 'none');
    frame.setAttribute('stroke', '#ffffff');
    frame.setAttribute('stroke-width', '2');

    const inset = doc.createElementNS(ns, 'rect');
    inset.setAttribute('x', '13.8');
    inset.setAttribute('y', '13');
    inset.setAttribute('width', '8');
    inset.setAttribute('height', '5.8');
    inset.setAttribute('rx', '1.2');
    inset.setAttribute('fill', '#ffffff');

    const lines = doc.createElementNS(ns, 'path');
    lines.setAttribute('d', 'M7.2 10.2h5.8M7.2 14h4.2');
    lines.setAttribute('stroke', '#ffffff');
    lines.setAttribute('stroke-width', '1.8');
    lines.setAttribute('stroke-linecap', 'round');

    svg.append(frame, inset, lines);
    if (active) {
      svg.appendChild(createActiveUnderlineBar());
    }
    return svg;
  }

  function createSubtitleToggleIcon(active: boolean): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(ns, 'svg');
    applyNativeIconSvgSizing(svg);

    const box = doc.createElementNS(ns, 'rect');
    box.setAttribute('x', '3.5');
    box.setAttribute('y', '5.5');
    box.setAttribute('width', '21');
    box.setAttribute('height', '16');
    box.setAttribute('rx', '2.4');
    box.setAttribute('fill', 'none');
    box.setAttribute('stroke', '#ffffff');
    box.setAttribute('stroke-width', '2');

    const line1 = doc.createElementNS(ns, 'path');
    line1.setAttribute('d', 'M7.5 11.2h13');
    line1.setAttribute('stroke', '#ffffff');
    line1.setAttribute('stroke-width', '2');
    line1.setAttribute('stroke-linecap', 'round');

    const line2 = doc.createElementNS(ns, 'path');
    line2.setAttribute('d', 'M7.5 15.8h9.5');
    line2.setAttribute('stroke', 'rgba(255, 255, 255, 0.9)');
    line2.setAttribute('stroke-width', '2');
    line2.setAttribute('stroke-linecap', 'round');

    svg.append(box, line1, line2);
    if (active) {
      svg.appendChild(createActiveUnderlineBar());
    }
    return svg;
  }

  function ensureControlsStylesheet(): void {
    if (doc.getElementById(YOUTUBE_CONTROLS_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = YOUTUBE_CONTROLS_STYLE_ID;
    style.textContent = /* css */ `
      button#${SUBTITLE_TOGGLE_BUTTON_ID}.ytp-button,
      button#${PIP_BUTTON_ID}.ytp-button {
        width: 48px !important;
        min-width: 48px !important;
        height: 100% !important;
        padding: 0 !important;
        margin: 0 !important;
        border: none !important;
        background: transparent !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        flex: 0 0 48px !important;
        box-sizing: border-box !important;
        vertical-align: top !important;
        opacity: 0.92;
        transition: opacity 120ms ease;
      }
      .ytp-delhi-modern button#${SUBTITLE_TOGGLE_BUTTON_ID}.ytp-button,
      .ytp-delhi-modern button#${PIP_BUTTON_ID}.ytp-button {
        width: 44px !important;
        min-width: 44px !important;
        flex: 0 0 44px !important;
      }
      .ytp-big-mode button#${SUBTITLE_TOGGLE_BUTTON_ID}.ytp-button,
      .ytp-big-mode button#${PIP_BUTTON_ID}.ytp-button {
        width: 54px !important;
        min-width: 54px !important;
        flex: 0 0 54px !important;
      }
      button#${SUBTITLE_TOGGLE_BUTTON_ID}.ytp-button:hover,
      button#${PIP_BUTTON_ID}.ytp-button:hover,
      button#${SUBTITLE_TOGGLE_BUTTON_ID}.ytp-button[aria-pressed="true"],
      button#${PIP_BUTTON_ID}.ytp-button[aria-pressed="true"] {
        opacity: 1;
      }
      button#${SUBTITLE_TOGGLE_BUTTON_ID}.ytp-button > svg,
      button#${PIP_BUTTON_ID}.ytp-button > svg {
        width: 28px !important;
        height: 28px !important;
        min-width: 28px !important;
        min-height: 28px !important;
        max-width: 28px !important;
        max-height: 28px !important;
        padding: 0 !important;
        margin: 0 !important;
        flex: 0 0 28px !important;
        box-sizing: content-box !important;
        display: block !important;
        overflow: visible !important;
        pointer-events: none !important;
      }
      .ytp-big-mode button#${SUBTITLE_TOGGLE_BUTTON_ID}.ytp-button > svg,
      .ytp-big-mode button#${PIP_BUTTON_ID}.ytp-button > svg {
        width: 34px !important;
        height: 34px !important;
        min-width: 34px !important;
        min-height: 34px !important;
        max-width: 34px !important;
        max-height: 34px !important;
        flex: 0 0 34px !important;
      }
    `;
    (doc.head ?? doc.documentElement)?.appendChild(style);
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
      width: '48px',
      flex: '0 0 48px',
      height: '100%',
      padding: '0px',
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

    ensureControlsStylesheet();

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

  function syncNativeCaptionStyleFromPlayer(force = false): void {
    if (destroyed) return;
    const moviePlayer = doc.getElementById('movie_player') as
      | (HTMLElement & { getSubtitlesUserSettings?: () => unknown })
      | null;
    let livePlayerSettings: unknown = null;
    try {
      livePlayerSettings = moviePlayer?.getSubtitlesUserSettings?.() ?? null;
    } catch {
      livePlayerSettings = null;
    }
    const nextTheme = readLocalYoutubeCaptionTheme(win, doc, livePlayerSettings);
    if (force || !areYoutubeNativeThemesEqual(lastBroadcastedTheme, nextTheme)) {
      lastBroadcastedTheme = nextTheme;
      postBridgeMessage({
        source: BRAND.ytBridgeSourceMain,
        type: 'native-caption-style-update',
        theme: nextTheme,
      });
    }
  }

  function handlePlayerStyleInteraction(event: Event): void {
    if (destroyed) return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      typeof target.closest === 'function' &&
      !target.closest('#movie_player, .html5-video-player, .ytp-popup, .ytp-settings-menu')
    ) {
      return;
    }
    const raf =
      win.requestAnimationFrame?.bind(win) ??
      ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16));
    raf(() => {
      if (!destroyed) syncNativeCaptionStyleFromPlayer(false);
    });
    if (pendingThemeTimer !== null) {
      clearTimeout(pendingThemeTimer);
    }
    pendingThemeTimer = setTimeout(() => {
      pendingThemeTimer = null;
      syncNativeCaptionStyleFromPlayer(false);
    }, 65);
  }

  function handleCaptionStorageEvent(event: StorageEvent): void {
    if (!event.key || event.key === YOUTUBE_CAPTION_STORAGE_KEY) {
      syncNativeCaptionStyleFromPlayer(false);
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
    syncNativeCaptionStyleFromPlayer(false);

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
      syncNativeCaptionStyleFromPlayer(true);

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
    win.addEventListener('storage', handleCaptionStorageEvent);
    doc.addEventListener('click', handlePlayerStyleInteraction, true);
    doc.addEventListener('keyup', handlePlayerStyleInteraction, true);

    cleanupFns.push(() => {
      win.removeEventListener('message', handleWindowMessage);
      win.removeEventListener('yt-navigate-finish', handleNavigation);
      win.removeEventListener('yt-page-data-updated', scheduleScan);
      win.removeEventListener('popstate', handleNavigation);
      win.removeEventListener('storage', handleCaptionStorageEvent);
      doc.removeEventListener('click', handlePlayerStyleInteraction, true);
      doc.removeEventListener('keyup', handlePlayerStyleInteraction, true);
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
    if (pendingThemeTimer !== null) {
      clearTimeout(pendingThemeTimer);
      pendingThemeTimer = null;
    }
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
    doc.getElementById(YOUTUBE_CONTROLS_STYLE_ID)?.remove();
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
