import { BRAND } from '@shared/brand';
import { createDefaultMarginConfig } from '@shared/constants';
import {
  isExtensionContextValid,
  requestBatchTranslation,
} from '@shared/messaging';
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
  YoutubeNativeCaptionTheme,
  YoutubeRawJson3Event,
} from '@shared/types';
import { isUrlExcluded } from '@shared/url-match';
import {
  resolveSubtitleLimitsFromConfig,
  SubtitleBatchScheduler,
} from './batching';
import {
  buildHtml5TrackIdentity,
  computeHtml5BottomOffset,
  computeHtml5CaptionTypography,
  computeVisibleRatio,
  findNativeCaptionLayer,
  HTML5_ARBITRATION_THROTTLE_MS,
  HTML5_CONTROLS_AUTOHIDE_IDLE_MS,
  HTML5_ENGAGE_DWELL_MS,
  HTML5_IMMEDIATE_LOOKAHEAD_MS,
  HTML5_REFILL_TRIGGER_MS,
  HTML5_STATUS_DWELL_MS,
  HTML5_TRACK_POLL_MS,
  isHostCaptionsOn,
  isHtml5VideoPlayingVisible,
  mergeHtml5Cues,
  NATIVE_CAPTION_HIDDEN_ATTR,
  NATIVE_CUE_SUPPRESSED_ATTR,
  NATIVE_HTML5_HIDE_STYLE_ID,
  pickCaptionTrack,
  rebaseSmpteBroadcastOffset,
  recordCueTranslationsInMemo,
  resolveEffectiveVideoRect,
  resolveHtml5PlayerRoot,
  resolveViewportSize,
  selectActiveHtml5Video,
} from './html5-video';
import {
  applyNativeThemeVariablesToElement,
  areYoutubeNativeThemesEqual,
  buildSourceTrackFingerprint,
  clampFontSizePercent,
  DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME,
  extractYoutubeVideoId,
  normalizeActiveCueState,
  normalizeBgOpacityOverride,
  normalizeSubtitleStylePreset,
  normalizeSubtitleTargetLang,
  normalizeTranslationTint,
  PIP_CLEAR_DELAY_MS,
  readLocalYoutubeCaptionTheme,
  resolveEffectiveTranslationScale,
  resolveRenderedCueLines,
  resolveSubtitleCjkFallbackForLang,
  resolveSubtitleTargetDir,
   sanitizeSubtitleMarkup,
  YOUTUBE_CAPTION_STORAGE_KEY,
  type YoutubeExtendedBridgeMessage,
  type YoutubeIsolatedToMainMessage,
} from './shared';
import {
  extractTextTrackCues,
  findActiveCueIndex,
  mergeAlignedSubtitleTrack,
  normalizeYoutubeEvents,
  parseWebVtt,
} from './timeline';

export {
  NATIVE_CAPTION_HIDDEN_ATTR,
  NATIVE_CUE_SUPPRESSED_ATTR,
  NATIVE_HTML5_HIDE_STYLE_ID,
};
export const SUBTITLE_OVERLAY_HOST_ID = `${BRAND.cssPrefix}-subtitle-overlay-host`;
export const NATIVE_YT_HIDE_STYLE_ID = `${BRAND.cssPrefix}-yt-native-caption-suppress`;
export const OVERLAY_OWNER_ATTR = `${BRAND.domAttrPrefix}-owner`;
export const ISOLATED_CONTROLLER_KEY = '__marginSubtitleIsolatedControllerV2__';

const MAX_STASHED_VIDEOS = 6;
const MAX_STASHED_CAPTURES_PER_VIDEO = 8;

interface StashedCaptionCapture {
  videoId: string;
  langCode: string;
  trackUrl: string;
  events: YoutubeRawJson3Event[];
}

