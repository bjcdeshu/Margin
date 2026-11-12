import type {
  AutoTranslateMode,
  UrlPatternConfig,
  WebpageSettings,
} from './types';
import { isUrlExcluded, matchesAnyUrlGlob } from './url-match';

export type LanguageConfidence = 'high' | 'medium' | 'low';

export interface DetectPageLanguageParams {
  htmlLang?: string;
  sampleText: string;
  targetLang: string;
}

export interface PageLanguageDetectionResult {
  isForeignToTarget: boolean;
  detectedLang: string;
  confidence: LanguageConfidence;
  reason: string;
}

export type AutoTranslateDecisionReason =
  | 'manual-session-off'
  | 'unsupported-scheme'
  | 'excluded-url'
  | 'whitelist-match'
  | 'mode-disabled'
  | 'awaiting-content'
  | 'same-language'
  | 'language-filtered'
  | 'foreign-page';

export interface EvaluateAutoTranslateParams {
  url: string;
  targetLang: string;
  webpage: WebpageSettings;
  urlRules: UrlPatternConfig;
  htmlLang?: string;
  sampleText: string;
  manuallyDisabledInSession?: boolean;
}

export interface AutoTranslateDecision {
  shouldTranslate: boolean;
  needsHydrationRecheck: boolean;
  detectedLang?: string;
  confidence?: LanguageConfidence;
  reason: AutoTranslateDecisionReason;
}

const MAX_SAMPLE_CHARS = 16_000;
const MIN_MEANINGFUL_CHARS = 24;

const NOISE_TOKEN_RE =
  /(?:https?:\/\/\S+|\bwww\.\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|@[A-Za-z0-9_.-]+|#[\p{L}\p{N}_-]+)/gu;

const LATIN_LANG_PREFIXES = new Set([
  'en',
  'fr',
  'de',
  'es',
  'pt',
  'it',
  'nl',
  'pl',
  'sv',
  'da',
  'no',
  'nb',
  'nn',
  'fi',
  'cs',
  'sk',
  'hu',
  'ro',
  'tr',
  'vi',
  'id',
  'ms',
  'tl',
  'ca',
  'eu',
  'gl',
  'hr',
  'sl',
  'et',
  'lv',
  'lt',
  'is',
  'ga',
  'cy',
  'af',
  'sw',
  'eo',
  'la',
]);

const CYRILLIC_LANG_PREFIXES = new Set([
  'ru',
  'uk',
  'bg',
  'sr',
  'be',
  'kk',
  'mn',
  'mk',
  'ky',
]);

const ARABIC_LANG_PREFIXES = new Set(['ar', 'fa', 'ur', 'ps']);
const DEVANAGARI_LANG_PREFIXES = new Set(['hi', 'mr', 'ne', 'sa']);

function normalizeLangTag(raw?: string): { full: string; primary: string } {
  const cleaned = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (!cleaned) {
    return { full: '', primary: '' };
  }
  const parts = cleaned.split('-').filter(Boolean);
  const primary = parts[0] ?? '';
  if (primary === 'zh') {
    if (parts.includes('tw') || parts.includes('hant')) {
      return { full: 'zh-tw', primary: 'zh' };
    }
    if (parts.includes('hk') || parts.includes('mo')) {
      return { full: 'zh-hk', primary: 'zh' };
    }
    if (parts.includes('cn') || parts.includes('hans') || parts.includes('sg')) {
      return { full: 'zh-cn', primary: 'zh' };
    }
    return { full: 'zh', primary: 'zh' };
  }
  return { full: cleaned, primary };
}

function isHanCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2ceaf)
  );
}

function isJapaneseKanaCodePoint(cp: number): boolean {
  // Exclude 0x30FB (・ middle dot used in transliterated names in Chinese)
  return (
    (cp >= 0x3041 && cp <= 0x3096) ||
    (cp >= 0x309d && cp <= 0x309f) ||
    (cp >= 0x30a1 && cp <= 0x30fa) ||
    (cp >= 0x30fc && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xff66 && cp <= 0xff9f)
  );
}

function isHangulCodePoint(cp: number): boolean {
  return (
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3131 && cp <= 0x318e)
  );
}

function isCyrillicCodePoint(cp: number): boolean {
  return cp >= 0x0400 && cp <= 0x052f;
}

function isArabicCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

function isThaiCodePoint(cp: number): boolean {
  return cp >= 0x0e01 && cp <= 0x0e5b && !(cp >= 0x0e50 && cp <= 0x0e59);
}

function isGreekCodePoint(cp: number): boolean {
  return (cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x1f00 && cp <= 0x1fff);
}

