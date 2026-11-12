import { SUPPORTED_LANGUAGES } from '@shared/constants';
import type {
  HoverModifierKey,
  MarginConfig,
  SelectionTriggerMode,
  SubtitleStylePreset,
} from '@shared/types';
import {
  FieldRow,
  SegmentedControl,
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

  const previewSourcePx = Math.round(17 * (sourceScale / 100) * 10) / 10;
  const previewTransPx = Math.round(17 * (transScale / 100) * 10) / 10;

  return (
    <div>
      {/* Section 1: Video Subtitles & Live 16:9 YouTube Preview Stage */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en'
                ? 'Video Subtitles & YouTube Bilingual PiP'
                : '视频双语字幕与 YouTube 画中画'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Native YouTube per-line caption strips with independent original (100%) and translation (70%) typography.'
                : '复刻 YouTube 原生逐行黑底字幕视觉，支持原文（默认 100%）与译文（默认 70%）独立字号比例实时预览。'}
            </p>
          </div>
        </div>

        {/* Live 16:9 Video Subtitle Preview Stage */}
        <div
          class="mp-subtitle-stage"
          data-pos={draft.subtitles.position}
          data-testid="subtitle-live-preview"
        >
          <span class="mp-subtitle-stage-badge">
            {lang === 'en'
              ? `16:9 Live Preview · ${sourceScale}% / ${transScale}%`
              : `16:9 实时字幕预览 · 原文 ${sourceScale}% / 译文 ${transScale}%`}
          </span>

          <div
            class="mp-subtitle-preview-stack"
            data-preset={stylePreset}
            data-testid="subtitle-preview-stack"
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

        <FieldRow
          label={lang === 'en' ? 'Caption Style Preset' : '字幕背景样式预设'}
          hint={
            lang === 'en'
              ? 'YouTube Native uses clean per-line 75% black strips with zero outer box border'
              : 'YouTube 原生黑底采用逐行紧贴 75% 半透明黑条，无外框包裹感'
          }
        >
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Subtitle Style Preset' : '字幕背景样式预设'}
            options={[
              {
                value: 'youtube-native',
                label: lang === 'en' ? 'YouTube Native' : 'YouTube 原生黑底 (推荐)',
              },
              {
                value: 'cinema-outline',
                label: lang === 'en' ? 'Cinema Outline' : '影院无底描边',
              },
              {
                value: 'warm-paper',
                label: lang === 'en' ? 'Warm Card' : '暖纸卡片',
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

        <FieldRow
          label={lang === 'en' ? 'Original Caption Scale' : '原文字幕字号比例'}
          badge={<StatusPill tone="mono">{sourceScale}%</StatusPill>}
          hint={
            lang === 'en'
              ? '100% matches standard YouTube player caption sizing'
              : '100% 与 YouTube 播放器原生英文字幕标准比例一致'
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="range"
              class="mp-range"
              data-testid="subtitle-source-scale-slider"
              aria-label={lang === 'en' ? 'Original Caption Scale' : '原文字幕字号比例'}
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
            {SUBTITLE_SCALE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                class={
                  sourceScale === preset
                    ? 'mp-btn mp-btn--sm mp-btn--solid'
                    : 'mp-btn mp-btn--sm'
                }
                onClick={() =>
                  onMutate((d) => {
                    d.subtitles.sourceScalePercent = preset;
                  })
                }
              >
                {preset}%
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Translation Caption Scale' : '译文字幕字号比例'}
          badge={<StatusPill tone="mono">{transScale}%</StatusPill>}
          hint={
            lang === 'en'
              ? '70% keeps the secondary translation crisp without crowding video visuals'
              : '默认 70% 让译文清晰易读且不遮挡视频主体画面'
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="range"
              class="mp-range"
              data-testid="subtitle-trans-scale-slider"
              aria-label={lang === 'en' ? 'Translation Caption Scale' : '译文字幕字号比例'}
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
            {SUBTITLE_SCALE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                class={
                  transScale === preset
                    ? 'mp-btn mp-btn--sm mp-btn--solid'
                    : 'mp-btn mp-btn--sm'
                }
                onClick={() =>
                  onMutate((d) => {
                    d.subtitles.translationScalePercent = preset;
                    d.subtitles.fontSizePercent = preset;
                  })
                }
              >
                {preset}%
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow label={lang === 'en' ? 'Subtitle Display Mode' : '字幕显示模式'}>
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Subtitle Display Mode' : '字幕显示模式'}
            options={[
              { value: 'bilingual', label: lang === 'en' ? 'Bilingual' : '双语字幕' },
              { value: 'target-only', label: lang === 'en' ? 'Target Only' : '仅译文' },
              { value: 'source-only', label: lang === 'en' ? 'Source Only' : '仅原文' },
            ]}
            value={draft.subtitles.displayMode}
            onChange={(mode) =>
              onMutate((d) => {
                d.subtitles.displayMode = mode;
              })
            }
          />
        </FieldRow>

        <FieldRow label={lang === 'en' ? 'Subtitle Position' : '字幕纵向位置'}>
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Subtitle Position' : '字幕纵向位置'}
            options={[
              { value: 'bottom', label: lang === 'en' ? 'Bottom' : '底部' },
              { value: 'top', label: lang === 'en' ? 'Top' : '顶部' },
            ]}
            value={draft.subtitles.position}
            onChange={(pos) =>
              onMutate((d) => {
                d.subtitles.position = pos;
              })
            }
          />
        </FieldRow>

        <FieldRow label={lang === 'en' ? 'Auto-Enable Video Subtitles' : '自动开启网页视频双语字幕'}>
          <ToggleSwitch
            ariaLabel={lang === 'en' ? 'Auto-Enable Subtitles' : '自动开启网页视频双语字幕'}
            checked={draft.subtitles.autoEnable}
            onChange={(next) =>
              onMutate((d) => {
                d.subtitles.autoEnable = next;
              })
            }
          />
        </FieldRow>

        <FieldRow
          label={
            lang === 'en'
              ? 'YouTube Auto-Enable & PiP Button'
              : 'YouTube 自动开启双语字幕与画中画按钮'
          }
        >
          <ToggleSwitch
            ariaLabel={lang === 'en' ? 'YouTube Auto-Enable' : 'YouTube 自动开启双语字幕'}
            checked={draft.subtitles.youtubeAutoEnable}
            onChange={(next) =>
              onMutate((d) => {
                d.subtitles.youtubeAutoEnable = next;
              })
            }
          />
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Lookahead Pre-Translation' : '时间轴前瞻预翻译'}
          hint={
            lang === 'en'
              ? 'Pre-translates upcoming subtitle batches ahead of the playhead for zero-lag captions'
              : '在播放指针前方提前批量预翻译后续时间轴，消除字幕等待延迟'
          }
        >
          <ToggleSwitch
            ariaLabel={lang === 'en' ? 'Subtitle Pre-Translation' : '时间轴前瞻预翻译'}
            checked={draft.subtitles.preTranslate}
            onChange={(next) =>
              onMutate((d) => {
                d.subtitles.preTranslate = next;
              })
            }
          />
        </FieldRow>
      </section>

      {/* Section 2: Input-Box Quick Translate */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en'
                ? 'Input-Box Quick Translate'
                : '输入框快捷翻译 (三击空格 / Alt+I)'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Translates active <input>, <textarea>, and rich [contenteditable] editors while preserving Ctrl+Z undo.'
                : '支持网页输入框、富文本编辑器与 Shadow DOM 输入框，替换后可按 Ctrl+Z 撤销恢复原稿。'}
            </p>
          </div>
        </div>

        <FieldRow label={lang === 'en' ? 'Enable Input-Box Translate' : '启用输入框快捷翻译 (Alt+I)'}>
          <ToggleSwitch
            ariaLabel={lang === 'en' ? 'Enable Input Translate' : '启用输入框快捷翻译'}
            checked={draft.input.enabled}
            onChange={(next) =>
              onMutate((d) => {
                d.input.enabled = next;
              })
            }
          />
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Triple-Space Trigger' : '连按 3 次空格快捷触发'}
          hint={
            lang === 'en'
              ? 'Press Space 3 times rapidly in any non-empty input box to translate in place'
              : '在非空输入框内快速连击 3 次空格即可就地翻译成目标语言'
          }
        >
          <ToggleSwitch
            ariaLabel={lang === 'en' ? 'Triple-Space Trigger' : '连按 3 次空格快捷触发'}
            checked={draft.input.tripleSpaceTrigger}
            onChange={(next) =>
              onMutate((d) => {
                d.input.tripleSpaceTrigger = next;
              })
            }
          />
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Triple-Space Window (ms)' : '三击空格识别时间窗 (毫秒)'}
        >
          <input
            type="number"
            class="mp-input mp-input--mono"
            style={{ width: '96px' }}
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
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Primary Input Target Language' : '输入译文目标语言'}
          hint={
            lang === 'en'
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
          label={lang === 'en' ? 'Fallback Target Language' : '反向回译目标语言'}
          hint={
            lang === 'en'
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
      </section>

      {/* Section 3: Hover & Selection */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Selection & Hover Translation' : '划词与悬停段落翻译'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Shadow-isolated lightweight paper popovers with zero side floating-ball clutter.'
                : '严格 Shadow DOM 隔离的轻量纸面气泡，不注入任何遮挡视线的侧边悬浮球。'}
            </p>
          </div>
        </div>

        <FieldRow
          label={lang === 'en' ? 'Selection Trigger Mode' : '划词翻译触发方式'}
          hint={
            lang === 'en'
              ? 'Icon shows a quiet trigger badge near selected text; Off disables selection popovers'
              : '默认选中文字后浮现小巧图标点击即译；设为「关闭」可避免与外部桌面划词软件冲突'
          }
        >
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Selection Trigger Mode' : '划词翻译触发方式'}
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

        <FieldRow
          label={lang === 'en' ? 'Modifier + Hover Paragraph' : '启用修饰键悬停单段翻译'}
        >
          <ToggleSwitch
            ariaLabel={lang === 'en' ? 'Enable Hover Translation' : '启用修饰键悬停单段翻译'}
            checked={draft.hover.enabled}
            onChange={(next) =>
              onMutate((d) => {
                d.hover.enabled = next;
              })
            }
          />
        </FieldRow>

        <FieldRow label={lang === 'en' ? 'Hover Modifier Key' : '悬停修饰键'}>
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Hover Modifier Key' : '悬停修饰键'}
            options={[
              { value: 'ctrl', label: 'Ctrl' },
              { value: 'alt', label: 'Alt' },
              { value: 'shift', label: 'Shift' },
              { value: 'meta', label: 'Meta/⌘' },
              { value: 'none', label: lang === 'en' ? 'None' : '无修饰键' },
            ]}
            value={draft.hover.modifierKey}
            onChange={(key: HoverModifierKey) =>
              onMutate((d) => {
                d.hover.modifierKey = key;
              })
            }
          />
        </FieldRow>

        <FieldRow label={lang === 'en' ? 'Hover Intent Delay (ms)' : '悬停防抖延迟 (毫秒)'}>
          <input
            type="number"
            class="mp-input mp-input--mono"
            style={{ width: '92px' }}
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
        </FieldRow>
      </section>
    </div>
  );
}
