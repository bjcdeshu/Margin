import { PROVIDER_PRESETS } from '@shared/constants';
import type { ProviderPreset, WireProtocol } from '@shared/types';

export interface EndpointPreviewResult {
  valid: boolean;
  fullUrl: string;
  origin: string;
  pathname: string;
  autoCompleted: boolean;
}

function defaultPathFor(preset: ProviderPreset, protocol: WireProtocol): string {
  if (preset === 'zhipu') {
    return '/api/paas/v4/chat/completions';
  }
  if (protocol === 'anthropic-messages' || preset === 'anthropic') {
    return '/v1/messages';
  }
  if (protocol === 'deeplx' || preset === 'deeplx') {
    return '/translate';
  }
  if (protocol === 'google-web' || preset === 'google-free') {
    return '/translate_a/single';
  }
  return '/v1/chat/completions';
}

/**
 * Pure P0-1 endpoint preview resolver for UI feedback without mutating `provider.baseUrl`.
 */
export function resolveEndpointPreview(
  rawBaseUrl: string,
  preset: ProviderPreset,
  protocol: WireProtocol,
): EndpointPreviewResult {
  const fallback = PROVIDER_PRESETS[preset]?.defaultEndpoint ?? 'https://api.openai.com/v1/chat/completions';
  const trimmed = String(rawBaseUrl ?? '').trim();
  const candidate = trimmed || fallback;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
    ? candidate
    : `https://${candidate}`;

  try {
    const parsed = new URL(withScheme);
    const originalPath = parsed.pathname;
    let nextPath = originalPath;

    if (!originalPath || originalPath === '/') {
      nextPath = defaultPathFor(preset, protocol);
    } else if (/\/v1\/?$/i.test(originalPath)) {
      const baseV1 = originalPath.replace(/\/+$/, '');
      if (protocol === 'anthropic-messages') {
        nextPath = `${baseV1}/messages`;
      } else if (protocol === 'openai-chat') {
        nextPath = `${baseV1}/chat/completions`;
      }
    }

    const autoCompleted = nextPath !== originalPath || withScheme !== trimmed;
    parsed.pathname = nextPath;

    return {
      valid: true,
      fullUrl: parsed.toString(),
      origin: parsed.origin,
      pathname: parsed.pathname + parsed.search,
      autoCompleted,
    };
  } catch {
    return {
      valid: false,
      fullUrl: candidate,
      origin: '',
      pathname: candidate,
      autoCompleted: false,
    };
  }
}
