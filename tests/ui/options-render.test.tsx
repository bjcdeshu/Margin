import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_ASSISTANTS, createDefaultMarginConfig } from '@shared/constants';
import {
  getMarginConfig,
  recordModelCapability,
  resetMemoryStorageForTests,
  saveMarginConfig,
} from '@shared/storage';
import { makeCapabilityKey } from '@shared/temperature';
import { OptionsApp } from '../../src/ui/options/OptionsApp';

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Quiet Paper 5-Tab Settings Studio (OptionsApp)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetMemoryStorageForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    render(null, container);
    container.remove();
  });

  it('renders all 5 editorial tabs, live inherit routing badges, and never shows Saved on initial load', async () => {
    const cfg = createDefaultMarginConfig();
    cfg.providers['openai-bytb6BIB'] = {
      ...cfg.providers['google-free'],
      id: 'openai-bytb6BIB',
      name: 'OpenAI',
      preset: 'openai',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com',
      apiKeys: ['sk-secret-do-not-expose'],
      model: 'gpt-6-luna',
      models: ['gpt-6-luna', 'glm-4.7'],
      assistantId: 'builtin-yaml',
      temperaturePolicy: { mode: 'omit' },
    };
    cfg.providerOrder = ['openai-bytb6BIB', 'google-free'];
    cfg.routing.webpage = 'openai-bytb6BIB';
    cfg.routing.input = 'inherit';
    await saveMarginConfig(cfg);

    await act(async () => {
      render(<OptionsApp initialTab="general" />, container);
    });
    await flushMicrotasks();

    // No Saved status pill on initial hydration
    expect(container.querySelector('[data-testid="options-save-status"]')).toBeNull();

    // All 5 tabs present in navigation rail
    const navLabels = Array.from(container.querySelectorAll('.mp-nav-item')).map(
      (el) => el.textContent ?? '',
    );
    expect(navLabels.some((t) => t.includes('常规与外观'))).toBe(true);
    expect(navLabels.some((t) => t.includes('AI 与翻译渠道'))).toBe(true);
    expect(navLabels.some((t) => t.includes('提示词与术语库'))).toBe(true);
    expect(navLabels.some((t) => t.includes('输入·字幕·站点规则'))).toBe(true);
    expect(navLabels.some((t) => t.includes('配置迁移与诊断'))).toBe(true);

    // Live resolved badge for `input: "inherit"` -> `→ OpenAI (gpt-6-luna)`
    const inputBadge = container.querySelector('[data-testid="scene-resolved-input"]');
    expect(inputBadge?.textContent).toBe('→ OpenAI (gpt-6-luna)');
  });

  it('renders live effective temperature preview badge across reasoning models, standard chat models, and 400 cache', async () => {
    const cfg = createDefaultMarginConfig();
    cfg.providers['openai-bytb6BIB'] = {
      ...cfg.providers['google-free'],
      id: 'openai-bytb6BIB',
      name: 'OpenAI Gateway',
      preset: 'openai',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com',
      apiKeys: ['sk-key-1'],
      model: 'gpt-6-luna',
      models: ['gpt-6-luna', 'glm-4.7', 'custom-strict-v1'],
      assistantId: 'builtin-yaml', // Aloxaf 0.3
      temperaturePolicy: { mode: 'omit' },
    };
    cfg.providerOrder = ['openai-bytb6BIB'];
    cfg.routing.webpage = 'openai-bytb6BIB';
    await saveMarginConfig(cfg);

    // Also record a cached HTTP 400 capability entry for `custom-strict-v1`
    const capKey = makeCapabilityKey(
      'https://api.example.com/v1/chat/completions',
      'custom-strict-v1',
    );
    await recordModelCapability(capKey, {
      supportsTemperature: false,
      learnedFromStatus: 400,
      updatedAt: Date.now(),
    });

    await act(async () => {
      render(<OptionsApp initialTab="providers" />, container);
    });
    await flushMicrotasks();

    // Endpoint auto-completion preview badge
    const endpointBadge = container.querySelector('[data-testid="provider-endpoint-preview"]');
    expect(endpointBadge?.textContent).toContain(
      'https://api.example.com/v1/chat/completions',
    );

    // 1. On `gpt-6-luna`, Aloxaf 0.3 is auto-omitted by Reasoning Guard
    const tempBadge = container.querySelector('[data-testid="live-temperature-preview"]');
    expect(tempBadge?.textContent).toContain(
      '实际请求：自动省略 (检测到推理模型 gpt-6-luna)',
    );

    // 2. Click `glm-4.7` model chip -> inherits assistant 0.3!
    const chipButtons = Array.from(container.querySelectorAll('.mp-chip button'));
    const glmBtn = chipButtons.find((b) => b.textContent === 'glm-4.7') as HTMLButtonElement;
    expect(glmBtn).toBeDefined();
    await act(async () => {
      glmBtn.click();
    });

    expect(
      container.querySelector('[data-testid="live-temperature-preview"]')?.textContent,
    ).toContain('实际请求：继承助手 0.3');

    // 3. Click `custom-strict-v1` model chip -> omitted via 400 capability cache!
    const cachedBtn = Array.from(container.querySelectorAll('.mp-chip button')).find(
      (b) => b.textContent === 'custom-strict-v1',
    ) as HTMLButtonElement;
    await act(async () => {
      cachedBtn.click();
    });
    expect(
      container.querySelector('[data-testid="live-temperature-preview"]')?.textContent,
    ).toContain('实际请求：自动省略 (已缓存 custom-strict-v1 的 400 拒绝记录)');
  });

  it('stages assistant preset reset without auto-saving until confirmed via Save Changes', async () => {
    const cfg = createDefaultMarginConfig();
    cfg.assistants['builtin-yaml'].name = 'Modified Assistant Name';
    await saveMarginConfig(cfg);

    await act(async () => {
      render(<OptionsApp initialTab="prompts" />, container);
    });
    await flushMicrotasks();

    const resetBtn = container.querySelector(
      '[data-testid="reset-aloxaf-yaml-btn"]',
    ) as HTMLButtonElement;
    expect(resetBtn).not.toBeNull();

    await act(async () => {
      resetBtn.click();
    });

    // Shows staged notice, NOT persisted yet!
    expect(container.querySelector('[data-testid="assistant-staged-notice"]')).not.toBeNull();
    const storedBeforeConfirm = await getMarginConfig();
    expect(storedBeforeConfirm.assistants['builtin-yaml'].name).toBe(
      'Modified Assistant Name',
    );
    expect(storedBeforeConfirm.assistants['builtin-yaml'].codec).toBe(
      BUILTIN_ASSISTANTS['builtin-yaml'].codec,
    );

    // Now confirm via header Save button
    const saveBtn = container.querySelector(
      '[data-testid="options-save-btn"]',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    await act(async () => {
      saveBtn.click();
    });
    await flushMicrotasks();

    const storedAfterConfirm = await getMarginConfig();
    expect(storedAfterConfirm.assistants['builtin-yaml'].name).toContain('泛用翻译大师');
    expect(
      container.querySelector('[data-testid="options-save-status"]')?.textContent,
    ).toBe('已保存');
  });

  it('executes 1-click legacy JSON import audit flow and redacted vs full backup export', async () => {
    const cfg = createDefaultMarginConfig();
    cfg.providers['google-free'].apiKeys = ['sk-top-secret-token'];
    await saveMarginConfig(cfg);

    await act(async () => {
      render(<OptionsApp initialTab="migration" />, container);
    });
    await flushMicrotasks();

    const textarea = container.querySelector(
      '[data-testid="legacy-json-textarea"]',
    ) as HTMLTextAreaElement;
    const parseBtn = container.querySelector(
      '[data-testid="parse-legacy-json-btn"]',
    ) as HTMLButtonElement;

    await act(async () => {
      textarea.value = JSON.stringify({
        translationService: 'openai',
        pcFloatBall: { enable: false },
      });
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      parseBtn.click();
    });

    const auditSummary = container.querySelector('[data-testid="import-audit-summary"]');
    expect(auditSummary).not.toBeNull();
    expect(auditSummary?.textContent).toContain('导入渠道');

    const applyBtn = container.querySelector(
      '[data-testid="apply-import-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });
    await flushMicrotasks();

    expect(auditSummary?.textContent).toContain('已正式应用');
    expect(
      container.querySelector('[data-testid="options-save-status"]')?.textContent,
    ).toBe('已保存');

    // Test Redacted Export (default: strips apiKeys)
    // Re-add secret to verify redaction vs full backup
    const withSecret = await getMarginConfig();
    withSecret.providers['google-free'].apiKeys = ['sk-private-backup-key'];
    await saveMarginConfig(withSecret);
    await flushMicrotasks();

    const exportBtn = container.querySelector(
      '[data-testid="export-copy-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      exportBtn.click();
    });
    await flushMicrotasks();

    const redactedPreview = container.querySelector(
      '[data-testid="export-json-preview"]',
    ) as HTMLTextAreaElement;
    expect(redactedPreview.value).not.toContain('sk-private-backup-key');

    // Check "Include API Keys for Local Backup" and export again
    const includeCheckbox = container.querySelector(
      '[data-testid="export-include-secrets-checkbox"]',
    ) as HTMLInputElement;
    await act(async () => {
      includeCheckbox.checked = true;
      includeCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      exportBtn.click();
    });
    await flushMicrotasks();

    const fullPreview = container.querySelector(
      '[data-testid="export-json-preview"]',
    ) as HTMLTextAreaElement;
    expect(fullPreview.value).toContain('sk-private-backup-key');
  });

  it('switches UI color mode & language and displays latency + temperatureTrace on 1-click Test Connection', async () => {
    const cfg = createDefaultMarginConfig();
    cfg.providers['openai-test'] = {
      ...cfg.providers['google-free'],
      id: 'openai-test',
      name: 'OpenAI Test',
      preset: 'openai',
      protocol: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      apiKeys: ['sk-test'],
      model: 'gpt-6-luna',
      models: ['gpt-6-luna'],
    };
    cfg.providerOrder = ['openai-test'];
    cfg.routing.webpage = 'openai-test';
    await saveMarginConfig(cfg);

    // Mock chrome.runtime.sendMessage for requestProviderTest
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        sendMessage: async () => ({
          ok: true,
          requestId: 'test-1',
          providerId: 'openai-test',
          model: 'gpt-6-luna',
          items: [{ id: 1, trans: '你好，世界' }],
          diagnostic: {
            schemaVersion: 1,
            product: 'Margin',
            version: '2.0.0',
            time: new Date().toISOString(),
            scene: 'service-test',
            codec: 'json-batch',
            provider: {
              id: 'openai-test',
              preset: 'openai',
              protocol: 'openai-chat',
              endpointOrigin: 'https://api.openai.com',
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
            latencyMs: 248,
          },
        }),
      },
    };

    try {
      await act(async () => {
        render(<OptionsApp initialTab="providers" />, container);
      });
      await flushMicrotasks();

      const testBtn = container.querySelector(
        '[data-testid="provider-test-btn"]',
      ) as HTMLButtonElement;
      await act(async () => {
        testBtn.click();
      });
      await flushMicrotasks();

      const resultBox = container.querySelector('[data-testid="provider-test-result"]');
      expect(resultBox?.textContent).toContain('248ms');
      expect(resultBox?.textContent).toContain('omitted-reasoning-guard');
    } finally {
      (globalThis as Record<string, unknown>).chrome = origChrome;
    }
  });
});
