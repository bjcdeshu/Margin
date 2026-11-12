import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
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
  registerPendingFlush?: (fn: (() => void) | null) => void;
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

const DEFAULT_ENDPOINT_BY_PROTOCOL: Readonly<Record<WireProtocol, string>> = {
  'openai-chat': PROVIDER_PRESETS.openai.defaultEndpoint,
  'anthropic-messages': PROVIDER_PRESETS.anthropic.defaultEndpoint,
  deeplx: PROVIDER_PRESETS.deeplx.defaultEndpoint,
  'google-web': PROVIDER_PRESETS['google-free'].defaultEndpoint,
};

const KNOWN_BUILTIN_ENDPOINTS = new Set<string>(
  Object.values(PROVIDER_PRESETS)
    .map((m) => m.defaultEndpoint)
    .filter(Boolean),
);

function adaptBaseUrlForProtocolSwitch(
  currentUrl: string,
  nextProto: WireProtocol,
): string {
  const trimmed = currentUrl.trim();
  if (!trimmed || KNOWN_BUILTIN_ENDPOINTS.has(trimmed)) {
    return DEFAULT_ENDPOINT_BY_PROTOCOL[nextProto];
  }

  // Strip another protocol's default path suffix on custom gateway origins
  const stripped = trimmed.replace(
    /(?:\/v1\/chat\/completions|\/api\/paas\/v4\/chat\/completions|\/v1\/messages|\/translate_a\/single|\/translate)\/?$/i,
    '',
  );
  if (stripped !== trimmed && stripped) {
    if (nextProto === 'openai-chat') return `${stripped}/v1/chat/completions`;
    if (nextProto === 'anthropic-messages') return `${stripped}/v1/messages`;
    if (nextProto === 'deeplx') return `${stripped}/translate`;
  }
  return currentUrl;
}

