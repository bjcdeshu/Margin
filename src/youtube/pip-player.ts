import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import type { MarginActiveCueState, SubtitleSettings } from '@shared/types';
import {
  applyNativeThemeVariablesToElement,
  areYoutubeNativeThemesEqual,
  clampFontSizePercent,
  clampSeekTime,
  cleanPipCueText,
  computePipDimensions,
  normalizeActiveCueState,
  normalizeBgOpacityOverride,
  normalizeSubtitleStylePreset,
  normalizeSubtitleTargetLang,
  normalizeTranslationTint,
  PIP_BUTTON_ID,
  PIP_CLEAR_DELAY_MS,
  PIP_NOTICE_DURATION_MS,
  PIP_NOTICE_HOST_ID,
  resolveEffectiveTranslationScale,
  resolveRenderedCueLines,
  resolveSubtitleCjkFallbackForLang,
  resolveSubtitleTargetDir,
} from './shared';

export {
  clampFontSizePercent,
  clampSeekTime,
  cleanPipCueText,
  computePipDimensions,
  normalizeActiveCueState,
  normalizeSubtitleTargetLang,
  PIP_BUTTON_ID,
  PIP_CLEAR_DELAY_MS,
  PIP_NOTICE_DURATION_MS,
  PIP_NOTICE_HOST_ID,
  resolveRenderedCueLines,
  resolveSubtitleCjkFallbackForLang,
  resolveSubtitleTargetDir,
};

export interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  preferInitialWindowPlacement?: boolean;
}

export interface DocumentPictureInPictureApi {
  window?: Window | null;
  requestWindow: (options?: DocumentPictureInPictureOptions) => Promise<Window>;
}

export interface PipCapableVideoElement extends HTMLVideoElement {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }
}

export type PipOpenMode =
  | 'document-pip-stream'
  | 'document-pip-moved'
  | 'native-video-pip'
  | 'unsupported'
  | 'no-video'
  | 'error';

export interface YoutubePipPlayerOptions {
  hostWindow?: Window;
  hostDocument?: Document;
  findVideo?: () => PipCapableVideoElement | null;
  onActiveChange?: (active: boolean, mode: PipOpenMode | null) => void;
  clearDelayMs?: number;
  noticeDurationMs?: number;
}

interface PipUiStrings {
  title: string;
  close: string;
  play: string;
  pause: string;
  rewind: string;
  forward: string;
  mute: string;
  unmute: string;
  noVideo: string;
  unsupported: string;
  nativeFallbackNotice: string;
  openFailed: string;
}

function getPipStrings(langHint?: string): PipUiStrings {
  const lang = (
    langHint ||
    (typeof navigator !== 'undefined' ? navigator.language : 'en') ||
    'en'
  ).toLowerCase();
  const isZh = lang.startsWith('zh');

  if (isZh) {
    return {
      title: 'Margin 双语画中画',
      close: '关闭画中画',
      play: '播放',
      pause: '暂停',
      rewind: '后退 10 秒',
      forward: '前进 10 秒',
      mute: '静音',
      unmute: '取消静音',
      noVideo: '未找到可播放的视频画面',
      unsupported: '当前浏览器环境不支持画中画模式',
      nativeFallbackNotice:
        '当前浏览器不支持 Document PiP，已回退至原生视频画中画（原生模式无法渲染自定义双语字幕层）',
      openFailed: '无法开启画中画窗口',
    };
  }

  return {
    title: 'Margin Bilingual Picture-in-Picture',
    close: 'Close Picture-in-Picture',
    play: 'Play',
    pause: 'Pause',
    rewind: 'Back 10 seconds',
    forward: 'Forward 10 seconds',
    mute: 'Mute',
    unmute: 'Unmute',
    noVideo: 'No playable video element found',
    unsupported: 'Picture-in-Picture is not supported in this browser',
    nativeFallbackNotice:
      'Document PiP is unavailable; opened native video PiP instead (native PiP cannot render custom bilingual subtitle overlays).',
    openFailed: 'Could not open Picture-in-Picture',
  };
}

/**
 * Direct-Bus YouTube Bilingual Document PiP Player + Guardrail 2 Native Video PiP Fallback.
 */
export class YoutubePipPlayer {
  private readonly hostWindow: Window;
  private readonly hostDocument: Document;
  private readonly customFindVideo?: () => PipCapableVideoElement | null;
  private readonly onActiveChange?: (active: boolean, mode: PipOpenMode | null) => void;
  private readonly clearDelayMs: number;
  private readonly noticeDurationMs: number;

