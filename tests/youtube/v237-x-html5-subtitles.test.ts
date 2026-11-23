import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultMarginConfig } from '@shared/constants';
import type {
  MarginConfig,
  SubtitleCue,
  TranslateBatchRequest,
  TranslateBatchResponse,
} from '@shared/types';
import {
  buildSubtitleBatchRequest,
  partitionCuesIntoBatches,
  planSubtitleBatches,
  SubtitleBatchScheduler,
} from '../../src/youtube/batching';
import {
  computeHtml5BottomOffset,
  computeHtml5CaptionTypography,
  computeVisibleRatio,
  findNativeCaptionLayer,
  isHostCaptionsOn,
  mergeHtml5Cues,
  NATIVE_CAPTION_HIDDEN_ATTR,
  NATIVE_CUE_SUPPRESSED_ATTR,
  NATIVE_HTML5_HIDE_STYLE_ID,
  normalizeForCaptionMatch,
  pickCaptionTrack,
  rebaseSmpteBroadcastOffset,
  recordCueTranslationsInMemo,
  selectActiveHtml5Video,
} from '../../src/youtube/html5-video';
import {
  createSubtitleIsolatedController,
  ISOLATED_CONTROLLER_KEY,
  SUBTITLE_OVERLAY_HOST_ID,
} from '../../src/youtube/isolated-entry';
import {
  buildSourceTrackFingerprint,
  cleanPipCueText,
  sanitizeSubtitleMarkup,
} from '../../src/youtube/shared';
import {
  extractTextTrackCues,
  parseWebVtt,
} from '../../src/youtube/timeline';

function setTestUrl(url: string): void {
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

function mockElementRect(
  el: Element,
  rect: { top: number; left: number; width: number; height: number },
): void {
  const full = {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  };
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => full,
    configurable: true,
  });
}

function setVideoPaused(video: HTMLVideoElement, paused: boolean): void {
  (video as unknown as { paused: boolean }).paused = paused;
}

interface FakeCue {
  startTime: number;
  endTime: number;
  text: string;
}

interface FakeTextTrackController {
  track: TextTrack;
  cues: FakeCue[];
  activeCues: FakeCue[];
  modeSetSpy: ReturnType<typeof vi.fn>;
  setHostMode: (next: TextTrackMode) => void;
  fireCueChange: () => void;
}

function createSpiedTextTrack(options: {
  id?: string;
  kind?: TextTrackKind;
  language?: string;
  label?: string;
  initialMode?: TextTrackMode;
  cues?: FakeCue[];
  activeCues?: FakeCue[];
}): FakeTextTrackController {
  let internalMode: TextTrackMode = options.initialMode ?? 'hidden';
  const cues: FakeCue[] = [...(options.cues ?? [])];
  const activeCues: FakeCue[] = [...(options.activeCues ?? cues)];
  const listeners = new Map<string, Set<() => void>>();
  const modeSetSpy = vi.fn((next: TextTrackMode) => {
    internalMode = next;
  });

  const trackObj = {
    id: options.id ?? 'x-track-1',
    kind: options.kind ?? 'subtitles',
    language: options.language ?? 'en',
    label: options.label ?? 'English',
    get cues() {
      return internalMode === 'disabled' ? null : cues;
    },
    get activeCues() {
      return internalMode === 'disabled' ? null : activeCues;
    },
    addEventListener(type: string, cb: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      listeners.get(type)?.delete(cb);
    },
  };

  Object.defineProperty(trackObj, 'mode', {
    get: () => internalMode,
    set: (val: TextTrackMode) => {
      modeSetSpy(val);
    },
    configurable: true,
    enumerable: true,
  });

  return {
    track: trackObj as unknown as TextTrack,
    cues,
    activeCues,
    modeSetSpy,
    setHostMode(next: TextTrackMode) {
      // Bypass Margin's setter spy so `modeSetSpy` strictly counts writes NOT initiated by host test harness
      internalMode = next;
    },
    fireCueChange() {
      listeners.get('cuechange')?.forEach((fn) => fn());
    },
  };
}

function createFakeTrackList(tracks: TextTrack[]): {
  list: TextTrackList;
  fire: (eventName: string) => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  const list = Object.assign([...tracks], {
    addEventListener(type: string, cb: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      listeners.get(type)?.delete(cb);
    },
  }) as unknown as TextTrackList;

  return {
    list,
    fire(eventName: string) {
      listeners.get(eventName)?.forEach((fn) => fn());
    },
  };
}

function createXVideoElement(options: {
  rect?: { top: number; left: number; width: number; height: number };
  paused?: boolean;
  muted?: boolean;
  volume?: number;
  currentTime?: number;
  duration?: number;
  readyState?: number;
  currentSrc?: string;
  textTracks?: TextTrackList;
} = {}): HTMLVideoElement {
  const video = document.createElement('video');
  const rect = options.rect ?? {
    top: 143,
    left: 238,
    width: 502,
    height: 283,
  };
  mockElementRect(video, rect);

  let pausedState = options.paused ?? false;
  let mutedState = options.muted ?? true;
  let volumeState = options.volume ?? 1;
  let timeState = options.currentTime ?? 1.0;

  Object.defineProperty(video, 'paused', {
    get: () => pausedState,
    set: (v: boolean) => {
      pausedState = v;
    },
    configurable: true,
  });
  Object.defineProperty(video, 'ended', { value: false, configurable: true });
  Object.defineProperty(video, 'readyState', {
    value: options.readyState ?? 4,
    configurable: true,
  });
  Object.defineProperty(video, 'muted', {
    get: () => mutedState,
    set: (v: boolean) => {
      mutedState = v;
    },
    configurable: true,
  });
  Object.defineProperty(video, 'volume', {
    get: () => volumeState,
    set: (v: number) => {
      volumeState = v;
    },
    configurable: true,
  });
  Object.defineProperty(video, 'currentTime', {
    get: () => timeState,
    set: (v: number) => {
      timeState = v;
    },
    configurable: true,
  });
  Object.defineProperty(video, 'duration', {
    value: options.duration ?? 20,
    configurable: true,
  });
  Object.defineProperty(video, 'videoWidth', {
    value: 1280,
    configurable: true,
  });
  Object.defineProperty(video, 'videoHeight', {
    value: 720,
    configurable: true,
  });
  Object.defineProperty(video, 'currentSrc', {
    value: options.currentSrc ?? 'blob:https://x.com/taovideo-1',
    configurable: true,
  });
  if (options.textTracks) {
    Object.defineProperty(video, 'textTracks', {
      value: options.textTracks,
      configurable: true,
    });
  }
  return video;
}

