import { describe, expect, it } from 'vitest';
import {
  exportMarginConfig,
  importLegacyConfig,
  redactProviderUrl,
} from '@core/migration';
import {
  createDefaultMarginConfig,
  resolveProviderIdForScene,
} from '@shared/constants';
import { resolveEffectiveTemperature } from '@shared/temperature';

function buildSanitizedUserLegacyConfigReplica(): Record<string, unknown> {
  return {
    interfaceLanguage: 'zh-CN',
    targetLanguage: 'zh-CN',
    sourceLanguage: 'auto',
    // Stale legacy top-level keys left behind by v1 downgrade-compat writes:
    translationService: 'openai',
    inputTranslationService: 'zhipu',
    enableInputTranslation: true,
    translationTheme: 'mask',
    translationThemePatterns: {
      none: { matches: ['https://arxiv.org/*'] },
      opacity: { matches: ['https://news.ycombinator.com/*'] },
      weakening: ['https://lobste.rs/*'],
    },
    pcFloatBall: { enable: false },
    monkeyH5FloatBall: { enable: false },
    sidePanel: { enable: false },
    generalRule: {
      lineBreakMaxTextCount: 280,
      'selectionTranslation.add': {
        enable: false,
      },
      'subtitleRule.add': {
        autoEnableSubtitle: true,
        youtubeAutoEnableSubtitle: true,
        preTranslation: true,
        translationFontSize: '70',
        translationPosition: 'bottom',
      },
    },
    translationUrlPattern: {
      matches: ['https://docs.example.com/*'],
      excludeMatches: ['https://linux.do/*'],
    },
    customAiAssistants: {
      'custom-4XA4Dkqm': {
        id: 'custom-4XA4Dkqm',
        name: '通用翻译',
        systemPrompt:
          'You are a professional translator. Translate into {{to}} and keep %% paragraph delimiters intact.',
        prompt: '{{text}}',
        multiplePrompt: '{{text}}',
        translationTextSeparator: '\n\n%%\n\n',
        maxTextGroupLengthPerRequest: 4,
        maxTextLengthPerRequest: 1200,
      },
      custom: {
        id: 'custom',
        name: '泛用翻译大师',
        enableRichTranslate: true,
        maxTextGroupLengthPerRequest: 17,
        maxTextGroupLengthPerRequestForSubtitle: 17,
        maxTextLengthPerRequest: 4096,
        // Intentional replica of Aloxaf YAML preset typo ("temperatre"):
        temperatre: 0.3,
        systemPrompt:
          'Translate into {{to}}. Output strictly inside <yaml>...</yaml> with id, thinking, trans.',
        prompt:
          '{{title_prompt}}{{summary_prompt}}{{terms_prompt}}<yaml>\n{{yaml}}\n</yaml>',
        subtitlePrompt:
          '{{title_prompt}}{{sub_terms_prompt}}<yaml>\n{{yaml}}\n</yaml>',
        env: {
          imt_yaml_item: '- id: {{id}}\n  src: |-\n    {{text}}',
          imt_subtitle_yaml_item: '- id: {{id}}\n  src: {{text}}',
          imt_source_field: 'src',
          imt_trans_field: 'trans',
          title_prompt: 'Title: {{imt_title}}\n',
          summary_prompt: 'Summary: {{imt_theme}}\n',
          terms_prompt: 'Glossary: {{imt_terms}}\n',
          sub_terms_prompt: 'Glossary: {{imt_terms}}\n',
        },
      },
    },
    translationServices: {
      // Unconfigured hidden legacy built-in placeholders that must be skipped:
      openai: {
        visible: false,
      },
      bing: {
        visible: false,
      },
      'openai-deleted': {
        extends: 'openai',
        isDeleted: true,
        APIKEY: 'sk-TEST_FAKE_KEY_DO_NOT_USE_DELETED',
        apiUrl: 'https://gateway.example.test/v1/chat/completions',
        model: 'gpt-4o-mini',
      },
      // Active user services:
      'openai-bytb6BIB': {
        name: 'Gateway GPT-6 Luna',
        extends: 'openai',
        type: 'openai',
        apiUrl: 'https://gateway.example.test/v1/chat/completions',
        APIKEY: 'sk-TEST_FAKE_KEY_DO_NOT_USE_1,sk-TEST_FAKE_KEY_DO_NOT_USE_2',
        model: 'gpt-6-luna',
        customModels: ['gpt-6-luna', 'gpt-5.4-mini'],
        assistantId: 'custom',
        enableAIContext: true,
        enableRichTranslate: true,
        limit: '50',
      },
      'openai-rycRGYJc': {
        name: 'Gateway GPT-5.6 Luna',
        extends: 'openai',
        type: 'openai',
        apiUrl: 'https://gateway.example.test/v1',
        APIKEY: 'sk-TEST_FAKE_KEY_DO_NOT_USE_3',
        model: 'gpt-5.6-luna',
        assistantId: 'custom',
        enableAIContext: true,
        limit: 30,
        temperature: '',
      },
      'deepseek-miDlPhjk': {
        name: 'Gateway Codex Spark',
        extends: 'deepseek',
        type: 'deepseek',
        apiUrl: 'https://gateway.example.test/v1/chat/completions',
        APIKEY: 'sk-TEST_FAKE_KEY_DO_NOT_USE_4\nsk-TEST_FAKE_KEY_DO_NOT_USE_5',
        model: 'gpt-5.3-codex-spark',
        assistantId: 'custom',
        enableAIContext: true,
        limit: '20',
        temperature: '0',
      },
      'zhipu-kSWi96Ql': {
        name: '智谱 GLM',
        extends: 'zhipu',
        type: 'zhipu',
        APIKEY: 'sk-TEST_FAKE_KEY_DO_NOT_USE_ZHIPU',
        model: 'glm-4-air',
        customModels: ['glm-4.6', 'glm-4.7'],
        assistantId: 'custom',
        limit: 20,
        bodyConfigs: {
          temperature: 0.01,
          thinking: { type: 'disabled' },
        },
      },
      deeplx: {
        url: 'http://127.0.0.1:1188/translate',
        enableRichTranslate: true,
        limit: 20,
      },
      'deeplx-custom': {
        name: 'Private DeepLX Pool',
        extends: 'deeplx',
        url: 'https://api.deeplx.org/TEST_FAKE_DEEPLX_SECRET_DO_NOT_USE/translate, https://deeplx.example.test/v1/TEST_FAKE_SECOND_SECRET_DO_NOT_USE/translate',
        enableRichTranslate: true,
        limit: '20',
      },
      'google-free': {
        visible: true,
      },
    },
    terms: {
      version: 1,
      data: [
        {
          id: 'default',
          name: 'AI Terms',
          active: true,
          glossaries: [
            { k: 'LLM', v: '' },
            { k: 'LLMs', v: '' },
            { k: 'Agentic Workflow', v: '智能体工作流', domain: 'arxiv.org' },
          ],
        },
        {
          id: 'archived',
          name: 'Inactive Group',
          active: false,
          glossaries: [{ k: 'ShouldSkip', v: '跳过' }],
        },
      ],
    },
    // Authoritative runtime routing table at bottom of exported v1 JSON:
    userTranslationServices: {
      translationService: 'openai-bytb6BIB',
      inputTranslationService: 'inherit',
      subtitleTranslateService: 'inherit',
      mouseHoverTranslationService: 'inherit',
      clientImageTranslationService: 'inherit',
    },
  };
}

