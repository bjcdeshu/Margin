import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';
import {
  BUILTIN_GLOSSARY_PACKS,
  expandAssistantPrompts,
  formatGlossaryBulkText,
  matchGlossaryEntries,
  parseGlossaryBulkText,
  resolveEffectiveGlossary,
} from '@core/prompts';
import {
  BUILTIN_ASSISTANTS,
  DEFAULT_ENABLED_GLOSSARY_PACK_IDS,
  resolveProviderIdForScene,
} from '@shared/constants';
import {
  requestBatchTranslation,
  requestClearTranslationCache,
  requestTranslationCacheStats,
} from '@shared/messaging';
import type {
  AssistantConfig,
  GlossaryEntry,
  MarginConfig,
  PageContextPayload,
  PromptCodecId,
} from '@shared/types';
import {
  FieldRow,
  CollapsibleSection,
  EditorialBadge,
  EmptyState,
  Icon,
  Metric,
  SegmentedControl,
  SettingGroup,
  StatusPill,
  SubHead,
  ToggleSwitch,
  labelForCodec,
} from '../../components';

export interface PromptsGlossaryTabProps {
  draft: MarginConfig;
  onMutate: (mutator: (next: MarginConfig) => void) => void;
  registerPendingFlush?: (fn: (() => void) | null) => void;
  onEnsureSavedBeforeTest?: () => Promise<void>;
}

type PromptSlot =
  | 'prompt'
  | 'inputPrompt'
  | 'selectionPrompt'
  | 'subtitlePrompt'
  | 'systemPrompt';

type PreviewScene = 'webpage' | 'input' | 'selection' | 'subtitle';

type SampleDomainKey = 'x.com' | 'github.com' | 'youtube.com' | 'arxiv.org' | 'none';

const CANONICAL_BUILTIN_ORDER = [
  'builtin-yaml',
  'builtin-yaml-thinking',
  'builtin-delimiter',
] as const;

const TEMPLATE_VARIABLES = [
  '{{to}}',
  '{{yaml}}',
  '{{text}}',
  '{{glossary_prompt}}',
  '{{style_prompt}}',
  '{{title_prompt}}',
  '{{summary_prompt}}',
  '{{thread_prompt}}',
  '{{context_window_prompt}}',
] as const;

const DEFAULT_PREVIEW_SAMPLE_TEXT =
  'When scaling an LLM Agent with a 200K Context Window, KV Cache reuse keeps latency low—just like nailing a frame-perfect Parry in Phantom Blade Zero.';

const SAMPLE_DOMAIN_CONTEXTS: Readonly<
  Record<Exclude<SampleDomainKey, 'none'>, PageContextPayload>
> = {
  'x.com': {
    url: 'https://x.com/karpathy/status/1900001',
    domain: 'x.com',
    title: 'Andrej Karpathy on X',
    summary:
      'Thread on LLM Agent scaling, Context Window efficiency, and action game combat feel.',
    styleGuide:
      'Social post / thread register (X): crisp, conversational, authentic tech & gaming community tone; preserve @handles, #hashtags, and acronyms.',
  },
  'github.com': {
    url: 'https://github.com/anthropics/claude-code/pull/42',
    domain: 'github.com',
    title: 'feat: optimize Subagent Context Window & KV Cache · Pull Request #42',
    summary: 'Engineering pull request reducing inference cold-start and backpressure.',
    styleGuide:
      'Developer documentation & GitHub engineering register: concise, accurate technical prose; preserve code identifiers, CLI flags, and PR terms.',
  },
  'youtube.com': {
    url: 'https://www.youtube.com/watch?v=pbz-combat',
    domain: 'www.youtube.com',
    title: 'Phantom Blade Zero — Combat Director Frame Breakdown',
    summary: 'Creator commentary explaining parry windows, hitboxes, and pacing.',
    styleGuide:
      'Spoken video & creator commentary register: natural, rhythmic spoken phrasing tailored for effortless on-screen reading.',
  },
  'arxiv.org': {
    url: 'https://arxiv.org/abs/2502.00001',
    domain: 'arxiv.org',
    title: 'Efficient Speculative Decoding for Long Context Window LLMs',
    summary: 'Academic paper on Transformer inference throughput and KV Cache compression.',
    styleGuide:
      'Academic & research paper register: rigorous, formal, unambiguous terminology and structured syntax.',
  },
};

function mergeBulkGlossaryEntries(
  existing: readonly GlossaryEntry[],
  incoming: readonly GlossaryEntry[],
): GlossaryEntry[] {
  const next = existing.map((item) => ({ ...item }));
  const indexByKey = new Map<string, number>();

  next.forEach((entry, idx) => {
    const key = `${entry.k.trim().toLowerCase()}@@${(entry.domain ?? '').trim().toLowerCase()}`;
    if (entry.k.trim()) {
      indexByKey.set(key, idx);
    }
  });

  for (const item of incoming) {
    const lookupKey = `${item.k.trim().toLowerCase()}@@${(item.domain ?? '').trim().toLowerCase()}`;
    const existingIdx = indexByKey.get(lookupKey);
    if (existingIdx !== undefined) {
      next[existingIdx] = {
        ...next[existingIdx],
        k: item.k,
        v: item.v,
        ...(item.domain ? { domain: item.domain } : {}),
      };
      if (!item.domain) {
        delete next[existingIdx].domain;
      }
      delete next[existingIdx].enabled;
    } else {
      indexByKey.set(lookupKey, next.length);
      next.push({ ...item });
    }
  }

  return next;
}

