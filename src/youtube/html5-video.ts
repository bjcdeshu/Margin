import { BRAND } from '@shared/brand';
import type { SubtitleCue } from '@shared/types';
import { sanitizeSubtitleMarkup } from './shared';
import {
  FALLBACK_CUE_DURATION_MS,
  MAX_CUE_DURATION_MS,
  MIN_CUE_DURATION_MS,
} from './timeline';

export const HTML5_IMMEDIATE_LOOKAHEAD_MS = 20_000;
export const HTML5_REFILL_TRIGGER_MS = 8_000;
export const HTML5_ENGAGE_DWELL_MS = 2_500;
export const HTML5_STATUS_DWELL_MS = 800;
export const HTML5_ARBITRATION_THROTTLE_MS = 200;
export const HTML5_TRACK_POLL_MS = 500;
export const HTML5_CONTROLS_AUTOHIDE_IDLE_MS = 2_500;
export const SMPTE_BROADCAST_OFFSET_MS = 3_600_000;

export const NATIVE_HTML5_HIDE_STYLE_ID = `${BRAND.cssPrefix}-html5-native-caption-suppress`;
export const NATIVE_CUE_SUPPRESSED_ATTR = `${BRAND.domAttrPrefix}-native-cue-suppressed`;
export const NATIVE_CAPTION_HIDDEN_ATTR = `${BRAND.domAttrPrefix}-native-caption-hidden`;

