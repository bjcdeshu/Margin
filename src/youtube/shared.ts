import { BRAND } from '@shared/brand';
import type {
  MarginActiveCueState,
  SubtitleCue,
  YoutubeMainBridgeMessage,
} from '@shared/types';

export const PIP_BUTTON_ID = `${BRAND.cssPrefix}-youtube-pip-button`;
export const SUBTITLE_TOGGLE_BUTTON_ID = `${BRAND.cssPrefix}-youtube-subtitle-button`;
export const PIP_NOTICE_HOST_ID = `${BRAND.cssPrefix}-youtube-pip-notice-host`;
export const PIP_CLEAR_DELAY_MS = 120;
export const PIP_NOTICE_DURATION_MS = 4_200;

export type YoutubeExtendedBridgeMessage =
  | YoutubeMainBridgeMessage
  | {
      source: typeof BRAND.ytBridgeSourceMain;
      type: 'subtitle-toggle-request';
      enabled: boolean;
    };

export function extractYoutubeVideoId(urlLike: string): string {
  if (!urlLike) return '';
  try {
    const parsed = new URL(urlLike, 'https://www.youtube.com');
    const vParam = parsed.searchParams.get('v');
    if (vParam) return vParam;

    const pathMatch = /^\/(?:live|shorts|embed)\/([A-Za-z0-9_-]{6,})/.exec(
      parsed.pathname,
    );
    if (pathMatch?.[1]) return pathMatch[1];
  } catch {
    // Ignore malformed URLs
  }
  return '';
}

export function isTimedTextUrl(urlLike: string): boolean {
  if (!urlLike) return false;
  try {
    const parsed = new URL(urlLike, 'https://www.youtube.com');
    return (
      parsed.pathname.includes('/api/timedtext') ||
      parsed.pathname.endsWith('/timedtext')
    );
  } catch {
    return urlLike.includes('/api/timedtext');
  }
}

export function buildSourceTrackFingerprint(
  videoId: string,
  langCode: string,
  cues: readonly SubtitleCue[],
): string {
  const firstStart = cues[0]?.tStartMs ?? 0;
  const lastStart = cues[cues.length - 1]?.tStartMs ?? 0;
  return `${videoId}::${langCode || 'auto'}::${cues.length}::${firstStart}::${lastStart}`;
}

/**
 * Cleans subtitle cue text while preserving intentional internal line breaks.
 */
export function cleanPipCueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function toFiniteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function clampFontSizePercent(value: unknown, fallback = 70): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(160, Math.max(40, Math.round(num)));
}

/**
 * Normalizes `MarginActiveCueState` and suppresses duplicate `translated === original`.
 */
export function normalizeActiveCueState(
  input?: Partial<MarginActiveCueState> | null,
): MarginActiveCueState {
  const original = cleanPipCueText(input?.original);
  let translated = cleanPipCueText(input?.translated);

  if (translated && translated === original) {
    translated = '';
  }

  const startMs = toFiniteOrNull(input?.startMs);
  const rawEndMs = toFiniteOrNull(input?.endMs);
  const endMs =
    rawEndMs !== null && startMs !== null && rawEndMs > startMs ? rawEndMs : null;

  const mode: MarginActiveCueState['mode'] =
    input?.mode === 'target-only' || input?.mode === 'source-only'
      ? input.mode
      : 'bilingual';

  const position: MarginActiveCueState['position'] =
    input?.position === 'top' ? 'top' : 'bottom';

  const fontSizePercent = clampFontSizePercent(input?.fontSizePercent, 70);

  return {
    original,
    translated,
    startMs,
    endMs,
    mode,
    fontSizePercent,
    position,
  };
}

/**
 * Resolves visible original/translated lines for the active display mode.
 */
export function resolveRenderedCueLines(cue: MarginActiveCueState): {
  originalLine: string;
  translatedLine: string;
} {
  if (cue.mode === 'source-only') {
    return { originalLine: cue.original, translatedLine: '' };
  }
  if (cue.mode === 'target-only') {
    return { originalLine: '', translatedLine: cue.translated };
  }
  return {
    originalLine: cue.original,
    translatedLine: cue.translated,
  };
}

/**
 * Computes proportional PiP dimensions clamped to `[320, 720]` width (and `[240, 720]` height)
 * preserving video aspect ratio (`0.6..3.0`, fallback `16:9`).
 */
export function computePipDimensions(
  videoWidth: number,
  videoHeight: number,
  preferredWidth = 560,
): { width: number; height: number } {
  const width = Math.min(
    720,
    Math.max(320, Math.round(Number(preferredWidth) || 560)),
  );
  const rawW = Number(videoWidth);
  const rawH = Number(videoHeight);
  const ratio = rawW > 0 && rawH > 0 ? rawW / rawH : 16 / 9;
  const safeRatio = Math.min(3, Math.max(0.6, ratio));
  const height = Math.min(720, Math.max(240, Math.round(width / safeRatio)));
  return { width, height };
}

/**
 * Clamps video seek target within `[0, duration]`.
 */
export function clampSeekTime(
  currentTime: number,
  deltaSeconds: number,
  duration: number,
): number {
  const current = toFiniteOrNull(currentTime) ?? 0;
  const delta = toFiniteOrNull(deltaSeconds) ?? 0;
  const next = current + delta;
  if (Number.isFinite(duration) && duration >= 0) {
    return Math.min(duration, Math.max(0, next));
  }
  return Math.max(0, next);
}
