import { SUPPORTED_LANGUAGES } from '@shared/constants';
import type {
  HoverModifierKey,
  MarginConfig,
  SelectionTriggerMode,
} from '@shared/types';
import {
  FieldRow,
  SegmentedControl,
  ToggleSwitch,
  formatLanguageOption,
  labelForSelectionMode,
} from '../../components';

export interface ScenesRulesTabProps {
  draft: MarginConfig;
  onMutate: (mutator: (next: MarginConfig) => void) => void;
}

export function ScenesRulesTab({ draft, onMutate }: ScenesRulesTabProps) {
  const lang = draft.interfaceLang;
  const targetLangOptions = SUPPORTED_LANGUAGES.filter((l) => l.code !== 'auto');

  const selectionValue: SelectionTriggerMode = draft.selection.enabled
    ? draft.selection.triggerMode === 'off'
      ? 'icon'
      : draft.selection.triggerMode
    : 'off';

  return (
    <div>
      {/* Section 1: Input-Box Quick Translate */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en'
                ? 'Input-Box Quick Translate'
                : '输入框快捷翻译 (Triple-Space / Alt+I)'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Translates active <input>, <textarea>, and rich [contenteditable] editors while preserving native Ctrl+Z undo.'
                : '支持网页输入框、富文本编辑器与 Shadow DOM 输入框，替换文本后可随时按 Ctrl+Z 撤销恢复原稿。'}
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
          label={lang === 'en' ? 'Triple-Space Trigger' : '连按 3 次空格快捷触发 (Triple-Space)'}
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
          label={lang === 'en' ? 'Triple-Space Window (ms)' : '三击空格时间窗 (毫秒)'}
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
              : '例如在英文社区输入中文草稿时，默认翻译为英文'
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
              : '当检测到输入文本已是主目标语言（如英文）时，自动翻译为此语言'
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

      {/* Section 2: Hover & Selection */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Hover & Selection Translation' : '悬停段落与划词翻译'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Shadow-isolated 16px widgets immune to host CSS rem scaling; no floating ball clutter.'
                : '采用严格 Shadow DOM 隔离的轻量纸面卡片，彻底告别遮挡视线的侧边悬浮球。'}
            </p>
          </div>
        </div>

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

        <FieldRow
          label={lang === 'en' ? 'Selection Trigger Mode' : '划词翻译触发方式'}
          hint={
            lang === 'en'
              ? 'Off disables selection popovers completely so external desktop tools never conflict'
              : '设为「关闭」时完全静默，不与桌面端划词工具产生冲突'
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
      </section>

      {/* Section 3: Video Subtitles & YouTube Bilingual PiP */}
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
                ? '6-step JSON3 timeline sanitizer + ±1000ms alignment + direct state bus into Document Picture-in-Picture.'
                : '内置 6 步时间轴清洗、±1000ms 单调对齐、独立 17 条预翻译与原生双语文档画中画 (PiP)。'}
            </p>
          </div>
        </div>

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
          label={lang === 'en' ? 'Lookahead Pre-Translation' : '时间轴前瞻预翻译 (preTranslate)'}
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

        <FieldRow label={lang === 'en' ? 'Subtitle Font Scale (%)' : '译文字号缩放比例 (%)'}>
          <input
            type="number"
            class="mp-input mp-input--mono"
            style={{ width: '92px' }}
            min={40}
            max={160}
            step={5}
            value={draft.subtitles.fontSizePercent}
            onInput={(e) => {
              const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
              onMutate((d) => {
                d.subtitles.fontSizePercent = Number.isFinite(v)
                  ? Math.max(40, Math.min(160, v))
                  : 70;
              });
            }}
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
      </section>

      {/* Section 4: URL Inclusion & Exclusion Rules */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Site URL Rules' : '站点自动翻译与排除规则'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'One URL glob pattern per line (e.g. https://linux.do/*). Excluded sites never auto-translate.'
                : '每行一条通配规则（如 https://linux.do/*），保存时自动去重与清理首尾空白。'}
            </p>
          </div>
        </div>

        <FieldRow
          label={lang === 'en' ? 'Skip Localhost & Private LANs' : '自动跳过局域网与本机地址'}
          hint="localhost, 127.0.0.1, 10.*, 192.168.*, *.local"
        >
          <ToggleSwitch
            ariaLabel={lang === 'en' ? 'Skip Private Networks' : '自动跳过局域网与本机地址'}
            checked={draft.urlRules.skipPrivateNetworks}
            onChange={(next) =>
              onMutate((d) => {
                d.urlRules.skipPrivateNetworks = next;
              })
            }
          />
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Auto-Translate Included URLs' : '自动翻译匹配白名单的站点'}
        >
          <ToggleSwitch
            ariaLabel={lang === 'en' ? 'Auto-Translate Matches' : '自动翻译匹配白名单的站点'}
            checked={draft.webpage.autoTranslateMatches}
            onChange={(next) =>
              onMutate((d) => {
                d.webpage.autoTranslateMatches = next;
              })
            }
          />
        </FieldRow>

        <FieldRow
          stacked
          label={lang === 'en' ? 'Exclude URL Patterns (Never Auto-Translate)' : '排除网址规则 (Exclude Matches)'}
          hint={lang === 'en' ? 'Example: https://linux.do/*' : '示例：https://linux.do/*'}
        >
          <textarea
            class="mp-textarea mp-textarea--mono"
            placeholder="https://linux.do/*"
            value={draft.urlRules.excludeMatches.join('\n')}
            onInput={(e) => {
              const lines = (e.currentTarget as HTMLTextAreaElement).value.split('\n');
              onMutate((d) => {
                d.urlRules.excludeMatches = lines;
              });
            }}
          />
        </FieldRow>

        <FieldRow
          stacked
          label={lang === 'en' ? 'Include URL Patterns (Auto-Translate)' : '自动翻译白名单规则 (Include Matches)'}
          hint={lang === 'en' ? 'Example: https://news.ycombinator.com/*' : '示例：https://news.ycombinator.com/*'}
        >
          <textarea
            class="mp-textarea mp-textarea--mono"
            placeholder="https://news.ycombinator.com/*"
            value={draft.urlRules.includeMatches.join('\n')}
            onInput={(e) => {
              const lines = (e.currentTarget as HTMLTextAreaElement).value.split('\n');
              onMutate((d) => {
                d.urlRules.includeMatches = lines;
              });
            }}
          />
        </FieldRow>
      </section>
    </div>
  );
}