function isHebrewCodePoint(cp: number): boolean {
  return cp >= 0x0590 && cp <= 0x05ff;
}

function isDevanagariCodePoint(cp: number): boolean {
  return cp >= 0x0900 && cp <= 0x097f && !(cp >= 0x0966 && cp <= 0x096f);
}

function isVietnameseDistinctCodePoint(cp: number): boolean {
  return (
    cp === 0x0102 ||
    cp === 0x0103 ||
    cp === 0x0110 ||
    cp === 0x0111 ||
    cp === 0x01a0 ||
    cp === 0x01a1 ||
    cp === 0x01af ||
    cp === 0x01b0 ||
    (cp >= 0x1ea0 && cp <= 0x1ef9)
  );
}

function isLatinLetterCodePoint(cp: number): boolean {
  return (
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0x00c0 && cp <= 0x024f && cp !== 0x00d7 && cp !== 0x00f7) ||
    (cp >= 0x1e00 && cp <= 0x1eff)
  );
}

function isForeignLanguageToTarget(detectedLang: string, targetLang: string): boolean {
  const det = normalizeLangTag(detectedLang);
  const tgt = normalizeLangTag(targetLang || 'zh-CN');
  if (!det.primary || det.primary === 'und') {
    return false;
  }
  if (tgt.primary === 'zh') {
    return det.primary !== 'zh';
  }
  return det.primary !== tgt.primary;
}

/**
 * Fast (< 1ms), pure, deterministic page language detector over a DOM text sample.
 * Handles real-world SPA quirks such as Chinese sites leaving `<html lang="en">`
 * in `index.html`, empty SPA hydration shells, Japanese Kanji+Kana mixtures, and
 * Chinese regional variants (`zh-CN` / `zh-TW` / `zh-HK`).
 */
