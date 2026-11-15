import type {
  ThemePatternRule,
  TranslationTheme,
  UrlPatternConfig,
} from './types';

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function splitAuthorityHostAndPort(authority: string): {
  hostPat: string;
  portPat: string | null;
} {
  if (authority.startsWith('[')) {
    const closeIdx = authority.indexOf(']');
    if (closeIdx !== -1) {
      const hostPat = authority.slice(0, closeIdx + 1);
      const rest = authority.slice(closeIdx + 1);
      return {
        hostPat,
        portPat: rest.startsWith(':') ? rest.slice(1) : null,
      };
    }
  }
  const colonIdx = authority.indexOf(':');
  if (colonIdx === -1) {
    return { hostPat: authority, portPat: null };
  }
  return {
    hostPat: authority.slice(0, colonIdx),
    portPat: authority.slice(colonIdx + 1),
  };
}

export function globToRegExp(pattern: string): RegExp | null {
  const trimmed = String(pattern ?? '').trim();
  if (!trimmed) return null;
  if (trimmed === '<all_urls>' || trimmed === '*://*/*' || trimmed === '*') {
    return /^https?:\/\/.+/i;
  }

  let schemeRe = 'https?';
  let rest = trimmed;
  let isBareHostShorthand = false;

  const schemeIdx = trimmed.indexOf('://');
  if (schemeIdx !== -1) {
    const rawScheme = trimmed.slice(0, schemeIdx);
    rest = trimmed.slice(schemeIdx + 3);
    schemeRe =
      rawScheme === '*'
        ? 'https?'
        : rawScheme
            .split('*')
            .map(escapeRegexChar)
            .join('[a-zA-Z0-9+.-]*');
  } else {
    isBareHostShorthand = !/[/?#]/.test(rest);
  }

  const pathStartIdx = rest.search(/[/?#]/);
  const authority = pathStartIdx === -1 ? rest : rest.slice(0, pathStartIdx);
  const pathAndQuery = pathStartIdx === -1 ? '' : rest.slice(pathStartIdx);

  try {
    if (!authority) {
      const pathRe = pathAndQuery.split('*').map(escapeRegexChar).join('.*');
      return new RegExp(`^${schemeRe}:\\/\\/${pathRe}$`, 'i');
    }

    const { hostPat, portPat } = splitAuthorityHostAndPort(authority);
    let hostRe: string;
    if (hostPat === '*') {
      hostRe = '[^/:?#@]+';
    } else if (hostPat.startsWith('*.')) {
      const subBase = hostPat
        .slice(2)
        .split('*')
        .map(escapeRegexChar)
        .join('[^/:?#@]*');
      hostRe = `(?:[^/:?#@]+\\.)?${subBase}`;
    } else {
      const exactHost = hostPat
        .split('*')
        .map(escapeRegexChar)
        .join('[^/:?#@]*');
      hostRe =
        isBareHostShorthand && !hostPat.includes('*')
          ? `(?:[^/:?#@]+\\.)?${exactHost}`
          : exactHost;
    }

    const portRe =
      portPat !== null
        ? `:${portPat.split('*').map(escapeRegexChar).join('\\d*')}`
        : '(?::\\d+)?';

    let tailRe: string;
    if (pathStartIdx === -1) {
      tailRe = '(?:[/?#].*)?$';
    } else if (pathAndQuery === '/*') {
      tailRe = '(?:\\/.*)?$';
    } else {
      tailRe = `${pathAndQuery.split('*').map(escapeRegexChar).join('.*')}$`;
    }

    return new RegExp(`^${schemeRe}:\\/\\/${hostRe}${portRe}${tailRe}`, 'i');
  } catch {
    return null;
  }
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

function isPrivateOrReservedIpv4(ip: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  const c = Number(ipv4[3]);
  const d = Number(ipv4[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function parseIpv6Hextets(rawIpv6: string): number[] | null {
  const withoutZone = rawIpv6.split('%')[0]?.trim().toLowerCase() ?? '';
  if (!withoutZone) return null;

  let normalized = withoutZone;
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon !== -1 && normalized.includes('.')) {
    const ipv4Tail = normalized.slice(lastColon + 1);
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4Tail);
    if (!m) return null;
    const o1 = Number(m[1]);
    const o2 = Number(m[2]);
    const o3 = Number(m[3]);
    const o4 = Number(m[4]);
    if (o1 > 255 || o2 > 255 || o3 > 255 || o4 > 255) return null;
    const hi = ((o1 << 8) | o2).toString(16);
    const lo = ((o3 << 8) | o4).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = normalized.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const nums: number[] = [];
    for (const tok of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
      nums.push(Number.parseInt(tok, 16));
    }
    return nums;
  };

  if (doubleColonParts.length === 2) {
    const left = parseSide(doubleColonParts[0]);
    const right = parseSide(doubleColonParts[1]);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    return [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const full = parseSide(normalized);
  if (!full || full.length !== 8) return null;
  return full;
}

function isPrivateOrReservedIpv6(bracketedHost: string): boolean {
  const inner = bracketedHost.slice(1, -1);
  const g = parseIpv6Hextets(inner);
  if (!g) return false;

  const allZeroPrefix6 =
    g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  // `::` (unspecified) or `::1` (loopback)
  if (allZeroPrefix6 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
    return true;
  }

  // IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96`, IPv4-translated `::ffff:0:0:0/96`, or NAT64 `64:ff9b::/96`
  const isV4Mapped =
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0xffff;
  const isV4Translated =
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0xffff &&
    g[5] === 0;
  const isNat64 =
    g[0] === 0x0064 &&
    g[1] === 0xff9b &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0;
  if (isV4Mapped || allZeroPrefix6 || isV4Translated || isNat64) {
    const ipv4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isPrivateOrReservedIpv4(ipv4);
  }

  // Unique Local `fc00::/7`
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // Link-Local `fe80::/10` or deprecated Site-Local `fec0::/10`
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;

  return false;
}

export function isPrivateOrLocalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(String(rawUrl ?? '').trim());
    const rawHost = parsed.hostname.toLowerCase();
    if (!rawHost) return false;

    if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
      return isPrivateOrReservedIpv6(rawHost);
    }

    const host = rawHost.replace(/\.+$/, '');
    if (!host) return false;

    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.lan') ||
      host.endsWith('.internal') ||
      host.endsWith('.home.arpa')
    ) {
      return true;
    }

    return isPrivateOrReservedIpv4(host);
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

export type SiteAutoRuleState = 'follow' | 'always' | 'never';

function extractHttpHostInfo(
  url: string,
): { hostname: string; host: string } | null {
  try {
    const parsed = new URL(String(url ?? '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    const hostname = parsed.hostname.trim().toLowerCase();
    const host = parsed.host.trim().toLowerCase();
    if (!hostname || !host) return null;
    return { hostname, host };
  } catch {
    return null;
  }
}

function isGlobalCatchAllPattern(pattern: string): boolean {
  const t = String(pattern ?? '').trim().toLowerCase();
  return (
    t === '<all_urls>' ||
    t === '*://*/*' ||
    t === 'https://*/*' ||
    t === 'http://*/*' ||
    t === '*'
  );
}

function isCanonicalSiteRuleForHost(pattern: string, host: string): boolean {
  const normalized = String(pattern ?? '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === `*://${host}/*` ||
    normalized === `https://${host}/*` ||
    normalized === `http://${host}/*` ||
    normalized === host
  );
}

function doesPatternMatchSiteHost(
  pattern: string,
  url: string,
  host: string,
): boolean {
  const trimmed = String(pattern ?? '').trim();
  if (!trimmed || isGlobalCatchAllPattern(trimmed)) {
    return false;
  }
  return (
    matchesUrlGlob(url, trimmed) ||
    matchesUrlGlob(`https://${host}/`, trimmed) ||
    matchesUrlGlob(`http://${host}/`, trimmed)
  );
}

export function getSiteAutoRule(
  url: string,
  rules: UrlPatternConfig,
): SiteAutoRuleState {
  const info = extractHttpHostInfo(url);
  if (!info) return 'follow';
  const { host } = info;

  if (rules.excludeMatches.some((p) => isCanonicalSiteRuleForHost(p, host))) {
    return 'never';
  }
  if (rules.includeMatches.some((p) => isCanonicalSiteRuleForHost(p, host))) {
    return 'always';
  }
  if (rules.excludeMatches.some((p) => doesPatternMatchSiteHost(p, url, host))) {
    return 'never';
  }
  if (rules.includeMatches.some((p) => doesPatternMatchSiteHost(p, url, host))) {
    return 'always';
  }
  return 'follow';
}

export function applySiteAutoRule(
  url: string,
  state: SiteAutoRuleState,
  rules: UrlPatternConfig,
): UrlPatternConfig {
  const info = extractHttpHostInfo(url);
  if (!info) {
    return {
      includeMatches: [...rules.includeMatches],
      excludeMatches: [...rules.excludeMatches],
      skipPrivateNetworks: rules.skipPrivateNetworks,
    };
  }

  const { host } = info;
  const canonical = `*://${host}/*`;
  const cleanIncludes = rules.includeMatches.filter(
    (p) => !isCanonicalSiteRuleForHost(p, host),
  );
  const cleanExcludes = rules.excludeMatches.filter(
    (p) => !isCanonicalSiteRuleForHost(p, host),
  );

  if (state === 'always') {
    return {
      includeMatches: [...cleanIncludes, canonical],
      excludeMatches: cleanExcludes,
      skipPrivateNetworks: rules.skipPrivateNetworks,
    };
  }

  if (state === 'never') {
    return {
      includeMatches: cleanIncludes,
      excludeMatches: [...cleanExcludes, canonical],
      skipPrivateNetworks: rules.skipPrivateNetworks,
    };
  }

  return {
    includeMatches: cleanIncludes,
    excludeMatches: cleanExcludes,
    skipPrivateNetworks: rules.skipPrivateNetworks,
  };
}

export {
  detectPageLanguageSample,
  evaluateAutoTranslateDecision,
  type AutoTranslateDecision,
  type AutoTranslateDecisionReason,
  type DetectPageLanguageParams,
  type EvaluateAutoTranslateParams,
  type LanguageConfidence,
  type PageLanguageDetectionResult,
} from './page-language';
