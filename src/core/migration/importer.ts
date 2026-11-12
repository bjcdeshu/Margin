import {
  BUILTIN_ASSISTANTS,
  PROVIDER_PRESETS,
  createDefaultMarginConfig,
} from '@shared/constants';
import {
  isStrictTemperatureModel,
  normalizeTemperaturePolicy,
} from '@shared/temperature';
import type {
  AssistantConfig,
  DisplayMode,
  GlossaryEntry,
  HoverModifierKey,
  LegacyImportAuditItem,
  LegacyImportResult,
  MarginConfig,
  PromptCodecId,
  ProviderConfig,
  ProviderPreset,
  SelectionTriggerMode,
  SubtitleStylePreset,
  TemperaturePolicy,
  ThemePatternRule,
  ThinkingPolicy,
  TranslationScene,
  TranslationTheme,
  UiColorMode,
  WireProtocol,
} from '@shared/types';
import { REDACTED_PLACEHOLDER } from './exporter';

const VALID_THEMES = new Set<TranslationTheme>([
  'none',
  'mask',
  'opacity',
  'weakening',
]);

const VALID_CODECS = new Set<PromptCodecId>([
  'yaml',
  'delimiter',
  'json-batch',
  'single-text',
]);

const VALID_PRESETS = new Set<ProviderPreset>([
  'openai',
  'deepseek',
  'zhipu',
  'anthropic',
  'deeplx',
  'google-free',
  'custom',
]);

const VALID_PROTOCOLS = new Set<WireProtocol>([
  'openai-chat',
  'anthropic-messages',
  'deeplx',
  'google-web',
]);

const UNSUPPORTED_PROPRIETARY_MT_IDS = new Set([
  'bing',
  'baidu',
  'deepl',
  'volc',
  'tencent',
  'caiyun',
  'youdao',
  'papago',
  'yandex',
  'niutrans',
  'transmart',
  'azure',
  'amazon',
  'ibm',
  'sogou',
  'alibaba',
]);

const KNOWN_OAPI_COMPAT_ENDPOINTS: Readonly<Record<string, string>> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
  siliconcloud: 'https://api.siliconflow.cn/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  moonshot: 'https://api.moonshot.cn/v1/chat/completions',
  kimi: 'https://api.moonshot.cn/v1/chat/completions',
  ollama: 'http://127.0.0.1:11434/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  grok: 'https://api.x.ai/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
};

const OAPI_COMPAT_HINTS = new Set([
  'ai',
  'custom',
  'custom-ai',
  'oapi',
  'openai-compatible',
  'openrouter',
  'siliconflow',
  'siliconcloud',
  'groq',
  'moonshot',
  'kimi',
  'qwen',
  'dashscope',
  'yi',
  'doubao',
  'ark',
  'ollama',
  'xai',
  'grok',
  'mistral',
  'gemini-openai',
  'azure-openai',
]);

const DEPRECATED_LEGACY_KEYS: ReadonlyArray<{
  key: string;
  label: string;
}> = [
  { key: 'pcFloatBall', label: 'desktop floating ball (pcFloatBall)' },
  { key: 'monkeyH5FloatBall', label: 'mobile/H5 floating ball (monkeyH5FloatBall)' },
  { key: 'sidePanel', label: 'browser side panel (sidePanel)' },
  { key: 'enableSidePanel', label: 'browser side panel toggle (enableSidePanel)' },
  { key: 'sidePanelConfig', label: 'browser side panel config (sidePanelConfig)' },
];

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function nonEmptyString(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function splitMultiValues(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pushOne = (item: unknown) => {
    if (typeof item !== 'string') return;
    for (const part of item.split(/[,\r\n]+/)) {
      const trimmed = part.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) pushOne(entry);
  } else if (typeof raw === 'string') {
    pushOne(raw);
  }
  return out;
}

function toPositiveInt(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const num = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(num) || num < 1) return fallback;
  return Math.floor(num);
}

