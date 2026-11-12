import { beforeEach, describe, expect, it } from 'vitest';
import { BRAND } from '@shared/brand';
import {
  createDefaultMarginConfig,
  resolveProviderIdForScene,
} from '@shared/constants';
import { sendTabCommand } from '@shared/messaging';
import { SHADOW_HOST_RESET_CSS } from '@shared/shadow-styles';
import {
  appendDiagnosticSnapshot,
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
    expect(BRAND.version).toBe('2.1.1');
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
    expect(defaults.subtitles.sourceScalePercent).toBe(100);
    expect(defaults.subtitles.translationScalePercent).toBe(70);
    expect(defaults.subtitles.stylePreset).toBe('youtube-native');
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

      // Pre-existing tab auto-injects once and retries cleanly
      const retryRes = await sendTabCommand(42, {
        type: 'margin:cmd:toggle-page',
      });
      expect(injectCalls).toBe(1);
      expect(retryRes.ok).toBe(true);
      expect(retryRes.autoInjected).toBe(true);
      expect((retryRes.result as { translated: boolean }).translated).toBe(true);

      // Restricted chrome:// tab returns unsupportedPage: true cleanly
      const restrictedRes = await sendTabCommand(99, {
        type: 'margin:cmd:toggle-page',
      });
      expect(restrictedRes.ok).toBe(false);
      expect(restrictedRes.unsupportedPage).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).chrome = origChrome;
    }
  });
});
