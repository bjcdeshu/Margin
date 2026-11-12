import type {
  AssistantConfig,
  MarginConfig,
  ProviderConfig,
  ProviderPreset,
  SceneRoutingConfig,
  TranslationScene,
  WireProtocol,
} from './types';

export interface LanguageEntry {
  code: string;
  englishName: string;
  nativeName: string;
}

export const SUPPORTED_LANGUAGES: readonly LanguageEntry[] = [
  { code: 'auto', englishName: 'Auto Detect', nativeName: '自动检测' },
  { code: 'zh-CN', englishName: 'Simplified Chinese', nativeName: '简体中文' },
  { code: 'zh-TW', englishName: 'Traditional Chinese', nativeName: '繁體中文' },
  { code: 'en', englishName: 'English', nativeName: 'English' },
  { code: 'ja', englishName: 'Japanese', nativeName: '日本語' },
  { code: 'ko', englishName: 'Korean', nativeName: '한국어' },
  { code: 'fr', englishName: 'French', nativeName: 'Français' },
  { code: 'de', englishName: 'German', nativeName: 'Deutsch' },
  { code: 'es', englishName: 'Spanish', nativeName: 'Español' },
  { code: 'ru', englishName: 'Russian', nativeName: 'Русский' },
  { code: 'pt', englishName: 'Portuguese', nativeName: 'Português' },
  { code: 'it', englishName: 'Italian', nativeName: 'Italiano' },
  { code: 'ar', englishName: 'Arabic', nativeName: 'العربية' },
  { code: 'vi', englishName: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'th', englishName: 'Thai', nativeName: 'ไทย' },
] as const;

export const LANGUAGE_ENGLISH_NAME_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  SUPPORTED_LANGUAGES.map((l) => [l.code, l.englishName]),
);

export function getEnglishLanguageName(code: string): string {
  return LANGUAGE_ENGLISH_NAME_MAP[code] || code;
}

export interface ProviderPresetMeta {
  preset: ProviderPreset;
  label: string;
  protocol: WireProtocol;
  defaultEndpoint: string;
  defaultModel: string;
  suggestedModels: string[];
  requiresApiKey: boolean;
}

export const PROVIDER_PRESETS: Readonly<Record<ProviderPreset, ProviderPresetMeta>> = {
  openai: {
    preset: 'openai',
    label: 'OpenAI / Compatible Gateway',
    protocol: 'openai-chat',
    defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4.1-mini',
    suggestedModels: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.4-mini', 'gpt-4.1-mini'],
    requiresApiKey: true,
  },
  deepseek: {
    preset: 'deepseek',
    label: 'DeepSeek / Compatible',
    protocol: 'openai-chat',
    defaultEndpoint: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner', 'gpt-5.3-codex-spark'],
    requiresApiKey: true,
  },
  zhipu: {
    preset: 'zhipu',
    label: 'Zhipu GLM (智谱清言)',
    protocol: 'openai-chat',
    defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defaultModel: 'glm-4-air',
    suggestedModels: ['glm-4-air', 'glm-4.6', 'glm-4.7', 'glm-4-flash'],
    requiresApiKey: true,
  },
  anthropic: {
    preset: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic-messages',
    defaultEndpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-5',
    suggestedModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    requiresApiKey: true,
  },
  deeplx: {
    preset: 'deeplx',
    label: 'DeepLX',
    protocol: 'deeplx',
    defaultEndpoint: 'http://127.0.0.1:1188/translate',
    defaultModel: 'deeplx',
    suggestedModels: ['deeplx'],
    requiresApiKey: false,
  },
  'google-free': {
    preset: 'google-free',
    label: 'Google Translate (Free)',
    protocol: 'google-web',
    defaultEndpoint: 'https://translate.googleapis.com/translate_a/single',
    defaultModel: 'gtx',
    suggestedModels: ['gtx'],
    requiresApiKey: false,
  },
  custom: {
    preset: 'custom',
    label: 'Custom OpenAI-Compatible',
    protocol: 'openai-chat',
    defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4.1-mini',
    suggestedModels: [],
    requiresApiKey: true,
  },
};

