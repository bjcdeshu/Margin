const RTL_PRIMARY_SUBTAGS: ReadonlySet<string> = new Set([
  'ar',
  'he',
  'iw',
  'fa',
  'ur',
  'ps',
  'dv',
  'yi',
  'ckb',
  'sd',
  'ug',
]);

const RTL_SCRIPT_SUBTAGS: ReadonlySet<string> = new Set([
  'arab',
  'hebr',
  'thaa',
  'nkoo',
  'syrc',
  'adlm',
]);

const LEGACY_BARE_CJK_FALLBACK_FONTS: ReadonlySet<string> = new Set([
  'simsun',
  'nsimsun',
  '宋体',
  '新宋体',
  'mingliu',
  'pmingliu',
  '細明體',
  '新細明體',
  '细明体',
  '新细明体',
]);

const SANS_OR_MONO_GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'sans-serif',
  'ui-sans-serif',
  'system-ui',
  'monospace',
  'ui-monospace',
  'cursive',
  'fantasy',
]);

const NON_SERIF_FONT_PATTERNS: readonly string[] = [
  'sans',
  'system-ui',
  '-apple-system',
  'blinkmacsystemfont',
  'segoe',
  'roboto',
  'helvetica',
  'arial',
  'inter',
  'verdana',
  'tahoma',
  'trebuchet',
  'calibri',
  'cantarell',
  'ubuntu',
  'lato',
  'montserrat',
  'poppins',
  'nunito',
  'geist',
  'chirp',
  'mono',
  'consolas',
  'menlo',
  'monaco',
  'courier',
  'jetbrains',
  'inconsolata',
  'pingfang',
  'heiti',
  'yahei',
  'jhenghei',
  'gothic',
  'meiryo',
  'malgun',
  'dotum',
  'gulim',
  'kaiti',
  'fangsong',
];

const EDITORIAL_SERIF_PATTERNS: readonly string[] = [
  'georgia',
  'times new roman',
  'garamond',
  'palatino',
  'book antiqua',
  'charter',
  'merriweather',
  'lora',
  'source serif',
  'source han serif',
  'noto serif',
  'songti',
  'stsong',
  'fzshusong',
  'hiragino mincho',
  'yu mincho',
  'mincho',
  'batang',
  'myeongjo',
  'applemyungjo',
  'cambria',
  'constantia',
  'baskerville',
  'crimson',
  'playfair',
  'newsreader',
  'literata',
  'spectral',
  'pt serif',
  'ibm plex serif',
  'tinos',
];

const WESTERN_UI_SANS_LEAD =
  '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", Arial';

const FONT_STACK_ZH_CN_SANS = `${WESTERN_UI_SANS_LEAD}, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", system-ui, sans-serif`;
const FONT_STACK_ZH_CN_SERIF =
  'Georgia, "Times New Roman", "Songti SC", "STSong", "Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "SimSun", serif';

const FONT_STACK_ZH_TW_SANS = `${WESTERN_UI_SANS_LEAD}, "PingFang TC", "Heiti TC", "Microsoft JhengHei UI", "Microsoft JhengHei", "Source Han Sans TC", "Noto Sans CJK TC", "Noto Sans TC", system-ui, sans-serif`;
const FONT_STACK_ZH_TW_SERIF =
  'Georgia, "Times New Roman", "Songti TC", "STSongti-TC-Regular", "Source Han Serif TC", "Noto Serif CJK TC", "Noto Serif TC", "PMingLiU", "MingLiU", serif';

const FONT_STACK_JA_SANS = `${WESTERN_UI_SANS_LEAD}, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", "Meiryo", "Source Han Sans JP", "Noto Sans CJK JP", "Noto Sans JP", system-ui, sans-serif`;
const FONT_STACK_JA_SERIF =
  'Georgia, "Times New Roman", "Hiragino Mincho ProN", "Yu Mincho", "Source Han Serif JP", "Noto Serif CJK JP", "Noto Serif JP", "MS PMincho", serif';

