import { beforeEach, describe, expect, it } from 'vitest';
import { BRAND } from '@shared/brand';
import {
  BUILTIN_ASSISTANTS,
  createDefaultMarginConfig,
  DEFAULT_ENABLED_GLOSSARY_PACK_IDS,
  resolveProviderIdForScene,
} from '@shared/constants';
import {
  requestClearTranslationCache,
  requestRuntimeWarmup,
  requestTranslationCacheStats,
  sendTabCommand,
} from '@shared/messaging';
import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import {
  appendDiagnosticSnapshot,
  backfillStoredConfig,
  getCapabilityCache,
  getDiagnosticsLog,
  getMarginConfig,
  recordModelCapability,
  resetMemoryStorageForTests,
  updateMarginConfig,
} from '@shared/storage';
import {
  isStrictTemperatureModel,
  makeCapabilityKey,
  normalizeTemperaturePolicy,
  resolveEffectiveTemperature,
  shouldStripTemperatureAndRetry,
} from '@shared/temperature';
import {
  isPrivateOrLocalUrl,
  isUrlExcluded,
  matchesUrlGlob,
  resolveThemeForUrl,
} from '@shared/url-match';

describe('Margin shared contracts & temperature engine', () => {
  beforeEach(() => {
    resetMemoryStorageForTests();
  });

  it('locks brand constants and Shadow DOM CSS reset invariants', () => {
    expect(BRAND.name).toBe('Margin');
    expect(BRAND.slug).toBe('margin');
    expect(BRAND.version).toBe('2.3.1');
    expect(BRAND.pinnedExtensionId).toMatch(/^[a-p]{32}$/);
    expect(SHADOW_HOST_RESET_CSS).toContain('all: initial !important');
    expect(SHADOW_HOST_RESET_CSS).toContain('font-size: 16px !important');
    expect(SHADOW_HOST_RESET_CSS).toContain(':host([hidden])');
    expect(SHADOW_HOST_RESET_CSS).toContain('display: none !important');
    expect(SHADOW_HOST_RESET_CSS).toContain('#fbfaf6');
    expect(SHADOW_HOST_RESET_CSS).toContain('#151411');

    const defaults = createDefaultMarginConfig();
    expect(defaults.selection.enabled).toBe(true);
    expect(defaults.hover.enabled).toBe(true);
    expect(defaults.webpage.autoTranslateMode).toBe('foreign');
    expect(defaults.webpage.autoTranslateMatches).toBe(true);
    expect(defaults.webpage.autoTranslateLanguages).toEqual([]);
    expect(defaults.enabledGlossaryPacks).toEqual([
      ...DEFAULT_ENABLED_GLOSSARY_PACK_IDS,
    ]);
    expect(defaults.promptSystemVersion).toBe(3);
    expect(defaults.assistants['builtin-yaml']).toBeDefined();
    expect(defaults.assistants['builtin-yaml-thinking']).toBeDefined();
    expect(defaults.assistants['builtin-delimiter']).toBeDefined();
    expect(defaults.subtitles.sourceScalePercent).toBe(100);
    expect(defaults.subtitles.translationScalePercent).toBe(70);
    expect(defaults.subtitles.stylePreset).toBe('youtube-native');
    expect(defaults.subtitles.bgOpacityPercent).toBeNull();
    expect(defaults.subtitles.translationTint).toBe('follow');

    // Verify `bgOpacityPercent: 0` (0% transparent) is preserved and never coerced to null
    const zeroOpacityCfg = createDefaultMarginConfig();
    zeroOpacityCfg.subtitles.bgOpacityPercent = 0;
    zeroOpacityCfg.subtitles.translationTint = 'amber';
    const backfilled = backfillStoredConfig(zeroOpacityCfg);
    expect(backfilled.config.subtitles.bgOpacityPercent).toBe(0);
    expect(backfilled.config.subtitles.translationTint).toBe('amber');
  });

  it('normalizes legacy undefined and empty-string temperatures to omit (never 0)', () => {
    expect(normalizeTemperaturePolicy(undefined)).toEqual({ mode: 'omit' });
    expect(normalizeTemperaturePolicy(null)).toEqual({ mode: 'omit' });
    expect(normalizeTemperaturePolicy('')).toEqual({ mode: 'omit' });
    expect(normalizeTemperaturePolicy('   ')).toEqual({ mode: 'omit' });
    expect(normalizeTemperaturePolicy(0.3)).toEqual({ mode: 'custom', value: 0.3 });
    expect(normalizeTemperaturePolicy('0')).toEqual({ mode: 'custom', value: 0 });
  });

  it('catches unanchored reasoning/GPT-5/GPT-6/Codex models while allowing standard chat models', () => {
    expect(isStrictTemperatureModel('gpt-6-luna')).toBe(true);
    expect(isStrictTemperatureModel('gpt-5.6-luna')).toBe(true);
    expect(isStrictTemperatureModel('gpt-5.3-codex-spark')).toBe(true);
    expect(isStrictTemperatureModel('o3-mini')).toBe(true);
    expect(isStrictTemperatureModel('deepseek-reasoner')).toBe(true);
    expect(isStrictTemperatureModel('glm5.3-thinking')).toBe(true);

    expect(isStrictTemperatureModel('deepseek-chat')).toBe(false);
    expect(isStrictTemperatureModel('glm-4-air')).toBe(false);
    expect(isStrictTemperatureModel('glm-4.7')).toBe(false);
    expect(isStrictTemperatureModel('gpt-4.1-mini')).toBe(false);
    expect(isStrictTemperatureModel('gpt-4o')).toBe(false);
    expect(isStrictTemperatureModel('gpt-3.5-turbo')).toBe(false);
  });

  it('applies 4-defense temperature resolution across assistant, reasoning guard, and 400 cache', () => {
    const aloxafPolicy = { mode: 'custom' as const, value: 0.3 };

    // On gpt-6-luna, Aloxaf 0.3 is automatically omitted by Reasoning Guard
    expect(
      resolveEffectiveTemperature({
        model: 'gpt-6-luna',
        providerPolicy: { mode: 'omit' },
        assistantPolicy: aloxafPolicy,
      }),
    ).toEqual({ value: undefined, trace: 'omitted-reasoning-guard' });

    // On glm-4.7, Aloxaf 0.3 is preserved as intended
    expect(
      resolveEffectiveTemperature({
        model: 'glm-4.7',
        providerPolicy: { mode: 'omit' },
        assistantPolicy: aloxafPolicy,
      }),
    ).toEqual({ value: 0.3, trace: 'sent-assistant-custom' });

    // When cached capability marks supportsTemperature: false, always omit
    expect(
      resolveEffectiveTemperature({
        model: 'custom-gateway-model',
        providerPolicy: { mode: 'custom', value: 0.5 },
        cachedCapability: { supportsTemperature: false, updatedAt: Date.now() },
      }),
    ).toEqual({ value: undefined, trace: 'omitted-capability-cache' });

    // Detects HTTP 400 unsupported temperature errors accurately
    expect(
      shouldStripTemperatureAndRetry(
        400,
        `{"error":{"message":"Unsupported parameter: 'temperature' is not supported with this model."}}`,
        true,
      ),
    ).toBe(true);
    expect(shouldStripTemperatureAndRetry(401, 'Invalid API key', true)).toBe(false);
    expect(shouldStripTemperatureAndRetry(400, 'temperature error', false)).toBe(false);
  });

  it('resolves live inherit routing cleanly across all scenes', () => {
    const cfg = createDefaultMarginConfig();
    cfg.providers['openai-bytb6BIB'] = {
      ...cfg.providers['google-free'],
      id: 'openai-bytb6BIB',
      preset: 'openai',
      protocol: 'openai-chat',
      model: 'gpt-6-luna',
    };
    cfg.routing.webpage = 'openai-bytb6BIB';
    cfg.routing.input = 'inherit';
    cfg.routing.subtitle = 'inherit';
    cfg.routing.image = 'inherit';

    expect(resolveProviderIdForScene('webpage', cfg.routing, cfg.providers)).toBe(
      'openai-bytb6BIB',
    );
    expect(resolveProviderIdForScene('input', cfg.routing, cfg.providers)).toBe(
      'openai-bytb6BIB',
    );
    expect(resolveProviderIdForScene('subtitle', cfg.routing, cfg.providers)).toBe(
      'openai-bytb6BIB',
    );
    expect(resolveProviderIdForScene('image', cfg.routing, cfg.providers)).toBe(
      'openai-bytb6BIB',
    );
  });

  it('enforces URL wildcard exclusions (linux.do/*) and private network guards', () => {
    const cfg = createDefaultMarginConfig();
    expect(matchesUrlGlob('https://linux.do/t/topic/2910452', 'https://linux.do/*')).toBe(
      true,
    );
    expect(isUrlExcluded('https://linux.do/t/topic/2910452', cfg.urlRules)).toBe(true);
    expect(isPrivateOrLocalUrl('http://192.168.1.10:8080/dashboard')).toBe(true);
    expect(isUrlExcluded('https://news.ycombinator.com/item?id=1', cfg.urlRules)).toBe(
      false,
    );
    expect(
      resolveThemeForUrl('https://arxiv.org/abs/2501.00001', 'mask', [
        { pattern: 'https://arxiv.org/*', theme: 'none' },
      ]),
    ).toBe('none');
  });

  it('persists config, capability cache, and diagnostics in storage', async () => {
    const initial = await getMarginConfig();
    expect(initial.schemaVersion).toBe(2);

    const updated = await updateMarginConfig((draft) => {
      draft.webpage.theme = 'mask';
    });
    expect(updated.webpage.theme).toBe('mask');

    const capKey = makeCapabilityKey('https://api.example.com/v1/chat/completions', 'gpt-6-luna');
    expect(capKey).toBe('https://api.example.com::gpt-6-luna');
    await recordModelCapability(capKey, {
      supportsTemperature: false,
      learnedFromStatus: 400,
      updatedAt: Date.now(),
    });
    const cache = await getCapabilityCache();
    expect(cache[capKey]?.supportsTemperature).toBe(false);

    await appendDiagnosticSnapshot({
      schemaVersion: 1,
      product: BRAND.name,
      version: BRAND.version,
      time: new Date().toISOString(),
      scene: 'webpage',
      codec: 'yaml',
      provider: {
        id: 'openai-bytb6BIB',
        preset: 'openai',
        protocol: 'openai-chat',
        endpointOrigin: 'https://api.example.com',
        endpointPath: '/v1/chat/completions',
        model: 'gpt-6-luna',
      },
      parameters: {
        temperatureTrace: 'omitted-reasoning-guard',
        thinkingMode: 'provider-default',
        stream: false,
      },
      httpStatus: 200,
      kind: 'ok',
      retryable: false,
      attempts: 1,
      latencyMs: 320,
    });
    const logs = await getDiagnosticsLog();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.product).toBe('Margin');
  });

  it('skips disabled providers in normal scene routing, auto-injects content scripts in sendTabCommand, and backfills legacy v2 subtitle scales', async () => {
    // 1. Disabled provider skipped on normal scenes, honored on explicit service-test
    const cfg = createDefaultMarginConfig();
    cfg.providers['disabled-ai'] = {
      ...cfg.providers['google-free'],
      id: 'disabled-ai',
      enabled: false,
    };
    cfg.providers['backup-mt'] = {
      ...cfg.providers['google-free'],
      id: 'backup-mt',
      enabled: true,
    };
    cfg.routing.webpage = 'disabled-ai';
    cfg.routing.input = 'inherit';
    expect(resolveProviderIdForScene('webpage', cfg.routing, cfg.providers)).not.toBe(
      'disabled-ai',
    );
    expect(
      resolveProviderIdForScene('service-test', cfg.routing, cfg.providers, 'disabled-ai'),
    ).toBe('disabled-ai');

    // 2. Backfill legacy v2 stored config missing sourceScalePercent / translationScalePercent / stylePreset
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const fakeStore: Record<string, unknown> = {
      [BRAND.storageKeyConfig]: {
        ...createDefaultMarginConfig(),
        subtitles: {
          enabled: true,
          autoEnableYoutube: true,
          targetLang: 'zh-CN',
          displayMode: 'bilingual',
          fontSizePercent: 85,
          position: 'bottom',
        },
      },
    };
    let sendCalls = 0;
    let injectCalls = 0;
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: structuredClone(fakeStore[key]) }),
          set: async (obj: Record<string, unknown>) => {
            Object.assign(fakeStore, structuredClone(obj));
          },
        },
      },
      tabs: {
        sendMessage: async (tabId: number) => {
          sendCalls += 1;
          if (tabId === 99) {
            throw new Error('Cannot access a chrome:// URL');
          }
          if (sendCalls === 1) {
            throw new Error('Could not establish connection. Receiving end does not exist.');
          }
          return { ok: true, translated: true };
        },
      },
      scripting: {
        executeScript: async (opts: { target: { tabId: number }; files: string[] }) => {
          if (opts.target.tabId === 99) {
            throw new Error('Cannot access a chrome:// URL');
          }
          injectCalls += 1;
          expect(opts.files).toEqual(['content.js', 'image-translate.js']);
          return [];
        },
      },
    };

    try {
      const backfilled = await getMarginConfig();
      expect(backfilled.subtitles.sourceScalePercent).toBe(100);
      expect(backfilled.subtitles.translationScalePercent).toBe(85);
      expect(backfilled.subtitles.fontSizePercent).toBe(85);
      expect(backfilled.subtitles.stylePreset).toBe('youtube-native');

      // Pre-existing tab auto-injects once and retries with backoff until content script receiver is ready
      const retryRes = await sendTabCommand(42, {
        type: 'margin:cmd:toggle-page',
      });
      expect(injectCalls).toBe(1);
      expect(retryRes.ok).toBe(true);
      expect(retryRes.autoInjected).toBe(true);
      expect((retryRes.result as { translated: boolean }).translated).toBe(true);

      // Slow tab where first post-inject retry still hits missing receiver succeeds on second backoff step
      let slowSendCalls = 0;
      (
        (globalThis as Record<string, unknown>).chrome as {
          tabs: { sendMessage: (tabId: number) => Promise<unknown> };
        }
      ).tabs.sendMessage = async () => {
        slowSendCalls += 1;
        if (slowSendCalls <= 2) {
          throw new Error(
            'Could not establish connection. Receiving end does not exist.',
          );
        }
        return { ok: true, translatedAfterBackoff: true };
      };
      const backoffRes = await sendTabCommand(43, {
        type: 'margin:cmd:toggle-page',
      });
      expect(injectCalls).toBe(2);
      expect(slowSendCalls).toBe(3);
      expect(backoffRes.ok).toBe(true);
      expect(backoffRes.autoInjected).toBe(true);
      expect(
        (backoffRes.result as { translatedAfterBackoff: boolean })
          .translatedAfterBackoff,
      ).toBe(true);

      // Restricted chrome:// tab returns unsupportedPage: true cleanly
      (
        (globalThis as Record<string, unknown>).chrome as {
          tabs: { sendMessage: (tabId: number) => Promise<unknown> };
        }
      ).tabs.sendMessage = async () => {
        throw new Error('Cannot access a chrome:// URL');
      };
      const restrictedRes = await sendTabCommand(99, {
        type: 'margin:cmd:toggle-page',
      });
      expect(restrictedRes.ok).toBe(false);
      expect(restrictedRes.unsupportedPage).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).chrome = origChrome;
    }
  });

  it('seamlessly upgrades live v2.0/v2.1 stored configs to v2.2.0 Editorial Prompts, foreign auto-translate, glossary packs, and channel assistant migration', async () => {
    const legacyV20 = createDefaultMarginConfig() as unknown as Record<
      string,
      unknown
    >;
    delete legacyV20.enabledGlossaryPacks;
    delete legacyV20.promptSystemVersion;

    // Simulate pre-v2.2.0 webpage settings without autoTranslateMode
    legacyV20.webpage = {
      displayMode: 'bilingual',
      theme: 'none',
      themePatterns: [],
      lineBreakMaxTextCount: 280,
      enableRichHtml: true,
      autoTranslateMatches: false,
    };

    // Simulate pre-v2.2.0 assistants: old `builtin-yaml` with `thinking:`, missing `builtin-yaml-thinking`,
    // stock v2.0-imported `custom` (`泛用翻译大师` with `thinking:`), and a genuinely custom user assistant `my-custom`
    legacyV20.assistants = {
      'builtin-yaml': {
        ...structuredClone(BUILTIN_ASSISTANTS['builtin-yaml']),
        name: 'Old Builtin YAML',
        prompt: 'Output:\n- id: 1\n  thinking: old\n  trans: ...\n<yaml>\n{{yaml}}\n</yaml>',
        inputPrompt: undefined,
        selectionPrompt: undefined,
      },
      'builtin-delimiter': {
        ...structuredClone(BUILTIN_ASSISTANTS['builtin-delimiter']),
        name: 'Old Delimiter',
        inputPrompt: undefined,
        selectionPrompt: undefined,
      },
      custom: {
        id: 'custom',
        name: '泛用翻译大师',
        codec: 'yaml',
        enableRichHtml: true,
        temperaturePolicy: { mode: 'custom', value: 0.3 },
        maxBatchCount: 17,
        maxSubtitleBatchCount: 17,
        maxCharsPerBatch: 4096,
        separator: '\n\n%%\n\n',
        systemPrompt: 'You are a translator.',
        prompt:
          'Output inside <yaml>:\n- id: 1\n  thinking: step1\n  trans: step2\n<yaml>\n{{yaml}}\n</yaml>',
        env: {
          imt_yaml_item: '- id: {{id}}\n  src: |-\n    {{text}}',
        },
      },
      'my-custom': {
        id: 'my-custom',
        name: 'My Bespoke Academic Translator',
        codec: 'delimiter',
        enableRichHtml: true,
        temperaturePolicy: { mode: 'omit' },
        maxBatchCount: 6,
        maxSubtitleBatchCount: 10,
        maxCharsPerBatch: 2000,
        separator: '\n\n%%\n\n',
        systemPrompt: 'Academic style.',
        prompt: '{{text}}',
        env: {},
      },
    };

    legacyV20.providers = {
      ...(legacyV20.providers as Record<string, unknown>),
      'openai-luna': {
        ...(legacyV20.providers as Record<string, Record<string, unknown>>)[
          'google-free'
        ],
        id: 'openai-luna',
        preset: 'openai',
        protocol: 'openai-chat',
        model: 'gpt-6-luna',
        assistantId: 'custom',
      },
      'zhipu-glm': {
        ...(legacyV20.providers as Record<string, Record<string, unknown>>)[
          'google-free'
        ],
        id: 'zhipu-glm',
        preset: 'zhipu',
        protocol: 'openai-chat',
        model: 'glm-4.7',
        assistantId: 'custom',
      },
      'academic-prov': {
        ...(legacyV20.providers as Record<string, Record<string, unknown>>)[
          'google-free'
        ],
        id: 'academic-prov',
        preset: 'openai',
        protocol: 'openai-chat',
        model: 'gpt-4.1-mini',
        assistantId: 'my-custom',
      },
    };

    const { config: upgraded, mutated } = backfillStoredConfig(
      legacyV20 as unknown as ReturnType<typeof createDefaultMarginConfig>,
    );
    expect(mutated).toBe(true);
    expect(upgraded.promptSystemVersion).toBe(3);
    expect(upgraded.webpage.autoTranslateMode).toBe('foreign');
    expect(upgraded.webpage.autoTranslateMatches).toBe(true);
    expect(upgraded.webpage.autoTranslateLanguages).toEqual([]);
    expect(upgraded.enabledGlossaryPacks).toEqual([
      ...DEFAULT_ENABLED_GLOSSARY_PACK_IDS,
    ]);

    // Built-in presets upgraded & `builtin-yaml-thinking` added
    expect(upgraded.assistants['builtin-yaml'].name).toBe(
      BUILTIN_ASSISTANTS['builtin-yaml'].name,
    );
    expect(upgraded.assistants['builtin-yaml'].prompt).not.toContain('thinking:');
    expect(upgraded.assistants['builtin-yaml-thinking']).toBeDefined();

    // Stock `custom` (`泛用翻译大师`) kept intact in `assistants`, with missing scene prompts backfilled
    expect(upgraded.assistants.custom).toBeDefined();
    expect(upgraded.assistants.custom.name).toBe('泛用翻译大师');
    expect(upgraded.assistants.custom.inputPrompt).toBeTruthy();
    expect(upgraded.assistants.custom.selectionPrompt).toBeTruthy();
    expect(upgraded.assistants.custom.subtitlePrompt).toBeTruthy();
    expect(upgraded.assistants['my-custom'].inputPrompt).toBeTruthy();

    // Active channels using stock `custom` migrated to fast `'builtin-yaml'`; non-stock `my-custom` untouched!
    expect(upgraded.providers['openai-luna'].assistantId).toBe('builtin-yaml');
    expect(upgraded.providers['zhipu-glm'].assistantId).toBe('builtin-yaml');
    expect(upgraded.providers['academic-prov'].assistantId).toBe('my-custom');

    // Second pass is idempotent (`mutated === false`)
    const secondPass = backfillStoredConfig(upgraded);
    expect(secondPass.mutated).toBe(false);
  });

  it('wires requestTranslationCacheStats and requestClearTranslationCache RPC helpers', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const sentTypes: string[] = [];
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        sendMessage: async (req: { type: string }) => {
          sentTypes.push(req.type);
          if (req.type === 'margin:get-translation-cache-stats') {
            return {
              ok: true,
              memoryEntries: 12,
              persistentEntries: 340,
              dbAvailable: true,
            };
          }
          return { ok: true };
        },
      },
    };

    try {
      const stats = await requestTranslationCacheStats();
      expect(stats).toEqual({
        ok: true,
        memoryEntries: 12,
        persistentEntries: 340,
        dbAvailable: true,
      });
      const cleared = await requestClearTranslationCache();
      expect(cleared).toEqual({ ok: true });
      const warmup = await requestRuntimeWarmup({ scene: 'webpage' });
      expect(warmup).toEqual({ ok: true });
      expect(sentTypes).toEqual([
        'margin:get-translation-cache-stats',
        'margin:clear-translation-cache',
        'margin:warmup',
      ]);
    } finally {
      (globalThis as Record<string, unknown>).chrome = origChrome;
    }
  });

  it('migrates promptSystemVersion 2 -> 3 non-destructively, refreshing unedited stock prompts while preserving user edits and custom assistants', () => {
    const v2Cfg = createDefaultMarginConfig();
    v2Cfg.promptSystemVersion = 2;

    // Unedited v2 stock prompts for `builtin-yaml` and `builtin-yaml-thinking`
    v2Cfg.assistants['builtin-yaml'] = {
      ...structuredClone(BUILTIN_ASSISTANTS['builtin-yaml']),
      prompt:
        '{{title_prompt}}{{summary_prompt}}{{style_prompt}}{{glossary_prompt}}Translate into {{to}}:\n<yaml>\n{{yaml}}\n</yaml>',
      env: { ...BUILTIN_ASSISTANTS['builtin-yaml'].env },
    };
    delete v2Cfg.assistants['builtin-yaml'].env.thread_prompt;
    delete v2Cfg.assistants['builtin-yaml'].env.context_window_prompt;

    v2Cfg.assistants['builtin-yaml-thinking'] = {
      ...structuredClone(BUILTIN_ASSISTANTS['builtin-yaml-thinking']),
      prompt:
        '{{title_prompt}}{{summary_prompt}}{{style_prompt}}{{glossary_prompt}}Translate into {{to}} with brief `thinking` and polished `trans`:\n<yaml>\n{{yaml}}\n</yaml>',
      env: { ...BUILTIN_ASSISTANTS['builtin-yaml-thinking'].env },
    };
    delete v2Cfg.assistants['builtin-yaml-thinking'].env.thread_prompt;
    delete v2Cfg.assistants['builtin-yaml-thinking'].env.context_window_prompt;

    // User-edited built-in delimiter prompt MUST be strictly preserved!
    v2Cfg.assistants['builtin-delimiter'] = {
      ...structuredClone(BUILTIN_ASSISTANTS['builtin-delimiter']),
      prompt: 'USER CUSTOM DELIMITER PROMPT:\n{{text}}',
      env: {
        ...BUILTIN_ASSISTANTS['builtin-delimiter'].env,
        thread_prompt: 'USER CUSTOM THREAD: {{threadContext}}\n',
      },
    };

    // Custom user assistant MUST be strictly preserved!
    v2Cfg.assistants['my-custom-v2'] = {
      id: 'my-custom-v2',
      name: 'User Custom v2',
      codec: 'yaml',
      enableRichHtml: true,
      temperaturePolicy: { mode: 'omit' },
      maxBatchCount: 10,
      maxSubtitleBatchCount: 10,
      maxCharsPerBatch: 3000,
      separator: '\n\n%%\n\n',
      systemPrompt: 'Custom system prompt.',
      prompt: 'Custom prompt {{yaml}}',
      env: { imt_yaml_item: '- id: {{id}}\n  src: {{text}}' },
    };

    const { config: v3Cfg, mutated } = backfillStoredConfig(v2Cfg);
    expect(mutated).toBe(true);
    expect(v3Cfg.promptSystemVersion).toBe(3);

    // Unedited built-ins refreshed with {{thread_prompt}}{{context_window_prompt}} and env macros
    expect(v3Cfg.assistants['builtin-yaml'].prompt).toContain(
      '{{thread_prompt}}{{context_window_prompt}}',
    );
    expect(v3Cfg.assistants['builtin-yaml'].env.thread_prompt).toBe(
      BUILTIN_ASSISTANTS['builtin-yaml'].env.thread_prompt,
    );
    expect(v3Cfg.assistants['builtin-yaml'].env.context_window_prompt).toBe(
      BUILTIN_ASSISTANTS['builtin-yaml'].env.context_window_prompt,
    );
    expect(v3Cfg.assistants['builtin-yaml-thinking'].prompt).toContain(
      '{{thread_prompt}}{{context_window_prompt}}',
    );

    // User-edited built-in prompt and env preserved, while missing context_window_prompt env added safely
    expect(v3Cfg.assistants['builtin-delimiter'].prompt).toBe(
      'USER CUSTOM DELIMITER PROMPT:\n{{text}}',
    );
    expect(v3Cfg.assistants['builtin-delimiter'].env.thread_prompt).toBe(
      'USER CUSTOM THREAD: {{threadContext}}\n',
    );
    expect(v3Cfg.assistants['builtin-delimiter'].env.context_window_prompt).toBe(
      BUILTIN_ASSISTANTS['builtin-delimiter'].env.context_window_prompt,
    );

    // Custom assistant untouched
    expect(v3Cfg.assistants['my-custom-v2'].prompt).toBe('Custom prompt {{yaml}}');
    expect(v3Cfg.assistants['my-custom-v2'].env).toEqual({
      imt_yaml_item: '- id: {{id}}\n  src: {{text}}',
    });

    // Idempotent on second run
    expect(backfillStoredConfig(v3Cfg).mutated).toBe(false);
  });
});