describe('v2.3.7 Suite 1 & 2: <X-word-ms> / Vendor / XML Sanitizer, Code Generics Safety & Track Fingerprints', () => {
  it('preserves every C++/TS/Rust generic, math comparison, and prose expression byte-for-byte', () => {
    const keepCorpus = [
      'std::vector<int>',
      'Array<string>',
      'Map<string, number>',
      'std::bitset<N-1>',
      'bitset<N-M>',
      'template <typename T = int>',
      'template<typename T=int>',
      "template<char C='a'>",
      'a < b && c > d',
      'if (x<y && y>z)',
      'std::map<std::string, int>',
      'Box<T = string>',
      'std::vector<std::vector<int>>',
      'Result<T, E>',
      'Foo<Bar::Baz>',
      'x <- y',
      'ratio <10:30> ok',
      'use the <div> tag',
      'f<a-b>(x)',
      'arr<X-1>',
      'cov<X-Y> here',
      '<X-Y>',
    ];

    for (const sample of keepCorpus) {
      expect(sanitizeSubtitleMarkup(sample)).toBe(sample);
      expect(cleanPipCueText(sample)).toBe(sample);
    }
  });

  it('strips <X-word-ms>, split openers/closers, WebVTT timestamps, TTML/XML vendor tags, and entity-encoded variants', () => {
    const stripCases: Array<[string, string]> = [
      [
        '<X-word-ms ms=80,79,59,280,80,219,240,139 index=1 character_ranges=0-1,2-4,5-8,9-17,18-21,22-27,28-32,33-36>So do you remember the first time you</X-word-ms>',
        'So do you remember the first time you',
      ],
      ['<X-word-ms ms=80 index=2 character_ranges=0-1>Hello', 'Hello'],
      ['world</X-word-ms>', 'world'],
      ['<00:00:01.234>Hi <00:01.20>there <00:01:02>x', 'Hi there x'],
      ['<tt:span style="s1">Hola</tt:span>', 'Hola'],
      ['<foo>bar</foo> baz', 'bar baz'],
      ['<custom a=1 b=2>txt', 'txt'],
      ['a<x-y z="1"/>b', 'ab'],
      [
        '&lt;X-word-ms ms=80,79 index=1 character_ranges=0-1,2-4&gt;So do you remember&lt;/X-word-ms&gt;',
        'So do you remember',
      ],
      [
        'std::vector<int> <X-word-ms ms=1 index=3>uses</X-word-ms> Array<string>',
        'std::vector<int> uses Array<string>',
      ],
    ];

    for (const [raw, expected] of stripCases) {
      expect(sanitizeSubtitleMarkup(raw)).toBe(expected);
    }

    // Adversarial ReDoS check (< 50ms budget)
    const manyAttrs = '<a ' + 'b=1 '.repeat(3000) + 'x'.repeat(5000);
    const manyLt = '<'.repeat(20_000);
    const longVendor = '<X-aa ' + 'a'.repeat(20_000);
    const t0 = performance.now();
    sanitizeSubtitleMarkup(manyAttrs);
    sanitizeSubtitleMarkup(manyLt);
    sanitizeSubtitleMarkup(longVendor);
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(50);
  });

  it('extracts clean cues from X-word-ms TextTrack/WebVTT and produces identical fingerprints across timing-noise variants', () => {
    const cuesTrackA = extractTextTrackCues([
      {
        startTime: 0.5,
        endTime: 3.2,
        text: '<X-word-ms ms=80,79,59 index=1 character_ranges=0-1,2-4>So do you remember the first time you</X-word-ms>',
      },
    ]);
    const cuesTrackB = extractTextTrackCues([
      {
        startTime: 0.5,
        endTime: 3.2,
        text: '<X-word-ms ms=95,110,45 index=99 character_ranges=0-1,2-4,5-9>So do you remember the first time you</X-word-ms>',
      },
    ]);

    expect(cuesTrackA).toEqual([
      {
        tStartMs: 500,
        dDurationMs: 2700,
        text: 'So do you remember the first time you',
      },
    ]);
    expect(
      buildSourceTrackFingerprint('vid-x', 'en', cuesTrackA),
    ).toBe(buildSourceTrackFingerprint('vid-x', 'en', cuesTrackB));

    const vtt = [
      'WEBVTT',
      'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000',
      '',
      '01:00:01.000 --> 01:00:03.500',
      '<X-word-ms ms=100,120 index=1 character_ranges=0-4,5-10>Hello world</X-word-ms>',
    ].join('\n');
    const parsedSmpte = parseWebVtt(vtt);
    expect(parsedSmpte[0]?.text).toBe('Hello world');
    expect(parsedSmpte[0]?.tStartMs).toBe(3_601_000);

    // SMPTE 01:00:00 offset rebases for short 20s video, stays untouched on 2h lecture
    expect(rebaseSmpteBroadcastOffset(parsedSmpte, 20_000)[0]?.tStartMs).toBe(
      1_000,
    );
    expect(
      rebaseSmpteBroadcastOffset(parsedSmpte, 7_200_000)[0]?.tStartMs,
    ).toBe(3_601_000);
  });
});