export interface RectLike {
  top: number;
  left: number;
  right?: number;
  bottom?: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface PlayingTimestampLookup {
  get(video: HTMLVideoElement): number | undefined;
}

export interface SelectActiveHtml5VideoParams {
  candidates: readonly HTMLVideoElement[];
  current: HTMLVideoElement | null;
  viewport?: ViewportSize;
  lastPlayingAt?: PlayingTimestampLookup;
}

export interface MergeHtml5CuesResult {
  kind: 'noop' | 'append' | 'rebuild';
  cues: SubtitleCue[];
  appended: SubtitleCue[];
  durationUpdates: Array<{ index: number; dDurationMs: number }>;
}

export interface Html5CaptionTypographyInput {
  heightPx: number;
  fullscreen?: boolean;
  origPct?: number;
  transPct?: number;
  targetLang?: string;
  scaleMult?: number;
  bgOpacityPercent?: number | null;
}

export interface Html5CaptionTypography {
  transPx: number;
  origPx: number;
  padY: number;
  padX: number;
  radius: number;
  capBg: string;
}

export interface Html5BottomOffsetInput {
  container: HTMLElement | null;
  playerRoot?: HTMLElement | null;
  video?: HTMLVideoElement | null;
  heightPx?: number;
  fullscreen?: boolean;
  paused?: boolean;
  recentPointerActivity?: boolean;
  getComputedStyleFn?: (el: Element) => CSSStyleDeclaration;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

function isCaptionKind(kind: string | undefined): boolean {
  return kind === 'subtitles' || kind === 'captions';
}

/**
 * Picks the active host-controlled caption track without ever writing `TextTrack.mode`.
 * Prefers `'showing'`, then `'hidden'`, and strictly ignores `'disabled'`.
 */
export function pickCaptionTrack(
  video: HTMLVideoElement | null | undefined,
): TextTrack | null {
  if (!video || !video.textTracks) return null;
  const tracks = Array.from(video.textTracks).filter((t) =>
    isCaptionKind(t?.kind),
  );
  const showing = tracks.find((t) => t.mode === 'showing');
  if (showing) return showing;
  const hidden = tracks.find((t) => t.mode === 'hidden');
  return hidden ?? null;
}

/**
 * Unambiguous host CC signal (valid because Margin never mutates `TextTrack.mode` on HTML5 hosts).
 */
export function isHostCaptionsOn(
  video: HTMLVideoElement | null | undefined,
): boolean {
  return pickCaptionTrack(video) !== null;
}

export function buildHtml5TrackIdentity(
  video: HTMLVideoElement,
  track: TextTrack,
): string {
  const captionTracks = Array.from(video.textTracks ?? []).filter((t) =>
    isCaptionKind(t?.kind),
  );
  const idx = captionTracks.indexOf(track);
  const trackWithId = track as TextTrack & { id?: string };
  return [
    trackWithId.id || '',
    track.language || '',
    track.label || '',
    track.kind || '',
    String(idx),
  ].join('|');
}

export function resolveViewportSize(doc?: Document | null): ViewportSize {
  const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const width =
    (win && Number.isFinite(win.innerWidth) && win.innerWidth > 0
      ? win.innerWidth
      : 0) ||
    doc?.documentElement?.clientWidth ||
    1024;
  const height =
    (win && Number.isFinite(win.innerHeight) && win.innerHeight > 0
      ? win.innerHeight
      : 0) ||
    doc?.documentElement?.clientHeight ||
    768;
  return { width, height };
}

export function resolveEffectiveVideoRect(
  video: HTMLVideoElement,
  viewport?: ViewportSize,
): Required<RectLike> {
  const raw = video.getBoundingClientRect?.() ?? {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  };
  const width = Number(raw.width) || 0;
  const height = Number(raw.height) || 0;
  if (width > 0 && height > 0) {
    const left = Number(raw.left) || 0;
    const top = Number(raw.top) || 0;
    return {
      top,
      left,
      width,
      height,
      right: raw.right !== undefined ? Number(raw.right) : left + width,
      bottom: raw.bottom !== undefined ? Number(raw.bottom) : top + height,
    };
  }

  // Headless unit-test environments (happy-dom) have 0x0 documentElement layout unless mocked on the node
  const doc = video.ownerDocument;
  const win = doc?.defaultView;
  const hasDocumentLayout =
    (doc?.documentElement?.getBoundingClientRect?.().width ?? 0) > 0;
  const hasOwnRectOverride = Object.prototype.hasOwnProperty.call(
    video,
    'getBoundingClientRect',
  );
  const computedDisplay = win?.getComputedStyle?.(video)?.display;

  if (
    !hasDocumentLayout &&
    !hasOwnRectOverride &&
    computedDisplay !== 'none' &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  ) {
    const vp = viewport ?? resolveViewportSize(doc);
    const w = Math.min(video.videoWidth, vp.width);
    const h = Math.min(video.videoHeight, vp.height);
    return { top: 0, left: 0, right: w, bottom: h, width: w, height: h };
  }

  return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
}

function isVideoElementLike(
  target: Element | RectLike,
): target is HTMLVideoElement {
  return (
    typeof (target as Element).getBoundingClientRect === 'function' &&
    (target as Element).tagName === 'VIDEO'
  );
}

function isElementLike(target: Element | RectLike): target is Element {
  return typeof (target as Element).getBoundingClientRect === 'function';
}

function computeRectIntersection(
  rect: RectLike,
  viewport: ViewportSize,
): { ratio: number; visibleArea: number; totalArea: number } {
  const width = Number(rect.width) || 0;
  const height = Number(rect.height) || 0;
  const vpW = Number(viewport.width) || 0;
  const vpH = Number(viewport.height) || 0;
  if (width <= 0 || height <= 0 || vpW <= 0 || vpH <= 0) {
    return { ratio: 0, visibleArea: 0, totalArea: 0 };
  }
  const left = Number(rect.left) || 0;
  const top = Number(rect.top) || 0;
  const right = rect.right !== undefined ? Number(rect.right) : left + width;
  const bottom = rect.bottom !== undefined ? Number(rect.bottom) : top + height;

  const interW = Math.max(0, Math.min(right, vpW) - Math.max(left, 0));
  const interH = Math.max(0, Math.min(bottom, vpH) - Math.max(top, 0));
  const visibleArea = interW * interH;
  const totalArea = width * height;
  return {
    ratio: clamp(visibleArea / totalArea, 0, 1),
    visibleArea,
    totalArea,
  };
}

/**
 * Computes the fraction `[0, 1]` of a video or rect intersecting the viewport.
 */
export function computeVisibleRatio(
  target: Element | RectLike,
  viewport?: ViewportSize,
): number {
  const vp =
    viewport ??
    resolveViewportSize(isElementLike(target) ? target.ownerDocument : null);
  const rect = isVideoElementLike(target)
    ? resolveEffectiveVideoRect(target, vp)
    : isElementLike(target)
      ? target.getBoundingClientRect()
      : target;
  return computeRectIntersection(rect, vp).ratio;
}

export function isHtml5VideoPlaying(video: HTMLVideoElement): boolean {
  return !video.paused && !video.ended && (video.readyState ?? 0) >= 2;
}

export function isHtml5VideoPlayingVisible(
  video: HTMLVideoElement,
  viewport?: ViewportSize,
): boolean {
  if (!video.isConnected || !isHtml5VideoPlaying(video)) return false;
  return computeVisibleRatio(video, viewport) >= 0.5;
}

/**
 * Selects the active HTML5 `<video>` across multi-video feeds with 25%–50% hysteresis.
 * Supports either `(SelectActiveHtml5VideoParams)` or `(candidates, current, viewport?, lastPlayingAt?)`.
 */
export function selectActiveHtml5Video(
  paramsOrCandidates: SelectActiveHtml5VideoParams | readonly HTMLVideoElement[],
  currentArg: HTMLVideoElement | null = null,
  viewportArg?: ViewportSize,
  lastPlayingAtArg?: PlayingTimestampLookup,
): HTMLVideoElement | null {
  const params: SelectActiveHtml5VideoParams = Array.isArray(paramsOrCandidates)
    ? {
        candidates: paramsOrCandidates as readonly HTMLVideoElement[],
        current: currentArg,
        viewport: viewportArg,
        lastPlayingAt: lastPlayingAtArg,
      }
    : (paramsOrCandidates as SelectActiveHtml5VideoParams);

  const firstDoc =
    params.current?.ownerDocument ?? params.candidates[0]?.ownerDocument ?? null;
  const vp = params.viewport ?? resolveViewportSize(firstDoc);

  interface ScoredCandidate {
    video: HTMLVideoElement;
    ratio: number;
    visibleArea: number;
    totalArea: number;
    playing: boolean;
    playingVisible: boolean;
    playedAt: number;
  }

  const scored: ScoredCandidate[] = [];
  for (const video of params.candidates) {
    if (!video || video.isConnected === false) continue;
    const rect = resolveEffectiveVideoRect(video, vp);
    const inter = computeRectIntersection(rect, vp);
    if (inter.totalArea <= 0) continue;
    const playing = isHtml5VideoPlaying(video);
    scored.push({
      video,
      ratio: inter.ratio,
      visibleArea: inter.visibleArea,
      totalArea: inter.totalArea,
      playing,
      playingVisible: playing && inter.ratio >= 0.5,
      playedAt: params.lastPlayingAt?.get(video) ?? 0,
    });
  }

  const playingVisibleCandidates = scored.filter((item) => item.playingVisible);

  // Hysteresis: retain `current` while connected and >= 25% visible if still playing
  // (or paused with no competing `playingVisible` video).
  if (params.current && params.current.isConnected !== false) {
    const curRect = resolveEffectiveVideoRect(params.current, vp);
    const curInter = computeRectIntersection(curRect, vp);
    if (
      curInter.totalArea > 0 &&
      curInter.ratio >= 0.25 &&
      (isHtml5VideoPlaying(params.current) ||
        playingVisibleCandidates.length === 0)
    ) {
      return params.current;
    }
  }

  if (playingVisibleCandidates.length > 0) {
    playingVisibleCandidates.sort(
      (a, b) => b.visibleArea - a.visibleArea || b.playedAt - a.playedAt,
    );
    return playingVisibleCandidates[0].video;
  }

  // Keep connected `current` when temporarily scrolled out with no replacement playing video
  // (state machine enters ON_IDLE so gate closes and overlay hides while preserving cached cues).
  if (params.current && params.current.isConnected !== false) {
    return params.current;
  }

  return null;
}

/**
 * Rebases `01:00:00.000` (`3_600_000ms`) NLE/SMPTE broadcast timecode offsets on raw `.vtt` fetch tracks
 * when every cue starts at `>= 3_600_000ms` while the media duration is `< 3_600_000ms`.
 */
export function rebaseSmpteBroadcastOffset(
  cues: readonly SubtitleCue[],
  videoDurationMs?: number,
): SubtitleCue[] {
  if (
    cues.length === 0 ||
    videoDurationMs === undefined ||
    !Number.isFinite(videoDurationMs) ||
    videoDurationMs <= 0 ||
    videoDurationMs >= SMPTE_BROADCAST_OFFSET_MS
  ) {
    return cues.map((c) => ({ ...c }));
  }
  const allAtOrPastOneHour = cues.every(
    (cue) => cue.tStartMs >= SMPTE_BROADCAST_OFFSET_MS,
  );
  if (!allAtOrPastOneHour) {
    return cues.map((c) => ({ ...c }));
  }
  return cues.map((cue) => ({
    ...cue,
    tStartMs: cue.tStartMs - SMPTE_BROADCAST_OFFSET_MS,
  }));
}

function finalizeHtml5CueDurations(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return cues.map((cue, index) => {
    let nextIndex = index + 1;
    while (
      nextIndex < cues.length &&
      cues[nextIndex].tStartMs <= cue.tStartMs
    ) {
      nextIndex += 1;
    }

    const nextStart = cues[nextIndex]?.tStartMs;
    const distanceToNext =
      nextStart !== undefined &&
      Number.isFinite(nextStart) &&
      nextStart > cue.tStartMs
        ? nextStart - cue.tStartMs
        : 0;

    let duration = cue.dDurationMs;
    if (!(duration > 0)) {
      duration = distanceToNext || FALLBACK_CUE_DURATION_MS;
    }
    if (distanceToNext > 0 && duration > distanceToNext) {
      duration = distanceToNext;
    }
    duration = clamp(duration, MIN_CUE_DURATION_MS, MAX_CUE_DURATION_MS);

    return {
      ...cue,
      dDurationMs: duration,
    };
  });
}

/**
 * Normalizes extracted HTML5 cues:
 * - Dedupes identical-text cues within `|Δstart| <= 50ms` (keeping widest end)
 * - Coalesces adjacent identical-text cues split across HLS segment boundaries (`gap <= 120ms`)
 */
export function normalizeHtml5CueList(
  rawCues: readonly SubtitleCue[],
): SubtitleCue[] {
  if (!rawCues || rawCues.length === 0) return [];

  const prepared: Array<{
    tStartMs: number;
    endMs: number;
    hasExplicitDuration: boolean;
    text: string;
    trans?: string;
    order: number;
  }> = [];

  for (let i = 0; i < rawCues.length; i += 1) {
    const cue = rawCues[i];
    if (!cue || !Number.isFinite(cue.tStartMs) || cue.tStartMs < 0) continue;
    const text = sanitizeSubtitleMarkup(cue.text);
    if (!text) continue;
    const dur =
      Number.isFinite(cue.dDurationMs) && cue.dDurationMs > 0
        ? cue.dDurationMs
        : 0;
    prepared.push({
      tStartMs: Math.round(cue.tStartMs),
      endMs: Math.round(cue.tStartMs + dur),
      hasExplicitDuration: dur > 0,
      text,
      ...(cue.trans ? { trans: cue.trans } : {}),
      order: i,
    });
  }

  prepared.sort(
    (a, b) => a.tStartMs - b.tStartMs || a.order - b.order,
  );

  const coalesced: typeof prepared = [];
  for (const cur of prepared) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.text === cur.text) {
      const startDelta = Math.abs(cur.tStartMs - prev.tStartMs);
      const boundaryGap = cur.tStartMs - prev.endMs;
      const isNearStartDup = startDelta <= 50;
      const isSegmentBoundarySplit =
        prev.hasExplicitDuration && boundaryGap <= 120;
      if (isNearStartDup || isSegmentBoundarySplit) {
        prev.endMs = Math.max(prev.endMs, cur.endMs);
        prev.hasExplicitDuration =
          prev.hasExplicitDuration || cur.hasExplicitDuration;
        if (!prev.trans && cur.trans) {
          prev.trans = cur.trans;
        }
        continue;
      }
    }
    coalesced.push({ ...cur });
  }

