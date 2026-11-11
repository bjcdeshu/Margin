import { useMemo, useState } from 'preact/hooks';
import { PROVIDER_PRESETS } from '@shared/constants';
import { requestProviderTest } from '@shared/messaging';
import { getCapabilityCache } from '@shared/storage';
import {
  isStrictTemperatureModel,
  makeCapabilityKey,
  resolveEffectiveTemperature,
} from '@shared/temperature';
import type {
  MarginConfig,
  ModelCapabilityMap,
  ProviderConfig,
  ProviderPreset,
  ThinkingPolicy,
  TranslateBatchResponse,
  WireProtocol,
} from '@shared/types';
import {
  FieldRow,
  SegmentedControl,
  StatusPill,
  ToggleSwitch,
  describeTemperatureResolution,
  labelForPreset,
  resolveEndpointPreview,
} from '../../components';

export interface ProvidersTabProps {
  draft: MarginConfig;
  capabilityCache: ModelCapabilityMap;
  onRefreshCapabilityCache?: (next: ModelCapabilityMap) => void;
  onMutate: (mutator: (next: MarginConfig) => void) => void;
  /** Ensures unsaved provider edits are persisted before background test runs. */
  onEnsureSavedBeforeTest: () => Promise<void>;
}

const PRESET_LIST: readonly ProviderPreset[] = [
  'openai',
  'deepseek',
  'zhipu',
  'anthropic',
  'deeplx',
  'google-free',
  'custom',
];

function createProviderFromPreset(preset: ProviderPreset): ProviderConfig {
  const meta = PROVIDER_PRESETS[preset];
  const suffix = Math.random().toString(36).slice(2, 7);
  const id = `${preset}-${suffix}`;
  return {
    id,
    name: meta.label,
    preset,
    protocol: meta.protocol,
    enabled: true,
    baseUrl: meta.defaultEndpoint,
    ...(preset === 'deeplx' ? { endpoints: [meta.defaultEndpoint] } : {}),
    apiKeys: [],
    model: meta.defaultModel,
    models: [...meta.suggestedModels],
    enableContext: preset !== 'deeplx' && preset !== 'google-free',
    enableRichHtml: true,
    stream: preset === 'deeplx' || preset === 'google-free' ? 'off' : 'auto',
    rateLimitRps: 20,
    maxConcurrency: 4,
    temperaturePolicy: { mode: 'omit' },
    thinkingPolicy: { mode: 'provider-default' },
  };
}

