import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BRAND } from '@shared/brand';
import {
  SUPPORTED_LANGUAGES,
  createDefaultMarginConfig,
  resolveProviderIdForScene,
} from '@shared/constants';
import { sendTabCommand } from '@shared/messaging';
import {
  getMarginConfig,
  onMarginConfigChanged,
  saveMarginConfig,
} from '@shared/storage';
import type {
  DisplayMode,
  MarginConfig,
  TranslationTheme,
  UiColorMode,
} from '@shared/types';
import {
  isUnsupportedBrowserUrl,
  matchesAnyUrlGlob,
  matchesUrlGlob,
} from '@shared/url-match';
import {
  SegmentedControl,
  StatusPill,
  createSaveTracker,
  formatLanguageOption,
  labelForDisplayMode,
  labelForTheme,
  shortLabelForColorMode,
  useUiColorMode,
} from '../components';

export interface ActiveTabInfo {
  id?: number;
  url?: string;
}

export interface PopupAppProps {
  /** Optional injected active tab for deterministic unit testing. */
  initialActiveTab?: ActiveTabInfo;
}

async function queryActiveBrowserTab(): Promise<ActiveTabInfo> {
  if (
    typeof globalThis.chrome !== 'undefined' &&
    typeof chrome.tabs?.query === 'function'
  ) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab) {
        return { id: tab.id, url: tab.url };
      }
    } catch {
      // Ignore permission/tab query errors
    }
  }
  return {};
}

function parseTabOriginInfo(url?: string): { hostname: string; originGlob: string } | null {
  if (!url || isUnsupportedBrowserUrl(url)) return null;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    return {
      hostname: parsed.hostname,
      originGlob: `${parsed.origin}/*`,
    };
  } catch {
    return null;
  }
}