  private pipWindow: Window | null = null;
  private pipDocument: Document | null = null;
  private sourceVideo: PipCapableVideoElement | null = null;
  private mirrorVideo: PipCapableVideoElement | null = null;
  private captureStream: MediaStream | null = null;
  private videoMode: 'stream' | 'moved' | 'native' | null = null;
  private restoreMovedVideo: (() => void) | null = null;
  private cleanupCallbacks: Array<() => void> = [];

  private cueState: MarginActiveCueState = normalizeActiveCueState();
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(options: YoutubePipPlayerOptions = {}) {
    this.hostWindow = options.hostWindow ?? window;
    this.hostDocument = options.hostDocument ?? document;
    this.customFindVideo = options.findVideo;
    this.onActiveChange = options.onActiveChange;
    this.clearDelayMs = options.clearDelayMs ?? PIP_CLEAR_DELAY_MS;
    this.noticeDurationMs = options.noticeDurationMs ?? PIP_NOTICE_DURATION_MS;
  }

  public isActive(): boolean {
    if (this.videoMode === 'native') {
      return Boolean(
        this.sourceVideo &&
          this.hostDocument.pictureInPictureElement === this.sourceVideo,
      );
    }
    return Boolean(this.pipWindow && !this.pipWindow.closed);
  }

  public getVideoMode(): 'stream' | 'moved' | 'native' | null {
    return this.videoMode;
  }

  public getCueState(): MarginActiveCueState {
    return { ...this.cueState };
  }

  public async toggle(): Promise<PipOpenMode | 'closed'> {
    if (this.isActive()) {
      await this.close();
      return 'closed';
    }
    return this.open();
  }

  /**
   * Updates the active cue directly from the typed state bus (`MarginActiveCueState`).
   * Applies a `120ms` clear debounce when transitioning to an empty gap so rapid
   * cue transitions never flicker.
   */
  public updateCue(input: Partial<MarginActiveCueState> | null | undefined): void {
    if (this.destroyed) return;
    const normalized = normalizeActiveCueState({
      mode: this.cueState.mode,
      targetLang: this.cueState.targetLang,
      fontSizePercent: this.cueState.fontSizePercent,
      sourceScalePercent: this.cueState.sourceScalePercent,
      translationScalePercent: this.cueState.translationScalePercent,
      stylePreset: this.cueState.stylePreset,
      bgOpacityPercent: this.cueState.bgOpacityPercent,
      translationTint: this.cueState.translationTint,
      nativeTheme: this.cueState.nativeTheme,
      position: this.cueState.position,
      ...input,
    });

    const lines = resolveRenderedCueLines(normalized);
    const hasVisibleText = Boolean(lines.originalLine || lines.translatedLine);

    if (hasVisibleText) {
      this.cancelClearTimer();
      this.cueState = normalized;
      this.renderPipSubtitles();
      return;
    }

    // Always apply non-text style/position/locale changes immediately even while debouncing text clear
    const styleChanged =
      normalized.targetLang !== this.cueState.targetLang ||
      normalized.fontSizePercent !== this.cueState.fontSizePercent ||
      normalized.sourceScalePercent !== this.cueState.sourceScalePercent ||
      normalized.translationScalePercent !== this.cueState.translationScalePercent ||
      normalized.stylePreset !== this.cueState.stylePreset ||
      normalized.bgOpacityPercent !== this.cueState.bgOpacityPercent ||
      normalized.translationTint !== this.cueState.translationTint ||
      !areYoutubeNativeThemesEqual(
        normalized.nativeTheme,
        this.cueState.nativeTheme,
      ) ||
      normalized.position !== this.cueState.position ||
      normalized.mode !== this.cueState.mode;

    if (styleChanged) {
      this.cueState = {
        ...this.cueState,
        mode: normalized.mode,
        targetLang: normalized.targetLang,
        fontSizePercent: normalized.fontSizePercent,
        sourceScalePercent: normalized.sourceScalePercent,
        translationScalePercent: normalized.translationScalePercent,
        stylePreset: normalized.stylePreset,
        bgOpacityPercent: normalized.bgOpacityPercent,
        translationTint: normalized.translationTint,
        nativeTheme: normalized.nativeTheme,
        position: normalized.position,
      };
      this.renderPipSubtitles();
    }

    const currentlyEmpty =
      !this.cueState.original && !this.cueState.translated;
    if (currentlyEmpty) {
      this.cueState = normalized;
      this.renderPipSubtitles();
      return;
    }

    if (this.clearTimer === null) {
      this.clearTimer = setTimeout(() => {
        this.clearTimer = null;
        this.cueState = normalizeActiveCueState({
          mode: this.cueState.mode,
          targetLang: this.cueState.targetLang,
          fontSizePercent: this.cueState.fontSizePercent,
          sourceScalePercent: this.cueState.sourceScalePercent,
          translationScalePercent: this.cueState.translationScalePercent,
          stylePreset: this.cueState.stylePreset,
          bgOpacityPercent: this.cueState.bgOpacityPercent,
          translationTint: this.cueState.translationTint,
          nativeTheme: this.cueState.nativeTheme,
          position: this.cueState.position,
        });
        this.renderPipSubtitles();
      }, this.clearDelayMs);
    }
  }

