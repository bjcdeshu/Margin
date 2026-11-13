import { BRAND } from '@shared/brand';
import type {
  MarginActiveCueState,
  SubtitleCue,
  SubtitleStylePreset,
  SubtitleTranslationTint,
  YoutubeMainBridgeMessage,
  YoutubeNativeCaptionTheme,
} from '@shared/types';

export const PIP_BUTTON_ID = `${BRAND.cssPrefix}-youtube-pip-button`;
export const SUBTITLE_TOGGLE_BUTTON_ID = `${BRAND.cssPrefix}-youtube-subtitle-button`;
export const PIP_NOTICE_HOST_ID = `${BRAND.cssPrefix}-youtube-pip-notice-host`;
export const YOUTUBE_CONTROLS_STYLE_ID = `${BRAND.cssPrefix}-youtube-controls-css`;
export const YOUTUBE_CAPTION_STORAGE_KEY = 'yt-player-caption-display-settings';
export const PIP_CLEAR_DELAY_MS = 120;
export const PIP_NOTICE_DURATION_MS = 4_200;

const CJK_FONT_FALLBACK =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';

export const DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME: YoutubeNativeCaptionTheme = {
  textColorCss: 'rgba(255, 255, 255, 1)',
  bgColorCss: 'rgba(8, 8, 8, 0.75)',
  windowBgCss: 'rgba(8, 8, 8, 0)',
  textShadowCss: 'none',
  fontFamilyCss: `"YouTube Noto", Roboto, Arial, ${CJK_FONT_FALLBACK}`,
  fontVariantCss: 'normal',
  fontScaleMultiplier: 1,
};

export interface YoutubeDomSegmentStyle {
  color?: string;
  backgroundColor?: string;
  windowBackgroundColor?: string;
  textShadow?: string;
  fontFamily?: string;
  fontVariant?: string;
}

export type YoutubeExtendedBridgeMessage =
  | YoutubeMainBridgeMessage
  | {
      source: typeof BRAND.ytBridgeSourceMain;
      type: 'subtitle-toggle-request';
      enabled: boolean;
    }
  | {
      source: typeof BRAND.ytBridgeSourceMain;
      type: 'native-caption-style-update';
      theme: YoutubeNativeCaptionTheme;
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

export function normalizeSubtitleStylePreset(
  value: unknown,
): SubtitleStylePreset {
  if (value === 'cinema-outline' || value === 'warm-paper') {
    return value;
  }
  return 'youtube-native';
}

export function normalizeBgOpacityOverride(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function normalizeTranslationTint(value: unknown): SubtitleTranslationTint {
  if (value === 'warm-ivory' || value === 'amber' || value === 'cyan') {
    return value;
  }
  return 'follow';
}

const YOUTUBE_NAMED_COLORS: Readonly<Record<string, [number, number, number]>> = {
  white: [255, 255, 255],
  yellow: [255, 255, 0],
  green: [0, 255, 0],
  cyan: [0, 255, 255],
  blue: [0, 0, 255],
  magenta: [255, 0, 255],
  red: [255, 0, 0],
  black: [8, 8, 8],
};

function parseYoutubeColorToRgba(
  rawColor: unknown,
  fallbackRgb: [number, number, number],
): { rgb: [number, number, number]; embeddedAlpha: number | null } {
  if (typeof rawColor !== 'string') {
    return { rgb: fallbackRgb, embeddedAlpha: null };
  }
  const trimmed = rawColor.trim().toLowerCase();
  if (!trimmed) {
    return { rgb: fallbackRgb, embeddedAlpha: null };
  }

  const named = YOUTUBE_NAMED_COLORS[trimmed];
  if (named) {
    return { rgb: named, embeddedAlpha: null };
  }

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : null;
      if ([r, g, b].every(Number.isFinite)) {
        return { rgb: [r, g, b], embeddedAlpha: a };
      }
    } else if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a =
        hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : null;
      if ([r, g, b].every(Number.isFinite)) {
        return { rgb: [r, g, b], embeddedAlpha: a };
      }
    }
  }

  const rgbaMatch =
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/.exec(
      trimmed,
    );
  if (rgbaMatch) {
    const r = Math.min(255, Math.max(0, Math.round(Number(rgbaMatch[1]))));
    const g = Math.min(255, Math.max(0, Math.round(Number(rgbaMatch[2]))));
    const b = Math.min(255, Math.max(0, Math.round(Number(rgbaMatch[3]))));
    let alpha: number | null = null;
    if (rgbaMatch[4] !== undefined) {
      const rawA = rgbaMatch[4];
      const parsedA = rawA.endsWith('%')
        ? Number(rawA.slice(0, -1)) / 100
        : Number(rawA);
      if (Number.isFinite(parsedA)) {
        alpha = Math.min(1, Math.max(0, parsedA));
      }
    }
    if ([r, g, b].every(Number.isFinite)) {
      return { rgb: [r, g, b], embeddedAlpha: alpha };
    }
  }

  return { rgb: fallbackRgb, embeddedAlpha: null };
}

