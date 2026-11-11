import type { SubtitleCue, YoutubeRawJson3Event } from '@shared/types';

export const FALLBACK_CUE_DURATION_MS = 3_000;
export const MIN_CUE_DURATION_MS = 100;
export const MAX_CUE_DURATION_MS = 30_000;
export const APPEND_PROXIMITY_FLOOR_MS = 5_000;
export const DEFAULT_ALIGNMENT_MAX_DELTA_MS = 1_000;
export const MIN_ALIGNMENT_MATCH_RATIO = 0.6;

export type YoutubeJson3Input =
  | readonly YoutubeRawJson3Event[]
  | { events?: readonly YoutubeRawJson3Event[] | null }
  | null
  | undefined;

export interface TextTrackCueLike {
  startTime: number;
  endTime: number;
  text?: string;
}

export interface AlignedTrackMergeOptions {
  maxDeltaMs?: number;
  minMatchRatio?: number;
}

export interface AlignedTrackMergeResult {
  applied: boolean;
  matchRatio: number;
  cues: SubtitleCue[];
}

interface PreparedYoutubeEvent {
  tStartMs: number;
  dDurationMs: number;
  text: string;
  wWinId?: number;
  aAppend?: number;
  order: number;
}

function extractRawEventText(event: YoutubeRawJson3Event | null | undefined): string {
  if (!event) return '';
  if (typeof event.text === 'string') return event.text;
  if (!Array.isArray(event.segs)) return '';
  return event.segs.map((seg) => seg?.utf8 ?? '').join('');
}

