import { BRAND } from '@shared/brand';
import { createDefaultMarginConfig } from '@shared/constants';
import { requestBatchTranslation } from '@shared/messaging';
import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import {
  getMarginConfig,
  onMarginConfigChanged,
  updateMarginConfig,
} from '@shared/storage';
import type {
  MarginActiveCueState,
  MarginConfig,
  SubtitleCue,
  TranslateBatchRequest,
  TranslateBatchResponse,
  YoutubeMainBridgeMessage,
} from '@shared/types';
import { isUrlExcluded } from '@shared/url-match';
import {
  resolveSubtitleLimitsFromConfig,
  SubtitleBatchScheduler,
} from './batching';
import {
  buildSourceTrackFingerprint,
  clampFontSizePercent,
  extractYoutubeVideoId,
  normalizeActiveCueState,
  normalizeSubtitleStylePreset,
  PIP_CLEAR_DELAY_MS,
  resolveEffectiveTranslationScale,
  resolveRenderedCueLines,
  type YoutubeExtendedBridgeMessage,
} from './shared';
import {
  extractTextTrackCues,
  findActiveCueIndex,
  mergeAlignedSubtitleTrack,
  normalizeYoutubeEvents,
  parseWebVtt,
} from './timeline';

export const SUBTITLE_OVERLAY_HOST_ID = `${BRAND.cssPrefix}-subtitle-overlay-host`;
const NATIVE_YT_HIDE_STYLE_ID = `${BRAND.cssPrefix}-yt-native-caption-suppress`;
const ISOLATED_CONTROLLER_KEY = '__marginSubtitleIsolatedControllerV2__';

function isYoutubeHostname(hostname: string): boolean {
  const lower = (hostname || '').toLowerCase();
  return lower === 'youtube.com' || lower.endsWith('.youtube.com');
}

function isTranslatedYoutubeTrackUrl(trackUrl: string): string | null {
  try {
    const parsed = new URL(trackUrl, 'https://www.youtube.com');
    return parsed.searchParams.get('tlang');
  } catch {
    return null;
  }
}

export interface SubtitleIsolatedControllerOptions {
  hostWindow?: Window;
  hostDocument?: Document;
  translateBatch?: (
    request: TranslateBatchRequest,
    signal: AbortSignal,
  ) => Promise<TranslateBatchResponse>;
  loadConfig?: () => Promise<MarginConfig>;
  subscribeConfig?: (listener: (config: MarginConfig) => void) => () => void;
}

export interface SubtitleIsolatedController {
  start(): Promise<void>;
  destroy(): void;
  getActiveCue(): MarginActiveCueState;
  getCues(): readonly SubtitleCue[];
}