function parseRawInputObject(
  rawInput: string | Record<string, unknown>,
): Record<string, unknown> {
  if (typeof rawInput === 'string') {
    const cleaned = rawInput.replace(/^\uFEFF/, '').trim();
    if (!cleaned) {
      throw new Error('Configuration input is empty.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON configuration: ${detail}`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error('Invalid configuration JSON: root value must be a JSON object.');
    }
    return parsed;
  }

  if (!isPlainObject(rawInput)) {
    throw new Error('Invalid configuration input: expected a JSON string or plain object.');
  }
  return rawInput;
}

function unwrapEnvelopeIfNeeded(
  root: Record<string, unknown>,
  audit: LegacyImportAuditItem[],
): Record<string, unknown> {
  const knownRootKeys = [
    'schemaVersion',
    'providers',
    'routing',
    'translationServices',
    'userTranslationServices',
    'customAiAssistants',
    'aiAssistants',
    'generalRule',
    'translationTheme',
    'translationUrlPattern',
    'terms',
    'glossary',
    'targetLanguage',
    'enableInputTranslation',
  ];
  if (knownRootKeys.some((k) => k in root)) {
    return root;
  }
  for (const wrapperKey of ['userCustomConfig', 'localConfig', 'config']) {
    const candidate = root[wrapperKey];
    if (isPlainObject(candidate) && knownRootKeys.some((k) => k in candidate)) {
      audit.push({
        level: 'info',
        code: 'unwrapped-storage-envelope',
        message: `Unwrapped nested configuration object from "${wrapperKey}".`,
      });
      return candidate;
    }
  }
  return root;
}

function normalizeInterfaceLang(
  raw: unknown,
  fallback: 'zh-CN' | 'en',
): 'zh-CN' | 'en' {
  const s = nonEmptyString(raw)?.toLowerCase();
  if (!s) return fallback;
  if (s === 'en' || s.startsWith('en-')) return 'en';
  if (s === 'zh' || s.startsWith('zh-') || s.startsWith('zh_')) return 'zh-CN';
  return fallback;
}

function normalizeTargetOrSourceLang(raw: unknown, fallback: string): string {
  const s = nonEmptyString(raw);
  if (!s) return fallback;
  const lower = s.toLowerCase();
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans') return 'zh-CN';
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant') return 'zh-TW';
  if (lower === 'auto') return 'auto';
  return s;
}

function detectAssistantCodec(raw: Record<string, unknown>): PromptCodecId {
  if (typeof raw.codec === 'string' && VALID_CODECS.has(raw.codec as PromptCodecId)) {
    return raw.codec as PromptCodecId;
  }

  const promptTexts = [
    raw.prompt,
    raw.multiplePrompt,
    raw.subtitlePrompt,
    raw.systemPrompt,
    raw.multipleSystemPrompt,
  ]
    .filter((v): v is string => typeof v === 'string')
    .join('\n');

  const envObj = isPlainObject(raw.env) ? raw.env : undefined;
  const hasYamlTemplate =
    /\{\{\s*yaml\s*\}\}|<\/?yaml>/i.test(promptTexts) ||
    Boolean(envObj && ('imt_yaml_item' in envObj || 'imt_subtitle_yaml_item' in envObj));

  if (hasYamlTemplate) {
    return 'yaml';
  }

  const sepText =
    typeof raw.translationTextSeparator === 'string'
      ? raw.translationTextSeparator
      : typeof raw.separator === 'string'
        ? raw.separator
        : '';

  const hasDelimiter =
    promptTexts.includes('%%') ||
    sepText.includes('%%') ||
    Boolean(nonEmptyString(raw.multiplePrompt));

  if (hasDelimiter) {
    return 'delimiter';
  }

  return 'json-batch';
}

interface AssistantImportContext {
  audit: LegacyImportAuditItem[];
  onNormalized: () => void;
}

function normalizeLegacyAssistant(
  fallbackId: string,
  raw: Record<string, unknown>,
  ctx: AssistantImportContext,
): AssistantConfig {
  const id = nonEmptyString(raw.id) ?? fallbackId;
  const name = nonEmptyString(raw.name) ?? id;
  const codec = detectAssistantCodec(raw);

  const defaultBatch = codec === 'yaml' ? 17 : codec === 'delimiter' ? 6 : 8;
  const defaultChars = codec === 'yaml' ? 4096 : 1800;

  const maxBatchCount = toPositiveInt(
    raw.maxBatchCount ?? raw.maxTextGroupLengthPerRequest,
    defaultBatch,
  );
  const maxSubtitleBatchCount = toPositiveInt(
    raw.maxSubtitleBatchCount ??
      raw.maxTextGroupLengthPerRequestForSubtitle ??
      raw.maxTextGroupLengthPerRequest ??
      raw.maxBatchCount,
    maxBatchCount,
  );
  const maxCharsPerBatch = toPositiveInt(
    raw.maxCharsPerBatch ?? raw.maxTextLengthPerRequest,
    defaultChars,
  );

  const enableRichHtml =
    raw.enableRichHtml !== undefined
      ? Boolean(raw.enableRichHtml)
      : raw.enableRichTranslate !== undefined
        ? Boolean(raw.enableRichTranslate)
        : true;

  let temperaturePolicy: TemperaturePolicy = { mode: 'omit' };
  const hasExplicitTemperature =
    raw.temperature !== undefined &&
    raw.temperature !== null &&
    String(raw.temperature).trim() !== '';

  if (isPlainObject(raw.temperaturePolicy)) {
    temperaturePolicy = normalizeTemperaturePolicy(raw.temperaturePolicy);
  } else if (hasExplicitTemperature) {
    temperaturePolicy = normalizeTemperaturePolicy(raw.temperature);
  } else if (
    'temperatre' in raw &&
    raw.temperatre !== undefined &&
    raw.temperatre !== null &&
    String(raw.temperatre).trim() !== ''
  ) {
    temperaturePolicy = normalizeTemperaturePolicy(raw.temperatre);
    ctx.onNormalized();
    ctx.audit.push({
      level: 'normalized',
      code: 'assistant-temperatre-typo',
      message: `Normalized typo "temperatre": ${JSON.stringify(raw.temperatre)} -> temperaturePolicy (${
        temperaturePolicy.mode === 'custom' ? temperaturePolicy.value : 'omit'
      }) on assistant "${id}" (${name}).`,
    });
  }

  const separator =
    typeof raw.translationTextSeparator === 'string' && raw.translationTextSeparator.length > 0
      ? raw.translationTextSeparator
      : typeof raw.separator === 'string' && raw.separator.length > 0
        ? raw.separator
        : '\n\n%%\n\n';

  const systemPrompt = typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '';
  const multipleSystemPrompt =
    typeof raw.multipleSystemPrompt === 'string' ? raw.multipleSystemPrompt : undefined;
  const multiplePrompt =
    typeof raw.multiplePrompt === 'string' ? raw.multiplePrompt : undefined;
  const rawPrompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  const prompt = rawPrompt || multiplePrompt || '';
  const subtitlePrompt =
    typeof raw.subtitlePrompt === 'string' ? raw.subtitlePrompt : undefined;

  const env: Record<string, string> = {};
  if (isPlainObject(raw.env)) {
    for (const [k, v] of Object.entries(raw.env)) {
      if (v !== undefined && v !== null) {
        env[k] = String(v);
      }
    }
  }

  const assistant: AssistantConfig = {
    id,
    name,
    codec,
    enableRichHtml,
    temperaturePolicy,
    maxBatchCount,
    maxSubtitleBatchCount,
    maxCharsPerBatch,
    separator,
    systemPrompt,
    prompt,
    env,
  };

  if (multipleSystemPrompt !== undefined) {
    assistant.multipleSystemPrompt = multipleSystemPrompt;
  }
  if (multiplePrompt !== undefined) {
    assistant.multiplePrompt = multiplePrompt;
  }
  if (subtitlePrompt !== undefined) {
    assistant.subtitlePrompt = subtitlePrompt;
  }

  return assistant;
}

function collectRawAssistants(
  source: unknown,
  into: Map<string, Record<string, unknown>>,
): void {
  if (Array.isArray(source)) {
    source.forEach((entry, idx) => {
      if (!isPlainObject(entry) || entry.isDeleted === true) return;
      const id = nonEmptyString(entry.id) ?? `custom-${idx + 1}`;
      into.set(id, entry);
    });
  } else if (isPlainObject(source)) {
    for (const [key, entry] of Object.entries(source)) {
      if (!isPlainObject(entry) || entry.isDeleted === true) continue;
      const id = nonEmptyString(entry.id) ?? key;
      into.set(id, entry);
    }
  }
}

interface ResolvedPresetProtocol {
  preset: ProviderPreset;
  protocol: WireProtocol;
  defaultBaseUrl: string;
}

function resolveLegacyProviderKind(
  serviceId: string,
  rawSvc: Record<string, unknown>,
): ResolvedPresetProtocol | null {
  if (
    typeof rawSvc.preset === 'string' &&
    VALID_PRESETS.has(rawSvc.preset as ProviderPreset) &&
    typeof rawSvc.protocol === 'string' &&
    VALID_PROTOCOLS.has(rawSvc.protocol as WireProtocol)
  ) {
    const preset = rawSvc.preset as ProviderPreset;
    return {
      preset,
      protocol: rawSvc.protocol as WireProtocol,
      defaultBaseUrl: PROVIDER_PRESETS[preset].defaultEndpoint,
    };
  }

  const ext = nonEmptyString(rawSvc.extends)?.toLowerCase() ?? '';
  const type = nonEmptyString(rawSvc.type)?.toLowerCase() ?? '';
  const idLower = serviceId.toLowerCase();
  const primaryHint = ext || type || idLower;

  if (
    primaryHint === 'google-free' ||
    primaryHint === 'google' ||
    idLower === 'google-free' ||
    idLower === 'google'
  ) {
    return {
      preset: 'google-free',
      protocol: 'google-web',
      defaultBaseUrl: PROVIDER_PRESETS['google-free'].defaultEndpoint,
    };
  }

  if (
    primaryHint === 'deeplx' ||
    primaryHint.startsWith('deeplx-') ||
    idLower === 'deeplx' ||
    idLower.startsWith('deeplx-')
  ) {
    return {
      preset: 'deeplx',
      protocol: 'deeplx',
      defaultBaseUrl: PROVIDER_PRESETS.deeplx.defaultEndpoint,
    };
  }

  if (
    primaryHint === 'claude' ||
    primaryHint === 'anthropic' ||
    primaryHint.startsWith('claude-') ||
    primaryHint.startsWith('anthropic-') ||
    idLower.startsWith('claude-') ||
    idLower.startsWith('anthropic-')
  ) {
    return {
      preset: 'anthropic',
      protocol: 'anthropic-messages',
      defaultBaseUrl: PROVIDER_PRESETS.anthropic.defaultEndpoint,
    };
  }

  if (
    primaryHint === 'zhipu' ||
    primaryHint === 'chatglm' ||
    primaryHint === 'glm' ||
    primaryHint.startsWith('zhipu-') ||
    idLower.startsWith('zhipu-')
  ) {
    return {
      preset: 'zhipu',
      protocol: 'openai-chat',
      defaultBaseUrl: PROVIDER_PRESETS.zhipu.defaultEndpoint,
    };
  }

  if (
    primaryHint === 'deepseek' ||
    primaryHint.startsWith('deepseek-') ||
    idLower.startsWith('deepseek-')
  ) {
    return {
      preset: 'deepseek',
      protocol: 'openai-chat',
      defaultBaseUrl: PROVIDER_PRESETS.deepseek.defaultEndpoint,
    };
  }

  if (
    primaryHint === 'openai' ||
    primaryHint.startsWith('openai-') ||
    idLower.startsWith('openai-')
  ) {
    return {
      preset: 'openai',
      protocol: 'openai-chat',
      defaultBaseUrl: PROVIDER_PRESETS.openai.defaultEndpoint,
    };
  }

  if (OAPI_COMPAT_HINTS.has(primaryHint)) {
    return {
      preset: 'custom',
      protocol: 'openai-chat',
      defaultBaseUrl:
        KNOWN_OAPI_COMPAT_ENDPOINTS[primaryHint] ?? PROVIDER_PRESETS.custom.defaultEndpoint,
    };
  }

  const explicitApiUrl = nonEmptyString(rawSvc.apiUrl ?? rawSvc.baseUrl);
  const hasAiSignals = Boolean(
    explicitApiUrl ||
      nonEmptyString(rawSvc.APIKEY ?? rawSvc.apiKey) ||
      nonEmptyString(rawSvc.model) ||
      rawSvc.customModels !== undefined,
  );

  if (UNSUPPORTED_PROPRIETARY_MT_IDS.has(primaryHint) && !explicitApiUrl) {
    return null;
  }

  if (hasAiSignals) {
    if (explicitApiUrl && /anthropic\.com|\/v1\/messages\b/i.test(explicitApiUrl)) {
      return {
        preset: 'anthropic',
        protocol: 'anthropic-messages',
        defaultBaseUrl: PROVIDER_PRESETS.anthropic.defaultEndpoint,
      };
    }
    return {
      preset: 'custom',
      protocol: 'openai-chat',
      defaultBaseUrl: PROVIDER_PRESETS.custom.defaultEndpoint,
    };
  }

  return null;
}

function shouldSkipUnconfiguredLegacyService(
  rawSvc: Record<string, unknown>,
  kind: ResolvedPresetProtocol,
): boolean {
  const hasAnyKeyOrEndpoint = Boolean(
    nonEmptyString(rawSvc.APIKEY) ||
      nonEmptyString(rawSvc.apiKey) ||
      (Array.isArray(rawSvc.apiKeys) && rawSvc.apiKeys.length > 0) ||
      nonEmptyString(rawSvc.apiUrl) ||
      nonEmptyString(rawSvc.baseUrl) ||
      nonEmptyString(rawSvc.url) ||
      (Array.isArray(rawSvc.endpoints) && rawSvc.endpoints.length > 0),
  );

  if (rawSvc.visible === false && !hasAnyKeyOrEndpoint) {
    return true;
  }

  const requiresKey = PROVIDER_PRESETS[kind.preset].requiresApiKey;
  if (requiresKey && !hasAnyKeyOrEndpoint) {
    const hasCustomModelOrAssistant = Boolean(
      nonEmptyString(rawSvc.model) ||
        splitMultiValues(rawSvc.customModels).length > 0 ||
        splitMultiValues(rawSvc.models).length > 0 ||
        nonEmptyString(rawSvc.assistantId),
    );
    if (!hasCustomModelOrAssistant) {
      return true;
    }
  }

  return false;
}

function resolveLegacyProviderTemperature(
  serviceId: string,
  model: string,
  preset: ProviderPreset,
  rawSvc: Record<string, unknown>,
  ctx: AssistantImportContext,
): TemperaturePolicy {
  if (isPlainObject(rawSvc.temperaturePolicy)) {
    return normalizeTemperaturePolicy(rawSvc.temperaturePolicy);
  }

  if (
    preset === 'zhipu' &&
    isPlainObject(rawSvc.bodyConfigs) &&
    rawSvc.bodyConfigs.temperature === 0.01
  ) {
    ctx.onNormalized();
    ctx.audit.push({
      level: 'normalized',
      code: 'provider-zhipu-legacy-temp-stripped',
      message: `Stripped legacy Zhipu hardcoded bodyConfigs.temperature (0.01) on provider "${serviceId}".`,
    });
  }

  const rawTemp =
    rawSvc.temperature !== undefined ? rawSvc.temperature : rawSvc.temperatre;

  if (
    rawSvc.temperature === undefined &&
    rawSvc.temperatre !== undefined &&
    rawSvc.temperatre !== null &&
    String(rawSvc.temperatre).trim() !== ''
  ) {
    const policy = normalizeTemperaturePolicy(rawSvc.temperatre);
    ctx.onNormalized();
    ctx.audit.push({
      level: 'normalized',
      code: 'provider-temperatre-typo',
      message: `Normalized typo "temperatre" -> temperaturePolicy on provider "${serviceId}".`,
    });
    return policy;
  }

  if (rawTemp === undefined || rawTemp === null || String(rawTemp).trim() === '') {
    return { mode: 'omit' };
  }

  // Legacy Immersive Translate Options UI schema Q3 set string `default: "0"`,
  // causing untouched custom services to serialize `"0"` (or `0` on reasoning models)
  // and fail with HTTP 400 on strict reasoning models. Normalize untouched `"0"` to `omit`.
  if (
    rawTemp === '0' ||
    (rawTemp === 0 && isStrictTemperatureModel(model))
  ) {
    ctx.onNormalized();
    ctx.audit.push({
      level: 'normalized',
      code: 'provider-legacy-zero-temperature-omitted',
      message: `Normalized legacy default temperature (${JSON.stringify(
        rawTemp,
      )}) -> omit on provider "${serviceId}" (${model}).`,
    });
    return { mode: 'omit' };
  }

  return normalizeTemperaturePolicy(rawTemp);
}

function resolveLegacyThinkingPolicy(rawSvc: Record<string, unknown>): ThinkingPolicy {
  if (isPlainObject(rawSvc.thinkingPolicy)) {
    const mode = rawSvc.thinkingPolicy.mode;
    if (mode === 'disabled') return { mode: 'disabled' };
    if (mode === 'enabled') {
      const budget = toPositiveInt(rawSvc.thinkingPolicy.budgetTokens, 0);
      return budget > 0 ? { mode: 'enabled', budgetTokens: budget } : { mode: 'enabled' };
    }
    return { mode: 'provider-default' };
  }

  if (isPlainObject(rawSvc.bodyConfigs)) {
    const bc = rawSvc.bodyConfigs;
    if (bc.enable_thinking === false) {
      return { mode: 'disabled' };
    }
    if (isPlainObject(bc.thinking)) {
      if (bc.thinking.type === 'disabled') return { mode: 'disabled' };
      if (bc.thinking.type === 'enabled') {
        const budget = toPositiveInt(bc.thinking.budget_tokens, 0);
        return budget > 0 ? { mode: 'enabled', budgetTokens: budget } : { mode: 'enabled' };
      }
    }
  }

  return { mode: 'provider-default' };
}

function normalizeLegacyProvider(
  serviceId: string,
  rawSvc: Record<string, unknown>,
  kind: ResolvedPresetProtocol,
  knownAssistants: Record<string, AssistantConfig>,
  ctx: AssistantImportContext,
): ProviderConfig {
  const presetMeta = PROVIDER_PRESETS[kind.preset];
  const name = nonEmptyString(rawSvc.name) ?? presetMeta.label;
  const enabled =
    rawSvc.enabled !== undefined
      ? Boolean(rawSvc.enabled)
      : rawSvc.visible !== undefined
        ? Boolean(rawSvc.visible)
        : true;

  const apiKeys =
    Array.isArray(rawSvc.apiKeys)
      ? splitMultiValues(rawSvc.apiKeys)
      : splitMultiValues(rawSvc.APIKEY ?? rawSvc.apiKey ?? rawSvc.token);

  let baseUrl: string;
  let endpoints: string[] | undefined;

  if (kind.protocol === 'deeplx') {
    const parsedEndpoints = Array.isArray(rawSvc.endpoints)
      ? splitMultiValues(rawSvc.endpoints)
      : splitMultiValues(rawSvc.url ?? rawSvc.apiUrl ?? rawSvc.baseUrl);
    endpoints = parsedEndpoints.length > 0 ? parsedEndpoints : [kind.defaultBaseUrl];
    baseUrl = endpoints[0];
  } else {
    baseUrl =
      nonEmptyString(rawSvc.apiUrl) ??
      nonEmptyString(rawSvc.baseUrl) ??
      kind.defaultBaseUrl;
  }

  const explicitModel = nonEmptyString(rawSvc.model) ?? '';
  const mergedModels = splitMultiValues([
    explicitModel,
    ...splitMultiValues(rawSvc.customModels),
    ...splitMultiValues(rawSvc.models),
  ]);
  const model = explicitModel || mergedModels[0] || presetMeta.defaultModel;
  const models = mergedModels.length > 0 ? mergedModels : [model];
  if (!models.includes(model)) {
    models.unshift(model);
  }

  const rawAssistantId = nonEmptyString(rawSvc.assistantId);
  const assistantId =
    rawAssistantId && (rawAssistantId !== 'default' || Boolean(knownAssistants.default))
      ? rawAssistantId
      : undefined;

  const enableContext = Boolean(rawSvc.enableAIContext ?? rawSvc.enableContext ?? false);
  const enableRichHtml =
    rawSvc.enableRichHtml !== undefined
      ? Boolean(rawSvc.enableRichHtml)
      : rawSvc.enableRichTranslate !== undefined
        ? Boolean(rawSvc.enableRichTranslate)
        : true;

  let stream: 'auto' | 'on' | 'off';
  if (rawSvc.stream === 'on' || rawSvc.stream === true) {
    stream = 'on';
  } else if (rawSvc.stream === 'off' || rawSvc.stream === false) {
    stream = 'off';
  } else if (kind.protocol === 'deeplx' || kind.protocol === 'google-web') {
    stream = 'off';
  } else {
    stream = 'auto';
  }

  const defaultRps =
    kind.protocol === 'google-web' || kind.protocol === 'deeplx' ? 15 : 10;
  const rateLimitRps = toPositiveInt(
    rawSvc.rateLimitRps ?? rawSvc.limit ?? rawSvc.maxRequestsPerSecond,
    defaultRps,
  );
  const maxConcurrency = toPositiveInt(
    rawSvc.maxConcurrency ?? rawSvc.concurrency,
    4,
  );

  const temperaturePolicy = resolveLegacyProviderTemperature(
    serviceId,
    model,
    kind.preset,
    rawSvc,
    ctx,
  );
  const thinkingPolicy = resolveLegacyThinkingPolicy(rawSvc);

  const provider: ProviderConfig = {
    id: serviceId,
    name,
    preset: kind.preset,
    protocol: kind.protocol,
    enabled,
    baseUrl,
    ...(endpoints ? { endpoints } : {}),
    apiKeys,
    model,
    models,
    ...(assistantId ? { assistantId } : {}),
    enableContext,
    enableRichHtml,
    stream,
    rateLimitRps,
    maxConcurrency,
    temperaturePolicy,
    thinkingPolicy,
  };

  const maxBatchCount = toPositiveInt(
    rawSvc.maxBatchCount ?? rawSvc.maxTextGroupLengthPerRequest,
    0,
  );
  if (maxBatchCount > 0) {
    provider.maxBatchCount = maxBatchCount;
  }

  const maxSubtitleBatchCount = toPositiveInt(
    rawSvc.maxSubtitleBatchCount ?? rawSvc.maxTextGroupLengthPerRequestForSubtitle,
    0,
  );
  if (maxSubtitleBatchCount > 0) {
    provider.maxSubtitleBatchCount = maxSubtitleBatchCount;
  }

  const maxCharsPerBatch = toPositiveInt(
    rawSvc.maxCharsPerBatch ?? rawSvc.maxTextLengthPerRequest,
    0,
  );
  if (maxCharsPerBatch > 0) {
    provider.maxCharsPerBatch = maxCharsPerBatch;
  }

  const rawHeaders = rawSvc.extraHeaders ?? rawSvc.customHeaders ?? rawSvc.headers;
  if (isPlainObject(rawHeaders)) {
    const extraHeaders: Record<string, string> = {};
    for (const [hk, hv] of Object.entries(rawHeaders)) {
      if (hk.includes('.remove') || hv === undefined || hv === null) continue;
      extraHeaders[hk] = String(hv);
    }
    if (Object.keys(extraHeaders).length > 0) {
      provider.extraHeaders = extraHeaders;
    }
  }

  return provider;
}

function pickFirstNonEmpty(
  obj: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const val = nonEmptyString(obj[key]);
    if (val) {
      return { key, value: val };
    }
  }
  return undefined;
}