  const intermediate: SubtitleCue[] = coalesced.map((item) => ({
    tStartMs: item.tStartMs,
    dDurationMs: item.hasExplicitDuration
      ? Math.max(0, item.endMs - item.tStartMs)
      : 0,
    text: item.text,
    ...(item.trans ? { trans: item.trans } : {}),
  }));

  return finalizeHtml5CueDurations(intermediate);
}

export function recordCueTranslationsInMemo(
  memo: Map<string, string>,
  cues: readonly SubtitleCue[],
): void {
  for (const cue of cues) {
    if (!cue?.text || !cue.trans) continue;
    const bucket = Math.round(cue.tStartMs / 50);
    memo.set(`${cue.text}|${bucket}`, cue.trans);
  }
}

function lookupCueTranslationInMemo(
  memo: ReadonlyMap<string, string> | undefined,
  text: string,
  tStartMs: number,
): string | undefined {
  if (!memo || memo.size === 0) return undefined;
  const center = Math.round(tStartMs / 50);
  return (
    memo.get(`${text}|${center}`) ??
    memo.get(`${text}|${center - 1}`) ??
    memo.get(`${text}|${center + 1}`)
  );
}

/**
 * Merges incoming HTML5 / HLS `TextTrack` cues against `existing` scheduler cues:
 * - `noop`: transient empty `next` or unchanged cue prefix
 * - `append`: `existing` is a `(±50ms, same-text)` prefix of `next` with new trailing cues
 * - `rebuild`: out-of-order seek insert or shrink, carrying existing `trans` by `(text, ±50ms)` (plus optional per-video `translationMemo` across HLS buffer eviction)
 */