describe('importLegacyConfig — full structural replica of user v1 config', () => {
  it('imports providers, assistants, routing precedence, glossary, themes, subtitles, and URL exclusions accurately from JSON string', () => {
    const rawJson = JSON.stringify(buildSanitizedUserLegacyConfigReplica());
    const result = importLegacyConfig(rawJson);
    const { config, audit, stats } = result;

    expect(config.schemaVersion).toBe(2);
    expect(config.interfaceLang).toBe('zh-CN');
    expect(config.targetLang).toBe('zh-CN');
    expect(config.sourceLang).toBe('auto');

    // 1. Scene Routing Precedence: userTranslationServices > stale top-level ("openai" / "zhipu")
    expect(config.routing.webpage).toBe('openai-bytb6BIB');
    expect(config.routing.input).toBe('inherit');
    expect(config.routing.subtitle).toBe('inherit');
    expect(config.routing.hover).toBe('inherit');
    expect(config.routing.image).toBe('inherit');
    expect(config.routing.pdf).toBe('inherit');
    expect(config.routing.selection).toBe('inherit');

    // Dynamic "inherit" resolution tracks routing.webpage (never stuck on stale "zhipu")
    expect(
      resolveProviderIdForScene('input', config.routing, config.providers),
    ).toBe('openai-bytb6BIB');
    expect(
      resolveProviderIdForScene('subtitle', config.routing, config.providers),
    ).toBe('openai-bytb6BIB');

    const switchedRouting = { ...config.routing, webpage: 'deepseek-miDlPhjk' };
    expect(
      resolveProviderIdForScene('input', switchedRouting, config.providers),
    ).toBe('deepseek-miDlPhjk');

    // Audit records overrides of stale top-level service keys
    const utsOverrides = audit.filter((a) => a.code === 'routing-uts-override');
    expect(utsOverrides.length).toBeGreaterThanOrEqual(2);
    expect(
      utsOverrides.some(
        (a) =>
          a.message.includes('openai-bytb6BIB') && a.message.includes('openai'),
      ),
    ).toBe(true);
    expect(
      utsOverrides.some(
        (a) => a.message.includes('inherit') && a.message.includes('zhipu'),
      ),
    ).toBe(true);

    // 2. Custom Assistants & "temperatre" -> 0.3 normalization
    expect(stats.assistantsImported).toBe(2);

    const delimAst = config.assistants['custom-4XA4Dkqm'];
    expect(delimAst).toBeDefined();
    expect(delimAst.name).toBe('通用翻译');
    expect(delimAst.codec).toBe('delimiter');
    expect(delimAst.maxBatchCount).toBe(4);
    expect(delimAst.maxSubtitleBatchCount).toBe(4);
    expect(delimAst.maxCharsPerBatch).toBe(1200);
    expect(delimAst.enableRichHtml).toBe(true);
    expect(delimAst.separator).toBe('\n\n%%\n\n');
    expect(delimAst.temperaturePolicy).toEqual({ mode: 'omit' });

    const yamlAst = config.assistants.custom;
    expect(yamlAst).toBeDefined();
    expect(yamlAst.name).toBe('泛用翻译大师');
    expect(yamlAst.codec).toBe('yaml');
    expect(yamlAst.enableRichHtml).toBe(true);
    expect(yamlAst.maxBatchCount).toBe(17);
    expect(yamlAst.maxSubtitleBatchCount).toBe(17);
    expect(yamlAst.maxCharsPerBatch).toBe(4096);
    expect(yamlAst.temperaturePolicy).toEqual({ mode: 'custom', value: 0.3 });
    expect(yamlAst.env.imt_yaml_item).toContain('{{id}}');

    const typoAudit = audit.find(
      (a) => a.level === 'normalized' && a.code === 'assistant-temperatre-typo',
    );
    expect(typoAudit).toBeDefined();
    expect(typoAudit?.message).toContain('temperatre');
    expect(typoAudit?.message).toContain('0.3');
    expect(stats.normalizedFields).toBeGreaterThanOrEqual(4);

    // 3. Providers (7 active imported; deleted & hidden empty placeholders skipped)
    expect(stats.providersImported).toBe(7);
    expect(config.providers.openai).toBeUndefined();
    expect(config.providers.bing).toBeUndefined();
    expect(config.providers['openai-deleted']).toBeUndefined();

    const luna6 = config.providers['openai-bytb6BIB'];
    expect(luna6.preset).toBe('openai');
    expect(luna6.protocol).toBe('openai-chat');
    expect(luna6.baseUrl).toBe('https://gateway.example.test/v1/chat/completions');
    expect(luna6.apiKeys).toEqual([
      'sk-TEST_FAKE_KEY_DO_NOT_USE_1',
      'sk-TEST_FAKE_KEY_DO_NOT_USE_2',
    ]);
    expect(luna6.model).toBe('gpt-6-luna');
    expect(luna6.models).toEqual(['gpt-6-luna', 'gpt-5.4-mini']);
    expect(luna6.assistantId).toBe('custom');
    expect(luna6.enableContext).toBe(true);
    expect(luna6.enableRichHtml).toBe(true);
    expect(luna6.rateLimitRps).toBe(50);
    expect(luna6.temperaturePolicy).toEqual({ mode: 'omit' });

    const luna56 = config.providers['openai-rycRGYJc'];
    expect(luna56.model).toBe('gpt-5.6-luna');
    expect(luna56.baseUrl).toBe('https://gateway.example.test/v1');
    expect(luna56.rateLimitRps).toBe(30);
    expect(luna56.temperaturePolicy).toEqual({ mode: 'omit' });

    const codexSpark = config.providers['deepseek-miDlPhjk'];
    expect(codexSpark.preset).toBe('deepseek');
    expect(codexSpark.protocol).toBe('openai-chat');
    expect(codexSpark.model).toBe('gpt-5.3-codex-spark');
    expect(codexSpark.apiKeys).toEqual([
      'sk-TEST_FAKE_KEY_DO_NOT_USE_4',
      'sk-TEST_FAKE_KEY_DO_NOT_USE_5',
    ]);
    expect(codexSpark.rateLimitRps).toBe(20);
    expect(codexSpark.temperaturePolicy).toEqual({ mode: 'omit' });

    const zhipu = config.providers['zhipu-kSWi96Ql'];
    expect(zhipu.preset).toBe('zhipu');
    expect(zhipu.protocol).toBe('openai-chat');
    expect(zhipu.baseUrl).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    );
    expect(zhipu.model).toBe('glm-4-air');
    expect(zhipu.models).toEqual(['glm-4-air', 'glm-4.6', 'glm-4.7']);
    expect(zhipu.temperaturePolicy).toEqual({ mode: 'omit' });
    expect(zhipu.thinkingPolicy).toEqual({ mode: 'disabled' });

    const deeplxCustom = config.providers['deeplx-custom'];
    expect(deeplxCustom.preset).toBe('deeplx');
    expect(deeplxCustom.protocol).toBe('deeplx');
    expect(deeplxCustom.endpoints).toEqual([
      'https://api.deeplx.org/TEST_FAKE_DEEPLX_SECRET_DO_NOT_USE/translate',
      'https://deeplx.example.test/v1/TEST_FAKE_SECOND_SECRET_DO_NOT_USE/translate',
    ]);
    expect(deeplxCustom.baseUrl).toBe(
      'https://api.deeplx.org/TEST_FAKE_DEEPLX_SECRET_DO_NOT_USE/translate',
    );
    expect(deeplxCustom.enableRichHtml).toBe(true);
    expect(deeplxCustom.rateLimitRps).toBe(20);

    expect(config.providers['google-free'].protocol).toBe('google-web');

    // 4. End-to-End Effective Temperature Check with Normalized Assistant 0.3:
    // Reasoning models omit temperature; Zhipu GLM-4 inherits Aloxaf 0.3 cleanly (no 0.01 clobber!)
    for (const strictProvider of [luna6, luna56, codexSpark]) {
      expect(
        resolveEffectiveTemperature({
          model: strictProvider.model,
          providerPolicy: strictProvider.temperaturePolicy,
          assistantPolicy: yamlAst.temperaturePolicy,
        }),
      ).toEqual({ value: undefined, trace: 'omitted-reasoning-guard' });
    }
    expect(
      resolveEffectiveTemperature({
        model: zhipu.model,
        providerPolicy: zhipu.temperaturePolicy,
        assistantPolicy: yamlAst.temperaturePolicy,
      }),
    ).toEqual({ value: 0.3, trace: 'sent-assistant-custom' });

    // 5. Glossary (`v: ""` keep-original preserved, inactive group skipped)
    expect(stats.glossaryEntriesImported).toBe(3);
    expect(config.glossary).toEqual([
      { k: 'LLM', v: '' },
      { k: 'LLMs', v: '' },
      { k: 'Agentic Workflow', v: '智能体工作流', domain: 'arxiv.org' },
    ]);

    // 6. Webpage, Input, Selection, Subtitles & URL Rules
    expect(config.webpage.theme).toBe('mask');
    expect(config.webpage.lineBreakMaxTextCount).toBe(280);
    expect(config.webpage.themePatterns).toEqual([
      { pattern: 'https://arxiv.org/*', theme: 'none' },
      { pattern: 'https://news.ycombinator.com/*', theme: 'opacity' },
      { pattern: 'https://lobste.rs/*', theme: 'weakening' },
    ]);
    expect(config.input.enabled).toBe(true);
    expect(config.selection.enabled).toBe(false);
    expect(config.subtitles).toEqual({
      autoEnable: true,
      youtubeAutoEnable: true,
      preTranslate: true,
      displayMode: 'bilingual',
      fontSizePercent: 70,
      sourceScalePercent: 100,
      translationScalePercent: 70,
      stylePreset: 'youtube-native',
      position: 'bottom',
    });
    expect(config.urlRules.excludeMatches).toEqual(['https://linux.do/*']);
    expect(config.urlRules.includeMatches).toEqual([
      'https://docs.example.com/*',
    ]);

    // 7. Deprecated keys recorded as ignored
    expect(stats.ignoredLegacyKeys).toEqual([
      'pcFloatBall',
      'monkeyH5FloatBall',
      'sidePanel',
    ]);
    const ignoredItems = audit.filter(
      (a) => a.level === 'ignored' && a.code === 'deprecated-legacy-key',
    );
    expect(ignoredItems).toHaveLength(3);
  });
});