function selectFallbackWebpageProvider(
  providers: Record<string, ProviderConfig>,
  providerOrder: readonly string[],
): string {
  for (const id of providerOrder) {
    const p = providers[id];
    if (p && p.enabled && id !== 'google-free') {
      return id;
    }
  }
  for (const id of providerOrder) {
    const p = providers[id];
    if (p && p.enabled) {
      return id;
    }
  }
  if (providers['google-free']) return 'google-free';
  return Object.keys(providers)[0] ?? 'google-free';
}

function resolveLegacyRouting(
  raw: Record<string, unknown>,
  providers: Record<string, ProviderConfig>,
  providerOrder: readonly string[],
  ctx: AssistantImportContext,
): MarginConfig['routing'] {
  const uts = isPlainObject(raw.userTranslationServices)
    ? raw.userTranslationServices
    : {};

  const utsWeb = nonEmptyString(uts.translationService);
  const topWeb = nonEmptyString(raw.translationService);

  if (utsWeb && topWeb && utsWeb !== topWeb) {
    ctx.onNormalized();
    ctx.audit.push({
      level: 'normalized',
      code: 'routing-uts-override',
      message: `Resolved webpage routing from userTranslationServices.translationService ("${utsWeb}"), overriding stale top-level translationService ("${topWeb}").`,
    });
  }

  let webpageCandidate = utsWeb ?? topWeb;
  let webpage: string;

  if (
    webpageCandidate &&
    webpageCandidate !== 'inherit' &&
    providers[webpageCandidate]?.enabled
  ) {
    webpage = webpageCandidate;
  } else if (
    utsWeb &&
    topWeb &&
    topWeb !== 'inherit' &&
    providers[topWeb]?.enabled
  ) {
    webpage = topWeb;
    ctx.audit.push({
      level: 'warning',
      code: 'routing-webpage-fallback',
      message: `Configured webpage service "${utsWeb}" was deleted or disabled; fell back to "${webpage}".`,
    });
  } else {
    webpage = selectFallbackWebpageProvider(providers, providerOrder);
    if (webpageCandidate && webpageCandidate !== webpage) {
      ctx.audit.push({
        level: 'warning',
        code: 'routing-webpage-fallback',
        message: `Configured webpage service "${webpageCandidate}" was unavailable; fell back safely to "${webpage}".`,
      });
    }
  }

  const secondaryScenes: ReadonlyArray<{
    scene: Exclude<TranslationScene, 'webpage'>;
    keys: readonly string[];
  }> = [
    { scene: 'input', keys: ['inputTranslationService'] },
    {
      scene: 'subtitle',
      keys: ['subtitleTranslateService', 'subtitleTranslationService'],
    },
    {
      scene: 'hover',
      keys: ['mouseHoverTranslationService', 'hoverTranslationService'],
    },
    { scene: 'selection', keys: ['selectionTranslationService'] },
    { scene: 'pdf', keys: ['pdfTranslationService', 'pdfTranslateService'] },
    {
      scene: 'image',
      keys: ['imageTranslationService', 'clientImageTranslationService'],
    },
  ];

  const routing: MarginConfig['routing'] = {
    webpage,
    input: 'inherit',
    subtitle: 'inherit',
    hover: 'inherit',
    selection: 'inherit',
    pdf: 'inherit',
    image: 'inherit',
  };

  for (const { scene, keys } of secondaryScenes) {
    const fromUts = pickFirstNonEmpty(uts, keys);
    const fromTop = pickFirstNonEmpty(raw, keys);

    if (fromUts && fromTop && fromUts.value !== fromTop.value) {
      ctx.onNormalized();
      const targetDesc =
        fromUts.value === 'inherit'
          ? `"inherit" (-> "${webpage}")`
          : `"${fromUts.value}"`;
      ctx.audit.push({
        level: 'normalized',
        code: 'routing-uts-override',
        message: `Resolved ${scene} routing from userTranslationServices.${fromUts.key} (${targetDesc}), overriding stale top-level ${fromTop.key} ("${fromTop.value}").`,
      });
    }

    const chosen = fromUts?.value ?? fromTop?.value ?? 'inherit';
    if (chosen === 'inherit') {
      routing[scene] = 'inherit';
    } else if (providers[chosen]?.enabled) {
      routing[scene] = chosen;
    } else {
      routing[scene] = 'inherit';
      ctx.audit.push({
        level: 'warning',
        code: 'routing-scene-fallback-inherit',
        message: `Configured ${scene} service "${chosen}" was unavailable; fell back to "inherit" (-> "${webpage}").`,
      });
    }
  }

  return routing;
}