function cleanCueLineText(text: string): string {
  return String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/**
 * P0-3 6-Step YouTube JSON3 Timeline Sanitizer:
 * 1) Retain zero/missing `dDurationMs` events (`tStartMs >= 0`, extract `segs[].utf8` / `text`,
 *    normalize `\r?\n` -> space, drop empty/whitespace-only).
 * 2) Merge rolling `aAppend === 1` cues into previous cue when `wWinId` matches or
 *    `tStartMs <= prev.tStartMs + Math.max(prev.dDurationMs, 5000)` (prefix-extension & suffix concat).
 * 3) Deduplicate identical `(tStartMs, text)` preserving `Math.max` duration.
 * 4) Infer missing/`0` duration from `distanceToNext` (`3000ms` tail fallback).
 * 5) Trim overlapping `dDurationMs > distanceToNext`.
 * 6) Clamp `dDurationMs` to `[100ms, 30000ms]`.
 */
export function normalizeYoutubeEvents(input: YoutubeJson3Input): SubtitleCue[] {
  let rawEvents: readonly YoutubeRawJson3Event[] = [];
  if (Array.isArray(input)) {
    rawEvents = input;
  } else if (input && typeof input === 'object' && 'events' in input && Array.isArray(input.events)) {
    rawEvents = input.events;
  }

  // Step 1: Retain zero/missing durations, normalize line breaks, drop invalid/empty, stable sort
  const prepared: PreparedYoutubeEvent[] = [];
  for (let order = 0; order < rawEvents.length; order += 1) {
    const event = rawEvents[order];
    if (!event) continue;

    const start = Number(event.tStartMs);
    if (!Number.isFinite(start) || start < 0) continue;

    const rawText = extractRawEventText(event).replace(/\r?\n/g, ' ');
    if (!rawText.trim()) continue;

    const duration = Number(event.dDurationMs);
    const preparedEvent: PreparedYoutubeEvent = {
      tStartMs: start,
      dDurationMs: Number.isFinite(duration) && duration > 0 ? duration : 0,
      text: rawText,
      order,
    };

    if (event.wWinId != null && Number.isFinite(Number(event.wWinId))) {
      preparedEvent.wWinId = Number(event.wWinId);
    }
    if (event.aAppend != null) {
      preparedEvent.aAppend = Number(event.aAppend);
    }

    prepared.push(preparedEvent);
  }

  prepared.sort(
    (left, right) => left.tStartMs - right.tStartMs || left.order - right.order,
  );

  // Step 2: Merge rolling `aAppend === 1` cues into previous cue
  const appended: PreparedYoutubeEvent[] = [];
  for (const event of prepared) {
    const previous = appended[appended.length - 1];
    const sameWindow =
      previous !== undefined &&
      event.wWinId != null &&
      previous.wWinId === event.wWinId;
    const nearPrevious =
      previous !== undefined &&
      event.tStartMs <=
        previous.tStartMs + Math.max(previous.dDurationMs || 0, APPEND_PROXIMITY_FLOOR_MS);

    if (event.aAppend === 1 && previous && (sameWindow || nearPrevious)) {
      const previousClean = cleanCueLineText(previous.text);
      const currentClean = cleanCueLineText(event.text);

      if (currentClean.startsWith(previousClean)) {
        previous.text = event.text;
      } else if (!previousClean.endsWith(currentClean)) {
        previous.text += event.text;
      }

      const appendEnd = event.tStartMs + event.dDurationMs - previous.tStartMs;
      if (appendEnd > previous.dDurationMs) {
        previous.dDurationMs = appendEnd;
      }
      continue;
    }

    appended.push({ ...event });
  }

  // Step 3: Deduplicate identical `(tStartMs, text)` keeping Math.max duration
  const deduplicated: SubtitleCue[] = [];
  for (const event of appended) {
    const text = cleanCueLineText(event.text);
    if (!text) continue;

    const previous = deduplicated[deduplicated.length - 1];
    if (previous && previous.tStartMs === event.tStartMs && previous.text === text) {
      previous.dDurationMs = Math.max(previous.dDurationMs, event.dDurationMs);
      continue;
    }

    const cue: SubtitleCue = {
      tStartMs: event.tStartMs,
      dDurationMs: event.dDurationMs,
      text,
    };
    if (event.wWinId != null) {
      cue.wWinId = event.wWinId;
    }
    deduplicated.push(cue);
  }

  // Steps 4, 5, 6: Infer missing/0 duration, trim overlaps, clamp to [100ms, 30000ms]
  return finalizeCueDurations(deduplicated);
}

function finalizeCueDurations(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return cues.map((cue, index) => {
    let nextIndex = index + 1;
    while (nextIndex < cues.length && cues[nextIndex].tStartMs <= cue.tStartMs) {
      nextIndex += 1;
    }

    const nextStart = cues[nextIndex]?.tStartMs;
    const distanceToNext =
      nextStart !== undefined && Number.isFinite(nextStart) && nextStart > cue.tStartMs
        ? nextStart - cue.tStartMs
        : 0;

    let duration = cue.dDurationMs;
    if (!(duration > 0)) {
      duration = distanceToNext || FALLBACK_CUE_DURATION_MS;
    }
    if (distanceToNext > 0 && duration > distanceToNext) {
      duration = distanceToNext;
    }
    duration = Math.max(
      MIN_CUE_DURATION_MS,
      Math.min(duration, MAX_CUE_DURATION_MS),
    );

    return {
      ...cue,
      dDurationMs: duration,
    };
  });
}

/**
 * Monotonic nearest-timestamp subtitle alignment within `±maxDeltaMs`.
 * Each translated cue is consumed at most once.
 */
export function alignSubtitleTranslation(
  sourceEvents: readonly Pick<SubtitleCue, 'tStartMs'>[],
  translatedEvents: readonly Pick<SubtitleCue, 'tStartMs' | 'text'>[],
  maxDeltaMs: number = DEFAULT_ALIGNMENT_MAX_DELTA_MS,
): string[] {
  const safeDelta = Number.isFinite(maxDeltaMs) && maxDeltaMs >= 0 ? maxDeltaMs : DEFAULT_ALIGNMENT_MAX_DELTA_MS;
  let translatedIndex = 0;

  return sourceEvents.map((source) => {
    while (
      translatedIndex < translatedEvents.length &&
      translatedEvents[translatedIndex].tStartMs < source.tStartMs - safeDelta
    ) {
      translatedIndex += 1;
    }

    let bestIndex = -1;
    let bestDistance = safeDelta + 1;
    for (
      let index = translatedIndex;
      index < translatedEvents.length &&
      translatedEvents[index].tStartMs <= source.tStartMs + safeDelta;
      index += 1
    ) {
      const distance = Math.abs(translatedEvents[index].tStartMs - source.tStartMs);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) return '';
    translatedIndex = bestIndex + 1;
    return translatedEvents[bestIndex].text || '';
  });
}

/**
 * Applies aligned subtitle translations onto `sourceEvents` when the monotonic
 * match ratio meets `minMatchRatio` (defaults to `>= 0.6`).
 */
export function mergeAlignedSubtitleTrack(
  sourceEvents: readonly SubtitleCue[],
  translatedEvents: readonly SubtitleCue[],
  options: AlignedTrackMergeOptions = {},
): AlignedTrackMergeResult {
  const maxDeltaMs = options.maxDeltaMs ?? DEFAULT_ALIGNMENT_MAX_DELTA_MS;
  const minMatchRatio = options.minMatchRatio ?? MIN_ALIGNMENT_MATCH_RATIO;

  const nonEmptyTranslated = translatedEvents.filter((cue) => Boolean(cue.text?.trim()));
  if (sourceEvents.length === 0 || nonEmptyTranslated.length === 0) {
    return {
      applied: false,
      matchRatio: 0,
      cues: sourceEvents.map((cue) => ({ ...cue })),
    };
  }

  const aligned = alignSubtitleTranslation(sourceEvents, nonEmptyTranslated, maxDeltaMs);
  const matchedCount = aligned.filter(Boolean).length;
  const matchRatio = matchedCount / sourceEvents.length;

  if (matchRatio < minMatchRatio) {
    return {
      applied: false,
      matchRatio,
      cues: sourceEvents.map((cue) => ({ ...cue })),
    };
  }

  return {
    applied: true,
    matchRatio,
    cues: sourceEvents.map((cue, index) =>
      aligned[index] ? { ...cue, trans: aligned[index] } : { ...cue },
    ),
  };
}

const HTML_ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
};