  public updateSettings(
    settings: Pick<SubtitleSettings, 'displayMode' | 'fontSizePercent' | 'position'> &
      Partial<
        Pick<
          SubtitleSettings,
          | 'sourceScalePercent'
          | 'translationScalePercent'
          | 'stylePreset'
          | 'bgOpacityPercent'
          | 'translationTint'
        >
      > & {
        targetLang?: string;
      },
  ): void {
    if (this.destroyed) return;
    const transScale = resolveEffectiveTranslationScale(settings);
    this.cueState = normalizeActiveCueState({
      ...this.cueState,
      mode: settings.displayMode,
      targetLang:
        settings.targetLang !== undefined
          ? normalizeSubtitleTargetLang(settings.targetLang)
          : this.cueState.targetLang,
      fontSizePercent: settings.fontSizePercent ?? transScale,
      sourceScalePercent:
        settings.sourceScalePercent ?? this.cueState.sourceScalePercent ?? 100,
      translationScalePercent: transScale,
      stylePreset:
        settings.stylePreset !== undefined
          ? normalizeSubtitleStylePreset(settings.stylePreset)
          : (this.cueState.stylePreset ?? 'youtube-native'),
      bgOpacityPercent:
        settings.bgOpacityPercent !== undefined
          ? normalizeBgOpacityOverride(settings.bgOpacityPercent)
          : this.cueState.bgOpacityPercent,
      translationTint:
        settings.translationTint !== undefined
          ? normalizeTranslationTint(settings.translationTint)
          : this.cueState.translationTint,
      position: settings.position,
    });
    this.renderPipSubtitles();
  }

  public clearCueImmediately(): void {
    this.cancelClearTimer();
    this.cueState = normalizeActiveCueState({
      mode: this.cueState.mode,
      targetLang: this.cueState.targetLang,
      fontSizePercent: this.cueState.fontSizePercent,
      sourceScalePercent: this.cueState.sourceScalePercent,
      translationScalePercent: this.cueState.translationScalePercent,
      stylePreset: this.cueState.stylePreset,
      bgOpacityPercent: this.cueState.bgOpacityPercent,
      translationTint: this.cueState.translationTint,
      nativeTheme: this.cueState.nativeTheme,
      position: this.cueState.position,
    });
    this.renderPipSubtitles();
  }

  public async open(): Promise<PipOpenMode> {
    if (this.destroyed) return 'error';

    const strings = getPipStrings(this.hostDocument.documentElement.lang);
    const sourceVideo = this.findSourceVideo();
    if (!sourceVideo) {
      this.showQuietPaperNotice(strings.noVideo);
      return 'no-video';
    }

    const docPip = this.hostWindow.documentPictureInPicture;

    // Guardrail 2: Fallback gracefully to native `video.requestPictureInPicture()` + Quiet Paper notice
    if (!docPip || typeof docPip.requestWindow !== 'function') {
      if (typeof sourceVideo.requestPictureInPicture === 'function') {
        try {
          await sourceVideo.requestPictureInPicture();
          this.sourceVideo = sourceVideo;
          this.videoMode = 'native';

          const onLeaveNativePip = () => {
            if (this.videoMode === 'native') {
              this.cleanupState();
            }
          };
          sourceVideo.addEventListener('leavepictureinpicture', onLeaveNativePip, {
            once: true,
          });
          this.cleanupCallbacks.push(() =>
            sourceVideo.removeEventListener('leavepictureinpicture', onLeaveNativePip),
          );

          this.showQuietPaperNotice(strings.nativeFallbackNotice);
          this.onActiveChange?.(true, 'native-video-pip');
          return 'native-video-pip';
        } catch {
          this.showQuietPaperNotice(strings.openFailed);
          return 'error';
        }
      }

      this.showQuietPaperNotice(strings.unsupported);
      return 'unsupported';
    }

    const dimensions = computePipDimensions(
      sourceVideo.videoWidth || sourceVideo.clientWidth,
      sourceVideo.videoHeight || sourceVideo.clientHeight,
    );

    try {
      let pipWindow: Window;
      try {
        pipWindow = await docPip.requestWindow({
          ...dimensions,
          preferInitialWindowPlacement: true,
        });
      } catch (err) {
        if (!(err instanceof TypeError)) throw err;
        pipWindow = await docPip.requestWindow(dimensions);
      }

      this.pipWindow = pipWindow;
      this.pipDocument = pipWindow.document;
      this.sourceVideo = sourceVideo;

      const attachedMode = this.setupPipDocument(pipWindow, sourceVideo, strings);
      const openMode: PipOpenMode =
        attachedMode === 'stream' ? 'document-pip-stream' : 'document-pip-moved';
      this.onActiveChange?.(true, openMode);
      return openMode;
    } catch {
      this.showQuietPaperNotice(strings.openFailed);
      this.cleanupState();
      return 'error';
    }
  }