function normalizeYoutubeOpacity(raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) {
    return Math.min(1, Math.max(0, n / 100));
  }
  return n;
}

function formatRgbaCss(rgb: [number, number, number], alpha: number): string {
  const safeAlpha = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${safeAlpha})`;
}

function resolveYoutubeCharEdgeShadow(
  edgeRaw: unknown,
  effectiveBgAlpha: number,
): string {
  const key =
    typeof edgeRaw === 'number'
      ? String(edgeRaw)
      : typeof edgeRaw === 'string'
        ? edgeRaw.trim().toLowerCase().replace(/[\s_-]+/g, '')
        : '0';

  if (key === '1' || key === 'dropshadow') {
    return '2px 2px 3px rgba(34, 34, 34, 0.92), 0 1px 4px rgba(0, 0, 0, 0.85)';
  }
  if (key === '2' || key === 'raised') {
    return '-1px -1px 0 #222222, 1px 1px 2px rgba(0, 0, 0, 0.92)';
  }
  if (key === '3' || key === 'depressed') {
    return '1px 1px 0 rgba(204, 204, 204, 0.88), -1px -1px 1px #111111';
  }
  if (key === '4' || key === 'uniform' || key === 'outline') {
    return '-1.2px -1.2px 0 rgba(0, 0, 0, 0.94), 1.2px -1.2px 0 rgba(0, 0, 0, 0.94), -1.2px 1.2px 0 rgba(0, 0, 0, 0.94), 1.2px 1.2px 0 rgba(0, 0, 0, 0.94), 0 1px 3px rgba(0, 0, 0, 0.85)';
  }

  // When background strip is transparent (`< 12%`) and no edge was chosen, apply subtle readability shadow
  if (effectiveBgAlpha < 0.12) {
    return '0 1px 3px rgba(0, 0, 0, 0.9), 0 0 5px rgba(0, 0, 0, 0.78)';
  }
  return 'none';
}

function resolveYoutubeFontFamily(fontFamilyRaw: unknown): {
  fontFamilyCss: string;
  fontVariantCss: string;
} {
  const code = Number(fontFamilyRaw);
  switch (code) {
    case 1:
      return {
        fontFamilyCss: `"Courier New", Courier, "Nimbus Mono L", monospace, ${CJK_FONT_FALLBACK}`,
        fontVariantCss: 'normal',
      };
    case 2:
      return {
        fontFamilyCss: `"Times New Roman", Times, Georgia, serif, ${CJK_FONT_FALLBACK}`,
        fontVariantCss: 'normal',
      };
    case 3:
      return {
        fontFamilyCss: `"DejaVu Sans Mono", "Lucida Console", Monaco, Consolas, monospace, ${CJK_FONT_FALLBACK}`,
        fontVariantCss: 'normal',
      };
    case 5:
      return {
        fontFamilyCss: `"Comic Sans MS", Impact, fantasy, ${CJK_FONT_FALLBACK}`,
        fontVariantCss: 'normal',
      };
    case 6:
      return {
        fontFamilyCss: `"Monotype Corsiva", "URW Chancery L", "Apple Chancery", cursive, ${CJK_FONT_FALLBACK}`,
        fontVariantCss: 'normal',
      };
    case 7:
      return {
        fontFamilyCss: `Arial, Helvetica, Verdana, ${CJK_FONT_FALLBACK}`,
        fontVariantCss: 'small-caps',
      };
    default:
      return {
        fontFamilyCss: DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME.fontFamilyCss,
        fontVariantCss: 'normal',
      };
  }
}

function resolveYoutubeFontScaleMultiplier(incrementRaw: unknown): number {
  if (incrementRaw === null || incrementRaw === undefined || incrementRaw === '') {
    return 1;
  }
  const inc = Number(incrementRaw);
  if (!Number.isFinite(inc)) return 1;
  const exactSteps: Readonly<Record<string, number>> = {
    '-2': 0.5,
    '-1': 0.75,
    '0': 1,
    '1': 1.5,
    '2': 2,
    '3': 2.25,
    '4': 2.5,
  };
  const key = String(Math.round(inc * 100) / 100);
  if (exactSteps[key] !== undefined) {
    return exactSteps[key];
  }
  return Math.round(Math.min(2.5, Math.max(0.5, Math.pow(2, inc / 2))) * 1000) / 1000;
}

function unwrapYoutubeCaptionSettingsRecord(
  raw: unknown,
): Record<string, unknown> | null {
  if (!raw) return null;
  let candidate: unknown = raw;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const obj = candidate as Record<string, unknown>;
  if ('data' in obj && obj.data !== undefined && obj.data !== null) {
    const unwrapped = unwrapYoutubeCaptionSettingsRecord(obj.data);
    if (unwrapped) return unwrapped;
  }
  return obj;
}

/**
 * Parses YouTube's native `⚙ -> Subtitles/CC -> Options` display settings from either
 * `moviePlayer.getSubtitlesUserSettings()`, `localStorage['yt-player-caption-display-settings']`,
 * or live `.ytp-caption-segment` / `.caption-window` inline styles.
 */
export function parseYoutubeNativeCaptionSettings(
  rawSettingsOrStorage: unknown,
  fallbackDomStyle?: Partial<YoutubeDomSegmentStyle> | null,
): YoutubeNativeCaptionTheme {
  const record = unwrapYoutubeCaptionSettingsRecord(rawSettingsOrStorage);

  if (record && Object.keys(record).length > 0) {
    const parsedFg = parseYoutubeColorToRgba(record.color, [255, 255, 255]);
    const fgAlpha = normalizeYoutubeOpacity(
      record.textOpacity,
      parsedFg.embeddedAlpha ?? 1,
    );

    const parsedBg = parseYoutubeColorToRgba(record.background, [8, 8, 8]);
    const bgAlpha = normalizeYoutubeOpacity(
      record.backgroundOpacity,
      parsedBg.embeddedAlpha ?? 0.75,
    );

    const parsedWin = parseYoutubeColorToRgba(record.windowColor, [8, 8, 8]);
    const winAlpha = normalizeYoutubeOpacity(
      record.windowOpacity,
      parsedWin.embeddedAlpha ?? 0,
    );

    const textShadowCss = resolveYoutubeCharEdgeShadow(
      record.charEdgeStyle,
      bgAlpha,
    );
    const { fontFamilyCss, fontVariantCss } = resolveYoutubeFontFamily(
      record.fontFamily,
    );
    const fontScaleMultiplier = resolveYoutubeFontScaleMultiplier(
      record.fontSizeIncrement,
    );

    return {
      textColorCss: formatRgbaCss(parsedFg.rgb, fgAlpha),
      bgColorCss: formatRgbaCss(parsedBg.rgb, bgAlpha),
      windowBgCss: formatRgbaCss(parsedWin.rgb, winAlpha),
      textShadowCss,
      fontFamilyCss,
      fontVariantCss,
      fontScaleMultiplier,
    };
  }

  if (fallbackDomStyle) {
    const hasDomValues = Boolean(
      fallbackDomStyle.color ||
        fallbackDomStyle.backgroundColor ||
        fallbackDomStyle.windowBackgroundColor ||
        fallbackDomStyle.textShadow ||
        fallbackDomStyle.fontFamily,
    );
    if (hasDomValues) {
      const parsedFg = parseYoutubeColorToRgba(
        fallbackDomStyle.color,
        [255, 255, 255],
      );
      const parsedBg = parseYoutubeColorToRgba(
        fallbackDomStyle.backgroundColor,
        [8, 8, 8],
      );
      const parsedWin = parseYoutubeColorToRgba(
        fallbackDomStyle.windowBackgroundColor,
        [8, 8, 8],
      );
      const bgAlpha = parsedBg.embeddedAlpha ?? 0.75;
      const shadow =
        fallbackDomStyle.textShadow && fallbackDomStyle.textShadow !== 'none'
          ? fallbackDomStyle.textShadow
          : bgAlpha < 0.12
            ? '0 1px 3px rgba(0, 0, 0, 0.9), 0 0 5px rgba(0, 0, 0, 0.78)'
            : 'none';
      return {
        textColorCss: formatRgbaCss(parsedFg.rgb, parsedFg.embeddedAlpha ?? 1),
        bgColorCss: formatRgbaCss(parsedBg.rgb, bgAlpha),
        windowBgCss: formatRgbaCss(parsedWin.rgb, parsedWin.embeddedAlpha ?? 0),
        textShadowCss: shadow,
        fontFamilyCss: fallbackDomStyle.fontFamily
          ? `${fallbackDomStyle.fontFamily}, ${CJK_FONT_FALLBACK}`
          : DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME.fontFamilyCss,
        fontVariantCss: fallbackDomStyle.fontVariant || 'normal',
        fontScaleMultiplier: 1,
      };
    }
  }

  return { ...DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME };
}

export function normalizeYoutubeNativeCaptionTheme(
  theme?: Partial<YoutubeNativeCaptionTheme> | null,
): YoutubeNativeCaptionTheme {
  if (!theme || typeof theme !== 'object') {
    return { ...DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME };
  }
  const mult = Number(theme.fontScaleMultiplier);
  return {
    textColorCss:
      typeof theme.textColorCss === 'string' && theme.textColorCss
        ? theme.textColorCss
        : DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME.textColorCss,
    bgColorCss:
      typeof theme.bgColorCss === 'string' && theme.bgColorCss
        ? theme.bgColorCss
        : DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME.bgColorCss,
    windowBgCss:
      typeof theme.windowBgCss === 'string' && theme.windowBgCss
        ? theme.windowBgCss
        : DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME.windowBgCss,
    textShadowCss:
      typeof theme.textShadowCss === 'string' && theme.textShadowCss
        ? theme.textShadowCss
        : DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME.textShadowCss,
    fontFamilyCss:
      typeof theme.fontFamilyCss === 'string' && theme.fontFamilyCss
        ? theme.fontFamilyCss
        : DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME.fontFamilyCss,
    fontVariantCss:
      typeof theme.fontVariantCss === 'string' && theme.fontVariantCss
        ? theme.fontVariantCss
        : DEFAULT_YOUTUBE_NATIVE_CAPTION_THEME.fontVariantCss,
    fontScaleMultiplier:
      Number.isFinite(mult) && mult > 0
        ? Math.min(2.5, Math.max(0.5, mult))
        : 1,
  };
}

export function areYoutubeNativeThemesEqual(
  a?: YoutubeNativeCaptionTheme | null,
  b?: YoutubeNativeCaptionTheme | null,
): boolean {
  const left = normalizeYoutubeNativeCaptionTheme(a);
  const right = normalizeYoutubeNativeCaptionTheme(b);
  return (
    left.textColorCss === right.textColorCss &&
    left.bgColorCss === right.bgColorCss &&
    left.windowBgCss === right.windowBgCss &&
    left.textShadowCss === right.textShadowCss &&
    left.fontFamilyCss === right.fontFamilyCss &&
    left.fontVariantCss === right.fontVariantCss &&
    left.fontScaleMultiplier === right.fontScaleMultiplier
  );
}

export function resolveTranslationTintColorCss(
  tint: SubtitleTranslationTint | undefined,
  fallbackFgCss: string,
): string {
  switch (tint) {
    case 'warm-ivory':
      return 'rgba(247, 239, 222, 0.96)';
    case 'amber':
      return 'rgba(255, 217, 125, 0.98)';
    case 'cyan':
      return 'rgba(158, 236, 255, 0.96)';
    case 'follow':
    default:
      return fallbackFgCss;
  }
}

export function resolveEffectiveNativeThemeVariables(
  theme?: YoutubeNativeCaptionTheme | null,
  overrides?: {
    bgOpacityPercent?: number | null;
    translationTint?: SubtitleTranslationTint;
  },
): {
  fgCss: string;
  transFgCss: string;
  bgCss: string;
  winBgCss: string;
  shadowCss: string;
  fontCss: string;
  variantCss: string;
  scaleMult: number;
} {
  const base = normalizeYoutubeNativeCaptionTheme(theme);
  const bgOverride = normalizeBgOpacityOverride(overrides?.bgOpacityPercent);
  let bgCss = base.bgColorCss;
  let shadowCss = base.textShadowCss;

  if (bgOverride !== null) {
    const parsedBg = parseYoutubeColorToRgba(base.bgColorCss, [8, 8, 8]);
    const alpha = bgOverride / 100;
    bgCss = formatRgbaCss(parsedBg.rgb, alpha);
    if (alpha < 0.12 && shadowCss === 'none') {
      shadowCss = '0 1px 3px rgba(0, 0, 0, 0.9), 0 0 5px rgba(0, 0, 0, 0.78)';
    }
  }

  const fgCss = base.textColorCss;
  const transFgCss = resolveTranslationTintColorCss(
    normalizeTranslationTint(overrides?.translationTint),
    fgCss,
  );

  return {
    fgCss,
    transFgCss,
    bgCss,
    winBgCss: base.windowBgCss,
    shadowCss,
    fontCss: base.fontFamilyCss,
    variantCss: base.fontVariantCss,
    scaleMult: base.fontScaleMultiplier,
  };
}

export function applyNativeThemeVariablesToElement(
  el: HTMLElement,
  cue: Pick<
    MarginActiveCueState,
    'nativeTheme' | 'bgOpacityPercent' | 'translationTint'
  >,
): void {
  const vars = resolveEffectiveNativeThemeVariables(cue.nativeTheme, {
    bgOpacityPercent: cue.bgOpacityPercent,
    translationTint: cue.translationTint,
  });
  el.style.setProperty('--margin-yt-fg', vars.fgCss);
  el.style.setProperty('--margin-yt-trans-fg', vars.transFgCss);
  el.style.setProperty('--margin-yt-bg', vars.bgCss);
  el.style.setProperty('--margin-yt-win-bg', vars.winBgCss);
  el.style.setProperty('--margin-yt-shadow', vars.shadowCss);
  el.style.setProperty('--margin-yt-font', vars.fontCss);
  el.style.setProperty('--margin-yt-variant', vars.variantCss);
  el.style.setProperty('--margin-yt-scale-mult', vars.scaleMult.toFixed(3));
}

export function readDomCaptionSegmentFallbackStyle(
  doc: Document,
): Partial<YoutubeDomSegmentStyle> | null {
  const seg = doc.querySelector<HTMLElement>(
    '#movie_player .ytp-caption-segment, .html5-video-player .ytp-caption-segment',
  );
  const winEl = doc.querySelector<HTMLElement>(
    '#movie_player .caption-window, .html5-video-player .caption-window',
  );
  if (!seg && !winEl) return null;
  return {
    color: seg?.style.color || undefined,
    backgroundColor: seg?.style.backgroundColor || seg?.style.background || undefined,
    windowBackgroundColor:
      winEl?.style.backgroundColor || winEl?.style.background || undefined,
    textShadow: seg?.style.textShadow || undefined,
    fontFamily: seg?.style.fontFamily || undefined,
    fontVariant: seg?.style.fontVariant || undefined,
  };
}

export function readLocalYoutubeCaptionTheme(
  win: Window,
  doc: Document,
  livePlayerSettings?: unknown,
): YoutubeNativeCaptionTheme {
  let raw: unknown = livePlayerSettings;
  if (!raw || (typeof raw === 'object' && Object.keys(raw as object).length === 0)) {
    try {
      raw = win.localStorage?.getItem(YOUTUBE_CAPTION_STORAGE_KEY) ?? null;
    } catch {
      raw = null;
    }
  }
  return parseYoutubeNativeCaptionSettings(
    raw,
    readDomCaptionSegmentFallbackStyle(doc),
  );
}

export function resolveEffectiveTranslationScale(settings: {
  translationScalePercent?: number;
  fontSizePercent?: number;
}): number {
  if (
    typeof settings.translationScalePercent === 'number' &&
    typeof settings.fontSizePercent === 'number' &&
    settings.translationScalePercent === 70 &&
    settings.fontSizePercent !== 70
  ) {
    return clampFontSizePercent(settings.fontSizePercent, 70);
  }
  return clampFontSizePercent(
    settings.translationScalePercent ?? settings.fontSizePercent,
    70,
  );
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

  const sourceScalePercent = clampFontSizePercent(
    input?.sourceScalePercent,
    100,
  );
  const translationScalePercent =
    input?.translationScalePercent !== undefined
      ? clampFontSizePercent(input.translationScalePercent, 70)
      : clampFontSizePercent(input?.fontSizePercent, 70);
  const fontSizePercent =
    input?.fontSizePercent !== undefined
      ? clampFontSizePercent(input.fontSizePercent, translationScalePercent)
      : translationScalePercent;
  const stylePreset = normalizeSubtitleStylePreset(input?.stylePreset);
  const bgOpacityPercent = normalizeBgOpacityOverride(input?.bgOpacityPercent);
  const translationTint = normalizeTranslationTint(input?.translationTint);
  const nativeTheme = input?.nativeTheme
    ? normalizeYoutubeNativeCaptionTheme(input.nativeTheme)
    : undefined;

  return {
    original,
    translated,
    startMs,
    endMs,
    mode,
    fontSizePercent,
    sourceScalePercent,
    translationScalePercent,
    stylePreset,
    bgOpacityPercent,
    translationTint,
    ...(nativeTheme ? { nativeTheme } : {}),
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