export function PopupApp({ initialActiveTab }: PopupAppProps = {}) {
  const [config, setConfig] = useState<MarginConfig>(() => createDefaultMarginConfig());
  const [hydrated, setHydrated] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTabInfo>(initialActiveTab ?? {});
  const [commandNotice, setCommandNotice] = useState<string | null>(null);

  const trackerRef = useRef(createSaveTracker());
  const [saveState, setSaveState] = useState(() => trackerRef.current.getState());

  useUiColorMode(config.uiColorMode);

  useEffect(() => {
    const tracker = trackerRef.current;
    const unsubTracker = tracker.subscribe(setSaveState);

    let active = true;
    void getMarginConfig().then((loaded) => {
      if (!active) return;
      tracker.hydrateReadOnly(loaded);
      setConfig(loaded);
      setHydrated(true);
    });

    if (!initialActiveTab) {
      void queryActiveBrowserTab().then((tab) => {
        if (active) setActiveTab(tab);
      });
    }

    const unsubStorage = onMarginConfigChanged((incoming) => {
      if (!active) return;
      tracker.observePersisted(incoming);
      setConfig(incoming);
    });

    return () => {
      active = false;
      unsubTracker();
      unsubStorage();
      tracker.dispose();
    };
  }, [initialActiveTab]);

  const lang = config.interfaceLang;

  const persistUserPatch = async (mutator: (draft: MarginConfig) => void) => {
    const draft = structuredClone(config);
    mutator(draft);
    setConfig(draft);

    const normalized = trackerRef.current.beginUserSave(draft);
    if (!normalized) return;

    try {
      await saveMarginConfig(normalized);
      const persisted = await getMarginConfig();
      trackerRef.current.observePersisted(persisted);
      setConfig(persisted);
    } catch (err) {
      trackerRef.current.failSave(err instanceof Error ? err.message : String(err));
    }
  };

  const webpageProviderId = useMemo(
    () => resolveProviderIdForScene('webpage', config.routing, config.providers),
    [config.routing, config.providers],
  );
  const inputProviderId = useMemo(
    () => resolveProviderIdForScene('input', config.routing, config.providers),
    [config.routing, config.providers],
  );

  const webpageProvider = config.providers[webpageProviderId];
  const inputProvider = config.providers[inputProviderId];

  const webpageSummary = webpageProvider
    ? `${webpageProvider.name} · ${webpageProvider.model}`
    : webpageProviderId;

  const inputInherits = !config.routing.input || config.routing.input === 'inherit';
  const inputSummary = inputInherits
    ? lang === 'en'
      ? `Follow Webpage · ${webpageProvider?.model ?? ''}`
      : `跟随网页 · ${webpageProvider?.model ?? ''}`
    : inputProvider
      ? `${inputProvider.name} · ${inputProvider.model}`
      : inputProviderId;

  const tabDomain = useMemo(() => parseTabOriginInfo(activeTab.url), [activeTab.url]);
  const isDomainExcluded = useMemo(() => {
    if (!activeTab.url || !tabDomain) return false;
    return matchesAnyUrlGlob(activeTab.url, config.urlRules.excludeMatches);
  }, [activeTab.url, tabDomain, config.urlRules.excludeMatches]);

  const handleToggleDomainExclude = () => {
    if (!activeTab.url || !tabDomain) return;
    const targetUrl = activeTab.url;
    void persistUserPatch((draft) => {
      if (isDomainExcluded) {
        draft.urlRules.excludeMatches = draft.urlRules.excludeMatches.filter(
          (pattern) => !matchesUrlGlob(targetUrl, pattern),
        );
      } else {
        draft.urlRules.excludeMatches = [
          ...draft.urlRules.excludeMatches,
          tabDomain.originGlob,
        ];
      }
    });
  };

  const handleOpenSettings = () => {
    if (
      typeof globalThis.chrome !== 'undefined' &&
      typeof chrome.runtime?.openOptionsPage === 'function'
    ) {
      void chrome.runtime.openOptionsPage();
      return;
    }
    if (typeof window !== 'undefined') {
      window.open('options.html', '_blank', 'noopener');
    }
  };

  const handleOpenPdfReader = () => {
    const isPdfTab = Boolean(activeTab.url && /\.pdf(?:[?#]|$)/i.test(activeTab.url));
    const query = isPdfTab && activeTab.url ? `?file=${encodeURIComponent(activeTab.url)}` : '';
    const targetPath = `pdf.html${query}`;
    const resolvedUrl =
      typeof globalThis.chrome !== 'undefined' &&
      typeof chrome.runtime?.getURL === 'function'
        ? chrome.runtime.getURL(targetPath)
        : targetPath;

    if (
      typeof globalThis.chrome !== 'undefined' &&
      typeof chrome.tabs?.create === 'function'
    ) {
      void chrome.tabs.create({ url: resolvedUrl });
      return;
    }
    if (typeof window !== 'undefined') {
      window.open(resolvedUrl, '_blank', 'noopener');
    }
  };

  const dispatchTabAction = async (
    type:
      | 'margin:cmd:toggle-page'
      | 'margin:cmd:translate-whole-page'
      | 'margin:cmd:toggle-mask'
      | 'margin:cmd:translate-input',
    feedback: string,
  ) => {
    if (activeTab.id !== undefined) {
      await sendTabCommand(activeTab.id, { type });
    }
    setCommandNotice(feedback);
  };

  const colorOptions: Array<{ value: UiColorMode; label: string }> = [
    { value: 'paper', label: shortLabelForColorMode('paper', lang) },
    { value: 'night', label: shortLabelForColorMode('night', lang) },
    { value: 'system', label: shortLabelForColorMode('system', lang) },
  ];

  const displayOptions: Array<{ value: DisplayMode; label: string }> = [
    { value: 'bilingual', label: labelForDisplayMode('bilingual', lang) },
    { value: 'target-only', label: labelForDisplayMode('target-only', lang) },
  ];

  const themeOptions: Array<{ value: TranslationTheme; label: string }> = [
    { value: 'none', label: labelForTheme('none', lang) },
    { value: 'mask', label: lang === 'en' ? 'Mask' : '模糊遮罩 Mask' },
    { value: 'opacity', label: labelForTheme('opacity', lang) },
    { value: 'weakening', label: labelForTheme('weakening', lang) },
  ];

  const targetLanguageList = SUPPORTED_LANGUAGES.filter((item) => item.code !== 'auto');

  return (
    <div class="mp-popup-sheet" data-hydrated={hydrated ? 'true' : 'false'}>
      {/* Header: Editorial wordmark + Paper/Night/System switch + Settings button */}
      <header class="mp-popup-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px' }}>
          <span class="mp-wordmark" style={{ fontSize: '21px' }}>
            {BRAND.name}
          </span>
          {saveState.status === 'saved' ? (
            <StatusPill tone="ok" dataTestId="popup-save-pill">
              {lang === 'en' ? 'Saved' : '已保存'}
            </StatusPill>
          ) : (
            <span class="mp-muted" style={{ fontSize: '11px' }}>
              v{BRAND.version}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Color Theme' : '界面主题'}
            options={colorOptions}
            value={config.uiColorMode}
            onChange={(mode) => void persistUserPatch((d) => { d.uiColorMode = mode; })}
          />
          <button
            type="button"
            class="mp-btn mp-btn--sm"
            aria-label={lang === 'en' ? 'Open Settings' : '打开设置'}
            title={lang === 'en' ? 'Open Margin Studio (options.html)' : '打开详细设置 (options.html)'}
            onClick={handleOpenSettings}
          >
            ⚙
          </button>
        </div>
      </header>

      {/* Primary Action + Quick Display Mode & Theme */}
      <section class="mp-popup-primary">
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            class="mp-btn mp-btn--solid"
            style={{ flex: 1, padding: '9px 12px', fontSize: '13.5px' }}
            onClick={() =>
              void dispatchTabAction(
                'margin:cmd:toggle-page',
                lang === 'en' ? 'Toggled page translation' : '已触发当前页面双语翻译',
              )
            }
          >
            {lang === 'en' ? 'Translate Current Page (Alt+A)' : '翻译当前页面 (Alt+A)'}
          </button>
          <button
            type="button"
            class="mp-btn"
            title={lang === 'en' ? 'Translate whole page immediately (Alt+W)' : '立即全文翻译 (Alt+W)'}
            onClick={() =>
              void dispatchTabAction(
                'margin:cmd:translate-whole-page',
                lang === 'en' ? 'Whole-page translation started' : '已触发全文翻译',
              )
            }
          >
            {lang === 'en' ? 'Full (Alt+W)' : '全文'}
          </button>
        </div>

        {commandNotice ? (
          <div class="mp-muted" style={{ fontSize: '11.5px' }} role="status">
            {commandNotice}
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <span class="mp-muted" style={{ fontSize: '12px' }}>
            {lang === 'en' ? 'Display' : '显示模式'}
          </span>
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Display Mode' : '显示模式'}
            options={displayOptions}
            value={config.webpage.displayMode}
            onChange={(mode) =>
              void persistUserPatch((d) => {
                d.webpage.displayMode = mode;
              })
            }
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span class="mp-muted" style={{ fontSize: '12px' }}>
              {lang === 'en' ? 'Translation Style' : '译文样式'}
            </span>
            {config.webpage.theme === 'mask' ? (
              <button
                type="button"
                class="mp-btn mp-btn--ghost mp-btn--sm"
                onClick={() =>
                  void dispatchTabAction(
                    'margin:cmd:toggle-mask',
                    lang === 'en' ? 'Mask toggled' : '已切换遮罩显隐',
                  )
                }
              >
                {lang === 'en' ? 'Reveal Mask (Alt+M)' : '显隐遮罩 (Alt+M)'}
              </button>
            ) : null}
          </div>
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Translation Theme' : '译文样式'}
            options={themeOptions}
            value={config.webpage.theme}
            fullWidth
            onChange={(theme) =>
              void persistUserPatch((d) => {
                d.webpage.theme = theme;
              })
            }
          />
        </div>
      </section>

      {/* Active Scene Routing Summary + Quick Target Language */}
      <section class="mp-popup-routing" aria-label={lang === 'en' ? 'Scene Routing' : '当前渠道路由'}>
        <div class="mp-popup-route-line">
          <span class="mp-muted">{lang === 'en' ? 'Webpage:' : '网页:'}</span>
          <StatusPill tone="accent" dataTestId="popup-route-webpage">
            {webpageSummary}
          </StatusPill>
        </div>

        <div class="mp-popup-route-line">
          <span class="mp-muted">{lang === 'en' ? 'Input Box:' : '输入框:'}</span>
          <StatusPill tone="neutral" dataTestId="popup-route-input">
            {inputSummary}
          </StatusPill>
        </div>

        <div class="mp-popup-route-line" style={{ paddingTop: '2px' }}>
          <label class="mp-muted" htmlFor="popup-target-lang">
            {lang === 'en' ? 'Target Language' : '目标语言'}
          </label>
          <select
            id="popup-target-lang"
            class="mp-select"
            style={{ padding: '4px 8px', fontSize: '12px', maxWidth: '196px' }}
            value={config.targetLang}
            onChange={(e) => {
              const val = (e.currentTarget as HTMLSelectElement).value;
              void persistUserPatch((d) => {
                d.targetLang = val;
              });
            }}
          >
            {targetLanguageList.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {formatLanguageOption(entry.code, lang)}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Bottom Editorial Strip: PDF Reader + Input Quick Hint + 1-Click Domain Rule */}
      <footer class="mp-popup-footer">
        <button
          type="button"
          class="mp-btn"
          style={{ width: '100%', justifyContent: 'space-between' }}
          onClick={handleOpenPdfReader}
        >
          <span>{lang === 'en' ? 'Open Bilingual PDF Reader' : '打开双语 PDF 阅读器'}</span>
          <span class="mp-muted mp-mono">PDF ↗</span>
        </button>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '6px',
            fontSize: '11.5px',
          }}
        >
          <span class="mp-muted">
            {lang === 'en'
              ? 'Translate Input (Triple-Space / Alt+I)'
              : '翻译输入框 (连按3次空格 / Alt+I)'}
          </span>
          <button
            type="button"
            class="mp-btn mp-btn--ghost mp-btn--sm"
            onClick={() =>
              void dispatchTabAction(
                'margin:cmd:translate-input',
                lang === 'en' ? 'Triggered input translation' : '已触发输入框翻译',
              )
            }
          >
            {lang === 'en' ? 'Run' : '触发'}
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            paddingTop: '4px',
            borderTop: '1px solid var(--rule-soft)',
          }}
        >
          {tabDomain ? (
            <>
              <span class="mp-mono mp-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {tabDomain.hostname}
              </span>
              <button
                type="button"
                data-testid="popup-domain-toggle"
                class={isDomainExcluded ? 'mp-btn mp-btn--solid mp-btn--sm' : 'mp-btn mp-btn--sm'}
                onClick={handleToggleDomainExclude}
              >
                {isDomainExcluded
                  ? lang === 'en'
                    ? 'Allow Current Domain'
                    : '允许当前域名'
                  : lang === 'en'
                    ? 'Exclude Current Domain'
                    : '排除当前域名'}
              </button>
            </>
          ) : (
            <span class="mp-muted" style={{ fontSize: '11.5px' }}>
              {lang === 'en' ? 'Browser internal page' : '当前标签页不支持注入脚本'}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
