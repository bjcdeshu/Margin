import type {
  ExportMarginOptions,
  MarginConfig,
  ProviderConfig,
} from '@shared/types';

export const REDACTED_PLACEHOLDER = '<REDACTED>';

const SENSITIVE_HEADER_NAME_RE =
  /^(?:authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|x-auth-token|x-access-token|cookie|set-cookie)$|(?:api[-_]?key|auth|token|secret|password|credential)/i;

const SENSITIVE_HEADER_VALUE_RE =
  /^\s*(?:Bearer|Basic|Token|Digest)\s+\S+|\bsk-[A-Za-z0-9_-]{8,}\b/i;

const SAFE_DEEPLX_PATH_SEGMENT_RE =
  /^(?:translate|dl|api|deeplx|deepl|service|proxy|v\d+)$/i;

const SENSITIVE_QUERY_PARAM_RE =
  /^(?:key|api[-_]?key|x[-_]?api[-_]?key|token|access[-_]?token|auth|auth[-_]?key|auth[-_]?token|secret|password)$/i;

const EMBEDDED_API_KEY_SEGMENT_RE = /^(?:sk-[A-Za-z0-9_-]{8,}|dplx_[A-Za-z0-9_-]{6,})$/;

/**
 * Redacts embedded credentials, query tokens, and private DeepLX path tokens
 * from a provider URL while preserving origin, port, safe route prefixes, and
 * non-secret query parameters (such as `api-version`).
 */
export function redactProviderUrl(rawUrl: string, isDeeplxProvider: boolean): string {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(REDACTED_PLACEHOLDER)) return trimmed;

  let parsed: URL;
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed);
  try {
    parsed = new URL(hasExplicitScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return trimmed.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED_PLACEHOLDER);
  }

  const hostLooksDeeplx = /deeplx/i.test(parsed.hostname);
  const treatAsDeeplx = isDeeplxProvider || hostLooksDeeplx;

  const hadUserInfo = Boolean(parsed.username || parsed.password);
  parsed.username = '';
  parsed.password = '';

  const trailingSlash = parsed.pathname.length > 1 && parsed.pathname.endsWith('/');
  const rawSegments = parsed.pathname.split('/').filter((seg) => seg.length > 0);
  const redactedSegments = rawSegments.map((seg) => {
    if (seg === REDACTED_PLACEHOLDER || seg === '%3CREDACTED%3E') {
      return REDACTED_PLACEHOLDER;
    }
    if (EMBEDDED_API_KEY_SEGMENT_RE.test(seg)) {
      return REDACTED_PLACEHOLDER;
    }
    if (treatAsDeeplx && !SAFE_DEEPLX_PATH_SEGMENT_RE.test(seg)) {
      return REDACTED_PLACEHOLDER;
    }
    return seg;
  });

  const rebuiltPath =
    redactedSegments.length > 0
      ? `/${redactedSegments.join('/')}${trailingSlash ? '/' : ''}`
      : parsed.pathname || '/';

  const queryParts: string[] = [];
  parsed.searchParams.forEach((value, key) => {
    if (SENSITIVE_QUERY_PARAM_RE.test(key) || EMBEDDED_API_KEY_SEGMENT_RE.test(value)) {
      queryParts.push(`${encodeURIComponent(key)}=${REDACTED_PLACEHOLDER}`);
    } else {
      queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  });

  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
  const authPrefix = hadUserInfo ? `${REDACTED_PLACEHOLDER}@` : '';
  const schemePrefix = hasExplicitScheme ? `${parsed.protocol}//` : '';

  return `${schemePrefix}${authPrefix}${parsed.host}${rebuiltPath}${queryString}${parsed.hash}`;
}

function redactProviderSecrets(provider: ProviderConfig): void {
  provider.apiKeys = [];

  const isDeeplx = provider.preset === 'deeplx' || provider.protocol === 'deeplx';
  if (provider.baseUrl) {
    provider.baseUrl = redactProviderUrl(provider.baseUrl, isDeeplx);
  }
  if (Array.isArray(provider.endpoints)) {
    provider.endpoints = provider.endpoints.map((ep) => redactProviderUrl(ep, isDeeplx));
  }

  if (provider.extraHeaders && typeof provider.extraHeaders === 'object') {
    const cleanHeaders: Record<string, string> = {};
    for (const [headerName, headerValue] of Object.entries(provider.extraHeaders)) {
      const valueStr = String(headerValue ?? '');
      if (
        SENSITIVE_HEADER_NAME_RE.test(headerName.trim()) ||
        SENSITIVE_HEADER_VALUE_RE.test(valueStr)
      ) {
        continue;
      }
      cleanHeaders[headerName] = valueStr;
    }
    provider.extraHeaders = cleanHeaders;
  }
}

/**
 * Exports a `MarginConfig` as formatted JSON.
 *
 * - Default (`includeSecrets: false`): strips `apiKeys`, removes auth/key headers
 *   from `extraHeaders`, and masks secret path/query tokens in private DeepLX URLs
 *   (`https://api.deeplx.org/<REDACTED>/translate`) so exports are safe to share.
 * - Full backup (`includeSecrets: true`): preserves lossless `MarginConfig` secrets
 *   for browser-to-browser migration.
 */
export function exportMarginConfig(
  config: MarginConfig,
  options: ExportMarginOptions = { includeSecrets: false },
): string {
  const clone = structuredClone(config);
  if (!options?.includeSecrets) {
    for (const provider of Object.values(clone.providers)) {
      redactProviderSecrets(provider);
    }
  }
  return JSON.stringify(clone, null, 2);
}
