import type {
  ThemePatternRule,
  TranslationTheme,
  UrlPatternConfig,
} from './types';

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(pattern: string): RegExp | null {
  const trimmed = String(pattern ?? '').trim();
  if (!trimmed) return null;
  if (trimmed === '<all_urls>' || trimmed === '*://*/*') {
    return /^https?:\/\/.+/i;
  }

  // Bare hostname shorthand like `linux.do` or `*.linux.do`
  if (!trimmed.includes('://') && !trimmed.includes('/')) {
    const hostRegex = trimmed
      .split('*')
      .map(escapeRegexChar)
      .join('[^/]*');
    return new RegExp(`^https?:\\/\\/(?:[^/]+\\.)?${hostRegex}(?:[:/]|$)`, 'i');
  }

  const regexStr = trimmed
    .split('*')
    .map(escapeRegexChar)
    .join('.*');
  return new RegExp(`^${regexStr}$`, 'i');
}

export function matchesUrlGlob(url: string, pattern: string): boolean {
  if (!url || !pattern) return false;
  const re = globToRegExp(pattern);
  return re ? re.test(url) : false;
}

export function matchesAnyUrlGlob(url: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (matchesUrlGlob(url, p)) return true;
  }
  return false;
}

export function isUnsupportedBrowserUrl(url: string): boolean {
  return /^(?:chrome|chrome-extension|edge|about|moz-extension|view-source|devtools):/i.test(
    String(url ?? '').trim(),
  );
}

export function isPrivateOrLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.endsWith('.local') ||
      host.endsWith('.lan')
    ) {
      return true;
    }
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4) {
      const a = Number(ipv4[1]);
      const b = Number(ipv4[2]);
      if (a === 10 || a === 127) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isUrlExcluded(url: string, rules: UrlPatternConfig): boolean {
  if (isUnsupportedBrowserUrl(url)) return true;
  if (rules.skipPrivateNetworks && isPrivateOrLocalUrl(url)) return true;
  return matchesAnyUrlGlob(url, rules.excludeMatches);
}

export function shouldAutoTranslateUrl(
  url: string,
  rules: UrlPatternConfig,
  autoTranslateMatches: boolean,
): boolean {
  if (isUrlExcluded(url, rules)) return false;
  if (!autoTranslateMatches) return false;
  if (rules.includeMatches.length === 0) return false;
  return matchesAnyUrlGlob(url, rules.includeMatches);
}

export function resolveThemeForUrl(
  url: string,
  defaultTheme: TranslationTheme,
  patterns: readonly ThemePatternRule[],
): TranslationTheme {
  for (const rule of patterns) {
    if (matchesUrlGlob(url, rule.pattern)) {
      return rule.theme;
    }
  }
  return defaultTheme;
}
