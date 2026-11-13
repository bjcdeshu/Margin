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
  CollapsibleSection,
  EditorialBadge,
  EmptyState,
  FieldRow,
  Icon,
  SegmentedControl,
  SettingGroup,
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

  const en = lang === 'en';
  const providerIndex = provider ? orderedIds.indexOf(provider.id) : -1;
  const isPrimary = provider ? draft.routing.webpage === provider.id : false;

  return (
    <div>
      {/* Provider Roster + Add Preset */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {en ? 'AI & Translation Channels' : 'AI 与翻译服务渠道'}
            </h2>
            <p class="mp-section-desc">
              {en
                ? 'Configure endpoints, multi-key rotation pools, and active models with 1-click connection verification.'
                : '配置服务地址、多密钥轮询池与主力模型，支持一键测试连通性；低频并发与采样参数已收纳于下方折叠区。'}
            </p>
          </div>

          <div class="mp-row mp-row--tight mp-row--nowrap mp-provider-add">
            <select
              class="mp-select"
              aria-label={en ? 'New Provider Preset' : '新增渠道预设'}
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
              <Icon name="plus" size={13} />
              {en ? 'Add Channel' : '添加渠道'}
            </button>
          </div>
        </div>

        <div class="mp-provider-layout">
          {/* Master: calm channel roster */}
          <nav class="mp-provider-rail">
            <div class="mp-provider-rail-head">
              <span class="mp-eyebrow">{en ? 'Channels' : '渠道'}</span>
              <span class="mp-eyebrow mp-tnum">{orderedIds.length}</span>
            </div>
            <div
              class="mp-provider-list"
              role="tablist"
              aria-label={en ? 'Provider List' : '渠道列表'}
            >
              {orderedIds.map((id) => {
                const p = draft.providers[id];
                if (!p) return null;
                const selected = id === activeId;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    class="mp-provider-item"
                    data-enabled={p.enabled ? 'true' : 'false'}
                    aria-selected={selected ? 'true' : 'false'}
                    onClick={() => {
                      commitCustomModelInput();
                      setSelectedId(id);
                      setRevealKeys(false);
                    }}
                  >
                    <span
                      class={p.enabled ? 'mp-provider-dot mp-provider-dot--on' : 'mp-provider-dot'}
                      aria-hidden="true"
                    />
                    <span class="mp-provider-item-text">
                      <span class="mp-provider-item-name">{p.name}</span>
                      <span class="mp-provider-item-model">{p.model}</span>
                    </span>
                    {!p.enabled ? (
                      <StatusPill tone="danger">{en ? 'Off' : '已停用'}</StatusPill>
                    ) : draft.routing.webpage === id ? (
                      <StatusPill tone="accent">{en ? 'Primary' : '主服务'}</StatusPill>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Detail */}
          {provider ? (
            <div class="mp-provider-detail">
              {/* Detail header: identity + actions */}
              <div class="mp-provider-head">
                <div class="mp-provider-identity">
                  <div class="mp-row mp-row--tight">
                    <span
                      class={provider.enabled ? 'mp-provider-dot mp-provider-dot--on' : 'mp-provider-dot'}
                      aria-hidden="true"
                    />
                    <h3 class="mp-provider-title">{provider.name}</h3>
                    {isPrimary ? (
                      <EditorialBadge tone="accent">{en ? 'Primary webpage channel' : '网页主服务'}</EditorialBadge>
                    ) : null}
                  </div>
                  <div class="mp-row mp-row--tight">
                    <StatusPill tone="mono">{provider.id}</StatusPill>
                    <StatusPill tone="neutral">{labelForPreset(provider.preset, lang)}</StatusPill>
                    <span class="mp-pill mp-pill--mono">{provider.protocol}</span>
                  </div>
                </div>

                <div class="mp-row mp-row--tight mp-provider-actions">
                  <button
                    type="button"
                    class="mp-btn mp-btn--solid"
                    data-testid="provider-test-btn"
                    disabled={testingId === provider.id}
                    onClick={() => void handleTestConnection()}
                  >
                    <Icon name={testingId === provider.id ? 'refresh' : 'pulse'} size={13} class={testingId === provider.id ? 'mp-spin' : undefined} />
                    {testingId === provider.id
                      ? en
                        ? 'Testing…'
                        : '测试连接中…'
                      : en
                        ? 'Test Connection'
                        : '测试连接'}
                  </button>
                </div>
              </div>

              <div class="mp-provider-toolbar">
                <div class="mp-row mp-row--tight">
                  {!isPrimary && provider.enabled ? (
                    <button
                      type="button"
                      class="mp-btn mp-btn--ghost mp-btn--sm"
                      onClick={() =>
                        onMutate((d) => {
                          d.routing.webpage = provider.id;
                        })
                      }
                    >
                      <Icon name="route" size={12} />
                      {en ? 'Set as Primary Webpage Channel' : '设为网页主服务'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    class="mp-btn mp-btn--ghost mp-btn--sm"
                    disabled={providerIndex <= 0}
                    onClick={() => handleMoveProvider(provider.id, -1)}
                  >
                    ↑ {en ? 'Up' : '上移'}
                  </button>
                  <button
                    type="button"
                    class="mp-btn mp-btn--ghost mp-btn--sm"
                    disabled={providerIndex >= orderedIds.length - 1}
                    onClick={() => handleMoveProvider(provider.id, 1)}
                  >
                    ↓ {en ? 'Down' : '下移'}
                  </button>
                  <span class="mp-provider-order mp-tnum">
                    {providerIndex + 1} / {orderedIds.length}
                  </span>
                </div>
                {orderedIds.length > 1 ? (
                  <button
                    type="button"
                    class="mp-btn mp-btn--danger mp-btn--sm"
                    onClick={() => handleDeleteProvider(provider.id)}
                  >
                    <Icon name="trash" size={12} />
                    {en ? 'Delete' : '删除渠道'}
                  </button>
                ) : null}
              </div>

              {/* Live Connection Test Result Card */}
              {activeTest ? (
                <div
                  class="mp-card mp-test-card"
                  data-tone={activeTest.ok && activeTest.response ? 'ok' : 'danger'}
                  data-testid="provider-test-result"
                >
                  <span class="mp-test-glyph" aria-hidden="true">
                    <Icon name={activeTest.ok && activeTest.response ? 'check' : 'x'} size={14} strokeWidth={1.8} />
                  </span>
                  {activeTest.ok && activeTest.response ? (
                    <div class="mp-test-body">
                      <div class="mp-row mp-row--tight">
                        <strong class="mp-test-title">{en ? 'Connected OK' : '连接成功'}</strong>
                        <span class="mp-pill mp-pill--ok mp-tnum">
                          <Icon name="bolt" size={11} />
                          {activeTest.response.diagnostic.latencyMs}ms
                        </span>
                        <StatusPill tone="mono">
                          trace: {activeTest.response.diagnostic.parameters.temperatureTrace}
                          {activeTest.response.diagnostic.parameters.temperatureSent !== undefined
                            ? ` (${activeTest.response.diagnostic.parameters.temperatureSent})`
                            : ''}
                        </StatusPill>
                      </div>
                      <div class="mp-test-sample">
                        {activeTest.response.items[0]?.trans
                          ? `Sample: "${activeTest.response.items[0].trans}"`
                          : activeTest.response.model}
                      </div>
                    </div>
                  ) : (
                    <div class="mp-test-body">
                      <div class="mp-row mp-row--tight">
                        <strong class="mp-test-title">{en ? 'Connection Failed' : '连接失败'}</strong>
                      </div>
                      <div class="mp-test-error">{activeTest.error || 'Unknown error'}</div>
                    </div>
                  )}
                </div>
              ) : null}

              {/* Primary Connection Settings */}
              <SettingGroup label={en ? 'Connection' : '连接'}>
                <FieldRow label={en ? 'Channel Name' : '渠道显示名称'}>
                  <input
                    type="text"
                    class="mp-input mp-input--name"
                    value={provider.name}
                    onInput={(e) => {
                      const val = (e.currentTarget as HTMLInputElement).value;
                      updateProvider((p) => {
                        p.name = val;
                      });
                    }}
                  />
                </FieldRow>

                <FieldRow label={en ? 'Enabled' : '启用此渠道'}>
                  <ToggleSwitch
                    ariaLabel={en ? 'Enable Provider' : '启用此渠道'}
                    checked={provider.enabled}
                    onChange={(next) =>
                      updateProvider((p) => {
                        p.enabled = next;
                      })
                    }
                  />
                </FieldRow>

                <FieldRow
                  label={en ? 'Wire Protocol' : '通信协议 (Wire Protocol)'}
                  hint={
                    en
                      ? 'OpenAI-compatible gateways, Zhipu, and DeepSeek all speak openai-chat'
                      : 'OpenAI 兼容中转站、DeepSeek、智谱 GLM 均使用 openai-chat 协议'
                  }
                >
                  <select
                    class="mp-select"
                    aria-label={en ? 'Wire Protocol' : '通信协议'}
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
                  label={en ? 'Base URL / Endpoint' : '接口地址 (Base URL)'}
                  hint={
                    en
                      ? 'Domain root or /v1 auto-completes path on request without mutating your saved Base URL'
                      : '填写域名根目录或 /v1 会自动补全请求路径，同时原样保留您填写的 Base URL'
                  }
                >
                  <div class="mp-stack mp-stack--tight">
                    <input
                      type="text"
                      class="mp-input mp-input--mono mp-input--block"
                      value={provider.baseUrl}
                      placeholder={PROVIDER_PRESETS[provider.preset]?.defaultEndpoint}
                      onInput={(e) => {
                        const val = (e.currentTarget as HTMLInputElement).value;
                        updateProvider((p) => {
                          p.baseUrl = val;
                        });
                      }}
                    />
                    {endpointPreview ? (
                      <span
                        class={
                          endpointPreview.valid
                            ? 'mp-endpoint-chip'
                            : 'mp-endpoint-chip mp-endpoint-chip--danger'
                        }
                        data-testid="provider-endpoint-preview"
                        title={endpointPreview.valid ? endpointPreview.fullUrl : undefined}
                      >
                        <Icon name={endpointPreview.valid ? 'route' : 'x'} size={12} />
                        {endpointPreview.valid ? (
                          <>
                            <span class="mp-endpoint-chip-label">
                              {en ? 'Resolved:' : '实际请求端点：'}
                            </span>{' '}
                            <span class="mp-endpoint-chip-url">{endpointPreview.fullUrl}</span>
                          </>
                        ) : (
                          <span class="mp-endpoint-chip-label">
                            {en ? 'Invalid URL' : 'URL 格式无效'}
                          </span>
                        )}
                      </span>
                    ) : null}
                  </div>
                </FieldRow>

                {provider.protocol === 'deeplx' ? (
                  <FieldRow
                    stacked
                    label={en ? 'DeepLX Rotation Endpoints' : 'DeepLX 多节点轮询地址 (每行或逗号分隔)'}
                    badge={
                      <span class="mp-pill mp-pill--mono">
                        {parseSplitList(rawEndpointsText).length}
                      </span>
                    }
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
              </SettingGroup>

              {/* Multi-Key API Key Pool (Masked by default, raw string buffer preserves typing) */}
              {PROVIDER_PRESETS[provider.preset]?.requiresApiKey || provider.apiKeys.length > 0 || provider.protocol !== 'google-web' ? (
                <SettingGroup label={en ? 'Authentication' : '认证'}>
                  <FieldRow
                    stacked
                    label={
                      <span class="mp-row mp-row--tight mp-row--nowrap">
                        <Icon name="key" size={13} />
                        <span>{en ? 'API Keys (Multi-Key Pool)' : 'API 密钥池 (支持多 Key 轮询)'}</span>
                      </span>
                    }
                    badge={
                      <StatusPill tone={provider.apiKeys.length > 0 ? 'ok' : 'neutral'}>
                        {en
                          ? `${provider.apiKeys.length} key(s)`
                          : `已配置 ${provider.apiKeys.length} 把密钥`}
                      </StatusPill>
                    }
                    hint={
                      en
                        ? 'One key per line or comma-separated. Keys are masked by default and rotated automatically on HTTP 429.'
                        : '支持换行或逗号分隔多把 Key，遇到 429 限流自动轮换冷却；默认遮罩显示。'
                    }
                  >
                    <div class="mp-stack mp-stack--tight">
                      <div class="mp-key-field">
                        {revealKeys ? (
                          <textarea
                            class="mp-textarea mp-textarea--mono mp-grow"
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
                            class="mp-input mp-input--mono mp-grow"
                            data-testid="api-keys-masked-input"
                            aria-label={en ? 'Masked API Key Input' : 'API 密钥输入 (遮罩模式)'}
                            placeholder={
                              en
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
                          <Icon name={revealKeys ? 'lock' : 'eye'} size={12} />
                          {revealKeys
                            ? en
                              ? 'Hide Keys'
                              : '隐藏明文密钥'
                            : en
                              ? 'Reveal Keys to Edit'
                              : '显示/多行编辑密钥'}
                        </button>
                      </div>
                      <div class="mp-key-hints">
                        <span class="mp-key-hint">
                          <Icon name={revealKeys ? 'eye' : 'lock'} size={11} />
                          {revealKeys
                            ? en
                              ? 'plaintext · one per line'
                              : '明文 · 每行一把'
                            : en
                              ? 'masked'
                              : '已遮罩'}
                        </span>
                        <span class="mp-key-hint">
                          <Icon name="refresh" size={11} />
                          {provider.apiKeys.length > 1
                            ? en
                              ? `round-robin ×${provider.apiKeys.length} · cooldown on 429`
                              : `轮询 ×${provider.apiKeys.length} · 429 自动冷却`
                            : en
                              ? 'add more keys to rotate on 429'
                              : '添加多把 Key 可在 429 时自动轮换'}
                        </span>
                      </div>
                    </div>
                  </FieldRow>
                </SettingGroup>
              ) : null}

              {/* Model Selector + Custom Model Tags */}
              <SettingGroup label={en ? 'Model' : '模型'}>
                <FieldRow
                  stacked
                  label={en ? 'Active Model & Custom Model Tags' : '当前模型与常用模型标签'}
                  badge={
                    isStrictTemperatureModel(provider.model) ? (
                      <StatusPill tone="accent">
                        {en ? 'Reasoning / Strict Model' : '推理/严格参数模型'}
                      </StatusPill>
                    ) : null
                  }
                >
                  <div class="mp-stack">
                    <div class="mp-model-inputs">
                      <input
                        type="text"
                        class="mp-input mp-input--mono mp-model-main"
                        aria-label={en ? 'Active Model Name' : '当前模型名称'}
                        value={provider.model}
                        onInput={(e) => {
                          const val = (e.currentTarget as HTMLInputElement).value;
                          updateProvider((p) => {
                            p.model = val;
                          });
                        }}
                      />
                      <div class="mp-row mp-row--tight mp-row--nowrap mp-model-tag">
                        <input
                          type="text"
                          class="mp-input mp-input--mono mp-grow"
                          data-testid="custom-model-tag-input"
                          placeholder={en ? 'Add model tag (e.g. gpt-6-luna)' : '输入新模型后回车或直接保存'}
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
                          <Icon name="plus" size={12} />
                          {en ? 'Pin Tag' : '加入标签'}
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
                                class="mp-chip-main"
                                aria-pressed={isActive ? 'true' : 'false'}
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
                                  class="mp-chip-remove"
                                  aria-label={`Remove model ${m}`}
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
                    label={en ? 'Bound Prompt Assistant' : '绑定提示词助手 (assistantId)'}
                    hint={
                      en
                        ? 'Defaults to Margin Fast Editorial (<yaml>) with scene-aware prompts; also supports Thinking (<yaml>), %% delimiter, or JSON batch'
                        : '新建 AI 渠道默认绑定「Margin 信达雅精译 (<yaml>)」结构化分场景提示词；也可切换思考精修、极速 %% 或 JSON 批处理'
                    }
                  >
                    <select
                      class="mp-select"
                      data-testid="provider-assistant-select"
                      aria-label={en ? 'Bound Prompt Assistant' : '绑定提示词助手'}
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
                        {en
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
              </SettingGroup>

              {/* Secondary Disclosure: Advanced Request & Concurrency Parameters */}
              <CollapsibleSection
                icon="gear"
                title={en ? 'Advanced Request & Concurrency Tuning' : '高级请求、温度与并发参数'}
                meta={<StatusPill tone="mono">{advancedSummaryLabel}</StatusPill>}
              >
                {isAiProtocol ? (
                  <>
                    <FieldRow
                      stacked
                      label={en ? 'Temperature Policy (2-Mode)' : '采样温度策略 (Temperature 双模式)'}
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
                        en
                          ? 'Omit never sends temperature:0, eliminating reasoning-model HTTP 400 errors.'
                          : '「不发送 Omit」彻底消除旧版默认发送 temperature:0 引发的推理模型 400 报错。'
                      }
                    >
                      <div class="mp-row">
                        <SegmentedControl
                          ariaLabel={en ? 'Temperature Mode' : '温度模式'}
                          options={[
                            {
                              value: 'omit',
                              label: en ? 'Omit (Recommended for Reasoning)' : '不发送 Omit (推荐推理模型)',
                            },
                            {
                              value: 'custom',
                              label: en ? 'Custom (0.0–2.0)' : '自定义数值 0.0–2.0',
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
                              class="mp-input mp-input--mono mp-input--num"
                              aria-label={en ? 'Custom Temperature Value' : '自定义温度数值'}
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
                              <label class="mp-inline-check">
                                <input
                                  type="checkbox"
                                  class="mp-checkbox"
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
                                <span>
                                  {en ? 'Force send on reasoning model' : '强制向推理模型发送'}
                                </span>
                              </label>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </FieldRow>

                    <FieldRow
                      label={en ? 'Thinking / Reasoning Policy' : '深度思考策略 (ThinkingPolicy)'}
                      hint={
                        en
                          ? 'Controls thinking budget or disables reasoning when fast low-latency translation is preferred'
                          : '控制推理预算或关闭思考链以降低首屏译文延迟'
                      }
                    >
                      <div class="mp-row">
                        <SegmentedControl
                          ariaLabel={en ? 'Thinking Policy' : '深度思考策略'}
                          options={[
                            { value: 'provider-default', label: en ? 'Default' : '默认' },
                            { value: 'disabled', label: en ? 'Disabled' : '关闭' },
                            { value: 'enabled', label: en ? 'Enabled' : '开启' },
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
                          <span class="mp-num-field">
                            <input
                              type="number"
                              class="mp-input mp-input--mono mp-input--num mp-input--num-wide"
                              aria-label={en ? 'Thinking budget tokens' : '思考预算 tokens'}
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
                            <span class="mp-num-unit">tok</span>
                          </span>
                        ) : null}
                      </div>
                    </FieldRow>

                    <FieldRow label={en ? 'SSE Streaming' : '流式响应传输 (SSE Stream)'}>
                      <SegmentedControl
                        ariaLabel={en ? 'Stream Policy' : '流式响应传输'}
                        options={[
                          { value: 'auto', label: en ? 'Auto' : '自动' },
                          { value: 'on', label: en ? 'On' : '开启' },
                          { value: 'off', label: en ? 'Off' : '关闭' },
                        ]}
                        value={provider.stream}
                        onChange={(next) =>
                          updateProvider((p) => {
                            p.stream = next;
                          })
                        }
                      />
                    </FieldRow>

                    <FieldRow label={en ? 'Inject Document Context' : '注入页面标题与摘要上下文'}>
                      <ToggleSwitch
                        ariaLabel={en ? 'Inject Document Context' : '注入页面标题与摘要上下文'}
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
                  label={en ? 'Rate Limit (RPS) & Max Concurrency' : '请求速率上限 (RPS) 与并发度'}
                >
                  <div class="mp-row mp-row--nowrap">
                    <label class="mp-num-field">
                      <span class="mp-num-unit">RPS</span>
                      <input
                        type="number"
                        class="mp-input mp-input--mono mp-input--num"
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

                    <label class="mp-num-field">
                      <span class="mp-num-unit">{en ? 'Concurrency' : '并发'}</span>
                      <input
                        type="number"
                        class="mp-input mp-input--mono mp-input--num"
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
              </CollapsibleSection>
            </div>
          ) : (
            <div class="mp-provider-detail">
              <EmptyState title={en ? 'No channel selected' : '尚未选择渠道'}>
                {en ? 'Add a channel from the preset menu above.' : '请从右上角预设菜单添加渠道。'}
              </EmptyState>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
