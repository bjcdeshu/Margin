import {
  SUPPORTED_LANGUAGES,
  resolveProviderIdForScene,
} from '@shared/constants';
import type {
  AutoTranslateMode,
  DisplayMode,
  MarginConfig,
  TranslationScene,
  TranslationTheme,
  UiColorMode,
} from '@shared/types';
import {
  FieldRow,
  SegmentedControl,
  StatusPill,
  ToggleSwitch,
  describeAutoTranslateMode,
  formatLanguageOption,
  labelForAutoTranslateMode,
  labelForColorMode,
  labelForDisplayMode,
  labelForScene,
  labelForTheme,
} from '../../components';

export interface GeneralTabProps {
  draft: MarginConfig;
  onMutate: (mutator: (next: MarginConfig) => void) => void;
}

const SCENES_ORDER: readonly TranslationScene[] = [
  'webpage',
  'input',
  'subtitle',
  'hover',
  'selection',
  'pdf',
  'image',
];

export function GeneralTab({ draft, onMutate }: GeneralTabProps) {
  const lang = draft.interfaceLang;

  const orderedProviders = draft.providerOrder
    .map((id) => draft.providers[id])
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  const fallbackProviders =
    orderedProviders.length > 0 ? orderedProviders : Object.values(draft.providers);

  const targetLangOptions = SUPPORTED_LANGUAGES.filter((l) => l.code !== 'auto');

  const colorModeOptions: Array<{ value: UiColorMode; label: string }> = [
    { value: 'paper', label: labelForColorMode('paper', lang) },
    { value: 'night', label: labelForColorMode('night', lang) },
    { value: 'system', label: labelForColorMode('system', lang) },
  ];

  const displayModeOptions: Array<{ value: DisplayMode; label: string }> = [
    { value: 'bilingual', label: labelForDisplayMode('bilingual', lang) },
    { value: 'target-only', label: labelForDisplayMode('target-only', lang) },
  ];

  const themeOptions: Array<{ value: TranslationTheme; label: string }> = [
    { value: 'none', label: labelForTheme('none', lang) },
    { value: 'mask', label: labelForTheme('mask', lang) },
    { value: 'opacity', label: labelForTheme('opacity', lang) },
    { value: 'weakening', label: labelForTheme('weakening', lang) },
  ];

  const currentAutoMode: AutoTranslateMode =
    draft.webpage.autoTranslateMode ??
    (draft.webpage.autoTranslateMatches ? 'whitelist' : 'off');

  const autoTranslateOptions: Array<{
    value: AutoTranslateMode;
    label: string;
    dataTestId: string;
  }> = [
    {
      value: 'foreign',
      label: labelForAutoTranslateMode('foreign', lang),
      dataTestId: 'general-auto-mode-foreign',
    },
    {
      value: 'whitelist',
      label: labelForAutoTranslateMode('whitelist', lang),
      dataTestId: 'general-auto-mode-whitelist',
    },
    {
      value: 'off',
      label: labelForAutoTranslateMode('off', lang),
      dataTestId: 'general-auto-mode-off',
    },
  ];

  return (
    <div>
      {/* Section 1 (Primary): Webpage Reading Experience & Languages */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Webpage Bilingual Reading' : '网页双语阅读与语言'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Core target language, bilingual typography, and controlled <mN> rich-text protection for daily reading.'
                : '日常网页、PDF、字幕与图片翻译的核心语言及排版样式，默认安全保护内联超链接与数学公式。'}
            </p>
          </div>
        </div>

        <FieldRow
          label={lang === 'en' ? 'Target Language' : '默认目标语言'}
          hint={lang === 'en' ? 'Primary language for webpage, PDF, subtitles & images' : '网页、PDF、视频字幕与图片翻译的目标语言'}
        >
          <select
            class="mp-select"
            aria-label={lang === 'en' ? 'Target Language' : '默认目标语言'}
            value={draft.targetLang}
            onChange={(e) => {
              const val = (e.currentTarget as HTMLSelectElement).value;
              onMutate((d) => {
                d.targetLang = val;
              });
            }}
          >
            {targetLangOptions.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {formatLanguageOption(entry.code, lang)}
              </option>
            ))}
          </select>
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Source Language' : '默认源语言'}
          hint={lang === 'en' ? 'Auto-detect recommended for mixed reading' : '日常混合语言阅读建议保持自动检测'}
        >
          <select
            class="mp-select"
            aria-label={lang === 'en' ? 'Source Language' : '默认源语言'}
            value={draft.sourceLang}
            onChange={(e) => {
              const val = (e.currentTarget as HTMLSelectElement).value;
              onMutate((d) => {
                d.sourceLang = val;
              });
            }}
          >
            {SUPPORTED_LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {formatLanguageOption(entry.code, lang)}
              </option>
            ))}
          </select>
        </FieldRow>

        <FieldRow
          stacked
          label={lang === 'en' ? 'Auto-Translate Strategy' : '自动翻译策略'}
          hint={describeAutoTranslateMode(currentAutoMode, lang)}
        >
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Auto-Translate Strategy' : '自动翻译策略'}
            dataTestId="general-auto-translate-mode"
            options={autoTranslateOptions}
            value={currentAutoMode}
            onChange={(nextMode) =>
              onMutate((d) => {
                d.webpage.autoTranslateMode = nextMode;
                d.webpage.autoTranslateMatches = nextMode !== 'off';
              })
            }
          />
        </FieldRow>

        <FieldRow label={lang === 'en' ? 'Display Mode' : '默认显示模式'}>
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Webpage Display Mode' : '默认显示模式'}
            options={displayModeOptions}
            value={draft.webpage.displayMode}
            onChange={(next) =>
              onMutate((d) => {
                d.webpage.displayMode = next;
              })
            }
          />
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Translation Style' : '译文视觉样式'}
          hint={
            lang === 'en'
              ? 'Blur Mask blurs translations until hovered or toggled via Alt+M (great for language learning)'
              : '模糊遮罩 (Mask) 默认轻度模糊译文，悬停或按 Alt+M 清晰显现，适合沉浸对照学习'
          }
        >
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Translation Style' : '译文视觉样式'}
            options={themeOptions}
            value={draft.webpage.theme}
            onChange={(next) =>
              onMutate((d) => {
                d.webpage.theme = next;
              })
            }
          />
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Preserve Rich Inline HTML & Math' : '保留富文本内联标签与公式'}
          hint={
            lang === 'en'
              ? 'Protects <a>, <strong>, <code>, and KaTeX/MathJax via <mN> tokens with automatic plain-text fallback'
              : '通过 <mN> 占位符保护超链接、加粗与行内公式；若模型偶发破坏标签仅单段优雅回退纯文本'
          }
        >
          <ToggleSwitch
            ariaLabel={lang === 'en' ? 'Enable Rich HTML' : '保留富文本内联标签与公式'}
            checked={draft.webpage.enableRichHtml}
            onChange={(next) =>
              onMutate((d) => {
                d.webpage.enableRichHtml = next;
              })
            }
          />
        </FieldRow>

        {/* Per-domain theme overrides (compact disclosure) */}
        <details
          class="mp-advanced-details"
          open={draft.webpage.themePatterns.length > 0}
        >
          <summary class="mp-advanced-summary">
            <span>
              {lang === 'en'
                ? 'Per-Site Translation Style Overrides'
                : '按站点定制译文样式 (themePatterns)'}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <StatusPill tone="mono">
                {draft.webpage.themePatterns.length}
              </StatusPill>
              <span class="mp-advanced-chevron">▸</span>
            </span>
          </summary>
          <div class="mp-advanced-body" style={{ paddingTop: '8px' }}>
            <div class="mp-flat-list">
              {draft.webpage.themePatterns.map((rule, idx) => (
                <div key={idx} class="mp-flat-item">
                  <input
                    type="text"
                    class="mp-input mp-input--mono"
                    style={{ flex: 1 }}
                    placeholder="https://arxiv.org/*"
                    value={rule.pattern}
                    onInput={(e) => {
                      const val = (e.currentTarget as HTMLInputElement).value;
                      onMutate((d) => {
                        if (d.webpage.themePatterns[idx]) {
                          d.webpage.themePatterns[idx].pattern = val;
                        }
                      });
                    }}
                  />
                  <select
                    class="mp-select"
                    value={rule.theme}
                    onChange={(e) => {
                      const val = (e.currentTarget as HTMLSelectElement).value as TranslationTheme;
                      onMutate((d) => {
                        if (d.webpage.themePatterns[idx]) {
                          d.webpage.themePatterns[idx].theme = val;
                        }
                      });
                    }}
                  >
                    {themeOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    class="mp-btn mp-btn--ghost mp-btn--sm"
                    aria-label={`Remove theme rule ${idx}`}
                    onClick={() =>
                      onMutate((d) => {
                        d.webpage.themePatterns = d.webpage.themePatterns.filter(
                          (_, i) => i !== idx,
                        );
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div style={{ paddingTop: '8px' }}>
              <button
                type="button"
                class="mp-btn mp-btn--sm"
                onClick={() =>
                  onMutate((d) => {
                    d.webpage.themePatterns = [
                      ...d.webpage.themePatterns,
                      { pattern: '', theme: 'none' },
                    ];
                  })
                }
              >
                + {lang === 'en' ? 'Add Site Style Rule' : '添加站点样式规则'}
              </button>
            </div>
          </div>
        </details>
      </section>

      {/* Section 2: Scene Routing Matrix (Primary prominent, inherited sub-scenes calm) */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Scene Channel Routing' : '分场景翻译渠道路由'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Sub-scenes set to "Follow Primary Webpage Service" automatically track your active primary channel.'
                : '子场景保持「跟随网页主服务」即可自动联动主渠道；已停用渠道会自动安全回退至可用渠道。'}
            </p>
          </div>
        </div>

        {SCENES_ORDER.map((scene) => {
          const isPrimary = scene === 'webpage';
          const rawValue = draft.routing[scene];
          const explicitProv =
            rawValue !== 'inherit' ? draft.providers[rawValue] : undefined;
          const isConfiguredDisabled = Boolean(explicitProv && !explicitProv.enabled);
          const resolvedId = resolveProviderIdForScene(
            scene,
            draft.routing,
            draft.providers,
          );
          const resolvedProvider = draft.providers[resolvedId];
          const resolvedText = resolvedProvider
            ? `→ ${resolvedProvider.name} (${resolvedProvider.model})`
            : `→ ${resolvedId}`;

          return (
            <FieldRow
              key={scene}
              label={labelForScene(scene, lang)}
              badge={
                isConfiguredDisabled ? (
                  <StatusPill
                    tone="danger"
                    dataTestId={`scene-resolved-${scene}`}
                  >
                    {lang === 'en'
                      ? `Disabled · Fallback ${resolvedText}`
                      : `已停用 · 自动回退 ${resolvedText}`}
                  </StatusPill>
                ) : isPrimary || rawValue !== 'inherit' ? (
                  <StatusPill
                    tone="accent"
                    dataTestId={`scene-resolved-${scene}`}
                  >
                    {resolvedText}
                  </StatusPill>
                ) : (
                  <span
                    class="mp-route-quiet"
                    data-testid={`scene-resolved-${scene}`}
                  >
                    {resolvedText}
                  </span>
                )
              }
              hint={
                isPrimary
                  ? lang === 'en'
                    ? 'Primary service inherited by sub-scenes below'
                    : '全局主翻译渠道，供下方「跟随网页主服务」的子场景实时继承'
                  : undefined
              }
            >
              <select
                class="mp-select"
                aria-label={`${labelForScene(scene, lang)} routing`}
                data-testid={`scene-select-${scene}`}
                value={rawValue}
                onChange={(e) => {
                  const val = (e.currentTarget as HTMLSelectElement).value;
                  onMutate((d) => {
                    if (scene === 'webpage') {
                      d.routing.webpage = val;
                    } else {
                      d.routing[scene] = val;
                    }
                  });
                }}
              >
                {!isPrimary ? (
                  <option value="inherit">
                    {lang === 'en'
                      ? 'Follow Primary Webpage Service'
                      : '跟随网页主服务'}
                  </option>
                ) : null}
                {fallbackProviders.map((prov) => (
                  <option key={prov.id} value={prov.id}>
                    {prov.name} ({prov.model})
                    {!prov.enabled
                      ? lang === 'en'
                        ? ' [Disabled]'
                        : ' [已停用]'
                      : ''}
                  </option>
                ))}
              </select>
            </FieldRow>
          );
        })}
      </section>

      {/* Section 3: Compact Studio Appearance */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Studio Appearance' : '界面外观与色彩'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Warm Paper editorial canvas synced across Popup, Options Studio, PDF Reader, and in-page popovers.'
                : '温暖纸感视觉规范统一应用于工具栏弹窗、设置工作台、双语 PDF 与页内交互卡片。'}
            </p>
          </div>
        </div>

        <FieldRow
          label={lang === 'en' ? 'Color Theme' : '工作台色彩主题'}
          hint={
            lang === 'en'
              ? 'Warm Paper (#fbfaf6), Warm Charcoal Night (#151411), or follow OS'
              : '暖纸白 (#fbfaf6)、暖炭黑夜读 (#151411) 或跟随系统深浅色'
          }
        >
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Color Theme' : '工作台色彩主题'}
            options={colorModeOptions}
            value={draft.uiColorMode}
            onChange={(next) =>
              onMutate((d) => {
                d.uiColorMode = next;
              })
            }
          />
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Interface Language' : '界面显示语言'}
          hint={lang === 'en' ? 'UI label language for Margin controls' : '设置页、弹窗与双语阅读器操作语言'}
        >
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Interface Language' : '界面显示语言'}
            options={[
              { value: 'zh-CN', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
            value={draft.interfaceLang}
            onChange={(next) =>
              onMutate((d) => {
                d.interfaceLang = next;
              })
            }
          />
        </FieldRow>
      </section>
    </div>
  );
}