  public async close(): Promise<void> {
    if (this.videoMode === 'native') {
      try {
        if (
          this.hostDocument.pictureInPictureElement &&
          typeof this.hostDocument.exitPictureInPicture === 'function'
        ) {
          await this.hostDocument.exitPictureInPicture();
        }
      } catch {
        // Ignore already-exited native PiP
      }
      this.cleanupState();
      return;
    }

    const pipWin = this.pipWindow;
    if (pipWin && !pipWin.closed) {
      try {
        pipWin.close();
      } catch {
        // Ignore close failure on detached window
      }
    }
    this.cleanupState();
  }

  public handleVideoCheck(): void {
    if (!this.pipWindow || !this.sourceVideo || this.videoMode === 'moved') return;
    const current = this.findSourceVideo();
    if (current && current !== this.sourceVideo) {
      void this.close();
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelClearTimer();
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.hostDocument.getElementById(PIP_NOTICE_HOST_ID)?.remove();
    void this.close();
  }

  private cancelClearTimer(): void {
    if (this.clearTimer !== null) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }

  private findSourceVideo(): PipCapableVideoElement | null {
    if (this.customFindVideo) {
      return this.customFindVideo();
    }
    if (this.videoMode === 'moved' && this.sourceVideo) {
      return this.sourceVideo;
    }

    const mainYt = this.hostDocument.querySelector<PipCapableVideoElement>(
      'video.html5-main-video',
    );
    if (mainYt && mainYt.readyState > 0) {
      return mainYt;
    }

    const candidates = Array.from(
      this.hostDocument.querySelectorAll<PipCapableVideoElement>('video'),
    )
      .filter((v) => v.isConnected && v.readyState > 0)
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      });

