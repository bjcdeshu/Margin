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

export const DEFAULT_ENABLED_GLOSSARY_PACK_IDS = [
  'ai-agent-infra',
  'dev-cloud-web',
  'screenwriting-narrative',
  'gaming-tech-culture',
] as const;

export const BUILTIN_ASSISTANTS: Record<string, AssistantConfig> = {
  'builtin-yaml': {
    id: 'builtin-yaml',
    name: 'Margin 信达雅精译 (Fast Editorial <yaml>)',
    codec: 'yaml',
    enableRichHtml: true,
    temperaturePolicy: { mode: 'custom', value: 0.3 },
    maxBatchCount: 17,
    maxSubtitleBatchCount: 17,
    maxCharsPerBatch: 4096,
    separator: '\n\n%%\n\n',
    systemPrompt: [
      'You are Margin, a senior bilingual editor translating into {{to}} with accuracy, idiomatic rhythm, and authentic register ("信达雅").',
      '1. Idiomatic Prose: Restructure English long clauses, nested modifiers, and passive constructions into clean, natural, rhythmic {{to}} prose with zero translationese.',
      '2. Domain & Register: Match tone and terminology to any provided Document Title, Context Summary, and Style Guide.',
      '3. Markup & Token Integrity: Preserve inline <m0>...</m0> HTML wrapper tags, <m-g id="N"/> placeholders, @handles, #hashtags, URLs, Markdown formatting, and code/CLI identifiers verbatim.',
      '4. Glossary Obedience: Strictly obey any provided glossary rules—preserve Keep-Original terms in exact source spelling and apply Required Term Mappings verbatim.',
      '5. Fast YAML Contract: Respond ONLY inside a single <yaml>...</yaml> block where each item has `- id: <number>` and `  trans: <translation>` ONLY. Never include a `thinking` field, preamble, or trailing commentary.',
    ].join('\n'),
    prompt:
      '{{title_prompt}}{{summary_prompt}}{{thread_prompt}}{{context_window_prompt}}{{style_prompt}}{{glossary_prompt}}Translate into {{to}}:\n<yaml>\n{{yaml}}\n</yaml>',
    inputPrompt:
      '{{glossary_prompt}}Rewrite and translate the user draft into concise, idiomatic, native-speaker {{to}} ready to post or send directly (e.g. on X, GitHub issues/PRs, or chat). Preserve @mentions, #hashtags, URLs, Markdown, and inline code verbatim. Output ONLY `- id: 1` and `trans` inside <yaml>:\n<yaml>\n{{yaml}}\n</yaml>',
    selectionPrompt:
      '{{title_prompt}}{{style_prompt}}{{glossary_prompt}}Translate the selected text into crisp, contextually accurate {{to}}. Render phrases and sentences naturally in context without dictionary notes or explanations. Output ONLY `- id` and `trans` inside <yaml>:\n<yaml>\n{{yaml}}\n</yaml>',
    subtitlePrompt:
      '{{title_prompt}}{{sub_summary_prompt}}{{style_prompt}}{{glossary_prompt}}Translate each video subtitle cue into natural, spoken {{to}} with concise on-screen pacing. Keep each translation strictly inside its own cue `id`; never merge, split, or shift trailing words across adjacent cues. Output ONLY `- id` and `trans` inside <yaml>:\n<yaml>\n{{yaml}}\n</yaml>',
    env: {
      imt_yaml_item: '- id: {{id}}\n  src: |-\n    {{text}}',
      imt_subtitle_yaml_item: '- id: {{id}}\n  src: {{text}}',
      imt_source_field: 'src',
      imt_trans_field: 'trans',
      imt_sub_source_field: 'src',
      imt_sub_trans_field: 'trans',
      title_prompt: 'Document Title: {{title}}\n',
      summary_prompt: 'Context Summary: {{summary}}\n',
      thread_prompt:
        'Thread / Post Topic (context only — do NOT translate): {{threadContext}}\n',
      context_window_prompt:
        'Preceding Context (for pronoun/tone continuity only — do NOT translate): {{prevContext}}\n',
      style_prompt: 'Style Guide: {{styleGuide}}\n',
      glossary_prompt: '{{glossaryInstruction}}\n',
      terms_prompt: 'Required Glossary: {{imt_terms}}\n',
      sub_summary_prompt: 'Video Context: {{summary}}\n',
      sub_terms_prompt: 'Required Glossary: {{imt_terms}}\n',
    },
  },
  'builtin-yaml-thinking': {
    id: 'builtin-yaml-thinking',
    name: '泛用翻译大师 · 思考精修 (Aloxaf <yaml>)',
    codec: 'yaml',
    enableRichHtml: true,
    temperaturePolicy: { mode: 'custom', value: 0.3 },
    maxBatchCount: 17,
    maxSubtitleBatchCount: 17,
    maxCharsPerBatch: 4096,
    separator: '\n\n%%\n\n',
    systemPrompt: [
      'You are a meticulous literary and technical editor translating into {{to}} using two-step structured reflection.',
      '1. First note key register, syntax restructuring, and glossary/markup constraints briefly in `thinking`, then write idiomatic, publication-grade {{to}} in `trans` (restructuring long English clauses and passives into natural prose).',
      '2. Preserve all inline <m0>...</m0> tags, <m-g id="N"/> placeholders, @handles, #hashtags, URLs, and code identifiers verbatim.',
      '3. Strictly obey any provided Keep-Original terms, Required Term Mappings, Document Title, Context Summary, and Style Guide.',
      '4. Respond ONLY inside a <yaml>...</yaml> block using `- id: <number>`, `  thinking: <brief editorial note>`, and `  trans: <final translation>`.',
    ].join('\n'),
    prompt:
      '{{title_prompt}}{{summary_prompt}}{{thread_prompt}}{{context_window_prompt}}{{style_prompt}}{{glossary_prompt}}Translate into {{to}} with brief `thinking` and polished `trans`:\n<yaml>\n{{yaml}}\n</yaml>',
    inputPrompt:
      '{{glossary_prompt}}Translate the user draft into idiomatic, native-speaker {{to}} ready to post on X, GitHub issues/PRs, or chat. Preserve @mentions, #hashtags, URLs, Markdown, and inline code verbatim. Respond inside <yaml> with `id: 1`, brief `thinking`, and `trans`:\n<yaml>\n{{yaml}}\n</yaml>',
    selectionPrompt:
      '{{title_prompt}}{{style_prompt}}{{glossary_prompt}}Translate the selected passage into crisp, contextually accurate {{to}}. Respond inside <yaml> with `id`, brief `thinking`, and `trans`:\n<yaml>\n{{yaml}}\n</yaml>',
    subtitlePrompt:
      '{{title_prompt}}{{sub_summary_prompt}}{{style_prompt}}{{glossary_prompt}}Translate each video subtitle cue into natural spoken {{to}}. Keep each translation strictly inside its own cue `id`; never shift trailing words to adjacent cues. Respond inside <yaml> with `id`, brief `thinking`, and `trans`:\n<yaml>\n{{yaml}}\n</yaml>',
    env: {
      imt_yaml_item: '- id: {{id}}\n  src: |-\n    {{text}}',
      imt_subtitle_yaml_item: '- id: {{id}}\n  src: {{text}}',
      imt_source_field: 'src',
      imt_trans_field: 'trans',
      imt_sub_source_field: 'src',
      imt_sub_trans_field: 'trans',
      title_prompt: 'Document Title: {{title}}\n',
      summary_prompt: 'Context Summary: {{summary}}\n',
      thread_prompt:
        'Thread / Post Topic (context only — do NOT translate): {{threadContext}}\n',
      context_window_prompt:
        'Preceding Context (for pronoun/tone continuity only — do NOT translate): {{prevContext}}\n',
      style_prompt: 'Style Guide: {{styleGuide}}\n',
      glossary_prompt: '{{glossaryInstruction}}\n',
      terms_prompt: 'Required Glossary: {{imt_terms}}\n',
      sub_summary_prompt: 'Video Context: {{summary}}\n',
      sub_terms_prompt: 'Required Glossary: {{imt_terms}}\n',
    },
  },
  'builtin-delimiter': {
    id: 'builtin-delimiter',
    name: '极速流式直译 (%%)',
    codec: 'delimiter',
    enableRichHtml: true,
    temperaturePolicy: { mode: 'omit' },
    maxBatchCount: 6,
    maxSubtitleBatchCount: 12,
    maxCharsPerBatch: 1800,
    separator: '\n\n%%\n\n',
    systemPrompt: [
      'You are Margin, a fast editorial translator into {{to}}.',
      'Restructure source sentences into clean, idiomatic {{to}} prose with zero translationese.',
      'Preserve `%%` paragraph separators, inline <m0>...</m0> / <mN> tags, <m-g id="N"/> placeholders, @handles, #hashtags, URLs, and code verbatim.',
      'Strictly obey any provided Keep-Original and Term Mapping rules, and output ONLY the translated text.',
    ].join(' '),
    prompt: '{{title_prompt}}{{thread_prompt}}{{context_window_prompt}}{{style_prompt}}{{glossary_prompt}}{{text}}',
    inputPrompt:
      '{{glossary_prompt}}Rewrite and translate into concise, native-speaker {{to}} ready to send or post (preserving @mentions, #hashtags, URLs, and code verbatim; output ONLY the translation):\n{{text}}',
    selectionPrompt:
      '{{title_prompt}}{{style_prompt}}{{glossary_prompt}}Translate the selected text into crisp, natural {{to}} (output ONLY the translation):\n{{text}}',
    subtitlePrompt:
      '{{title_prompt}}{{sub_summary_prompt}}{{style_prompt}}{{glossary_prompt}}Translate each subtitle cue into natural spoken {{to}}, keeping exact `%%` cue boundaries without shifting words across cues:\n{{text}}',
    env: {
      title_prompt: 'Title: {{title}}\n',
      thread_prompt:
        'Thread / Post Topic (context only — do NOT translate): {{threadContext}}\n',
      context_window_prompt:
        'Preceding Context (for pronoun/tone continuity only — do NOT translate): {{prevContext}}\n',
      sub_summary_prompt: 'Video Context: {{summary}}\n',
      style_prompt: 'Style Guide: {{styleGuide}}\n',
      glossary_prompt: '{{glossaryInstruction}}\n',
      terms_prompt: 'Glossary: {{imt_terms}}\n',
    },
  },
};