export function PromptsGlossaryTab({
  draft,
  onMutate,
  registerPendingFlush,
  onEnsureSavedBeforeTest,
}: PromptsGlossaryTabProps) {
  const lang = draft.interfaceLang;

  const assistantIds = useMemo(() => {
    const allKeys = Object.keys(draft.assistants);
    const ordered: string[] = [];
    for (const builtinId of CANONICAL_BUILTIN_ORDER) {
      if (allKeys.includes(builtinId)) {
        ordered.push(builtinId);
      }
    }
    for (const key of allKeys) {
      if (!ordered.includes(key)) {
        ordered.push(key);
      }
    }
    return ordered;
  }, [draft.assistants]);

  const [selectedAstId, setSelectedAstId] = useState<string>(
    () => assistantIds[0] ?? 'builtin-yaml',
  );
  const [activePromptSlot, setActivePromptSlot] = useState<PromptSlot>('prompt');
  const [showMultiOverride, setShowMultiOverride] = useState(false);
  const [stagedPresetNotice, setStagedPresetNotice] = useState<string | null>(null);
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvVal, setNewEnvVal] = useState('');

  // Live Prompt Preview & Sample Tester state
  const [previewScene, setPreviewScene] = useState<PreviewScene>('webpage');
  const [sampleDomain, setSampleDomain] = useState<SampleDomainKey>('x.com');
  const [sampleText, setSampleText] = useState<string>(DEFAULT_PREVIEW_SAMPLE_TEXT);
  const [trialRunning, setTrialRunning] = useState(false);
  const [trialResult, setTrialResult] = useState<{
    ok: boolean;
    translation?: string;
    thinking?: string;
    model?: string;
    providerId?: string;
    latencyMs?: number;
    error?: string;
  } | null>(null);

  // Glossary Packs & Custom Glossary Manager state
  const [expandedPacks, setExpandedPacks] = useState<Record<string, boolean>>({});
  const [glossarySearch, setGlossarySearch] = useState('');
  const [bulkGlossaryText, setBulkGlossaryText] = useState(() =>
    formatGlossaryBulkText(draft.glossary),
  );
  const [bulkGlossaryNotice, setBulkGlossaryNotice] = useState<string | null>(null);

  // Persistent Translation DB status card state
  const [cacheStats, setCacheStats] = useState<{
    memoryEntries: number;
    persistentEntries: number;
    dbAvailable: boolean;
  }>({
    memoryEntries: 0,
    persistentEntries: 0,
    dbAvailable: false,
  });
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);

  const refreshCacheStats = useCallback(async () => {
    try {
      const res = await requestTranslationCacheStats();
      if (res && res.ok) {
        setCacheStats({
          memoryEntries: res.memoryEntries,
          persistentEntries: res.persistentEntries,
          dbAvailable: res.dbAvailable,
        });
      }
    } catch {
      // Ignore in standalone/non-extension test environments without runtime messaging
    }
  }, []);

  useEffect(() => {
    void refreshCacheStats();
  }, [refreshCacheStats]);

  const handleClearTranslationDb = async () => {
    setCacheBusy(true);
    try {
      await requestClearTranslationCache();
      setCacheStats((prev) => ({
        ...prev,
        memoryEntries: 0,
        persistentEntries: 0,
      }));
      await refreshCacheStats();
      setCacheNotice(
        lang === 'en'
          ? 'Cleared in-memory & IndexedDB persistent translation cache'
          : '已清空内存热缓存与本地持久化翻译数据库',
      );
    } catch {
      setCacheStats((prev) => ({
        ...prev,
        memoryEntries: 0,
        persistentEntries: 0,
      }));
      setCacheNotice(
        lang === 'en'
          ? 'Cleared translation cache'
          : '已清空翻译数据库',
      );
    } finally {
      setCacheBusy(false);
    }
  };

  const currentAstId = draft.assistants[selectedAstId]
    ? selectedAstId
    : (assistantIds[0] ?? '');
  const assistant = currentAstId ? draft.assistants[currentAstId] : undefined;
  const builtinPresetForSelected = currentAstId
    ? BUILTIN_ASSISTANTS[currentAstId]
    : undefined;

  const updateAssistant = (mutator: (ast: AssistantConfig) => void) => {
    if (!currentAstId) return;
    onMutate((d) => {
      const target = d.assistants[currentAstId];
      if (target) mutator(target);
    });
  };

  const envInputsRef = useRef({ key: newEnvKey, val: newEnvVal, astId: currentAstId });
  envInputsRef.current = { key: newEnvKey, val: newEnvVal, astId: currentAstId };

  const commitPendingEnvEntry = () => {
    const k = envInputsRef.current.key.trim();
    const v = envInputsRef.current.val;
    const targetAstId = envInputsRef.current.astId;
    if (!k || !targetAstId) return;
    onMutate((d) => {
      const target = d.assistants[targetAstId];
      if (target) {
        target.env[k] = v;
      }
    });
    envInputsRef.current.key = '';
    envInputsRef.current.val = '';
    setNewEnvKey('');
    setNewEnvVal('');
  };

  useEffect(() => {
    if (!registerPendingFlush) return;
    registerPendingFlush(() => {
      commitPendingEnvEntry();
    });
    return () => registerPendingFlush(null);
  }, [registerPendingFlush]);

  const handleAddAssistant = () => {
    const base = structuredClone(BUILTIN_ASSISTANTS['builtin-yaml']);
    const id = `custom-${Math.random().toString(36).slice(2, 8)}`;
    base.id = id;
    base.name = lang === 'en' ? 'Custom Editorial Assistant' : '自定义精译助手';
    onMutate((d) => {
      d.assistants[id] = base;
    });
    setSelectedAstId(id);
    setStagedPresetNotice(null);
  };

  const handleDeleteAssistant = (id: string) => {
    if (BUILTIN_ASSISTANTS[id] || assistantIds.length <= 1) return;
    const remaining = assistantIds.filter((item) => item !== id);
    onMutate((d) => {
      delete d.assistants[id];
      for (const p of Object.values(d.providers)) {
        if (p.assistantId === id) {
          p.assistantId = 'builtin-yaml';
        }
      }
    });
    setSelectedAstId(remaining[0] ?? 'builtin-yaml');
    setStagedPresetNotice(null);
  };

  /**
   * Stages a built-in preset into the active assistant WITHOUT auto-saving until
   * the user confirms via "Save Changes", clearing any stale `multiplePrompt` /
   * `multipleSystemPrompt` overrides!
   */
  const handleStageBuiltinReset = (
    presetKey: 'builtin-yaml' | 'builtin-yaml-thinking' | 'builtin-delimiter',
    preserveCustomName = false,
  ) => {
    if (!assistant) return;
    const template = structuredClone(BUILTIN_ASSISTANTS[presetKey]);

    updateAssistant((ast) => {
      if (!preserveCustomName) {
        ast.name = template.name;
      }
      ast.codec = template.codec;
      ast.enableRichHtml = template.enableRichHtml;
      ast.temperaturePolicy = structuredClone(template.temperaturePolicy);
      ast.maxBatchCount = template.maxBatchCount;
      ast.maxSubtitleBatchCount = template.maxSubtitleBatchCount;
      ast.maxCharsPerBatch = template.maxCharsPerBatch;
      ast.separator = template.separator;
      ast.systemPrompt = template.systemPrompt;
      ast.prompt = template.prompt;
      ast.inputPrompt = template.inputPrompt;
      ast.selectionPrompt = template.selectionPrompt;
      ast.subtitlePrompt = template.subtitlePrompt;
      if (template.multiplePrompt) {
        ast.multiplePrompt = template.multiplePrompt;
      } else {
        delete ast.multiplePrompt;
      }
      if (template.multipleSystemPrompt) {
        ast.multipleSystemPrompt = template.multipleSystemPrompt;
      } else {
        delete ast.multipleSystemPrompt;
      }
      ast.env = structuredClone(template.env);
    });

    setShowMultiOverride(false);
    setStagedPresetNotice(
      lang === 'en'
        ? `Reset to "${template.name}" in draft. Click "Save Changes" in the header to persist.`
        : `已载入内置预设「${template.name}」草稿（未自动保存，点击顶部「保存设置」确认后正式生效）。`,
    );
  };

  const handleInsertVariable = (token: string) => {
    if (!assistant) return;
    updateAssistant((ast) => {
      const prev = ast[activePromptSlot] ?? '';
      const next = prev ? `${prev}${token}` : token;
      if (activePromptSlot === 'prompt' && ast.multiplePrompt === prev && prev !== '') {
        ast.multiplePrompt = next;
      }
      ast[activePromptSlot] = next;
    });
  };

  const effectiveGlossary = useMemo(
    () => resolveEffectiveGlossary(draft),
    [draft.glossary, draft.enabledGlossaryPacks],
  );

  const sampleContext: PageContextPayload | undefined = useMemo(
    () => (sampleDomain === 'none' ? undefined : SAMPLE_DOMAIN_CONTEXTS[sampleDomain]),
    [sampleDomain],
  );

  const matchedPreviewGlossary = useMemo(
    () =>
      matchGlossaryEntries(
        [sampleText || ''],
        effectiveGlossary,
        sampleContext?.url || sampleContext?.domain,
      ),
    [sampleText, effectiveGlossary, sampleContext],
  );

  const expandedPreview = useMemo(() => {
    if (!assistant) return null;
    return expandAssistantPrompts({
      assistant,
      scene: previewScene,
      fromLang: draft.sourceLang || 'auto',
      toLang: draft.targetLang || 'zh-CN',
      items: [{ id: 1, text: sampleText || 'Hello world' }],
      context: sampleContext,
      glossary: effectiveGlossary,
    });
  }, [
    assistant,
    previewScene,
    draft.sourceLang,
    draft.targetLang,
    sampleText,
    sampleContext,
    effectiveGlossary,
  ]);

  const activeSceneProviderId = useMemo(
    () => resolveProviderIdForScene(previewScene, draft.routing, draft.providers),
    [previewScene, draft.routing, draft.providers],
  );
  const activeSceneProvider = draft.providers[activeSceneProviderId];

  const handleRunLiveTrial = async () => {
    const trimmed = sampleText.trim();
    if (!trimmed) return;
    setTrialRunning(true);
    setTrialResult(null);
    const startedAt = performance.now();
    try {
      if (onEnsureSavedBeforeTest) {
        await onEnsureSavedBeforeTest();
      }
      const res = await requestBatchTranslation({
        requestId: `studio-trial-${Date.now()}`,
        scene: previewScene,
        providerId: activeSceneProviderId,
        fromLang: draft.sourceLang || 'auto',
        toLang: draft.targetLang || 'zh-CN',
        items: [{ id: 1, text: trimmed }],
        context: sampleContext,
      });
      const latencyMs =
        res.diagnostic?.latencyMs && res.diagnostic.latencyMs > 0
          ? res.diagnostic.latencyMs
          : Math.max(1, Math.round(performance.now() - startedAt));

      if (res.ok) {
        setTrialResult({
          ok: true,
          translation: res.items[0]?.trans ?? '',
          thinking: res.items[0]?.thinking,
          model: res.model,
          providerId: res.providerId,
          latencyMs,
        });
        void refreshCacheStats();
      } else {
        setTrialResult({
          ok: false,
          latencyMs,
          error:
            res.error?.message ||
            res.diagnostic?.sanitizedError ||
            (lang === 'en' ? 'Trial translation failed' : '在线试译请求失败'),
        });
      }
    } catch (err) {
      setTrialResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTrialRunning(false);
    }
  };

  // Enabled built-in glossary packs
  const enabledPackSet = useMemo(
    () =>
      new Set<string>(
        Array.isArray(draft.enabledGlossaryPacks)
          ? draft.enabledGlossaryPacks
          : DEFAULT_ENABLED_GLOSSARY_PACK_IDS,
      ),
    [draft.enabledGlossaryPacks],
  );

  const handleToggleGlossaryPack = (packId: string, nextEnabled: boolean) => {
    onMutate((d) => {
      const current = new Set<string>(
        Array.isArray(d.enabledGlossaryPacks)
          ? d.enabledGlossaryPacks
          : DEFAULT_ENABLED_GLOSSARY_PACK_IDS,
      );
      if (nextEnabled) {
        current.add(packId);
      } else {
        current.delete(packId);
      }
      d.enabledGlossaryPacks = BUILTIN_GLOSSARY_PACKS.map((p) => p.id).filter((id) =>
        current.has(id),
      );
    });
  };

  const filteredCustomGlossary = useMemo(() => {
    const q = glossarySearch.trim().toLowerCase();
    return draft.glossary
      .map((entry, idx) => ({ entry, idx }))
      .filter(({ entry }) => {
        if (!q) return true;
        return (
          entry.k.toLowerCase().includes(q) ||
          entry.v.toLowerCase().includes(q) ||
          (entry.domain ?? '').toLowerCase().includes(q)
        );
      });
  }, [draft.glossary, glossarySearch]);

  const codecOptions: Array<{ value: PromptCodecId; label: string }> = [
    { value: 'yaml', label: labelForCodec('yaml', lang) },
    { value: 'delimiter', label: labelForCodec('delimiter', lang) },
    { value: 'json-batch', label: labelForCodec('json-batch', lang) },
    { value: 'single-text', label: labelForCodec('single-text', lang) },
  ];

  const promptSlotOptions: Array<{
    value: PromptSlot;
    label: string;
    dataTestId: string;
  }> = [
    {
      value: 'prompt',
      label: lang === 'en' ? 'Webpage / Batch' : '网页/批量模板',
      dataTestId: 'prompt-slot-prompt',
    },
    {
      value: 'inputPrompt',
      label: lang === 'en' ? 'Input Writing' : '输入框写作',
      dataTestId: 'prompt-slot-inputPrompt',
    },
    {
      value: 'selectionPrompt',
      label: lang === 'en' ? 'Selection' : '划词精译',
      dataTestId: 'prompt-slot-selectionPrompt',
    },
    {
      value: 'subtitlePrompt',
      label: lang === 'en' ? 'Subtitles' : '视频字幕',
      dataTestId: 'prompt-slot-subtitlePrompt',
    },
    {
      value: 'systemPrompt',
      label: lang === 'en' ? 'System' : '系统指令',
      dataTestId: 'prompt-slot-systemPrompt',
    },
  ];

  const boundWebProvider = draft.providers[draft.routing.webpage];

  return (
    <div>
      {/* Section 1: Prompt Studio */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en'
                ? 'Editorial Prompt Studio & Scene Templates'
                : '提示词工作台与分场景精译助手'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Inspect and customize built-in Editorial <yaml>, Thinking <yaml>, and Streaming %% assistants across all 5 scene slots.'
                : '内置「Margin 信达雅精译」、「泛用翻译大师 · 思考精修」与「极速流式直译」三大预设，支持网页、输入框写作、划词、字幕独立定制。'}
            </p>
          </div>
          <button type="button" class="mp-btn mp-btn--solid" onClick={handleAddAssistant}>
            <Icon name="plus" size={13} />
            {lang === 'en' ? 'New Assistant' : '新建助手'}
          </button>
        </div>

        <div
          class="mp-roster-bar"
          role="tablist"
          aria-label={lang === 'en' ? 'Assistants' : '助手列表'}
        >
          {assistantIds.map((id) => {
            const ast = draft.assistants[id];
            if (!ast) return null;
            const isBoundToWebpage = boundWebProvider?.assistantId === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                data-testid={`assistant-tab-${id}`}
                class="mp-roster-tab"
                aria-selected={id === currentAstId ? 'true' : 'false'}
                onClick={() => {
                  commitPendingEnvEntry();
                  setSelectedAstId(id);
                  setStagedPresetNotice(null);
                  setShowMultiOverride(false);
                }}
              >
                <span>{ast.name}</span>
                <StatusPill tone="mono">{ast.codec}</StatusPill>
                {isBoundToWebpage ? (
                  <EditorialBadge tone="accent">
                    {lang === 'en' ? 'Active' : '当前绑定'}
                  </EditorialBadge>
                ) : null}
              </button>
            );
          })}
        </div>

        {assistant ? (
          <div>
            {/* Preset Reset / Template Loader Bar (Staged, never auto-saved) */}
            <div class="mp-row mp-row--between mp-preset-bar">
              <div class="mp-row">
                <StatusPill tone="mono">{assistant.id}</StatusPill>
                {builtinPresetForSelected ? (
                  <button
                    type="button"
                    class="mp-btn mp-btn--sm"
                    data-testid="reset-builtin-assistant-btn"
                    onClick={() =>
                      handleStageBuiltinReset(
                        assistant.id as
                          | 'builtin-yaml'
                          | 'builtin-yaml-thinking'
                          | 'builtin-delimiter',
                      )
                    }
                  >
                    {lang === 'en' ? 'Reset to Built-in Preset' : '重置为内置预设'}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      class="mp-btn mp-btn--sm"
                      data-testid="load-editorial-yaml-btn"
                      onClick={() => handleStageBuiltinReset('builtin-yaml', true)}
                    >
                      {lang === 'en'
                        ? 'Load Fast Editorial (<yaml>)'
                        : '载入「Margin 信达雅精译」模板'}
                    </button>
                    <button
                      type="button"
                      class="mp-btn mp-btn--sm"
                      data-testid="load-thinking-yaml-btn"
                      onClick={() => handleStageBuiltinReset('builtin-yaml-thinking', true)}
                    >
                      {lang === 'en'
                        ? 'Load Thinking (<yaml>)'
                        : '载入「思考精修」模板'}
                    </button>
                    <button
                      type="button"
                      class="mp-btn mp-btn--sm"
                      data-testid="load-delimiter-btn"
                      onClick={() => handleStageBuiltinReset('builtin-delimiter', true)}
                    >
                      {lang === 'en' ? 'Load Streaming (%%)' : '载入「极速 %%」模板'}
                    </button>
                  </>
                )}
              </div>

              {!builtinPresetForSelected && assistantIds.length > 1 ? (
                <button
                  type="button"
                  class="mp-btn mp-btn--danger mp-btn--sm"
                  onClick={() => handleDeleteAssistant(assistant.id)}
                >
                  {lang === 'en' ? 'Delete Assistant' : '删除自定义助手'}
                </button>
              ) : null}
            </div>

            {stagedPresetNotice ? (
              <div class="mp-editorial-note" data-testid="assistant-staged-notice">
                {stagedPresetNotice}
              </div>
            ) : null}

            <SettingGroup label={lang === 'en' ? 'Assistant Parameters' : '助手参数'}>
            <FieldRow label={lang === 'en' ? 'Assistant Name' : '助手名称'}>
              <input
                type="text"
                class="mp-input"
                style={{ minWidth: '300px' }}
                value={assistant.name}
                onInput={(e) => {
                  const val = (e.currentTarget as HTMLInputElement).value;
                  updateAssistant((ast) => {
                    ast.name = val;
                  });
                }}
              />
            </FieldRow>

            <FieldRow label={lang === 'en' ? 'Prompt Wire Codec' : '提示词协议格式 (Codec)'}>
              <SegmentedControl
                ariaLabel={lang === 'en' ? 'Prompt Codec' : '提示词协议格式'}
                options={codecOptions}
                value={assistant.codec}
                onChange={(codec) =>
                  updateAssistant((ast) => {
                    ast.codec = codec;
                  })
                }
              />
            </FieldRow>

            <FieldRow
              label={lang === 'en' ? 'Enable Rich HTML (<mN>)' : '启用富文本标签保护 (<mN>)'}
            >
              <ToggleSwitch
                ariaLabel={lang === 'en' ? 'Assistant Enable Rich HTML' : '启用富文本标签保护'}
                checked={assistant.enableRichHtml}
                onChange={(next) =>
                  updateAssistant((ast) => {
                    ast.enableRichHtml = next;
                  })
                }
              />
            </FieldRow>

            <FieldRow
              label={
                lang === 'en'
                  ? 'Batch Limits (Webpage / Subtitles / Chars)'
                  : '分批上限 (网页段落 / 独立字幕条数 / 最大字符)'
              }
              hint={
                lang === 'en'
                  ? 'Subtitle batching uses maxSubtitleBatchCount independently so cues never spill across boundaries'
                  : '视频字幕使用独立的单批条数上限 (默认 17)，与网页段落解耦防串行'
              }
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <label class="mp-inline-field">
                  {lang === 'en' ? 'Web' : '网页'}
                  <input
                    type="number"
                    class="mp-input mp-input--mono"
                    style={{ width: '64px' }}
                    min={1}
                    max={60}
                    value={assistant.maxBatchCount}
                    onInput={(e) => {
                      const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                      updateAssistant((ast) => {
                        ast.maxBatchCount = Number.isFinite(v) ? Math.max(1, v) : 17;
                      });
                    }}
                  />
                </label>

                <label class="mp-inline-field">
                  {lang === 'en' ? 'Subtitle' : '字幕'}
                  <input
                    type="number"
                    class="mp-input mp-input--mono"
                    style={{ width: '64px' }}
                    min={1}
                    max={60}
                    value={assistant.maxSubtitleBatchCount}
                    onInput={(e) => {
                      const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                      updateAssistant((ast) => {
                        ast.maxSubtitleBatchCount = Number.isFinite(v) ? Math.max(1, v) : 17;
                      });
                    }}
                  />
                </label>

                <label class="mp-inline-field">
                  {lang === 'en' ? 'Chars' : '字符'}
                  <input
                    type="number"
                    class="mp-input mp-input--mono"
                    style={{ width: '80px' }}
                    min={200}
                    max={32000}
                    value={assistant.maxCharsPerBatch}
                    onInput={(e) => {
                      const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                      updateAssistant((ast) => {
                        ast.maxCharsPerBatch = Number.isFinite(v) ? Math.max(200, v) : 4096;
                      });
                    }}
                  />
                </label>
              </div>
            </FieldRow>

            <FieldRow
              label={lang === 'en' ? 'Assistant Default Temperature' : '助手默认温度策略'}
              hint={
                lang === 'en'
                  ? 'Used on standard chat models (e.g. glm-4.7, deepseek-chat) when provider is Omit; auto-omitted on reasoning models.'
                  : '当渠道设为 Omit 时供常规对话模型继承（如 0.3）；遇到推理模型时仍会自动安全省略。'
              }
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <SegmentedControl
                  ariaLabel={lang === 'en' ? 'Assistant Temperature Policy' : '助手默认温度策略'}
                  options={[
                    { value: 'omit', label: lang === 'en' ? 'Omit' : '不发送 Omit' },
                    { value: 'custom', label: lang === 'en' ? 'Custom' : '自定义数值' },
                  ]}
                  value={assistant.temperaturePolicy.mode}
                  onChange={(mode) =>
                    updateAssistant((ast) => {
                      ast.temperaturePolicy =
                        mode === 'omit' ? { mode: 'omit' } : { mode: 'custom', value: 0.3 };
                    })
                  }
                />
                {assistant.temperaturePolicy.mode === 'custom' ? (
                  <input
                    type="number"
                    class="mp-input mp-input--mono"
                    style={{ width: '80px' }}
                    min={0}
                    max={2}
                    step={0.1}
                    value={assistant.temperaturePolicy.value}
                    onInput={(e) => {
                      const raw = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
                      updateAssistant((ast) => {
                        ast.temperaturePolicy = {
                          mode: 'custom',
                          value: Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : 0.3,
                        };
                      });
                    }}
                  />
                ) : null}
              </div>
            </FieldRow>
            </SettingGroup>

            {/* 5-Slot Scene & System Prompt Template Editor */}
            <SubHead
              title={
                <>
                  <Icon name="file" />
                  {lang === 'en'
                    ? 'Prompt Templates (5 Scene Slots)'
                    : '提示词模板编辑器（5 大场景槽位）'}
                </>
              }
            />
            <div class="mp-stack">
              <p class="mp-field-hint" style={{ margin: 0 }}>
                {activePromptSlot === 'inputPrompt'
                  ? lang === 'en'
                    ? 'Dedicated prompt for triple-space / Alt+I input-box writing & native expression polishing.'
                    : '专用于输入框三击空格 / Alt+I 快捷写作润色（保留 @提及、#标签、URL 与行内代码）。'
                  : activePromptSlot === 'selectionPrompt'
                    ? lang === 'en'
                      ? 'Dedicated prompt for text-selection popover crisp translation.'
                      : '专用于鼠标划词浮层精译（自然贴合上下文，不夹杂冗余词典解释）。'
                    : activePromptSlot === 'subtitlePrompt'
                      ? lang === 'en'
                        ? 'Dedicated prompt for video & YouTube subtitles with strict cue-boundary alignment.'
                        : '专用于视频与 YouTube 双语字幕（口语化表达、严格对齐单条时间轴不串行）。'
                      : lang === 'en'
                        ? 'Switch slots to customize scene prompts; variable chips insert into the draft.'
                        : '切换槽位分别编辑；点击变量芯片可快捷插入草稿，不会自动提交保存。'}
              </p>

              <SegmentedControl
                ariaLabel={lang === 'en' ? 'Prompt Slot' : '提示词槽位'}
                dataTestId="assistant-prompt-slot-tabs"
                options={promptSlotOptions}
                value={activePromptSlot}
                onChange={setActivePromptSlot}
              />

              <div class="mp-code-frame">
                <div class="mp-code-frame-head">
                  <span class="mp-eyebrow">
                    {promptSlotOptions.find((opt) => opt.value === activePromptSlot)?.label}
                    {' · '}
                    {activePromptSlot}
                  </span>
                  <div class="mp-chip-list">
                    {TEMPLATE_VARIABLES.map((token) => (
                      <button
                        key={token}
                        type="button"
                        class="mp-var-chip"
                        title={lang === 'en' ? `Insert ${token}` : `插入 ${token}`}
                        onClick={() => handleInsertVariable(token)}
                      >
                        <span class="mp-var-chip-plus">+</span>
                        {token}
                      </button>
                    ))}
                  </div>
                </div>

                <textarea
                  class="mp-textarea mp-textarea--mono"
                  data-testid="assistant-prompt-textarea"
                  style={{ minHeight: '150px' }}
                  placeholder={
                    activePromptSlot === 'inputPrompt' ||
                    activePromptSlot === 'selectionPrompt' ||
                    activePromptSlot === 'subtitlePrompt'
                      ? lang === 'en'
                        ? '(Empty — inherits Webpage / Batch prompt automatically)'
                        : '（留空则自动复用「网页/批量模板」）'
                      : undefined
                  }
                  value={assistant[activePromptSlot] ?? ''}
                  onInput={(e) => {
                    const val = (e.currentTarget as HTMLTextAreaElement).value;
                    updateAssistant((ast) => {
                      if (
                        activePromptSlot === 'prompt' &&
                        ast.multiplePrompt !== undefined &&
                        ast.multiplePrompt === ast.prompt
                      ) {
                        ast.multiplePrompt = val;
                      }
                      ast[activePromptSlot] = val;
                    });
                  }}
                />

                <div class="mp-code-frame-foot">
                  <span class="mp-muted mp-mono mp-tnum" style={{ fontSize: '11px' }}>
                    {(assistant[activePromptSlot] ?? '').length}
                    {lang === 'en' ? ' chars' : ' 字符'}
                  </span>
                  {activePromptSlot === 'prompt' ? (
                    <div class="mp-row mp-row--tight">
                      <button
                        type="button"
                        class="mp-btn mp-btn--ghost mp-btn--sm"
                        onClick={() => setShowMultiOverride((prev) => !prev)}
                      >
                        {assistant.multiplePrompt?.trim()
                          ? lang === 'en'
                            ? '● Custom Multi-Paragraph Override (multiplePrompt) Active'
                            : '● 已设置独立多段覆盖模板 (multiplePrompt)'
                          : lang === 'en'
                            ? '+ Optional Multi-Paragraph Override (multiplePrompt)'
                            : '+ 可选：单独覆盖多段落模板 (multiplePrompt)'}
                      </button>

                      {assistant.multiplePrompt !== undefined ? (
                        <button
                          type="button"
                          class="mp-btn mp-btn--ghost mp-btn--sm"
                          onClick={() => {
                            updateAssistant((ast) => {
                              delete ast.multiplePrompt;
                            });
                            setShowMultiOverride(false);
                          }}
                        >
                          {lang === 'en'
                            ? 'Clear Override (Reuse prompt)'
                            : '清除独立多段覆盖（统一使用 prompt）'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {activePromptSlot === 'prompt' &&
              (showMultiOverride || Boolean(assistant.multiplePrompt?.trim())) ? (
                <div class="mp-code-frame">
                  <div class="mp-code-frame-head">
                    <span class="mp-eyebrow">multiplePrompt</span>
                    <span class="mp-muted" style={{ fontSize: '11.5px' }}>
                      {lang === 'en'
                        ? 'Used for multi-paragraph batches'
                        : '多段落批量请求专用'}
                    </span>
                  </div>
                  <textarea
                    class="mp-textarea mp-textarea--mono"
                    data-testid="assistant-multiple-prompt-textarea"
                    style={{ minHeight: '96px' }}
                    placeholder={
                      lang === 'en'
                        ? '(Empty — multi-paragraph batches reuse prompt automatically)'
                        : '（留空默认复用主 prompt 模板）'
                    }
                    value={assistant.multiplePrompt ?? ''}
                    onInput={(e) => {
                      const val = (e.currentTarget as HTMLTextAreaElement).value;
                      updateAssistant((ast) => {
                        if (!val.trim()) {
                          delete ast.multiplePrompt;
                        } else {
                          ast.multiplePrompt = val;
                        }
                      });
                    }}
                  />
                </div>
              ) : null}
            </div>

            {/* Collapsible Live Prompt Preview & Sample Tester */}
            <CollapsibleSection
              dataTestId="prompt-live-preview-panel"
              defaultOpen
              icon="eye"
              title={
                lang === 'en'
                  ? 'Live Prompt Expansion Preview & Sample Tester'
                  : '实时提示词展开预览与在线试译'
              }
              meta={
                <>
                  <StatusPill tone="accent" dataTestId="preview-matched-glossary-pill">
                    {lang === 'en'
                      ? `Matched Terms: ${matchedPreviewGlossary.length}`
                      : `命中术语 ${matchedPreviewGlossary.length} 项`}
                  </StatusPill>
                  <StatusPill tone="mono">{previewScene}</StatusPill>
                </>
              }
              bodyClass="mp-stack mp-stack--loose mp-preview-body"
            >
              <div class="mp-row mp-row--between">
                <SegmentedControl
                  ariaLabel={lang === 'en' ? 'Preview Scene' : '预览场景'}
                  dataTestId="preview-scene-control"
                  options={[
                    {
                      value: 'webpage',
                      label: lang === 'en' ? 'Webpage' : '网页正文',
                      dataTestId: 'preview-scene-webpage',
                    },
                    {
                      value: 'input',
                      label: lang === 'en' ? 'Input' : '输入框写作',
                      dataTestId: 'preview-scene-input',
                    },
                    {
                      value: 'selection',
                      label: lang === 'en' ? 'Selection' : '划词精译',
                      dataTestId: 'preview-scene-selection',
                    },
                    {
                      value: 'subtitle',
                      label: lang === 'en' ? 'Subtitles' : '视频字幕',
                      dataTestId: 'preview-scene-subtitle',
                    },
                  ]}
                  value={previewScene}
                  onChange={setPreviewScene}
                />

                <label class="mp-inline-field">
                  <Icon name="globe" size={13} />
                  {lang === 'en' ? 'Sample Domain' : '模拟站点语境'}
                  <select
                    class="mp-select"
                    data-testid="preview-domain-select"
                    aria-label={lang === 'en' ? 'Sample Domain' : '模拟站点语境'}
                    value={sampleDomain}
                    onChange={(e) =>
                      setSampleDomain(
                        (e.currentTarget as HTMLSelectElement).value as SampleDomainKey,
                      )
                    }
                  >
                    <option value="x.com">x.com (Social Thread)</option>
                    <option value="github.com">github.com (PR / Docs)</option>
                    <option value="youtube.com">youtube.com (Creator Subtitles)</option>
                    <option value="arxiv.org">arxiv.org (Research Paper)</option>
                    <option value="none">
                      {lang === 'en' ? 'None (Plain Text Only)' : '无站点上下文 (纯文本)'}
                    </option>
                  </select>
                </label>
              </div>

              <div class="mp-code-frame">
                <div class="mp-code-frame-head">
                  <span class="mp-eyebrow">{lang === 'en' ? 'Sample Source' : '试译示例源文本'}</span>
                  <span class="mp-muted" style={{ fontSize: '11.5px' }}>
                    {lang === 'en'
                      ? 'Auto-injects matched glossary & domain style guide'
                      : '实时匹配保留原文词、强制译名与站点文风指南'}
                  </span>
                </div>
                <textarea
                  class="mp-textarea"
                  data-testid="preview-sample-textarea"
                  style={{ minHeight: '68px' }}
                  value={sampleText}
                  onInput={(e) =>
                    setSampleText((e.currentTarget as HTMLTextAreaElement).value)
                  }
                />
              </div>

              {expandedPreview ? (
                <div class="mp-preview-grid">
                  <div class="mp-preview-pane">
                    <div class="mp-preview-pane-head">
                      <span>System Prompt</span>
                      <span class="mp-tnum">{(expandedPreview.systemPrompt || '').length}</span>
                    </div>
                    <pre class="mp-preview-code" data-testid="preview-expanded-system">
                      {expandedPreview.systemPrompt || '(empty)'}
                    </pre>
                  </div>
                  <div class="mp-preview-pane">
                    <div class="mp-preview-pane-head">
                      <span>User Prompt</span>
                      <span class="mp-tnum">{(expandedPreview.userPrompt || '').length}</span>
                    </div>
                    <pre class="mp-preview-code" data-testid="preview-expanded-user">
                      {expandedPreview.userPrompt || '(empty)'}
                    </pre>
                  </div>
                </div>
              ) : null}

              <div class="mp-row mp-row--between">
                <span class="mp-inline-field">
                  <Icon name="route" size={13} />
                  {lang === 'en' ? 'Active channel for scene' : '当前场景生效试译渠道'}
                  <span class="mp-pill mp-pill--mono">
                    {activeSceneProvider
                      ? `${activeSceneProvider.name} · ${activeSceneProvider.model}`
                      : activeSceneProviderId}
                  </span>
                </span>

                <button
                  type="button"
                  class="mp-btn mp-btn--solid"
                  data-testid="preview-run-translate-btn"
                  disabled={trialRunning || !sampleText.trim()}
                  onClick={() => void handleRunLiveTrial()}
                >
                  <Icon name={trialRunning ? 'pulse' : 'bolt'} size={13} />
                  {trialRunning
                    ? lang === 'en'
                      ? 'Translating…'
                      : '在线试译中…'
                    : lang === 'en'
                      ? 'Live Translate Sample'
                      : '在线试译'}
                </button>
              </div>

              {trialResult ? (
                <div
                  class="mp-trial-result"
                  data-ok={trialResult.ok ? 'true' : 'false'}
                  data-testid="preview-translate-result"
                >
                  {trialResult.ok ? (
                    <>
                      <div class="mp-row">
                        <EditorialBadge tone="ok">
                          {lang === 'en' ? 'Translated' : '试译完成'} · {trialResult.latencyMs}ms
                        </EditorialBadge>
                        {trialResult.model ? (
                          <StatusPill tone="mono">{trialResult.model}</StatusPill>
                        ) : null}
                      </div>
                      <div class="mp-trial-translation">{trialResult.translation}</div>
                      {trialResult.thinking ? (
                        <div class="mp-muted mp-mono" style={{ fontSize: '11.5px' }}>
                          thinking: {trialResult.thinking}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div class="mp-row">
                      <EditorialBadge tone="danger">
                        {lang === 'en' ? 'Trial Failed' : '试译失败'}
                      </EditorialBadge>
                      <span style={{ color: 'var(--danger-ink)', fontSize: '12.5px' }}>
                        {trialResult.error}
                      </span>
                    </div>
                  )}
                </div>
              ) : null}
            </CollapsibleSection>

            {/* env Key-Value Editor — low-frequency, collapsed by default */}
            <CollapsibleSection
              quiet
              icon="layers"
              title={lang === 'en' ? 'Advanced Macro Snippets (env)' : '高级宏变量片段 (env)'}
              meta={
                <StatusPill tone="mono">
                  {lang === 'en'
                    ? `${Object.keys(assistant.env).length} items`
                    : `${Object.keys(assistant.env).length} 项`}
                </StatusPill>
              }
              bodyClass="mp-env-body"
            >
              <p class="mp-field-hint" style={{ margin: '10px 0 4px' }}>
                {lang === 'en'
                  ? 'Two-pass conditional template macros such as imt_yaml_item, title_prompt, style_prompt, glossary_prompt'
                  : '支持 imt_yaml_item、title_prompt、style_prompt、glossary_prompt 等两阶段条件展开变量（空值自动剪枝）'}
              </p>
              <div class="mp-env-list">
                {Object.entries(assistant.env).map(([envKey, envVal]) => (
                  <div key={envKey} class="mp-env-row">
                    <span class="mp-env-key" title={envKey}>
                      {envKey}
                    </span>
                    <textarea
                      class="mp-textarea mp-textarea--mono"
                      rows={envVal.includes('\n') ? Math.min(4, envVal.split('\n').length) : 1}
                      style={{
                        minHeight: envVal.includes('\n') ? '64px' : '32px',
                        padding: '5px 10px',
                      }}
                      value={envVal}
                      onInput={(e) => {
                        const nextV = (e.currentTarget as HTMLTextAreaElement).value;
                        updateAssistant((ast) => {
                          ast.env[envKey] = nextV;
                        });
                      }}
                    />
                    <button
                      type="button"
                      class="mp-icon-btn"
                      aria-label={lang === 'en' ? `Remove ${envKey}` : `删除 ${envKey}`}
                      onClick={() =>
                        updateAssistant((ast) => {
                          delete ast.env[envKey];
                        })
                      }
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                ))}
              </div>

              <div class="mp-env-row mp-env-row--new">
                <input
                  type="text"
                  class="mp-input mp-input--mono"
                  placeholder="env_key"
                  value={newEnvKey}
                  onInput={(e) => setNewEnvKey((e.currentTarget as HTMLInputElement).value)}
                />
                <input
                  type="text"
                  class="mp-input mp-input--mono"
                  placeholder="Template value..."
                  value={newEnvVal}
                  onInput={(e) => setNewEnvVal((e.currentTarget as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitPendingEnvEntry();
                    }
                  }}
                />
                <button
                  type="button"
                  class="mp-btn mp-btn--sm"
                  onClick={() => commitPendingEnvEntry()}
                >
                  <Icon name="plus" size={12} />
                  {lang === 'en' ? 'Add env' : '添加变量'}
                </button>
              </div>
            </CollapsibleSection>
          </div>
        ) : null}
      </section>

      {/* Section 2: Built-in Domain Glossary Packs + Custom Glossary Table */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en'
                ? 'Domain Glossary Packs & Custom Terms'
                : '内置领域术语包与自定义术语库'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Curated Keep-Original acronyms & exact domain mappings; custom entries override built-in packs automatically.'
                : '内置四大高频专业领域词包（保留原文缩写 + 标准译名映射）；下方自定义术语优先级更高，可按需覆盖或停用。'}
            </p>
          </div>
          <StatusPill tone="accent" dataTestId="effective-glossary-count-pill">
            {lang === 'en'
              ? `${effectiveGlossary.length} Effective Terms`
              : `当前生效 ${effectiveGlossary.length} 条术语`}
          </StatusPill>
        </div>

        {/* 2x2 Responsive Grid of Built-in Glossary Packs */}
        <div class="mp-pack-grid" data-testid="builtin-glossary-pack-grid">
          {BUILTIN_GLOSSARY_PACKS.map((pack) => {
            const enabled = enabledPackSet.has(pack.id);
            const isExpanded = Boolean(expandedPacks[pack.id]);
            const visibleEntries = isExpanded
              ? pack.entries
              : pack.entries.slice(0, 6);
            const keepCount = pack.entries.filter(
              (entry) => String(entry.v ?? '').trim() === '',
            ).length;

            return (
              <div
                key={pack.id}
                class="mp-pack-card"
                data-testid={`glossary-pack-${pack.id}`}
                data-enabled={enabled ? 'true' : 'false'}
              >
                <div class="mp-pack-head">
                  <div class="mp-stack mp-stack--tight">
                    <div class="mp-pack-title-line">
                      <span class="mp-pack-title">{pack.name}</span>
                      <StatusPill tone="accent">{pack.badge}</StatusPill>
                    </div>
                    <span class="mp-pack-count mp-tnum">
                      {lang === 'en'
                        ? `${pack.entries.length} terms · ${keepCount} keep · ${pack.entries.length - keepCount} mapped`
                        : `${pack.entries.length} 词 · 保留 ${keepCount} · 译名 ${pack.entries.length - keepCount}`}
                    </span>
                  </div>

                  <ToggleSwitch
                    ariaLabel={`${pack.name} pack`}
                    dataTestId={`glossary-pack-toggle-${pack.id}`}
                    checked={enabled}
                    onChange={(next) => handleToggleGlossaryPack(pack.id, next)}
                  />
                </div>

                <p class="mp-pack-desc">{pack.description}</p>

                <div class="mp-pack-terms">
                  {visibleEntries.map((entry) => {
                    const isKeep = String(entry.v ?? '').trim() === '';
                    return (
                      <span
                        key={entry.k}
                        class="mp-pack-term-pill"
                        data-kind={isKeep ? 'keep' : 'map'}
                      >
                        <span>{entry.k}</span>
                        <span class="mp-pack-term-target">
                          {isKeep ? (
                            lang === 'en' ? (
                              'Keep'
                            ) : (
                              '保留原文'
                            )
                          ) : (
                            <>
                              <span class="mp-visually-hidden">{'=> '}</span>
                              {entry.v}
                            </>
                          )}
                        </span>
                      </span>
                    );
                  })}
                </div>

                {pack.entries.length > 6 ? (
                  <div class="mp-pack-foot">
                    <button
                      type="button"
                      class="mp-btn mp-btn--ghost mp-btn--sm"
                      data-testid={`glossary-pack-expand-${pack.id}`}
                      aria-expanded={isExpanded ? 'true' : 'false'}
                      onClick={() =>
                        setExpandedPacks((prev) => ({
                          ...prev,
                          [pack.id]: !prev[pack.id],
                        }))
                      }
                    >
                      <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
                      {isExpanded
                        ? lang === 'en'
                          ? 'Collapse Terms'
                          : '收起术语列表'
                        : lang === 'en'
                          ? `Show All ${pack.entries.length} Terms`
                          : `展开全部 ${pack.entries.length} 项术语`}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Custom Glossary Sub-header + Search + Add */}
        <SubHead
          title={
            <>
              {lang === 'en' ? 'Custom Glossary Rules' : '自定义术语与原词保护规则'}
              <StatusPill tone="mono">{draft.glossary.length}</StatusPill>
            </>
          }
          actions={
            <>
              <input
                type="search"
                class="mp-input"
                data-testid="glossary-search-input"
                style={{ width: '220px' }}
                placeholder={
                  lang === 'en' ? 'Filter custom terms…' : '搜索源词、译词或域名…'
                }
                value={glossarySearch}
                onInput={(e) =>
                  setGlossarySearch((e.currentTarget as HTMLInputElement).value)
                }
              />
              <button
                type="button"
                class="mp-btn mp-btn--solid"
                data-testid="glossary-add-btn"
                onClick={() =>
                  onMutate((d) => {
                    d.glossary = [...d.glossary, { k: '', v: '' }];
                  })
                }
              >
                <Icon name="plus" size={13} />
                {lang === 'en' ? 'Add Term' : '添加术语'}
              </button>
            </>
          }
        />

        <div class="mp-editorial-note" style={{ marginTop: 0 }}>
          {lang === 'en'
            ? 'Tip: Leave target blank ("") for Keep-Original terms (e.g. LLM), or enter a target phrase for exact translation. Optional domain (e.g. x.com) scopes the rule to matching sites.'
            : '提示：译文留空代表「保留原文」不翻译（如 LLM）；填写译词代表「指定译法」；可可选填写限定域名（如 x.com）。停用某条自定义词条也会同步屏蔽同名内置词条。'}
        </div>

        <div class="mp-card mp-glossary-card">
          {filteredCustomGlossary.length > 0 ? (
            <div class="mp-glossary-head" aria-hidden="true">
              <span />
              <span>{lang === 'en' ? 'Source' : '源词'}</span>
              <span style={{ textAlign: 'center' }}>{lang === 'en' ? 'Type' : '类型'}</span>
              <span>{lang === 'en' ? 'Target' : '译词'}</span>
              <span>{lang === 'en' ? 'Domain' : '限定域名'}</span>
              <span />
            </div>
          ) : null}

          <div class="mp-flat-list" data-testid="custom-glossary-list">
            {filteredCustomGlossary.length === 0 ? (
              <EmptyState
                title={
                  glossarySearch.trim()
                    ? lang === 'en'
                      ? 'No matching terms'
                      : '没有匹配的自定义术语'
                    : lang === 'en'
                      ? 'No custom terms yet'
                      : '还没有自定义术语'
                }
              >
                {glossarySearch.trim()
                  ? lang === 'en'
                    ? 'Try a different source term, target, or domain.'
                    : '换个源词、译词或域名试试。'
                  : lang === 'en'
                    ? 'Built-in packs above are already active. Add a term to override them.'
                    : '上方内置术语包已生效；添加术语即可覆盖或补充。'}
              </EmptyState>
            ) : null}

            {filteredCustomGlossary.map(({ entry: item, idx }) => {
              const isKeepOriginal = String(item.v ?? '').trim() === '';
              const isEntryEnabled = item.enabled !== false;

              return (
                <div
                  key={idx}
                  class="mp-glossary-row"
                  data-testid={`glossary-row-${idx}`}
                  data-enabled={isEntryEnabled ? 'true' : 'false'}
                  style={{ opacity: isEntryEnabled ? 1 : 0.55 }}
                >
                  <ToggleSwitch
                    ariaLabel={
                      lang === 'en'
                        ? `Enable term ${item.k || idx}`
                        : `启用术语 ${item.k || idx}`
                    }
                    dataTestId={`glossary-item-toggle-${idx}`}
                    checked={isEntryEnabled}
                    onChange={(next) =>
                      onMutate((d) => {
                        const row = d.glossary[idx];
                        if (!row) return;
                        if (next) {
                          delete row.enabled;
                        } else {
                          row.enabled = false;
                        }
                      })
                    }
                  />

                  <input
                    type="text"
                    class="mp-input mp-input--mono"
                    placeholder={lang === 'en' ? 'Source term (e.g. LLM)' : '源词 (如 LLM)'}
                    value={item.k}
                    onInput={(e) => {
                      const val = (e.currentTarget as HTMLInputElement).value;
                      onMutate((d) => {
                        if (d.glossary[idx]) d.glossary[idx].k = val;
                      });
                    }}
                  />

                  <StatusPill tone={isKeepOriginal ? 'neutral' : 'accent'}>
                    {isKeepOriginal
                      ? lang === 'en'
                        ? 'Keep Original'
                        : '保留原文'
                      : lang === 'en'
                        ? 'Mapped'
                        : '指定译法'}
                  </StatusPill>

                  <input
                    type="text"
                    class="mp-input"
                    placeholder={
                      lang === 'en'
                        ? 'Keep original untranslated (leave empty)'
                        : '留空 = 保留原文不翻译'
                    }
                    value={item.v}
                    onInput={(e) => {
                      const val = (e.currentTarget as HTMLInputElement).value;
                      onMutate((d) => {
                        if (d.glossary[idx]) d.glossary[idx].v = val;
                      });
                    }}
                  />

                  <input
                    type="text"
                    class="mp-input mp-input--mono mp-glossary-domain"
                    placeholder={lang === 'en' ? 'Domain (x.com)' : '限定域名 (如 x.com)'}
                    value={item.domain ?? ''}
                    onInput={(e) => {
                      const val = (e.currentTarget as HTMLInputElement).value;
                      onMutate((d) => {
                        if (d.glossary[idx]) {
                          if (val.trim()) {
                            d.glossary[idx].domain = val;
                          } else {
                            delete d.glossary[idx].domain;
                          }
                        }
                      });
                    }}
                  />

                  <button
                    type="button"
                    class="mp-icon-btn"
                    aria-label={`Remove term ${item.k || idx}`}
                    onClick={() =>
                      onMutate((d) => {
                        d.glossary = d.glossary.filter((_, i) => i !== idx);
                      })
                    }
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Collapsible Bulk Text Import / Export */}
        <CollapsibleSection
          quiet
          icon="upload"
          dataTestId="glossary-bulk-panel"
          title={
            lang === 'en'
              ? 'Bulk Text Import / Export (source = target or bare Keep-Original)'
              : '批量文本导入 / 导出（源词 = 译词 或单行保留原文）'
          }
          bodyClass="mp-stack mp-bulk-body"
        >
          <p class="mp-field-hint" style={{ margin: 0 }}>
            {lang === 'en'
              ? 'Format: one entry per line — `Context Window = 上下文窗口`, `Phantom Blade Zero => 影之刃零`, or bare `LLM` to keep original. Optional `@x.com` suffix scopes domain.'
              : '支持每行一条：`Context Window = 上下文窗口`、`Phantom Blade Zero => 影之刃零`，或单写 `LLM` 表示保留原文；末尾可加 `@x.com` 限定域名。'}
          </p>

          <div class="mp-code-frame">
            <textarea
              class="mp-textarea mp-textarea--mono"
              data-testid="glossary-bulk-textarea"
              style={{ minHeight: '120px' }}
              placeholder={'LLM\nContext Window = 上下文窗口\nParry = 弹反 @x.com'}
              value={bulkGlossaryText}
              onInput={(e) =>
                setBulkGlossaryText((e.currentTarget as HTMLTextAreaElement).value)
              }
            />
          </div>

          <div class="mp-row">
            <button
              type="button"
              class="mp-btn mp-btn--solid mp-btn--sm"
              data-testid="glossary-bulk-import-btn"
              onClick={() => {
                const parsed = parseGlossaryBulkText(bulkGlossaryText);
                onMutate((d) => {
                  d.glossary = mergeBulkGlossaryEntries(d.glossary, parsed);
                });
                setBulkGlossaryNotice(
                  lang === 'en'
                    ? `Merged ${parsed.length} term(s) into draft`
                    : `已合并导入 ${parsed.length} 条术语至草稿（点击顶部「保存设置」持久化）`,
                );
              }}
            >
              {lang === 'en' ? 'Merge Import into Custom Terms' : '合并导入至自定义术语'}
            </button>

            <button
              type="button"
              class="mp-btn mp-btn--sm"
              data-testid="glossary-bulk-replace-btn"
              onClick={() => {
                const parsed = parseGlossaryBulkText(bulkGlossaryText);
                onMutate((d) => {
                  d.glossary = parsed;
                });
                setBulkGlossaryNotice(
                  lang === 'en'
                    ? `Replaced custom glossary with ${parsed.length} term(s)`
                    : `已用 ${parsed.length} 条批量规则替换自定义术语`,
                );
              }}
            >
              {lang === 'en' ? 'Replace All Custom Terms' : '覆盖替换自定义术语'}
            </button>

            <button
              type="button"
              class="mp-btn mp-btn--sm"
              data-testid="glossary-bulk-export-btn"
              onClick={() => {
                const formatted = formatGlossaryBulkText(draft.glossary);
                setBulkGlossaryText(formatted);
                setBulkGlossaryNotice(
                  lang === 'en'
                    ? 'Exported active custom terms to text box above'
                    : '已将当前启用的自定义术语导出至上方文本框',
                );
              }}
            >
              <Icon name="download" size={12} />
              {lang === 'en' ? 'Export Current Terms to Text' : '从当前自定义术语导出文本'}
            </button>

            {bulkGlossaryNotice ? (
              <EditorialBadge tone="ok" dataTestId="glossary-bulk-notice">
                {bulkGlossaryNotice}
              </EditorialBadge>
            ) : null}
          </div>
        </CollapsibleSection>
      </section>

      {/* Section 3: Persistent Local Translation Database Status Card */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en'
                ? 'Persistent Local Translation Database'
                : '本地持久化翻译数据库 (2-Tier Cache)'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? '2-tier memory LRU + IndexedDB persistent cache keyed by model, prompt fingerprint, and matched glossary signature.'
                : '二级内存热缓存 + IndexedDB 本地持久化译文库，按模型、提示词指纹与实际命中的术语签名精准索引，重启浏览器秒开复用。'}
            </p>
          </div>
          <EditorialBadge tone={cacheStats.dbAvailable ? 'ok' : 'neutral'}>
            {cacheStats.dbAvailable
              ? lang === 'en'
                ? 'IndexedDB Ready'
                : 'IndexedDB 已就绪'
              : lang === 'en'
                ? 'Memory Only'
                : '内存缓存模式'}
          </EditorialBadge>
        </div>

        <div class="mp-db-card" data-testid="translation-db-card">
          <div class="mp-metric-grid" aria-hidden="true">
            <Metric
              icon="bolt"
              label={lang === 'en' ? 'L1 · Memory hot cache' : 'L1 · 内存热缓存'}
              value={cacheStats.memoryEntries.toLocaleString()}
              unit={lang === 'en' ? 'entries' : '条'}
              caption={lang === 'en' ? 'LRU, cleared on restart' : 'LRU，浏览器重启即清空'}
            />
            <Metric
              icon="database"
              label={lang === 'en' ? 'L2 · IndexedDB' : 'L2 · 本地持久化库'}
              value={cacheStats.persistentEntries.toLocaleString()}
              unit={lang === 'en' ? 'entries' : '条'}
              caption={
                cacheStats.dbAvailable
                  ? lang === 'en'
                    ? 'Survives restarts · instant reuse'
                    : '跨重启保留 · 秒开复用'
                  : lang === 'en'
                    ? 'Unavailable in this context'
                    : '当前环境不可用'
              }
            />
          </div>

          <div class="mp-db-card-foot">
            <div class="mp-stack mp-stack--tight">
              <strong class="mp-db-summary" data-testid="translation-db-stats">
                {lang === 'en'
                  ? `Memory Hot Cache ${cacheStats.memoryEntries} · Persistent DB ${cacheStats.persistentEntries} (IndexedDB)`
                  : `内存热缓存 ${cacheStats.memoryEntries} 条 · 本地持久化库 ${cacheStats.persistentEntries} 条 (IndexedDB)`}
              </strong>
              {cacheNotice ? (
                <span class="mp-muted" style={{ fontSize: '12px' }} data-testid="translation-db-notice">
                  {cacheNotice}
                </span>
              ) : null}
            </div>

            <div class="mp-row">
              <button
                type="button"
                class="mp-btn mp-btn--sm"
                data-testid="translation-db-refresh-btn"
                disabled={cacheBusy}
                onClick={() => void refreshCacheStats()}
              >
                <Icon name="refresh" size={12} />
                {lang === 'en' ? 'Refresh' : '刷新'}
              </button>
              <button
                type="button"
                class="mp-btn mp-btn--danger mp-btn--sm"
                data-testid="translation-db-clear-btn"
                disabled={cacheBusy}
                onClick={() => void handleClearTranslationDb()}
              >
                <Icon name="trash" size={12} />
                {lang === 'en' ? 'Clear Translation Database' : '清空翻译数据库'}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