export function decodeSubtitleEntities(raw: string): string {
  return String(raw ?? '').replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (full, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
      }
      if (entity.startsWith('#')) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
      }
      const mapped = HTML_ENTITY_MAP[entity.toLowerCase()];
      return mapped !== undefined ? mapped : full;
    },
  );
}

/**
 * Strips WebVTT / HTML inline cue markup (`<c.color>`, `<v Speaker>`, `<00:01.200>`, `<rt>...</rt>`)
 * and normalizes whitespace.
 */
export function stripVttMarkup(raw: string): string {
  const withoutRt = String(raw ?? '').replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '');
  const withoutTags = withoutRt.replace(/<[^>]+>/g, '');
  return decodeSubtitleEntities(withoutTags)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/[\t\f\v ]+/g, ' ')
    .trim();
}

/**
 * Parses a WebVTT / SRT timestamp (`HH:MM:SS.mmm`, `MM:SS.mmm`, or `,mmm`) into milliseconds.
 */
export function parseWebVttTimestamp(raw: string): number | null {
  const trimmed = String(raw ?? '').trim();
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(trimmed);
  if (!match) return null;

  const hours = match[1] !== undefined ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millisStr = match[4].padEnd(3, '0');
  const millis = Number(millisStr);

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(millis) ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return null;
  }

  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + millis;
}

/**
 * Clean WebVTT / SRT cue parser for generic HTML5 `<video><track>` captions.
 */
export function parseWebVtt(vttContent: string): SubtitleCue[] {
  const normalized = String(vttContent ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n{2,}/);
  const rawCues: Array<{ tStartMs: number; dDurationMs: number; text: string; order: number }> = [];

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx += 1) {
    const lines = blocks[blockIdx]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) continue;

    const header = lines[0];
    if (
      /^WEBVTT(?:\s|$)/i.test(header) ||
      /^NOTE(?:\s|$)/i.test(header) ||
      /^STYLE(?:\s|$)/i.test(header) ||
      /^REGION(?:\s|$)/i.test(header)
    ) {
      continue;
    }

    let timingLineIndex = -1;
    for (let i = 0; i < Math.min(lines.length, 2); i += 1) {
      if (lines[i].includes('-->')) {
        timingLineIndex = i;
        break;
      }
    }
    if (timingLineIndex < 0) continue;

    const timingParts = lines[timingLineIndex].split('-->');
    if (timingParts.length < 2) continue;

    const startMs = parseWebVttTimestamp(timingParts[0].trim());
    const endToken = timingParts[1].trim().split(/\s+/)[0] ?? '';
    const endMs = parseWebVttTimestamp(endToken);
    if (startMs === null || startMs < 0) continue;

    const textPayload = lines.slice(timingLineIndex + 1).join(' ');
    const text = stripVttMarkup(textPayload);
    if (!text) continue;

    const rawDuration = endMs !== null && endMs > startMs ? endMs - startMs : 0;
    rawCues.push({
      tStartMs: startMs,
      dDurationMs: rawDuration,
      text,
      order: blockIdx,
    });
  }

  return normalizeParsedGenericCues(rawCues);
}

/**
 * Converts browser `TextTrackCueList` / `VTTCue[]` objects into normalized `SubtitleCue[]`.
 */
export function extractTextTrackCues(
  cues: ArrayLike<TextTrackCueLike> | null | undefined,
): SubtitleCue[] {
  if (!cues || typeof cues.length !== 'number') return [];
  const rawCues: Array<{ tStartMs: number; dDurationMs: number; text: string; order: number }> = [];

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (!cue) continue;
    const startSec = Number(cue.startTime);
    if (!Number.isFinite(startSec) || startSec < 0) continue;

    const text = stripVttMarkup(cue.text ?? '');
    if (!text) continue;

    const startMs = Math.round(startSec * 1000);
    const endSec = Number(cue.endTime);
    const durationMs =
      Number.isFinite(endSec) && endSec > startSec
        ? Math.round((endSec - startSec) * 1000)
        : 0;

    rawCues.push({
      tStartMs: startMs,
      dDurationMs: durationMs,
      text,
      order: i,
    });
  }

  return normalizeParsedGenericCues(rawCues);
}