    return candidates[0] ?? mainYt ?? null;
  }

  private setupPipDocument(
    pipWindow: Window,
    sourceVideo: PipCapableVideoElement,
    strings: PipUiStrings,
  ): 'stream' | 'moved' {
    const doc = pipWindow.document;
    doc.title = strings.title;
    doc.head.replaceChildren();
    doc.body.replaceChildren();

    const meta = doc.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width,initial-scale=1';
    doc.head.appendChild(meta);

    const style = doc.createElement('style');
    style.textContent = buildPipWindowStyles();
    doc.head.appendChild(style);

    const root = doc.createElement('main');
    root.id = 'margin-pip-root';
    root.dataset.position = this.cueState.position;
    doc.body.appendChild(root);

    const attachedMode = this.attachVideoToPip(root, sourceVideo, doc);

    const subtitleContainer = doc.createElement('div');
    subtitleContainer.id = 'margin-pip-subtitles';
    subtitleContainer.dataset.position = this.cueState.position;
    subtitleContainer.setAttribute('aria-live', 'off');
    subtitleContainer.hidden = true;

    const originalEl = doc.createElement('div');
    originalEl.id = 'margin-pip-original';
    originalEl.className = 'margin-pip-line margin-pip-original cue-orig';
    originalEl.hidden = true;
    const origSeg = doc.createElement('span');
    origSeg.className = 'margin-sub-seg';
    originalEl.appendChild(origSeg);

    const translatedEl = doc.createElement('div');
    translatedEl.id = 'margin-pip-translated';
    translatedEl.className = 'margin-pip-line margin-pip-translated cue-trans';
    translatedEl.hidden = true;
    const transSeg = doc.createElement('span');
    transSeg.className = 'margin-sub-seg';
    translatedEl.appendChild(transSeg);

    subtitleContainer.append(originalEl, translatedEl);
    root.appendChild(subtitleContainer);

    const controls = this.buildPipControls(doc, sourceVideo, strings);
    root.appendChild(controls);

    const onPageHide = () => {
      this.cleanupState();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      this.handlePipKeyDown(event, sourceVideo);
    };

    pipWindow.addEventListener('pagehide', onPageHide, { once: true });
    pipWindow.addEventListener('keydown', onKeyDown);
    this.cleanupCallbacks.push(() => {
      pipWindow.removeEventListener('pagehide', onPageHide);
      pipWindow.removeEventListener('keydown', onKeyDown);
    });

    this.renderPipSubtitles();
    this.updateTransportState(strings);

    return attachedMode;
  }

  private attachVideoToPip(
    root: HTMLElement,
    sourceVideo: PipCapableVideoElement,
    pipDoc: Document,
  ): 'stream' | 'moved' {
    const captureFn = sourceVideo.captureStream ?? sourceVideo.mozCaptureStream;
    if (typeof captureFn === 'function') {
      try {
        const stream = captureFn.call(sourceVideo);
        const videoTracks = stream?.getVideoTracks?.() ?? [];
        if (videoTracks.length > 0) {
          const mirror = pipDoc.createElement('video') as PipCapableVideoElement;
          mirror.id = 'margin-pip-video';
          mirror.autoplay = true;
          mirror.muted = true;
          mirror.playsInline = true;
          mirror.disablePictureInPicture = true;
          try {
            mirror.srcObject = stream;
          } catch {
            Object.defineProperty(mirror, 'srcObject', {
              value: stream,
              writable: true,
              configurable: true,
            });
          }
          root.appendChild(mirror);
          void mirror.play().catch(() => {});

          this.videoMode = 'stream';
          this.captureStream = stream;
          this.mirrorVideo = mirror;

          const primaryTrack = videoTracks[0];
          const onEnded = () => {
            if (this.pipWindow && !this.pipWindow.closed) {
              void this.close();
            }
          };
          primaryTrack?.addEventListener?.('ended', onEnded, { once: true });
          this.cleanupCallbacks.push(() => {
            primaryTrack?.removeEventListener?.('ended', onEnded);
          });
          return 'stream';
        }
      } catch {
        // Fall through to moved-video mode
      }
    }

    const parent = sourceVideo.parentNode;
    if (!parent) {
      throw new Error('Source video element has no parent node.');
    }

    const placeholder = this.hostDocument.createComment(
      'margin-youtube-pip-video-placeholder',
    );
    parent.insertBefore(placeholder, sourceVideo);
    const prevStyleAttr = sourceVideo.getAttribute('style');

    sourceVideo.style.width = '100%';
    sourceVideo.style.height = '100%';
    sourceVideo.style.objectFit = 'contain';
    sourceVideo.style.background = '#000';
    root.appendChild(sourceVideo);

    this.videoMode = 'moved';
    this.restoreMovedVideo = () => {
      if (placeholder.parentNode) {
        placeholder.parentNode.replaceChild(sourceVideo, placeholder);
      } else if (parent.isConnected) {
        parent.appendChild(sourceVideo);
      }
      if (prevStyleAttr === null) {
        sourceVideo.removeAttribute('style');
      } else {
        sourceVideo.setAttribute('style', prevStyleAttr);
      }
    };

    return 'moved';
  }

  private buildPipControls(
    doc: Document,
    sourceVideo: PipCapableVideoElement,
    strings: PipUiStrings,
  ): HTMLElement {
    const nav = doc.createElement('nav');
    nav.id = 'margin-pip-controls';
    nav.setAttribute('aria-label', strings.title);

    const makeBtn = (
      action: string,
      label: string,
      title: string,
      onClick: () => void,
    ) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.dataset.action = action;
      btn.textContent = label;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
      });
      return btn;
    };

    const rewindBtn = makeBtn('rewind', '-10s', strings.rewind, () => {
      sourceVideo.currentTime = clampSeekTime(
        sourceVideo.currentTime,
        -10,
        sourceVideo.duration,
      );
    });

    const playBtn = makeBtn('play', '▶', strings.play, () => {
      if (sourceVideo.paused) {
        void sourceVideo.play().catch(() => {});
      } else {
        sourceVideo.pause();
      }
    });

    const forwardBtn = makeBtn('forward', '+10s', strings.forward, () => {
      sourceVideo.currentTime = clampSeekTime(
        sourceVideo.currentTime,
        10,
        sourceVideo.duration,
      );
    });

    const muteBtn = makeBtn('mute', '🔊', strings.mute, () => {
      sourceVideo.muted = !sourceVideo.muted;
    });

    const closeBtn = makeBtn('close', '×', strings.close, () => {
      void this.close();
    });

    nav.append(rewindBtn, playBtn, forwardBtn, muteBtn, closeBtn);

    const syncControls = () => this.updateTransportState(strings);
    const mediaEvents = ['play', 'pause', 'ended', 'volumechange', 'durationchange'];
    for (const evt of mediaEvents) {
      sourceVideo.addEventListener(evt, syncControls);
      this.cleanupCallbacks.push(() => sourceVideo.removeEventListener(evt, syncControls));
    }

    return nav;
  }

  private updateTransportState(strings: PipUiStrings): void {
    const doc = this.pipDocument;
    const video = this.sourceVideo;
    if (!doc || !video) return;

    const playBtn = doc.querySelector<HTMLButtonElement>('[data-action="play"]');
    if (playBtn) {
      const paused = video.paused;
      playBtn.textContent = paused ? '▶' : '❚❚';
      playBtn.title = paused ? strings.play : strings.pause;
      playBtn.setAttribute('aria-label', playBtn.title);
    }

    const muteBtn = doc.querySelector<HTMLButtonElement>('[data-action="mute"]');
    if (muteBtn) {
      const muted = video.muted || video.volume === 0;
      muteBtn.textContent = muted ? '🔇' : '🔊';
      muteBtn.title = muted ? strings.unmute : strings.mute;
      muteBtn.setAttribute('aria-label', muteBtn.title);
    }

    const seekable = Number.isFinite(video.duration) && video.duration > 0;
    for (const action of ['rewind', 'forward']) {
      const btn = doc.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
      if (btn) btn.disabled = !seekable;
    }
  }

  private handlePipKeyDown(event: KeyboardEvent, video: PipCapableVideoElement): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const activeTag = this.pipDocument?.activeElement?.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

    const key = event.key.toLowerCase();
    if (key === ' ' || key === 'k') {
      event.preventDefault();
      if (video.paused) {
        void video.play().catch(() => {});
      } else {
        video.pause();
      }
      return;
    }
    if (key === 'arrowleft') {
      event.preventDefault();
      video.currentTime = clampSeekTime(video.currentTime, -5, video.duration);
      return;
    }
    if (key === 'arrowright') {
      event.preventDefault();
      video.currentTime = clampSeekTime(video.currentTime, 5, video.duration);
      return;
    }
    if (key === 'm') {
      event.preventDefault();
      video.muted = !video.muted;
      return;
    }
    if (key === 'escape') {
      event.preventDefault();
      void this.close();
    }
  }

  private renderPipSubtitles(): void {
    const doc = this.pipDocument;
    if (!doc) return;

    const root = doc.getElementById('margin-pip-root');
    const container = doc.getElementById('margin-pip-subtitles');
    const originalEl = doc.getElementById('margin-pip-original');
    const translatedEl = doc.getElementById('margin-pip-translated');
    if (!container || !originalEl || !translatedEl) return;

    const origPct = clampFontSizePercent(this.cueState.sourceScalePercent, 100);
    const transPct = clampFontSizePercent(
      this.cueState.translationScalePercent ?? this.cueState.fontSizePercent,
      70,
    );
    const preset = normalizeSubtitleStylePreset(this.cueState.stylePreset);
    container.style.setProperty('--margin-orig-scale', (origPct / 100).toFixed(3));
    container.style.setProperty('--margin-trans-scale', (transPct / 100).toFixed(3));
    applyNativeThemeVariablesToElement(container, this.cueState);
    container.dataset.stylePreset = preset;
    container.dataset.position = this.cueState.position;
    if (root) {
      root.dataset.position = this.cueState.position;
    }

    const { originalLine, translatedLine } = resolveRenderedCueLines(this.cueState);

    let origSeg = originalEl.querySelector<HTMLElement>('.margin-sub-seg');
    if (!origSeg) {
      origSeg = doc.createElement('span');
      origSeg.className = 'margin-sub-seg';
      originalEl.replaceChildren(origSeg);
    }
    origSeg.textContent = originalLine;
    originalEl.hidden = !originalLine;

    const targetBcp47 = normalizeSubtitleTargetLang(this.cueState.targetLang);
    if (targetBcp47) {
      translatedEl.setAttribute('lang', targetBcp47);
      translatedEl.setAttribute('dir', resolveSubtitleTargetDir(targetBcp47));
    } else {
      translatedEl.removeAttribute('lang');
      translatedEl.removeAttribute('dir');
    }

    let transSeg = translatedEl.querySelector<HTMLElement>('.margin-sub-seg');
    if (!transSeg) {
      transSeg = doc.createElement('span');
      transSeg.className = 'margin-sub-seg';
      translatedEl.replaceChildren(transSeg);
    }
    transSeg.textContent = translatedLine;
    translatedEl.hidden = !translatedLine;

    container.hidden = !originalLine && !translatedLine;
  }

  private cleanupState(): void {
    for (const fn of this.cleanupCallbacks.splice(0)) {
      try {
        fn();
      } catch {
        // Best-effort cleanup
      }
    }

    if (this.videoMode === 'moved' && this.restoreMovedVideo) {
      try {
        this.restoreMovedVideo();
      } catch {
        // Ignore restoration errors on torn-down host documents
      }
    }

    if (this.mirrorVideo) {
      try {
        this.mirrorVideo.srcObject = null;
      } catch {
        // Ignore detached mirror element
      }
    }

    if (this.captureStream) {
      for (const track of this.captureStream.getTracks?.() ?? []) {
        try {
          track.stop();
        } catch {
          // Ignore ended tracks
        }
      }
    }

    const hadActiveSession =
      this.pipWindow !== null || this.videoMode !== null;

    this.pipWindow = null;
    this.pipDocument = null;
    this.sourceVideo = null;
    this.mirrorVideo = null;
    this.captureStream = null;
    this.videoMode = null;
    this.restoreMovedVideo = null;

    if (hadActiveSession) {
      this.onActiveChange?.(false, null);
    }
  }

  /**
   * Renders a brief, non-blocking Quiet Paper / Warm Charcoal editorial notice
   * isolated inside a Shadow DOM host so page styles never distort it.
   */
  public showQuietPaperNotice(message: string): void {
    this.hostDocument.getElementById(PIP_NOTICE_HOST_ID)?.remove();
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }

    const host = this.hostDocument.createElement('div');
    host.id = PIP_NOTICE_HOST_ID;
    host.setAttribute('data-display-mode', 'night');

    const shadow = host.attachShadow({ mode: 'open' });
    const style = this.hostDocument.createElement('style');
    style.textContent = `
      ${SHADOW_HOST_RESET_CSS}
      :host {
        position: fixed !important;
        top: 20px !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
      }
      .margin-pip-notice {
        max-width: min(520px, 90vw);
        padding: 10px 16px;
        border-radius: 6px;
        background: var(--paper, #151411);
        color: var(--ink, #ece4d2);
        border: 1px solid var(--rule-strong, rgba(201, 148, 85, 0.3));
        border-left: 3px solid var(--accent, #c99455);
        font-size: 13px;
        line-height: 1.5;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.34);
      }
    `;

    const card = this.hostDocument.createElement('div');
    card.className = 'margin-pip-notice';
    card.setAttribute('role', 'status');
    card.textContent = message;

    shadow.append(style, card);
    (this.hostDocument.body ?? this.hostDocument.documentElement)?.appendChild(host);

    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      host.remove();
    }, this.noticeDurationMs);
  }
}

