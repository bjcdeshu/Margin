import { useEffect, useRef, useState } from 'preact/hooks';
import { BUILTIN_ASSISTANTS } from '@shared/constants';
import type {
  AssistantConfig,
  MarginConfig,
  PromptCodecId,
} from '@shared/types';
import {
  FieldRow,
  SegmentedControl,
  StatusPill,
  ToggleSwitch,
  labelForCodec,
} from '../../components';

export interface PromptsGlossaryTabProps {
  draft: MarginConfig;
  onMutate: (mutator: (next: MarginConfig) => void) => void;
  registerPendingFlush?: (fn: (() => void) | null) => void;
}

type PromptSlot =
  | 'systemPrompt'
  | 'prompt'
  | 'multiplePrompt'
  | 'subtitlePrompt';

const TEMPLATE_VARIABLES = [
  '{{to}}',
  '{{yaml}}',
  '{{text}}',
  '{{title_prompt}}',
  '{{summary_prompt}}',
  '{{terms_prompt}}',
] as const;

export function PromptsGlossaryTab({
  draft,
  onMutate,
  registerPendingFlush,
}: PromptsGlossaryTabProps) {
  const lang = draft.interfaceLang;
  const assistantIds = Object.keys(draft.assistants);

  const [selectedAstId, setSelectedAstId] = useState<string>(
    () => assistantIds[0] ?? 'builtin-yaml',
  );
  const [activePromptSlot, setActivePromptSlot] = useState<PromptSlot>('systemPrompt');
  const [stagedPresetNotice, setStagedPresetNotice] = useState<string | null>(null);
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvVal, setNewEnvVal] = useState('');

  const currentAstId = draft.assistants[selectedAstId]
    ? selectedAstId
    : (assistantIds[0] ?? '');
  const assistant = currentAstId ? draft.assistants[currentAstId] : undefined;

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
    base.name = lang === 'en' ? 'Custom Assistant' : '自定义翻译助手';
    onMutate((d) => {
      d.assistants[id] = base;
    });
    setSelectedAstId(id);
    setStagedPresetNotice(null);
  };

  const handleDeleteAssistant = (id: string) => {
    if (assistantIds.length <= 1) return;
    const remaining = assistantIds.filter((item) => item !== id);
    onMutate((d) => {
      delete d.assistants[id];
      for (const p of Object.values(d.providers)) {
        if (p.assistantId === id) {
          delete p.assistantId;
        }
      }
    });
    setSelectedAstId(remaining[0] ?? '');
    setStagedPresetNotice(null);
  };

  /**
   * Loads built-in Aloxaf "泛用翻译大师" (<yaml>) or "通用翻译" (%%) into the draft
   * WITHOUT auto-saving until the user confirms via Save, and explicitly clears any
   * stale imported `multiplePrompt` / `multipleSystemPrompt` overrides!
   */
  const handleStageBuiltinReset = (presetKey: 'builtin-yaml' | 'builtin-delimiter') => {
    if (!assistant) return;
    const template = structuredClone(BUILTIN_ASSISTANTS[presetKey]);
    const displayName =
      presetKey === 'builtin-yaml' ? '泛用翻译大师 (Aloxaf <yaml>)' : '通用翻译 (%%)';

    updateAssistant((ast) => {
      ast.name = displayName;
      ast.codec = template.codec;
      ast.enableRichHtml = template.enableRichHtml;
      ast.temperaturePolicy = structuredClone(template.temperaturePolicy);
      ast.maxBatchCount = template.maxBatchCount;
      ast.maxSubtitleBatchCount = template.maxSubtitleBatchCount;
      ast.maxCharsPerBatch = template.maxCharsPerBatch;
      ast.separator = template.separator;
      ast.systemPrompt = template.systemPrompt;
      ast.prompt = template.prompt;
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

    setStagedPresetNotice(
      lang === 'en'
        ? `Loaded "${displayName}" into draft. Click "Save Changes" in the header to confirm and persist.`
        : `已载入预设「${displayName}」草稿（未自动保存，点击顶部「保存设置」确认后正式生效）。`,
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

  const codecOptions: Array<{ value: PromptCodecId; label: string }> = [
    { value: 'yaml', label: labelForCodec('yaml', lang) },
    { value: 'delimiter', label: labelForCodec('delimiter', lang) },
    { value: 'json-batch', label: labelForCodec('json-batch', lang) },
    { value: 'single-text', label: labelForCodec('single-text', lang) },
  ];

  return (
    <div>
      {/* Section 1: Custom Assistants Editor */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Custom AI Prompt Assistants' : '自定义提示词助手 (Custom Assistants)'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Pluggable codecs (<yaml>, %%, JSON, Single) keep full compatibility with Aloxaf YAML & streaming prompts.'
                : '可插拔编码器完整兼容 Aloxaf「泛用翻译大师」<yaml> 结构化输出与 %% 流式分隔符。'}
            </p>
          </div>
          <button type="button" class="mp-btn mp-btn--solid" onClick={handleAddAssistant}>
            + {lang === 'en' ? 'New Assistant' : '新建助手'}
          </button>
        </div>

        <div class="mp-roster-bar" role="tablist" aria-label={lang === 'en' ? 'Assistants' : '助手列表'}>
          {assistantIds.map((id) => {
            const ast = draft.assistants[id];
            if (!ast) return null;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                class="mp-roster-tab"
                aria-selected={id === currentAstId ? 'true' : 'false'}
                onClick={() => {
                  commitPendingEnvEntry();
                  setSelectedAstId(id);
                  setStagedPresetNotice(null);
                }}
              >
                <span>{ast.name}</span>
                <StatusPill tone="mono">{ast.codec}</StatusPill>
              </button>
            );
          })}
        </div>

        {assistant ? (
          <div>
            {/* Preset Reset Actions (Staged, never auto-saved) */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                paddingBottom: '12px',
                borderBottom: '1px solid var(--rule-soft)',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  class="mp-btn mp-btn--sm"
                  data-testid="reset-aloxaf-yaml-btn"
                  onClick={() => handleStageBuiltinReset('builtin-yaml')}
                >
                  {lang === 'en'
                    ? 'Reset to Aloxaf "泛用翻译大师" (<yaml>)'
                    : '重置为内置「泛用翻译大师」(<yaml>)'}
                </button>
                <button
                  type="button"
                  class="mp-btn mp-btn--sm"
                  data-testid="reset-delimiter-btn"
                  onClick={() => handleStageBuiltinReset('builtin-delimiter')}
                >
                  {lang === 'en'
                    ? 'Reset to "通用翻译" (%%)'
                    : '重置为内置「通用翻译」(%%)'}
                </button>
              </div>

              {assistantIds.length > 1 ? (
                <button
                  type="button"
                  class="mp-btn mp-btn--danger mp-btn--sm"
                  onClick={() => handleDeleteAssistant(assistant.id)}
                >
                  {lang === 'en' ? 'Delete Assistant' : '删除助手'}
                </button>
              ) : null}
            </div>

            {stagedPresetNotice ? (
              <div class="mp-editorial-note" data-testid="assistant-staged-notice">
                {stagedPresetNotice}
              </div>
            ) : null}

            <FieldRow label={lang === 'en' ? 'Assistant Name' : '助手名称'}>
              <input
                type="text"
                class="mp-input"
                style={{ minWidth: '340px' }}
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

            <FieldRow label={lang === 'en' ? 'Enable Rich HTML (<mN>)' : '启用富文本标签保护 (<mN>)'}>
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
                <label class="mp-muted" style={{ fontSize: '12px' }}>
                  {lang === 'en' ? 'Web' : '网页'}
                  <input
                    type="number"
                    class="mp-input mp-input--mono"
                    style={{ width: '68px', marginLeft: '4px' }}
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

                <label class="mp-muted" style={{ fontSize: '12px' }}>
                  {lang === 'en' ? 'Subtitle' : '字幕'}
                  <input
                    type="number"
                    class="mp-input mp-input--mono"
                    style={{ width: '68px', marginLeft: '4px' }}
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

                <label class="mp-muted" style={{ fontSize: '12px' }}>
                  {lang === 'en' ? 'Chars' : '字符'}
                  <input
                    type="number"
                    class="mp-input mp-input--mono"
                    style={{ width: '84px', marginLeft: '4px' }}
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

            {/* Segmented Prompt Editor (System / User / Multi-Batch / Subtitle) */}
            <FieldRow
              stacked
              label={lang === 'en' ? 'Prompt Templates' : '提示词模板编辑器'}
              hint={
                activePromptSlot === 'multiplePrompt'
                  ? lang === 'en'
                    ? 'Optional multi-paragraph override; leave blank to automatically reuse prompt.'
                    : '多段并发覆盖模板；留空则多段落批次自动复用主 prompt 模板。'
                  : lang === 'en'
                    ? 'Inserting variables modifies the draft only and does not auto-submit.'
                    : '切换模板槽位编辑；点击下方变量芯片可快捷插入，不会自动提交保存。'
              }
            >
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                  <SegmentedControl
                    ariaLabel={lang === 'en' ? 'Prompt Slot' : '提示词槽位'}
                    options={[
                      { value: 'systemPrompt', label: 'systemPrompt' },
                      { value: 'prompt', label: 'prompt' },
                      { value: 'multiplePrompt', label: 'multiplePrompt' },
                      { value: 'subtitlePrompt', label: 'subtitlePrompt' },
                    ]}
                    value={activePromptSlot}
                    onChange={setActivePromptSlot}
                  />

                  <div class="mp-chip-list">
                    {TEMPLATE_VARIABLES.map((token) => (
                      <button
                        key={token}
                        type="button"
                        class="mp-btn mp-btn--sm mp-mono"
                        onClick={() => handleInsertVariable(token)}
                      >
                        +{token}
                      </button>
                    ))}
                  </div>
                </div>

                <textarea
                  class="mp-textarea mp-textarea--mono"
                  data-testid="assistant-prompt-textarea"
                  style={{ minHeight: '132px' }}
                  placeholder={
                    activePromptSlot === 'multiplePrompt'
                      ? lang === 'en'
                        ? '(Empty — inherits prompt automatically)'
                        : '（留空默认复用 prompt 模板）'
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
                      if (activePromptSlot === 'multiplePrompt' && !val.trim()) {
                        delete ast.multiplePrompt;
                      } else {
                        ast[activePromptSlot] = val;
                      }
                    });
                  }}
                />
              </div>
            </FieldRow>

            {/* env Key-Value Editor */}
            <FieldRow
              stacked
              label={lang === 'en' ? 'Environment Macros (env)' : '环境变量宏片段 (env 键值表)'}
              hint={
                lang === 'en'
                  ? 'Two-pass template macros such as imt_yaml_item, title_prompt, terms_prompt'
                  : '支持 imt_yaml_item、title_prompt、terms_prompt 等两阶段条件展开变量'
              }
            >
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {Object.entries(assistant.env).map(([envKey, envVal]) => (
                  <div
                    key={envKey}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}
                  >
                    <span
                      class="mp-chip"
                      style={{ minWidth: '168px', justifyContent: 'space-between' }}
                    >
                      {envKey}
                    </span>
                    <textarea
                      class="mp-textarea mp-textarea--mono"
                      rows={envVal.includes('\n') ? Math.min(4, envVal.split('\n').length) : 1}
                      style={{
                        flex: 1,
                        minHeight: envVal.includes('\n') ? '64px' : '34px',
                        padding: '6px 10px',
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
                      class="mp-btn mp-btn--ghost mp-btn--sm"
                      onClick={() =>
                        updateAssistant((ast) => {
                          delete ast.env[envKey];
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}

                <div style={{ display: 'flex', gap: '8px', paddingTop: '4px' }}>
                  <input
                    type="text"
                    class="mp-input mp-input--mono"
                    style={{ width: '168px' }}
                    placeholder="env_key"
                    value={newEnvKey}
                    onInput={(e) => setNewEnvKey((e.currentTarget as HTMLInputElement).value)}
                  />
                  <input
                    type="text"
                    class="mp-input mp-input--mono"
                    style={{ flex: 1 }}
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
                    + {lang === 'en' ? 'Add env' : '添加变量'}
                  </button>
                </div>
              </div>
            </FieldRow>
          </div>
        ) : null}
      </section>

      {/* Section 2: Glossary Editor */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Glossary & Keep-Original Terms' : '术语库与专有名词保护 (Glossary)'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Empty target value ("") = preserve source token untranslated, e.g. LLM, LLMs.'
                : '译文留空 = 保留原文不翻译，如 LLM、LLMs（同时对 AI 渠道与 DeepLX/Google 生效）。'}
            </p>
          </div>
          <button
            type="button"
            class="mp-btn mp-btn--solid"
            onClick={() =>
              onMutate((d) => {
                d.glossary = [...d.glossary, { k: '', v: '' }];
              })
            }
          >
            + {lang === 'en' ? 'Add Term' : '添加术语'}
          </button>
        </div>

        <div class="mp-editorial-note">
          {lang === 'en'
            ? 'Tip: Leave the right-hand translation field blank to lock technical acronyms (such as LLM, CUDA, LoRA) in their original English spelling.'
            : '提示：右侧译文留空即代表「保留原文不翻译，如 LLM」，无需重复填写相同英文。'}
        </div>

        <div class="mp-flat-list">
          {draft.glossary.map((item, idx) => (
            <div key={idx} class="mp-flat-item">
              <input
                type="text"
                class="mp-input mp-input--mono"
                style={{ flex: '1 1 160px' }}
                placeholder={lang === 'en' ? 'Source term (e.g. LLM)' : '源词 (如 LLM)'}
                value={item.k}
                onInput={(e) => {
                  const val = (e.currentTarget as HTMLInputElement).value;
                  onMutate((d) => {
                    if (d.glossary[idx]) d.glossary[idx].k = val;
                  });
                }}
              />
              <span class="mp-muted">→</span>
              <input
                type="text"
                class="mp-input"
                style={{ flex: '1 1 200px' }}
                placeholder={
                  lang === 'en'
                    ? 'Keep original untranslated (leave empty)'
                    : '保留原文不翻译，如 LLM (留空即可)'
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
                class="mp-input mp-input--mono"
                style={{ width: '140px' }}
                placeholder={lang === 'en' ? 'Domain (optional)' : '限定域名 (可选)'}
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
                class="mp-btn mp-btn--ghost mp-btn--sm"
                aria-label={`Remove term ${item.k || idx}`}
                onClick={() =>
                  onMutate((d) => {
                    d.glossary = d.glossary.filter((_, i) => i !== idx);
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