export function detectPageLanguageSample(
  params: DetectPageLanguageParams,
): PageLanguageDetectionResult {
  const htmlTag = normalizeLangTag(params.htmlLang);
  const cleaned = String(params.sampleText ?? '')
    .slice(0, MAX_SAMPLE_CHARS)
    .replace(NOISE_TOKEN_RE, ' ');

  let han = 0;
  let kana = 0;
  let hangul = 0;
  let cyrillic = 0;
  let arabic = 0;
  let thai = 0;
  let greek = 0;
  let hebrew = 0;
  let devanagari = 0;
  let latin = 0;
  let vietnameseDistinct = 0;

  for (let i = 0; i < cleaned.length; ) {
    const cp = cleaned.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;

    if (isLatinLetterCodePoint(cp)) {
      latin++;
      if (isVietnameseDistinctCodePoint(cp)) {
        vietnameseDistinct++;
      }
    } else if (isHanCodePoint(cp)) {
      han++;
    } else if (isJapaneseKanaCodePoint(cp)) {
      kana++;
    } else if (isHangulCodePoint(cp)) {
      hangul++;
    } else if (isCyrillicCodePoint(cp)) {
      cyrillic++;
    } else if (isArabicCodePoint(cp)) {
      arabic++;
    } else if (isThaiCodePoint(cp)) {
      thai++;
    } else if (isGreekCodePoint(cp)) {
      greek++;
    } else if (isHebrewCodePoint(cp)) {
      hebrew++;
    } else if (isDevanagariCodePoint(cp)) {
      devanagari++;
    }
  }

  const total =
    han +
    kana +
    hangul +
    cyrillic +
    arabic +
    thai +
    greek +
    hebrew +
    devanagari +
    latin;

  if (total < MIN_MEANINGFUL_CHARS) {
    const tentative =
      htmlTag.full.startsWith('zh-')
        ? htmlTag.full
        : htmlTag.primary || 'und';
    return {
      isForeignToTarget: false,
      detectedLang: tentative,
      confidence: 'low',
      reason: 'insufficient-sample',
    };
  }

  const hanRatio = han / total;
  const kanaRatio = kana / total;
  const hangulRatio = hangul / total;
  const cyrillicRatio = cyrillic / total;
  const arabicRatio = arabic / total;
  const thaiRatio = thai / total;
  const greekRatio = greek / total;
  const hebrewRatio = hebrew / total;
  const devanagariRatio = devanagari / total;
  const latinRatio = latin / total;

  let detectedLang = 'en';
  let confidence: LanguageConfidence = 'high';
  let reason = 'latin-script';

  // 1. Japanese (Hiragana + Katakana mixed with Kanji/Latin)
  if ((kana >= 3 && kanaRatio >= 0.03) || (htmlTag.primary === 'ja' && kana > 0)) {
    detectedLang = 'ja';
    confidence =
      kana >= 6 || kanaRatio >= 0.06 || htmlTag.primary === 'ja'
        ? 'high'
        : 'medium';
    reason = 'japanese-kana-script';
  }
  // 2. Korean (Hangul)
  else if (
    (hangul >= 4 && hangulRatio >= 0.08) ||
    (htmlTag.primary === 'ko' && hangul > 0)
  ) {
    detectedLang = 'ko';
    confidence =
      hangulRatio >= 0.25 || htmlTag.primary === 'ko' ? 'high' : 'medium';
    reason = 'korean-hangul-script';
  }
  // 3. Chinese Han ideographs (>= 25% Han & < 3% Kana overrides misleading <html lang="en">)
  else if (hanRatio >= 0.25 && kanaRatio < 0.03) {
    if (htmlTag.full === 'zh-tw' || htmlTag.full === 'zh-hk') {
      detectedLang = htmlTag.full;
    } else {
      detectedLang = 'zh';
    }
    confidence =
      hanRatio >= 0.4 || htmlTag.primary === 'zh' ? 'high' : 'medium';
    reason =
      htmlTag.primary && htmlTag.primary !== 'zh'
        ? 'han-script-overrides-html-lang'
        : 'chinese-han-script';
  }
  // 4. Other distinct non-Latin scripts
  else if (cyrillicRatio >= 0.25) {
    detectedLang = CYRILLIC_LANG_PREFIXES.has(htmlTag.primary)
      ? htmlTag.primary
      : 'ru';
    confidence = cyrillicRatio >= 0.5 ? 'high' : 'medium';
    reason = 'cyrillic-script';
  } else if (arabicRatio >= 0.25) {
    detectedLang = ARABIC_LANG_PREFIXES.has(htmlTag.primary)
      ? htmlTag.primary
      : 'ar';
    confidence = arabicRatio >= 0.5 ? 'high' : 'medium';
    reason = 'arabic-script';
  } else if (thaiRatio >= 0.25) {
    detectedLang = 'th';
    confidence = thaiRatio >= 0.5 ? 'high' : 'medium';
    reason = 'thai-script';
  } else if (devanagariRatio >= 0.25) {
    detectedLang = DEVANAGARI_LANG_PREFIXES.has(htmlTag.primary)
      ? htmlTag.primary
      : 'hi';
    confidence = devanagariRatio >= 0.5 ? 'high' : 'medium';
    reason = 'devanagari-script';
  } else if (greekRatio >= 0.25) {
    detectedLang = 'el';
    confidence = greekRatio >= 0.5 ? 'high' : 'medium';
    reason = 'greek-script';
  } else if (hebrewRatio >= 0.25) {
    detectedLang = 'he';
    confidence = hebrewRatio >= 0.5 ? 'high' : 'medium';
    reason = 'hebrew-script';
  }
  // 5. Latin-dominant prose (English, French, German, Spanish, Vietnamese, etc.)
  else {
    if (
      vietnameseDistinct >= 3 &&
      (!htmlTag.primary || htmlTag.primary === 'vi' || htmlTag.primary === 'en')
    ) {
      detectedLang = 'vi';
      reason = 'vietnamese-latin-diacritics';
    } else if (htmlTag.primary && LATIN_LANG_PREFIXES.has(htmlTag.primary)) {
      detectedLang = htmlTag.primary;
      reason =
        htmlTag.primary === 'en' ? 'latin-script' : 'latin-script-with-html-lang';
    } else {
      detectedLang = 'en';
      reason = 'latin-script';
    }
    confidence = latinRatio >= 0.6 ? 'high' : 'medium';
  }

  return {
    isForeignToTarget: isForeignLanguageToTarget(detectedLang, params.targetLang),
    detectedLang,
    confidence,
    reason,
  };
}

function resolveEffectiveAutoTranslateMode(
  webpage: WebpageSettings,
): AutoTranslateMode {
  if (
    webpage.autoTranslateMode === 'off' ||
    webpage.autoTranslateMode === 'whitelist' ||
    webpage.autoTranslateMode === 'foreign'
  ) {
    return webpage.autoTranslateMode;
  }
  return webpage.autoTranslateMatches ? 'whitelist' : 'off';
}

