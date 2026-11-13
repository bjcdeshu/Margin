import { SUPPORTED_LANGUAGES } from '@shared/constants';
import type {
  HoverModifierKey,
  MarginConfig,
  SelectionTriggerMode,
  SubtitleStylePreset,
  SubtitleTranslationTint,
} from '@shared/types';
import {
  FieldRow,
  Icon,
  Kbd,
  SegmentedControl,
  SettingGroup,
  StatusPill,
  ToggleSwitch,
  formatLanguageOption,
  labelForSelectionMode,
} from '../../components';

export interface ScenesRulesTabProps {
  draft: MarginConfig;
  onMutate: (mutator: (next: MarginConfig) => void) => void;
}

const SUBTITLE_SCALE_PRESETS = [100, 85, 70] as const;

export function ScenesRulesTab({ draft, onMutate }: ScenesRulesTabProps) {
  const lang = draft.interfaceLang;
  const targetLangOptions = SUPPORTED_LANGUAGES.filter((l) => l.code !== 'auto');

  const selectionValue: SelectionTriggerMode = draft.selection.enabled
    ? draft.selection.triggerMode === 'off'
      ? 'icon'
      : draft.selection.triggerMode
    : 'off';

  const sourceScale = draft.subtitles.sourceScalePercent ?? 100;
  const transScale =
    draft.subtitles.translationScalePercent ?? draft.subtitles.fontSizePercent ?? 70;
  const stylePreset: SubtitleStylePreset =
    draft.subtitles.stylePreset ?? 'youtube-native';
  const bgOpacityOverride =
    typeof draft.subtitles.bgOpacityPercent === 'number'
      ? Math.max(0, Math.min(100, Math.round(draft.subtitles.bgOpacityPercent)))
      : null;
  const translationTint: SubtitleTranslationTint =
    draft.subtitles.translationTint ?? 'follow';

  const previewBgAlpha = (bgOpacityOverride ?? 75) / 100;
  const previewBgCss = `rgba(8, 8, 8, ${previewBgAlpha})`;
  const previewShadowCss =
    previewBgAlpha < 0.12
      ? '0 1px 3px rgba(0, 0, 0, 0.9), 0 0 5px rgba(0, 0, 0, 0.78)'
      : 'none';
  const previewTransFgCss =
    translationTint === 'warm-ivory'
      ? 'rgba(247, 239, 222, 0.96)'
      : translationTint === 'amber'
        ? 'rgba(255, 217, 125, 0.98)'
        : translationTint === 'cyan'
          ? 'rgba(158, 236, 255, 0.96)'
          : 'rgba(255, 255, 255, 0.95)';

  const previewSourcePx = Math.round(17 * (sourceScale / 100) * 10) / 10;
  const previewTransPx = Math.round(17 * (transScale / 100) * 10) / 10;

  const en = lang === 'en';

  const renderScalePresets = (current: number, apply: (preset: number) => void, label: string) => (
    <div class="mp-segmented mp-scale-presets" role="radiogroup" aria-label={label}>
      {SUBTITLE_SCALE_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          role="radio"
          class="mp-segmented-btn mp-tnum"
          aria-checked={current === preset ? 'true' : 'false'}
          onClick={() => apply(preset)}
        >
          {preset}%
        </button>
      ))}
    </div>
  );

  return (
    <div>
      {/* Section 1: Video Subtitles & Live 16:9 YouTube Preview Stage */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {en ? 'Video Subtitles & YouTube Bilingual PiP' : '视频双语字幕与 YouTube 画中画'}
            </h2>
            <p class="mp-section-desc">
              {en
                ? 'Hybrid YouTube caption engine: syncs native player color/opacity/edge options live while keeping independent 100% / 70% bilingual typography and PiP.'
                : '融合 YouTube 原生字幕设置（自动联动播放器 ⚙ 字幕选项的颜色、背景透明度与描边），兼顾原文 100% / 译文 70% 独立字号、防遮挡抬升与双语画中画。'}
            </p>
          </div>
        </div>

        {/* Live 16:9 Video Subtitle Preview Stage */}
        <figure class="mp-stage-figure">
          <div
            class="mp-subtitle-stage"
            data-pos={draft.subtitles.position}
            data-testid="subtitle-live-preview"
          >
            <span class="mp-subtitle-stage-badge">
              {en
                ? `16:9 Live Preview · ${sourceScale}% / ${transScale}%`
                : `16:9 实时字幕预览 · 原文 ${sourceScale}% / 译文 ${transScale}%`}
            </span>

            <div
              class="mp-subtitle-preview-stack"
              data-preset={stylePreset}
              data-testid="subtitle-preview-stack"
              style={
                {
                  '--mp-preview-bg': previewBgCss,
                  '--mp-preview-shadow': previewShadowCss,
                  '--mp-preview-trans-fg': previewTransFgCss,
                } as Record<string, string>
              }
            >
              {draft.subtitles.displayMode !== 'target-only' ? (
                <div
                  class="mp-subtitle-preview-line mp-subtitle-preview-line--src"
                  data-testid="subtitle-preview-source"
                  style={{ fontSize: `${previewSourcePx}px` }}
                >
                  <span class="margin-sub-seg">this. Let&apos;s get it.</span>
                </div>
              ) : null}
              {draft.subtitles.displayMode !== 'source-only' ? (
                <div
                  class="mp-subtitle-preview-line mp-subtitle-preview-line--trans"
                  data-testid="subtitle-preview-trans"
                  style={{ fontSize: `${previewTransPx}px` }}
                >
                  <span class="margin-sub-seg">来吧，开始！</span>
                </div>
              ) : null}
            </div>

            <div class="mp-subtitle-stage-scrubber" />
          </div>
          <figcaption class="mp-stage-caption">
            <span class="mp-row mp-row--tight">
              <Icon name="film" size={12} />
              <span>{en ? 'Rendered with your live draft' : '随当前草稿实时渲染'}</span>
            </span>
            <span class="mp-row mp-row--tight">
              <span class="mp-pill mp-pill--mono">
                {draft.subtitles.position === 'top' ? (en ? 'top' : '顶部') : en ? 'bottom' : '底部'}
              </span>
              <span class="mp-pill mp-pill--mono">{draft.subtitles.displayMode}</span>
            </span>
          </figcaption>
        </figure>

        <SettingGroup label={en ? 'Caption typography' : '字幕排版'}>
          <FieldRow
            label={en ? 'Caption Style Preset' : '字幕背景样式预设'}
            hint={
              en
                ? 'YouTube Native syncs live with YouTube ⚙ -> Subtitles -> Options (font color, opacity, edge & font)'
                : 'YouTube 原生融合会实时读取播放器「⚙ -> 字幕 -> 选项」中的字色、背景透明度、描边与字体'
            }
          >
            <SegmentedControl
              ariaLabel={en ? 'Subtitle Style Preset' : '字幕背景样式预设'}
              options={[
                {
                  value: 'youtube-native',
                  label: en ? 'YouTube Hybrid' : 'YouTube 原生融合 (推荐)',
                },
                {
                  value: 'cinema-outline',
                  label: en ? 'Cinema Outline' : '影院无底描边',
                },
                {
                  value: 'warm-paper',
                  label: en ? 'Warm Card' : '暖纸卡片',
                },
              ]}
              value={stylePreset}
              onChange={(preset: SubtitleStylePreset) =>
                onMutate((d) => {
                  d.subtitles.stylePreset = preset;
                })
              }
            />
          </FieldRow>

          {stylePreset === 'youtube-native' ? (
            <>
              <FieldRow
                label={en ? 'Background Strip Opacity' : '黑底条不透明度'}
                badge={
                  <StatusPill tone="mono">
                    {bgOpacityOverride === null
                      ? en
                        ? 'Native'
                        : '跟随原生'
                      : `${bgOpacityOverride}%`}
                  </StatusPill>
                }
                hint={
                  en
                    ? 'Follow Native inherits YouTube player caption background opacity (default 75%), or lock a custom opacity'
                    : '默认跟随 YouTube 播放器原生设置（75%），也可在此固定为半透或全透明'
                }
              >
                <SegmentedControl
                  ariaLabel={en ? 'Background Strip Opacity' : '黑底条不透明度'}
                  options={[
                    { value: 'native', label: en ? 'Follow Native' : '跟随原生' },
                    { value: '75', label: '75%' },
                    { value: '50', label: '50%' },
                    { value: '25', label: '25%' },
                    { value: '0', label: en ? '0% Clear' : '0% 透明' },
                  ]}
                  value={
                    bgOpacityOverride === null
                      ? 'native'
                      : String(bgOpacityOverride)
                  }
                  onChange={(rawVal: string) =>
                    onMutate((d) => {
                      d.subtitles.bgOpacityPercent =
                        rawVal === 'native' ? null : Number.parseInt(rawVal, 10);
                    })
                  }
                />
              </FieldRow>

              <FieldRow
                label={en ? 'Translation Line Tint' : '译文色彩区分'}
                hint={
                  en
                    ? 'Keep original and translated lines unified, or tint the secondary line for instant visual separation'
                    : '默认跟随原生字色，也可为下方译文设置柔和暖白或浅琥珀色以便一眼区分双语'
                }
              >
                <SegmentedControl
                  ariaLabel={en ? 'Translation Line Tint' : '译文色彩区分'}
                  options={[
                    { value: 'follow', label: en ? 'Follow Native' : '跟随原文' },
                    { value: 'warm-ivory', label: en ? 'Warm Ivory' : '柔和暖白' },
                    { value: 'amber', label: en ? 'Soft Amber' : '浅琥珀金' },
                    { value: 'cyan', label: en ? 'Clear Cyan' : '清透青' },
                  ]}
                  value={translationTint}
                  onChange={(tint: SubtitleTranslationTint) =>
                    onMutate((d) => {
                      d.subtitles.translationTint = tint;
                    })
                  }
                />
              </FieldRow>
            </>
          ) : null}

          <FieldRow
            label={en ? 'Original Caption Scale' : '原文字幕字号比例'}
            badge={<StatusPill tone="mono">{sourceScale}%</StatusPill>}
            hint={
              en
                ? '100% matches standard YouTube player caption sizing'
                : '100% 与 YouTube 播放器原生英文字幕标准比例一致'
            }
          >
            <div class="mp-scale-control">
              <input
                type="range"
                class="mp-range"
                data-testid="subtitle-source-scale-slider"
                aria-label={en ? 'Original Caption Scale' : '原文字幕字号比例'}
                min={50}
                max={160}
                step={5}
                value={sourceScale}
                onInput={(e) => {
                  const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                  onMutate((d) => {
                    d.subtitles.sourceScalePercent = Number.isFinite(v)
                      ? Math.max(50, Math.min(160, v))
                      : 100;
                  });
                }}
              />
              {renderScalePresets(
                sourceScale,
                (preset) =>
                  onMutate((d) => {
                    d.subtitles.sourceScalePercent = preset;
                  }),
                en ? 'Original scale presets' : '原文字号预设',
              )}
            </div>
          </FieldRow>

          <FieldRow
            label={en ? 'Translation Caption Scale' : '译文字幕字号比例'}
            badge={<StatusPill tone="mono">{transScale}%</StatusPill>}
            hint={
              en
                ? '70% keeps the secondary translation crisp without crowding video visuals'
                : '默认 70% 让译文清晰易读且不遮挡视频主体画面'
            }
          >
            <div class="mp-scale-control">
              <input
                type="range"
                class="mp-range"
                data-testid="subtitle-trans-scale-slider"
                aria-label={en ? 'Translation Caption Scale' : '译文字幕字号比例'}
                min={50}
                max={160}
                step={5}
                value={transScale}
                onInput={(e) => {
                  const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                  const clamped = Number.isFinite(v) ? Math.max(50, Math.min(160, v)) : 70;
                  onMutate((d) => {
                    d.subtitles.translationScalePercent = clamped;
                    d.subtitles.fontSizePercent = clamped;
                  });
                }}
              />
              {renderScalePresets(
                transScale,
                (preset) =>
                  onMutate((d) => {
                    d.subtitles.translationScalePercent = preset;
                    d.subtitles.fontSizePercent = preset;
                  }),
                en ? 'Translation scale presets' : '译文字号预设',
              )}
            </div>
          </FieldRow>
        </SettingGroup>

        <SettingGroup label={en ? 'Layout' : '显示与位置'}>
          <FieldRow label={en ? 'Subtitle Display Mode' : '字幕显示模式'}>
            <SegmentedControl
              ariaLabel={en ? 'Subtitle Display Mode' : '字幕显示模式'}
              options={[
                { value: 'bilingual', label: en ? 'Bilingual' : '双语字幕' },
                { value: 'target-only', label: en ? 'Target Only' : '仅译文' },
                { value: 'source-only', label: en ? 'Source Only' : '仅原文' },
              ]}
              value={draft.subtitles.displayMode}
              onChange={(mode) =>
                onMutate((d) => {
                  d.subtitles.displayMode = mode;
                })
              }
            />
          </FieldRow>

          <FieldRow label={en ? 'Subtitle Position' : '字幕纵向位置'}>
            <SegmentedControl
              ariaLabel={en ? 'Subtitle Position' : '字幕纵向位置'}
              options={[
                { value: 'bottom', label: en ? 'Bottom' : '底部' },
                { value: 'top', label: en ? 'Top' : '顶部' },
              ]}
              value={draft.subtitles.position}
              onChange={(pos) =>
                onMutate((d) => {
                  d.subtitles.position = pos;
                })
              }
            />
          </FieldRow>
        </SettingGroup>

        <SettingGroup label={en ? 'Automation' : '自动化'}>
          <FieldRow label={en ? 'Auto-Enable Video Subtitles' : '自动开启网页视频双语字幕'}>
            <ToggleSwitch
              ariaLabel={en ? 'Auto-Enable Subtitles' : '自动开启网页视频双语字幕'}
              checked={draft.subtitles.autoEnable}
              onChange={(next) =>
                onMutate((d) => {
                  d.subtitles.autoEnable = next;
                })
              }
            />
          </FieldRow>

          <FieldRow
            label={en ? 'YouTube Auto-Enable & PiP Button' : 'YouTube 自动开启双语字幕与画中画按钮'}
          >
            <ToggleSwitch
              ariaLabel={en ? 'YouTube Auto-Enable' : 'YouTube 自动开启双语字幕'}
              checked={draft.subtitles.youtubeAutoEnable}
              onChange={(next) =>
                onMutate((d) => {
                  d.subtitles.youtubeAutoEnable = next;
                })
              }
            />
          </FieldRow>

          <FieldRow
            label={en ? 'Lookahead Pre-Translation' : '时间轴前瞻预翻译'}
            hint={
              en
                ? 'Pre-translates upcoming subtitle batches ahead of the playhead for zero-lag captions'
                : '在播放指针前方提前批量预翻译后续时间轴，消除字幕等待延迟'
            }
          >
            <ToggleSwitch
              ariaLabel={en ? 'Subtitle Pre-Translation' : '时间轴前瞻预翻译'}
              checked={draft.subtitles.preTranslate}
              onChange={(next) =>
                onMutate((d) => {
                  d.subtitles.preTranslate = next;
                })
              }
            />
          </FieldRow>
        </SettingGroup>
      </section>

      {/* Section 2: Input-Box Quick Translate */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {en ? 'Input-Box Quick Translate' : '输入框快捷翻译 (三击空格 / Alt+I)'}
            </h2>
            <p class="mp-section-desc">
              {en
                ? 'Translates active <input>, <textarea>, and rich [contenteditable] editors while preserving Ctrl+Z undo.'
                : '支持网页输入框、富文本编辑器与 Shadow DOM 输入框，替换后可按 Ctrl+Z 撤销恢复原稿。'}
            </p>
          </div>
          <span class="mp-row mp-row--tight mp-row--nowrap" aria-hidden="true">
            <Kbd>Alt</Kbd>
            <Kbd>I</Kbd>
          </span>
        </div>

        <SettingGroup label={en ? 'Trigger' : '触发'}>
          <FieldRow label={en ? 'Enable Input-Box Translate' : '启用输入框快捷翻译 (Alt+I)'}>
            <ToggleSwitch
              ariaLabel={en ? 'Enable Input Translate' : '启用输入框快捷翻译'}
              checked={draft.input.enabled}
              onChange={(next) =>
                onMutate((d) => {
                  d.input.enabled = next;
                })
              }
            />
          </FieldRow>

          <FieldRow
            label={en ? 'Triple-Space Trigger' : '连按 3 次空格快捷触发'}
            hint={
              en
                ? 'Press Space 3 times rapidly in any non-empty input box to translate in place'
                : '在非空输入框内快速连击 3 次空格即可就地翻译成目标语言'
            }
          >
            <ToggleSwitch
              ariaLabel={en ? 'Triple-Space Trigger' : '连按 3 次空格快捷触发'}
              checked={draft.input.tripleSpaceTrigger}
              onChange={(next) =>
                onMutate((d) => {
                  d.input.tripleSpaceTrigger = next;
                })
              }
            />
          </FieldRow>

          <FieldRow label={en ? 'Triple-Space Window (ms)' : '三击空格识别时间窗 (毫秒)'}>
            <span class="mp-num-field">
              <input
                type="number"
                class="mp-input mp-input--mono mp-input--num"
                min={250}
                max={2000}
                step={50}
                value={draft.input.tripleSpaceWindowMs}
                onInput={(e) => {
                  const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                  onMutate((d) => {
                    d.input.tripleSpaceWindowMs = Number.isFinite(v) ? Math.max(250, v) : 650;
                  });
                }}
              />
              <span class="mp-num-unit">ms</span>
            </span>
          </FieldRow>
        </SettingGroup>

        <SettingGroup label={en ? 'Languages' : '语言'}>
          <FieldRow
            label={en ? 'Primary Input Target Language' : '输入译文目标语言'}
            hint={
              en
                ? 'When drafting Chinese on GitHub/English forums, translates into this language (default English)'
                : '在英文社区输入中文草稿时默认翻译为该语言（默认英文）'
            }
          >
            <select
              class="mp-select"
              value={draft.input.targetLang}
              onChange={(e) => {
                const val = (e.currentTarget as HTMLSelectElement).value;
                onMutate((d) => {
                  d.input.targetLang = val;
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
            label={en ? 'Fallback Target Language' : '反向回译目标语言'}
            hint={
              en
                ? 'Used when the input text is already in the primary input target language'
                : '当输入内容已是主目标语言（如英文）时，自动反向翻译为此语言'
            }
          >
            <select
              class="mp-select"
              value={draft.input.fallbackTargetLang}
              onChange={(e) => {
                const val = (e.currentTarget as HTMLSelectElement).value;
                onMutate((d) => {
                  d.input.fallbackTargetLang = val;
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
        </SettingGroup>
      </section>

      {/* Section 3: Hover & Selection */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {en ? 'Selection & Hover Translation' : '划词与悬停段落翻译'}
            </h2>
            <p class="mp-section-desc">
              {en
                ? 'Shadow-isolated lightweight paper popovers with zero side floating-ball clutter.'
                : '严格 Shadow DOM 隔离的轻量纸面气泡，不注入任何遮挡视线的侧边悬浮球。'}
            </p>
          </div>
        </div>

        <SettingGroup label={en ? 'Selection' : '划词'}>
          <FieldRow
            label={en ? 'Selection Trigger Mode' : '划词翻译触发方式'}
            hint={
              en
                ? 'Icon shows a quiet trigger badge near selected text; Off disables selection popovers'
                : '默认选中文字后浮现小巧图标点击即译；设为「关闭」可避免与外部桌面划词软件冲突'
            }
          >
            <SegmentedControl
              ariaLabel={en ? 'Selection Trigger Mode' : '划词翻译触发方式'}
              options={[
                { value: 'off', label: labelForSelectionMode('off', lang) },
                { value: 'icon', label: labelForSelectionMode('icon', lang) },
                { value: 'dot', label: labelForSelectionMode('dot', lang) },
                { value: 'instant', label: labelForSelectionMode('instant', lang) },
              ]}
              value={selectionValue}
              onChange={(mode) =>
                onMutate((d) => {
                  if (mode === 'off') {
                    d.selection.enabled = false;
                    d.selection.triggerMode = 'off';
                  } else {
                    d.selection.enabled = true;
                    d.selection.triggerMode = mode;
                  }
                })
              }
            />
          </FieldRow>
        </SettingGroup>

        <SettingGroup label={en ? 'Hover' : '悬停'}>
          <FieldRow label={en ? 'Modifier + Hover Paragraph' : '启用修饰键悬停单段翻译'}>
            <ToggleSwitch
              ariaLabel={en ? 'Enable Hover Translation' : '启用修饰键悬停单段翻译'}
              checked={draft.hover.enabled}
              onChange={(next) =>
                onMutate((d) => {
                  d.hover.enabled = next;
                })
              }
            />
          </FieldRow>

          <FieldRow label={en ? 'Hover Modifier Key' : '悬停修饰键'}>
            <SegmentedControl
              ariaLabel={en ? 'Hover Modifier Key' : '悬停修饰键'}
              options={[
                { value: 'ctrl', label: 'Ctrl' },
                { value: 'alt', label: 'Alt' },
                { value: 'shift', label: 'Shift' },
                { value: 'meta', label: 'Meta/⌘' },
                { value: 'none', label: en ? 'None' : '无修饰键' },
              ]}
              value={draft.hover.modifierKey}
              onChange={(key: HoverModifierKey) =>
                onMutate((d) => {
                  d.hover.modifierKey = key;
                })
              }
            />
          </FieldRow>

          <FieldRow label={en ? 'Hover Intent Delay (ms)' : '悬停防抖延迟 (毫秒)'}>
            <span class="mp-num-field">
              <input
                type="number"
                class="mp-input mp-input--mono mp-input--num"
                min={0}
                max={1500}
                step={20}
                value={draft.hover.delayMs}
                onInput={(e) => {
                  const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                  onMutate((d) => {
                    d.hover.delayMs = Number.isFinite(v) ? Math.max(0, v) : 180;
                  });
                }}
              />
              <span class="mp-num-unit">ms</span>
            </span>
          </FieldRow>
        </SettingGroup>
      </section>
    </div>
  );
}