describe('v2.3.7 Suite 3: SubtitleBatchScheduler Dispatch Gate, HLS appendCues & Refill Window', () => {
  it('strips vendor tags at ingestion for batch char-budget & idempotently in buildSubtitleBatchRequest, and plans 2400 cues in < 2ms (P1-1)', () => {
    const noisyText =
      '<X-word-ms ms=80,79,59,280,80,219,240,139 index=1 character_ranges=0-1,2-4,5-8,9-17,18-21,22-27,28-32,33-36>So do you remember the first time you</X-word-ms>';
    // Ingested cues are sanitized once at extraction (37 chars each -> 2 cues fit in maxCharsPerBatch = 90)
    const ingested = extractTextTrackCues([
      { startTime: 0, endTime: 2, text: noisyText },
      { startTime: 2, endTime: 4, text: noisyText },
    ]);
    const cleanEntries = ingested.map((cue, cueIndex) => ({ cueIndex, cue }));
    const batches = partitionCuesIntoBatches(cleanEntries, {
      maxBatchCount: 10,
      maxCharsPerBatch: 90,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);

    // Defense-in-depth: even if raw unsanitized cue text reaches buildSubtitleBatchRequest, wire payload is stripped
    const rawEntries = [
      { cueIndex: 0, cue: { tStartMs: 0, dDurationMs: 2000, text: noisyText } },
      {
        cueIndex: 1,
        cue: { tStartMs: 2000, dDurationMs: 2000, text: noisyText },
      },
    ];
    const built = buildSubtitleBatchRequest({
      entries: rawEntries,
      fromLang: 'en',
      toLang: 'zh-CN',
    });
    expect(built.request.items.map((i) => i.text)).toEqual([
      'So do you remember the first time you',
      'So do you remember the first time you',
    ]);

    // P1-1 CPU budget: planning a 2400-cue (2-hour) YouTube track takes < 2ms!
    const largeTrack: SubtitleCue[] = Array.from({ length: 2400 }, (_, i) => ({
      tStartMs: i * 3_000,
      dDurationMs: 2_500,
      text: `Lecture sentence number ${i} discussing std::vector<int> and distributed systems.`,
      ...(i < 1200 ? { trans: `第 ${i} 句中文字幕译文` } : {}),
    }));
    // Warm up JIT once
    planSubtitleBatches({
      cues: largeTrack,
      currentTimeMs: 3_600_000,
      preTranslate: true,
      limits: { maxBatchCount: 17, maxCharsPerBatch: 4096 },
    });
    const t0 = performance.now();
    const planned = planSubtitleBatches({
      cues: largeTrack,
      currentTimeMs: 3_600_000,
      preTranslate: true,
      limits: { maxBatchCount: 17, maxCharsPerBatch: 4096 },
    });
    const elapsedMs = performance.now() - t0;
    expect(planned.immediateBatches.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(2);
  });

  it('gates pump() on setDispatchGate(false) without aborting already-in-flight batches, and appends HLS cues mid-flight without cancellation', async () => {
    const dispatchedRequests: TranslateBatchRequest[] = [];
    const signals: AbortSignal[] = [];
    const resolvers: Array<() => void> = [];

    const scheduler = new SubtitleBatchScheduler({
      maxImmediateConcurrency: 1,
      translateBatch: (req, signal) => {
        dispatchedRequests.push(req);
        signals.push(signal);
        return new Promise<TranslateBatchResponse>((resolve) => {
          resolvers.push(() => {
            resolve({
              ok: true,
              requestId: req.requestId,
              providerId: 'mock',
              model: 'mock',
              items: req.items.map((it) => ({
                id: it.id,
                trans: `译:${it.text}`,
              })),
              diagnostic: {} as never,
            });
          });
        });
      },
    });

    scheduler.configure({
      fromLang: 'en',
      toLang: 'zh-CN',
      preTranslate: false,
      immediateLookaheadMs: 20_000,
      refillTriggerMs: 8_000,
      maxBatchCount: 2,
      maxCharsPerBatch: 4096,
    });

    // 1. Gate closed -> loadCues, updatePlayhead, configure, appendCues all dispatch 0
    scheduler.setDispatchGate(false);
    scheduler.loadCues(
      'x-vid-1',
      [
        { tStartMs: 0, dDurationMs: 2000, text: 'Chunk 1 cue A' },
        { tStartMs: 2000, dDurationMs: 2000, text: 'Chunk 1 cue B' },
      ],
      0,
    );
    scheduler.updatePlayhead(500);
    scheduler.configure({ videoTitle: 'Updated title' });
    scheduler.appendCues([
      { tStartMs: 4000, dDurationMs: 2000, text: 'Chunk 2 cue C' },
    ]);
    expect(dispatchedRequests).toHaveLength(0);

    // 2. Reopen gate -> dispatches Batch #1 (cues 0 & 1 due to maxBatchCount=2)
    scheduler.setDispatchGate(true);
    expect(dispatchedRequests).toHaveLength(1);
    expect(dispatchedRequests[0].items.map((i) => i.text)).toEqual([
      'Chunk 1 cue A',
      'Chunk 1 cue B',
    ]);

    // 3. While Batch #1 is in-flight, append HLS Chunk #3 -> does NOT cancel Batch #1!
    scheduler.appendCues([
      { tStartMs: 6000, dDurationMs: 2000, text: 'Chunk 3 cue D' },
    ]);
    expect(signals[0].aborted).toBe(false);

    // 4. Close gate (user pauses) BEFORE Batch #1 resolves -> Batch #1 still settles & applies, and 0 new batches fire!
    scheduler.setDispatchGate(false);
    expect(signals[0].aborted).toBe(false);

    resolvers.shift()!();
    await new Promise((r) => setTimeout(r, 0));

    expect(scheduler.getCues().map((c) => c.trans)).toEqual([
      '译:Chunk 1 cue A',
      '译:Chunk 1 cue B',
      undefined,
      undefined,
    ]);
    expect(dispatchedRequests).toHaveLength(1);

    // 5. Reopen gate -> Batch #2 (cues 2 & 3) dispatches immediately and resolves onto indices 2 & 3
    scheduler.setDispatchGate(true);
    expect(dispatchedRequests).toHaveLength(2);
    expect(dispatchedRequests[1].items.map((i) => i.text)).toEqual([
      'Chunk 2 cue C',
      'Chunk 3 cue D',
    ]);
    resolvers.shift()!();
    await scheduler.waitForIdle();

    expect(scheduler.getCues().map((c) => c.trans)).toEqual([
      '译:Chunk 1 cue A',
      '译:Chunk 1 cue B',
      '译:Chunk 2 cue C',
      '译:Chunk 3 cue D',
    ]);
  });

  it('respects immediateLookaheadMs=20s + refillTriggerMs=8s without 1-cue trickle, and keeps default YouTube plans identical to v2.3.6', () => {
    const cues: SubtitleCue[] = [
      { tStartMs: 0, dDurationMs: 2000, text: 'c0', trans: '已译0' },
      { tStartMs: 12_000, dDurationMs: 2000, text: 'c12' },
      { tStartMs: 18_000, dDurationMs: 2000, text: 'c18' },
      { tStartMs: 30_000, dDurationMs: 2000, text: 'c30' },
      { tStartMs: 50_000, dDurationMs: 2000, text: 'c50' },
    ];

    // At t=2s on HTML5 (20s window, 8s trigger): c12 is at +10s (> +8s trigger) -> immediateBatches empty!
    const html5HoldPlan = planSubtitleBatches({
      cues,
      currentTimeMs: 2_000,
      preTranslate: false,
      limits: { maxBatchCount: 17, maxCharsPerBatch: 4096 },
      immediateLookaheadMs: 20_000,
      refillTriggerMs: 8_000,
    });
    expect(html5HoldPlan.immediateBatches).toEqual([]);
    expect(html5HoldPlan.lookaheadBatches).toEqual([]);

    // At t=4s on HTML5: c12 is now at +8s (<= +8s trigger!) -> batches BOTH c12 and c18 in [2s, 24s], excluding c30!
    const html5RefillPlan = planSubtitleBatches({
      cues,
      currentTimeMs: 4_000,
      preTranslate: false,
      limits: { maxBatchCount: 17, maxCharsPerBatch: 4096 },
      immediateLookaheadMs: 20_000,
      refillTriggerMs: 8_000,
    });
    expect(
      html5RefillPlan.immediateBatches[0]?.map((e) => e.cue.text),
    ).toEqual(['c12', 'c18']);

    // Default YouTube plan (35s immediate + preTranslate: true): immediate has c12, c18, c30; lookahead has c50
    const ytPlan = planSubtitleBatches({
      cues,
      currentTimeMs: 2_000,
      preTranslate: true,
      limits: { maxBatchCount: 17, maxCharsPerBatch: 4096 },
    });
    expect(ytPlan.immediateBatches[0]?.map((e) => e.cue.text)).toEqual([
      'c12',
      'c18',
      'c30',
    ]);
    expect(ytPlan.lookaheadBatches[0]?.map((e) => e.cue.text)).toEqual(['c50']);
  });
});

describe('v2.3.7 Suite 4: html5-video Pure Helpers (Merge, Arbitration, Style 1 Typography & Control-Bar Clearance)', () => {
  it('merges HLS cues across append, ±50ms jitter dedupe, <=120ms boundary split coalesce, out-of-order rebuild carrying trans, and empty noop', () => {
    const existing: SubtitleCue[] = [
      { tStartMs: 0, dDurationMs: 2000, text: 'First sentence', trans: '第一句' },
      { tStartMs: 2000, dDurationMs: 2000, text: 'Boundary split', trans: '跨分片句' },
    ];

    // 1. Empty transient next -> noop
    const emptyRes = mergeHtml5Cues(existing, []);
    expect(emptyRes.kind).toBe('noop');
    expect(emptyRes.cues).toEqual(existing);

    // 2. Append with +25ms PTS jitter duplicate + 4000..5600ms segment-boundary split + new cue at 6000ms
    const appendRes = mergeHtml5Cues(existing, [
      { tStartMs: 0, dDurationMs: 2000, text: 'First sentence' },
      { tStartMs: 20, dDurationMs: 2010, text: 'First sentence' }, // ±50ms duplicate
      { tStartMs: 2020, dDurationMs: 1980, text: 'Boundary split' }, // ends at 4000
      { tStartMs: 4050, dDurationMs: 1550, text: 'Boundary split' }, // gap 50ms <= 120ms -> coalesces to 2020..5600!
      { tStartMs: 6000, dDurationMs: 2000, text: 'Third sentence' },
    ]);
    expect(appendRes.kind).toBe('append');
    expect(appendRes.appended).toEqual([
      { tStartMs: 6000, dDurationMs: 2000, text: 'Third sentence' },
    ]);
    expect(appendRes.durationUpdates).toEqual([
      { index: 1, dDurationMs: 3580 },
    ]);
    expect(appendRes.cues[0]?.trans).toBe('第一句');
    expect(appendRes.cues[1]?.trans).toBe('跨分片句');
    expect(appendRes.cues[1]?.dDurationMs).toBe(3580);

    // 3. Out-of-order seek insert before existing cues -> rebuild carrying `trans`!
    const rebuildRes = mergeHtml5Cues(
      [
        { tStartMs: 10_000, dDurationMs: 2000, text: 'Later cue', trans: '后段字幕' },
      ],
      [
        { tStartMs: 1_000, dDurationMs: 2000, text: 'Earlier seek cue' },
        { tStartMs: 10_030, dDurationMs: 2000, text: 'Later cue' },
      ],
    );
    expect(rebuildRes.kind).toBe('rebuild');
    expect(rebuildRes.cues).toEqual([
      { tStartMs: 1_000, dDurationMs: 2000, text: 'Earlier seek cue' },
      { tStartMs: 10_030, dDurationMs: 2000, text: 'Later cue', trans: '后段字幕' },
    ]);
  });

  it('arbitrates active video across timeline scroll with 25%–50% hysteresis and playing-timestamp tie-break', () => {
    const vp = { width: 1024, height: 700 };
    const lastPlaying = new WeakMap<HTMLVideoElement, number>();

    const card1 = createXVideoElement({
      paused: true,
      rect: { top: -400, left: 238, width: 502, height: 283 }, // off-screen
    });
    const card2 = createXVideoElement({
      paused: false,
      rect: { top: 180, left: 238, width: 502, height: 283 }, // 100% visible
    });
    document.body.append(card1, card2);

    // Card #1 paused off-screen + Card #2 playing visible -> switches to Card #2
    expect(
      selectActiveHtml5Video([card1, card2], card1, vp, lastPlaying),
    ).toBe(card2);

    // Hysteresis: Card #2 is bound & playing, scrolled to 35% visible (between 0.25 and 0.5) while Card #3 is 100% visible
    mockElementRect(card2, {
      top: 700 - Math.round(283 * 0.35),
      left: 238,
      width: 502,
      height: 283,
    });
    const card3 = createXVideoElement({
      paused: false,
      rect: { top: 150, left: 238, width: 502, height: 283 },
    });
    document.body.appendChild(card3);
    expect(computeVisibleRatio(card2, vp)).toBeGreaterThanOrEqual(0.25);
    expect(computeVisibleRatio(card2, vp)).toBeLessThan(0.5);
    expect(
      selectActiveHtml5Video([card2, card3], card2, vp, lastPlaying),
    ).toBe(card2);

    // Once Card #2 drops below 25% visible (e.g. 15%), switches cleanly to Card #3
    mockElementRect(card2, {
      top: 700 - Math.round(283 * 0.15),
      left: 238,
      width: 502,
      height: 283,
    });
    expect(
      selectActiveHtml5Video([card2, card3], card2, vp, lastPlaying),
    ).toBe(card3);
  });

  it('computes Style 1 typography (283px -> 14/12.5, 1080p fs -> 28/24.5, CJK 14px floor) and X [role="slider"] clearance (55px vs 14px)', () => {
    const compact = computeHtml5CaptionTypography({
      heightPx: 283,
      fullscreen: false,
      origPct: 100,
      transPct: 70,
      targetLang: 'zh-CN',
      scaleMult: 1,
    });
    expect(compact.transPx).toBe(14);
    expect(compact.origPx).toBe(12.5);
    expect(compact.capBg).toBe('rgba(17, 17, 20, 0.66)');

    const fs1080 = computeHtml5CaptionTypography({
      heightPx: 1080,
      fullscreen: true,
      origPct: 100,
      transPct: 70,
      targetLang: 'zh-CN',
      scaleMult: 1,
    });
    expect(fs1080.transPx).toBe(28);
    expect(fs1080.origPx).toBe(24.5);

    // CJK floor at transPct=50 -> 14px for zh-CN, 13px for fr
    expect(
      computeHtml5CaptionTypography({
        heightPx: 283,
        transPct: 50,
        targetLang: 'zh-CN',
      }).transPx,
    ).toBe(14);
    expect(
      computeHtml5CaptionTypography({
        heightPx: 283,
        transPct: 50,
        targetLang: 'fr',
      }).transPx,
    ).toBe(13);

    // Bottom offset: visible 47px scrubber on 502x283 X player -> 55px; faded out -> 14px; fullscreen hidden -> 38px
    const playerRoot = document.createElement('div');
    playerRoot.setAttribute('data-testid', 'videoPlayer');
    mockElementRect(playerRoot, { top: 143, left: 238, width: 502, height: 283 });
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    // Scrubber 47px from bottom: top = 143 + 283 - 47 = 379
    mockElementRect(slider, { top: 379, left: 250, width: 478, height: 12 });
    playerRoot.appendChild(slider);
    document.body.appendChild(playerRoot);

    expect(
      computeHtml5BottomOffset({
        container: playerRoot,
        playerRoot,
        heightPx: 283,
        fullscreen: false,
      }),
    ).toBe(55);

    slider.style.opacity = '0';
    expect(
      computeHtml5BottomOffset({
        container: playerRoot,
        playerRoot,
        heightPx: 283,
        fullscreen: false,
      }),
    ).toBe(14);

    expect(
      computeHtml5BottomOffset({
        container: playerRoot,
        playerRoot,
        heightPx: 1080,
        fullscreen: true,
      }),
    ).toBe(38);
  });

  it('validates isHostCaptionsOn, pickCaptionTrack, normalizeForCaptionMatch, and static import purity of html5-video.ts', () => {
    const disabledCtrl = createSpiedTextTrack({ initialMode: 'disabled' });
    const hiddenCtrl = createSpiedTextTrack({ initialMode: 'hidden', id: 'hid' });
    const showingCtrl = createSpiedTextTrack({ initialMode: 'showing', id: 'sho' });

    const vOff = createXVideoElement({
      textTracks: createFakeTrackList([disabledCtrl.track]).list,
    });
    expect(isHostCaptionsOn(vOff)).toBe(false);
    expect(pickCaptionTrack(vOff)).toBeNull();

    const vBoth = createXVideoElement({
      textTracks: createFakeTrackList([disabledCtrl.track, hiddenCtrl.track, showingCtrl.track]).list,
    });
    expect(isHostCaptionsOn(vBoth)).toBe(true);
    expect(pickCaptionTrack(vBoth)).toBe(showingCtrl.track);
    expect(disabledCtrl.modeSetSpy).not.toHaveBeenCalled();
    expect(hiddenCtrl.modeSetSpy).not.toHaveBeenCalled();
    expect(showingCtrl.modeSetSpy).not.toHaveBeenCalled();

    expect(
      normalizeForCaptionMatch(
        '<X-word-ms ms=80,79 index=1>So, do you remember?!</X-word-ms>',
      ),
    ).toBe('sodoyouremember');

    // Static import purity check for html5-video.ts too
    const here = path.dirname(fileURLToPath(import.meta.url));
    const html5VideoSrc = fs.readFileSync(
      path.resolve(here, '../../src/youtube/html5-video.ts'),
      'utf8',
    );
    expect(html5VideoSrc).not.toMatch(/from\s+['"]\.\/main-entry['"]/);
    expect(html5VideoSrc).not.toMatch(/from\s+['"]\.\/pip-player['"]/);
  });
});

describe('v2.3.7 Suite 5: X / HTML5 SubtitleIsolatedController Lifecycle, Zero mode Writes & Native Suppression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>)[ISOLATED_CONTROLLER_KEY];
    mockElementRect(document.documentElement, {
      top: 0,
      left: 0,
      width: 1280,
      height: 800,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>)[ISOLATED_CONTROLLER_KEY];
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('(a, b, f) dwells on muted X card -> renders clean Style 1 capsule, suppresses X React caption layer, NEVER writes TextTrack.mode, and resumes in 0ms on CC OFF -> ON', async () => {
    setTestUrl('https://x.com/home');

    const rawXText =
      '<X-word-ms ms=80,79,59,280,80,219,240,139 index=1 character_ranges=0-1,2-4,5-8,9-17,18-21,22-27,28-32,33-36>So do you remember the first time you</X-word-ms>';
    const trackCtrl = createSpiedTextTrack({
      initialMode: 'hidden',
      cues: [{ startTime: 0, endTime: 5, text: rawXText }],
    });
    const trackListCtrl = createFakeTrackList([trackCtrl.track]);

    // Build authentic X tweet + `[data-testid="videoPlayer"]` DOM
    const article = document.createElement('article');
    const tweetText = document.createElement('div');
    tweetText.setAttribute('data-testid', 'tweetText');
    tweetText.textContent = 'So do you remember the first time you'; // identical quote outside player — must NEVER be marked!

    const playerRoot = document.createElement('div');
    playerRoot.setAttribute('data-testid', 'videoPlayer');
    mockElementRect(playerRoot, { top: 143, left: 238, width: 502, height: 283 });

    const videoComp = document.createElement('div');
    videoComp.setAttribute('data-testid', 'videoComponent');
    videoComp.style.position = 'relative';
    mockElementRect(videoComp, { top: 143, left: 238, width: 502, height: 283 });

    const video = createXVideoElement({
      muted: true,
      paused: false,
      currentTime: 1.0,
      textTracks: trackListCtrl.list,
    });
    videoComp.appendChild(video);

    const xCaptionWrapper = document.createElement('div');
    xCaptionWrapper.className = 'css-175oi2r x-caption-layer';
    const xCaptionSpan = document.createElement('span');
    xCaptionSpan.setAttribute('dir', 'auto');
    xCaptionSpan.textContent = 'So do you remember the first time you';
    xCaptionWrapper.appendChild(xCaptionSpan);

    const controlsBar = document.createElement('div');
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    mockElementRect(slider, { top: 379, left: 250, width: 478, height: 12 });
    const ccBtn = document.createElement('button');
    ccBtn.type = 'button';
    ccBtn.textContent = 'CC';
    const playBtn = document.createElement('div');
    playBtn.setAttribute('data-testid', 'playButton');
    playBtn.textContent = 'Play';
    controlsBar.append(slider, ccBtn, playBtn);

    playerRoot.append(videoComp, xCaptionWrapper, controlsBar);
    article.append(tweetText, playerRoot);
    document.body.appendChild(article);

    const translateSpy = vi.fn(async (req: TranslateBatchRequest) => ({
      ok: true,
      requestId: req.requestId,
      providerId: 'mock',
      model: 'mock',
      items: req.items.map((it) => ({
        id: it.id,
        trans: '那你还记得第一次……',
      })),
      diagnostic: {} as never,
    }));

    const controller = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: translateSpy,
    });
    await controller.start();

    // Before 2500ms timeline dwell: 0 translate calls, X's own caption stays visible!
    await vi.advanceTimersByTimeAsync(2_000);
    expect(translateSpy).toHaveBeenCalledTimes(0);
    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).toBeNull();
    expect(video.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)).toBe(false);
    expect(xCaptionWrapper.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR)).toBe(false);

    // Cross 2500ms dwell -> engages, translates clean source text, renders Style 1 capsule & suppresses native!
    await vi.advanceTimersByTimeAsync(600);

    expect(translateSpy).toHaveBeenCalledTimes(1);
    expect(translateSpy.mock.calls[0][0].items[0].text).toBe(
      'So do you remember the first time you',
    );

    const host = document.getElementById(SUBTITLE_OVERLAY_HOST_ID);
    expect(host).not.toBeNull();
    const wrap = host!.shadowRoot!.getElementById('margin-sub-wrap')!;
    expect(wrap.dataset.surface).toBe('html5');
    expect(wrap.style.getPropertyValue('--margin-sub-trans-px')).toBe('14px');
    expect(wrap.style.getPropertyValue('--margin-sub-orig-px')).toBe('12.5px');
    expect(wrap.style.getPropertyValue('--margin-sub-bottom-px')).toBe('55px');
    expect(
      host!.shadowRoot!.getElementById('margin-sub-original')!.textContent,
    ).toBe('So do you remember the first time you');
    expect(
      host!.shadowRoot!.getElementById('margin-sub-translated')!.textContent,
    ).toBe('那你还记得第一次……');

    // Native suppression applied strictly to `<video>` and `xCaptionWrapper`, NEVER controls/buttons/tweetText!
    expect(video.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)).toBe(true);
    expect(xCaptionWrapper.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR)).toBe(true);
    expect(ccBtn.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR)).toBe(false);
    expect(slider.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR)).toBe(false);
    expect(playBtn.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR)).toBe(false);
    expect(tweetText.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR)).toBe(false);
    expect(document.getElementById(NATIVE_HTML5_HIDE_STYLE_ID)).not.toBeNull();

    // User clicks CC OFF in X -> hls.js flips `mode = 'disabled'` and fires `change`
    trackCtrl.setHostMode('disabled');
    trackListCtrl.fire('change');
    await vi.advanceTimersByTimeAsync(50);

    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).toBeNull();
    expect(video.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)).toBe(false);
    expect(xCaptionWrapper.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR)).toBe(false);

    // User clicks CC back ON (`mode = 'hidden'`) -> resumes immediately from memory with ZERO new translateBatch calls!
    trackCtrl.setHostMode('hidden');
    trackListCtrl.fire('change');
    await vi.advanceTimersByTimeAsync(50);

    expect(translateSpy).toHaveBeenCalledTimes(1);
    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).not.toBeNull();
    expect(video.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)).toBe(true);
    expect(xCaptionWrapper.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR)).toBe(true);

    // Secondary CC-OFF signal: X build keeps `mode = 'hidden'` on CC click but unmounts its caption DOM across 2 cuechanges (+250ms confirm each)
    ccBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    xCaptionWrapper.remove();
    trackCtrl.fireCueChange();
    await vi.advanceTimersByTimeAsync(320);
    trackCtrl.fireCueChange();
    await vi.advanceTimersByTimeAsync(320);

    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).toBeNull();
    expect(video.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)).toBe(false);

    // Clicking CC ON during an inter-cue gap (`activeCues = []`), then next cue arrives -> Margin recovers automatically! (P2-5)
    trackCtrl.activeCues.length = 0;
    ccBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(350);
    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).toBeNull();

    // Next cue arrives and X mounts its caption layer back -> cuechange listener stayed attached and restores Margin!
    trackCtrl.activeCues.push({ startTime: 0, endTime: 5, text: rawXText });
    playerRoot.insertBefore(xCaptionWrapper, controlsBar);
    trackCtrl.fireCueChange();
    await vi.advanceTimersByTimeAsync(50);
    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).not.toBeNull();

    // HARD INVARIANT: Margin wrote `TextTrack.mode` ZERO times across the entire lifecycle!
    expect(trackCtrl.modeSetSpy).toHaveBeenCalledTimes(0);

    controller.destroy();
    expect(video.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)).toBe(false);
    expect(xCaptionWrapper.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR)).toBe(false);
    expect(document.getElementById(NATIVE_HTML5_HIDE_STYLE_ID)).toBeNull();
  });

  it('(c) makes strictly 0 translateBatch calls on fast-scrolled muted autoplay timeline cards', async () => {
    setTestUrl('https://x.com/home');

    const cards = Array.from({ length: 5 }, (_, i) => {
      const tCtrl = createSpiedTextTrack({
        id: `t-${i}`,
        initialMode: 'hidden',
        cues: [{ startTime: 0, endTime: 5, text: `Autoplay card ${i}` }],
      });
      const v = createXVideoElement({
        muted: true,
        paused: false,
        currentTime: 0.5,
        currentSrc: `blob:https://x.com/feed-${i}`,
        // Partially off-screen (< 50% visible) initially
        rect: { top: 700, left: 238, width: 502, height: 283 },
        textTracks: createFakeTrackList([tCtrl.track]).list,
      });
      document.body.appendChild(v);
      return { v, tCtrl };
    });

    const translateSpy = vi.fn(async (req: TranslateBatchRequest) => ({
      ok: true,
      requestId: req.requestId,
      providerId: 'mock',
      model: 'mock',
      items: req.items.map((it) => ({ id: it.id, trans: `译:${it.text}` })),
      diagnostic: {} as never,
    }));

    const controller = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: translateSpy,
    });
    await controller.start();

    // Scroll through each card for 1.2s (< 2.5s dwell), then scroll it away
    for (let i = 0; i < cards.length; i += 1) {
      mockElementRect(cards[i].v, {
        top: 180,
        left: 238,
        width: 502,
        height: 283,
      });
      document.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(1_200);
      mockElementRect(cards[i].v, {
        top: -400,
        left: 238,
        width: 502,
        height: 283,
      });
      setVideoPaused(cards[i].v, true);
      document.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(250);
    }

    expect(translateSpy).toHaveBeenCalledTimes(0);
    for (const c of cards) {
      expect(c.tCtrl.modeSetSpy).toHaveBeenCalledTimes(0);
      expect(c.v.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)).toBe(false);
    }

    controller.destroy();
  });

  it('(d, e) appends 4s HLS chunks via 500ms poll without aborting in-flight LLM batches, and switches cleanly between two timeline videos', async () => {
    setTestUrl('https://x.com/DariaIv27369195/status/19920001');

    const track1 = createSpiedTextTrack({
      id: 'hls-1',
      initialMode: 'hidden',
      cues: [{ startTime: 0, endTime: 4, text: 'HLS segment 1' }],
    });
    const video1 = createXVideoElement({
      muted: false, // unmuted -> immediately engaged!
      paused: false,
      currentTime: 0.5,
      currentSrc: 'blob:https://x.com/vid-1',
      rect: { top: 143, left: 238, width: 502, height: 283 },
      textTracks: createFakeTrackList([track1.track]).list,
    });

    const track2 = createSpiedTextTrack({
      id: 'hls-2',
      initialMode: 'hidden',
      cues: [{ startTime: 0, endTime: 4, text: 'Second card cue' }],
    });
    const video2 = createXVideoElement({
      muted: false,
      paused: true,
      currentTime: 0.5,
      currentSrc: 'blob:https://x.com/vid-2',
      rect: { top: 900, left: 238, width: 502, height: 283 },
      textTracks: createFakeTrackList([track2.track]).list,
    });

    const wrap1 = document.createElement('div');
    mockElementRect(wrap1, { top: 143, left: 238, width: 502, height: 283 });
    wrap1.appendChild(video1);

    const wrap2 = document.createElement('div');
    mockElementRect(wrap2, { top: 900, left: 238, width: 502, height: 283 });
    wrap2.appendChild(video2);

    document.body.append(wrap1, wrap2);

    const pendingBatchResolvers: Array<() => void> = [];
    const batchSignals: AbortSignal[] = [];

    const translateSpy = vi.fn(
      (req: TranslateBatchRequest, signal: AbortSignal) => {
        batchSignals.push(signal);
        return new Promise<TranslateBatchResponse>((resolve) => {
          pendingBatchResolvers.push(() => {
            resolve({
              ok: true,
              requestId: req.requestId,
              providerId: 'mock',
              model: 'mock',
              items: req.items.map((it) => ({
                id: it.id,
                trans: `译:${it.text}`,
              })),
              diagnostic: {} as never,
            });
          });
        });
      },
    );

    const controller = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: translateSpy,
    });
    await controller.start();

    expect(translateSpy).toHaveBeenCalledTimes(1);
    expect(batchSignals[0].aborted).toBe(false);

    // Simulate hls.js `track.addCue(...)` (silent push without firing `change` or `cuechange`) while Batch #1 is still in-flight!
    track1.cues.push({ startTime: 4, endTime: 8, text: 'HLS segment 2' });
    await vi.advanceTimersByTimeAsync(550);

    // Batch #1 MUST NOT have been aborted by the 4s HLS segment append!
    expect(batchSignals[0].aborted).toBe(false);
    expect(controller.getCues().map((c) => c.text)).toEqual([
      'HLS segment 1',
      'HLS segment 2',
    ]);

    // Resolve Batch #1 and Batch #2 -> both translations land intact
    while (pendingBatchResolvers.length > 0) {
      pendingBatchResolvers.shift()!();
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(50);
    expect(controller.getCues().map((c) => c.trans)).toEqual([
      '译:HLS segment 1',
      '译:HLS segment 2',
    ]);
    expect(video1.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)).toBe(true);

    // Scroll to Video #2: Video #1 pauses & scrolls off-screen, Video #2 enters viewport and plays
    setVideoPaused(video1, true);
    mockElementRect(video1, { top: -400, left: 238, width: 502, height: 283 });
    mockElementRect(wrap1, { top: -400, left: 238, width: 502, height: 283 });

    setVideoPaused(video2, false);
    mockElementRect(video2, { top: 160, left: 238, width: 502, height: 283 });
    mockElementRect(wrap2, { top: 160, left: 238, width: 502, height: 283 });
    video2.dispatchEvent(new Event('playing'));
    await vi.advanceTimersByTimeAsync(250);

    while (pendingBatchResolvers.length > 0) {
      pendingBatchResolvers.shift()!();
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(50);

    // Video #1's suppression attribute and mutated inline position are cleanly restored; Video #2 is now active!
    expect(video1.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)).toBe(false);
    expect(wrap1.style.position).toBe('');
    expect(video2.hasAttribute(NATIVE_CUE_SUPPRESSED_ATTR)).toBe(true);
    expect(controller.getActiveCue().translated).toBe('译:Second card cue');

    controller.destroy();
  });

  it('Round-2 (P2-1..P2-5 & P3-a/b): zero per-tick TreeWalker/querySelectorAll scans, zero 2Hz retry storm on 429, zero forced layout on composer keydown, lag-tolerant secondary CC check, GIF badge safety & HLS eviction memo', async () => {
    setTestUrl('https://x.com/home');

    // 1. P3-a & P3-b pure checks: "GIF" badge (3 chars) never widens LCA on "A gift for you", and memo survives HLS eviction
    const playerDiv = document.createElement('div');
    playerDiv.setAttribute('data-testid', 'videoPlayer');
    const gifBadge = document.createElement('div');
    gifBadge.textContent = 'GIF';
    const realCap = document.createElement('div');
    const realSpan = document.createElement('span');
    realSpan.textContent = 'A gift for you';
    realCap.appendChild(realSpan);
    playerDiv.append(gifBadge, realCap);
    expect(findNativeCaptionLayer(playerDiv, ['A gift for you'])).toBe(realCap);

    const memo = new Map<string, string>();
    recordCueTranslationsInMemo(memo, [
      { tStartMs: 1_000, dDurationMs: 2_000, text: 'Evicted early cue', trans: '早期已译字幕' },
    ]);
    // Simulate HLS buffer shrink leaving only cue at 20s in `existing`, followed by rewind re-inserting cue at 1.02s
    const rebuiltFromMemo = mergeHtml5Cues(
      [{ tStartMs: 20_000, dDurationMs: 2_000, text: 'Late cue', trans: '后段字幕' }],
      [
        { tStartMs: 1_020, dDurationMs: 2_000, text: 'Evicted early cue' },
        { tStartMs: 20_000, dDurationMs: 2_000, text: 'Late cue' },
      ],
      memo,
    );
    expect(rebuiltFromMemo.kind).toBe('rebuild');
    expect(rebuiltFromMemo.cues[0]?.trans).toBe('早期已译字幕');

    // 2. Mount X card + outside tweet composer `<textarea>`
    const composer = document.createElement('textarea');
    composer.setAttribute('data-testid', 'tweetTextarea_0');
    document.body.appendChild(composer);

    const trackCtrl = createSpiedTextTrack({
      initialMode: 'hidden',
      cues: [{ startTime: 0, endTime: 10, text: 'Steady playback caption' }],
    });
    const playerRoot = document.createElement('div');
    playerRoot.setAttribute('data-testid', 'videoPlayer');
    mockElementRect(playerRoot, { top: 143, left: 238, width: 502, height: 283 });
    const videoComp = document.createElement('div');
    videoComp.style.position = 'relative';
    mockElementRect(videoComp, { top: 143, left: 238, width: 502, height: 283 });
    const video = createXVideoElement({
      muted: true,
      paused: false,
      currentTime: 0.5,
      textTracks: createFakeTrackList([trackCtrl.track]).list,
    });
    videoComp.appendChild(video);
    const xCap = document.createElement('div');
    xCap.innerHTML = '<span dir="auto">Steady playback caption</span>';
    const playToggle = document.createElement('button');
    playToggle.type = 'button';
    playToggle.textContent = 'Play';
    playerRoot.append(videoComp, xCap, playToggle);
    document.body.appendChild(playerRoot);

    let shouldFail429 = false;
    const translateSpy = vi.fn(async (req: TranslateBatchRequest) => {
      if (shouldFail429) {
        throw new Error('HTTP 429 rate limited');
      }
      return {
        ok: true,
        requestId: req.requestId,
        providerId: 'mock',
        model: 'mock',
        items: req.items.map((it) => ({ id: it.id, trans: `译:${it.text}` })),
        diagnostic: {} as never,
      };
    });

    const controller = createSubtitleIsolatedController({
      loadConfig: async () => createDefaultMarginConfig(),
      subscribeConfig: () => () => {},
      translateBatch: translateSpy,
    });
    await controller.start();

    // P2-2: While in ON_IDLE (muted before 2.5s dwell), 1.5s of 10Hz ticks + timeupdates must make 0 document attribute scans!
    const docQsaSpy = vi.spyOn(document, 'querySelectorAll');
    const treeWalkerSpy = vi.spyOn(document, 'createTreeWalker');
    docQsaSpy.mockClear();
    treeWalkerSpy.mockClear();

    for (let step = 1; step <= 10; step += 1) {
      video.currentTime = 0.5 + step * 0.1;
      video.dispatchEvent(new Event('timeupdate'));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(treeWalkerSpy).toHaveBeenCalledTimes(0);
    const idleSuppressQueries = docQsaSpy.mock.calls.filter(([sel]) =>
      String(sel).includes('data-margin-native'),
    );
    expect(idleSuppressQueries).toHaveLength(0);

    // P2-4: Typing 15 keystrokes in X's composer makes ZERO video getBoundingClientRect or querySelectorAll('video') calls!
    const videoRectSpy = vi.fn(() => ({
      top: 143,
      left: 238,
      width: 502,
      height: 283,
      right: 740,
      bottom: 426,
      x: 238,
      y: 143,
      toJSON: () => ({}),
    }));
    Object.defineProperty(video, 'getBoundingClientRect', {
      value: videoRectSpy,
      configurable: true,
    });
    docQsaSpy.mockClear();
    videoRectSpy.mockClear();
    for (let k = 0; k < 15; k += 1) {
      composer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
      );
    }
    expect(videoRectSpy).toHaveBeenCalledTimes(0);
    expect(
      docQsaSpy.mock.calls.filter(([sel]) => sel === 'video'),
    ).toHaveLength(0);

    // Cross remaining dwell to enter ON_ACTIVE -> translates & suppresses X caption
    await vi.advanceTimersByTimeAsync(1_600);
    expect(translateSpy).toHaveBeenCalledTimes(1);
    expect(xCap.hasAttribute(NATIVE_CAPTION_HIDDEN_ATTR)).toBe(true);

    // P2-1: During steady-state ON_ACTIVE playback ticks (1.5s, 15 ticks + timeupdates), TreeWalker runs ZERO times!
    treeWalkerSpy.mockClear();
    for (let step = 1; step <= 15; step += 1) {
      video.currentTime = 2.0 + step * 0.1;
      video.dispatchEvent(new Event('timeupdate'));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(treeWalkerSpy).toHaveBeenCalledTimes(0);

    // P2-5: Non-CC click (Play/Pause) followed by a slow React commit (100ms > 2 frames, < 250ms) across 2 cuechanges must NOT false-trigger OFF!
    playToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let c = 0; c < 2; c += 1) {
      xCap.remove();
      trackCtrl.fireCueChange();
      await vi.advanceTimersByTimeAsync(80); // > 2 frames (32ms), so 2xrAF saw nothing...
      playerRoot.insertBefore(xCap, playToggle); // ...React commits at 80ms (< 250ms confirm)!
      await vi.advanceTimersByTimeAsync(220);
    }
    expect(document.getElementById(SUBTITLE_OVERLAY_HOST_ID)).not.toBeNull();

    // P2-3: Append a new cue while provider returns 429 -> attempted ONCE, zero 2Hz retry storm across 3,000ms of 500ms polls!
    shouldFail429 = true;
    translateSpy.mockClear();
    trackCtrl.cues.push({ startTime: 4, endTime: 9, text: 'Rate limited cue' });
    await vi.advanceTimersByTimeAsync(600);
    expect(translateSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(translateSpy).toHaveBeenCalledTimes(1);

    docQsaSpy.mockRestore();
    treeWalkerSpy.mockRestore();
    controller.destroy();
  });
});