export function cloneAssistantConfig(ast: AssistantConfig): AssistantConfig {
  return {
    ...ast,
    temperaturePolicy: { ...ast.temperaturePolicy },
    ...(ast.env ? { env: { ...ast.env } } : {}),
  };
}

export function cloneBuiltinAssistants(): Record<string, AssistantConfig> {
  const out: Record<string, AssistantConfig> = {};
  for (const [key, ast] of Object.entries(BUILTIN_ASSISTANTS)) {
    out[key] = cloneAssistantConfig(ast);
  }
  return out;
}

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
    assistants: cloneBuiltinAssistants(),
    glossary: [
      { k: 'LLM', v: '' },
      { k: 'LLMs', v: '' },
    ],
    enabledGlossaryPacks: [...DEFAULT_ENABLED_GLOSSARY_PACK_IDS],
    promptSystemVersion: 3,
    webpage: {
      displayMode: 'bilingual',
      theme: 'none',
      themePatterns: [],
      lineBreakMaxTextCount: 280,
      enableRichHtml: true,
      autoTranslateMatches: true,
      autoTranslateMode: 'foreign',
      autoTranslateLanguages: [],
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
      bgOpacityPercent: null,
      translationTint: 'follow',
      position: 'bottom',
    },
    urlRules: {
      includeMatches: [],
      excludeMatches: ['https://linux.do/*'],
      skipPrivateNetworks: true,
    },
  };
}
