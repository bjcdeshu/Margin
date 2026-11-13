import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('Quiet Paper 6-Tab Settings Studio (OptionsApp)', () => {
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

  it('renders all 6 editorial tabs, live inherit routing badges, and never shows Saved on initial load', async () => {
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

    // All 6 editorial tabs present in navigation rail
    const navLabels = Array.from(container.querySelectorAll('.mp-nav-item')).map(
      (el) => el.textContent ?? '',
    );
    expect(navLabels).toHaveLength(6);
    expect(navLabels.some((t) => t.includes('常规与阅读'))).toBe(true);
    expect(navLabels.some((t) => t.includes('AI 与翻译渠道'))).toBe(true);
    expect(navLabels.some((t) => t.includes('视频字幕与交互'))).toBe(true);
    expect(navLabels.some((t) => t.includes('提示词与术语库'))).toBe(true);
    expect(navLabels.some((t) => t.includes('站点规则'))).toBe(true);
    expect(navLabels.some((t) => t.includes('配置迁移与诊断'))).toBe(true);

    // Live resolved badge for `input: "inherit"` -> `→ OpenAI (gpt-6-luna)`
    const inputBadge = container.querySelector('[data-testid="scene-resolved-input"]');
    expect(inputBadge?.textContent).toBe('→ OpenAI (gpt-6-luna)');
  });

  it('syncs webpage.autoTranslateMode and autoTranslateMatches across GeneralTab and SiteRulesTab', async () => {
    await saveMarginConfig(createDefaultMarginConfig());

    await act(async () => {
      render(<OptionsApp initialTab="general" />, container);
    });
    await flushMicrotasks();

    // Default mode is `foreign` with <html lang> + visible prose character analysis explanation
    const foreignBtn = container.querySelector(
      '[data-testid="general-auto-mode-foreign"]',
    ) as HTMLButtonElement;
    expect(foreignBtn.getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('非目标语言自动翻译（推荐）');
    expect(container.textContent).toContain('<html lang>');
    expect(container.textContent).toContain('https://linux.do/*');

    // Switch to `whitelist` in GeneralTab
    const whitelistBtn = container.querySelector(
      '[data-testid="general-auto-mode-whitelist"]',
    ) as HTMLButtonElement;
    await act(async () => {
      whitelistBtn.click();
    });

    // Navigate to SiteRulesTab and verify `whitelist` is active in top strategy card
    const navButtons = () =>
      Array.from(container.querySelectorAll('.mp-nav-item')) as HTMLButtonElement[];
    await act(async () => {
      navButtons().find((b) => b.textContent?.includes('站点规则'))!.click();
    });

    const rulesWhitelistBtn = container.querySelector(
      '[data-testid="rules-auto-mode-whitelist"]',
    ) as HTMLButtonElement;
    const rulesOffBtn = container.querySelector(
      '[data-testid="rules-auto-mode-off"]',
    ) as HTMLButtonElement;
    expect(rulesWhitelistBtn.getAttribute('aria-checked')).toBe('true');

    // Switch to `off` in SiteRulesTab -> keeps `autoTranslateMatches = false` in sync
    await act(async () => {
      rulesOffBtn.click();
    });

    const saveBtn = container.querySelector(
      '[data-testid="options-save-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    await flushMicrotasks();

    const persisted = await getMarginConfig();
    expect(persisted.webpage.autoTranslateMode).toBe('off');
    expect(persisted.webpage.autoTranslateMatches).toBe(false);
  });

  it('defaults assistantId to builtin-yaml (Margin 信达雅精译) when adding new AI channels in ProvidersTab', async () => {
    await saveMarginConfig(createDefaultMarginConfig());

    await act(async () => {
      render(<OptionsApp initialTab="providers" />, container);
    });
    await flushMicrotasks();

    const presetSelect = container.querySelector(
      'select[aria-label="新增渠道预设"]',
    ) as HTMLSelectElement;
    const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('添加渠道'),
    ) as HTMLButtonElement;

    // 1. Add OpenAI channel -> automatically binds `builtin-yaml`
    await act(async () => {
      presetSelect.value = 'openai';
      presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      addBtn.click();
    });

    const boundSelect = container.querySelector(
      '[data-testid="provider-assistant-select"]',
    ) as HTMLSelectElement;
    expect(boundSelect).not.toBeNull();
    expect(boundSelect.value).toBe('builtin-yaml');

    // 2. Add Anthropic channel -> also automatically binds `builtin-yaml`
    await act(async () => {
      presetSelect.value = 'anthropic';
      presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      addBtn.click();
    });
    expect(
      (container.querySelector('[data-testid="provider-assistant-select"]') as HTMLSelectElement)
        .value,
    ).toBe('builtin-yaml');

    // Save and verify persisted config
    const saveBtn = container.querySelector(
      '[data-testid="options-save-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    await flushMicrotasks();

    const persisted = await getMarginConfig();
    const aiProviders = Object.values(persisted.providers).filter(
      (p) => p.protocol === 'openai-chat' || p.protocol === 'anthropic-messages',
    );
    expect(aiProviders).toHaveLength(2);
    for (const p of aiProviders) {
      expect(p.assistantId).toBe('builtin-yaml');
    }
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
      assistantId: 'builtin-yaml', // 0.3
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

    // 1. On `gpt-6-luna`, assistant 0.3 is auto-omitted by Reasoning Guard
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

  it('stages built-in assistant preset reset without auto-saving until confirmed via Save Changes', async () => {
    const cfg = createDefaultMarginConfig();
    cfg.assistants['builtin-yaml'].name = 'Modified Assistant Name';
    await saveMarginConfig(cfg);

    await act(async () => {
      render(<OptionsApp initialTab="prompts" />, container);
    });
    await flushMicrotasks();

    // All 3 built-in assistants visible in roster
    expect(
      container.querySelector('[data-testid="assistant-tab-builtin-yaml"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="assistant-tab-builtin-yaml-thinking"]')?.textContent,
    ).toContain('泛用翻译大师 · 思考精修');
    expect(
      container.querySelector('[data-testid="assistant-tab-builtin-delimiter"]')?.textContent,
    ).toContain('极速流式直译');

    // Multi-line YAML macro `imt_yaml_item` renders inside a <textarea> preserving newlines
    const envTextareas = Array.from(container.querySelectorAll('textarea'));
    expect(envTextareas.some((ta) => ta.value.includes('- id: {{id}}\n  src: |-'))).toBe(
      true,
    );

    const resetBtn = container.querySelector(
      '[data-testid="reset-builtin-assistant-btn"]',
    ) as HTMLButtonElement;
    expect(resetBtn).not.toBeNull();
    expect(resetBtn.textContent).toContain('重置为内置预设');

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
    expect(storedAfterConfirm.assistants['builtin-yaml'].name).toContain(
      'Margin 信达雅精译',
    );
    expect(
      container.querySelector('[data-testid="options-save-status"]')?.textContent,
    ).toBe('已保存');
  });

  it('powers PromptsGlossaryTab scene slots, live prompt preview + sample tester, 4 glossary packs, bulk import/export, and persistent translation DB card', async () => {
    const cfg = createDefaultMarginConfig();
    cfg.providers['openai-studio'] = {
      ...cfg.providers['google-free'],
      id: 'openai-studio',
      name: 'OpenAI Studio',
      preset: 'openai',
      protocol: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      apiKeys: ['sk-studio'],
      model: 'gpt-5.4-mini',
      models: ['gpt-5.4-mini'],
      assistantId: 'builtin-yaml',
    };
    cfg.providerOrder = ['openai-studio', 'google-free'];
    cfg.routing.webpage = 'openai-studio';
    await saveMarginConfig(cfg);

    let mockMemCount = 14;
    let mockPersistentCount = 128;
    const sendMessageSpy = vi.fn(async (req: { type: string }) => {
      if (req.type === 'margin:get-translation-cache-stats') {
        return {
          ok: true,
          memoryEntries: mockMemCount,
          persistentEntries: mockPersistentCount,
          dbAvailable: true,
        };
      }
      if (req.type === 'margin:clear-translation-cache') {
        mockMemCount = 0;
        mockPersistentCount = 0;
        return { ok: true };
      }
      if (req.type === 'margin:translate-batch') {
        mockMemCount += 1;
        mockPersistentCount += 1;
        return {
          ok: true,
          requestId: 'studio-trial-1',
          providerId: 'openai-studio',
          model: 'gpt-5.4-mini',
          items: [
            {
              id: 1,
              trans:
                '当使用 200K 上下文窗口扩展 LLM Agent 时，KV Cache 复用能保持低延迟——就像在《影之刃零》中打出完美帧弹反一样。',
            },
          ],
          diagnostic: {
            schemaVersion: 1,
            product: 'Margin',
            version: '2.2.0',
            time: new Date().toISOString(),
            scene: 'webpage',
            codec: 'yaml',
            provider: {
              id: 'openai-studio',
              preset: 'openai',
              protocol: 'openai-chat',
              endpointOrigin: 'https://api.openai.com',
              endpointPath: '/v1/chat/completions',
              model: 'gpt-5.4-mini',
            },
            parameters: {
              temperatureTrace: 'sent-assistant-custom',
              temperatureSent: 0.3,
              thinkingMode: 'provider-default',
              stream: false,
            },
            httpStatus: 200,
            kind: 'ok',
            retryable: false,
            attempts: 1,
            latencyMs: 312,
          },
        };
      }
      return { ok: true };
    });

    const origChrome = (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        sendMessage: sendMessageSpy,
      },
    };

    try {
      await act(async () => {
        render(<OptionsApp initialTab="prompts" />, container);
      });
      await flushMicrotasks();

      // 1. Scene prompt slots: switch to `inputPrompt` and `selectionPrompt`
      const inputSlotBtn = container.querySelector(
        '[data-testid="prompt-slot-inputPrompt"]',
      ) as HTMLButtonElement;
      const selectionSlotBtn = container.querySelector(
        '[data-testid="prompt-slot-selectionPrompt"]',
      ) as HTMLButtonElement;
      const promptTa = container.querySelector(
        '[data-testid="assistant-prompt-textarea"]',
      ) as HTMLTextAreaElement;

      await act(async () => {
        inputSlotBtn.click();
      });
      expect(promptTa.value).toContain('Rewrite and translate the user draft');

      await act(async () => {
        selectionSlotBtn.click();
      });
      expect(promptTa.value).toContain('Translate the selected text');

      // 2. Live Prompt Preview injects Keep-Original terms, Mapped terms, and Domain Style Guide
      const expandedUser = container.querySelector(
        '[data-testid="preview-expanded-user"]',
      );
      expect(expandedUser?.textContent).toContain('Keep-Original Terms');
      expect(expandedUser?.textContent).toContain('LLM');
      expect(expandedUser?.textContent).toContain('Context Window => 上下文窗口');
      expect(expandedUser?.textContent).toContain('Phantom Blade Zero => 影之刃零');
      expect(expandedUser?.textContent).toContain('Style Guide: Social post / thread register');

      // Switch preview scene to `input` -> uses `inputPrompt`
      const previewInputBtn = container.querySelector(
        '[data-testid="preview-scene-input"]',
      ) as HTMLButtonElement;
      await act(async () => {
        previewInputBtn.click();
      });
      expect(expandedUser?.textContent).toContain('Rewrite and translate the user draft');

      // Run Live Sample Translation (`在线试译`) -> shows translated text + latency ms
      const runTrialBtn = container.querySelector(
        '[data-testid="preview-run-translate-btn"]',
      ) as HTMLButtonElement;
      await act(async () => {
        runTrialBtn.click();
      });
      await flushMicrotasks();

      const trialBox = container.querySelector('[data-testid="preview-translate-result"]');
      expect(trialBox?.textContent).toContain('312ms');
      expect(trialBox?.textContent).toContain('影之刃零');

      // 3. Built-in 4 Glossary Packs rendered + instant toggle updates enabledGlossaryPacks & live preview
      for (const packId of [
        'ai-agent-infra',
        'dev-cloud-web',
        'screenwriting-narrative',
        'gaming-tech-culture',
      ]) {
        expect(
          container.querySelector(`[data-testid="glossary-pack-${packId}"]`),
        ).not.toBeNull();
      }

      // Expand full terms in `gaming-tech-culture` pack
      const expandGamingBtn = container.querySelector(
        '[data-testid="glossary-pack-expand-gaming-tech-culture"]',
      ) as HTMLButtonElement;
      await act(async () => {
        expandGamingBtn.click();
      });
      expect(
        container.querySelector('[data-testid="glossary-pack-gaming-tech-culture"]')
          ?.textContent,
      ).toContain('=> 影之刃零');

      // Toggle OFF `gaming-tech-culture` -> `Phantom Blade Zero => 影之刃零` disappears from live preview!
      const gamingToggle = container.querySelector(
        '[data-testid="glossary-pack-toggle-gaming-tech-culture"]',
      ) as HTMLButtonElement;
      await act(async () => {
        gamingToggle.click();
      });
      expect(expandedUser?.textContent).not.toContain('Phantom Blade Zero => 影之刃零');

      // 4. Bulk Glossary Import / Export + Custom Search & Per-Entry Toggle
      const bulkTa = container.querySelector(
        '[data-testid="glossary-bulk-textarea"]',
      ) as HTMLTextAreaElement;
      const bulkReplaceBtn = container.querySelector(
        '[data-testid="glossary-bulk-replace-btn"]',
      ) as HTMLButtonElement;
      const bulkExportBtn = container.querySelector(
        '[data-testid="glossary-bulk-export-btn"]',
      ) as HTMLButtonElement;

      await act(async () => {
        bulkTa.value = 'CUDA\nSubagent => 子代理 @github.com';
        bulkTa.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        bulkReplaceBtn.click();
      });

      // Verify custom list shows Keep Original (`保留原文`) and Mapped (`指定译法`)
      const customList = container.querySelector('[data-testid="custom-glossary-list"]');
      expect(customList?.textContent).toContain('保留原文');
      expect(customList?.textContent).toContain('指定译法');

      // Export back to text
      await act(async () => {
        bulkExportBtn.click();
      });
      expect(bulkTa.value).toBe('CUDA\nSubagent = 子代理 @github.com');

      // Save changes and confirm enabledGlossaryPacks + bulk glossary persisted
      const saveBtn = container.querySelector(
        '[data-testid="options-save-btn"]',
      ) as HTMLButtonElement;
      await act(async () => {
        saveBtn.click();
      });
      await flushMicrotasks();

      const persisted = await getMarginConfig();
      expect(persisted.enabledGlossaryPacks).toEqual([
        'ai-agent-infra',
        'dev-cloud-web',
        'screenwriting-narrative',
      ]);
      expect(persisted.glossary).toEqual([
        { k: 'CUDA', v: '' },
        { k: 'Subagent', v: '子代理', domain: 'github.com' },
      ]);

      // 5. Persistent Local Translation Database Status Card (Stats + Refresh + Clear)
      const dbStats = container.querySelector('[data-testid="translation-db-stats"]');
      expect(dbStats?.textContent).toContain('内存热缓存 15 条');
      expect(dbStats?.textContent).toContain('本地持久化库 129 条 (IndexedDB)');

      const clearDbBtn = container.querySelector(
        '[data-testid="translation-db-clear-btn"]',
      ) as HTMLButtonElement;
      await act(async () => {
        clearDbBtn.click();
      });
      await flushMicrotasks();

      expect(dbStats?.textContent).toContain('内存热缓存 0 条 · 本地持久化库 0 条 (IndexedDB)');
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: 'margin:clear-translation-cache',
      });
    } finally {
      (globalThis as Record<string, unknown>).chrome = origChrome;
    }
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
            version: '2.2.0',
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

  it('renders 16:9 live subtitle preview stage, preserves multi-key raw input, clears stale multiplePrompt on reset, and retains staged migration across tabs', async () => {
    const cfg = createDefaultMarginConfig();
    cfg.providers['openai-pool'] = {
      ...cfg.providers['google-free'],
      id: 'openai-pool',
      name: 'OpenAI Pool',
      preset: 'openai',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com',
      apiKeys: ['sk-alpha'],
      model: 'gpt-6-luna',
      models: ['gpt-6-luna'],
    };
    cfg.providerOrder = ['openai-pool', 'google-free'];
    cfg.routing.webpage = 'openai-pool';
    cfg.assistants['custom'] = {
      ...structuredClone(BUILTIN_ASSISTANTS['builtin-yaml']),
      id: 'custom',
      name: 'Imported Custom Assistant',
      multiplePrompt: '<yaml>{{yaml}}</yaml>',
    };
    await saveMarginConfig(cfg);

    await act(async () => {
      render(<OptionsApp initialTab="subtitles" />, container);
    });
    await flushMicrotasks();

    // 1. Live 16:9 subtitle preview renders 100% / 70% and youtube-native preset
    const previewStage = container.querySelector('[data-testid="subtitle-live-preview"]');
    const previewStack = container.querySelector('[data-testid="subtitle-preview-stack"]');
    expect(previewStage?.textContent).toContain('100%');
    expect(previewStage?.textContent).toContain('70%');
    expect(previewStack?.getAttribute('data-preset')).toBe('youtube-native');

    const transSlider = container.querySelector(
      '[data-testid="subtitle-trans-scale-slider"]',
    ) as HTMLInputElement;
    await act(async () => {
      transSlider.value = '85';
      transSlider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(previewStage?.textContent).toContain('85%');

    // 2. Switch to Providers tab & verify raw multi-key textarea preserves trailing comma/newline
    const navButtons = () =>
      Array.from(container.querySelectorAll('.mp-nav-item')) as HTMLButtonElement[];
    await act(async () => {
      navButtons().find((b) => b.textContent?.includes('AI 与翻译渠道'))!.click();
    });

    const revealBtn = container.querySelector(
      '[data-testid="toggle-reveal-keys-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      revealBtn.click();
    });

    const keysTa = container.querySelector(
      '[data-testid="api-keys-textarea"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      keysTa.value = 'sk-alpha,\nsk-beta, ';
      keysTa.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(keysTa.value).toBe('sk-alpha,\nsk-beta, ');

    // 3. Switch to Prompts tab, select `custom` assistant with stale multiplePrompt, and load delimiter template -> clears multiplePrompt
    await act(async () => {
      navButtons().find((b) => b.textContent?.includes('提示词与术语库'))!.click();
    });
    const customAstTab = container.querySelector(
      '[data-testid="assistant-tab-custom"]',
    ) as HTMLButtonElement;
    await act(async () => {
      customAstTab.click();
    });
    const loadDelimBtn = container.querySelector(
      '[data-testid="load-delimiter-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      loadDelimBtn.click();
    });

    // Save changes and confirm persisted state
    const saveBtn = container.querySelector(
      '[data-testid="options-save-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    await flushMicrotasks();

    const saved = await getMarginConfig();
    expect(saved.subtitles.translationScalePercent).toBe(85);
    expect(saved.subtitles.fontSizePercent).toBe(85);
    expect(saved.providers['openai-pool'].apiKeys).toEqual(['sk-alpha', 'sk-beta']);
    expect(saved.assistants['custom'].codec).toBe('delimiter');
    expect(saved.assistants['custom'].multiplePrompt).toBeUndefined();

    // 4. Switch to Migration tab, parse JSON without applying, switch tabs away and back -> preview persists!
    await act(async () => {
      navButtons().find((b) => b.textContent?.includes('配置迁移与诊断'))!.click();
    });
    const jsonTa = container.querySelector(
      '[data-testid="legacy-json-textarea"]',
    ) as HTMLTextAreaElement;
    const parseBtn = container.querySelector(
      '[data-testid="parse-legacy-json-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      jsonTa.value = JSON.stringify({ translationService: 'deeplx' });
      jsonTa.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      parseBtn.click();
    });
    expect(container.querySelector('[data-testid="import-audit-summary"]')).not.toBeNull();

    // Switch to Site Rules tab and back to Migration tab
    await act(async () => {
      navButtons().find((b) => b.textContent?.includes('站点规则'))!.click();
    });
    await act(async () => {
      navButtons().find((b) => b.textContent?.includes('配置迁移与诊断'))!.click();
    });
    expect(container.querySelector('[data-testid="import-audit-summary"]')).not.toBeNull();
  });

  it('renders v2.3.0 studio badge, triggers save on Ctrl+S, and keeps env macro disclosure collapsed by default in PromptsGlossaryTab', async () => {
    await saveMarginConfig(createDefaultMarginConfig());

    await act(async () => {
      render(<OptionsApp initialTab="prompts" />, container);
    });
    await flushMicrotasks();

    // 1. Studio footer displays v2.3.0 badge & keyboard shortcut hint
    const footerVersion = container.querySelector('.mp-nav-footer .mp-pill--mono');
    expect(footerVersion?.textContent).toBe('v2.3.0');
    const saveBtn = container.querySelector(
      '[data-testid="options-save-btn"]',
    ) as HTMLButtonElement;
    expect(saveBtn.textContent).toMatch(/Ctrl\+S|⌘S/);

    // 2. Advanced Macro Snippets (env) <details> disclosure is collapsed by default
    const detailsEls = Array.from(container.querySelectorAll('details'));
    const envDetails = detailsEls.find((d) =>
      d.querySelector('summary')?.textContent?.includes('高级宏变量片段 (env)'),
    ) as HTMLDetailsElement | undefined;
    expect(envDetails).toBeDefined();
    expect(envDetails!.open).toBe(false);
    expect(envDetails!.hasAttribute('open')).toBe(false);
    expect(envDetails!.textContent).toContain('thread_prompt');
    expect(envDetails!.textContent).toContain('context_window_prompt');

    // 3. Make a draft edit and trigger save via Ctrl+S keyboard shortcut
    const promptTa = container.querySelector(
      '[data-testid="assistant-prompt-textarea"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      promptTa.value = `${promptTa.value}\n# v2.3.0 shortcut edit`;
      promptTa.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(
      container.querySelector('[data-testid="options-unsaved-pill"]')?.textContent,
    ).toBe('有未保存更改');

    await act(async () => {
      const evt = new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(evt);
    });
    await flushMicrotasks();

    expect(
      container.querySelector('[data-testid="options-save-status"]')?.textContent,
    ).toBe('已保存');
    const persisted = await getMarginConfig();
    expect(persisted.assistants['builtin-yaml'].prompt).toContain(
      '# v2.3.0 shortcut edit',
    );
  });
});