describe('importLegacyConfig — edge cases & alternate legacy schemas', () => {
  it('supports flat glossary arrays, Claude/Anthropic services, json-batch codec detection, and nested selectionTranslation', () => {
    const result = importLegacyConfig({
      translationServices: {
        'claude-main': {
          name: 'Anthropic Sonnet',
          extends: 'claude',
          APIKEY: 'sk-ant-TEST_FAKE_KEY_DO_NOT_USE',
          model: 'claude-sonnet-4-5',
          temperature: 0.4,
        },
      },
      customAiAssistants: [
        {
          id: 'plain-json-ast',
          name: 'JSON Batch Assistant',
          prompt: 'Translate the JSON array into {{to}}.',
          maxTextGroupLengthPerRequest: 10,
          maxTextLengthPerRequest: 2500,
          enableRichTranslate: false,
        },
      ],
      generalRule: {
        selectionTranslation: {
          enable: true,
          triggerMode: 'dot',
        },
      },
      terms: [
        { k: 'LLM', v: '' },
        { k: 'RAG', v: '检索增强生成', caseSensitive: true },
      ],
      userTranslationServices: {
        translationService: 'claude-main',
      },
    });

    const claude = result.config.providers['claude-main'];
    expect(claude.preset).toBe('anthropic');
    expect(claude.protocol).toBe('anthropic-messages');
    expect(claude.baseUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(claude.temperaturePolicy).toEqual({ mode: 'custom', value: 0.4 });

    const jsonAst = result.config.assistants['plain-json-ast'];
    expect(jsonAst.codec).toBe('json-batch');
    expect(jsonAst.maxBatchCount).toBe(10);
    expect(jsonAst.maxSubtitleBatchCount).toBe(10);
    expect(jsonAst.enableRichHtml).toBe(false);

    expect(result.config.selection).toEqual({
      enabled: true,
      triggerMode: 'dot',
    });
    expect(result.config.glossary).toEqual([
      { k: 'LLM', v: '' },
      { k: 'RAG', v: '检索增强生成', caseSensitive: true },
    ]);
  });

  it('falls back safely when configured routing targets are deleted or invisible', () => {
    const result = importLegacyConfig({
      translationServices: {
        'openai-dead': {
          extends: 'openai',
          isDeleted: true,
          APIKEY: 'sk-TEST_FAKE_KEY_DO_NOT_USE',
          model: 'gpt-4.1-mini',
        },
        'openai-live': {
          extends: 'openai',
          APIKEY: 'sk-TEST_FAKE_KEY_DO_NOT_USE_LIVE',
          model: 'gpt-4.1-mini',
        },
      },
      userTranslationServices: {
        translationService: 'openai-dead',
        pdfTranslationService: 'missing-service',
      },
    });

    expect(result.config.routing.webpage).toBe('openai-live');
    expect(result.config.routing.pdf).toBe('inherit');
    expect(
      result.audit.some((a) => a.code === 'routing-webpage-fallback'),
    ).toBe(true);
    expect(
      result.audit.some((a) => a.code === 'routing-scene-fallback-inherit'),
    ).toBe(true);
  });

  it('handles UTF-8 BOM JSON strings, storage envelopes, camelCase apiKey, string customModels, and rejects malformed JSON cleanly', () => {
    const withBom = `\uFEFF${JSON.stringify({
      userCustomConfig: {
        targetLanguage: 'ja',
        interfaceLanguage: 'en-US',
        pdfTranslationService: 'google-free',
        imageTranslationService: 'deeplx',
        userTranslationServices: {
          translationService: 'openai-camel',
          pdfTranslationService: 'inherit',
          imageTranslationService: 'inherit',
        },
        translationServices: {
          'openai-camel': {
            extends: 'openai',
            apiKey: 'sk-TEST_FAKE_CAMEL_KEY_1, sk-TEST_FAKE_CAMEL_KEY_2',
            model: 'gpt-4.1-mini',
            customModels: 'gpt-4.1-mini, gpt-4o',
          },
          'openai-hidden-configured': {
            extends: 'openai',
            visible: false,
            APIKEY: 'sk-TEST_FAKE_HIDDEN_KEY',
            apiUrl: 'https://hidden.example.test/v1/chat/completions',
            model: 'gpt-4o-mini',
          },
        },
      },
    })}`;
    const imported = importLegacyConfig(withBom);
    expect(imported.config.targetLang).toBe('ja');
    expect(imported.config.interfaceLang).toBe('en');
    expect(imported.config.routing.webpage).toBe('openai-camel');
    expect(imported.config.routing.pdf).toBe('inherit');
    expect(imported.config.routing.image).toBe('inherit');
    expect(imported.config.providers['openai-camel'].apiKeys).toEqual([
      'sk-TEST_FAKE_CAMEL_KEY_1',
      'sk-TEST_FAKE_CAMEL_KEY_2',
    ]);
    expect(imported.config.providers['openai-camel'].models).toEqual([
      'gpt-4.1-mini',
      'gpt-4o',
    ]);
    expect(imported.config.providers['openai-hidden-configured'].enabled).toBe(
      false,
    );

    expect(() => importLegacyConfig('{invalid json')).toThrow(
      /Invalid JSON configuration/i,
    );
    expect(() => importLegacyConfig('["not-an-object"]')).toThrow(
      /root value must be a JSON object/i,
    );
  });
});

describe('exportMarginConfig & Margin v2 round-trip', () => {
  it('redacts apiKeys, auth headers, and private DeepLX URL path tokens by default without mutating source config', () => {
    const { config } = importLegacyConfig(buildSanitizedUserLegacyConfigReplica());
    config.providers['openai-bytb6BIB'].extraHeaders = {
      Authorization: 'Bearer sk-TEST_FAKE_BEARER_DO_NOT_USE',
      'x-api-key': 'sk-TEST_FAKE_HEADER_KEY_DO_NOT_USE',
      'X-Client-App': 'Margin',
    };

    const redactedJson = exportMarginConfig(config);
    const parsed = JSON.parse(redactedJson) as typeof config;

    // Original config remains completely unmutated
    expect(config.providers['openai-bytb6BIB'].apiKeys).toHaveLength(2);
    expect(config.providers['openai-bytb6BIB'].extraHeaders?.Authorization).toContain(
      'Bearer',
    );
    expect(config.providers['deeplx-custom'].baseUrl).toContain(
      'TEST_FAKE_DEEPLX_SECRET_DO_NOT_USE',
    );

    // Zero fake secrets survive anywhere in the serialized shareable JSON
    expect(redactedJson).not.toContain('TEST_FAKE_');

    // API keys stripped
    expect(parsed.providers['openai-bytb6BIB'].apiKeys).toEqual([]);
    expect(parsed.providers['zhipu-kSWi96Ql'].apiKeys).toEqual([]);

    // Sensitive headers stripped while non-secret headers stay intact
    expect(parsed.providers['openai-bytb6BIB'].extraHeaders).toEqual({
      'X-Client-App': 'Margin',
    });

    // Private DeepLX embedded path tokens masked; local/public DeepLX URL preserved
    expect(parsed.providers['deeplx-custom'].baseUrl).toBe(
      'https://api.deeplx.org/<REDACTED>/translate',
    );
    expect(parsed.providers['deeplx-custom'].endpoints).toEqual([
      'https://api.deeplx.org/<REDACTED>/translate',
      'https://deeplx.example.test/v1/<REDACTED>/translate',
    ]);
    expect(parsed.providers.deeplx.baseUrl).toBe(
      'http://127.0.0.1:1188/translate',
    );

    // Re-importing a redacted shareable v2 export works cleanly and flags redacted placeholders
    const reimported = importLegacyConfig(redactedJson);
    expect(reimported.config.schemaVersion).toBe(2);
    expect(reimported.config.routing.webpage).toBe('openai-bytb6BIB');
    expect(reimported.config.routing.input).toBe('inherit');
    expect(
      reimported.audit.some((a) => a.code === 'redacted-secrets-detected'),
    ).toBe(true);
  });

  it('preserves 100% lossless MarginConfig in full backup mode (includeSecrets: true) across round-trip import', () => {
    const base = createDefaultMarginConfig();
    const { config } = importLegacyConfig(
      buildSanitizedUserLegacyConfigReplica(),
      base,
    );
    config.uiColorMode = 'night';
    config.providers['openai-bytb6BIB'].extraHeaders = {
      'X-Custom-Gateway': 'unbow',
      Authorization: 'Bearer sk-TEST_FAKE_BACKUP_TOKEN_DO_NOT_USE',
    };

    const backupJson = exportMarginConfig(config, { includeSecrets: true });
    expect(backupJson).toContain('sk-TEST_FAKE_KEY_DO_NOT_USE_1');
    expect(backupJson).toContain('TEST_FAKE_DEEPLX_SECRET_DO_NOT_USE');

    const roundTrip = importLegacyConfig(backupJson);
    expect(roundTrip.config).toEqual(config);
    expect(roundTrip.stats.providersImported).toBe(
      Object.keys(config.providers).length,
    );
    expect(roundTrip.stats.assistantsImported).toBe(
      Object.keys(config.assistants).length,
    );
    expect(roundTrip.stats.glossaryEntriesImported).toBe(config.glossary.length);
  });

  it('redactProviderUrl preserves safe route prefixes and non-secret query params while masking query keys and userinfo', () => {
    expect(
      redactProviderUrl(
        'https://user:TEST_FAKE_PASS@proxy.example.test/openai/deployments/gpt4/chat/completions?api-version=2024-10-21&api-key=TEST_FAKE_QUERY_KEY',
        false,
      ),
    ).toBe(
      'https://<REDACTED>@proxy.example.test/openai/deployments/gpt4/chat/completions?api-version=2024-10-21&api-key=<REDACTED>',
    );
    expect(
      redactProviderUrl('https://deeplx.example.test/api/v2/translate', true),
    ).toBe('https://deeplx.example.test/api/v2/translate');
  });
});