export function ProvidersTab({
  draft,
  capabilityCache,
  onRefreshCapabilityCache,
  onMutate,
  onEnsureSavedBeforeTest,
}: ProvidersTabProps) {
  const lang = draft.interfaceLang;

  const orderedIds = useMemo(() => {
    const known = draft.providerOrder.filter((id) => Boolean(draft.providers[id]));
    for (const id of Object.keys(draft.providers)) {
      if (!known.includes(id)) known.push(id);
    }
    return known;
  }, [draft.providerOrder, draft.providers]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newPreset, setNewPreset] = useState<ProviderPreset>('openai');
  const [revealKeys, setRevealKeys] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; response?: TranslateBatchResponse; error?: string }>
  >({});

  const defaultProviderId = draft.providers[draft.routing.webpage]
    ? draft.routing.webpage
    : (orderedIds[0] ?? '');
  const activeId =
    selectedId && draft.providers[selectedId] ? selectedId : defaultProviderId;
  const provider = activeId ? draft.providers[activeId] : undefined;

  const endpointPreview = useMemo(() => {
    if (!provider) return null;
    return resolveEndpointPreview(provider.baseUrl, provider.preset, provider.protocol);
  }, [provider?.baseUrl, provider?.preset, provider?.protocol]);

  const boundAssistant = provider?.assistantId
    ? draft.assistants[provider.assistantId]
    : undefined;

  const effectiveTemp = useMemo(() => {
    if (!provider) return null;
    const originKey = makeCapabilityKey(
      endpointPreview?.fullUrl || provider.baseUrl,
      provider.model,
    );
    return resolveEffectiveTemperature({
      model: provider.model,
      providerPolicy: provider.temperaturePolicy,
      assistantPolicy: boundAssistant?.temperaturePolicy,
      cachedCapability: capabilityCache[originKey],
    });
  }, [
    provider?.model,
    provider?.temperaturePolicy,
    provider?.baseUrl,
    endpointPreview?.fullUrl,
    boundAssistant?.temperaturePolicy,
    capabilityCache,
  ]);

  const updateProvider = (mutator: (p: ProviderConfig) => void) => {
    if (!activeId) return;
    onMutate((d) => {
      const target = d.providers[activeId];
      if (target) mutator(target);
    });
  };

  const handleAddProvider = () => {
    const created = createProviderFromPreset(newPreset);
    onMutate((d) => {
      d.providers[created.id] = created;
      d.providerOrder = [...orderedIds, created.id];
    });
    setSelectedId(created.id);
    setRevealKeys(false);
  };

  const handleMoveProvider = (id: string, delta: -1 | 1) => {
    const idx = orderedIds.indexOf(id);
    const nextIdx = idx + delta;
    if (idx < 0 || nextIdx < 0 || nextIdx >= orderedIds.length) return;
    onMutate((d) => {
      const nextOrder = [...orderedIds];
      const [moved] = nextOrder.splice(idx, 1);
      nextOrder.splice(nextIdx, 0, moved);
      d.providerOrder = nextOrder;
    });
  };

  const handleDeleteProvider = (id: string) => {
    if (orderedIds.length <= 1) return;
    const remaining = orderedIds.filter((item) => item !== id);
    const fallbackId = remaining[0];
    onMutate((d) => {
      delete d.providers[id];
      d.providerOrder = remaining;
      if (d.routing.webpage === id) {
        d.routing.webpage = fallbackId;
      }
      for (const scene of ['input', 'subtitle', 'hover', 'selection', 'pdf', 'image'] as const) {
        if (d.routing[scene] === id) {
          d.routing[scene] = 'inherit';
        }
      }
    });
    setSelectedId(fallbackId);
  };

  const handleAddCustomModel = () => {
    const trimmed = customModelInput.trim();
    if (!trimmed || !provider) return;
    updateProvider((p) => {
      if (!p.models.includes(trimmed)) {
        p.models = [...p.models, trimmed];
      }
      p.model = trimmed;
    });
    setCustomModelInput('');
  };

  const handleTestConnection = async () => {
    if (!provider) return;
    const targetId = provider.id;
    setTestingId(targetId);
    try {
      await onEnsureSavedBeforeTest();
      const res = await requestProviderTest(targetId);
      if (onRefreshCapabilityCache) {
        const latestCaps = await getCapabilityCache();
        onRefreshCapabilityCache(latestCaps);
      }
      setTestResults((prev) => ({
        ...prev,
        [targetId]: {
          ok: res.ok,
          response: res,
          error: res.ok ? undefined : res.error?.message || res.diagnostic?.sanitizedError,
        },
      }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [targetId]: {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const candidateModels = useMemo(() => {
    if (!provider) return [];
    const presetModels = PROVIDER_PRESETS[provider.preset]?.suggestedModels ?? [];
    const all = new Set<string>([...presetModels, ...provider.models]);
    if (provider.model) all.add(provider.model);
    return Array.from(all);
  }, [provider]);

  const activeTest = provider ? testResults[provider.id] : undefined;
  const isAiProtocol =
    provider?.protocol === 'openai-chat' || provider?.protocol === 'anthropic-messages';

  return (
    <div>
      {/* Provider Roster Bar + Add Preset */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'AI & Translation Channels' : 'AI 与翻译服务渠道'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Protocol-first channel configuration with automatic endpoint completion, multi-key rotation, and 4-defense temperature protection.'
                : '协议解耦渠道管理，内置端点路径智能补全、多密钥自动轮询与四重温度参数防呆保护。'}
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <select
              class="mp-select"
              aria-label={lang === 'en' ? 'New Provider Preset' : '新增渠道预设'}
              value={newPreset}
              onChange={(e) => setNewPreset((e.currentTarget as HTMLSelectElement).value as ProviderPreset)}
            >
              {PRESET_LIST.map((preset) => (
                <option key={preset} value={preset}>
                  {labelForPreset(preset, lang)}
                </option>
              ))}
            </select>
            <button type="button" class="mp-btn mp-btn--solid" onClick={handleAddProvider}>
              + {lang === 'en' ? 'Add Channel' : '添加渠道'}
            </button>
          </div>
        </div>

        <div class="mp-roster-bar" role="tablist" aria-label={lang === 'en' ? 'Provider List' : '渠道列表'}>
          {orderedIds.map((id) => {
            const p = draft.providers[id];
            if (!p) return null;
            const selected = id === activeId;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                class="mp-roster-tab"
                aria-selected={selected ? 'true' : 'false'}
                onClick={() => {
                  setSelectedId(id);
                  setRevealKeys(false);
                }}
              >
                <span>{p.name}</span>
                <span class="mp-mono mp-muted">{p.model}</span>
                {draft.routing.webpage === id ? (
                  <StatusPill tone="accent">{lang === 'en' ? 'Primary' : '主服务'}</StatusPill>
                ) : null}
              </button>
            );
          })}
        </div>

        {provider ? (
          <div>
            {/* Toolbar for active provider: reorder, test connection, delete */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                paddingBottom: '12px',
                borderBottom: '1px solid var(--rule-soft)',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <StatusPill tone="mono">{provider.id}</StatusPill>
                <StatusPill tone="neutral">{labelForPreset(provider.preset, lang)}</StatusPill>
                <button
                  type="button"
                  class="mp-btn mp-btn--sm"
                  disabled={orderedIds.indexOf(provider.id) <= 0}
                  onClick={() => handleMoveProvider(provider.id, -1)}
                >
                  ↑ {lang === 'en' ? 'Move Up' : '上移'}
                </button>
                <button
                  type="button"
                  class="mp-btn mp-btn--sm"
                  disabled={orderedIds.indexOf(provider.id) >= orderedIds.length - 1}
                  onClick={() => handleMoveProvider(provider.id, 1)}
                >
                  ↓ {lang === 'en' ? 'Move Down' : '下移'}
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  class="mp-btn mp-btn--solid"
                  data-testid="provider-test-btn"
                  disabled={testingId === provider.id}
                  onClick={() => void handleTestConnection()}
                >
                  {testingId === provider.id
                    ? lang === 'en'
                      ? 'Testing…'
                      : '测试连接中…'
                    : lang === 'en'
                      ? 'Test Connection'
                      : '测试连接'}
                </button>

                {orderedIds.length > 1 ? (
                  <button
                    type="button"
                    class="mp-btn mp-btn--danger mp-btn--sm"
                    onClick={() => handleDeleteProvider(provider.id)}
                  >
                    {lang === 'en' ? 'Delete' : '删除渠道'}
                  </button>
                ) : null}
              </div>
            </div>

            {/* Live Connection Test Banner */}
            {activeTest ? (
              <div
                class="mp-editorial-note"
                data-testid="provider-test-result"
                style={{
                  borderLeftColor: activeTest.ok ? 'var(--ok-ink)' : 'var(--danger-ink)',
                }}
              >
                {activeTest.ok && activeTest.response ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
                    <StatusPill tone="ok">
                      {lang === 'en' ? 'Connected OK' : '连接成功'} · {activeTest.response.diagnostic.latencyMs}ms
                    </StatusPill>
                    <StatusPill tone="mono">
                      trace: {activeTest.response.diagnostic.parameters.temperatureTrace}
                      {activeTest.response.diagnostic.parameters.temperatureSent !== undefined
                        ? ` (${activeTest.response.diagnostic.parameters.temperatureSent})`
                        : ''}
                    </StatusPill>
                    <span class="mp-muted">
                      {activeTest.response.items[0]?.trans
                        ? `Sample: "${activeTest.response.items[0].trans}"`
                        : activeTest.response.model}
                    </span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
                    <StatusPill tone="danger">
                      {lang === 'en' ? 'Connection Failed' : '连接失败'}
                    </StatusPill>
                    <span>{activeTest.error || 'Unknown error'}</span>
                  </div>
                )}
              </div>
            ) : null}

            {/* Basic Channel Identity */}
            <FieldRow label={lang === 'en' ? 'Channel Name' : '渠道显示名称'}>
              <input
                type="text"
                class="mp-input"
                style={{ minWidth: '240px' }}
                value={provider.name}
                onInput={(e) => {
                  const val = (e.currentTarget as HTMLInputElement).value;
                  updateProvider((p) => {
                    p.name = val;
                  });
                }}
              />
            </FieldRow>

            <FieldRow label={lang === 'en' ? 'Enabled' : '启用此渠道'}>
              <ToggleSwitch
                ariaLabel={lang === 'en' ? 'Enable Provider' : '启用此渠道'}
                checked={provider.enabled}
                onChange={(next) =>
                  updateProvider((p) => {
                    p.enabled = next;
                  })
                }
              />
            </FieldRow>

            <FieldRow
              label={lang === 'en' ? 'Wire Protocol' : '通信协议 (Wire Protocol)'}
              hint={
                lang === 'en'
                  ? 'OpenAI-compatible gateways, Zhipu, and DeepSeek all speak openai-chat'
                  : 'OpenAI 兼容中转站、DeepSeek、智谱 GLM 均使用 openai-chat 协议'
              }
            >
              <select
                class="mp-select"
                value={provider.protocol}
                onChange={(e) => {
                  const nextProto = (e.currentTarget as HTMLSelectElement).value as WireProtocol;
                  updateProvider((p) => {
                    p.protocol = nextProto;
                  });
                }}
              >
                <option value="openai-chat">openai-chat (/v1/chat/completions)</option>
                <option value="anthropic-messages">anthropic-messages (/v1/messages)</option>
                <option value="deeplx">deeplx (/translate)</option>
                <option value="google-web">google-web (gtx)</option>
              </select>
            </FieldRow>

            {/* Base URL + Live Endpoint Path Preview */}
            <FieldRow
              stacked
              label={lang === 'en' ? 'Base URL / Endpoint' : '接口地址 (Base URL)'}
              badge={
                endpointPreview ? (
                  <StatusPill
                    tone={endpointPreview.valid ? 'mono' : 'danger'}
                    dataTestId="provider-endpoint-preview"
                  >
                    {endpointPreview.valid
                      ? `${lang === 'en' ? 'Resolved:' : '实际请求端点：'} ${endpointPreview.fullUrl}`
                      : lang === 'en'
                        ? 'Invalid URL'
                        : 'URL 格式无效'}
                  </StatusPill>
                ) : null
              }
              hint={
                lang === 'en'
                  ? 'Domain root or /v1 auto-completes path on request without mutating your saved Base URL'
                  : '填写域名根目录或 /v1 会自动补全请求路径，同时原样保留您填写的 Base URL'
              }
            >
              <input
                type="text"
                class="mp-input mp-input--mono"
                style={{ width: '100%' }}
                value={provider.baseUrl}
                placeholder={PROVIDER_PRESETS[provider.preset]?.defaultEndpoint}
                onInput={(e) => {
                  const val = (e.currentTarget as HTMLInputElement).value;
                  updateProvider((p) => {
                    p.baseUrl = val;
                  });
                }}
              />
            </FieldRow>

            {provider.protocol === 'deeplx' ? (
              <FieldRow
                stacked
                label={lang === 'en' ? 'DeepLX Rotation Endpoints' : 'DeepLX 多节点轮询地址 (每行或逗号分隔)'}
              >
                <textarea
                  class="mp-textarea mp-textarea--mono"
                  value={(provider.endpoints ?? [provider.baseUrl]).join('\n')}
                  onInput={(e) => {
                    const raw = (e.currentTarget as HTMLTextAreaElement).value;
                    const list = raw
                      .split(/[\n,]+/)
                      .map((s) => s.trim())
                      .filter(Boolean);
                    updateProvider((p) => {
                      p.endpoints = list;
                      if (list[0]) p.baseUrl = list[0];
                    });
                  }}
                />
              </FieldRow>
            ) : null}

            {/* Multi-Key API Key Pool (Masked by default) */}
            {PROVIDER_PRESETS[provider.preset]?.requiresApiKey || provider.apiKeys.length > 0 || provider.protocol !== 'google-web' ? (
              <FieldRow
                stacked
                label={lang === 'en' ? 'API Keys (Multi-Key Pool)' : 'API 密钥池 (支持多 Key 轮询)'}
                badge={
                  <StatusPill tone={provider.apiKeys.length > 0 ? 'ok' : 'neutral'}>
                    {lang === 'en'
                      ? `${provider.apiKeys.length} key(s)`
                      : `已配置 ${provider.apiKeys.length} 把密钥`}
                  </StatusPill>
                }
                hint={
                  lang === 'en'
                    ? 'One key per line or comma-separated. Keys are masked by default and rotated automatically on HTTP 429.'
                    : '支持换行或逗号分隔填写多把 Key，遇到 429 限流自动冷却切换；默认遮罩脱敏保护。'
                }
              >
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      class="mp-btn mp-btn--ghost mp-btn--sm"
                      onClick={() => setRevealKeys((v) => !v)}
                    >
                      {revealKeys
                        ? lang === 'en'
                          ? 'Hide Keys'
                          : '隐藏明文密钥'
                        : lang === 'en'
                          ? 'Reveal Keys to Edit'
                          : '显示/编辑密钥'}
                    </button>
                  </div>

                  {revealKeys ? (
                    <textarea
                      class="mp-textarea mp-textarea--mono"
                      placeholder="sk-..."
                      value={provider.apiKeys.join('\n')}
                      onInput={(e) => {
                        const raw = (e.currentTarget as HTMLTextAreaElement).value;
                        const keys = raw
                          .split(/[\n,]+/)
                          .map((s) => s.trim())
                          .filter(Boolean);
                        updateProvider((p) => {
                          p.apiKeys = keys;
                        });
                      }}
                    />
                  ) : (
                    <input
                      type="password"
                      class="mp-input mp-input--mono"
                      style={{ width: '100%' }}
                      aria-label={lang === 'en' ? 'Masked API Key Input' : 'API 密钥输入 (遮罩模式)'}
                      placeholder={
                        lang === 'en'
                          ? 'Paste API key(s) (comma-separated, masked)...'
                          : '粘贴 API Key（支持逗号分隔多把密钥，默认遮罩显示）...'
                      }
                      value={provider.apiKeys.join(',')}
                      onInput={(e) => {
                        const raw = (e.currentTarget as HTMLInputElement).value;
                        const keys = raw
                          .split(/[\n,]+/)
                          .map((s) => s.trim())
                          .filter(Boolean);
                        updateProvider((p) => {
                          p.apiKeys = keys;
                        });
                      }}
                    />
                  )}
                </div>
              </FieldRow>
            ) : null}

            {/* Model Selector + Custom Model Tags */}
            <FieldRow
              stacked
              label={lang === 'en' ? 'Active Model & Custom Model Tags' : '当前模型与自定义模型标签'}
              badge={
                isStrictTemperatureModel(provider.model) ? (
                  <StatusPill tone="accent">
                    {lang === 'en' ? 'Reasoning / Strict Model' : '推理/严格参数模型'}
                  </StatusPill>
                ) : null
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    class="mp-input mp-input--mono"
                    aria-label={lang === 'en' ? 'Active Model Name' : '当前模型名称'}
                    style={{ flex: '1 1 220px' }}
                    value={provider.model}
                    onInput={(e) => {
                      const val = (e.currentTarget as HTMLInputElement).value;
                      updateProvider((p) => {
                        p.model = val;
                      });
                    }}
                  />
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      type="text"
                      class="mp-input mp-input--mono"
                      style={{ minWidth: '240px' }}
                      placeholder={lang === 'en' ? 'Add model tag (e.g. gpt-6-luna)' : '添加常用模型标签 (如 gpt-6-luna)'}
                      value={customModelInput}
                      onInput={(e) => setCustomModelInput((e.currentTarget as HTMLInputElement).value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddCustomModel();
                        }
                      }}
                    />
                    <button type="button" class="mp-btn mp-btn--sm" onClick={handleAddCustomModel}>
                      + {lang === 'en' ? 'Pin Tag' : '加入标签'}
                    </button>
                  </div>
                </div>

                {candidateModels.length > 0 ? (
                  <div class="mp-chip-list">
                    {candidateModels.map((m) => {
                      const isActive = m === provider.model;
                      const isCustomRemovable = provider.models.includes(m) && candidateModels.length > 1;
                      return (
                        <span
                          key={m}
                          class={isActive ? 'mp-chip mp-chip--active' : 'mp-chip'}
                        >
                          <button
                            type="button"
                            style={{
                              appearance: 'none',
                              border: 'none',
                              background: 'transparent',
                              color: 'inherit',
                              font: 'inherit',
                              cursor: 'pointer',
                              padding: 0,
                            }}
                            onClick={() =>
                              updateProvider((p) => {
                                p.model = m;
                              })
                            }
                          >
                            {m}
                          </button>
                          {isCustomRemovable ? (
                            <button
                              type="button"
                              aria-label={`Remove model ${m}`}
                              style={{
                                appearance: 'none',
                                border: 'none',
                                background: 'transparent',
                                color: 'var(--muted)',
                                cursor: 'pointer',
                                padding: '0 2px',
                              }}
                              onClick={() =>
                                updateProvider((p) => {
                                  p.models = p.models.filter((item) => item !== m);
                                })
                              }
                            >
                              ×
                            </button>
                          ) : null}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </FieldRow>

            {/* Assistant Binding + Explicit 2-Mode Temperature Control + Live Preview */}
            {isAiProtocol ? (
              <>
                <FieldRow
                  label={lang === 'en' ? 'Bound Prompt Assistant' : '绑定提示词助手 (assistantId)'}
                  hint={
                    lang === 'en'
                      ? 'Choose Aloxaf <yaml>, %% streaming delimiter, or leave default id-locked JSON batch'
                      : '可绑定「泛用翻译大师 (<yaml>)」、「通用翻译 (%%)」或使用内置默认 JSON 批处理'
                  }
                >
                  <select
                    class="mp-select"
                    aria-label={lang === 'en' ? 'Bound Prompt Assistant' : '绑定提示词助手'}
                    value={provider.assistantId ?? ''}
                    onChange={(e) => {
                      const val = (e.currentTarget as HTMLSelectElement).value;
                      updateProvider((p) => {
                        if (val) {
                          p.assistantId = val;
                        } else {
                          delete p.assistantId;
                        }
                      });
                    }}
                  >
                    <option value="">
                      {lang === 'en'
                        ? 'Built-in Default (id-locked JSON Batch)'
                        : '内置默认 (JSON 严格 ID 批处理)'}
                    </option>
                    {Object.values(draft.assistants).map((ast) => (
                      <option key={ast.id} value={ast.id}>
                        {ast.name} [{ast.codec}]
                      </option>
                    ))}
                  </select>
                </FieldRow>

                <FieldRow
                  stacked
                  label={lang === 'en' ? 'Temperature Policy (2-Mode)' : '采样温度策略 (Temperature 双模式)'}
                  badge={
                    effectiveTemp ? (
                      <StatusPill
                        tone={effectiveTemp.value === undefined ? 'accent' : 'ok'}
                        dataTestId="live-temperature-preview"
                      >
                        {describeTemperatureResolution({
                          trace: effectiveTemp.trace,
                          value: effectiveTemp.value,
                          model: provider.model,
                          assistantName: boundAssistant?.name,
                          lang,
                        })}
                      </StatusPill>
                    ) : null
                  }
                  hint={
                    lang === 'en'
                      ? 'Omit never sends temperature:0, eliminating reasoning-model HTTP 400 errors.'
                      : '「不发送 Omit」彻底消除旧版默认发送 temperature:0 引发的推理模型 400 报错。'
                  }
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', width: '100%' }}>
                    <SegmentedControl
                      ariaLabel={lang === 'en' ? 'Temperature Mode' : '温度模式'}
                      options={[
                        {
                          value: 'omit',
                          label:
                            lang === 'en'
                              ? 'Omit (Recommended for Reasoning)'
                              : '不发送 Omit (推荐推理模型)',
                        },
                        {
                          value: 'custom',
                          label: lang === 'en' ? 'Custom (0.0–2.0)' : '自定义数值 0.0–2.0',
                        },
                      ]}
                      value={provider.temperaturePolicy.mode}
                      onChange={(mode) =>
                        updateProvider((p) => {
                          if (mode === 'omit') {
                            p.temperaturePolicy = { mode: 'omit' };
                          } else {
                            p.temperaturePolicy = { mode: 'custom', value: 0.3 };
                          }
                        })
                      }
                    />

                    {provider.temperaturePolicy.mode === 'custom' ? (
                      <>
                        <input
                          type="number"
                          class="mp-input mp-input--mono"
                          aria-label={lang === 'en' ? 'Custom Temperature Value' : '自定义温度数值'}
                          style={{ width: '92px' }}
                          min={0}
                          max={2}
                          step={0.1}
                          value={provider.temperaturePolicy.value}
                          onInput={(e) => {
                            const raw = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
                            const clamped = Number.isFinite(raw)
                              ? Math.max(0, Math.min(2, Math.round(raw * 1000) / 1000))
                              : 0.3;
                            updateProvider((p) => {
                              const prevForce =
                                p.temperaturePolicy.mode === 'custom'
                                  ? p.temperaturePolicy.forceOnReasoning
                                  : undefined;
                              p.temperaturePolicy = {
                                mode: 'custom',
                                value: clamped,
                                ...(prevForce ? { forceOnReasoning: true } : {}),
                              };
                            });
                          }}
                        />

                        {isStrictTemperatureModel(provider.model) ? (
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                            <input
                              type="checkbox"
                              checked={Boolean(provider.temperaturePolicy.forceOnReasoning)}
                              onChange={(e) => {
                                const checked = (e.currentTarget as HTMLInputElement).checked;
                                updateProvider((p) => {
                                  if (p.temperaturePolicy.mode === 'custom') {
                                    p.temperaturePolicy = {
                                      mode: 'custom',
                                      value: p.temperaturePolicy.value,
                                      ...(checked ? { forceOnReasoning: true } : {}),
                                    };
                                  }
                                });
                              }}
                            />
                            <span class="mp-muted">
                              {lang === 'en' ? 'Force send on reasoning model' : '强制向推理模型发送'}
                            </span>
                          </label>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </FieldRow>

                <FieldRow
                  label={lang === 'en' ? 'Thinking / Reasoning Policy' : '深度思考策略 (ThinkingPolicy)'}
                  hint={
                    lang === 'en'
                      ? 'Controls thinking budget or disables reasoning when fast low-latency translation is preferred'
                      : '控制推理预算或关闭思考链以降低翻译首字延迟'
                  }
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <SegmentedControl
                      ariaLabel={lang === 'en' ? 'Thinking Policy' : '深度思考策略'}
                      options={[
                        { value: 'provider-default', label: lang === 'en' ? 'Default' : '默认' },
                        { value: 'disabled', label: lang === 'en' ? 'Disabled' : '关闭' },
                        { value: 'enabled', label: lang === 'en' ? 'Enabled' : '开启' },
                      ]}
                      value={provider.thinkingPolicy.mode}
                      onChange={(mode: ThinkingPolicy['mode']) =>
                        updateProvider((p) => {
                          if (mode === 'enabled') {
                            p.thinkingPolicy = { mode: 'enabled', budgetTokens: 2048 };
                          } else {
                            p.thinkingPolicy = { mode };
                          }
                        })
                      }
                    />
                    {provider.thinkingPolicy.mode === 'enabled' ? (
                      <input
                        type="number"
                        class="mp-input mp-input--mono"
                        style={{ width: '104px' }}
                        min={256}
                        max={32768}
                        step={256}
                        value={provider.thinkingPolicy.budgetTokens ?? 2048}
                        onInput={(e) => {
                          const budget = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                          updateProvider((p) => {
                            p.thinkingPolicy = {
                              mode: 'enabled',
                              budgetTokens: Number.isFinite(budget) ? Math.max(256, budget) : 2048,
                            };
                          });
                        }}
                      />
                    ) : null}
                  </div>
                </FieldRow>

                <FieldRow label={lang === 'en' ? 'SSE Streaming' : '流式响应传输 (SSE Stream)'}>
                  <SegmentedControl
                    ariaLabel={lang === 'en' ? 'Stream Policy' : '流式响应传输'}
                    options={[
                      { value: 'auto', label: lang === 'en' ? 'Auto' : '自动' },
                      { value: 'on', label: lang === 'en' ? 'On' : '开启' },
                      { value: 'off', label: lang === 'en' ? 'Off' : '关闭' },
                    ]}
                    value={provider.stream}
                    onChange={(next) =>
                      updateProvider((p) => {
                        p.stream = next;
                      })
                    }
                  />
                </FieldRow>

                <FieldRow
                  label={lang === 'en' ? 'Inject Document Context' : '注入页面标题与摘要上下文'}
                >
                  <ToggleSwitch
                    ariaLabel={lang === 'en' ? 'Inject Document Context' : '注入页面标题与摘要上下文'}
                    checked={provider.enableContext}
                    onChange={(next) =>
                      updateProvider((p) => {
                        p.enableContext = next;
                      })
                    }
                  />
                </FieldRow>
              </>
            ) : null}

            {/* Rate Limit & Concurrency */}
            <FieldRow
              label={lang === 'en' ? 'Rate Limit (RPS) & Max Concurrency' : '请求速率上限 (RPS) 与并发度'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label class="mp-muted" style={{ fontSize: '12px' }}>
                  RPS
                  <input
                    type="number"
                    class="mp-input mp-input--mono"
                    style={{ width: '76px', marginLeft: '6px' }}
                    min={1}
                    max={200}
                    value={provider.rateLimitRps}
                    onInput={(e) => {
                      const val = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                      updateProvider((p) => {
                        p.rateLimitRps = Number.isFinite(val) ? Math.max(1, val) : 20;
                      });
                    }}
                  />
                </label>

                <label class="mp-muted" style={{ fontSize: '12px' }}>
                  {lang === 'en' ? 'Concurrency' : '并发'}
                  <input
                    type="number"
                    class="mp-input mp-input--mono"
                    style={{ width: '72px', marginLeft: '6px' }}
                    min={1}
                    max={32}
                    value={provider.maxConcurrency}
                    onInput={(e) => {
                      const val = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                      updateProvider((p) => {
                        p.maxConcurrency = Number.isFinite(val) ? Math.max(1, val) : 4;
                      });
                    }}
                  />
                </label>
              </div>
            </FieldRow>
          </div>
        ) : null}
      </section>
    </div>
  );
}