function parseGlossaryEntries(
  rawTerms: unknown,
  audit: LegacyImportAuditItem[],
): GlossaryEntry[] {
  const deduped = new Map<string, GlossaryEntry>();

  const pushRawEntry = (item: unknown, groupDomain?: string) => {
    if (!isPlainObject(item)) return;
    const k = nonEmptyString(item.k ?? item.key ?? item.source);
    if (!k) return;
    const rawV =
      item.v !== undefined && item.v !== null
        ? String(item.v)
        : item.value !== undefined && item.value !== null
          ? String(item.value)
          : item.target !== undefined && item.target !== null
            ? String(item.target)
            : '';
    const domain = nonEmptyString(item.domain) ?? groupDomain;
    const caseSensitive =
      typeof item.caseSensitive === 'boolean' ? item.caseSensitive : undefined;

    const entry: GlossaryEntry = {
      k,
      v: rawV,
      ...(domain ? { domain } : {}),
      ...(caseSensitive !== undefined ? { caseSensitive } : {}),
    };
    const dedupKey = `${k}::${domain ?? ''}::${caseSensitive ? '1' : '0'}`;
    deduped.set(dedupKey, entry);
  };

  const ingestCollection = (collection: unknown, groupDomain?: string) => {
    if (Array.isArray(collection)) {
      for (const item of collection) {
        if (Array.isArray(item) && item.length >= 1) {
          pushRawEntry(
            { k: item[0], v: item.length >= 2 ? item[1] : '' },
            groupDomain,
          );
        } else {
          pushRawEntry(item, groupDomain);
        }
      }
    } else if (isPlainObject(collection)) {
      for (const [k, val] of Object.entries(collection)) {
        if (typeof val === 'string') {
          pushRawEntry({ k, v: val }, groupDomain);
        } else if (isPlainObject(val)) {
          pushRawEntry({ k, ...val }, groupDomain);
        }
      }
    }
  };

  if (Array.isArray(rawTerms)) {
    ingestCollection(rawTerms);
  } else if (isPlainObject(rawTerms)) {
    if (Array.isArray(rawTerms.data)) {
      for (const group of rawTerms.data) {
        if (!isPlainObject(group)) continue;
        if (group.active === false || group.enabled === false) {
          const groupName = nonEmptyString(group.name ?? group.id) ?? 'unnamed';
          audit.push({
            level: 'ignored',
            code: 'glossary-inactive-group-skipped',
            message: `Skipped inactive glossary group "${groupName}".`,
          });
          continue;
        }
        const groupDomain = nonEmptyString(group.domain ?? group.urlPattern);
        ingestCollection(
          group.glossaries ?? group.terms ?? group.items,
          groupDomain,
        );
      }
    } else if (Array.isArray(rawTerms.glossaries)) {
      ingestCollection(rawTerms.glossaries, nonEmptyString(rawTerms.domain));
    } else {
      ingestCollection(rawTerms);
    }
  }

  return Array.from(deduped.values());
}