function parseSplitList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createProviderFromPreset(preset: ProviderPreset): ProviderConfig {
  const meta = PROVIDER_PRESETS[preset];
  const suffix = Math.random().toString(36).slice(2, 7);
  const id = `${preset}-${suffix}`;
  const isAiChannel =
    meta.protocol === 'openai-chat' || meta.protocol === 'anthropic-messages';
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
    ...(isAiChannel ? { assistantId: 'builtin-yaml' } : {}),
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
  registerPendingFlush,
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

  // Raw string buffers so typing commas, spaces, or Enter newlines never strips characters mid-edit
  const [rawApiKeysText, setRawApiKeysText] = useState(() =>
    (provider?.apiKeys ?? []).join('\n'),
  );
  const [rawEndpointsText, setRawEndpointsText] = useState(() =>
    (provider?.endpoints ?? (provider ? [provider.baseUrl] : [])).join('\n'),
  );

  const prevActiveIdRef = useRef(activeId);
  useEffect(() => {
    if (!provider) return;
    const switchedChannel = prevActiveIdRef.current !== activeId;
    prevActiveIdRef.current = activeId;

    if (switchedChannel) {
      setRawApiKeysText(
        revealKeys ? provider.apiKeys.join('\n') : provider.apiKeys.join(', '),
      );
      setRawEndpointsText((provider.endpoints ?? [provider.baseUrl]).join('\n'));
      setCustomModelInput('');
      return;
    }

    if (parseSplitList(rawApiKeysText).join('\n') !== provider.apiKeys.join('\n')) {
      setRawApiKeysText(
        revealKeys ? provider.apiKeys.join('\n') : provider.apiKeys.join(', '),
      );
    }
    const targetEndpoints = provider.endpoints ?? [provider.baseUrl];
    if (
      parseSplitList(rawEndpointsText).join('\n') !==
      targetEndpoints.filter(Boolean).join('\n')
    ) {
      setRawEndpointsText(targetEndpoints.join('\n'));
    }
  }, [activeId, provider?.apiKeys, provider?.endpoints, provider?.baseUrl, revealKeys]);

  const updateProvider = (mutator: (p: ProviderConfig) => void) => {
    if (!activeId) return;
    onMutate((d) => {
      const target = d.providers[activeId];
      if (target) mutator(target);
    });
  };

  const customModelInputRef = useRef(customModelInput);
  customModelInputRef.current = customModelInput;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const commitCustomModelInput = () => {
    const trimmed = customModelInputRef.current.trim();
    const targetId = activeIdRef.current;
    if (!trimmed || !targetId) return;
    onMutate((d) => {
      const p = d.providers[targetId];
      if (!p) return;
      if (!p.models.includes(trimmed)) {
        p.models = [...p.models, trimmed];
      }
      p.model = trimmed;
    });
    customModelInputRef.current = '';
    setCustomModelInput('');
  };

  useEffect(() => {
    if (!registerPendingFlush) return;
    registerPendingFlush(() => {
      commitCustomModelInput();
    });
    return () => registerPendingFlush(null);
  }, [registerPendingFlush]);

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
    const fallbackId =
      remaining.find((rid) => draft.providers[rid]?.enabled) ?? remaining[0];
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

  const handleTestConnection = async () => {
    if (!provider) return;
    commitCustomModelInput();
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

  const advancedSummaryLabel = useMemo(() => {
    if (!provider) return '';
    if (!isAiProtocol) {
      return `${provider.rateLimitRps} RPS · ${lang === 'en' ? 'Concurrency' : '并发'} ${provider.maxConcurrency}`;
    }
    const tempLabel =
      provider.temperaturePolicy.mode === 'omit'
        ? lang === 'en'
          ? 'Omit Temp'
          : 'Omit温度'
        : `Temp ${provider.temperaturePolicy.value}`;
    const thinkLabel =
      provider.thinkingPolicy.mode === 'provider-default'
        ? lang === 'en'
          ? 'Default Thinking'
          : '默认思考'
        : provider.thinkingPolicy.mode === 'disabled'
          ? lang === 'en'
            ? 'No Thinking'
            : '关闭思考'
          : lang === 'en'
            ? 'Thinking On'
            : '开启思考';
    const streamLabel =
      provider.stream === 'off'
        ? 'SSE Off'
        : lang === 'en'
          ? `SSE ${provider.stream}`
          : `SSE ${provider.stream === 'on' ? '强制' : '自动'}`;
    return `${tempLabel} · ${thinkLabel} · ${streamLabel} · ${lang === 'en' ? 'Concurrency' : '并发'} ${provider.maxConcurrency}`;
  }, [provider, isAiProtocol, lang]);

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
                ? 'Configure endpoints, multi-key rotation pools, and active models with 1-click connection verification.'
                : '配置服务地址、多密钥轮询池与主力模型，支持一键测试连通性；低频并发与采样参数已收纳于下方折叠区。'}
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
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
                  commitCustomModelInput();
                  setSelectedId(id);
                  setRevealKeys(false);
                }}
              >
                <span>{p.name}</span>
                <span class="mp-mono mp-muted">{p.model}</span>
                {!p.enabled ? (
                  <StatusPill tone="danger">{lang === 'en' ? 'Off' : '已停用'}</StatusPill>
                ) : draft.routing.webpage === id ? (
                  <StatusPill tone="accent">{lang === 'en' ? 'Primary' : '主服务'}</StatusPill>
                ) : null}
              </button>
            );
          })}
        </div>

        {provider ? (
          <div>
            {/* Toolbar for active provider: reorder, make primary, test connection, delete */}
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
                {draft.routing.webpage !== provider.id && provider.enabled ? (
                  <button
                    type="button"
                    class="mp-btn mp-btn--sm"
                    onClick={() =>
                      onMutate((d) => {
                        d.routing.webpage = provider.id;
                      })
                    }
                  >
                    {lang === 'en' ? 'Set as Primary Webpage Channel' : '设为网页主服务'}
                  </button>
                ) : null}
                <button
                  type="button"
                  class="mp-btn mp-btn--sm"
                  disabled={orderedIds.indexOf(provider.id) <= 0}
                  onClick={() => handleMoveProvider(provider.id, -1)}
                >
                  ↑ {lang === 'en' ? 'Up' : '上移'}
                </button>
                <button
                  type="button"
                  class="mp-btn mp-btn--sm"
                  disabled={orderedIds.indexOf(provider.id) >= orderedIds.length - 1}
                  onClick={() => handleMoveProvider(provider.id, 1)}
                >
                  ↓ {lang === 'en' ? 'Down' : '下移'}
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

            {/* Primary Connection Settings */}
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
                aria-label={lang === 'en' ? 'Wire Protocol' : '通信协议'}
                value={provider.protocol}
                onChange={(e) => {
                  const nextProto = (e.currentTarget as HTMLSelectElement).value as WireProtocol;
                  updateProvider((p) => {
                    p.baseUrl = adaptBaseUrlForProtocolSwitch(p.baseUrl, nextProto);
                    p.protocol = nextProto;
                    if (nextProto === 'deeplx' || nextProto === 'google-web') {
                      p.stream = 'off';
                      delete p.assistantId;
                    } else if (!p.assistantId && draft.assistants['builtin-yaml']) {
                      p.assistantId = 'builtin-yaml';
                    }
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
                  data-testid="deeplx-endpoints-textarea"
                  value={rawEndpointsText}
                  onInput={(e) => {
                    const raw = (e.currentTarget as HTMLTextAreaElement).value;
                    setRawEndpointsText(raw);
                    const list = parseSplitList(raw);
                    updateProvider((p) => {
                      p.endpoints = list;
                      if (list[0]) p.baseUrl = list[0];
                    });
                  }}
                />
              </FieldRow>
            ) : null}

            {/* Multi-Key API Key Pool (Masked by default, raw string buffer preserves typing) */}
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
                    : '支持换行或逗号分隔多把 Key，遇到 429 限流自动轮换冷却；默认遮罩显示。'
                }
              >
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      class="mp-btn mp-btn--ghost mp-btn--sm"
                      data-testid="toggle-reveal-keys-btn"
                      onClick={() => {
                        setRevealKeys((prev) => {
                          const next = !prev;
                          setRawApiKeysText(
                            next
                              ? provider.apiKeys.join('\n')
                              : provider.apiKeys.join(', '),
                          );
                          return next;
                        });
                      }}
                    >
                      {revealKeys
                        ? lang === 'en'
                          ? 'Hide Keys'
                          : '隐藏明文密钥'
                        : lang === 'en'
                          ? 'Reveal Keys to Edit'
                          : '显示/多行编辑密钥'}
                    </button>
                  </div>

                  {revealKeys ? (
                    <textarea
                      class="mp-textarea mp-textarea--mono"
                      data-testid="api-keys-textarea"
                      placeholder="sk-..."
                      value={rawApiKeysText}
                      onInput={(e) => {
                        const raw = (e.currentTarget as HTMLTextAreaElement).value;
                        setRawApiKeysText(raw);
                        const keys = parseSplitList(raw);
                        updateProvider((p) => {
                          p.apiKeys = keys;
                        });
                      }}
                    />
                  ) : (
                    <input
                      type="password"
                      class="mp-input mp-input--mono"
                      data-testid="api-keys-masked-input"
                      style={{ width: '100%' }}
                      aria-label={lang === 'en' ? 'Masked API Key Input' : 'API 密钥输入 (遮罩模式)'}
                      placeholder={
                        lang === 'en'
                          ? 'Paste API key(s) (comma-separated, masked)...'
                          : '粘贴 API Key（支持逗号分隔多把密钥，默认遮罩显示）...'
                      }
                      value={rawApiKeysText}
                      onInput={(e) => {
                        const raw = (e.currentTarget as HTMLInputElement).value;
                        setRawApiKeysText(raw);
                        const keys = parseSplitList(raw);
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
              label={lang === 'en' ? 'Active Model & Custom Model Tags' : '当前模型与常用模型标签'}
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
                      data-testid="custom-model-tag-input"
                      style={{ minWidth: '230px' }}
                      placeholder={lang === 'en' ? 'Add model tag (e.g. gpt-6-luna)' : '输入新模型后回车或直接保存'}
                      value={customModelInput}
                      onInput={(e) => setCustomModelInput((e.currentTarget as HTMLInputElement).value)}
                      onBlur={() => commitCustomModelInput()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitCustomModelInput();
                        }
                      }}
                    />
                    <button
                      type="button"
                      class="mp-btn mp-btn--sm"
                      onClick={() => commitCustomModelInput()}
                    >
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

            {isAiProtocol ? (
              <FieldRow
                label={lang === 'en' ? 'Bound Prompt Assistant' : '绑定提示词助手 (assistantId)'}
                hint={
                  lang === 'en'
                    ? 'Defaults to Margin Fast Editorial (<yaml>) with scene-aware prompts; also supports Thinking (<yaml>), %% delimiter, or JSON batch'
                    : '新建 AI 渠道默认绑定「Margin 信达雅精译 (<yaml>)」结构化分场景提示词；也可切换思考精修、极速 %% 或 JSON 批处理'
                }
              >
                <select
                  class="mp-select"
                  data-testid="provider-assistant-select"
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
            ) : null}

            {/* Secondary Disclosure: Advanced Request & Concurrency Parameters */}
            <details class="mp-advanced-details">
              <summary class="mp-advanced-summary">
                <span>
                  {lang === 'en'
                    ? 'Advanced Request & Concurrency Tuning'
                    : '高级请求、温度与并发参数'}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <StatusPill tone="mono">{advancedSummaryLabel}</StatusPill>
                  <span class="mp-advanced-chevron">▸</span>
                </span>
              </summary>

              <div class="mp-advanced-body">
                {isAiProtocol ? (
                  <>
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
                          : '控制推理预算或关闭思考链以降低首屏译文延迟'
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
            </details>
          </div>
        ) : null}
      </section>
    </div>
  );
}