const FONT_STACK_KO_SANS = `${WESTERN_UI_SANS_LEAD}, "Apple SD Gothic Neo", "Malgun Gothic", "Source Han Sans KR", "Noto Sans CJK KR", "Noto Sans KR", system-ui, sans-serif`;
const FONT_STACK_KO_SERIF =
  'Georgia, "Times New Roman", "AppleMyungjo", "Batang", "Source Han Serif KR", "Noto Serif CJK KR", "Noto Serif KR", serif';

const FONT_STACK_UNIVERSAL_SANS = `${WESTERN_UI_SANS_LEAD}, "Noto Sans", system-ui, sans-serif`;
const FONT_STACK_UNIVERSAL_SERIF =
  'Georgia, "Times New Roman", "Noto Serif", serif';

/**
 * Normalizes a configured target language code into a clean BCP-47 tag suitable for HTML `lang`.
 * Returns `''` for empty, `'auto'`, or invalid tags.
 */
export function normalizeTargetBcp47Lang(targetLang: string | undefined): string {
  const cleaned = String(targetLang ?? '')
    .trim()
    .replace(/_/g, '-');
  if (!cleaned) {
    return '';
  }

  const rawParts = cleaned.split('-').filter(Boolean);
  if (rawParts.length === 0) {
    return '';
  }

  for (const part of rawParts) {
    if (!/^[a-zA-Z0-9]+$/.test(part)) {
      return '';
    }
  }

  const lowerParts = rawParts.map((p) => p.toLowerCase());
  const primary = lowerParts[0];

  if (primary === 'auto' || primary === 'und') {
    return '';
  }

  if (primary === 'chs') {
    return 'zh-CN';
  }
  if (primary === 'cht') {
    return 'zh-TW';
  }

  if (primary === 'zh') {
    if (
      lowerParts.includes('tw') ||
      lowerParts.includes('hk') ||
      lowerParts.includes('mo') ||
      lowerParts.includes('hant')
    ) {
      return 'zh-TW';
    }
    return 'zh-CN';
  }

  if (primary === 'jp' || (primary === 'ja' && (lowerParts.length === 1 || lowerParts[1] === 'jp'))) {
    return 'ja';
  }

  if (primary === 'kr' || (primary === 'ko' && (lowerParts.length === 1 || lowerParts[1] === 'kr'))) {
    return 'ko';
  }

  const formatted: string[] = [primary];
  for (let i = 1; i < lowerParts.length; i++) {
    const sub = lowerParts[i];
    if (sub.length === 4 && /^[a-z]{4}$/.test(sub)) {
      // ISO 15924 script subtag -> TitleCase (e.g. Latn, Cyrl)
      formatted.push(sub[0].toUpperCase() + sub.slice(1));
    } else if (
      (sub.length === 2 && /^[a-z]{2}$/.test(sub)) ||
      (sub.length === 3 && /^[0-9]{3}$/.test(sub))
    ) {
      // ISO 3166-1 / UN M.49 region subtag -> UPPERCASE (e.g. BR, US, 419)
      formatted.push(sub.toUpperCase());
    } else {
      formatted.push(sub);
    }
  }

  return formatted.join('-');
}

/**
 * Resolves the natural text direction (`'rtl'` | `'ltr'`) for a normalized BCP-47 target language,
 * or `null` when empty. Prevents RTL host containers (e.g. Arabic/Hebrew posts on X) from inverting
 * LTR translations and vice versa.
 */
export function resolveTargetTextDir(bcp47Lang: string): 'rtl' | 'ltr' | null {
  const normalized = normalizeTargetBcp47Lang(bcp47Lang);
  if (!normalized) {
    return null;
  }

  const lowerParts = normalized.toLowerCase().split('-');
  const primary = lowerParts[0] ?? '';

  for (let i = 1; i < lowerParts.length; i++) {
    const sub = lowerParts[i];
    if (sub.length === 4) {
      if (RTL_SCRIPT_SUBTAGS.has(sub)) {
        return 'rtl';
      }
      if (sub === 'latn' || sub === 'cyrl') {
        return 'ltr';
      }
    }
  }

  if (RTL_PRIMARY_SUBTAGS.has(primary)) {
    return 'rtl';
  }

  return 'ltr';
}

