import { BRAND } from '@shared/brand';
import type {
  DiagnosticKind,
  DiagnosticSnapshot,
  PromptCodecId,
  ProviderPreset,
  TemperatureTrace,
  ThinkingPolicy,
  TranslationScene,
  WireProtocol,
} from '@shared/types';

const KNOWN_SAFE_PATH_SEGMENTS = new Set([
  'v1',
  'v2',
  'v3',
  'v4',
  'api',
  'paas',
  'chat',
  'completions',
  'messages',
  'responses',
  'translate',
  'translate_a',
  'single',
  'openai',
  'anthropic',
  'deepseek',
  'zhipu',
  'models',
  'deployments',
  'compatible-mode',
]);

const BEARER_TOKEN_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi;
const PREFIXED_API_KEY_RE =
  /\b(?:sk|rk|pk|ak|zk|ant|gsk|xai)-[A-Za-z0-9._-]{6,}\b/g;
const ZHIPU_STYLE_JWT_KEY_RE = /\b[0-9a-fA-F]{20,}\.[A-Za-z0-9_-]{10,}\b/g;
const URL_USERINFO_RE = /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const QUERY_SECRET_RE =
  /([?&](?:key|api_key|apikey|token|access_token|auth|secret|password)=)[^&\s#"']+/gi;
const KV_SECRET_RE =
  /((?:x-api-key|api[-_]?key|access[-_]?token|authorization|secret|password)\s*[:=]\s*["']?)([^\s"',&;}\]]+)/gi;
const DEEPLX_PATH_SECRET_RE =
  /(https?:\/\/[^\s/]+)\/([A-Za-z0-9_-]{12,})(\/(?:v2\/)?translate\b)/gi;

/**
 * Redacts API keys, Bearer tokens, URL credentials, query tokens, and explicit
 * provider secrets from any error message or upstream body snippet.
 */
export function sanitizeErrorText(
  rawError: unknown,
  knownSecrets: readonly string[] = [],
  maxLength = 420,
): string {
  let text: string;
  if (rawError instanceof Error) {
    text = rawError.message || rawError.name;
  } else if (typeof rawError === 'string') {
    text = rawError;
  } else if (rawError === null || rawError === undefined) {
    return '';
  } else {
    try {
      text = JSON.stringify(rawError);
    } catch {
      text = String(rawError);
    }
  }

  // First scrub exact known secrets (API keys, private URL tokens)
  for (const secret of knownSecrets) {
    const trimmed = String(secret ?? '').trim();
    if (trimmed.length >= 4) {
      text = text.split(trimmed).join('[REDACTED]');
    }
  }

  text = text
    .replace(URL_USERINFO_RE, '$1[REDACTED_USER]:[REDACTED_PASS]@')
    .replace(DEEPLX_PATH_SECRET_RE, '$1/[REDACTED]$3')
    .replace(QUERY_SECRET_RE, '$1[REDACTED]')
    .replace(BEARER_TOKEN_RE, '$1[REDACTED_TOKEN]')
    .replace(PREFIXED_API_KEY_RE, '[REDACTED_KEY]')
    .replace(ZHIPU_STYLE_JWT_KEY_RE, '[REDACTED_KEY]')
    .replace(KV_SECRET_RE, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > maxLength) {
    return `${text.slice(0, maxLength - 1)}…`;
  }
  return text;
}

function looksLikeSecretPathSegment(segment: string, protocol: WireProtocol): boolean {
  if (!segment) return false;
  const lower = segment.toLowerCase();
  if (KNOWN_SAFE_PATH_SEGMENTS.has(lower)) return false;

  if (protocol === 'deeplx' && segment.length >= 10) {
    return true;
  }

  // Redact long high-entropy token segments in custom gateway paths
  if (segment.length >= 20 && /^[A-Za-z0-9._-]+$/.test(segment)) {
    const hasDigit = /\d/.test(segment);
    const hasAlpha = /[A-Za-z]/.test(segment);
    if (hasDigit && hasAlpha) return true;
  }

  if (/^(?:sk|rk|pk|ak|zk)-/i.test(segment)) {
    return true;
  }

  return false;
}

/**
 * Extracts zero-secret `endpointOrigin` and `endpointPath` from a resolved URL
 * (automatically stripping query strings, hashes, basic-auth userinfo, and path tokens).
 */
export function parseSafeEndpointParts(
  resolvedUrl: string,
  protocol: WireProtocol = 'openai-chat',
): { endpointOrigin: string; endpointPath: string } {
  try {
    const normalized = /^https?:\/\//i.test(resolvedUrl)
      ? resolvedUrl
      : `https://${resolvedUrl}`;
    const parsed = new URL(normalized);
    const maskedSegments = parsed.pathname.split('/').map((seg) =>
      looksLikeSecretPathSegment(seg, protocol) ? '[REDACTED]' : seg,
    );
    return {
      endpointOrigin: parsed.origin,
      endpointPath: maskedSegments.join('/') || '/',
    };
  } catch {
    return {
      endpointOrigin: 'invalid-endpoint',
      endpointPath: '/',
    };
  }
}

export function classifyDiagnosticKind(params: {
  ok: boolean;
  httpStatus?: number;
  recoveredFromUnsupportedParam?: boolean;
  isNetworkError?: boolean;
  isInvalidResponse?: boolean;
}): DiagnosticKind {
  const {
    ok,
    httpStatus,
    recoveredFromUnsupportedParam,
    isNetworkError,
    isInvalidResponse,
  } = params;

  if (ok) {
    return recoveredFromUnsupportedParam ? 'unsupported-param-recovered' : 'ok';
  }
  if (isInvalidResponse) {
    return 'invalid-response';
  }
  if (isNetworkError) {
    return 'network-error';
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return 'auth-error';
  }
  if (httpStatus === 429) {
    return 'rate-limit';
  }
  if (httpStatus === 400 || httpStatus === 404 || httpStatus === 422) {
    return 'bad-request';
  }
  if (httpStatus !== undefined && (httpStatus >= 500 || httpStatus === 408)) {
    return 'upstream-error';
  }
  return 'network-error';
}

export interface BuildDiagnosticParams {
  scene: TranslationScene | 'service-test';
  codec: PromptCodecId;
  provider: {
    id: string;
    preset: ProviderPreset;
    protocol: WireProtocol;
    resolvedEndpoint: string;
    model: string;
  };
  parameters: {
    temperatureTrace: TemperatureTrace;
    temperatureSent?: number;
    thinkingMode: ThinkingPolicy['mode'];
    stream: boolean;
  };
  httpStatus?: number;
  kind: DiagnosticKind;
  retryable: boolean;
  attempts: number;
  latencyMs: number;
  rawError?: unknown;
  knownSecrets?: readonly string[];
  now?: Date;
}

export function buildDiagnosticSnapshot(
  params: BuildDiagnosticParams,
): DiagnosticSnapshot {
  const { endpointOrigin, endpointPath } = parseSafeEndpointParts(
    params.provider.resolvedEndpoint,
    params.provider.protocol,
  );
  const sanitizedError =
    params.rawError !== undefined
      ? sanitizeErrorText(params.rawError, params.knownSecrets)
      : undefined;

  return {
    schemaVersion: BRAND.diagnosticSchemaVersion,
    product: BRAND.name,
    version: BRAND.version,
    time: (params.now ?? new Date()).toISOString(),
    scene: params.scene,
    codec: params.codec,
    provider: {
      id: params.provider.id,
      preset: params.provider.preset,
      protocol: params.provider.protocol,
      endpointOrigin,
      endpointPath,
      model: params.provider.model,
    },
    parameters: {
      temperatureTrace: params.parameters.temperatureTrace,
      ...(params.parameters.temperatureSent !== undefined
        ? { temperatureSent: params.parameters.temperatureSent }
        : {}),
      thinkingMode: params.parameters.thinkingMode,
      stream: params.parameters.stream,
    },
    ...(params.httpStatus !== undefined ? { httpStatus: params.httpStatus } : {}),
    kind: params.kind,
    retryable: params.retryable,
    attempts: Math.max(1, Math.floor(params.attempts)),
    latencyMs: Math.max(0, Math.round(params.latencyMs)),
    ...(sanitizedError ? { sanitizedError } : {}),
  };
}