export function createSubtitleIsolatedController(
  options: SubtitleIsolatedControllerOptions = {},
): SubtitleIsolatedController {
  const win = options.hostWindow ?? window;
  const doc = options.hostDocument ?? document;
  const loadConfig = options.loadConfig ?? getMarginConfig;
  const subscribeConfig = options.subscribeConfig ?? onMarginConfigChanged;
  const translateFn =
    options.translateBatch ??
    (async (req: TranslateBatchRequest, signal: AbortSignal) => {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return requestBatchTranslation(req);
    });

  let config: MarginConfig = createDefaultMarginConfig();
  let sessionEnabledOverride: boolean | null = null;
  let currentVideoKey = '';
  let activeSourceTrackFingerprint = '';
  let currentPlayheadMs = 0;
  let activeCueState: MarginActiveCueState = normalizeActiveCueState();
  let renderedCueState: MarginActiveCueState = normalizeActiveCueState();
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let playheadPollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubConfig: (() => void) | null = null;
  let domObserver: MutationObserver | null = null;
  let playerResizeObserver: ResizeObserver | null = null;
  let observedPlayerContainer: HTMLElement | null = null;
  let boundHtml5Video: HTMLVideoElement | null = null;
  let detachHtml5Listeners: (() => void) | null = null;
  let destroyed = false;

  function buildConfiguredCueDefaults(): Partial<MarginActiveCueState> {
    const transScale = resolveEffectiveTranslationScale(config.subtitles);
    return {
      mode: config.subtitles.displayMode,
      fontSizePercent: config.subtitles.fontSizePercent ?? transScale,
      sourceScalePercent: clampFontSizePercent(
        config.subtitles.sourceScalePercent,
        100,
      ),
      translationScalePercent: transScale,
      stylePreset: normalizeSubtitleStylePreset(config.subtitles.stylePreset),
      position: config.subtitles.position,
    };
  }

  const isYoutube = isYoutubeHostname(win.location?.hostname ?? '');

  const scheduler = new SubtitleBatchScheduler({
    translateBatch: translateFn,
    onCuesUpdated: () => {
      refreshActiveCueFromPlayhead();
    },
  });

  function isSubtitlesEnabledForSite(): boolean {
    const href = win.location?.href ?? '';
    if (href && isUrlExcluded(href, config.urlRules)) {
      return false;
    }
    if (sessionEnabledOverride !== null) {
      return sessionEnabledOverride;
    }
    return isYoutube
      ? Boolean(config.subtitles.youtubeAutoEnable)
      : Boolean(config.subtitles.autoEnable);
  }

  function syncSchedulerConfig(): void {
    const resolved = resolveSubtitleLimitsFromConfig(config);
    scheduler.configure({
      fromLang: config.sourceLang || 'auto',
      toLang: config.targetLang || 'zh-CN',
      providerId: resolved.providerId,
      preTranslate: Boolean(config.subtitles.preTranslate),
      maxBatchCount: resolved.maxBatchCount,
      maxCharsPerBatch: resolved.maxCharsPerBatch,
      pageUrl: win.location?.href ?? 'https://www.youtube.com/',
      videoTitle: doc.title || undefined,
    });
  }

  function postToYoutubeMain(msg: YoutubeMainBridgeMessage): void {
    if (!isYoutube) return;
    try {
      win.postMessage(msg, '*');
    } catch {
      // Ignore postMessage on detached window
    }
  }

  function broadcastSubtitleConfig(): void {
    if (!isYoutube) return;
    postToYoutubeMain({
      source: BRAND.ytBridgeSourceIsolated,
      type: 'subtitle-config-update',
      settings: {
        ...config.subtitles,
        youtubeAutoEnable: isSubtitlesEnabledForSite(),
      },
    });
  }

  function broadcastActiveCue(cue: MarginActiveCueState): void {
    postToYoutubeMain({
      source: BRAND.ytBridgeSourceIsolated,
      type: 'active-cue-update',
      cue,
    });
  }

  function setNativeYoutubeCaptionSuppression(suppress: boolean): void {
    if (!isYoutube) return;
    const existing = doc.getElementById(NATIVE_YT_HIDE_STYLE_ID);
    if (!suppress) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const style = doc.createElement('style');
    style.id = NATIVE_YT_HIDE_STYLE_ID;
    style.textContent = `
      .html5-video-player .ytp-caption-window-container {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    (doc.head ?? doc.documentElement)?.appendChild(style);
  }

  function findOverlayMountContainer(): HTMLElement | null {
    const fsEl = doc.fullscreenElement as HTMLElement | null;
    if (fsEl && (fsEl.tagName !== 'VIDEO' || fsEl.parentElement)) {
      return fsEl.tagName === 'VIDEO' ? fsEl.parentElement : fsEl;
    }

    if (isYoutube) {
      return (
        doc.querySelector<HTMLElement>('#movie_player.html5-video-player') ??
        doc.querySelector<HTMLElement>('.html5-video-player')
      );
    }

    if (boundHtml5Video?.parentElement) {
      const parent = boundHtml5Video.parentElement;
      const computed = win.getComputedStyle?.(parent);
      if (computed && computed.position === 'static') {
        parent.style.position = 'relative';
      }
      return parent;
    }

    return null;
  }

  function syncOverlayBaseFontSize(
    container: HTMLElement,
    wrapper: HTMLElement,
  ): void {
    const playerHeight =
      container.clientHeight ||
      container.getBoundingClientRect?.().height ||
      0;
    const basePx =
      playerHeight > 0
        ? Math.max(16, Math.min(34, Math.round(playerHeight * 0.042)))
        : doc.fullscreenElement
          ? 26
          : 18;
    wrapper.style.setProperty('--margin-sub-base-px', `${basePx}px`);
  }

  function ensurePlayerResizeObserver(container: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') return;
    if (observedPlayerContainer === container && playerResizeObserver) return;
    playerResizeObserver?.disconnect();
    observedPlayerContainer = container;
    playerResizeObserver = new ResizeObserver(() => {
      if (destroyed) return;
      const host = doc.getElementById(SUBTITLE_OVERLAY_HOST_ID);
      const wrapper = host?.shadowRoot?.getElementById('margin-sub-wrap');
      if (wrapper) {
        syncOverlayBaseFontSize(container, wrapper);
      }
    });
    playerResizeObserver.observe(container);
  }

  function ensureOverlayShadowRoot(): ShadowRoot | null {
    const container = findOverlayMountContainer();
    if (!container) return null;

    let host = doc.getElementById(SUBTITLE_OVERLAY_HOST_ID) as HTMLElement | null;
    if (!host) {
      host = doc.createElement('div');
      host.id = SUBTITLE_OVERLAY_HOST_ID;
      host.setAttribute(`${BRAND.domAttrPrefix}-injected`, 'subtitle-overlay');
      const shadow = host.attachShadow({ mode: 'open' });

      const style = doc.createElement('style');
      style.textContent = buildInPlayerOverlayCss();

      const wrapper = doc.createElement('div');
      wrapper.id = 'margin-sub-wrap';
      wrapper.dataset.position = config.subtitles.position;
      wrapper.dataset.stylePreset = normalizeSubtitleStylePreset(
        config.subtitles.stylePreset,
      );
      wrapper.hidden = true;

      const origLine = doc.createElement('div');
      origLine.id = 'margin-sub-original';
      origLine.className = 'margin-sub-line margin-sub-original';
      origLine.hidden = true;
      const origSeg = doc.createElement('span');
      origSeg.className = 'margin-sub-seg';
      origLine.appendChild(origSeg);

      const transLine = doc.createElement('div');
      transLine.id = 'margin-sub-translated';
      transLine.className = 'margin-sub-line margin-sub-translated';
      transLine.hidden = true;
      const transSeg = doc.createElement('span');
      transSeg.className = 'margin-sub-seg';
      transLine.appendChild(transSeg);

      wrapper.append(origLine, transLine);
      shadow.append(style, wrapper);
    }

    if (host.parentElement !== container) {
      container.appendChild(host);
    }

    ensurePlayerResizeObserver(container);
    const wrapper = host.shadowRoot?.getElementById('margin-sub-wrap');
    if (wrapper) {
      syncOverlayBaseFontSize(container, wrapper);
    }

    const isFullscreen = Boolean(doc.fullscreenElement);
    host.toggleAttribute('data-fullscreen', isFullscreen);
    host.setAttribute('data-display-mode', 'night');

    return host.shadowRoot;
  }

  function removeOverlayHost(): void {
    playerResizeObserver?.disconnect();
    playerResizeObserver = null;
    observedPlayerContainer = null;
    doc.getElementById(SUBTITLE_OVERLAY_HOST_ID)?.remove();
    setNativeYoutubeCaptionSuppression(false);
  }

  function applyOverlayDom(cue: MarginActiveCueState): void {
    renderedCueState = cue;

    if (!isSubtitlesEnabledForSite() || scheduler.getCues().length === 0) {
      removeOverlayHost();
      return;
    }

    setNativeYoutubeCaptionSuppression(true);
    const shadow = ensureOverlayShadowRoot();
    if (!shadow) return;

    const wrapper = shadow.getElementById('margin-sub-wrap');
    const origEl = shadow.getElementById('margin-sub-original');
    const transEl = shadow.getElementById('margin-sub-translated');
    if (!wrapper || !origEl || !transEl) return;

    const origPct = clampFontSizePercent(cue.sourceScalePercent, 100);
    const transPct = clampFontSizePercent(
      cue.translationScalePercent ?? cue.fontSizePercent,
      70,
    );
    const preset = normalizeSubtitleStylePreset(cue.stylePreset);
    wrapper.style.setProperty('--margin-sub-orig-scale', (origPct / 100).toFixed(3));
    wrapper.style.setProperty('--margin-sub-trans-scale', (transPct / 100).toFixed(3));
    wrapper.dataset.stylePreset = preset;
    wrapper.dataset.position = cue.position;
    wrapper.toggleAttribute('data-fullscreen', Boolean(doc.fullscreenElement));

    const { originalLine, translatedLine } = resolveRenderedCueLines(cue);

    let origSeg = origEl.querySelector<HTMLElement>('.margin-sub-seg');
    if (!origSeg) {
      origSeg = doc.createElement('span');
      origSeg.className = 'margin-sub-seg';
      origEl.replaceChildren(origSeg);
    }
    origSeg.textContent = originalLine;
    origEl.hidden = !originalLine;

    let transSeg = transEl.querySelector<HTMLElement>('.margin-sub-seg');
    if (!transSeg) {
      transSeg = doc.createElement('span');
      transSeg.className = 'margin-sub-seg';
      transEl.replaceChildren(transSeg);
    }
    transSeg.textContent = translatedLine;
    transEl.hidden = !translatedLine;

    wrapper.hidden = !originalLine && !translatedLine;
  }

  function cancelClearTimer(): void {
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
  }

  function commitActiveCue(nextRaw: Partial<MarginActiveCueState>): void {
    const normalized = normalizeActiveCueState({
      ...buildConfiguredCueDefaults(),
      ...nextRaw,
    });

    const changed =
      normalized.original !== activeCueState.original ||
      normalized.translated !== activeCueState.translated ||
      normalized.startMs !== activeCueState.startMs ||
      normalized.endMs !== activeCueState.endMs ||
      normalized.mode !== activeCueState.mode ||
      normalized.fontSizePercent !== activeCueState.fontSizePercent ||
      normalized.sourceScalePercent !== activeCueState.sourceScalePercent ||
      normalized.translationScalePercent !== activeCueState.translationScalePercent ||
      normalized.stylePreset !== activeCueState.stylePreset ||
      normalized.position !== activeCueState.position;

    activeCueState = normalized;

    if (changed) {
      broadcastActiveCue(normalized);
    }

    const lines = resolveRenderedCueLines(normalized);
    const hasContent = Boolean(lines.originalLine || lines.translatedLine);

    if (hasContent) {
      cancelClearTimer();
      applyOverlayDom(normalized);
      return;
    }

    const hadRenderedContent = Boolean(
      renderedCueState.original || renderedCueState.translated,
    );
    if (!hadRenderedContent) {
      applyOverlayDom(normalized);
      return;
    }

    if (clearTimer === null) {
      clearTimer = setTimeout(() => {
        clearTimer = null;
        applyOverlayDom(normalizeActiveCueState(buildConfiguredCueDefaults()));
      }, PIP_CLEAR_DELAY_MS);
    }
  }

  function refreshActiveCueFromPlayhead(): void {
    if (!isSubtitlesEnabledForSite()) {
      cancelClearTimer();
      removeOverlayHost();
      const empty = normalizeActiveCueState(buildConfiguredCueDefaults());
      activeCueState = empty;
      broadcastActiveCue(empty);
      return;
    }

    const cues = scheduler.getCues();
    const activeIndex = findActiveCueIndex(cues, currentPlayheadMs);
    if (activeIndex < 0) {
      commitActiveCue({
        original: '',
        translated: '',
        startMs: null,
        endMs: null,
      });
      return;
    }

    const cue = cues[activeIndex];
    commitActiveCue({
      original: cue.text,
      translated: cue.trans ?? '',
      startMs: cue.tStartMs,
      endMs: cue.tStartMs + cue.dDurationMs,
    });
  }

  function isSameWindowMessage(event: MessageEvent): boolean {
    if (!event.source || event.source === win) return true;
    try {
      return (event.source as Window).document === doc;
    } catch {
      return false;
    }
  }

  function handleYoutubeBridgeMessage(event: MessageEvent): void {
    if (destroyed || !isYoutube || !isSameWindowMessage(event)) return;
    const msg = event.data as Partial<YoutubeExtendedBridgeMessage> | null;
    if (!msg || typeof msg !== 'object' || msg.source !== BRAND.ytBridgeSourceMain) {
      return;
    }

    if (msg.type === 'subtitle-toggle-request') {
      const nextEnabled = Boolean(msg.enabled);
      sessionEnabledOverride = nextEnabled;
      void updateMarginConfig((draft) => {
        draft.subtitles.youtubeAutoEnable = nextEnabled;
      }).catch(() => {});

      broadcastSubtitleConfig();
      if (!nextEnabled) {
        scheduler.cancelAll();
        refreshActiveCueFromPlayhead();
      } else {
        syncSchedulerConfig();
        scheduler.updatePlayhead(currentPlayheadMs);
        refreshActiveCueFromPlayhead();
      }
      return;
    }

    if (msg.type === 'playhead-tick') {
      if (typeof msg.currentTimeMs !== 'number') return;
      if (msg.videoId && currentVideoKey && msg.videoId !== currentVideoKey) {
        currentVideoKey = msg.videoId;
        activeSourceTrackFingerprint = '';
        scheduler.loadCues(msg.videoId, [], msg.currentTimeMs);
      }
      currentPlayheadMs = msg.currentTimeMs;
      if (isSubtitlesEnabledForSite()) {
        scheduler.updatePlayhead(currentPlayheadMs);
      }
      refreshActiveCueFromPlayhead();
      return;
    }

    if (msg.type === 'caption-track-captured' && Array.isArray(msg.events)) {
      const videoId =
        msg.videoId || extractYoutubeVideoId(win.location?.href ?? '');
      if (!videoId) return;

      const normalized = normalizeYoutubeEvents(msg.events);
      if (normalized.length === 0) return;

      const tlang = isTranslatedYoutubeTrackUrl(msg.trackUrl ?? '');
      const existingCues = scheduler.getCues();

      // If YouTube emitted a `tlang` translated track for the active video, align by ±1000ms (>= 0.6 ratio)
      if (tlang && currentVideoKey === videoId && existingCues.length > 0) {
        const merged = mergeAlignedSubtitleTrack(existingCues, normalized);
        if (merged.applied) {
          scheduler.loadCues(videoId, merged.cues, currentPlayheadMs);
          refreshActiveCueFromPlayhead();
        }
        return;
      }

      const nextFingerprint = buildSourceTrackFingerprint(
        videoId,
        msg.langCode ?? 'auto',
        normalized,
      );

      // Idempotent replay guard: preserve existing `cue.trans` & in-flight batches on config/toggle sync
      if (
        currentVideoKey === videoId &&
        activeSourceTrackFingerprint === nextFingerprint &&
        existingCues.length > 0
      ) {
        if (isSubtitlesEnabledForSite()) {
          syncSchedulerConfig();
          scheduler.updatePlayhead(currentPlayheadMs);
        } else {
          scheduler.cancelAll();
        }
        refreshActiveCueFromPlayhead();
        return;
      }

      if (currentVideoKey !== videoId) {
        activeSourceTrackFingerprint = '';
      }
      currentVideoKey = videoId;
      if (isSubtitlesEnabledForSite()) {
        syncSchedulerConfig();
        activeSourceTrackFingerprint = nextFingerprint;
        scheduler.loadCues(videoId, normalized, currentPlayheadMs);
      } else {
        scheduler.cancelAll();
      }
      refreshActiveCueFromPlayhead();
    }
  }

  async function tryLoadHtml5VideoTracks(video: HTMLVideoElement): Promise<void> {
    if (destroyed || isYoutube || !isSubtitlesEnabledForSite()) return;

    // 1. Check populated TextTrackCueList first
    const textTracks = Array.from(video.textTracks ?? []).filter(
      (t) => t.kind === 'subtitles' || t.kind === 'captions',
    );
    for (const track of textTracks) {
      if (track.mode === 'disabled') {
        track.mode = 'hidden';
      }
      const extracted = extractTextTrackCues(
        track.cues as unknown as ArrayLike<{
          startTime: number;
          endTime: number;
          text?: string;
        }>,
      );
      if (extracted.length > 0) {
        const key = `html5:${video.currentSrc || win.location?.href || 'video'}`;
        if (currentVideoKey !== key || scheduler.getCues().length === 0) {
          currentVideoKey = key;
          currentPlayheadMs = Math.max(0, Math.round((video.currentTime || 0) * 1000));
          syncSchedulerConfig();
          scheduler.loadCues(key, extracted, currentPlayheadMs);
          refreshActiveCueFromPlayhead();
        }
        return;
      }
    }

    // 2. Fallback: fetch `<track src="...vtt">` directly
    const trackEls = Array.from(
      video.querySelectorAll<HTMLTrackElement>(
        'track[kind="subtitles"], track[kind="captions"], track:not([kind])',
      ),
    );
    const primaryTrackEl =
      trackEls.find((el) => el.default) ?? trackEls[0];
    if (!primaryTrackEl?.src) return;

    const key = `html5-vtt:${primaryTrackEl.src}`;
    if (currentVideoKey === key && scheduler.getCues().length > 0) return;

    try {
      const res = await win.fetch(primaryTrackEl.src, { credentials: 'same-origin' });
      if (!res.ok) return;
      const vttText = await res.text();
      const parsed = parseWebVtt(vttText);
      if (parsed.length === 0 || destroyed) return;

      currentVideoKey = key;
      currentPlayheadMs = Math.max(0, Math.round((video.currentTime || 0) * 1000));
      syncSchedulerConfig();
      scheduler.loadCues(key, parsed, currentPlayheadMs);
      refreshActiveCueFromPlayhead();
    } catch {
      // Ignore cross-origin track fetch blocks
    }
  }

  function bindGenericHtml5Video(): void {
    if (destroyed || isYoutube || !isSubtitlesEnabledForSite()) return;
    const candidate = Array.from(doc.querySelectorAll('video')).find(
      (v) =>
        v.querySelector('track') !== null || (v.textTracks?.length ?? 0) > 0,
    );
    if (!candidate || candidate === boundHtml5Video) return;

    detachHtml5Listeners?.();
    boundHtml5Video = candidate;

    const onSync = () => {
      currentPlayheadMs = Math.max(0, Math.round((candidate.currentTime || 0) * 1000));
      if (isSubtitlesEnabledForSite()) {
        scheduler.updatePlayhead(currentPlayheadMs);
      }
      refreshActiveCueFromPlayhead();
    };

    const onTrackReady = () => {
      void tryLoadHtml5VideoTracks(candidate);
    };

    const events = ['timeupdate', 'seeking', 'seeked', 'play', 'loadedmetadata'];
    for (const evt of events) {
      candidate.addEventListener(evt, onSync);
    }
    candidate.textTracks?.addEventListener?.('change', onTrackReady);
    candidate.textTracks?.addEventListener?.('addtrack', onTrackReady);

    detachHtml5Listeners = () => {
      for (const evt of events) {
        candidate.removeEventListener(evt, onSync);
      }
      candidate.textTracks?.removeEventListener?.('change', onTrackReady);
      candidate.textTracks?.removeEventListener?.('addtrack', onTrackReady);
    };

    void tryLoadHtml5VideoTracks(candidate);
  }

  function tickActiveVideoPlayhead(): void {
    if (destroyed || !isSubtitlesEnabledForSite()) return;
    const video = isYoutube
      ? doc.querySelector<HTMLVideoElement>('video.html5-main-video')
      : boundHtml5Video;
    if (!video || video.paused) return;

    const nextMs = Math.max(0, Math.round((video.currentTime || 0) * 1000));
    if (Math.abs(nextMs - currentPlayheadMs) >= 40) {
      currentPlayheadMs = nextMs;
      scheduler.updatePlayhead(currentPlayheadMs);
      refreshActiveCueFromPlayhead();
    }
  }

  function handleFullscreenChange(): void {
    if (destroyed) return;
    applyOverlayDom(activeCueState);
  }

  async function start(): Promise<void> {
    if (destroyed) return;

    if (isYoutube) {
      win.addEventListener('message', handleYoutubeBridgeMessage);
    }
    doc.addEventListener('fullscreenchange', handleFullscreenChange);

    try {
      config = await loadConfig();
    } catch {
      config = createDefaultMarginConfig();
    }
    if (destroyed) return;

    syncSchedulerConfig();
    broadcastSubtitleConfig();

    unsubConfig = subscribeConfig((nextCfg) => {
      config = nextCfg;
      sessionEnabledOverride = null;
      if (isSubtitlesEnabledForSite()) {
        syncSchedulerConfig();
      } else {
        scheduler.cancelAll();
      }
      broadcastSubtitleConfig();
      if (!isYoutube) {
        bindGenericHtml5Video();
      }
      refreshActiveCueFromPlayhead();
    });

    playheadPollTimer = setInterval(tickActiveVideoPlayhead, 100);

    if (!isYoutube) {
      const startHtml5Scan = () => {
        if (destroyed) return;
        bindGenericHtml5Video();
        if (!domObserver && doc.documentElement) {
          domObserver = new MutationObserver(() => {
            if (!boundHtml5Video?.isConnected) {
              boundHtml5Video = null;
            }
            bindGenericHtml5Video();
          });
          domObserver.observe(doc.documentElement, {
            childList: true,
            subtree: true,
          });
        }
      };

      if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', startHtml5Scan, { once: true });
      } else {
        startHtml5Scan();
      }
    }
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    cancelClearTimer();
    if (playheadPollTimer !== null) {
      clearInterval(playheadPollTimer);
      playheadPollTimer = null;
    }
    if (isYoutube) {
      win.removeEventListener('message', handleYoutubeBridgeMessage);
    }
    doc.removeEventListener('fullscreenchange', handleFullscreenChange);
    unsubConfig?.();
    unsubConfig = null;
    domObserver?.disconnect();
    domObserver = null;
    detachHtml5Listeners?.();
    detachHtml5Listeners = null;
    boundHtml5Video = null;
    scheduler.cancelAll();
    removeOverlayHost();
  }

  return {
    start,
    destroy,
    getActiveCue: () => ({ ...activeCueState }),
    getCues: () => scheduler.getCues(),
  };
}

function buildInPlayerOverlayCss(): string {
  return /* css */ `
    ${SHADOW_HOST_RESET_CSS}
    :host {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      pointer-events: none !important;
      z-index: 60 !important;
      overflow: hidden !important;
    }
    #margin-sub-wrap {
      --margin-sub-base-px: 18px;
      --margin-sub-orig-scale: 1;
      --margin-sub-trans-scale: 0.7;
      position: absolute;
      left: 5%;
      right: 5%;
      bottom: 52px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      text-align: center;
      pointer-events: none;
      font-family: "YouTube Noto", Roboto, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    }
    #margin-sub-wrap[data-position="top"] {
      bottom: auto;
      top: 34px;
    }
    #margin-sub-wrap[data-fullscreen] {
      bottom: 70px;
    }
    #margin-sub-wrap[data-fullscreen][data-position="top"] {
      bottom: auto;
      top: 46px;
    }
    #margin-sub-wrap[hidden],
    .margin-sub-line[hidden] {
      display: none !important;
    }
    .margin-sub-line {
      width: fit-content;
      max-width: min(92%, 960px);
      padding: 0;
      margin: 0;
      background: transparent;
      border: none;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      text-shadow: none;
      box-sizing: border-box;
      line-height: 1.48;
    }
    .margin-sub-seg {
      display: inline;
      background: rgba(8, 8, 8, 0.75);
      color: #ffffff;
      padding: 2px 7px;
      border-radius: 2px;
      border: none;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    .margin-sub-original {
      color: #ffffff;
      font-size: calc(var(--margin-sub-base-px, 18px) * var(--margin-sub-orig-scale, 1));
      font-weight: 500;
    }
    .margin-sub-translated {
      color: rgba(255, 255, 255, 0.96);
      font-size: calc(var(--margin-sub-base-px, 18px) * var(--margin-sub-trans-scale, 0.7));
      font-weight: 500;
    }
    .margin-sub-translated .margin-sub-seg {
      color: rgba(255, 255, 255, 0.96);
    }
    #margin-sub-wrap[data-style-preset="cinema-outline"] {
      gap: 3px;
    }
    #margin-sub-wrap[data-style-preset="cinema-outline"] .margin-sub-seg {
      background: transparent;
      border: none;
      padding: 1px 6px;
      text-shadow:
        0 1px 3px rgba(0, 0, 0, 0.95),
        0 0 6px rgba(0, 0, 0, 0.9),
        -1px -1px 0 rgba(0, 0, 0, 0.85),
        1px -1px 0 rgba(0, 0, 0, 0.85),
        -1px 1px 0 rgba(0, 0, 0, 0.85),
        1px 1px 0 rgba(0, 0, 0, 0.85);
    }
    #margin-sub-wrap[data-style-preset="warm-paper"] {
      gap: 4px;
    }
    #margin-sub-wrap[data-style-preset="warm-paper"] .margin-sub-line {
      padding: 3px 10px 4px;
      border-radius: 5px;
      background: rgba(21, 20, 17, 0.82);
      border: 1px solid rgba(201, 148, 85, 0.24);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.88);
      line-height: 1.36;
    }
    #margin-sub-wrap[data-style-preset="warm-paper"] .margin-sub-seg {
      background: transparent;
      padding: 0;
      color: inherit;
    }
    #margin-sub-wrap[data-style-preset="warm-paper"] .margin-sub-original {
      color: rgba(236, 228, 210, 0.90);
    }
    #margin-sub-wrap[data-style-preset="warm-paper"] .margin-sub-translated {
      color: #fbfaf6;
    }
  `;
}

function shouldAutoBootIsolatedEntry(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  if (window.top !== window) return false;
  return Boolean(
    typeof globalThis.chrome !== 'undefined' && globalThis.chrome?.runtime?.id,
  );
}

if (shouldAutoBootIsolatedEntry()) {
  const winRecord = window as unknown as Record<
    string,
    SubtitleIsolatedController | undefined
  >;
  if (!winRecord[ISOLATED_CONTROLLER_KEY]) {
    const controller = createSubtitleIsolatedController();
    Object.defineProperty(window, ISOLATED_CONTROLLER_KEY, {
      configurable: true,
      enumerable: false,
      value: controller,
    });
    void controller.start();
  }
}
