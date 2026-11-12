import { useEffect, useState } from 'preact/hooks';
import type { MarginConfig } from '@shared/types';
import { FieldRow, ToggleSwitch } from '../../components';

export interface SiteRulesTabProps {
  draft: MarginConfig;
  onMutate: (mutator: (next: MarginConfig) => void) => void;
}

export function SiteRulesTab({ draft, onMutate }: SiteRulesTabProps) {
  const lang = draft.interfaceLang;

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
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Site Auto-Translate & Exclusion Rules' : '站点自动翻译与排除规则'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'One URL glob pattern per line (e.g. https://linux.do/*). Excluded sites skip automatic webpage translation.'
                : '每行一条网址通配规则（如 https://linux.do/*），保存时自动去重与清理空白。排除规则优先级高于白名单。'}
            </p>
          </div>
        </div>

        <FieldRow
          label={lang === 'en' ? 'Auto-Translate Included URLs' : '自动翻译匹配白名单的站点'}
          hint={
            lang === 'en'
              ? 'Automatically starts bilingual webpage translation when visiting URLs matching Include Matches below'
              : '访问命中下方「白名单规则」的站点时自动开启双语网页翻译'
          }
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
          label={lang === 'en' ? 'Exclude URL Patterns (Never Auto-Translate)' : '不自动翻译的排除网址规则 (Exclude Matches)'}
          hint={lang === 'en' ? 'Example: https://linux.do/*' : '示例：https://linux.do/*（一行一条）'}
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
          label={lang === 'en' ? 'Include URL Patterns (Auto-Translate Whitelist)' : '自动翻译白名单规则 (Include Matches)'}
          hint={lang === 'en' ? 'Example: https://news.ycombinator.com/*' : '示例：https://news.ycombinator.com/*（一行一条）'}
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
