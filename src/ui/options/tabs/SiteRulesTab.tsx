import { useEffect, useState } from 'preact/hooks';
import type { AutoTranslateMode, MarginConfig } from '@shared/types';
import {
  FieldRow,
  SegmentedControl,
  StatusPill,
  ToggleSwitch,
  describeAutoTranslateMode,
  labelForAutoTranslateMode,
} from '../../components';

export interface SiteRulesTabProps {
  draft: MarginConfig;
  onMutate: (mutator: (next: MarginConfig) => void) => void;
}

export function SiteRulesTab({ draft, onMutate }: SiteRulesTabProps) {
  const lang = draft.interfaceLang;

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
      dataTestId: 'rules-auto-mode-foreign',
    },
    {
      value: 'whitelist',
      label: labelForAutoTranslateMode('whitelist', lang),
      dataTestId: 'rules-auto-mode-whitelist',
    },
    {
      value: 'off',
      label: labelForAutoTranslateMode('off', lang),
      dataTestId: 'rules-auto-mode-off',
    },
  ];

  const [rawExcludes, setRawExcludes] = useState(() =>
    draft.urlRules.excludeMatches.join('\n'),
  );
  const [rawIncludes, setRawIncludes] = useState(() =>
    draft.urlRules.includeMatches.join('\n'),
  );

  // Sync local textarea text if draft changes externally (e.g. Revert or Import)
  useEffect(() => {
    const currentParsed = rawExcludes
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const incomingParsed = draft.urlRules.excludeMatches
      .map((s) => s.trim())
      .filter(Boolean);
    if (currentParsed.join('\n') !== incomingParsed.join('\n')) {
      setRawExcludes(draft.urlRules.excludeMatches.join('\n'));
    }
  }, [draft.urlRules.excludeMatches]);

  useEffect(() => {
    const currentParsed = rawIncludes
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const incomingParsed = draft.urlRules.includeMatches
      .map((s) => s.trim())
      .filter(Boolean);
    if (currentParsed.join('\n') !== incomingParsed.join('\n')) {
      setRawIncludes(draft.urlRules.includeMatches.join('\n'));
    }
  }, [draft.urlRules.includeMatches]);

  return (
    <div>
      {/* Top Strategy Card: Auto-Translate Mode */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Global Auto-Translate Strategy' : '全局自动翻译策略'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Choose how Margin decides whether to start bilingual webpage translation automatically on navigation.'
                : '控制打开网页时何时自动启动双语对照阅读；工具栏弹窗支持按站点一键切换「跟随全局 / 此站必翻 / 此站不翻」。'}
            </p>
          </div>
          <StatusPill tone="accent" dataTestId="rules-active-mode-pill">
            {labelForAutoTranslateMode(currentAutoMode, lang)}
          </StatusPill>
        </div>

        <FieldRow
          stacked
          label={lang === 'en' ? 'Auto-Translate Strategy' : '自动翻译策略 (autoTranslateMode)'}
        >
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Auto-Translate Strategy' : '自动翻译策略'}
            dataTestId="rules-auto-translate-mode"
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

        <div class="mp-editorial-note" data-testid="rules-strategy-explanation">
          {describeAutoTranslateMode(currentAutoMode, lang)}
        </div>
      </section>

      {/* Section 2: Per-Site URL Exclusion & Inclusion Rules */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Site Exclusion & Whitelist URL Rules' : '站点排除与必翻白名单规则'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'One URL glob pattern per line (e.g. https://linux.do/*). Excluded sites skip automatic webpage translation.'
                : '每行一条网址通配规则（如 https://linux.do/*），保存时自动去重与清理空白。排除规则优先级始终高于必翻白名单与外语检测。'}
            </p>
          </div>
        </div>

        <FieldRow
          stacked
          label={lang === 'en' ? 'Exclude URL Patterns (Never Auto-Translate)' : '不自动翻译的排除网址规则 (Exclude Matches / 此站不翻)'}
          hint={lang === 'en' ? 'Example: https://linux.do/*' : '示例：https://linux.do/* 或 *://linux.do/*（一行一条）'}
        >
          <textarea
            class="mp-textarea mp-textarea--mono"
            data-testid="site-exclude-textarea"
            placeholder="https://linux.do/*"
            value={rawExcludes}
            onInput={(e) => {
              const raw = (e.currentTarget as HTMLTextAreaElement).value;
              setRawExcludes(raw);
              const lines = raw.split('\n');
              onMutate((d) => {
                d.urlRules.excludeMatches = lines;
              });
            }}
          />
        </FieldRow>

        <FieldRow
          stacked
          label={lang === 'en' ? 'Include URL Patterns (Always Auto-Translate Whitelist)' : '自动翻译必翻白名单规则 (Include Matches / 此站必翻)'}
          hint={lang === 'en' ? 'Example: https://news.ycombinator.com/*' : '示例：https://news.ycombinator.com/* 或 *://x.com/*（一行一条）'}
        >
          <textarea
            class="mp-textarea mp-textarea--mono"
            data-testid="site-include-textarea"
            placeholder="https://news.ycombinator.com/*"
            value={rawIncludes}
            onInput={(e) => {
              const raw = (e.currentTarget as HTMLTextAreaElement).value;
              setRawIncludes(raw);
              const lines = raw.split('\n');
              onMutate((d) => {
                d.urlRules.includeMatches = lines;
              });
            }}
          />
        </FieldRow>

        <FieldRow
          label={lang === 'en' ? 'Skip Localhost & Private LANs' : '自动跳过局域网与本机开发地址'}
          hint="localhost, 127.0.0.1, 10.*, 192.168.*, *.local"
        >
          <ToggleSwitch
            ariaLabel={lang === 'en' ? 'Skip Private Networks' : '自动跳过局域网与本机开发地址'}
            checked={draft.urlRules.skipPrivateNetworks}
            onChange={(next) =>
              onMutate((d) => {
                d.urlRules.skipPrivateNetworks = next;
              })
            }
          />
        </FieldRow>
      </section>
    </div>
  );
}
