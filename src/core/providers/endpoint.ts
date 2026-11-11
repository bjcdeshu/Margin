import { PROVIDER_PRESETS } from '@shared/constants';
import type { ProviderConfig } from '@shared/types';

/**
 * Clean TypeScript port of P0-1 `resolveProviderEndpoint`.
 *
 * - Never mutates the caller's stored `configuredUrl` string.
 * - Prepends `https://` when scheme is omitted.
 * - Root path `/` inherits the complete default endpoint path (`/v1/chat/completions`,
 *   `/api/paas/v4/chat/completions`, `/v1/messages`, `/translate`, etc.).
 * - Paths ending in `/v1` (such as `/v1`, `/openai/v1`, `/anthropic/v1`) append
 *   `/chat/completions` or `/messages` according to `defaultUrl`.
 * - Any explicit custom path, port, basic-auth userinfo, query string, or hash is preserved.
 */
export function resolveProviderEndpoint(
  defaultUrl: string,
  configuredUrl?: string,
): string {
  const fallback = new URL(defaultUrl);
  let raw = String(configuredUrl ?? '').trim();
  if (!raw) {
    return fallback.toString();
  }
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  const configured = new URL(raw);
  const defaultPath = fallback.pathname;

  if (configured.pathname === '/') {
    fallback.protocol = configured.protocol;
    fallback.hostname = configured.hostname;
    fallback.port = configured.port;
    fallback.username = configured.username;
    fallback.password = configured.password;
    fallback.search = configured.search;
    fallback.hash = configured.hash;
    return fallback.toString();
  }

  const configuredPath = configured.pathname.replace(/\/+$/, '');
  const endpointSuffix = defaultPath.endsWith('/chat/completions')
    ? '/chat/completions'
    : defaultPath.endsWith('/messages')
      ? '/messages'
      : '';

  if (endpointSuffix && /(?:^|\/)v1$/i.test(configuredPath)) {
    configured.pathname = configuredPath + endpointSuffix;
  }

  return configured.toString();
}

export function resolveDefaultEndpointForProvider(
  provider: Pick<ProviderConfig, 'preset' | 'protocol'>,
): string {
  if (provider.protocol === 'anthropic-messages') {
    return PROVIDER_PRESETS.anthropic.defaultEndpoint;
  }
  if (provider.protocol === 'deeplx') {
    return PROVIDER_PRESETS.deeplx.defaultEndpoint;
  }
  if (provider.protocol === 'google-web') {
    return PROVIDER_PRESETS['google-free'].defaultEndpoint;
  }
  return (
    PROVIDER_PRESETS[provider.preset]?.defaultEndpoint ??
    PROVIDER_PRESETS.openai.defaultEndpoint
  );
}

export function resolveEndpointForProvider(
  provider: Pick<ProviderConfig, 'preset' | 'protocol' | 'baseUrl'>,
): string {
  const defaultUrl = resolveDefaultEndpointForProvider(provider);
  return resolveProviderEndpoint(defaultUrl, provider.baseUrl);
}

export function resolveDeepLXEndpoints(
  provider: Pick<ProviderConfig, 'endpoints' | 'baseUrl'>,
): string[] {
  const defaultUrl = PROVIDER_PRESETS.deeplx.defaultEndpoint;
  const rawCandidates: string[] = [];

  if (Array.isArray(provider.endpoints) && provider.endpoints.length > 0) {
    for (const ep of provider.endpoints) {
      for (const piece of String(ep ?? '').split(/[,\r\n]+/)) {
        const trimmed = piece.trim();
        if (trimmed) rawCandidates.push(trimmed);
      }
    }
  }

  if (rawCandidates.length === 0 && provider.baseUrl) {
    for (const piece of String(provider.baseUrl).split(/[,\r\n]+/)) {
      const trimmed = piece.trim();
      if (trimmed) rawCandidates.push(trimmed);
    }
  }

  if (rawCandidates.length === 0) {
    return [defaultUrl];
  }

  const deduplicated = Array.from(
    new Set(rawCandidates.map((u) => resolveProviderEndpoint(defaultUrl, u))),
  );
  return deduplicated.length > 0 ? deduplicated : [defaultUrl];
}
