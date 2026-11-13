import type {
  ModelCapabilityEntry,
  ResolvedTemperature,
  TemperaturePolicy,
} from './types';

/**
 * Matches reasoning / strict-parameter models where arbitrary `temperature` (e.g. 0 or 0.3)
 * causes HTTP 400 (`Unsupported parameter: 'temperature'` or `Only default (1) supported`).
 *
 * Deliberately unanchored at the end so vendor/gateway suffixes (`gpt-6-luna`,
 * `gpt-5.6-luna`, `gpt-5.3-codex-spark`, `o3-mini-high`) are always caught.
 */
const STRICT_MODEL_PREFIX_RE =
  /^(?:o[1-9](?:[-._]|$)|gpt-(?:[5-9]|\d{2,})(?:[-._]|$))/i;

const STRICT_MODEL_KEYWORD_RE =
  /(?:codex|reasoner|thinking|\br1\b|\bqwq\b)/i;

const UNSUPPORTED_TEMP_ERROR_RE =
  /\btemperature\b|unsupported[_\s-]?parameter|unsupported[_\s-]?value|only the default \(1\) value is supported/i;

const UNSUPPORTED_REASONING_EFFORT_ERROR_RE =
  /\breasoning[_\s-]?effort\b|\breasoningEffort\b/i;

export function isStrictTemperatureModel(model: string): boolean {
  const m = String(model ?? '').trim();
  if (!m) return false;
  return STRICT_MODEL_PREFIX_RE.test(m) || STRICT_MODEL_KEYWORD_RE.test(m);
}

/**
 * Matches OpenAI reasoning-family models (`o1*`, `o3*`, `o4*`, `gpt-5*`, `gpt-6*`)
 * eligible for scene-aware `reasoning_effort: 'low'` on realtime scenes (`webpage`, `hover`, `subtitle`),
 * excluding `codex` variants where gateways may omit `reasoning_effort`.
 */
export function isOpenAiLightReasoningModel(model: string): boolean {
  const m = String(model ?? '').trim();
  if (!m) return false;
  if (/codex/i.test(m)) return false;
  return STRICT_MODEL_PREFIX_RE.test(m);
}

/**
 * Normalizes any raw config value (`undefined`, `null`, `""`, `"0.3"`, `0.3`) into
 * a strict 2-mode `TemperaturePolicy`.
 *
 * Critically: `undefined`, `null`, and `""` ALWAYS map to `{ mode: 'omit' }`,
 * eliminating legacy Layer 1 (`temperature = 0` default) and Layer 2 (`"" -> NaN` flip-flop).
 */
export function normalizeTemperaturePolicy(
  rawTemp: unknown,
  forceOnReasoning = false,
): TemperaturePolicy {
  if (rawTemp === undefined || rawTemp === null) {
    return { mode: 'omit' };
  }
  if (typeof rawTemp === 'object') {
    const obj = rawTemp as Record<string, unknown>;
    if (obj.mode === 'omit') return { mode: 'omit' };
    if (obj.mode === 'custom') {
      const val = Number.parseFloat(String(obj.value ?? ''));
      if (Number.isFinite(val)) {
        return {
          mode: 'custom',
          value: clampTemperature(val),
          ...(obj.forceOnReasoning ? { forceOnReasoning: true } : {}),
        };
      }
      return { mode: 'omit' };
    }
  }
  const str = String(rawTemp).trim();
  if (!str) {
    return { mode: 'omit' };
  }
  const parsed = Number.parseFloat(str);
  if (!Number.isFinite(parsed)) {
    return { mode: 'omit' };
  }
  return {
    mode: 'custom',
    value: clampTemperature(parsed),
    ...(forceOnReasoning ? { forceOnReasoning: true } : {}),
  };
}

function clampTemperature(val: number): number {
  const clamped = Math.max(0, Math.min(2, val));
  return Math.round(clamped * 1000) / 1000;
}

export function makeCapabilityKey(endpointOrOrigin: string, model: string): string {
  let origin = String(endpointOrOrigin ?? '').trim();
  try {
    if (origin) {
      const normalized = /^https?:\/\//i.test(origin) ? origin : `https://${origin}`;
      origin = new URL(normalized).origin.toLowerCase();
    }
  } catch {
    origin = origin.toLowerCase();
  }
  return `${origin}::${String(model ?? '').trim().toLowerCase()}`;
}

export function resolveEffectiveTemperature(params: {
  model: string;
  providerPolicy: TemperaturePolicy;
  assistantPolicy?: TemperaturePolicy;
  cachedCapability?: ModelCapabilityEntry;
}): ResolvedTemperature {
  const { model, providerPolicy, assistantPolicy, cachedCapability } = params;

  if (cachedCapability?.supportsTemperature === false) {
    return { value: undefined, trace: 'omitted-capability-cache' };
  }

  const strictModel = isStrictTemperatureModel(model);

  if (providerPolicy.mode === 'custom' && Number.isFinite(providerPolicy.value)) {
    if (strictModel && !providerPolicy.forceOnReasoning) {
      return { value: undefined, trace: 'omitted-reasoning-guard' };
    }
    return { value: providerPolicy.value, trace: 'sent-provider-custom' };
  }

  if (assistantPolicy?.mode === 'custom' && Number.isFinite(assistantPolicy.value)) {
    if (strictModel) {
      return { value: undefined, trace: 'omitted-reasoning-guard' };
    }
    return { value: assistantPolicy.value, trace: 'sent-assistant-custom' };
  }

  return { value: undefined, trace: 'omitted-default' };
}

export function shouldStripTemperatureAndRetry(
  httpStatus: number,
  errorBodyText: string,
  sentPayloadHadTemperature: boolean,
): boolean {
  if (!sentPayloadHadTemperature) return false;
  if (httpStatus !== 400 && httpStatus !== 422) return false;
  return UNSUPPORTED_TEMP_ERROR_RE.test(String(errorBodyText ?? ''));
}

export function shouldStripReasoningEffortAndRetry(
  httpStatus: number,
  errorBodyText: string,
  sentPayloadHadReasoningEffort: boolean,
): boolean {
  if (!sentPayloadHadReasoningEffort) return false;
  if (httpStatus !== 400 && httpStatus !== 422) return false;
  return UNSUPPORTED_REASONING_EFFORT_ERROR_RE.test(String(errorBodyText ?? ''));
}