function normalizeTranslationTheme(
  rawTheme: unknown,
  fallback: TranslationTheme,
  ctx?: AssistantImportContext,
): TranslationTheme {
  const s = nonEmptyString(rawTheme)?.toLowerCase();
  if (!s) return fallback;
  if (VALID_THEMES.has(s as TranslationTheme)) {
    return s as TranslationTheme;
  }
  if (s === 'blur' || s === 'spoiler') return 'mask';
  if (s === 'transparent' || s === 'fade') return 'opacity';

  if (ctx) {
    ctx.onNormalized();
    ctx.audit.push({
      level: 'normalized',
      code: 'theme-unsupported-fallback',
      message: `Normalized legacy decorative theme "${String(rawTheme)}" -> "none".`,
    });
  }
  return 'none';
}

function parseThemePatterns(
  rawPatterns: unknown,
  ctx: AssistantImportContext,
): ThemePatternRule[] {
  const rules: ThemePatternRule[] = [];
  const seen = new Set<string>();

  const addRule = (pattern: unknown, rawTheme: unknown) => {
    const p = nonEmptyString(pattern);
    if (!p) return;
    const theme = normalizeTranslationTheme(rawTheme, 'none', ctx);
    const key = `${p}::${theme}`;
    if (!seen.has(key)) {
      seen.add(key);
      rules.push({ pattern: p, theme });
    }
  };

  if (Array.isArray(rawPatterns)) {
    for (const item of rawPatterns) {
      if (!isPlainObject(item)) continue;
      const theme = item.theme ?? item.translationTheme;
      if (Array.isArray(item.matches)) {
        for (const m of item.matches) addRule(m, theme);
      } else {
        addRule(item.pattern ?? item.url ?? item.matches, theme);
      }
    }
  } else if (isPlainObject(rawPatterns)) {
    for (const [themeKey, val] of Object.entries(rawPatterns)) {
      if (Array.isArray(val)) {
        for (const m of val) addRule(m, themeKey);
      } else if (isPlainObject(val)) {
        const list =
          val.matches ?? val['matches.add'] ?? val.patterns ?? val.includeMatches;
        if (Array.isArray(list)) {
          for (const m of list) addRule(m, themeKey);
        }
      }
    }
  }

  return rules;
}

function mergeNestedRuleSection(
  generalRule: Record<string, unknown>,
  baseKey: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const direct = generalRule[baseKey];
  if (isPlainObject(direct)) {
    Object.assign(merged, direct);
    if (isPlainObject(direct.add)) Object.assign(merged, direct.add);
    if (isPlainObject(direct.modify)) Object.assign(merged, direct.modify);
  }
  const addKey = generalRule[`${baseKey}.add`];
  if (isPlainObject(addKey)) {
    Object.assign(merged, addKey);
  }
  const modKey = generalRule[`${baseKey}.modify`];
  if (isPlainObject(modKey)) {
    Object.assign(merged, modKey);
  }
  return merged;
}