export function mergeHtml5Cues(
  existing: readonly SubtitleCue[],
  nextRaw: readonly SubtitleCue[],
  translationMemo?: ReadonlyMap<string, string>,
): MergeHtml5CuesResult {
  const normNext = normalizeHtml5CueList(nextRaw);

  if (normNext.length === 0) {
    return {
      kind: 'noop',
      cues: existing.map((c) => ({ ...c })),
      appended: [],
      durationUpdates: [],
    };
  }

  if (existing.length === 0) {
    const hydrated =
      translationMemo && translationMemo.size > 0
        ? normNext.map((nx) => {
            const memoTrans =
              nx.trans ??
              lookupCueTranslationInMemo(translationMemo, nx.text, nx.tStartMs);
            return memoTrans ? { ...nx, trans: memoTrans } : nx;
          })
        : normNext;
    return {
      kind: 'rebuild',
      cues: hydrated,
      appended: [],
      durationUpdates: [],
    };
  }

  if (normNext.length >= existing.length) {
    let prefixMatches = true;
    const durationUpdates: Array<{ index: number; dDurationMs: number }> = [];

    for (let i = 0; i < existing.length; i += 1) {
      const ex = existing[i];
      const nx = normNext[i];
      if (
        ex.text !== nx.text ||
        Math.abs(nx.tStartMs - ex.tStartMs) > 50
      ) {
        prefixMatches = false;
        break;
      }
      if (Math.abs(nx.dDurationMs - ex.dDurationMs) > 50) {
        durationUpdates.push({ index: i, dDurationMs: nx.dDurationMs });
      }
    }

    if (prefixMatches) {
      const updatedExisting = existing.map((ex, i) => ({
        ...ex,
        dDurationMs: normNext[i].dDurationMs,
      }));

      if (normNext.length === existing.length) {
        return {
          kind: 'noop',
          cues: updatedExisting,
          appended: [],
          durationUpdates,
        };
      }

      const firstAppended = normNext[existing.length];
      const lastExisting = existing[existing.length - 1];
      if (firstAppended.tStartMs >= lastExisting.tStartMs) {
        const appended = normNext.slice(existing.length).map((nx) => {
          const memoTrans =
            nx.trans ??
            lookupCueTranslationInMemo(translationMemo, nx.text, nx.tStartMs);
          return memoTrans ? { ...nx, trans: memoTrans } : nx;
        });
        return {
          kind: 'append',
          cues: [...updatedExisting, ...appended],
          appended,
          durationUpdates,
        };
      }
    }
  }

  // Rebuild path: carry existing translations by `(text, |Δstart| <= 50ms)`, falling back to `translationMemo`
  const translatedPool = existing.filter((ex) => Boolean(ex.trans));
  const usedPoolIndices = new Set<number>();

  const carried = normNext.map((nx) => {
    let bestPoolIdx = -1;
    let bestDelta = 51;
    for (let i = 0; i < translatedPool.length; i += 1) {
      if (usedPoolIndices.has(i)) continue;
      const candidate = translatedPool[i];
      if (candidate.text !== nx.text) continue;
      const delta = Math.abs(candidate.tStartMs - nx.tStartMs);
      if (delta <= 50 && delta < bestDelta) {
        bestDelta = delta;
        bestPoolIdx = i;
      }
    }
    if (bestPoolIdx >= 0) {
      usedPoolIndices.add(bestPoolIdx);
      return {
        ...nx,
        trans: translatedPool[bestPoolIdx].trans,
      };
    }
    const memoTrans = lookupCueTranslationInMemo(
      translationMemo,
      nx.text,
      nx.tStartMs,
    );
    if (memoTrans) {
      return {
        ...nx,
        trans: memoTrans,
      };
    }
    return { ...nx };
  });

  return {
    kind: 'rebuild',
    cues: carried,
    appended: [],
    durationUpdates: [],
  };
}