function buildPipWindowStyles(): string {
  return /* css */ `
    *, *::before, *::after {
      box-sizing: border-box;
    }
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      background: #0d0c0a;
      overflow: hidden;
      font-family: "Segoe UI Variable", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
      color: #ece4d2;
    }
    #margin-pip-root {
      position: relative;
      width: 100%;
      height: 100%;
      background: #000;
      overflow: hidden;
    }
    #margin-pip-root > video {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
    }
    #margin-pip-subtitles {
      --margin-orig-scale: 1;
      --margin-trans-scale: 0.7;
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
      left: 4%;
      right: 4%;
      bottom: 7%;
      z-index: 20;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      pointer-events: none;
      text-align: center;
      font-family: "YouTube Noto", Roboto, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    }
    #margin-pip-subtitles[data-style-preset="youtube-native"] {
      font-family: var(--margin-yt-font-family, var(--margin-yt-font));
      font-variant: var(--margin-yt-variant, normal);
      background: var(--margin-yt-win-bg, transparent);
      width: fit-content;
      max-width: 92%;
      margin-left: auto;
      margin-right: auto;
      padding: 2px 4px;
      border-radius: 3px;
    }
    #margin-pip-subtitles[data-position="top"] {
      bottom: auto;
      top: 7%;
    }
    #margin-pip-subtitles[hidden],
    .margin-pip-line[hidden] {
      display: none !important;
    }
    .margin-pip-line {
      width: fit-content;
      max-width: 96%;
      padding: 0;
      margin: 0;
      background: transparent;
      border: none;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      text-shadow: none;
      line-height: 1.48;
    }
    #margin-pip-subtitles[data-style-preset="youtube-native"] .margin-pip-line {
      max-width: 100%;
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
    .margin-pip-original,
    .cue-orig {
      color: var(--margin-yt-fg, #ffffff);
      font-size: calc(clamp(14px, 3.2vw, 24px) * var(--margin-orig-scale, 1) * var(--margin-yt-scale-mult, 1));
      font-weight: 500;
    }
    #margin-pip-subtitles[data-style-preset="youtube-native"] .margin-pip-original,
    #margin-pip-subtitles[data-style-preset="youtube-native"] .cue-orig {
      font-family: var(--margin-yt-font-family, var(--margin-yt-font));
    }
    .margin-pip-translated,
    .cue-trans {
      color: var(--margin-yt-trans-fg, rgba(255, 255, 255, 0.96));
      font-family: var(--margin-sub-trans-font-family);
      font-size: calc(clamp(14px, 3.2vw, 24px) * var(--margin-trans-scale, 0.7) * var(--margin-yt-scale-mult, 1));
      font-weight: 500;
      unicode-bidi: isolate;
    }
    #margin-pip-subtitles[data-style-preset="youtube-native"] .margin-pip-translated,
    #margin-pip-subtitles[data-style-preset="youtube-native"] .cue-trans {
      font-family: var(--margin-yt-trans-font-family, var(--margin-yt-font-family));
    }
    .margin-pip-translated .margin-sub-seg {
      color: var(--margin-yt-trans-fg, rgba(255, 255, 255, 0.96));
    }
    #margin-pip-subtitles[data-style-preset="cinema-outline"] {
      gap: 3px;
    }
    #margin-pip-subtitles[data-style-preset="cinema-outline"] .margin-sub-seg {
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
    #margin-pip-subtitles[data-style-preset="warm-paper"] {
      gap: 4px;
    }
    #margin-pip-subtitles[data-style-preset="warm-paper"] .margin-pip-line {
      padding: 3px 10px 4px;
      border-radius: 5px;
      background: rgba(21, 20, 17, 0.82);
      border: 1px solid rgba(201, 148, 85, 0.24);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.88);
      line-height: 1.36;
    }
    #margin-pip-subtitles[data-style-preset="warm-paper"] .margin-sub-seg {
      background: transparent;
      padding: 0;
      color: inherit;
    }
    #margin-pip-subtitles[data-style-preset="warm-paper"] .margin-pip-original {
      color: rgba(236, 228, 210, 0.90);
    }
    #margin-pip-subtitles[data-style-preset="warm-paper"] .margin-pip-translated {
      color: #fbfaf6;
    }
    #margin-pip-controls {
      position: absolute;
      top: 8px;
      left: 50%;
      z-index: 30;
      display: flex;
      gap: 6px;
      align-items: center;
      transform: translateX(-50%);
      padding: 5px 7px;
      border-radius: 6px;
      background: rgba(21, 20, 17, 0.86);
      border: 1px solid rgba(201, 148, 85, 0.28);
      backdrop-filter: blur(8px);
      opacity: 0;
      transition: opacity 160ms cubic-bezier(0.2, 0.72, 0.2, 1);
    }
    #margin-pip-root[data-position="top"] #margin-pip-controls {
      top: auto;
      bottom: 8px;
    }
    body:hover #margin-pip-controls,
    #margin-pip-controls:focus-within {
      opacity: 1;
    }
    #margin-pip-controls button {
      min-width: 36px;
      height: 28px;
      padding: 0 8px;
      border: 1px solid rgba(236, 228, 210, 0.14);
      border-radius: 4px;
      background: rgba(251, 250, 246, 0.08);
      color: #ece4d2;
      font: 600 12px/1 "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease;
    }
    #margin-pip-controls button:hover:not(:disabled) {
      background: rgba(201, 148, 85, 0.22);
      border-color: rgba(201, 148, 85, 0.48);
    }
    #margin-pip-controls button:focus-visible {
      outline: 2px solid #c99455;
      outline-offset: 2px;
    }
    #margin-pip-controls button:disabled {
      opacity: 0.36;
      cursor: not-allowed;
    }
    #margin-pip-controls [data-action="close"] {
      font-size: 18px;
      line-height: 1;
    }
  `;
}
