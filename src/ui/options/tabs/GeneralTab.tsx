import {
  SUPPORTED_LANGUAGES,
  resolveProviderIdForScene,
} from '@shared/constants';
import type {
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
  formatLanguageOption,
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

  return (
    <div>
      {/* Section 1: Interface & Languages */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Appearance & Language' : '界面外观与默认语言'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Warm editorial reading canvas synced across Popup, Options, PDF Studio, and in-page widgets.'
                : '温暖纸质编辑部视觉规范，统一应用于工具栏弹窗、设置中心、双语 PDF 与页内浮层。'}
            </p>
          </div>
        </div>

        <FieldRow
          label={lang === 'en' ? 'Interface Language' : '界面语言'}
          hint={lang === 'en' ? 'UI label language for Margin controls' : '设置页、弹窗与双语阅读器操作语言'}
        >
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Interface Language' : '界面语言'}
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

        <FieldRow
          label={lang === 'en' ? 'Color Theme' : '色彩主题'}
          hint={
            lang === 'en'
              ? 'Warm Paper (#fbfaf6), Warm Charcoal Night (#151411), or follow OS'
              : '暖纸白 (#fbfaf6)、暖炭黑夜读 (#151411) 或自动跟随系统深浅色'
          }
        >
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Color Theme' : '色彩主题'}
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
          label={lang === 'en' ? 'Source Language' : '默认源语言'}
          hint={lang === 'en' ? 'Auto-detect recommended for mixed reading' : '日常网页阅读建议保持自动检测'}
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
          label={lang === 'en' ? 'Target Language' : '默认目标语言'}
          hint={lang === 'en' ? 'Primary language for webpage, PDF, subtitles & images' : '网页、PDF、字幕与图片翻译的目标语言'}
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
      </section>

      {/* Section 2: Live Scene Routing Matrix */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Scene Routing Matrix' : '分场景翻译渠道路由'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Sub-scenes set to "Follow Primary Webpage Service (inherit)" dynamically track changes to your primary channel.'
                : '设为「跟随主翻译服务 (inherit)」的场景会自动联动网页主服务，切换主模型时无需逐项重配。'}
            </p>
          </div>
        </div>

        {SCENES_ORDER.map((scene) => {
          const isPrimary = scene === 'webpage';
          const rawValue = draft.routing[scene];
          const resolvedId = resolveProviderIdForScene(scene, draft.routing, draft.providers);
          const resolvedProvider = draft.providers[resolvedId];
          const resolvedText = resolvedProvider
            ? `→ ${resolvedProvider.name} (${resolvedProvider.model})`
            : `→ ${resolvedId}`;

          return (
            <FieldRow
              key={scene}
              label={labelForScene(scene, lang)}
              badge={
                <StatusPill
                  tone={isPrimary || rawValue !== 'inherit' ? 'accent' : 'mono'}
                  dataTestId={`scene-resolved-${scene}`}
                >
                  {resolvedText}
                </StatusPill>
              }
              hint={
                isPrimary
                  ? lang === 'en'
                    ? 'Primary service inherited by other scenes'
                    : '全局主翻译渠道，供勾选「跟随主翻译服务」的子场景实时继承'
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
                      ? 'Follow Primary Webpage Service (inherit)'
                      : '跟随主翻译服务 (inherit)'}
                  </option>
                ) : null}
                {fallbackProviders.map((prov) => (
                  <option key={prov.id} value={prov.id}>
                    {prov.name} ({prov.model}){!prov.enabled ? ' [已停用]' : ''}
                  </option>
                ))}
              </select>
            </FieldRow>
          );
        })}
      </section>

      {/* Section 3: Webpage Typography & Themes */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Webpage Typography & Theme' : '网页译文排版与样式'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Controlled rich-text keeps inline links, emphasis, and math formulas intact without innerHTML risks.'
                : '受控富文本引擎默认在双语与仅译文模式下同时保护内联链接、粗体与数学公式。'}
            </p>
          </div>
        </div>

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
              : '模糊遮罩 (Mask) 默认轻度模糊译文，悬停或按 Alt+M 清晰显现，适合沉浸学习阅读'
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

        <FieldRow
          label={
            lang === 'en'
              ? 'Inline Line-Break Threshold (chars)'
              : '短段落换行字数阈值 (lineBreakMaxTextCount)'
          }
          hint={
            lang === 'en'
              ? 'Paragraphs longer than this count always break onto a dedicated bilingual block (default 280)'
              : '超过该字符数的段落始终独立换行排版（默认 280）'
          }
        >
          <input
            type="number"
            class="mp-input mp-input--mono"
            style={{ width: '96px' }}
            min={0}
            max={5000}
            value={draft.webpage.lineBreakMaxTextCount}
            onInput={(e) => {
              const parsed = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
              onMutate((d) => {
                d.webpage.lineBreakMaxTextCount = Number.isFinite(parsed) ? Math.max(0, parsed) : 280;
              });
            }}
          />
        </FieldRow>
      </section>
    </div>
  );
}