function normalizeParsedGenericCues(
  rawCues: Array<{ tStartMs: number; dDurationMs: number; text: string; order: number }>,
): SubtitleCue[] {
  rawCues.sort((a, b) => a.tStartMs - b.tStartMs || a.order - b.order);

  const deduplicated: SubtitleCue[] = [];
  for (const item of rawCues) {
    const prev = deduplicated[deduplicated.length - 1];
    if (prev && prev.tStartMs === item.tStartMs && prev.text === item.text) {
      prev.dDurationMs = Math.max(prev.dDurationMs, item.dDurationMs);
      continue;
    }
    deduplicated.push({
      tStartMs: item.tStartMs,
      dDurationMs: item.dDurationMs,
      text: item.text,
    });
  }

  return finalizeCueDurations(deduplicated);
}

/**
 * Parses YouTube `/api/timedtext` payloads across JSON3 (`events`), SRV3 XML (`<p t d>`),
 * legacy TimedText XML (`<text start dur>`), and WebVTT formats into `YoutubeRawJson3Event[]`.
 */
export function parseYoutubeTimedTextPayload(rawBody: string): YoutubeRawJson3Event[] {
  const trimmed = String(rawBody ?? '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { events?: unknown };
      if (Array.isArray(parsed?.events)) {
        return parsed.events as YoutubeRawJson3Event[];
      }
    } catch {
      return [];
    }
  }

  if (/^WEBVTT(?:\s|$)/i.test(trimmed)) {
    return parseWebVtt(trimmed).map((cue) => ({
      tStartMs: cue.tStartMs,
      dDurationMs: cue.dDurationMs,
      text: cue.text,
    }));
  }

  if (trimmed.startsWith('<')) {
    const events: YoutubeRawJson3Event[] = [];

    // SRV3 `<p t="1200" d="3400">...</p>`
    const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = pRegex.exec(trimmed)) !== null) {
      const attrs = pMatch[1];
      const inner = pMatch[2];
      const tMatch = /\bt="(\d+)"/i.exec(attrs);
      if (!tMatch) continue;
      const dMatch = /\bd="(\d+)"/i.exec(attrs);
      const wMatch = /\bw="(\d+)"/i.exec(attrs);
      const aMatch = /\ba="(\d+)"/i.exec(attrs);
      const text = decodeSubtitleEntities(inner.replace(/<[^>]+>/g, ''));
      events.push({
        tStartMs: Number(tMatch[1]),
        dDurationMs: dMatch ? Number(dMatch[1]) : 0,
        wWinId: wMatch ? Number(wMatch[1]) : undefined,
        aAppend: aMatch ? Number(aMatch[1]) : undefined,
        text,
      });
    }
    if (events.length > 0) return events;

    // Legacy `<text start="1.25" dur="2.5">...</text>`
    const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let tNodeMatch: RegExpExecArray | null;
    while ((tNodeMatch = textRegex.exec(trimmed)) !== null) {
      const attrs = tNodeMatch[1];
      const inner = tNodeMatch[2];
      const startMatch = /\bstart="([\d.]+)"/i.exec(attrs);
      if (!startMatch) continue;
      const durMatch = /\bdur="([\d.]+)"/i.exec(attrs);
      const text = decodeSubtitleEntities(inner.replace(/<[^>]+>/g, ''));
      events.push({
        tStartMs: Math.round(Number(startMatch[1]) * 1000),
        dDurationMs: durMatch ? Math.round(Number(durMatch[1]) * 1000) : 0,
        text,
      });
    }
    return events;
  }

  return [];
}

/**
 * Binary-searches sorted `cues` for the active cue covering `currentTimeMs`.
 */
export function findActiveCueIndex(
  cues: readonly SubtitleCue[],
  currentTimeMs: number,
): number {
  if (cues.length === 0 || !Number.isFinite(currentTimeMs) || currentTimeMs < 0) {
    return -1;
  }

  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (cues[mid].tStartMs <= currentTimeMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Walk backward slightly in case two cues share adjacent/identical start boundaries
  for (let i = candidate; i >= 0 && i >= candidate - 2; i -= 1) {
    const cue = cues[i];
    if (currentTimeMs >= cue.tStartMs && currentTimeMs < cue.tStartMs + cue.dDurationMs) {
      return i;
    }
  }

  return -1;
}