function importNativeMarginV2(
  raw: Record<string, unknown>,
  baseConfig?: MarginConfig,
): LegacyImportResult {
  const config = baseConfig
    ? structuredClone(baseConfig)
    : createDefaultMarginConfig();
  const audit: LegacyImportAuditItem[] = [];
  let normalizedFields = 0;
  const ctx: AssistantImportContext = {
    audit,
    onNormalized: () => {
      normalizedFields += 1;
    },
  };

  const validColorModes = new Set<UiColorMode>(['paper', 'night', 'system']);
  if (
    typeof raw.uiColorMode === 'string' &&
    validColorModes.has(raw.uiColorMode as UiColorMode)
  ) {
    config.uiColorMode = raw.uiColorMode as UiColorMode;
  }
  config.interfaceLang = normalizeInterfaceLang(
    raw.interfaceLang,
    config.interfaceLang,
  );
  config.sourceLang = normalizeTargetOrSourceLang(raw.sourceLang, config.sourceLang);
  config.targetLang = normalizeTargetOrSourceLang(raw.targetLang, config.targetLang);

  let assistantsImported = 0;
  const nextAssistants: Record<string, AssistantConfig> = {
    ...structuredClone(BUILTIN_ASSISTANTS),
  };
  if (isPlainObject(raw.assistants)) {
    for (const [id, rawAst] of Object.entries(raw.assistants)) {
      if (!isPlainObject(rawAst)) continue;
      const normalized = normalizeLegacyAssistant(id, rawAst, ctx);
      nextAssistants[normalized.id] = normalized;
      assistantsImported += 1;
    }
  }
  config.assistants = nextAssistants;

  let providersImported = 0;
  let hasRedactedSecrets = false;
  const nextProviders: Record<string, ProviderConfig> = {};

  if (isPlainObject(raw.providers)) {
    for (const [id, rawProv] of Object.entries(raw.providers)) {
      if (!isPlainObject(rawProv)) continue;
      const kind = resolveLegacyProviderKind(id, rawProv);
      if (!kind) continue;
      const provider = normalizeLegacyProvider(
        id,
        rawProv,
        kind,
        config.assistants,
        ctx,
      );
      if (
        provider.baseUrl.includes(REDACTED_PLACEHOLDER) ||
        provider.endpoints?.some((ep) => ep.includes(REDACTED_PLACEHOLDER))
      ) {
        hasRedactedSecrets = true;
      }
      nextProviders[id] = provider;
      providersImported += 1;
    }
  }

  if (Object.keys(nextProviders).length === 0) {
    const defaults = createDefaultMarginConfig();
    nextProviders['google-free'] = defaults.providers['google-free'];
  }
  config.providers = nextProviders;

  const order: string[] = [];
  if (Array.isArray(raw.providerOrder)) {
    for (const item of raw.providerOrder) {
      if (typeof item === 'string' && config.providers[item] && !order.includes(item)) {
        order.push(item);
      }
    }
  }
  for (const id of Object.keys(config.providers)) {
    if (!order.includes(id)) {
      order.push(id);
    }
  }
  config.providerOrder = order;

  if (hasRedactedSecrets) {
    audit.push({
      level: 'warning',
      code: 'redacted-secrets-detected',
      message:
        'Imported a redacted Margin shareable config (<REDACTED> tokens present); re-enter private API keys or DeepLX tokens before translating.',
    });
  }

  let glossaryEntriesImported = 0;
  if (Array.isArray(raw.glossary)) {
    config.glossary = parseGlossaryEntries(raw.glossary, audit);
    glossaryEntriesImported = config.glossary.length;
  }

  if (isPlainObject(raw.webpage)) {
    const wp = raw.webpage;
    if (wp.displayMode === 'bilingual' || wp.displayMode === 'target-only') {
      config.webpage.displayMode = wp.displayMode;
    }
    config.webpage.theme = normalizeTranslationTheme(
      wp.theme,
      config.webpage.theme,
      ctx,
    );
    if (Array.isArray(wp.themePatterns)) {
      config.webpage.themePatterns = parseThemePatterns(wp.themePatterns, ctx);
    }
    config.webpage.lineBreakMaxTextCount = toPositiveInt(
      wp.lineBreakMaxTextCount,
      config.webpage.lineBreakMaxTextCount,
    );
    if (typeof wp.enableRichHtml === 'boolean') {
      config.webpage.enableRichHtml = wp.enableRichHtml;
    }
    if (typeof wp.autoTranslateMatches === 'boolean') {
      config.webpage.autoTranslateMatches = wp.autoTranslateMatches;
    }
  }

  if (isPlainObject(raw.input)) {
    const inp = raw.input;
    if (typeof inp.enabled === 'boolean') config.input.enabled = inp.enabled;
    if (typeof inp.tripleSpaceTrigger === 'boolean') {
      config.input.tripleSpaceTrigger = inp.tripleSpaceTrigger;
    }
    config.input.tripleSpaceWindowMs = toPositiveInt(
      inp.tripleSpaceWindowMs,
      config.input.tripleSpaceWindowMs,
    );
    config.input.targetLang = normalizeTargetOrSourceLang(
      inp.targetLang,
      config.input.targetLang,
    );
    config.input.fallbackTargetLang = normalizeTargetOrSourceLang(
      inp.fallbackTargetLang,
      config.input.fallbackTargetLang,
    );
  }

  if (isPlainObject(raw.selection)) {
    const sel = raw.selection;
    if (typeof sel.enabled === 'boolean') config.selection.enabled = sel.enabled;
    const validTriggers = new Set<SelectionTriggerMode>([
      'off',
      'icon',
      'dot',
      'instant',
    ]);
    if (
      typeof sel.triggerMode === 'string' &&
      validTriggers.has(sel.triggerMode as SelectionTriggerMode)
    ) {
      config.selection.triggerMode = sel.triggerMode as SelectionTriggerMode;
    }
  }

  if (isPlainObject(raw.hover)) {
    const hov = raw.hover;
    if (typeof hov.enabled === 'boolean') config.hover.enabled = hov.enabled;
    const validMods = new Set<HoverModifierKey>([
      'none',
      'ctrl',
      'alt',
      'shift',
      'meta',
    ]);
    if (
      typeof hov.modifierKey === 'string' &&
      validMods.has(hov.modifierKey as HoverModifierKey)
    ) {
      config.hover.modifierKey = hov.modifierKey as HoverModifierKey;
    }
    config.hover.delayMs = toPositiveInt(hov.delayMs, config.hover.delayMs);
  }

  if (isPlainObject(raw.subtitles)) {
    const sub = raw.subtitles;
    if (typeof sub.autoEnable === 'boolean') config.subtitles.autoEnable = sub.autoEnable;
    if (typeof sub.youtubeAutoEnable === 'boolean') {
      config.subtitles.youtubeAutoEnable = sub.youtubeAutoEnable;
    }
    if (typeof sub.preTranslate === 'boolean') {
      config.subtitles.preTranslate = sub.preTranslate;
    }
    if (
      sub.displayMode === 'bilingual' ||
      sub.displayMode === 'target-only' ||
      sub.displayMode === 'source-only'
    ) {
      config.subtitles.displayMode = sub.displayMode;
    }
    const legacyTransScale = Math.max(
      50,
      Math.min(160, toPositiveInt(sub.fontSizePercent, config.subtitles.fontSizePercent)),
    );
    config.subtitles.sourceScalePercent = Math.max(
      50,
      Math.min(
        160,
        toPositiveInt(sub.sourceScalePercent, config.subtitles.sourceScalePercent ?? 100),
      ),
    );
    config.subtitles.translationScalePercent = Math.max(
      50,
      Math.min(
        160,
        toPositiveInt(sub.translationScalePercent, legacyTransScale),
      ),
    );
    config.subtitles.fontSizePercent = config.subtitles.translationScalePercent;
    if (
      sub.stylePreset === 'youtube-native' ||
      sub.stylePreset === 'cinema-outline' ||
      sub.stylePreset === 'warm-paper'
    ) {
      config.subtitles.stylePreset = sub.stylePreset as SubtitleStylePreset;
    }
    if (sub.position === 'bottom' || sub.position === 'top') {
      config.subtitles.position = sub.position;
    }
  }

  if (isPlainObject(raw.urlRules)) {
    const ur = raw.urlRules;
    if (Array.isArray(ur.includeMatches)) {
      config.urlRules.includeMatches = splitMultiValues(ur.includeMatches);
    }
    if (Array.isArray(ur.excludeMatches)) {
      config.urlRules.excludeMatches = splitMultiValues(ur.excludeMatches);
    }
    if (typeof ur.skipPrivateNetworks === 'boolean') {
      config.urlRules.skipPrivateNetworks = ur.skipPrivateNetworks;
    }
  }

  if (isPlainObject(raw.routing)) {
    const r = raw.routing;
    const webId = nonEmptyString(r.webpage);
    config.routing.webpage =
      webId && webId !== 'inherit' && config.providers[webId]
        ? webId
        : selectFallbackWebpageProvider(config.providers, config.providerOrder);

    const scenes: Array<Exclude<TranslationScene, 'webpage'>> = [
      'input',
      'subtitle',
      'hover',
      'selection',
      'pdf',
      'image',
    ];
    for (const scene of scenes) {
      const val = nonEmptyString(r[scene]) ?? 'inherit';
      if (val === 'inherit') {
        config.routing[scene] = 'inherit';
      } else if (config.providers[val]) {
        config.routing[scene] = val;
      } else {
        config.routing[scene] = 'inherit';
        audit.push({
          level: 'warning',
          code: 'routing-scene-fallback-inherit',
          message: `Scene "${scene}" referenced missing provider "${val}"; reset to "inherit".`,
        });
      }
    }
  }

  audit.unshift({
    level: 'info',
    code: 'margin-v2-import',
    message: `Imported Margin v2 configuration (${providersImported} providers, ${assistantsImported} assistants, ${glossaryEntriesImported} glossary entries).`,
  });

  return {
    config,
    audit,
    stats: {
      providersImported,
      assistantsImported,
      glossaryEntriesImported,
      normalizedFields,
      ignoredLegacyKeys: [],
    },
  };
}