function matchesConfiguredAutoLanguages(
  detectedLang: string,
  allowedLanguages: readonly string[],
  targetLang: string,
): boolean {
  const det = normalizeLangTag(detectedLang);
  const tgt = normalizeLangTag(targetLang);

  for (const rawAllowed of allowedLanguages) {
    const allowed = normalizeLangTag(rawAllowed);
    if (!allowed.full) continue;

    // Exact or subtag match (e.g. allowed `en` matches `en`/`en-us`; allowed `zh-tw` matches `zh-tw`)
    if (det.full === allowed.full || det.full.startsWith(`${allowed.full}-`)) {
      return true;
    }

    // Non-Chinese targetLang with `zh-CN` in allowed list matches generic `zh` Han detection
    if (tgt.primary !== 'zh' && allowed.primary === 'zh' && det.primary === 'zh') {
      return true;
    }
  }

  return false;
}

/**
 * Evaluates whether Margin should automatically start bilingual webpage translation
 * for the given URL and DOM text sample.
 */
export function evaluateAutoTranslateDecision(
  params: EvaluateAutoTranslateParams,
): AutoTranslateDecision {
  const {
    url,
    targetLang,
    webpage,
    urlRules,
    htmlLang,
    sampleText,
    manuallyDisabledInSession = false,
  } = params;

  // 1. User manually turned off translation on this page during current session
  if (manuallyDisabledInSession) {
    return {
      shouldTranslate: false,
      needsHydrationRecheck: false,
      reason: 'manual-session-off',
    };
  }

  // 2. Only http:// and https:// pages are eligible for automatic web translation
  const trimmedUrl = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    return {
      shouldTranslate: false,
      needsHydrationRecheck: false,
      reason: 'unsupported-scheme',
    };
  }

  // 3. Excluded URLs & private networks always win
  if (isUrlExcluded(trimmedUrl, urlRules)) {
    return {
      shouldTranslate: false,
      needsHydrationRecheck: false,
      reason: 'excluded-url',
    };
  }

  const mode = resolveEffectiveAutoTranslateMode(webpage);

  // 4. Explicit URL whitelist (`urlRules.includeMatches`) works in BOTH `'whitelist'` and `'foreign'` modes
  if (
    mode !== 'off' &&
    urlRules.includeMatches.length > 0 &&
    matchesAnyUrlGlob(trimmedUrl, urlRules.includeMatches)
  ) {
    return {
      shouldTranslate: true,
      needsHydrationRecheck: false,
      reason: 'whitelist-match',
    };
  }

  // 5. `'off'` or `'whitelist'` (when URL did not match whitelist above) stops here
  if (mode === 'off' || mode === 'whitelist') {
    return {
      shouldTranslate: false,
      needsHydrationRecheck: false,
      reason: 'mode-disabled',
    };
  }

  // 6. `'foreign'` mode -> inspect page language sample
  const detection = detectPageLanguageSample({
    htmlLang,
    sampleText,
    targetLang,
  });

  if (detection.confidence === 'low') {
    return {
      shouldTranslate: false,
      needsHydrationRecheck: true,
      detectedLang: detection.detectedLang,
      confidence: detection.confidence,
      reason: 'awaiting-content',
    };
  }

  const allowedLangs = (webpage.autoTranslateLanguages ?? [])
    .map((item) => item.trim())
    .filter(Boolean);

  // Explicit Chinese regional variant opt-in (e.g. `targetLang = 'zh-CN'` + `autoTranslateLanguages: ['zh-tw']`)
  const targetNorm = normalizeLangTag(targetLang);
  const detNorm = normalizeLangTag(detection.detectedLang);
  const explicitChineseVariantRequested =
    targetNorm.primary === 'zh' &&
    (detNorm.full === 'zh-tw' || detNorm.full === 'zh-hk') &&
    detNorm.full !== targetNorm.full &&
    allowedLangs.length > 0 &&
    matchesConfiguredAutoLanguages(detection.detectedLang, allowedLangs, targetLang);

  if (!detection.isForeignToTarget && !explicitChineseVariantRequested) {
    return {
      shouldTranslate: false,
      needsHydrationRecheck: false,
      detectedLang: detection.detectedLang,
      confidence: detection.confidence,
      reason: 'same-language',
    };
  }

  if (
    allowedLangs.length > 0 &&
    !matchesConfiguredAutoLanguages(detection.detectedLang, allowedLangs, targetLang)
  ) {
    return {
      shouldTranslate: false,
      needsHydrationRecheck: false,
      detectedLang: detection.detectedLang,
      confidence: detection.confidence,
      reason: 'language-filtered',
    };
  }

  return {
    shouldTranslate: true,
    needsHydrationRecheck: false,
    detectedLang: detection.detectedLang,
    confidence: detection.confidence,
    reason: 'foreign-page',
  };
}