function isNonSerifFontToken(token: string): boolean {
  if (SANS_OR_MONO_GENERIC_FAMILIES.has(token)) {
    return true;
  }
  return NON_SERIF_FONT_PATTERNS.some((pat) => token.includes(pat));
}

/**
 * Detects whether a host element's `computedStyle.fontFamily` intentionally uses editorial serif
 * typography (e.g. NYTimes, Substack, Medium `Georgia, serif` / `Merriweather` / `Songti SC`),
 * while ignoring bare browser fallback strings (`SimSun`, `NSimSun`, `MingLiU`, `PMingLiU`, or
 * unstyled UA single-token `"Times New Roman"`) and `sans-serif` / `monospace` stacks.
 */
export function isEditorialSerifFontFamily(
  computedFontFamily: string | null | undefined,
): boolean {
  if (!computedFontFamily) {
    return false;
  }

  const tokens = computedFontFamily
    .split(',')
    .map((part) => part.trim().replace(/^['"]+|['"]+$/g, '').trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) {
    return false;
  }

  const first = tokens[0];
  const last = tokens[tokens.length - 1];

  if (isNonSerifFontToken(first) || SANS_OR_MONO_GENERIC_FAMILIES.has(last)) {
    return false;
  }

  // Bare single-token "Times New Roman" / "Times" is the default unstyled browser / happy-dom UA font
  if (tokens.length === 1 && (first === 'times new roman' || first === 'times')) {
    return false;
  }

  // Bare SimSun / NSimSun / MingLiU / PMingLiU fallback-only strings must NOT trigger serif mode
  const nonGenericTokens = tokens.filter(
    (t) => t !== 'serif' && t !== 'ui-serif',
  );
  if (
    nonGenericTokens.length > 0 &&
    nonGenericTokens.every((t) => LEGACY_BARE_CJK_FALLBACK_FONTS.has(t))
  ) {
    return false;
  }

  for (const token of tokens) {
    if (LEGACY_BARE_CJK_FALLBACK_FONTS.has(token)) {
      continue;
    }
    if (token === 'serif' || token === 'ui-serif' || token === 'times') {
      return true;
    }
    if (EDITORIAL_SERIF_PATTERNS.some((pat) => token.includes(pat))) {
      return true;
    }
    if (token.includes('serif') && !token.includes('sans')) {
      return true;
    }
  }

  return false;
}

/**
 * Resolves a locale-pure CSS `font-family` stack for the target translation language so shared CJK
 * Han ideographs render uniformly without Japanese `Meiryo` / Korean `Malgun Gothic` / Windows `SimSun`
 * ransom-note mixing, while inline Latin words and numbers stay crisp.
 */
export function resolveTargetFontFamilyCss(
  bcp47Lang: string,
  options?: { serif?: boolean },
): string {
  const normalized = normalizeTargetBcp47Lang(bcp47Lang);
  const serif = Boolean(options?.serif);

  if (normalized === 'zh-TW') {
    return serif ? FONT_STACK_ZH_TW_SERIF : FONT_STACK_ZH_TW_SANS;
  }

  if (normalized === 'zh-CN' || normalized.startsWith('zh')) {
    return serif ? FONT_STACK_ZH_CN_SERIF : FONT_STACK_ZH_CN_SANS;
  }

  if (normalized === 'ja' || normalized.startsWith('ja-')) {
    return serif ? FONT_STACK_JA_SERIF : FONT_STACK_JA_SANS;
  }

  if (normalized === 'ko' || normalized.startsWith('ko-')) {
    return serif ? FONT_STACK_KO_SERIF : FONT_STACK_KO_SANS;
  }

  return serif ? FONT_STACK_UNIVERSAL_SERIF : FONT_STACK_UNIVERSAL_SANS;
}