/**
 * Imports either a legacy Immersive Translate / `myAItranslate` v1 JSON config
 * or a native `MarginConfig` (`schemaVersion: 2`) backup into a clean, validated
 * `MarginConfig` with a complete structured audit log.
 */
export function importLegacyConfig(
  rawInput: string | Record<string, unknown>,
  baseConfig?: MarginConfig,
): LegacyImportResult {
  const rootObj = parseRawInputObject(rawInput);
  const audit: LegacyImportAuditItem[] = [];
  const raw = unwrapEnvelopeIfNeeded(rootObj, audit);

  if (raw.schemaVersion === 2) {
    return importNativeMarginV2(raw, baseConfig);
  }

  const config = baseConfig
    ? structuredClone(baseConfig)
    : createDefaultMarginConfig();

  let normalizedFields = 0;
  const ignoredLegacyKeys: string[] = [];
  const recordIgnoredKey = (key: string, description: string) => {
    if (!ignoredLegacyKeys.includes(key)) {
      ignoredLegacyKeys.push(key);
    }
    audit.push({
      level: 'ignored',
      code: 'deprecated-legacy-key',
      message: `Ignored deprecated legacy setting "${key}" (${description}).`,
    });
  };

  const ctx: AssistantImportContext = {
    audit,
    onNormalized: () => {
      normalizedFields += 1;
    },
  };

  const generalRule = isPlainObject(raw.generalRule) ? raw.generalRule : {};

  // 1. Record deprecated float-ball & side-panel keys explicitly dropped in Margin v2
  for (const { key, label } of DEPRECATED_LEGACY_KEYS) {
    if (
      key in raw ||
      key in generalRule ||
      `${key}.add` in generalRule ||
      `${key}.modify` in generalRule
    ) {
      recordIgnoredKey(key, label);
    }
  }

  // 2. Import Custom AI Assistants (`aiAssistants` + `customAiAssistants`)
  const rawAssistantsMap = new Map<string, Record<string, unknown>>();
  collectRawAssistants(raw.aiAssistants, rawAssistantsMap);
  collectRawAssistants(raw.customAiAssistants, rawAssistantsMap);

  let assistantsImported = 0;
  for (const [id, rawAst] of rawAssistantsMap.entries()) {
    const assistant = normalizeLegacyAssistant(id, rawAst, ctx);
    config.assistants[assistant.id] = assistant;
    assistantsImported += 1;
  }

  // 3. Import Translation Providers (`translationServices`)
  let providersImported = 0;
  const importedProviderOrder: string[] = [];

  if (isPlainObject(raw.translationServices)) {
    for (const [serviceId, rawEntry] of Object.entries(raw.translationServices)) {
      if (!isPlainObject(rawEntry)) continue;

      if (rawEntry.isDeleted === true) {
        audit.push({
          level: 'ignored',
          code: 'deleted-provider-skipped',
          message: `Skipped deleted legacy service "${serviceId}".`,
        });
        continue;
      }

      const kind = resolveLegacyProviderKind(serviceId, rawEntry);
      if (!kind) {
        if (rawEntry.visible !== false) {
          audit.push({
            level: 'ignored',
            code: 'unsupported-legacy-provider',
            message: `Skipped unsupported non-AI legacy service "${serviceId}".`,
          });
        }
        continue;
      }

      if (shouldSkipUnconfiguredLegacyService(rawEntry, kind)) {
        continue;
      }

      const provider = normalizeLegacyProvider(
        serviceId,
        rawEntry,
        kind,
        config.assistants,
        ctx,
      );
      config.providers[serviceId] = provider;
      if (!importedProviderOrder.includes(serviceId)) {
        importedProviderOrder.push(serviceId);
      }
      providersImported += 1;
    }
  }

  // Guarantee built-in zero-config `google-free` fallback remains available
  if (!config.providers['google-free']) {
    const defaults = createDefaultMarginConfig();
    config.providers['google-free'] = defaults.providers['google-free'];
  }

  const finalOrder: string[] = [...importedProviderOrder];
  for (const existingId of config.providerOrder) {
    if (config.providers[existingId] && !finalOrder.includes(existingId)) {
      finalOrder.push(existingId);
    }
  }
  for (const id of Object.keys(config.providers)) {
    if (!finalOrder.includes(id)) {
      finalOrder.push(id);
    }
  }
  config.providerOrder = finalOrder;

  // 4. Resolve Scene Routing (`userTranslationServices` > Top-Level, preserving `"inherit"`)
  config.routing = resolveLegacyRouting(
    raw,
    config.providers,
    config.providerOrder,
    ctx,
  );

  // 5. Languages & Appearance
  config.targetLang = normalizeTargetOrSourceLang(
    raw.targetLanguage ?? raw.targetLang,
    config.targetLang,
  );
  config.sourceLang = normalizeTargetOrSourceLang(
    raw.sourceLanguage ?? raw.sourceLang,
    config.sourceLang,
  );
  config.interfaceLang = normalizeInterfaceLang(
    raw.interfaceLanguage ?? raw.interfaceLang,
    config.interfaceLang,
  );

  // 6. Webpage Theme, Patterns, Display Mode & Line Break Threshold
  if (raw.translationTheme !== undefined) {
    config.webpage.theme = normalizeTranslationTheme(
      raw.translationTheme,
      config.webpage.theme,
      ctx,
    );
  } else if (generalRule.translationTheme !== undefined) {
    config.webpage.theme = normalizeTranslationTheme(
      generalRule.translationTheme,
      config.webpage.theme,
      ctx,
    );
  }

  if (raw.translationThemePatterns !== undefined) {
    config.webpage.themePatterns = parseThemePatterns(
      raw.translationThemePatterns,
      ctx,
    );
  }

  const rawTransMode = nonEmptyString(
    raw.translationMode ?? generalRule.translationMode ?? raw.displayMode,
  )?.toLowerCase();
  if (rawTransMode) {
    const modeMap: Record<string, DisplayMode> = {
      dual: 'bilingual',
      bilingual: 'bilingual',
      translation: 'target-only',
      target: 'target-only',
      'target-only': 'target-only',
      onlytranslation: 'target-only',
    };
    if (modeMap[rawTransMode]) {
      config.webpage.displayMode = modeMap[rawTransMode];
    }
  }

  const rawLineBreak =
    generalRule.lineBreakMaxTextCount ??
    raw['generalRule.lineBreakMaxTextCount'] ??
    raw.lineBreakMaxTextCount;
  if (rawLineBreak !== undefined) {
    config.webpage.lineBreakMaxTextCount = toPositiveInt(
      rawLineBreak,
      config.webpage.lineBreakMaxTextCount,
    );
  }

  const rawWebRich = generalRule.enableRichTranslate ?? raw.enableRichTranslate;
  if (rawWebRich !== undefined) {
    config.webpage.enableRichHtml = Boolean(rawWebRich);
  }

  // 7. Input-Box Quick Translation
  if (raw.enableInputTranslation !== undefined) {
    config.input.enabled = Boolean(raw.enableInputTranslation);
  }
  const inputRule = mergeNestedRuleSection(generalRule, 'inputRule');
  if (isPlainObject(raw.inputRule)) {
    Object.assign(inputRule, raw.inputRule);
  }
  if (inputRule.enable !== undefined && raw.enableInputTranslation === undefined) {
    config.input.enabled = Boolean(inputRule.enable);
  }
  if (inputRule.targetLanguage !== undefined || inputRule.targetLang !== undefined) {
    config.input.targetLang = normalizeTargetOrSourceLang(
      inputRule.targetLanguage ?? inputRule.targetLang,
      config.input.targetLang,
    );
  }

  // 8. Selection & Hover Translation
  const selectionRule = mergeNestedRuleSection(generalRule, 'selectionTranslation');
  if (selectionRule.enable !== undefined) {
    config.selection.enabled = Boolean(selectionRule.enable);
  } else if (raw.enableSelectionTranslation !== undefined) {
    config.selection.enabled = Boolean(raw.enableSelectionTranslation);
  }
  const rawSelTrigger = nonEmptyString(selectionRule.triggerMode)?.toLowerCase();
  if (
    rawSelTrigger === 'off' ||
    rawSelTrigger === 'icon' ||
    rawSelTrigger === 'dot' ||
    rawSelTrigger === 'instant'
  ) {
    config.selection.triggerMode = rawSelTrigger;
  }

  const hoverRule = mergeNestedRuleSection(generalRule, 'mouseHoverTranslation');
  if (hoverRule.enable !== undefined) {
    config.hover.enabled = Boolean(hoverRule.enable);
  } else if (raw.enableMouseHoverTranslation !== undefined) {
    config.hover.enabled = Boolean(raw.enableMouseHoverTranslation);
  }
  const rawHoverKey = nonEmptyString(
    hoverRule.mouseHoverHoldKey ?? hoverRule.modifierKey ?? raw.mouseHoverHoldKey,
  )?.toLowerCase();
  if (rawHoverKey) {
    const keyMap: Record<string, HoverModifierKey> = {
      none: 'none',
      ctrl: 'ctrl',
      control: 'ctrl',
      alt: 'alt',
      option: 'alt',
      shift: 'shift',
      meta: 'meta',
      cmd: 'meta',
      command: 'meta',
    };
    if (keyMap[rawHoverKey]) {
      config.hover.modifierKey = keyMap[rawHoverKey];
    }
  }

  // 9. Video Subtitles (`generalRule["subtitleRule.add"]` / `subtitleRule`)
  const subtitleRule = mergeNestedRuleSection(generalRule, 'subtitleRule');
  if (isPlainObject(raw.subtitleRule)) {
    Object.assign(subtitleRule, raw.subtitleRule);
  }
  if (subtitleRule.autoEnableSubtitle !== undefined) {
    config.subtitles.autoEnable = Boolean(subtitleRule.autoEnableSubtitle);
  }
  if (subtitleRule.youtubeAutoEnableSubtitle !== undefined) {
    config.subtitles.youtubeAutoEnable = Boolean(
      subtitleRule.youtubeAutoEnableSubtitle,
    );
  }
  if (subtitleRule.preTranslation !== undefined) {
    config.subtitles.preTranslate = Boolean(subtitleRule.preTranslation);
  }
  if (subtitleRule.translationFontSize !== undefined) {
    const rawFs = subtitleRule.translationFontSize;
    const coercedFs = Math.max(
      50,
      Math.min(160, toPositiveInt(rawFs, config.subtitles.fontSizePercent)),
    );
    if (typeof rawFs === 'string' && rawFs.trim() !== '') {
      ctx.onNormalized();
      audit.push({
        level: 'normalized',
        code: 'subtitle-fontsize-coerced',
        message: `Normalized subtitleRule.translationFontSize ${JSON.stringify(rawFs)} -> ${coercedFs}.`,
      });
    }
    config.subtitles.fontSizePercent = coercedFs;
    config.subtitles.translationScalePercent = coercedFs;
  }
  if (subtitleRule.originalFontSize !== undefined || subtitleRule.sourceScalePercent !== undefined) {
    const rawOrig = subtitleRule.sourceScalePercent ?? subtitleRule.originalFontSize;
    config.subtitles.sourceScalePercent = Math.max(
      50,
      Math.min(160, toPositiveInt(rawOrig, config.subtitles.sourceScalePercent ?? 100)),
    );
  }
  if (!config.subtitles.sourceScalePercent) {
    config.subtitles.sourceScalePercent = 100;
  }
  if (!config.subtitles.translationScalePercent) {
    config.subtitles.translationScalePercent = config.subtitles.fontSizePercent || 70;
  }
  if (!config.subtitles.stylePreset) {
    config.subtitles.stylePreset = 'youtube-native';
  }
  const rawSubPos = nonEmptyString(subtitleRule.translationPosition)?.toLowerCase();
  if (rawSubPos === 'bottom' || rawSubPos === 'top') {
    config.subtitles.position = rawSubPos;
  }
  const rawSubMode = nonEmptyString(
    subtitleRule.translationMode ?? subtitleRule.displayMode,
  )?.toLowerCase();
  if (rawSubMode === 'dual' || rawSubMode === 'bilingual') {
    config.subtitles.displayMode = 'bilingual';
  } else if (
    rawSubMode === 'translation' ||
    rawSubMode === 'target' ||
    rawSubMode === 'target-only'
  ) {
    config.subtitles.displayMode = 'target-only';
  } else if (rawSubMode === 'original' || rawSubMode === 'source-only') {
    config.subtitles.displayMode = 'source-only';
  }

  // 10. URL Rules (`translationUrlPattern` + `immediateTranslateUrlPattern`)
  if (isPlainObject(raw.translationUrlPattern)) {
    const urlPat = raw.translationUrlPattern;
    const rawExcludes =
      urlPat.excludeMatches ?? urlPat['excludeMatches.add'] ?? urlPat.excludes;
    if (rawExcludes !== undefined) {
      config.urlRules.excludeMatches = splitMultiValues(rawExcludes);
    }
    const rawMatches =
      urlPat.matches ?? urlPat['matches.add'] ?? urlPat.includeMatches;
    if (rawMatches !== undefined) {
      const includes = splitMultiValues(rawMatches);
      config.urlRules.includeMatches = includes;
      if (includes.length > 0 && raw.autoTranslateMatches === undefined) {
        config.webpage.autoTranslateMatches = true;
      }
    }
  }
  if (isPlainObject(raw.immediateTranslateUrlPattern)) {
    const imm = raw.immediateTranslateUrlPattern;
    const immMatches = splitMultiValues(imm.matches ?? imm['matches.add']);
    if (immMatches.length > 0) {
      config.urlRules.includeMatches = splitMultiValues([
        ...config.urlRules.includeMatches,
        ...immMatches,
      ]);
      config.webpage.autoTranslateMatches = true;
    }
  }

  // 11. Glossary (`terms` / `glossary`, preserving `v: ""` keep-original entries)
  let glossaryEntriesImported = 0;
  const rawGlossarySource = raw.terms !== undefined ? raw.terms : raw.glossary;
  if (rawGlossarySource !== undefined) {
    const parsedGlossary = parseGlossaryEntries(rawGlossarySource, audit);
    config.glossary = parsedGlossary;
    glossaryEntriesImported = parsedGlossary.length;
  }

  audit.unshift({
    level: 'info',
    code: 'legacy-v1-import',
    message: `Imported legacy configuration (${providersImported} providers, ${assistantsImported} assistants, ${glossaryEntriesImported} glossary entries).`,
  });

  return {
    config,
    audit,
    stats: {
      providersImported,
      assistantsImported,
      glossaryEntriesImported,
      normalizedFields,
      ignoredLegacyKeys,
    },
  };
}