/**
 * Normalizes caption text for DOM matching (NFKC, lowercase, strips whitespace/punctuation/symbols).
 */
export function normalizeForCaptionMatch(raw: string): string {
  if (!raw) return '';
  return sanitizeSubtitleMarkup(raw)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * Resolves the host player container root for a bound `<video>`.
 * Prefers X's `[data-testid="videoPlayer"]`; otherwise climbs `<= 4` ancestors whose area is `<= 1.3x` video rect.
 */
export function resolveHtml5PlayerRoot(
  video: HTMLVideoElement | null | undefined,
): HTMLElement | null {
  if (!video) return null;
  const xPlayer = video.closest<HTMLElement>('[data-testid="videoPlayer"]');
  if (xPlayer) return xPlayer;

  const vRect = video.getBoundingClientRect?.();
  const videoArea =
    vRect && vRect.width > 0 && vRect.height > 0
      ? vRect.width * vRect.height
      : 0;

  if (videoArea > 0) {
    let best: HTMLElement | null = null;
    let anc = video.parentElement;
    for (let depth = 1; depth <= 4 && anc; depth += 1) {
      const tag = anc.tagName;
      if (tag === 'BODY' || tag === 'HTML') break;
      const aRect = anc.getBoundingClientRect?.();
      const area =
        aRect && aRect.width > 0 && aRect.height > 0
          ? aRect.width * aRect.height
          : 0;
      if (area > 0 && area <= videoArea * 1.3) {
        best = anc;
      } else if (area > videoArea * 1.3) {
        break;
      }
      anc = anc.parentElement;
    }
    return best ?? video.parentElement;
  }

  const parent = video.parentElement;
  if (
    parent &&
    parent.tagName !== 'BODY' &&
    parent.tagName !== 'HTML' &&
    parent.tagName !== 'MAIN' &&
    parent.tagName !== 'ARTICLE'
  ) {
    return parent;
  }
  return null;
}

const FORBIDDEN_CAPTION_SUBTREE_SELECTOR = [
  'video',
  'button',
  '[role="button"]',
  '[role="slider"]',
  '[data-testid="playButton"]',
  '[data-testid="tweetText"]',
  `[${BRAND.domAttrPrefix}-injected]`,
].join(', ');

function isForbiddenCaptionElement(
  el: Element,
  ownHost?: Element | null,
): boolean {
  if (ownHost && el === ownHost) return true;
  const tag = el.tagName;
  if (
    tag === 'VIDEO' ||
    tag === 'BUTTON' ||
    tag === 'SCRIPT' ||
    tag === 'STYLE' ||
    tag === 'NOSCRIPT'
  ) {
    return true;
  }
  const role = el.getAttribute('role');
  if (role === 'button' || role === 'slider') return true;
  const testId = el.getAttribute('data-testid');
  if (testId === 'playButton' || testId === 'tweetText') return true;
  if (el.hasAttribute(`${BRAND.domAttrPrefix}-injected`)) return true;
  return false;
}

function hasForbiddenAncestorWithinRoot(
  el: Element,
  root: HTMLElement,
  ownHost?: Element | null,
): boolean {
  let cur: Element | null = el;
  while (cur && cur !== root) {
    if (isForbiddenCaptionElement(cur, ownHost)) return true;
    cur = cur.parentElement;
  }
  return false;
}

function containsForbiddenDescendant(
  el: HTMLElement,
  ownHost?: Element | null,
): boolean {
  if (isForbiddenCaptionElement(el, ownHost)) return true;
  if (ownHost && el.contains(ownHost)) return true;
  return el.querySelector(FORBIDDEN_CAPTION_SUBTREE_SELECTOR) !== null;
}

/**
 * Locates X / custom HTML5 player's DOM caption layer by cue-text match without touching
 * controls, buttons, sliders, `<video>`, or Margin's own overlay host.
 */
export function findNativeCaptionLayer(
  root: HTMLElement | null,
  activeTexts: readonly string[],
  ownHost?: Element | null,
): HTMLElement | null {
  if (!root || !activeTexts || activeTexts.length === 0) return null;

  const normActives = activeTexts
    .map(normalizeForCaptionMatch)
    .filter((t) => t.length >= 2);
  if (normActives.length === 0) return null;

  const joinedActive = normActives.join('');
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const matchingParents: HTMLElement[] = [];

  let currentNode = walker.nextNode();
  while (currentNode) {
    const parent = currentNode.parentElement;
    if (
      parent &&
      parent !== root &&
      !hasForbiddenAncestorWithinRoot(parent, root, ownHost)
    ) {
      const normNode = normalizeForCaptionMatch(currentNode.nodeValue ?? '');
      // P3-a: require >= 4 normalized chars for substring match (unless equal to a whole short cue)
      // so short "GIF" / "HD" / "Live" badges can never widen the LCA.
      const isWholeShortCue =
        normNode.length >= 2 &&
        normActives.some((active) => active === normNode);
      const isValidSubstring =
        normNode.length >= 4 &&
        (normActives.some((active) => active.includes(normNode)) ||
          joinedActive.includes(normNode));
      if (isWholeShortCue || isValidSubstring) {
        if (!matchingParents.includes(parent)) {
          matchingParents.push(parent);
        }
      }
    }
    currentNode = walker.nextNode();
  }

  if (matchingParents.length === 0) return null;

  // Compute LCA of matching text-node parents within `root`
  let lca: HTMLElement | null = matchingParents[0];
  for (let i = 1; i < matchingParents.length && lca; i += 1) {
    const other = matchingParents[i];
    while (lca && !lca.contains(other)) {
      lca = lca.parentElement;
    }
  }
  if (!lca || lca === root || !root.contains(lca)) return null;
  if (containsForbiddenDescendant(lca, ownHost)) return null;

  // Climb to outermost dedicated caption wrapper inside `root`
  let candidate: HTMLElement = lca;
  while (candidate.parentElement && candidate.parentElement !== root) {
    const nextParent = candidate.parentElement;
    if (containsForbiddenDescendant(nextParent, ownHost)) break;
    const parentNorm = normalizeForCaptionMatch(nextParent.textContent ?? '');
    if (!parentNorm || !joinedActive.includes(parentNorm)) break;
    candidate = nextParent;
  }

  const candidateNorm = normalizeForCaptionMatch(candidate.textContent ?? '');
  if (!candidateNorm) return null;

  const joinedRatio = candidateNorm.length / joinedActive.length;
  const validAgainstJoined =
    joinedActive.includes(candidateNorm) &&
    joinedRatio >= 0.6 &&
    joinedRatio <= 1.2;
  const validAgainstSingleCue = normActives.some((active) => {
    const r = candidateNorm.length / active.length;
    return active.includes(candidateNorm) && r >= 0.6 && r <= 1.2;
  });

  if (!validAgainstJoined && !validAgainstSingleCue) {
    return null;
  }

  return candidate;
}

/**
 * Style 1 typography solver for HTML5 / X bilingual capsules.
 * Enforces a crisp 14px CJK readability floor on compact cards (502x283 -> 14px zh / 12.5px en)
 * and scales smoothly up to cinema proportions in fullscreen (1080p -> 28px / 24.5px).
 */
export function computeHtml5CaptionTypography(
  input: Html5CaptionTypographyInput,
): Html5CaptionTypography {
  const fullscreen = Boolean(input.fullscreen);
  const H =
    Number.isFinite(input.heightPx) && input.heightPx > 0
      ? input.heightPx
      : fullscreen
        ? 1080
        : 300;
  const origPct =
    input.origPct !== undefined && Number.isFinite(input.origPct) && input.origPct > 0
      ? input.origPct
      : 100;
  const transPct =
    input.transPct !== undefined && Number.isFinite(input.transPct) && input.transPct > 0
      ? input.transPct
      : 70;
  const scaleMult =
    input.scaleMult !== undefined && Number.isFinite(input.scaleMult) && input.scaleMult > 0
      ? input.scaleMult
      : 1;
  const targetLang = (input.targetLang ?? 'zh-CN').trim();

  const transBase = clamp(9 + 0.0176 * H, 14, 36);
  const isCjk = /^(zh|ja|ko)\b/i.test(targetLang);
  const minTransPx = isCjk ? 14 : 13;

  const transPx = roundHalf(
    clamp(transBase * (transPct / 70) * scaleMult, minTransPx, 44),
  );
  const origPx = roundHalf(
    clamp(transBase * 0.88 * (origPct / 100) * scaleMult, 12, 38),
  );

  const padY = clamp(Math.round(transPx * 0.28), 3, 9);
  const padX = clamp(Math.round(transPx * 0.7), 8, 20);
  const radius = clamp(Math.round(transPx * 0.72), 8, 14);

  const alpha =
    input.bgOpacityPercent !== null &&
    input.bgOpacityPercent !== undefined &&
    Number.isFinite(input.bgOpacityPercent)
      ? clamp(Math.round(input.bgOpacityPercent), 0, 100) / 100
      : 0.66;
  const roundedAlpha = Math.round(alpha * 1000) / 1000;
  const capBg = `rgba(17, 17, 20, ${roundedAlpha})`;

  return {
    transPx,
    origPx,
    padY,
    padX,
    radius,
    capBg,
  };
}

const GENERIC_CONTROL_BAR_SELECTOR =
  '.vjs-control-bar, .plyr__controls, .jw-controlbar, .mejs__controls, .shaka-bottom-controls';

function isControlBarRenderedVisible(
  el: HTMLElement,
  stopRoot: HTMLElement,
  getStyle: (node: Element) => CSSStyleDeclaration,
): boolean {
  const rect = el.getBoundingClientRect?.();
  if (!rect || rect.height <= 0 || rect.width <= 0) return false;

  let opacityProduct = 1;
  let cur: HTMLElement | null = el;
  while (cur) {
    const st = getStyle(cur);
    if (
      st.display === 'none' ||
      st.visibility === 'hidden' ||
      st.visibility === 'collapse'
    ) {
      return false;
    }
    const rawOp = st.opacity;
    if (rawOp !== undefined && rawOp !== '') {
      const parsedOp = Number(rawOp);
      if (Number.isFinite(parsedOp)) {
        opacityProduct *= parsedOp;
        if (opacityProduct < 0.15) return false;
      }
    }
    if (cur === stopRoot) break;
    cur = cur.parentElement;
  }

  return opacityProduct >= 0.15;
}

/**
 * Dynamic bottom-offset solver for X `[role="slider"]` and generic HTML5 control bars.
 * Lifts the capsule cleanly above X's ~47px scrubber (`~55px`) when visible and settles to `14px` when hidden.
 */
export function computeHtml5BottomOffset(input: Html5BottomOffsetInput): number {
  const fullscreen = Boolean(input.fullscreen);
  const container = input.container;
  const containerRect = container?.getBoundingClientRect?.();
  const rawH =
    input.heightPx && input.heightPx > 0
      ? input.heightPx
      : containerRect?.height || container?.clientHeight || 0;
  const H = rawH > 0 ? rawH : fullscreen ? 1080 : 283;
  const hiddenGap = fullscreen
    ? clamp(Math.round(H * 0.035), 24, 48)
    : H < 400
      ? 14
      : 16;

  if (!container) {
    return input.paused || input.recentPointerActivity
      ? fullscreen
        ? 72
        : 52
      : hiddenGap;
  }

  const searchRoot = input.playerRoot ?? container;
  const defaultView = container.ownerDocument?.defaultView;
  const getStyle =
    input.getComputedStyleFn ??
    ((node: Element) =>
      defaultView?.getComputedStyle
        ? defaultView.getComputedStyle(node)
        : ({} as CSSStyleDeclaration));

  const cWidth = containerRect?.width || container.clientWidth || 0;
  const cHeight = containerRect?.height || H;
  const cTop = containerRect?.top ?? 0;
  const cBottom =
    containerRect && containerRect.height > 0
      ? containerRect.bottom
      : cTop + cHeight;

  // 1. X / custom player wide `[role="slider"]` scrubber in bottom 40%
  if (cWidth > 0 && cHeight > 0) {
    const sliders = Array.from(
      searchRoot.querySelectorAll<HTMLElement>('[role="slider"]'),
    );
    let matchedBottomSlider = false;
    for (const slider of sliders) {
      const sRect = slider.getBoundingClientRect?.();
      if (!sRect) continue;
      const isWideBottom =
        sRect.width >= cWidth * 0.5 &&
        sRect.top >= cTop + cHeight * 0.6 &&
        sRect.top <= cBottom;
      if (!isWideBottom) continue;

      matchedBottomSlider = true;
      if (isControlBarRenderedVisible(slider, searchRoot, getStyle)) {
        const clearance = Math.round(cBottom - sRect.top + 8);
        return clamp(clearance, hiddenGap, Math.round(0.4 * H));
      }
    }
    if (matchedBottomSlider) {
      return hiddenGap;
    }
    // If inside X `[data-testid="videoPlayer"]` and X unmounted/collapsed its slider completely -> controls are hidden
    if (
      searchRoot.getAttribute('data-testid') === 'videoPlayer' ||
      searchRoot.querySelector('[data-testid="videoComponent"]') !== null
    ) {
      return hiddenGap;
    }
  }

  // 2. Known third-party HTML5 player control bars
  const knownBar = searchRoot.querySelector<HTMLElement>(
    GENERIC_CONTROL_BAR_SELECTOR,
  );
  if (knownBar && cHeight > 0) {
    const bRect = knownBar.getBoundingClientRect?.();
    if (
      bRect &&
      bRect.top > cTop &&
      bRect.top < cBottom &&
      isControlBarRenderedVisible(knownBar, searchRoot, getStyle)
    ) {
      const clearance = Math.round(cBottom - bRect.top + 8);
      return clamp(clearance, hiddenGap, Math.round(0.4 * H));
    }
    return hiddenGap;
  }

  // 3. Native `<video controls>` / unknown player autohide heuristic
  if (input.paused || input.recentPointerActivity) {
    return fullscreen ? 72 : 52;
  }
  return hiddenGap;
}