export const BUILTIN_ASSISTANTS: Record<string, AssistantConfig> = {
  'builtin-yaml': {
    id: 'builtin-yaml',
    name: 'Master Structured YAML (Aloxaf-Compatible)',
    codec: 'yaml',
    enableRichHtml: true,
    temperaturePolicy: { mode: 'custom', value: 0.3 },
    maxBatchCount: 17,
    maxSubtitleBatchCount: 17,
    maxCharsPerBatch: 4096,
    separator: '\n\n%%\n\n',
    systemPrompt:
      'You are a meticulous editorial translator. Translate every item naturally into {{to}} while preserving inline <mN> tags verbatim. Respond ONLY inside a <yaml>...</yaml> block with fields `id`, optional brief `thinking`, and `trans`.',
    prompt:
      '{{title_prompt}}{{summary_prompt}}{{terms_prompt}}Translate into {{to}}:\n<yaml>\n{{yaml}}\n</yaml>',
    subtitlePrompt:
      '{{title_prompt}}{{terms_prompt}}Translate each video subtitle cue into {{to}}. Keep each translation strictly inside its own cue `id`; never shift trailing words to adjacent cues:\n<yaml>\n{{yaml}}\n</yaml>',
    env: {
      imt_yaml_item: '- id: {{id}}\n  src: |-\n    {{text}}',
      imt_subtitle_yaml_item: '- id: {{id}}\n  src: {{text}}',
      imt_source_field: 'src',
      imt_trans_field: 'trans',
      imt_sub_source_field: 'src',
      imt_sub_trans_field: 'trans',
      title_prompt: 'Document Title: {{imt_title}}\n',
      summary_prompt: 'Context Summary: {{imt_theme}}\n',
      terms_prompt: 'Required Glossary: {{imt_terms}}\n',
      sub_summary_prompt: 'Video Context: {{imt_theme}}\n',
      sub_terms_prompt: 'Required Glossary: {{imt_terms}}\n',
    },
  },
  'builtin-delimiter': {
    id: 'builtin-delimiter',
    name: 'Fast Streaming Delimiter (%%)',
    codec: 'delimiter',
    enableRichHtml: true,
    temperaturePolicy: { mode: 'omit' },
    maxBatchCount: 6,
    maxSubtitleBatchCount: 12,
    maxCharsPerBatch: 1800,
    separator: '\n\n%%\n\n',
    systemPrompt:
      'You are a professional translator. Translate the user input into {{to}}. Preserve `%%` paragraph separators and any `<mN>` inline tags exactly. Output ONLY the translated text.',
    prompt: '{{title_prompt}}{{terms_prompt}}{{text}}',
    env: {
      title_prompt: 'Title: {{imt_title}}\n',
      terms_prompt: 'Glossary: {{imt_terms}}\n',
    },
  },
};

export function resolveProviderIdForScene(
  scene: TranslationScene | 'service-test',
  routing: SceneRoutingConfig,
  providers: Record<string, ProviderConfig>,
  explicitProviderId?: string,
): string {
  if (explicitProviderId && providers[explicitProviderId]) {
    if (scene === 'service-test' || providers[explicitProviderId].enabled) {
      return explicitProviderId;
    }
  }
  const firstEnabled = Object.values(providers).find((p) => p.enabled);
  const fallbackId =
    firstEnabled?.id ??
    (providers['google-free'] ? 'google-free' : (Object.keys(providers)[0] ?? 'google-free'));

  if (scene === 'service-test') {
    const webProv = providers[routing.webpage];
    return webProv && webProv.enabled ? routing.webpage : fallbackId;
  }
  const configured = routing[scene];
  const targetId = !configured || configured === 'inherit' ? routing.webpage : configured;
  if (providers[targetId]?.enabled) {
    return targetId;
  }
  if (providers[routing.webpage]?.enabled) {
    return routing.webpage;
  }
  return fallbackId;
}

export function createDefaultMarginConfig(): MarginConfig {
  const googleFree: ProviderConfig = {
    id: 'google-free',
    name: 'Google Translate (Free)',
    preset: 'google-free',
    protocol: 'google-web',
    enabled: true,
    baseUrl: PROVIDER_PRESETS['google-free'].defaultEndpoint,
    apiKeys: [],
    model: 'gtx',
    models: ['gtx'],
    enableContext: false,
    enableRichHtml: true,
    stream: 'off',
    rateLimitRps: 15,
    maxConcurrency: 4,
    maxBatchCount: 12,
    maxSubtitleBatchCount: 16,
    maxCharsPerBatch: 3200,
    temperaturePolicy: { mode: 'omit' },
    thinkingPolicy: { mode: 'provider-default' },
  };

  return {
    schemaVersion: 2,
    uiColorMode: 'paper',
    interfaceLang: 'zh-CN',
    sourceLang: 'auto',
    targetLang: 'zh-CN',
    routing: {
      webpage: 'google-free',
      input: 'inherit',
      subtitle: 'inherit',
      hover: 'inherit',
      selection: 'inherit',
      pdf: 'inherit',
      image: 'inherit',
    },
    providers: {
      'google-free': googleFree,
    },
    providerOrder: ['google-free'],
    assistants: {
      ...structuredClone(BUILTIN_ASSISTANTS),
    },
    glossary: [
      { k: 'LLM', v: '' },
      { k: 'LLMs', v: '' },
    ],
    webpage: {
      displayMode: 'bilingual',
      theme: 'none',
      themePatterns: [],
      lineBreakMaxTextCount: 280,
      enableRichHtml: true,
      autoTranslateMatches: false,
    },
    input: {
      enabled: true,
      tripleSpaceTrigger: true,
      tripleSpaceWindowMs: 650,
      targetLang: 'en',
      fallbackTargetLang: 'zh-CN',
    },
    selection: {
      enabled: true,
      triggerMode: 'icon',
    },
    hover: {
      enabled: true,
      modifierKey: 'ctrl',
      delayMs: 180,
    },
    subtitles: {
      autoEnable: true,
      youtubeAutoEnable: true,
      preTranslate: true,
      displayMode: 'bilingual',
      fontSizePercent: 70,
      sourceScalePercent: 100,
      translationScalePercent: 70,
      stylePreset: 'youtube-native',
      position: 'bottom',
    },
    urlRules: {
      includeMatches: [],
      excludeMatches: ['https://linux.do/*'],
      skipPrivateNetworks: true,
    },
  };
}