let isolatedInstanceSeq = 0;
function nextIsolatedInstanceId(): string {
  isolatedInstanceSeq += 1;
  return `margin-iso-${Date.now().toString(36)}-${isolatedInstanceSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

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
  isDestroyed?(): boolean;
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

  const instanceId = nextIsolatedInstanceId();
  let config: MarginConfig = createDefaultMarginConfig();
  let configLoaded = false;
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
  let watchFlexyObserver: MutationObserver | null = null;
  let playerResizeObserver: ResizeObserver | null = null;
  let observedPlayerContainer: HTMLElement | null = null;
  let playerClassObserver: MutationObserver | null = null;
  let observedClassContainer: HTMLElement | null = null;
  let pendingCaptionSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let ownedOverlayHost: HTMLElement | null = null;
  let boundHtml5Video: HTMLVideoElement | null = null;
  let boundHtml5PlayerRoot: HTMLElement | null = null;
  let activeHtml5VideoIdentity = '';
  let html5TrackLoadGen = 0;
  let detachHtml5Listeners: (() => void) | null = null;
  let detachHtml5DocListeners: (() => void) | null = null;
  let detachPickedTrackListener: (() => void) | null = null;
  let activePickedTrack: TextTrack | null = null;
  let html5OverlayState: 'OFF' | 'ON_IDLE' | 'ON_ACTIVE' = 'OFF';
  let html5SuppressionApplied = false;
  let suppressedVideoEl: HTMLVideoElement | null = null;
  let lastAppliedStyleSig = '';
  let lastPolledCueCount = -1;
  let lastPolledLastEndTime = -1;
  let lastSentPlayheadMs = -1;
  let lastTrackPollAt = 0;
  let lastOverlayOffsetPollAt = 0;
  let lastPointerActivityAt = 0;
  let pausedAfterPlay = false;
  let cachedNativeCaptionEl: HTMLElement | null = null;
  let hadPositiveNativeCaptionLayer = false;
  let awaitingUiToggleCheck = false;
  let missingLayerCueChangesAfterClick = 0;
  let hostCaptionsHiddenByUi = false;
  let arbitrationTimer: ReturnType<typeof setTimeout> | null = null;
  let lastArbitrationAt = 0;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let dwellVideo: HTMLVideoElement | null = null;
  let uiClickRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  let missingLayerConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  let controlsFadeTimer: ReturnType<typeof setTimeout> | null = null;
  let captionLayerRafToken = 0;
  const videoIdentityMap = new WeakMap<HTMLVideoElement, number>();
  let nextHtml5VideoSeq = 0;
  const lastPlayingAtMap = new WeakMap<HTMLVideoElement, number>();
  const engagedVideos = new WeakSet<HTMLVideoElement>();
  const mutatedPositionMap = new Map<HTMLElement, string>();
  const videoTranslationMemo = new Map<string, string>();
  let lastMemoLangKey = '';
  let hadRuntimeIdAtStart = false;
  let destroyed = false;
  const stashedCapturesByVideoId = new Map<string, StashedCaptionCapture[]>();

  const isYoutube = isYoutubeHostname(win.location?.hostname ?? '');
  let hasReceivedMainThemeBridge = false;
  let currentNativeTheme: YoutubeNativeCaptionTheme = isYoutube
    ? readLocalYoutubeCaptionTheme(win, doc)
    : { ...DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME };

  function buildConfiguredCueDefaults(): Partial<MarginActiveCueState> {
    const transScale = resolveEffectiveTranslationScale(config.subtitles);
    return {
      mode: config.subtitles.displayMode,
      targetLang: normalizeSubtitleTargetLang(config.targetLang || 'zh-CN'),
      fontSizePercent: config.subtitles.fontSizePercent ?? transScale,
      sourceScalePercent: clampFontSizePercent(
        config.subtitles.sourceScalePercent,
        100,
      ),
      translationScalePercent: transScale,
      stylePreset: normalizeSubtitleStylePreset(config.subtitles.stylePreset),
      bgOpacityPercent: normalizeBgOpacityOverride(
        config.subtitles.bgOpacityPercent,
      ),
      translationTint: normalizeTranslationTint(
        config.subtitles.translationTint,
      ),
      ...(isYoutube ? { nativeTheme: currentNativeTheme } : {}),
      position: config.subtitles.position,
    };
  }

  const scheduler = new SubtitleBatchScheduler({
    translateBatch: translateFn,
    onCuesUpdated: () => {
      if (!isYoutube) {
        recordCueTranslationsInMemo(videoTranslationMemo, scheduler.getCues());
        if (boundHtml5Video) {
          updateHtml5DispatchGate(boundHtml5Video);
        }
      }
      refreshActiveCueFromPlayhead();
    },
  });
  if (!isYoutube) {
    scheduler.setDispatchGate(false);
  }

  function isHtml5OverlayActive(): boolean {
    return isYoutube || html5OverlayState === 'ON_ACTIVE';
  }

  function getHtml5VideoIdentity(video: HTMLVideoElement): string {
    let id = videoIdentityMap.get(video);
    if (id === undefined) {
      nextHtml5VideoSeq += 1;
      id = nextHtml5VideoSeq;
      videoIdentityMap.set(video, id);
    }
    const src = video.currentSrc || video.getAttribute('src') || '';
    return `html5#${id}|${src}`;
  }

  function restoreMutatedPositions(): void {
    for (const [el, prevInlinePos] of mutatedPositionMap.entries()) {
      if (prevInlinePos) {
        el.style.position = prevInlinePos;
      } else {
        el.style.removeProperty('position');
      }
    }
    mutatedPositionMap.clear();
  }

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
    if (isYoutube) {
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
      return;
    }
    const nextMemoLangKey = `${config.targetLang || 'zh-CN'}|${resolved.providerId}`;
    if (lastMemoLangKey && lastMemoLangKey !== nextMemoLangKey) {
      videoTranslationMemo.clear();
    }
    lastMemoLangKey = nextMemoLangKey;
    scheduler.configure({
      fromLang: config.sourceLang || 'auto',
      toLang: config.targetLang || 'zh-CN',
      providerId: resolved.providerId,
      preTranslate: false,
      immediateLookaheadMs: HTML5_IMMEDIATE_LOOKAHEAD_MS,
      refillTriggerMs: HTML5_REFILL_TRIGGER_MS,
      maxBatchCount: resolved.maxBatchCount,
      maxCharsPerBatch: resolved.maxCharsPerBatch,
      pageUrl: win.location?.href ?? '',
      videoTitle: doc.title || undefined,
    });
  }

  function postToYoutubeMain(msg: YoutubeIsolatedToMainMessage): void {
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
      instanceId,
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

  function ensureHtml5NativeSuppressStyle(): void {
    if (isYoutube) return;
    if (doc.getElementById(NATIVE_HTML5_HIDE_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = NATIVE_HTML5_HIDE_STYLE_ID;
    style.textContent = [
      `video[${NATIVE_CUE_SUPPRESSED_ATTR}]::cue { color: transparent !important; background: transparent !important; text-shadow: none !important; outline: none !important; opacity: 0 !important; }`,
      `video[${NATIVE_CUE_SUPPRESSED_ATTR}]::-webkit-media-text-track-display { opacity: 0 !important; }`,
      `[${NATIVE_CAPTION_HIDDEN_ATTR}] { opacity: 0 !important; pointer-events: none !important; transition: none !important; }`,
    ].join('\n');
    (doc.head ?? doc.documentElement)?.appendChild(style);
  }

  function extractActiveTrackTexts(video: HTMLVideoElement): string[] {
    const picked = pickCaptionTrack(video);
    if (!picked) return [];

    const activeList = (
      picked as TextTrack & {
        activeCues?: ArrayLike<{ text?: string }> | null;
      }
    ).activeCues;

    if (activeList !== undefined && activeList !== null) {
      const texts: string[] = [];
      for (let i = 0; i < activeList.length; i += 1) {
        const cleaned = sanitizeSubtitleMarkup(activeList[i]?.text ?? '');
        if (cleaned) texts.push(cleaned);
      }
      return texts;
    }

    // Fallback when fake `TextTrack` in unit tests omits `.activeCues`
    const cueList = picked.cues as unknown as
      | ArrayLike<{ startTime: number; endTime: number; text?: string }>
      | null
      | undefined;
    if (!cueList || typeof cueList.length !== 'number') return [];
    const nowSec = Number(video.currentTime) || 0;
    const texts: string[] = [];
    for (let i = 0; i < cueList.length; i += 1) {
      const c = cueList[i];
      if (!c) continue;
      if (nowSec >= Number(c.startTime) && nowSec < Number(c.endTime)) {
        const cleaned = sanitizeSubtitleMarkup(c.text ?? '');
        if (cleaned) texts.push(cleaned);
      }
    }
    return texts;
  }

  function syncNativeCaptionLayerSuppression(
    video: HTMLVideoElement | null,
    options: { forceScan?: boolean } = {},
  ): HTMLElement | null {
    if (isYoutube || !video || !video.isConnected) return null;
    const playerRoot =
      boundHtml5PlayerRoot?.isConnected
        ? boundHtml5PlayerRoot
        : resolveHtml5PlayerRoot(video);
    if (!playerRoot) return null;

    // P2-1 fast path: skip TreeWalker when cached caption layer is still mounted, marked, and non-empty
    if (
      !options.forceScan &&
      !awaitingUiToggleCheck &&
      !hostCaptionsHiddenByUi &&
      html5OverlayState === 'ON_ACTIVE' &&
      cachedNativeCaptionEl?.isConnected &&
      cachedNativeCaptionEl.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR) &&
      Boolean(cachedNativeCaptionEl.textContent?.trim())
    ) {
      return cachedNativeCaptionEl;
    }

    const activeTexts = extractActiveTrackTexts(video);
    if (activeTexts.length === 0) {
      return cachedNativeCaptionEl;
    }

    const found = findNativeCaptionLayer(
      playerRoot,
      activeTexts,
      ownedOverlayHost ?? doc.getElementById(SUBTITLE_OVERLAY_HOST_ID),
    );

    if (found) {
      hadPositiveNativeCaptionLayer = true;
      missingLayerCueChangesAfterClick = 0;
      awaitingUiToggleCheck = false;
      if (missingLayerConfirmTimer !== null) {
        clearTimeout(missingLayerConfirmTimer);
        missingLayerConfirmTimer = null;
      }
      if (hostCaptionsHiddenByUi) {
        hostCaptionsHiddenByUi = false;
        evaluateHtml5State(false);
        return found;
      }
      if (html5OverlayState === 'ON_ACTIVE') {
        if (cachedNativeCaptionEl && cachedNativeCaptionEl !== found) {
          cachedNativeCaptionEl.removeAttribute(NATIVE_CAPTION_HIDDEN_ATTR);
        }
        cachedNativeCaptionEl = found;
        found.setAttribute(NATIVE_CAPTION_HIDDEN_ATTR, '');
        html5SuppressionApplied = true;
      }
      return found;
    }

    if (cachedNativeCaptionEl && !cachedNativeCaptionEl.isConnected) {
      cachedNativeCaptionEl = null;
    }

    return null;
  }

  function setHtml5VideoCueSuppressedOnly(video: HTMLVideoElement | null): void {
    if (isYoutube || !video || !video.isConnected) return;
    if (
      suppressedVideoEl === video &&
      video.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)
    ) {
      return;
    }
    ensureHtml5NativeSuppressStyle();
    if (suppressedVideoEl && suppressedVideoEl !== video) {
      suppressedVideoEl.removeAttribute(NATIVE_CUE_SUPPRESSED_ATTR);
    }
    video.setAttribute(NATIVE_CUE_SUPPRESSED_ATTR, '');
    suppressedVideoEl = video;
    html5SuppressionApplied = true;
  }

  function setHtml5NativeSuppression(
    video: HTMLVideoElement | null,
    suppress: boolean,
  ): void {
    if (isYoutube) return;
    if (!suppress) {
      // P2-2 O(1) guard: never scan DOM when nothing was suppressed
      if (
        !html5SuppressionApplied &&
        !suppressedVideoEl &&
        !cachedNativeCaptionEl
      ) {
        return;
      }
      video?.removeAttribute(NATIVE_CUE_SUPPRESSED_ATTR);
      suppressedVideoEl?.removeAttribute(NATIVE_CUE_SUPPRESSED_ATTR);
      cachedNativeCaptionEl?.removeAttribute(NATIVE_CAPTION_HIDDEN_ATTR);
      suppressedVideoEl = null;
      cachedNativeCaptionEl = null;
      html5SuppressionApplied = false;
      return;
    }
    if (!video || !video.isConnected) return;
    setHtml5VideoCueSuppressedOnly(video);
    syncNativeCaptionLayerSuppression(video);
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
      const vRect = boundHtml5Video.getBoundingClientRect?.();
      const hasLayoutRect = Boolean(vRect && vRect.width > 0 && vRect.height > 0);
      let firstRectMatchedAncestor: HTMLElement | null = null;
      let anc: HTMLElement | null = boundHtml5Video.parentElement;

      for (let depth = 0; depth < 3 && anc; depth += 1) {
        if (anc === doc.body || anc === doc.documentElement) break;
        const aRect = anc.getBoundingClientRect?.();
        const rectMatches =
          !hasLayoutRect ||
          Boolean(
            aRect &&
              vRect &&
              Math.abs(aRect.width - vRect.width) <= 4 &&
              Math.abs(aRect.height - vRect.height) <= 4 &&
              Math.abs(aRect.top - vRect.top) <= 4 &&
              Math.abs(aRect.left - vRect.left) <= 4,
          );
        if (rectMatches && !firstRectMatchedAncestor) {
          firstRectMatchedAncestor = anc;
        }
        const computed = win.getComputedStyle?.(anc);
        if (rectMatches && computed && computed.position && computed.position !== 'static') {
          return anc;
        }
        anc = anc.parentElement;
      }

      const fallback = firstRectMatchedAncestor ?? boundHtml5Video.parentElement;
      const computed = win.getComputedStyle?.(fallback);
      if (computed && computed.position === 'static') {
        if (!mutatedPositionMap.has(fallback)) {
          mutatedPositionMap.set(fallback, fallback.style.position);
        }
        fallback.style.position = 'relative';
      }
      return fallback;
    }

    return null;
  }

  function computeOverlayBottomOffsetPx(
    container: HTMLElement,
    playerHeight: number,
  ): number {
    if (!isYoutube) {
      return doc.fullscreenElement ? 70 : 52;
    }

    const controlsAutoHidden =
      container.classList.contains('ytp-autohide') &&
      !container.classList.contains('ytp-settings-shown');

    if (controlsAutoHidden) {
      return playerHeight > 0
        ? Math.max(24, Math.min(56, Math.round(playerHeight * 0.048)))
        : doc.fullscreenElement
          ? 48
          : 28;
    }

    const isBig =
      Boolean(doc.fullscreenElement) ||
      container.classList.contains('ytp-big-mode');
    const fallbackVisibleBottom = isBig ? 104 : 78;

    const playerRect = container.getBoundingClientRect?.();
    const barEl =
      container.querySelector<HTMLElement>('.ytp-progress-bar-container') ??
      container.querySelector<HTMLElement>('.ytp-chrome-bottom');
    const barRect = barEl?.getBoundingClientRect?.();

    if (
      playerRect &&
      barRect &&
      playerRect.height > 0 &&
      barRect.top > playerRect.top &&
      barRect.top < playerRect.bottom
    ) {
      const clearance = Math.round(playerRect.bottom - barRect.top + 14);
      const minClearance = isBig ? 96 : 74;
      const maxClearance = isBig ? 184 : 156;
      return Math.min(maxClearance, Math.max(minClearance, clearance));
    }

    return fallbackVisibleBottom;
  }

  function syncHtml5OverlayTypographyAndOffset(
    container: HTMLElement,
    wrapper: HTMLElement,
    cueForStyle?: MarginActiveCueState,
  ): void {
    const isFs = Boolean(doc.fullscreenElement);
    const vRect = boundHtml5Video
      ? resolveEffectiveVideoRect(boundHtml5Video)
      : null;
    const playerHeight =
      container.getBoundingClientRect?.().height ||
      container.clientHeight ||
      vRect?.height ||
      0;

    const styleSource = cueForStyle ?? activeCueState;
    const origPct = clampFontSizePercent(styleSource.sourceScalePercent, 100);
    const transPct = clampFontSizePercent(
      styleSource.translationScalePercent ?? styleSource.fontSizePercent,
      70,
    );
    const targetLang = normalizeSubtitleTargetLang(
      styleSource.targetLang || config.targetLang || 'zh-CN',
    );
    const scaleMult = styleSource.nativeTheme?.fontScaleMultiplier ?? 1;

    const typo = computeHtml5CaptionTypography({
      heightPx: playerHeight,
      fullscreen: isFs,
      origPct,
      transPct,
      targetLang,
      scaleMult,
      bgOpacityPercent: styleSource.bgOpacityPercent,
    });

    const recentPointer =
      lastPointerActivityAt > 0 &&
      Date.now() - lastPointerActivityAt <= HTML5_CONTROLS_AUTOHIDE_IDLE_MS;
    const bottomPx = computeHtml5BottomOffset({
      container,
      playerRoot: resolveHtml5PlayerRoot(boundHtml5Video),
      video: boundHtml5Video,
      heightPx: playerHeight,
      fullscreen: isFs,
      paused: Boolean(boundHtml5Video?.paused),
      recentPointerActivity: recentPointer,
      getComputedStyleFn: win.getComputedStyle
        ? (el) => win.getComputedStyle(el)
        : undefined,
    });

    const cjkTail = resolveSubtitleCjkFallbackForLang(targetLang);
    wrapper.style.setProperty('--margin-sub-trans-px', `${typo.transPx}px`);
    wrapper.style.setProperty('--margin-sub-orig-px', `${typo.origPx}px`);
    wrapper.style.setProperty('--margin-cap-pad-y', `${typo.padY}px`);
    wrapper.style.setProperty('--margin-cap-pad-x', `${typo.padX}px`);
    wrapper.style.setProperty('--margin-cap-radius', `${typo.radius}px`);
    wrapper.style.setProperty('--margin-cap-bg', typo.capBg);
    wrapper.style.setProperty(
      '--margin-html5-trans-font-family',
      `Chirp, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, ${cjkTail}`,
    );
    wrapper.style.setProperty('--margin-sub-bottom-px', `${bottomPx}px`);
  }

  function syncOverlayBaseFontSize(
    container: HTMLElement,
    wrapper: HTMLElement,
    cueForStyle?: MarginActiveCueState,
  ): void {
    if (!isYoutube) {
      syncHtml5OverlayTypographyAndOffset(container, wrapper, cueForStyle);
      return;
    }

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
    const bottomPx = computeOverlayBottomOffsetPx(container, playerHeight);
    wrapper.style.setProperty('--margin-sub-base-px', `${basePx}px`);
    wrapper.style.setProperty('--margin-sub-bottom-px', `${bottomPx}px`);
  }

  function syncHtml5OverlayLayout(): void {
    if (destroyed || isYoutube) return;
    const host = doc.getElementById(SUBTITLE_OVERLAY_HOST_ID);
    const wrapper = host?.shadowRoot?.getElementById('margin-sub-wrap');
    const container = host?.parentElement;
    if (wrapper && container) {
      syncHtml5OverlayTypographyAndOffset(container, wrapper, activeCueState);
    }
  }

  function ensurePlayerResizeObserver(container: HTMLElement): void {
    if (typeof ResizeObserver !== 'undefined') {
      if (observedPlayerContainer !== container || !playerResizeObserver) {
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
    }

    if (
      isYoutube &&
      typeof MutationObserver !== 'undefined' &&
      (observedClassContainer !== container || !playerClassObserver)
    ) {
      playerClassObserver?.disconnect();
      observedClassContainer = container;
      playerClassObserver = new MutationObserver(() => {
        if (destroyed) return;
        const host = doc.getElementById(SUBTITLE_OVERLAY_HOST_ID);
        const wrapper = host?.shadowRoot?.getElementById('margin-sub-wrap');
        if (wrapper) {
          syncOverlayBaseFontSize(container, wrapper);
        }
      });
      playerClassObserver.observe(container, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }
  }

  function buildHtml5StyleSignature(
    cue: MarginActiveCueState,
    isFs: boolean,
  ): string {
    const origPct = clampFontSizePercent(cue.sourceScalePercent, 100);
    const transPct = clampFontSizePercent(
      cue.translationScalePercent ?? cue.fontSizePercent,
      70,
    );
    const lang = normalizeSubtitleTargetLang(
      cue.targetLang || config.targetLang || 'zh-CN',
    );
    const mult = cue.nativeTheme?.fontScaleMultiplier ?? 1;
    return `${isFs ? 1 : 0}|${origPct}|${transPct}|${lang}|${cue.bgOpacityPercent ?? ''}|${mult}`;
  }

  function ensureOverlayShadowRoot(
    cueForStyle?: MarginActiveCueState,
  ): ShadowRoot | null {
    const container = findOverlayMountContainer();
    if (!container) return null;

    let host = doc.getElementById(SUBTITLE_OVERLAY_HOST_ID) as HTMLElement | null;
    if (host && host.getAttribute(OVERLAY_OWNER_ATTR) !== instanceId) {
      host.remove();
      host = null;
    }
    let createdNewHost = false;
    if (!host) {
      createdNewHost = true;
      host = doc.createElement('div');
      host.id = SUBTITLE_OVERLAY_HOST_ID;
      host.setAttribute(`${BRAND.domAttrPrefix}-injected`, 'subtitle-overlay');
      const shadow = host.attachShadow({ mode: 'open' });

      const style = doc.createElement('style');
      style.textContent = buildInPlayerOverlayCss();

      const wrapper = doc.createElement('div');
      wrapper.id = 'margin-sub-wrap';
      wrapper.dataset.surface = isYoutube ? 'youtube' : 'html5';
      wrapper.dataset.mode = config.subtitles.displayMode;
      wrapper.dataset.position = config.subtitles.position;
      wrapper.dataset.stylePreset = normalizeSubtitleStylePreset(
        config.subtitles.stylePreset,
      );
      wrapper.hidden = true;

      const origLine = doc.createElement('div');
      origLine.id = 'margin-sub-original';
      origLine.className = 'margin-sub-line margin-sub-original margin-sub-line--orig';
      origLine.hidden = true;
      const origSeg = doc.createElement('span');
      origSeg.className = 'margin-sub-seg';
      origLine.appendChild(origSeg);

      const transLine = doc.createElement('div');
      transLine.id = 'margin-sub-translated';
      transLine.className = 'margin-sub-line margin-sub-translated margin-sub-line--trans';
      transLine.hidden = true;
      const transSeg = doc.createElement('span');
      transSeg.className = 'margin-sub-seg';
      transLine.appendChild(transSeg);

      wrapper.append(origLine, transLine);
      shadow.append(style, wrapper);
    }

    host.setAttribute(OVERLAY_OWNER_ATTR, instanceId);
    ownedOverlayHost = host;

    let didReparent = false;
    if (host.parentElement !== container) {
      container.appendChild(host);
      didReparent = true;
    }

    ensurePlayerResizeObserver(container);
    const isFullscreen = Boolean(doc.fullscreenElement);
    const wrapper = host.shadowRoot?.getElementById('margin-sub-wrap');
    if (wrapper) {
      if (isYoutube) {
        syncOverlayBaseFontSize(container, wrapper);
      } else if (createdNewHost || didReparent) {
        const effectiveCue = cueForStyle ?? activeCueState;
        syncHtml5OverlayTypographyAndOffset(container, wrapper, effectiveCue);
        lastAppliedStyleSig = buildHtml5StyleSignature(
          effectiveCue,
          isFullscreen,
        );
      }
    }

    host.toggleAttribute('data-fullscreen', isFullscreen);
    host.setAttribute('data-display-mode', 'night');

    return host.shadowRoot;
  }

  function removeOverlayHost(options: { contextInvalidated?: boolean } = {}): void {
    // P2-2 fast skip on HTML5 when no overlay or suppression is mounted
    if (
      !isYoutube &&
      !ownedOverlayHost &&
      !playerResizeObserver &&
      !html5SuppressionApplied &&
      !suppressedVideoEl &&
      !cachedNativeCaptionEl &&
      !doc.getElementById(SUBTITLE_OVERLAY_HOST_ID)
    ) {
      return;
    }

    playerResizeObserver?.disconnect();
    playerResizeObserver = null;
    observedPlayerContainer = null;
    playerClassObserver?.disconnect();
    playerClassObserver = null;
    observedClassContainer = null;
    lastAppliedStyleSig = '';

    const ownedOwner = ownedOverlayHost?.getAttribute(OVERLAY_OWNER_ATTR) ?? '';
    if (
      ownedOverlayHost &&
      (!options.contextInvalidated || !ownedOwner || ownedOwner === instanceId)
    ) {
      ownedOverlayHost.remove();
    }
    ownedOverlayHost = null;

    const existingHost = doc.getElementById(SUBTITLE_OVERLAY_HOST_ID);
    const existingOwner = existingHost?.getAttribute(OVERLAY_OWNER_ATTR) ?? '';
    const ownedByOtherInstance = Boolean(
      existingHost && existingOwner && existingOwner !== instanceId,
    );
    if (!options.contextInvalidated || !ownedByOtherInstance) {
      existingHost?.remove();
    }

    const remainingHost = doc.getElementById(SUBTITLE_OVERLAY_HOST_ID);
    const remainingOwner = remainingHost?.getAttribute(OVERLAY_OWNER_ATTR) ?? '';
    const hasOtherMountedOwner = Boolean(
      remainingHost?.isConnected &&
        remainingOwner &&
        remainingOwner !== instanceId,
    );
    if (!hasOtherMountedOwner) {
      if (isYoutube) {
        setNativeYoutubeCaptionSuppression(false);
      } else {
        setHtml5NativeSuppression(boundHtml5Video, false);
      }
    }
  }

  function applyOverlayDom(cue: MarginActiveCueState): void {
    if (
      !isSubtitlesEnabledForSite() ||
      !isHtml5OverlayActive() ||
      scheduler.getCues().length === 0
    ) {
      renderedCueState = cue;
      removeOverlayHost();
      return;
    }

    const shadow = ensureOverlayShadowRoot(cue);
    const wrapper = shadow?.getElementById('margin-sub-wrap');
    const origEl = shadow?.getElementById('margin-sub-original');
    const transEl = shadow?.getElementById('margin-sub-translated');
    if (!shadow || !wrapper || !origEl || !transEl) {
      renderedCueState = normalizeActiveCueState(buildConfiguredCueDefaults());
      if (isYoutube) {
        setNativeYoutubeCaptionSuppression(false);
      } else {
        setHtml5NativeSuppression(boundHtml5Video, false);
      }
      return;
    }

    renderedCueState = cue;
    if (isYoutube) {
      setNativeYoutubeCaptionSuppression(true);
    } else {
      // P2-1: set only the `<video>` attribute here; TreeWalker runs strictly on ON_ACTIVE entry, cuechange & click recheck
      setHtml5VideoCueSuppressedOnly(boundHtml5Video);
    }

    const origPct = clampFontSizePercent(cue.sourceScalePercent, 100);
    const transPct = clampFontSizePercent(
      cue.translationScalePercent ?? cue.fontSizePercent,
      70,
    );
    const preset = normalizeSubtitleStylePreset(cue.stylePreset);
    const isFs = Boolean(doc.fullscreenElement);
    wrapper.style.setProperty('--margin-sub-orig-scale', (origPct / 100).toFixed(3));
    wrapper.style.setProperty('--margin-sub-trans-scale', (transPct / 100).toFixed(3));
    applyNativeThemeVariablesToElement(wrapper, cue);
    wrapper.dataset.surface = isYoutube ? 'youtube' : 'html5';
    wrapper.dataset.mode = cue.mode;
    wrapper.dataset.stylePreset = preset;
    wrapper.dataset.position = cue.position;
    wrapper.toggleAttribute('data-fullscreen', isFs);

    if (!isYoutube && ownedOverlayHost?.parentElement) {
      const nextStyleSig = buildHtml5StyleSignature(cue, isFs);
      if (nextStyleSig !== lastAppliedStyleSig) {
        syncHtml5OverlayTypographyAndOffset(
          ownedOverlayHost.parentElement,
          wrapper,
          cue,
        );
        lastAppliedStyleSig = nextStyleSig;
      }
    }

    const { originalLine, translatedLine } = resolveRenderedCueLines(cue);

    let origSeg = origEl.querySelector<HTMLElement>('.margin-sub-seg');
    if (!origSeg) {
      origSeg = doc.createElement('span');
      origSeg.className = 'margin-sub-seg';
      origEl.replaceChildren(origSeg);
    }
    origSeg.textContent = originalLine;
    origEl.hidden = !originalLine;

    const targetBcp47 = normalizeSubtitleTargetLang(cue.targetLang);
    if (targetBcp47) {
      transEl.setAttribute('lang', targetBcp47);
      transEl.setAttribute('dir', resolveSubtitleTargetDir(targetBcp47));
    } else {
      transEl.removeAttribute('lang');
      transEl.removeAttribute('dir');
    }

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
      normalized.targetLang !== activeCueState.targetLang ||
      normalized.fontSizePercent !== activeCueState.fontSizePercent ||
      normalized.sourceScalePercent !== activeCueState.sourceScalePercent ||
      normalized.translationScalePercent !== activeCueState.translationScalePercent ||
      normalized.stylePreset !== activeCueState.stylePreset ||
      normalized.bgOpacityPercent !== activeCueState.bgOpacityPercent ||
      normalized.translationTint !== activeCueState.translationTint ||
      !areYoutubeNativeThemesEqual(
        normalized.nativeTheme,
        activeCueState.nativeTheme,
      ) ||
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
    if (!isSubtitlesEnabledForSite() || !isHtml5OverlayActive()) {
      cancelClearTimer();
      removeOverlayHost();
      if (
        isYoutube ||
        activeCueState.original ||
        activeCueState.translated ||
        renderedCueState.original ||
        renderedCueState.translated
      ) {
        const empty = normalizeActiveCueState(buildConfiguredCueDefaults());
        activeCueState = empty;
        renderedCueState = empty;
        broadcastActiveCue(empty);
      }
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

  function resolveActiveYoutubePageVideoId(): string {
    return (
      extractYoutubeVideoId(win.location?.href ?? '') ||
      doc.querySelector('ytd-watch-flexy')?.getAttribute('video-id') ||
      ''
    );
  }

  function stashCapturedTrackForVideo(item: StashedCaptionCapture): void {
    const existingList = stashedCapturesByVideoId.get(item.videoId);
    let list: StashedCaptionCapture[];
    if (existingList) {
      stashedCapturesByVideoId.delete(item.videoId);
      list = existingList.filter((entry) => entry.trackUrl !== item.trackUrl);
    } else {
      if (stashedCapturesByVideoId.size >= MAX_STASHED_VIDEOS) {
        const oldestKey = stashedCapturesByVideoId.keys().next().value;
        if (oldestKey !== undefined) {
          stashedCapturesByVideoId.delete(oldestKey);
        }
      }
      list = [];
    }
    if (list.length >= MAX_STASHED_CAPTURES_PER_VIDEO) {
      list.shift();
    }
    list.push(item);
    stashedCapturesByVideoId.set(item.videoId, list);
  }

  function processCapturedCaptionTrack(capture: StashedCaptionCapture): void {
    const { videoId, langCode, trackUrl, events } = capture;
    const normalized = normalizeYoutubeEvents(events);
    if (normalized.length === 0) return;

    const tlang = isTranslatedYoutubeTrackUrl(trackUrl);
    const existingCues = scheduler.getCues();

    // Only merge YouTube `tlang` tracks into `cue.trans` when normalized `tlang` matches `config.targetLang`
    if (tlang) {
      const normalizedTlang = normalizeSubtitleTargetLang(tlang);
      const normalizedTarget = normalizeSubtitleTargetLang(
        config.targetLang || 'zh-CN',
      );
      if (
        normalizedTlang &&
        normalizedTarget &&
        normalizedTlang === normalizedTarget &&
        currentVideoKey === videoId &&
        existingCues.length > 0
      ) {
        const merged = mergeAlignedSubtitleTrack(existingCues, normalized);
        if (merged.applied) {
          scheduler.loadCues(videoId, merged.cues, currentPlayheadMs);
          refreshActiveCueFromPlayhead();
        }
      }
      return;
    }

    const nextFingerprint = buildSourceTrackFingerprint(
      videoId,
      langCode || 'auto',
      normalized,
      trackUrl,
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

  function drainStashedCapturesForVideo(videoId: string): boolean {
    const stashed = stashedCapturesByVideoId.get(videoId);
    if (!stashed || stashed.length === 0) return false;
    stashedCapturesByVideoId.delete(videoId);
    for (const item of stashed) {
      processCapturedCaptionTrack(item);
    }
    return true;
  }

  function syncYoutubePageVideoTransition(requestMissingFromMain = false): void {
    if (destroyed || !isYoutube) return;
    const activePageVideoId = resolveActiveYoutubePageVideoId();
    if (!activePageVideoId) return;
    if (currentVideoKey && currentVideoKey !== activePageVideoId) {
      currentVideoKey = activePageVideoId;
      activeSourceTrackFingerprint = '';
      const video = doc.querySelector<HTMLVideoElement>('video.html5-main-video');
      currentPlayheadMs = video
        ? Math.max(0, Math.round((video.currentTime || 0) * 1000))
        : 0;
      scheduler.loadCues(activePageVideoId, [], currentPlayheadMs);
      refreshActiveCueFromPlayhead();
    }
    const drained = drainStashedCapturesForVideo(activePageVideoId);
    if (!drained && requestMissingFromMain && scheduler.getCues().length === 0) {
      postToYoutubeMain({
        source: BRAND.ytBridgeSourceIsolated,
        type: 'request-active-captions',
        videoId: activePageVideoId,
      });
    }
  }

  function handleYoutubeNavigation(): void {
    if (destroyed || !isYoutube) return;
    if (!isExtensionContextValid(hadRuntimeIdAtStart)) {
      destroy({ contextInvalidated: true });
      return;
    }
    syncYoutubePageVideoTransition(true);
  }

  function handleYoutubeBridgeMessage(event: MessageEvent): void {
    if (destroyed || !isYoutube || !isSameWindowMessage(event)) return;
    if (!isExtensionContextValid(hadRuntimeIdAtStart)) {
      destroy({ contextInvalidated: true });
      return;
    }
    const msg = event.data as Partial<YoutubeExtendedBridgeMessage> | null;
    if (!msg || typeof msg !== 'object' || msg.source !== BRAND.ytBridgeSourceMain) {
      return;
    }

    if (msg.type === 'main-controller-ready') {
      if (configLoaded) {
        broadcastSubtitleConfig();
      }
      return;
    }

    if (msg.type === 'native-caption-style-update' && msg.theme) {
      hasReceivedMainThemeBridge = true;
      if (!areYoutubeNativeThemesEqual(currentNativeTheme, msg.theme)) {
        currentNativeTheme = msg.theme;
        refreshActiveCueFromPlayhead();
      }
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
        const activeVid = resolveActiveYoutubePageVideoId();
        if (activeVid && stashedCapturesByVideoId.has(activeVid)) {
          drainStashedCapturesForVideo(activeVid);
        }
        if (scheduler.getCues().length === 0 && activeVid) {
          postToYoutubeMain({
            source: BRAND.ytBridgeSourceIsolated,
            type: 'request-active-captions',
            videoId: activeVid,
          });
        }
        scheduler.updatePlayhead(currentPlayheadMs);
        refreshActiveCueFromPlayhead();
      }
      return;
    }

    if (msg.type === 'playhead-tick') {
      if (typeof msg.currentTimeMs !== 'number') return;
      const activePageVideoId = resolveActiveYoutubePageVideoId();
      if (msg.videoId && activePageVideoId && msg.videoId !== activePageVideoId) {
        return;
      }
      const targetVideoId = msg.videoId || activePageVideoId;
      currentPlayheadMs = msg.currentTimeMs;
      if (targetVideoId && currentVideoKey && targetVideoId !== currentVideoKey) {
        currentVideoKey = targetVideoId;
        activeSourceTrackFingerprint = '';
        scheduler.loadCues(targetVideoId, [], msg.currentTimeMs);
      }
      if (configLoaded && targetVideoId && stashedCapturesByVideoId.has(targetVideoId)) {
        drainStashedCapturesForVideo(targetVideoId);
      }
      if (configLoaded && isSubtitlesEnabledForSite()) {
        scheduler.updatePlayhead(
          currentPlayheadMs,
          msg.seeked ? { seek: true } : undefined,
        );
      }
      if (configLoaded) {
        refreshActiveCueFromPlayhead();
      }
      return;
    }

    if (msg.type === 'caption-track-captured' && Array.isArray(msg.events)) {
      const activePageVideoId = resolveActiveYoutubePageVideoId();
      const trackUrlVideoId = extractYoutubeVideoId(msg.trackUrl ?? '');
      const videoId = trackUrlVideoId || msg.videoId || activePageVideoId;
      if (!videoId) return;

      // Defer processing until initial config loads from storage, or when SPA timedtext arrives before URL updates
      if (!configLoaded || (activePageVideoId && videoId !== activePageVideoId)) {
        if (msg.events.length > 0) {
          stashCapturedTrackForVideo({
            videoId,
            langCode: msg.langCode ?? 'auto',
            trackUrl: msg.trackUrl ?? '',
            events: msg.events,
          });
        }
        return;
      }

      drainStashedCapturesForVideo(videoId);
      processCapturedCaptionTrack({
        videoId,
        langCode: msg.langCode ?? 'auto',
        trackUrl: msg.trackUrl ?? '',
        events: msg.events,
      });
    }
  }

  function scheduleTwoRafs(callback: () => void): void {
    const token = captionLayerRafToken;
    const raf =
      win.requestAnimationFrame?.bind(win) ??
      ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16));
    raf(() => {
      if (destroyed || captionLayerRafToken !== token) return;
      raf(() => {
        if (destroyed || captionLayerRafToken !== token) return;
        callback();
      });
    });
  }

  function clearHtml5BoundTimers(): void {
    if (dwellTimer !== null) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }
    dwellVideo = null;
    if (uiClickRecheckTimer !== null) {
      clearTimeout(uiClickRecheckTimer);
      uiClickRecheckTimer = null;
    }
    if (missingLayerConfirmTimer !== null) {
      clearTimeout(missingLayerConfirmTimer);
      missingLayerConfirmTimer = null;
    }
    if (controlsFadeTimer !== null) {
      clearTimeout(controlsFadeTimer);
      controlsFadeTimer = null;
    }
    captionLayerRafToken += 1;
  }

  function unbindHtml5Video(): void {
    html5TrackLoadGen += 1;
    clearHtml5BoundTimers();
    detachPickedTrackListener?.();
    detachPickedTrackListener = null;
    activePickedTrack = null;
    detachHtml5Listeners?.();
    detachHtml5Listeners = null;

    const prevVideo = boundHtml5Video;
    if (prevVideo && !prevVideo.isConnected) {
      engagedVideos.delete(prevVideo);
    }
    boundHtml5Video = null;
    boundHtml5PlayerRoot = null;
    activeHtml5VideoIdentity = '';
    currentVideoKey = '';
    html5OverlayState = 'OFF';
    lastPolledCueCount = -1;
    lastPolledLastEndTime = -1;
    lastSentPlayheadMs = -1;
    pausedAfterPlay = false;
    hadPositiveNativeCaptionLayer = false;
    awaitingUiToggleCheck = false;
    missingLayerCueChangesAfterClick = 0;
    hostCaptionsHiddenByUi = false;
    videoTranslationMemo.clear();

    setHtml5NativeSuppression(prevVideo, false);
    restoreMutatedPositions();
    scheduler.setDispatchGate(false);
    scheduler.cancelAll();
    scheduler.loadCues('', [], 0);
    cancelClearTimer();
    removeOverlayHost();
    const empty = normalizeActiveCueState(buildConfiguredCueDefaults());
    activeCueState = empty;
    renderedCueState = empty;
  }

  function isImmediateVideoEngaged(video: HTMLVideoElement): boolean {
    if (engagedVideos.has(video)) return true;
    const volumeOk = video.volume === undefined || Number(video.volume) > 0;
    if (!video.muted && volumeOk) {
      engagedVideos.add(video);
      return true;
    }
    const fsEl = doc.fullscreenElement;
    if (fsEl && (fsEl === video || fsEl.contains(video))) {
      engagedVideos.add(video);
      return true;
    }
    const pipWin = (
      win as Window & {
        documentPictureInPicture?: { window?: Window | null };
      }
    ).documentPictureInPicture?.window;
    if ((pipWin && !pipWin.closed) || doc.pictureInPictureElement === video) {
      engagedVideos.add(video);
      return true;
    }
    return false;
  }

  function resolveHtml5EngageDwellMs(video: HTMLVideoElement): number {
    const pathname = win.location?.pathname ?? '';
    if (!/\/status\/[^/?#]+/.test(pathname)) {
      return HTML5_ENGAGE_DWELL_MS;
    }
    const vp = resolveViewportSize(doc);
    const allVideos = Array.from(doc.querySelectorAll('video'));
    let maxArea = 0;
    let targetArea = 0;
    for (const candidate of allVideos) {
      if (!candidate.isConnected) continue;
      const rect = resolveEffectiveVideoRect(candidate, vp);
      const ratio = computeVisibleRatio(rect, vp);
      const visArea = rect.width * rect.height * ratio;
      if (candidate === video) targetArea = visArea;
      if (visArea > maxArea) maxArea = visArea;
    }
    return targetArea > 0 && targetArea >= maxArea
      ? HTML5_STATUS_DWELL_MS
      : HTML5_ENGAGE_DWELL_MS;
  }

  function updateHtml5DispatchGate(video: HTMLVideoElement): void {
    if (
      html5OverlayState !== 'ON_ACTIVE' ||
      doc.hidden ||
      !isSubtitlesEnabledForSite()
    ) {
      scheduler.setDispatchGate(false);
      return;
    }
    const ratio = computeVisibleRatio(video);
    if (ratio < 0.5) {
      scheduler.setDispatchGate(false);
      return;
    }
    if (!video.paused) {
      scheduler.setDispatchGate(true);
      return;
    }
    // Allow translating the currently active cue on an unpaused-yet `showing` track (e.g. paused lecture load / track switch)
    if (!pausedAfterPlay && pickCaptionTrack(video)?.mode === 'showing') {
      const cues = scheduler.getCues();
      const idx = findActiveCueIndex(cues, currentPlayheadMs);
      const needsActiveCue = idx >= 0 && !cues[idx]?.trans;
      scheduler.setDispatchGate(needsActiveCue);
      return;
    }
    scheduler.setDispatchGate(false);
  }

  function attachPickedTrackCueListener(
    video: HTMLVideoElement,
    track: TextTrack,
  ): void {
    if (activePickedTrack === track) return;
    detachPickedTrackListener?.();
    detachPickedTrackListener = null;
    activePickedTrack = track;
    lastPolledCueCount = -1;
    lastPolledLastEndTime = -1;

    if (typeof track.addEventListener !== 'function') return;
    const onCueChange = () => {
      if (destroyed || boundHtml5Video !== video || activePickedTrack !== track) {
        return;
      }
      currentPlayheadMs = Math.max(0, Math.round((video.currentTime || 0) * 1000));
      void ingestHtml5VideoTracks(video, false);
      refreshActiveCueFromPlayhead();
      if (html5OverlayState === 'ON_ACTIVE') {
        syncNativeCaptionLayerSuppression(video);
      }
      scheduleTwoRafs(() => {
        if (destroyed || boundHtml5Video !== video || activePickedTrack !== track) {
          return;
        }
        const foundAtRaf = syncNativeCaptionLayerSuppression(video, {
          forceScan: awaitingUiToggleCheck || hostCaptionsHiddenByUi,
        });
        // P2-5: require BOTH 2xrAF AND a +250ms confirmation check to fail before counting a missing layer
        if (
          !foundAtRaf &&
          awaitingUiToggleCheck &&
          hadPositiveNativeCaptionLayer &&
          extractActiveTrackTexts(video).length > 0
        ) {
          if (missingLayerConfirmTimer !== null) {
            clearTimeout(missingLayerConfirmTimer);
          }
          const checkGen = html5TrackLoadGen;
          missingLayerConfirmTimer = setTimeout(() => {
            missingLayerConfirmTimer = null;
            if (
              destroyed ||
              checkGen !== html5TrackLoadGen ||
              boundHtml5Video !== video ||
              activePickedTrack !== track ||
              !awaitingUiToggleCheck ||
              !hadPositiveNativeCaptionLayer
            ) {
              return;
            }
            if (extractActiveTrackTexts(video).length === 0) return;
            const foundAfterDelay = syncNativeCaptionLayerSuppression(video, {
              forceScan: true,
            });
            if (!foundAfterDelay) {
              missingLayerCueChangesAfterClick += 1;
              if (missingLayerCueChangesAfterClick >= 2) {
                hostCaptionsHiddenByUi = true;
                awaitingUiToggleCheck = false;
                missingLayerCueChangesAfterClick = 0;
                evaluateHtml5State(false);
              }
            }
          }, 250);
        }
      });
    };
    track.addEventListener('cuechange', onCueChange);
    detachPickedTrackListener = () => {
      track.removeEventListener?.('cuechange', onCueChange);
    };
  }

  async function ingestHtml5VideoTracks(
    video: HTMLVideoElement,
    forceCheck = false,
  ): Promise<void> {
    if (destroyed || isYoutube || boundHtml5Video !== video || !isSubtitlesEnabledForSite()) {
      return;
    }
    const picked = pickCaptionTrack(video);
    if (!picked) {
      detachPickedTrackListener?.();
      detachPickedTrackListener = null;
      activePickedTrack = null;
      return;
    }

    attachPickedTrackCueListener(video, picked);

    const videoIdentity = getHtml5VideoIdentity(video);
    const trackIdentity = buildHtml5TrackIdentity(video, picked);
    const key = `html5:${videoIdentity}::${trackIdentity}`;

    const cueList = picked.cues as unknown as
      | ArrayLike<{ startTime: number; endTime: number; text?: string }>
      | null
      | undefined;
    const cueCount = cueList && typeof cueList.length === 'number' ? cueList.length : 0;
    const lastEndTime =
      cueCount > 0 ? Number(cueList![cueCount - 1]?.endTime ?? -1) : -1;

    if (cueCount > 0) {
      if (
        !forceCheck &&
        currentVideoKey === key &&
        cueCount === lastPolledCueCount &&
        lastEndTime === lastPolledLastEndTime &&
        scheduler.getCues().length > 0
      ) {
        return;
      }
      lastPolledCueCount = cueCount;
      lastPolledLastEndTime = lastEndTime;

      const extracted = extractTextTrackCues(cueList);
      if (extracted.length === 0) return;

      if (currentVideoKey !== key) {
        currentVideoKey = key;
        currentPlayheadMs = Math.max(0, Math.round((video.currentTime || 0) * 1000));
        lastSentPlayheadMs = currentPlayheadMs;
        syncSchedulerConfig();
        const normalized = mergeHtml5Cues([], extracted, videoTranslationMemo).cues;
        scheduler.loadCues(key, normalized, currentPlayheadMs);
        updateHtml5DispatchGate(video);
        refreshActiveCueFromPlayhead();
        return;
      }

      const existing = scheduler.getCues();
      const merged = mergeHtml5Cues(existing, extracted, videoTranslationMemo);
      for (const upd of merged.durationUpdates) {
        scheduler.updateCueDuration(upd.index, upd.dDurationMs);
      }

      if (merged.kind === 'append') {
        scheduler.appendCues(merged.appended);
        updateHtml5DispatchGate(video);
        refreshActiveCueFromPlayhead();
      } else if (merged.kind === 'rebuild') {
        currentPlayheadMs = Math.max(0, Math.round((video.currentTime || 0) * 1000));
        lastSentPlayheadMs = currentPlayheadMs;
        syncSchedulerConfig();
        scheduler.loadCues(key, merged.cues, currentPlayheadMs);
        updateHtml5DispatchGate(video);
        refreshActiveCueFromPlayhead();
      } else if (merged.durationUpdates.length > 0) {
        refreshActiveCueFromPlayhead();
      }
      return;
    }

    // Transient empty `cues` on an already-loaded active track -> noop (keep existing cues)
    if (currentVideoKey === key && scheduler.getCues().length > 0) {
      return;
    }

    // Fallback: fetch `<track src="...vtt">` ONLY for the active showing/hidden track when `cues` is empty/null
    const trackEls = Array.from(
      video.querySelectorAll<HTMLTrackElement>(
        'track[kind="subtitles"], track[kind="captions"], track:not([kind])',
      ),
    );
    const matchedTrackEl =
      trackEls.find(
        (el) =>
          (picked.language && el.srclang === picked.language) ||
          (picked.label && el.label === picked.label),
      ) ??
      trackEls.find((el) => el.default) ??
      (trackEls.length === 1 ? trackEls[0] : undefined);

    if (!matchedTrackEl?.src) return;

    const vttKey = `html5-vtt:${videoIdentity}::${matchedTrackEl.src}::${matchedTrackEl.srclang || ''}::${matchedTrackEl.label || ''}`;
    if (currentVideoKey === vttKey && scheduler.getCues().length > 0) return;

    const loadGen = ++html5TrackLoadGen;
    try {
      const res = await win.fetch(matchedTrackEl.src, { credentials: 'same-origin' });
      if (!res.ok) return;
      const vttText = await res.text();
      const parsed = parseWebVtt(vttText);
      if (
        parsed.length === 0 ||
        destroyed ||
        loadGen !== html5TrackLoadGen ||
        boundHtml5Video !== video ||
        pickCaptionTrack(video) !== picked ||
        !isSubtitlesEnabledForSite()
      ) {
        return;
      }

      const durationSec = Number(video.duration);
      const durationMs =
        Number.isFinite(durationSec) && durationSec > 0
          ? durationSec * 1000
          : undefined;
      const rebased = rebaseSmpteBroadcastOffset(parsed, durationMs);

      currentVideoKey = vttKey;
      currentPlayheadMs = Math.max(0, Math.round((video.currentTime || 0) * 1000));
      syncSchedulerConfig();
      scheduler.loadCues(vttKey, rebased, currentPlayheadMs);
      updateHtml5DispatchGate(video);
      refreshActiveCueFromPlayhead();
    } catch {
      // Ignore cross-origin track fetch blocks
    }
  }

  function evaluateHtml5State(forceTrackCheck = false): void {
    if (destroyed || isYoutube) return;
    if (!isSubtitlesEnabledForSite()) {
      if (boundHtml5Video) unbindHtml5Video();
      return;
    }
    const video = boundHtml5Video;
    if (!video || !video.isConnected) {
      if (video) unbindHtml5Video();
      return;
    }

    const nextIdentity = getHtml5VideoIdentity(video);
    if (activeHtml5VideoIdentity && activeHtml5VideoIdentity !== nextIdentity) {
      currentVideoKey = '';
      lastPolledCueCount = -1;
      lastPolledLastEndTime = -1;
      lastSentPlayheadMs = -1;
      pausedAfterPlay = false;
      hostCaptionsHiddenByUi = false;
      awaitingUiToggleCheck = false;
      missingLayerCueChangesAfterClick = 0;
      videoTranslationMemo.clear();
      scheduler.setDispatchGate(false);
      scheduler.cancelAll();
      scheduler.loadCues(
        '',
        [],
        Math.max(0, Math.round((video.currentTime || 0) * 1000)),
      );
    }
    activeHtml5VideoIdentity = nextIdentity;

    const rawHostOn = isHostCaptionsOn(video);
    if (!rawHostOn) {
      hostCaptionsHiddenByUi = false;
    }
    const ccOn = rawHostOn && !hostCaptionsHiddenByUi;

    if (!ccOn) {
      if (dwellTimer !== null) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
        dwellVideo = null;
      }
      if (!rawHostOn) {
        detachPickedTrackListener?.();
        detachPickedTrackListener = null;
        activePickedTrack = null;
      } else {
        // P2-5: while `hostCaptionsHiddenByUi` is set on a `hidden` track, keep cuechange listener
        // attached so a CC-ON click made during a gap between cues recovers on the next cue!
        const picked = pickCaptionTrack(video);
        if (picked) {
          attachPickedTrackCueListener(video, picked);
        }
      }
      html5OverlayState = 'OFF';
      scheduler.setDispatchGate(false);
      scheduler.cancelAll();
      setHtml5NativeSuppression(video, false);
      refreshActiveCueFromPlayhead();
      return;
    }

    currentPlayheadMs = Math.max(0, Math.round((video.currentTime || 0) * 1000));
    void ingestHtml5VideoTracks(video, forceTrackCheck);

    const engaged = isImmediateVideoEngaged(video);
    const vp = resolveViewportSize(doc);
    const ratio = computeVisibleRatio(video, vp);
    const playingVis = isHtml5VideoPlayingVisible(video, vp);

    if (!engaged) {
      if (playingVis && !doc.hidden) {
        if (dwellTimer === null || dwellVideo !== video) {
          if (dwellTimer !== null) clearTimeout(dwellTimer);
          dwellVideo = video;
          const dwellMs = resolveHtml5EngageDwellMs(video);
          dwellTimer = setTimeout(() => {
            dwellTimer = null;
            dwellVideo = null;
            if (
              !destroyed &&
              boundHtml5Video === video &&
              !doc.hidden &&
              isHostCaptionsOn(video) &&
              !hostCaptionsHiddenByUi &&
              isHtml5VideoPlayingVisible(video)
            ) {
              engagedVideos.add(video);
              evaluateHtml5State(false);
            }
          }, dwellMs);
        }
      } else if (dwellTimer !== null) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
        dwellVideo = null;
      }
    } else if (dwellTimer !== null) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
      dwellVideo = null;
    }

    if (!engaged || ratio < 0.25 || doc.hidden) {
      html5OverlayState = 'ON_IDLE';
      scheduler.setDispatchGate(false);
      setHtml5NativeSuppression(video, false);
      refreshActiveCueFromPlayhead();
      return;
    }

    const wasActive = html5OverlayState === 'ON_ACTIVE';
    html5OverlayState = 'ON_ACTIVE';
    // P2-3: do NOT call `scheduler.updatePlayhead` unconditionally here (delta===0 would trigger seek retries at 2 Hz);
    // `updateHtml5DispatchGate` already calls `pump()`, and playhead ticks/seeks call `updatePlayhead` on real movement.
    updateHtml5DispatchGate(video);
    refreshActiveCueFromPlayhead();
    if (!wasActive && scheduler.getCues().length > 0) {
      setHtml5NativeSuppression(video, true);
    }
  }

  function bindHtml5Video(candidate: HTMLVideoElement): void {
    if (destroyed || isYoutube || !isSubtitlesEnabledForSite()) return;
    if (candidate === boundHtml5Video) {
      evaluateHtml5State(false);
      return;
    }

    if (boundHtml5Video) {
      unbindHtml5Video();
    }

    html5TrackLoadGen += 1;
    boundHtml5Video = candidate;
    boundHtml5PlayerRoot = resolveHtml5PlayerRoot(candidate);
    activeHtml5VideoIdentity = getHtml5VideoIdentity(candidate);
    pausedAfterPlay = false;

    const onSync = (seek = false) => {
      if (destroyed || boundHtml5Video !== candidate) return;
      currentPlayheadMs = Math.max(0, Math.round((candidate.currentTime || 0) * 1000));
      if (seek) {
        evaluateHtml5State(true);
      }
      if (
        isSubtitlesEnabledForSite() &&
        (seek || currentPlayheadMs !== lastSentPlayheadMs)
      ) {
        lastSentPlayheadMs = currentPlayheadMs;
        scheduler.updatePlayhead(
          currentPlayheadMs,
          seek ? { seek: true } : undefined,
        );
      }
      refreshActiveCueFromPlayhead();
    };

    const onPlaybackTick = () => onSync(false);
    const onExplicitSeek = () => onSync(true);
    const onTrackChange = () => {
      if (destroyed || boundHtml5Video !== candidate) return;
      hostCaptionsHiddenByUi = false;
      awaitingUiToggleCheck = false;
      missingLayerCueChangesAfterClick = 0;
      evaluateHtml5State(true);
    };
    const onMetadataLoaded = () => {
      if (destroyed || boundHtml5Video !== candidate) return;
      evaluateHtml5State(true);
    };

    const playerRoot = boundHtml5PlayerRoot;
    const onPointerControlActivity = () => {
      if (destroyed || boundHtml5Video !== candidate) return;
      lastPointerActivityAt = Date.now();
      syncHtml5OverlayLayout();
      if (controlsFadeTimer !== null) {
        clearTimeout(controlsFadeTimer);
      }
      controlsFadeTimer = setTimeout(() => {
        controlsFadeTimer = null;
        syncHtml5OverlayLayout();
      }, 350);
    };

    const seekEvents = ['seeking', 'seeked'];
    candidate.addEventListener('timeupdate', onPlaybackTick);
    for (const evt of seekEvents) {
      candidate.addEventListener(evt, onExplicitSeek);
    }
    candidate.addEventListener('loadedmetadata', onMetadataLoaded);
    candidate.textTracks?.addEventListener?.('change', onTrackChange);
    candidate.textTracks?.addEventListener?.('addtrack', onTrackChange);
    candidate.textTracks?.addEventListener?.('removetrack', onTrackChange);
    if (playerRoot) {
      playerRoot.addEventListener('pointermove', onPointerControlActivity, {
        passive: true,
      });
      playerRoot.addEventListener('pointerenter', onPointerControlActivity, {
        passive: true,
      });
      playerRoot.addEventListener('pointerleave', onPointerControlActivity, {
        passive: true,
      });
    }

    detachHtml5Listeners = () => {
      candidate.removeEventListener('timeupdate', onPlaybackTick);
      for (const evt of seekEvents) {
        candidate.removeEventListener(evt, onExplicitSeek);
      }
      candidate.removeEventListener('loadedmetadata', onMetadataLoaded);
      candidate.textTracks?.removeEventListener?.('change', onTrackChange);
      candidate.textTracks?.removeEventListener?.('addtrack', onTrackChange);
      candidate.textTracks?.removeEventListener?.('removetrack', onTrackChange);
      if (playerRoot) {
        playerRoot.removeEventListener('pointermove', onPointerControlActivity);
        playerRoot.removeEventListener('pointerenter', onPointerControlActivity);
        playerRoot.removeEventListener('pointerleave', onPointerControlActivity);
      }
    };

    evaluateHtml5State(true);
  }

  function runHtml5Arbitration(): void {
    if (destroyed || isYoutube) return;
    lastArbitrationAt = Date.now();
    if (!isSubtitlesEnabledForSite()) {
      if (boundHtml5Video) unbindHtml5Video();
      return;
    }

    const candidates = Array.from(doc.querySelectorAll('video'));
    const vp = resolveViewportSize(doc);
    let selected = selectActiveHtml5Video({
      candidates,
      current: boundHtml5Video,
      viewport: vp,
      lastPlayingAt: lastPlayingAtMap,
    });

    // Fallback when no video is playing yet: bind a visible engaged or unmuted `showing` video
    if (!selected) {
      let bestFallback: HTMLVideoElement | null = null;
      let bestArea = 0;
      for (const v of candidates) {
        if (!v.isConnected) continue;
        const ratio = computeVisibleRatio(v, vp);
        if (ratio < 0.5) continue;
        const isUnmutedShowing =
          !v.muted &&
          (v.volume === undefined || Number(v.volume) > 0) &&
          pickCaptionTrack(v)?.mode === 'showing';
        if (!engagedVideos.has(v) && !isUnmutedShowing) continue;
        const rect = resolveEffectiveVideoRect(v, vp);
        const visArea = rect.width * rect.height * ratio;
        if (visArea > bestArea) {
          bestArea = visArea;
          bestFallback = v;
        }
      }
      selected = bestFallback;
    }

    if (selected !== boundHtml5Video) {
      if (!selected) {
        unbindHtml5Video();
      } else {
        bindHtml5Video(selected);
      }
      return;
    }

    if (boundHtml5Video) {
      evaluateHtml5State(false);
    }
  }

  function scheduleArbitration(immediate = false): void {
    if (destroyed || isYoutube) return;
    if (immediate) {
      if (arbitrationTimer !== null) {
        clearTimeout(arbitrationTimer);
        arbitrationTimer = null;
      }
      runHtml5Arbitration();
      return;
    }
    const elapsed = Date.now() - lastArbitrationAt;
    if (elapsed >= HTML5_ARBITRATION_THROTTLE_MS && arbitrationTimer === null) {
      runHtml5Arbitration();
      return;
    }
    if (arbitrationTimer === null) {
      const delay = Math.max(
        16,
        HTML5_ARBITRATION_THROTTLE_MS - Math.max(0, elapsed),
      );
      arbitrationTimer = setTimeout(() => {
        arbitrationTimer = null;
        runHtml5Arbitration();
      }, delay);
    }
  }

  function findEnclosingHtml5Video(
    target: EventTarget | null,
    eventType: string,
  ): HTMLVideoElement | null {
    if (!target || typeof (target as Node).nodeType !== 'number') return null;
    const el =
      (target as Node).nodeType === 1
        ? (target as Element)
        : (target as Node).parentElement;
    if (!el) return null;

    // P2-4: purely structural O(1) ancestor/cached-root check — ZERO querySelectorAll('video') or getBoundingClientRect
    const direct = el.closest?.('video, [data-testid="videoPlayer"]');
    if (direct) {
      return direct.tagName === 'VIDEO'
        ? (direct as HTMLVideoElement)
        : direct.querySelector('video');
    }

    if (
      boundHtml5Video?.isConnected &&
      boundHtml5PlayerRoot?.isConnected &&
      boundHtml5PlayerRoot.contains(el)
    ) {
      return boundHtml5Video;
    }

    if (eventType === 'keydown') {
      return null;
    }

    const nearParent = el.parentElement;
    if (
      nearParent &&
      nearParent !== doc.body &&
      nearParent !== doc.documentElement
    ) {
      const siblingVideo = nearParent.querySelector(':scope > video');
      if (siblingVideo) return siblingVideo as HTMLVideoElement;
    }
    return null;
  }

  function attachHtml5DocumentListeners(): void {
    if (isYoutube || detachHtml5DocListeners) return;

    const onMediaCapture = (event: Event) => {
      if (destroyed) return;
      const target = event.target;
      if (event.type === 'load') {
        if (
          target &&
          (target as Element).tagName === 'TRACK' &&
          boundHtml5Video &&
          boundHtml5Video.contains(target as Node)
        ) {
          evaluateHtml5State(true);
        }
        return;
      }
      if (!target || (target as Element).tagName !== 'VIDEO') {
        return;
      }
      const video = target as HTMLVideoElement;
      if (event.type === 'playing') {
        lastPlayingAtMap.set(video, Date.now());
        if (video === boundHtml5Video) {
          pausedAfterPlay = false;
        }
      } else if (event.type === 'play') {
        if (video === boundHtml5Video) {
          pausedAfterPlay = false;
          evaluateHtml5State(false);
          syncHtml5OverlayLayout();
        }
      } else if (event.type === 'pause' || event.type === 'ended') {
        if (video === boundHtml5Video) {
          pausedAfterPlay = true;
          evaluateHtml5State(false);
          syncHtml5OverlayLayout();
        }
      } else if (event.type === 'volumechange') {
        if (!video.muted && (video.volume === undefined || Number(video.volume) > 0)) {
          engagedVideos.add(video);
          if (video === boundHtml5Video) {
            evaluateHtml5State(false);
          }
        }
      } else if (event.type === 'emptied') {
        if (video === boundHtml5Video) {
          currentVideoKey = '';
          lastPolledCueCount = -1;
          lastPolledLastEndTime = -1;
          lastSentPlayheadMs = -1;
          pausedAfterPlay = false;
          videoTranslationMemo.clear();
          scheduler.setDispatchGate(false);
          scheduler.cancelAll();
          scheduler.loadCues('', [], 0);
          evaluateHtml5State(true);
        }
      }
      scheduleArbitration(false);
    };

    const onViewportChange = () => {
      if (destroyed) return;
      scheduleArbitration(false);
    };

    const onVisibilityChange = () => {
      if (destroyed) return;
      evaluateHtml5State(false);
      scheduleArbitration(false);
    };

    const onPlayerInteraction = (event: Event) => {
      if (destroyed) return;
      const video = findEnclosingHtml5Video(event.target, event.type);
      if (!video) return;
      lastPointerActivityAt = Date.now();
      engagedVideos.add(video);

      if (video !== boundHtml5Video) {
        scheduleArbitration(true);
      } else {
        evaluateHtml5State(false);
        syncHtml5OverlayLayout();
      }

      if (event.type === 'click' || event.type === 'keydown') {
        if (video === boundHtml5Video && hadPositiveNativeCaptionLayer) {
          awaitingUiToggleCheck = true;
          missingLayerCueChangesAfterClick = 0;
        }
        scheduleTwoRafs(() => {
          if (destroyed || boundHtml5Video !== video) return;
          evaluateHtml5State(true);
          syncNativeCaptionLayerSuppression(video, { forceScan: true });
          syncHtml5OverlayLayout();
        });
        if (uiClickRecheckTimer !== null) {
          clearTimeout(uiClickRecheckTimer);
        }
        uiClickRecheckTimer = setTimeout(() => {
          uiClickRecheckTimer = null;
          if (destroyed || boundHtml5Video !== video) return;
          evaluateHtml5State(true);
          syncNativeCaptionLayerSuppression(video, { forceScan: true });
          syncHtml5OverlayLayout();
        }, 300);
      }
    };

    const mediaEvents = [
      'play',
      'playing',
      'pause',
      'ended',
      'emptied',
      'loadedmetadata',
      'volumechange',
      'load',
    ];
    for (const evt of mediaEvents) {
      doc.addEventListener(evt, onMediaCapture, true);
    }
    doc.addEventListener('scroll', onViewportChange, {
      capture: true,
      passive: true,
    });
    win.addEventListener('resize', onViewportChange, { passive: true });
    doc.addEventListener('visibilitychange', onVisibilityChange);
    doc.addEventListener('pointerdown', onPlayerInteraction, true);
    doc.addEventListener('click', onPlayerInteraction, true);
    doc.addEventListener('keydown', onPlayerInteraction, true);

    detachHtml5DocListeners = () => {
      for (const evt of mediaEvents) {
        doc.removeEventListener(evt, onMediaCapture, true);
      }
      doc.removeEventListener('scroll', onViewportChange, true);
      win.removeEventListener('resize', onViewportChange);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      doc.removeEventListener('pointerdown', onPlayerInteraction, true);
      doc.removeEventListener('click', onPlayerInteraction, true);
      doc.removeEventListener('keydown', onPlayerInteraction, true);
    };
  }

  function tickActiveVideoPlayhead(): void {
    if (destroyed) return;
    if (!isExtensionContextValid(hadRuntimeIdAtStart)) {
      destroy({ contextInvalidated: true });
      return;
    }
    if (isYoutube) {
      const activePageVideoId = resolveActiveYoutubePageVideoId();
      if (activePageVideoId && stashedCapturesByVideoId.has(activePageVideoId)) {
        syncYoutubePageVideoTransition(false);
      }
    }
    if (!isSubtitlesEnabledForSite()) return;

    if (!isYoutube) {
      const video = boundHtml5Video;
      if (!video) return;
      if (!video.isConnected) {
        unbindHtml5Video();
        scheduleArbitration(false);
        return;
      }
      const now = Date.now();
      if (now - lastTrackPollAt >= HTML5_TRACK_POLL_MS) {
        lastTrackPollAt = now;
        if (hostCaptionsHiddenByUi) {
          syncNativeCaptionLayerSuppression(video, { forceScan: true });
        }
        evaluateHtml5State(false);
      }
      const wrapper = ownedOverlayHost?.shadowRoot?.getElementById('margin-sub-wrap');
      if (wrapper && !wrapper.hidden && now - lastOverlayOffsetPollAt >= 250) {
        lastOverlayOffsetPollAt = now;
        syncHtml5OverlayLayout();
      }
      if (video.paused) return;
      const nextMs = Math.max(0, Math.round((video.currentTime || 0) * 1000));
      if (Math.abs(nextMs - currentPlayheadMs) >= 40) {
        currentPlayheadMs = nextMs;
        lastSentPlayheadMs = nextMs;
        scheduler.updatePlayhead(currentPlayheadMs);
        refreshActiveCueFromPlayhead();
      }
      return;
    }

    const video = doc.querySelector<HTMLVideoElement>('video.html5-main-video');
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
    if (!isExtensionContextValid(hadRuntimeIdAtStart)) {
      destroy({ contextInvalidated: true });
      return;
    }
    if (!isYoutube) {
      const fsEl = doc.fullscreenElement;
      if (fsEl) {
        const fsVideo =
          fsEl.tagName === 'VIDEO'
            ? (fsEl as HTMLVideoElement)
            : fsEl.querySelector('video');
        if (fsVideo) {
          engagedVideos.add(fsVideo);
        }
      }
      scheduleArbitration(true);
    }
    applyOverlayDom(activeCueState);
  }

  function syncLocalCaptionThemeFromStorage(fromStorageEvent = false): void {
    if (destroyed || !isYoutube) return;
    // Once MAIN world bridges `getSubtitlesUserSettings()`, defer click polling to MAIN world
    if (hasReceivedMainThemeBridge && !fromStorageEvent) return;
    if (fromStorageEvent) {
      let hasStored = false;
      try {
        hasStored = Boolean(win.localStorage?.getItem(YOUTUBE_CAPTION_STORAGE_KEY));
      } catch {
        hasStored = false;
      }
      if (!hasStored && hasReceivedMainThemeBridge) return;
    }
    const nextTheme = readLocalYoutubeCaptionTheme(win, doc);
    if (!areYoutubeNativeThemesEqual(currentNativeTheme, nextTheme)) {
      currentNativeTheme = nextTheme;
      refreshActiveCueFromPlayhead();
    }
  }

  function handleStorageEvent(event: StorageEvent): void {
    if (destroyed || !isYoutube) return;
    if (!isExtensionContextValid(hadRuntimeIdAtStart)) {
      destroy({ contextInvalidated: true });
      return;
    }
    if (!event.key || event.key === YOUTUBE_CAPTION_STORAGE_KEY) {
      syncLocalCaptionThemeFromStorage(true);
    }
  }

  function handlePlayerMenuInteraction(event: Event): void {
    if (destroyed || !isYoutube) return;
    if (!isExtensionContextValid(hadRuntimeIdAtStart)) {
      destroy({ contextInvalidated: true });
      return;
    }
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
      if (!destroyed) syncLocalCaptionThemeFromStorage();
    });
    if (pendingCaptionSyncTimer !== null) {
      clearTimeout(pendingCaptionSyncTimer);
    }
    pendingCaptionSyncTimer = setTimeout(() => {
      pendingCaptionSyncTimer = null;
      syncLocalCaptionThemeFromStorage();
    }, 65);
  }

  async function start(): Promise<void> {
    if (destroyed) return;
    const winRecord = win as unknown as Record<
      string,
      SubtitleIsolatedController | undefined
    >;
    const prevController = winRecord[ISOLATED_CONTROLLER_KEY];
    if (prevController && prevController !== controllerApi) {
      try {
        prevController.destroy();
      } catch {
        // Ignore teardown errors on previous controller in same isolated world
      }
    }

    hadRuntimeIdAtStart = Boolean(globalThis.chrome?.runtime?.id);

    if (isYoutube) {
      if (scheduler.getCues().length === 0) {
        const existingHost = doc.getElementById(SUBTITLE_OVERLAY_HOST_ID);
        const existingOwner = existingHost?.getAttribute(OVERLAY_OWNER_ATTR) ?? '';
        const hasLiveHost = Boolean(existingHost?.isConnected && existingOwner);
        if (!hasLiveHost) {
          setNativeYoutubeCaptionSuppression(false);
        }
      }

      currentNativeTheme = readLocalYoutubeCaptionTheme(win, doc);
      win.addEventListener('message', handleYoutubeBridgeMessage);
      win.addEventListener('storage', handleStorageEvent);
      win.addEventListener('yt-navigate-finish', handleYoutubeNavigation);
      win.addEventListener('yt-page-data-updated', handleYoutubeNavigation);
      win.addEventListener('popstate', handleYoutubeNavigation);
      doc.addEventListener('click', handlePlayerMenuInteraction, true);
      doc.addEventListener('keyup', handlePlayerMenuInteraction, true);

      if (typeof MutationObserver !== 'undefined' && doc.documentElement) {
        watchFlexyObserver = new MutationObserver(() => {
          if (destroyed) return;
          const activeVid = resolveActiveYoutubePageVideoId();
          if (activeVid && stashedCapturesByVideoId.has(activeVid)) {
            syncYoutubePageVideoTransition(false);
          }
        });
        watchFlexyObserver.observe(doc.documentElement, {
          subtree: true,
          attributes: true,
          attributeFilter: ['video-id'],
        });
      }
    }
    doc.addEventListener('fullscreenchange', handleFullscreenChange);

    try {
      config = await loadConfig();
    } catch {
      config = createDefaultMarginConfig();
    }
    if (destroyed) return;
    configLoaded = true;

    syncSchedulerConfig();
    if (isYoutube) {
      const video = doc.querySelector<HTMLVideoElement>('video.html5-main-video');
      if (video && Number.isFinite(video.currentTime) && video.currentTime > 0) {
        currentPlayheadMs = Math.max(0, Math.round(video.currentTime * 1000));
      }
      const activeVid = resolveActiveYoutubePageVideoId();
      if (activeVid && stashedCapturesByVideoId.has(activeVid)) {
        drainStashedCapturesForVideo(activeVid);
      }
    }
    broadcastSubtitleConfig();

    unsubConfig = subscribeConfig((nextCfg) => {
      config = nextCfg;
      sessionEnabledOverride = null;
      if (isSubtitlesEnabledForSite()) {
        syncSchedulerConfig();
      } else {
        html5TrackLoadGen += 1;
        if (!isYoutube) {
          unbindHtml5Video();
        } else {
          scheduler.cancelAll();
        }
      }
      broadcastSubtitleConfig();
      if (!isYoutube && isSubtitlesEnabledForSite()) {
        scheduleArbitration(true);
      }
      refreshActiveCueFromPlayhead();
    });

    playheadPollTimer = setInterval(tickActiveVideoPlayhead, 100);

    if (!isYoutube) {
      attachHtml5DocumentListeners();
      const startHtml5Scan = () => {
        if (destroyed) return;
        scheduleArbitration(true);
        if (!domObserver && doc.documentElement) {
          domObserver = new MutationObserver(() => {
            if (boundHtml5Video && !boundHtml5Video.isConnected) {
              unbindHtml5Video();
            }
            scheduleArbitration(false);
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

  function destroy(cleanupOptions: { contextInvalidated?: boolean } = {}): void {
    if (destroyed) return;
    destroyed = true;
    html5TrackLoadGen += 1;
    cancelClearTimer();
    if (arbitrationTimer !== null) {
      clearTimeout(arbitrationTimer);
      arbitrationTimer = null;
    }
    clearHtml5BoundTimers();
    if (playheadPollTimer !== null) {
      clearInterval(playheadPollTimer);
      playheadPollTimer = null;
    }
    if (pendingCaptionSyncTimer !== null) {
      clearTimeout(pendingCaptionSyncTimer);
      pendingCaptionSyncTimer = null;
    }
    if (isYoutube) {
      win.removeEventListener('message', handleYoutubeBridgeMessage);
      win.removeEventListener('storage', handleStorageEvent);
      win.removeEventListener('yt-navigate-finish', handleYoutubeNavigation);
      win.removeEventListener('yt-page-data-updated', handleYoutubeNavigation);
      win.removeEventListener('popstate', handleYoutubeNavigation);
      doc.removeEventListener('click', handlePlayerMenuInteraction, true);
      doc.removeEventListener('keyup', handlePlayerMenuInteraction, true);
    }
    watchFlexyObserver?.disconnect();
    watchFlexyObserver = null;
    stashedCapturesByVideoId.clear();
    doc.removeEventListener('fullscreenchange', handleFullscreenChange);
    try {
      unsubConfig?.();
    } catch {
      // Ignore storage unsubscribe errors when extension context is invalidated
    }
    unsubConfig = null;
    domObserver?.disconnect();
    domObserver = null;
    detachHtml5DocListeners?.();
    detachHtml5DocListeners = null;
    if (!isYoutube) {
      unbindHtml5Video();
    } else {
      detachHtml5Listeners?.();
      detachHtml5Listeners = null;
      boundHtml5Video = null;
      scheduler.cancelAll();
    }
    removeOverlayHost(cleanupOptions);
    if (!isYoutube) {
      const remainingHost = doc.getElementById(SUBTITLE_OVERLAY_HOST_ID);
      const remainingOwner = remainingHost?.getAttribute(OVERLAY_OWNER_ATTR) ?? '';
      const hasOtherMountedOwner = Boolean(
        remainingHost?.isConnected &&
          remainingOwner &&
          remainingOwner !== instanceId,
      );
      if (!hasOtherMountedOwner) {
        doc.getElementById(NATIVE_HTML5_HIDE_STYLE_ID)?.remove();
      }
    }

    if (isYoutube) {
      postToYoutubeMain({
        source: BRAND.ytBridgeSourceIsolated,
        type: 'isolated-context-invalidated',
        instanceId,
      });
    }

    const winRecord = win as unknown as Record<string, unknown>;
    if (winRecord[ISOLATED_CONTROLLER_KEY] === controllerApi) {
      delete winRecord[ISOLATED_CONTROLLER_KEY];
    }
  }

  const controllerApi: SubtitleIsolatedController = {
    start,
    destroy: () => destroy(),
    isDestroyed: () => destroyed,
    getActiveCue: () => ({ ...activeCueState }),
    getCues: () => scheduler.getCues(),
  };

  return controllerApi;
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
      --margin-sub-bottom-px: 52px;
      --margin-sub-orig-scale: 1;
      --margin-sub-trans-scale: 0.7;
      --margin-yt-fg: rgba(255, 255, 255, 1);
      --margin-yt-trans-fg: rgba(255, 255, 255, 0.96);
      --margin-yt-bg: rgba(8, 8, 8, 0.75);
      --margin-yt-win-bg: rgba(8, 8, 8, 0);
      --margin-yt-shadow: none;
      --margin-yt-font: "YouTube Noto", Roboto, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;
      --margin-yt-font-family: "YouTube Noto", Roboto, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;
      --margin-yt-trans-font: "YouTube Noto", Roboto, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;
      --margin-yt-trans-font-family: "YouTube Noto", Roboto, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;
      --margin-sub-trans-font-family: "YouTube Noto", Roboto, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;
      --margin-yt-variant: normal;
      --margin-yt-scale-mult: 1;
      position: absolute;
      left: 5%;
      right: 5%;
      bottom: var(--margin-sub-bottom-px, 52px);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      text-align: center;
      pointer-events: none;
      transition: bottom 180ms cubic-bezier(0.2, 0, 0, 1);
      font-family: "YouTube Noto", Roboto, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    }
    #margin-sub-wrap[data-position="top"] {
      bottom: auto;
      top: 34px;
      transition: none;
    }
    #margin-sub-wrap[data-fullscreen] {
      bottom: var(--margin-sub-bottom-px, 70px);
    }
    #margin-sub-wrap[data-fullscreen][data-position="top"] {
      bottom: auto;
      top: 46px;
    }
    #margin-sub-wrap[hidden],
    .margin-sub-line[hidden] {
      display: none !important;
    }
    #margin-sub-wrap[data-style-preset="youtube-native"] {
      font-family: var(--margin-yt-font-family, var(--margin-yt-font));
      font-variant: var(--margin-yt-variant, normal);
      background: var(--margin-yt-win-bg, transparent);
      width: fit-content;
      max-width: 90%;
      margin-left: auto;
      margin-right: auto;
      padding: 2px 4px;
      border-radius: 3px;
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
    #margin-sub-wrap[data-style-preset="youtube-native"] .margin-sub-line {
      max-width: min(100%, 960px);
    }
    .margin-sub-seg {
      display: inline;
      background: var(--margin-yt-bg, rgba(8, 8, 8, 0.75));
      color: var(--margin-yt-fg, #ffffff);
      text-shadow: var(--margin-yt-shadow, none);
      padding: 2px 7px;
      border-radius: 2px;
      border: none;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    .margin-sub-original,
    .margin-sub-line--orig {
      color: var(--margin-yt-fg, #ffffff);
      font-size: calc(var(--margin-sub-base-px, 18px) * var(--margin-sub-orig-scale, 1) * var(--margin-yt-scale-mult, 1));
      font-weight: 500;
    }
    #margin-sub-wrap[data-style-preset="youtube-native"] .margin-sub-original,
    #margin-sub-wrap[data-style-preset="youtube-native"] .margin-sub-line--orig {
      font-family: var(--margin-yt-font-family, var(--margin-yt-font));
    }
    .margin-sub-translated,
    .margin-sub-line--trans {
      color: var(--margin-yt-trans-fg, rgba(255, 255, 255, 0.96));
      font-family: var(--margin-sub-trans-font-family);
      font-size: calc(var(--margin-sub-base-px, 18px) * var(--margin-sub-trans-scale, 0.7) * var(--margin-yt-scale-mult, 1));
      font-weight: 500;
      unicode-bidi: isolate;
    }
    #margin-sub-wrap[data-style-preset="youtube-native"] .margin-sub-translated,
    #margin-sub-wrap[data-style-preset="youtube-native"] .margin-sub-line--trans {
      font-family: var(--margin-yt-trans-font-family, var(--margin-yt-font-family));
    }
    .margin-sub-translated .margin-sub-seg {
      color: var(--margin-yt-trans-fg, rgba(255, 255, 255, 0.96));
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
    #margin-sub-wrap[data-surface="html5"] {
      left: 0;
      right: 0;
    }
    #margin-sub-wrap[data-surface="html5"][data-position="top"] {
      top: 12px;
    }
    #margin-sub-wrap[data-surface="html5"][data-fullscreen][data-position="top"] {
      top: 46px;
    }
    #margin-sub-wrap[data-surface="html5"][data-style-preset="youtube-native"] {
      width: fit-content;
      max-width: min(88%, 46em);
      margin-inline: auto;
      padding: var(--margin-cap-pad-y, 4px) var(--margin-cap-pad-x, 10px);
      border-radius: var(--margin-cap-radius, 10px);
      background: var(--margin-cap-bg, rgba(17, 17, 20, 0.66));
      -webkit-backdrop-filter: blur(8px) saturate(140%);
      backdrop-filter: blur(8px) saturate(140%);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28), inset 0 0 0 0.5px rgba(255, 255, 255, 0.08);
      gap: 2px;
      font-family: Chirp, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    #margin-sub-wrap[data-surface="html5"] .margin-sub-line {
      max-width: 100%;
      line-height: 1.34;
      text-wrap: balance;
    }
    #margin-sub-wrap[data-surface="html5"][data-style-preset="youtube-native"] .margin-sub-seg {
      background: transparent;
      padding: 0;
      border-radius: 0;
      box-decoration-break: slice;
      -webkit-box-decoration-break: slice;
      text-shadow: 0 1px 1.5px rgba(0, 0, 0, 0.45);
    }
    #margin-sub-wrap[data-surface="html5"] .margin-sub-original,
    #margin-sub-wrap[data-surface="html5"] .margin-sub-line--orig {
      font-size: var(--margin-sub-orig-px, 12.5px);
      font-weight: 400;
      color: rgba(255, 255, 255, 0.74);
    }
    #margin-sub-wrap[data-surface="html5"][data-style-preset="youtube-native"] .margin-sub-original,
    #margin-sub-wrap[data-surface="html5"][data-style-preset="youtube-native"] .margin-sub-line--orig {
      font-family: Chirp, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    #margin-sub-wrap[data-surface="html5"][data-style-preset="youtube-native"] .margin-sub-original .margin-sub-seg {
      color: rgba(255, 255, 255, 0.74);
    }
    #margin-sub-wrap[data-surface="html5"] .margin-sub-translated,
    #margin-sub-wrap[data-surface="html5"] .margin-sub-line--trans,
    #margin-sub-wrap[data-surface="html5"][data-style-preset="youtube-native"] .margin-sub-translated,
    #margin-sub-wrap[data-surface="html5"][data-style-preset="youtube-native"] .margin-sub-line--trans {
      font-size: var(--margin-sub-trans-px, 14px);
      font-weight: 500;
      letter-spacing: 0.01em;
      font-family: var(--margin-html5-trans-font-family, var(--margin-sub-trans-font-family));
    }
    #margin-sub-wrap[data-surface="html5"][data-mode="source-only"] .margin-sub-original,
    #margin-sub-wrap[data-surface="html5"][data-mode="source-only"] .margin-sub-line--orig,
    #margin-sub-wrap[data-surface="html5"][data-mode="source-only"][data-style-preset="youtube-native"] .margin-sub-original .margin-sub-seg {
      font-size: var(--margin-sub-trans-px, 14px);
      color: rgba(255, 255, 255, 0.97);
    }
    #margin-sub-wrap[data-surface="html5"][data-style-preset="warm-paper"] {
      max-width: min(88%, 46em);
      margin-inline: auto;
    }
    #margin-sub-wrap[data-surface="html5"][data-style-preset="warm-paper"] .margin-sub-original {
      color: rgba(236, 228, 210, 0.90);
    }
    #margin-sub-wrap[data-surface="html5"][data-style-preset="warm-paper"] .margin-sub-translated {
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

export function bootSubtitleIsolatedEntry(
  win: Window = window,
  options?: SubtitleIsolatedControllerOptions,
): SubtitleIsolatedController {
  const winRecord = win as unknown as Record<
    string,
    SubtitleIsolatedController | undefined
  >;
  const existing = winRecord[ISOLATED_CONTROLLER_KEY];
  if (
    !options &&
    existing &&
    !existing.isDestroyed?.() &&
    Boolean(
      typeof globalThis.chrome !== 'undefined' && globalThis.chrome?.runtime?.id,
    )
  ) {
    return existing;
  }
  if (existing) {
    try {
      existing.destroy();
    } catch {
      // Ignore teardown errors on stale controller
    }
  }
  const controller = createSubtitleIsolatedController({
    hostWindow: win,
    hostDocument: win.document,
    ...options,
  });
  Object.defineProperty(win, ISOLATED_CONTROLLER_KEY, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: controller,
  });
  void controller.start();
  return controller;
}

if (shouldAutoBootIsolatedEntry()) {
  bootSubtitleIsolatedEntry(window);
}
