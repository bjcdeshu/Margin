import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND } from '@shared/brand';
import { createDefaultMarginConfig } from '@shared/constants';
import type { YoutubeMainBridgeMessage } from '@shared/types';
import { createSubtitleIsolatedController, SUBTITLE_OVERLAY_HOST_ID } from '../../src/youtube/isolated-entry';
import {
  createYoutubeMainController,
  SUBTITLE_TOGGLE_BUTTON_ID,
} from '../../src/youtube/main-entry';
import {
  clampSeekTime,
  computePipDimensions,
  normalizeActiveCueState,
  PIP_BUTTON_ID,
  PIP_NOTICE_HOST_ID,
  YoutubePipPlayer,
  type PipCapableVideoElement,
} from '../../src/youtube/pip-player';

function createMockVideo(overrides: Partial<PipCapableVideoElement> = {}): PipCapableVideoElement {
  const video = document.createElement('video') as PipCapableVideoElement;
  video.className = 'html5-main-video';
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'videoWidth', { value: 1920, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 1080, configurable: true });
  Object.defineProperty(video, 'duration', { value: 120, configurable: true });
  video.play = vi.fn().mockResolvedValue(undefined);
  video.pause = vi.fn();
  Object.assign(video, overrides);
  return video;
}

describe('YouTube Bilingual Document PiP & Guardrail 2 Fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    delete window.documentPictureInPicture;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    delete window.documentPictureInPicture;
  });

  it('clamps PiP dimensions proportionally to [320, 720] and clamps seek targets safely', () => {
    expect(computePipDimensions(1920, 1080, 560)).toEqual({
      width: 560,
      height: 315,
    });
    expect(computePipDimensions(0, 0, 100)).toEqual({
      width: 320,
      height: 240,
    });
    expect(computePipDimensions(1080, 1920, 900)).toEqual({
      width: 720,
      height: 720,
    });

    expect(clampSeekTime(4, -10, 100)).toBe(0);
    expect(clampSeekTime(95, 10, 100)).toBe(100);
    expect(clampSeekTime(12, 5, Number.POSITIVE_INFINITY)).toBe(17);
  });

  it('suppresses duplicate translated === original cues and debounces empty cue gaps by 120ms', async () => {
    expect(
      normalizeActiveCueState({
        original: 'LLM',
        translated: 'LLM',
        mode: 'bilingual',
      }),
    ).toMatchObject({
      original: 'LLM',
      translated: '',
    });

    const pipDoc = document.implementation.createHTMLDocument('pip');
    const pipWin = {
      document: pipDoc,
      closed: false,
      close: vi.fn(function (this: { closed: boolean }) {
        this.closed = true;
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;

    window.documentPictureInPicture = {
      requestWindow: vi.fn().mockResolvedValue(pipWin),
    };

    const mockTrack = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const video = createMockVideo({
      captureStream: () =>
        ({
          getVideoTracks: () => [mockTrack],
          getTracks: () => [mockTrack],
        }) as unknown as MediaStream,
    });
    document.body.appendChild(video);

    const player = new YoutubePipPlayer();
    const mode = await player.open();
    expect(mode).toBe('document-pip-stream');

    const pipMirror = pipDoc.getElementById('margin-pip-video') as HTMLVideoElement | null;
    expect(pipMirror?.muted).toBe(true);

    // Push Cue 1
    player.updateCue({
      original: 'First line',
      translated: '第一行',
      mode: 'bilingual',
      fontSizePercent: 84,
      position: 'top',
    });

    const container = pipDoc.getElementById('margin-pip-subtitles')!;
    const origEl = pipDoc.getElementById('margin-pip-original')!;
    const transEl = pipDoc.getElementById('margin-pip-translated')!;

    expect(container.hidden).toBe(false);
    expect(container.dataset.position).toBe('top');
    expect(origEl.textContent).toBe('First line');
    expect(transEl.textContent).toBe('第一行');

    // Push empty gap -> after 80ms (< 120ms), Cue 1 MUST remain visible without flicker!
    player.updateCue({ original: '', translated: '' });
    vi.advanceTimersByTime(80);
    expect(container.hidden).toBe(false);
    expect(transEl.textContent).toBe('第一行');

    // Cue 2 arrives at +80ms -> seamlessly replaces Cue 1 and cancels clear timer!
    player.updateCue({ original: 'Second line', translated: '第二行' });
    vi.advanceTimersByTime(100);
    expect(container.hidden).toBe(false);
    expect(transEl.textContent).toBe('第二行');

    // Empty gap lasting >= 120ms -> cleanly clears overlay
    player.updateCue({ original: '', translated: '' });
    vi.advanceTimersByTime(125);
    expect(container.hidden).toBe(true);
    expect(origEl.hidden).toBe(true);
    expect(transEl.hidden).toBe(true);

    await player.close();
    expect(mockTrack.stop).toHaveBeenCalled();
  });

  it('falls back to moving <video> when captureStream is unavailable and restores exact placeholder & styles on close', async () => {
    const pipDoc = document.implementation.createHTMLDocument('pip-moved');
    let pageHideHandler: (() => void) | undefined;
    const pipWin = {
      document: pipDoc,
      closed: false,
      close: vi.fn(function (this: { closed: boolean }) {
        this.closed = true;
      }),
      addEventListener: vi.fn((evt: string, cb: () => void) => {
        if (evt === 'pagehide') pageHideHandler = cb;
      }),
      removeEventListener: vi.fn(),
    } as unknown as Window;

    window.documentPictureInPicture = {
      requestWindow: vi.fn().mockResolvedValue(pipWin),
    };

    const wrapper = document.createElement('div');
    const beforeSibling = document.createElement('span');
    const video = createMockVideo({ captureStream: undefined });
    video.setAttribute('style', 'width: 640px; height: 360px;');
    const afterSibling = document.createElement('span');
    wrapper.append(beforeSibling, video, afterSibling);
    document.body.appendChild(wrapper);

    const player = new YoutubePipPlayer();
    const mode = await player.open();
    expect(mode).toBe('document-pip-moved');
    expect(pipDoc.getElementById('margin-pip-root')?.contains(video)).toBe(true);
    expect(wrapper.contains(video)).toBe(false);

    // Simulate PiP window pagehide -> restores video between beforeSibling and afterSibling with original style
    pageHideHandler?.();
    expect(wrapper.contains(video)).toBe(true);
    expect(video.previousSibling).toBe(beforeSibling);
    expect(video.nextSibling).toBe(afterSibling);
    expect(video.getAttribute('style')).toBe('width: 640px; height: 360px;');
  });

  it('enforces Guardrail 2: calls video.requestPictureInPicture() and shows Quiet Paper notice when Document PiP is unavailable', async () => {
    delete window.documentPictureInPicture;
    const video = createMockVideo();
    const requestNativePip = vi.fn().mockResolvedValue({});
    video.requestPictureInPicture = requestNativePip;
    document.body.appendChild(video);

    const player = new YoutubePipPlayer();
    const mode = await player.open();

    expect(mode).toBe('native-video-pip');
    expect(requestNativePip).toHaveBeenCalledTimes(1);

    const noticeHost = document.getElementById(PIP_NOTICE_HOST_ID);
    expect(noticeHost).not.toBeNull();
    const noticeText = noticeHost?.shadowRoot?.textContent ?? '';
    expect(noticeText.toLowerCase()).toContain('native');
    expect(noticeText.toLowerCase()).toContain('bilingual');

    player.destroy();
  });

  it('bridges MAIN timedtext capture -> ISOLATED translator -> in-player Shadow overlay & PiP cue bus', async () => {
    vi.useRealTimers();
    const happyWin = window as unknown as {
      happyDOM?: { setURL: (url: string) => void };
    };
    if (happyWin.happyDOM?.setURL) {
      happyWin.happyDOM.setURL('https://www.youtube.com/watch?v=testVid123');
    } else {
      Object.defineProperty(window, 'location', {
        value: new URL('https://www.youtube.com/watch?v=testVid123'),
        configurable: true,
      });
    }

    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    playerEl.className = 'html5-video-player';
    const rightControls = document.createElement('div');
    rightControls.className = 'ytp-right-controls';
    const video = createMockVideo();
    video.currentTime = 0.5;
    playerEl.append(video, rightControls);
    document.body.appendChild(playerEl);

    const baseFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          events: [
            { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Good morning' }] },
          ],
        }),
        { status: 200 },
      ),
    );
    window.fetch = baseFetch;

    const cfg = createDefaultMarginConfig();
    const mainCtrl = createYoutubeMainController();
    const isolatedCtrl = createSubtitleIsolatedController({
      loadConfig: async () => cfg,
      subscribeConfig: () => () => {},
      translateBatch: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: req.items.map((item) => ({ id: item.id, trans: '早上好' })),
        diagnostic: {
          schemaVersion: 1,
          product: BRAND.name,
          version: BRAND.version,
          time: new Date().toISOString(),
          scene: 'subtitle',
          codec: 'single-text',
          provider: {
            id: 'google-free',
            preset: 'google-free',
            protocol: 'google-web',
            endpointOrigin: 'https://translate.googleapis.com',
            endpointPath: '/translate_a/single',
            model: 'gtx',
          },
          parameters: {
            temperatureTrace: 'omitted-default',
            thinkingMode: 'provider-default',
            stream: false,
          },
          kind: 'ok',
          retryable: false,
          attempts: 1,
          latencyMs: 50,
        },
      }),
    });

    mainCtrl.start();
    await isolatedCtrl.start();

    // Wait a microtask/rAF for player button scan
    await new Promise((r) => setTimeout(r, 30));
    expect(document.getElementById(PIP_BUTTON_ID)).not.toBeNull();
    expect(document.getElementById(SUBTITLE_TOGGLE_BUTTON_ID)).not.toBeNull();

    // Trigger hooked fetch for `/api/timedtext`
    await window.fetch(
      'https://www.youtube.com/api/timedtext?v=testVid123&lang=en&fmt=json3',
    );
    // Simulate playhead tick at 500ms
    const tickMsg: YoutubeMainBridgeMessage = {
      source: BRAND.ytBridgeSourceMain,
      type: 'playhead-tick',
      videoId: 'testVid123',
      currentTimeMs: 500,
      paused: false,
    };
    window.postMessage(tickMsg, '*');

    await new Promise((r) => setTimeout(r, 50));

    // Verify Shadow-isolated in-player overlay rendered bilingual cue AND synced to PiP state bus!
    const overlayHost = document.getElementById(SUBTITLE_OVERLAY_HOST_ID);
    expect(overlayHost).not.toBeNull();
    expect(
      overlayHost?.shadowRoot?.getElementById('margin-sub-original')?.textContent,
    ).toBe('Good morning');
    expect(
      overlayHost?.shadowRoot?.getElementById('margin-sub-translated')?.textContent,
    ).toBe('早上好');

    expect(mainCtrl.getPipPlayer().getCueState()).toMatchObject({
      original: 'Good morning',
      translated: '早上好',
      mode: 'bilingual',
    });

    // Clicking subtitle toggle button turns bilingual overlay off & clears active cue
    const toggleBtn = document.getElementById(SUBTITLE_TOGGLE_BUTTON_ID) as HTMLButtonElement;
    toggleBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).toBeNull();
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');

    isolatedCtrl.destroy();
    mainCtrl.destroy();
  });

  it('handles PiP transport bar buttons, keyboard shortcuts (Space/K/Arrows/M/Esc), and display modes', async () => {
    const pipDoc = document.implementation.createHTMLDocument('pip-keys');
    const keyListeners: Array<(ev: KeyboardEvent) => void> = [];
    const pipWin = {
      document: pipDoc,
      closed: false,
      close: vi.fn(function (this: { closed: boolean }) {
        this.closed = true;
      }),
      addEventListener: vi.fn((evt: string, cb: (ev: KeyboardEvent) => void) => {
        if (evt === 'keydown') keyListeners.push(cb);
      }),
      removeEventListener: vi.fn(),
    } as unknown as Window;

    window.documentPictureInPicture = {
      requestWindow: vi.fn().mockResolvedValue(pipWin),
    };

    let isPaused = true;
    const video = createMockVideo({
      captureStream: () =>
        ({
          getVideoTracks: () => [{ stop: vi.fn() }],
          getTracks: () => [{ stop: vi.fn() }],
        }) as unknown as MediaStream,
    });
    Object.defineProperty(video, 'paused', {
      get: () => isPaused,
      configurable: true,
    });
    video.play = vi.fn().mockImplementation(async () => {
      isPaused = false;
    });
    video.pause = vi.fn().mockImplementation(() => {
      isPaused = true;
    });
    video.currentTime = 30;
    document.body.appendChild(video);

    const player = new YoutubePipPlayer();
    await player.open();

    // Target-only & Source-only display modes
    player.updateCue({
      original: 'Hello',
      translated: '你好',
      mode: 'target-only',
    });
    expect(pipDoc.getElementById('margin-pip-original')?.hidden).toBe(true);
    expect(pipDoc.getElementById('margin-pip-translated')?.textContent).toBe('你好');

    player.updateSettings({
      displayMode: 'source-only',
      fontSizePercent: 90,
      position: 'bottom',
    });
    expect(pipDoc.getElementById('margin-pip-original')?.hidden).toBe(false);
    expect(pipDoc.getElementById('margin-pip-translated')?.hidden).toBe(true);

    // Transport buttons: +10s, -10s, mute
    (pipDoc.querySelector('[data-action="forward"]') as HTMLButtonElement).click();
    expect(video.currentTime).toBe(40);
    (pipDoc.querySelector('[data-action="rewind"]') as HTMLButtonElement).click();
    expect(video.currentTime).toBe(30);
    (pipDoc.querySelector('[data-action="mute"]') as HTMLButtonElement).click();
    expect(video.muted).toBe(true);

    // Keyboard shortcuts: K (play), ArrowRight (+5s), ArrowLeft (-5s), M (unmute), Escape (close)
    const dispatchPipKey = (key: string) => {
      const ev = new KeyboardEvent('keydown', { key, cancelable: true });
      keyListeners.forEach((fn) => fn(ev));
    };

    dispatchPipKey('k');
    expect(video.play).toHaveBeenCalledTimes(1);
    dispatchPipKey('ArrowRight');
    expect(video.currentTime).toBe(35);
    dispatchPipKey('ArrowLeft');
    expect(video.currentTime).toBe(30);
    dispatchPipKey('m');
    expect(video.muted).toBe(false);
    dispatchPipKey('Escape');
    expect(player.isActive()).toBe(false);
  });

  it('supports generic HTML5 <video><track> bilingual captions on non-YouTube sites', async () => {
    vi.useRealTimers();
    const happyWin = window as unknown as {
      happyDOM?: { setURL: (url: string) => void };
    };
    happyWin.happyDOM?.setURL('https://courses.example.edu/lecture-1');

    const container = document.createElement('div');
    const video = createMockVideo();
    video.currentTime = 1.5;
    Object.defineProperty(video, 'textTracks', {
      value: [
        {
          kind: 'subtitles',
          mode: 'showing',
          cues: [{ startTime: 1.0, endTime: 3.0, text: 'Welcome students' }],
        },
      ],
      configurable: true,
    });
    container.appendChild(video);
    document.body.appendChild(container);

    const cfg = createDefaultMarginConfig();
    const isolated = createSubtitleIsolatedController({
      loadConfig: async () => cfg,
      subscribeConfig: () => () => {},
      translateBatch: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: req.items.map((i) => ({ id: i.id, trans: '欢迎同学们' })),
        diagnostic: {
          schemaVersion: 1,
          product: BRAND.name,
          version: BRAND.version,
          time: new Date().toISOString(),
          scene: 'subtitle',
          codec: 'single-text',
          provider: {
            id: 'google-free',
            preset: 'google-free',
            protocol: 'google-web',
            endpointOrigin: 'https://translate.googleapis.com',
            endpointPath: '/translate_a/single',
            model: 'gtx',
          },
          parameters: {
            temperatureTrace: 'omitted-default',
            thinkingMode: 'provider-default',
            stream: false,
          },
          kind: 'ok',
          retryable: false,
          attempts: 1,
          latencyMs: 20,
        },
      }),
    });

    await isolated.start();
    await new Promise((r) => setTimeout(r, 40));

    const overlayHost = document.getElementById(SUBTITLE_OVERLAY_HOST_ID);
    expect(overlayHost).not.toBeNull();
    expect(
      overlayHost?.shadowRoot?.getElementById('margin-sub-original')?.textContent,
    ).toBe('Welcome students');
    expect(
      overlayHost?.shadowRoot?.getElementById('margin-sub-translated')?.textContent,
    ).toBe('欢迎同学们');

    isolated.destroy();
  });

  it('intercepts XMLHttpRequest /api/timedtext responses and resets cleanly on yt-navigate-finish', async () => {
    vi.useRealTimers();
    const happyWin = window as unknown as {
      happyDOM?: { setURL: (url: string) => void };
    };
    happyWin.happyDOM?.setURL('https://www.youtube.com/watch?v=xhrVid001');

    const capturedMessages: YoutubeMainBridgeMessage[] = [];
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.source === BRAND.ytBridgeSourceMain && ev.data?.type === 'caption-track-captured') {
        capturedMessages.push(ev.data as YoutubeMainBridgeMessage);
      }
    };
    window.addEventListener('message', onMsg);

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function mockUnderlyingSend(this: XMLHttpRequest) {
      Object.defineProperty(this, 'responseText', {
        value: JSON.stringify({
          events: [{ tStartMs: 200, dDurationMs: 1800, segs: [{ utf8: 'XHR cue' }] }],
        }),
        configurable: true,
      });
      this.dispatchEvent(new Event('load'));
    };

    const mainCtrl = createYoutubeMainController();
    mainCtrl.start();

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://www.youtube.com/api/timedtext?v=xhrVid001&lang=en&fmt=json3');
    xhr.send();

    await new Promise((r) => setTimeout(r, 20));
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0]).toMatchObject({
      type: 'caption-track-captured',
      videoId: 'xhrVid001',
      langCode: 'en',
    });

    // Simulate SPA navigation to a new video -> clears PiP cue immediately
    mainCtrl.getPipPlayer().updateCue({ original: 'XHR cue', translated: 'XHR 字幕' });
    happyWin.happyDOM?.setURL('https://www.youtube.com/watch?v=xhrVid002');
    window.dispatchEvent(new Event('yt-navigate-finish'));
    expect(mainCtrl.getPipPlayer().getCueState().original).toBe('');

    mainCtrl.destroy();
    XMLHttpRequest.prototype.send = origSend;
    window.removeEventListener('message', onMsg);
  });
});
