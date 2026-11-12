import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
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
  TabPageState,
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
  useUiColorMode,
} from '../components';

export interface ActiveTabInfo {
  id?: number;
  url?: string;
}

export interface PopupAppProps {
  /** Optional injected active tab for deterministic unit testing. */
  initialActiveTab?: ActiveTabInfo;
  /** Optional initial live page state for deterministic unit testing. */
  initialPageState?: TabPageState;
}

const IDLE_PAGE_STATE: TabPageState = {
  active: false,
  inFlightBlocks: 0,
  translatedBlocks: 0,
  maskRevealed: false,
};

const COLOR_CYCLE_ORDER: readonly UiColorMode[] = ['paper', 'night', 'system'];

function nextUiColorMode(current: UiColorMode): UiColorMode {
  const idx = COLOR_CYCLE_ORDER.indexOf(current);
  return COLOR_CYCLE_ORDER[(idx + 1) % COLOR_CYCLE_ORDER.length] ?? 'paper';
}

function formatThemeCycleLabel(mode: UiColorMode, lang: 'zh-CN' | 'en'): string {
  switch (mode) {
    case 'paper':
      return lang === 'en' ? '☀ Paper' : '☀ 纸白';
    case 'night':
      return lang === 'en' ? '☾ Night' : '☾ 夜读';
    case 'system':
      return lang === 'en' ? '◐ Auto' : '◐ 自动';
  }
}

function isTabPageStateObject(val: unknown): val is TabPageState {
  return (
    Boolean(val) &&
    typeof val === 'object' &&
    typeof (val as TabPageState).active === 'boolean' &&
    typeof (val as TabPageState).inFlightBlocks === 'number'
  );
}

function extractDispatchedPageState(raw: unknown): TabPageState | null {
  if (isTabPageStateObject(raw)) {
    return raw;
  }
  if (raw && typeof raw === 'object') {
    const nested = (raw as { state?: unknown }).state;
    if (isTabPageStateObject(nested)) {
      return nested;
    }
  }
  return null;
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

function parseTabOriginInfo(
  url?: string,
): { hostname: string; originGlob: string } | null {
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

export function PopupApp({
  initialActiveTab,
  initialPageState,
}: PopupAppProps = {}) {
  const [config, setConfig] = useState<MarginConfig>(() =>
    createDefaultMarginConfig(),
  );
  const configRef = useRef<MarginConfig>(config);
  const hydratedRef = useRef(false);
  const saveSeqRef = useRef(0);

  const [hydrated, setHydrated] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTabInfo>(
    initialActiveTab ?? {},
  );
  const [pageState, setPageState] = useState<TabPageState>(
    initialPageState ?? IDLE_PAGE_STATE,
  );
  const [commandNotice, setCommandNotice] = useState<{
    text: string;
    isError?: boolean;
  } | null>(null);

  const trackerRef = useRef(createSaveTracker());
  const [saveState, setSaveState] = useState(() =>
    trackerRef.current.getState(),
  );

  useUiColorMode(config.uiColorMode);

  const syncConfigState = useCallback((next: MarginConfig) => {
    configRef.current = next;
    setConfig(next);
  }, []);

  const refreshTabPageState = useCallback(async (tab: ActiveTabInfo) => {
    if (
      tab.id === undefined ||
      (tab.url !== undefined && isUnsupportedBrowserUrl(tab.url))
    ) {
      return;
    }
    const res = await sendTabCommand(tab.id, {
      type: 'margin:cmd:get-page-state',
    });
    if (res.ok) {
      const parsed = extractDispatchedPageState(res.result);
      if (parsed) {
        setPageState(parsed);
      }
    }
  }, []);

  useEffect(() => {
    const tracker = trackerRef.current;
    const unsubTracker = tracker.subscribe(setSaveState);

    let active = true;
    void getMarginConfig().then((loaded) => {
      if (!active) return;
      tracker.hydrateReadOnly(loaded);
      syncConfigState(loaded);
      hydratedRef.current = true;
      setHydrated(true);
    });

    if (!initialActiveTab) {
      void queryActiveBrowserTab().then((tab) => {
        if (!active) return;
        setActiveTab(tab);
        void refreshTabPageState(tab);
      });
    } else if (!initialPageState) {
      void refreshTabPageState(initialActiveTab);
    }

    const unsubStorage = onMarginConfigChanged((incoming) => {
      if (!active) return;
      tracker.observePersisted(incoming);
      syncConfigState(incoming);
    });

    return () => {
      active = false;
      unsubTracker();
      unsubStorage();
      tracker.dispose();
    };
  }, [
    initialActiveTab,
    initialPageState,
    refreshTabPageState,
    syncConfigState,
  ]);

  // Poll live progress while blocks are actively translating in the current tab
  useEffect(() => {
    if (
      activeTab.id === undefined ||
      (!pageState.active && pageState.inFlightBlocks === 0)
    ) {
      return undefined;
    }
    if (pageState.inFlightBlocks <= 0) {
      return undefined;
    }
    const timer = setInterval(() => {
      void refreshTabPageState(activeTab);
    }, 650);
    return () => clearInterval(timer);
  }, [
    activeTab,
    pageState.active,
    pageState.inFlightBlocks,
    refreshTabPageState,
  ]);

  const lang = config.interfaceLang;

  const persistUserPatch = async (mutator: (draft: MarginConfig) => void) => {
    if (!hydratedRef.current) return;

    const draft = structuredClone(configRef.current);
    mutator(draft);
    syncConfigState(draft);

    const normalized = trackerRef.current.beginUserSave(draft);
    if (!normalized) return;

    const seq = ++saveSeqRef.current;
    try {
      await saveMarginConfig(normalized);
      const persisted = await getMarginConfig();
      trackerRef.current.observePersisted(persisted);
      if (seq === saveSeqRef.current) {
        syncConfigState(persisted);
      }
    } catch (err) {
      trackerRef.current.failSave(
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const webpageProviderId = useMemo(
    () =>
      resolveProviderIdForScene('webpage', config.routing, config.providers),
    [config.routing, config.providers],
  );
  const webpageProvider = config.providers[webpageProviderId];
  const webpageSummary = webpageProvider
    ? `${webpageProvider.name} · ${webpageProvider.model}`
    : webpageProviderId;

  const tabDomain = useMemo(
    () => parseTabOriginInfo(activeTab.url),
    [activeTab.url],
  );
  const isUnsupportedTab = useMemo(
    () => Boolean(activeTab.url && isUnsupportedBrowserUrl(activeTab.url)),
    [activeTab.url],
  );
  const isDomainExcluded = useMemo(() => {
    if (!activeTab.url || !tabDomain) return false;
    return matchesAnyUrlGlob(activeTab.url, config.urlRules.excludeMatches);
  }, [activeTab.url, tabDomain, config.urlRules.excludeMatches]);

  const handleToggleDomainExclude = () => {
    if (!activeTab.url || !tabDomain) return;
    const targetUrl = activeTab.url;
    const nextExcluded = !isDomainExcluded;
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
    if (nextExcluded) {
      setPageState(IDLE_PAGE_STATE);
      setCommandNotice(null);
    }
  };

  const openOptionsTarget = (tabQuery?: string) => {
    const relative = tabQuery ? `options.html?tab=${tabQuery}` : 'options.html';
    if (
      !tabQuery &&
      typeof globalThis.chrome !== 'undefined' &&
      typeof chrome.runtime?.openOptionsPage === 'function'
    ) {
      void chrome.runtime.openOptionsPage();
      return;
    }
    const resolvedUrl =
      typeof globalThis.chrome !== 'undefined' &&
      typeof chrome.runtime?.getURL === 'function'
        ? chrome.runtime.getURL(relative)
        : relative;
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

  const handleOpenPdfReader = () => {
    const isPdfTab = Boolean(
      activeTab.url && /\.pdf(?:[?#]|$)/i.test(activeTab.url),
    );
    const query =
      isPdfTab && activeTab.url
        ? `?file=${encodeURIComponent(activeTab.url)}`
        : '';
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
      | 'margin:cmd:toggle-mask',
  ) => {
    if (isUnsupportedTab) {
      setCommandNotice({
        text:
          lang === 'en'
            ? 'This browser page does not allow extension scripts.'
            : '当前为浏览器受限页面，无法注入翻译脚本',
        isError: true,
      });
      return;
    }

    if (activeTab.id === undefined) {
      return;
    }

    const res = await sendTabCommand(activeTab.id, { type });
    if (!res.ok) {
      setCommandNotice({
        text:
          res.unsupportedPage
            ? lang === 'en'
              ? 'This page does not support content script injection.'
              : '当前页面不支持注入翻译脚本'
            : res.error ||
              (lang === 'en'
                ? 'Could not reach active tab.'
                : '无法连接当前标签页，请刷新网页后重试'),
        isError: true,
      });
      return;
    }

    const returnedState = extractDispatchedPageState(res.result);
    if (returnedState) {
      setPageState(returnedState);
      if (type === 'margin:cmd:toggle-page') {
        setCommandNotice({
          text: returnedState.active
            ? lang === 'en'
              ? 'Bilingual page translation enabled'
              : '已开启当前页面双语翻译'
            : lang === 'en'
              ? 'Restored original webpage'
              : '已还原网页原文',
        });
      } else if (type === 'margin:cmd:translate-whole-page') {
        setCommandNotice({
          text:
            lang === 'en'
              ? 'Whole-page translation started'
              : '正在翻译整页全部段落…',
        });
      } else {
        setCommandNotice({
          text: returnedState.maskRevealed
            ? lang === 'en'
              ? 'Revealed masked translations'
              : '已显示全部遮罩译文'
            : lang === 'en'
              ? 'Re-masked translations'
              : '已恢复遮罩隐藏',
        });
      }
      return;
    }

    // Fallback when running in minimal test environments without chrome.tabs
    if (type === 'margin:cmd:toggle-page') {
      setPageState((prev) => ({ ...prev, active: !prev.active }));
    }
    setCommandNotice(null);
  };

  const displayOptions: Array<{ value: DisplayMode; label: string }> = [
    { value: 'bilingual', label: labelForDisplayMode('bilingual', lang) },
    { value: 'target-only', label: labelForDisplayMode('target-only', lang) },
  ];

  const themeOptions: Array<{ value: TranslationTheme; label: string }> = [
    { value: 'none', label: lang === 'en' ? 'None' : '无' },
    { value: 'mask', label: lang === 'en' ? 'Mask' : '遮罩' },
    { value: 'opacity', label: lang === 'en' ? 'Fade' : '淡化' },
    { value: 'weakening', label: lang === 'en' ? 'Soft' : '弱化' },
  ];

  const targetLanguageList = SUPPORTED_LANGUAGES.filter(
    (item) => item.code !== 'auto',
  );

  const bannerError = pageState.lastError || (commandNotice?.isError ? commandNotice.text : null);
  const bannerInfo = !bannerError ? commandNotice?.text : null;

  return (
    <div class="mp-popup-sheet" data-hydrated={hydrated ? 'true' : 'false'}>
      {/* Header: Serif wordmark + Live state badge + 1-button Theme Cycler + Settings */}
      <header class="mp-popup-header">
        <div class="mp-popup-header-brand">
          <span class="mp-wordmark" style={{ fontSize: '20px' }}>
            {BRAND.name}
          </span>
          {saveState.status === 'saved' ? (
            <StatusPill tone="ok" dataTestId="popup-save-pill">
              {lang === 'en' ? 'Saved' : '已保存'}
            </StatusPill>
          ) : pageState.lastError ? (
            <StatusPill tone="danger" dataTestId="popup-page-badge">
              {lang === 'en' ? 'Error' : '翻译异常'}
            </StatusPill>
          ) : pageState.inFlightBlocks > 0 ? (
            <StatusPill tone="accent" dataTestId="popup-page-badge">
              {lang === 'en'
                ? `Translating · ${pageState.translatedBlocks}`
                : `翻译中 · ${pageState.translatedBlocks}`}
            </StatusPill>
          ) : pageState.active ? (
            <StatusPill tone="ok" dataTestId="popup-page-badge">
              {lang === 'en'
                ? `Active · ${pageState.translatedBlocks}`
                : `双语已开启${pageState.translatedBlocks > 0 ? ` · ${pageState.translatedBlocks}` : ''}`}
            </StatusPill>
          ) : (
            <span class="mp-muted" style={{ fontSize: '11px' }}>
              v{BRAND.version}
            </span>
          )}
        </div>

        <div class="mp-popup-header-actions">
          <button
            type="button"
            class="mp-btn mp-btn--sm"
            data-testid="popup-theme-cycle"
            aria-label={lang === 'en' ? 'Switch Color Theme' : '切换界面外观主题'}
            title={
              lang === 'en'
                ? 'Cycle Paper / Night / System theme'
                : '点击切换 纸白 / 夜读 / 跟随系统'
            }
            onClick={() =>
              void persistUserPatch((d) => {
                d.uiColorMode = nextUiColorMode(d.uiColorMode);
              })
            }
          >
            {formatThemeCycleLabel(config.uiColorMode, lang)}
          </button>
          <button
            type="button"
            class="mp-btn mp-btn--sm"
            data-testid="popup-open-settings"
            aria-label={lang === 'en' ? 'Open Settings' : '打开设置'}
            title={
              lang === 'en'
                ? 'Open Margin Studio (options.html)'
                : '打开详细设置 (options.html)'
            }
            onClick={() => openOptionsTarget()}
          >
            ⚙
          </button>
        </div>
      </header>

      {/* Tier 1: Primary Page Action Hero */}
      <section class="mp-popup-hero">
        <div class="mp-popup-hero-row">
          <button
            type="button"
            data-testid="popup-toggle-page"
            disabled={isUnsupportedTab}
            class={
              pageState.active
                ? 'mp-btn mp-popup-hero-btn mp-popup-hero-btn--active'
                : 'mp-btn mp-btn--solid mp-popup-hero-btn'
            }
            onClick={() => void dispatchTabAction('margin:cmd:toggle-page')}
          >
            <span>
              {pageState.active
                ? lang === 'en'
                  ? 'Restore Original'
                  : '还原网页原文'
                : lang === 'en'
                  ? 'Translate Current Page'
                  : '翻译当前页面'}
            </span>
            <kbd class="mp-popup-kbd">Alt+A</kbd>
          </button>

          <button
            type="button"
            class="mp-btn"
            data-testid="popup-whole-page"
            disabled={isUnsupportedTab}
            title={
              lang === 'en'
                ? 'Translate whole page immediately (Alt+W)'
                : '立即全文翻译 (Alt+W)'
            }
            onClick={() =>
              void dispatchTabAction('margin:cmd:translate-whole-page')
            }
          >
            {lang === 'en' ? 'Full' : '全文'}
          </button>
        </div>

        {bannerError ? (
          <div
            class="mp-popup-banner mp-popup-banner--error"
            data-testid="popup-status-banner"
            role="alert"
          >
            {bannerError}
          </div>
        ) : bannerInfo ? (
          <div
            class="mp-popup-banner"
            data-testid="popup-status-banner"
            role="status"
          >
            {bannerInfo}
          </div>
        ) : null}
      </section>

      {/* Tier 2: Core Reading Controls Card */}
      <section
        class="mp-popup-card"
        aria-label={lang === 'en' ? 'Reading Preferences' : '阅读与排版偏好'}
      >
        <div class="mp-popup-control-row">
          <label class="mp-popup-control-label" htmlFor="popup-target-lang">
            {lang === 'en' ? 'Target Language' : '目标语言'}
          </label>
          <select
            id="popup-target-lang"
            class="mp-select"
            style={{ padding: '4px 8px', fontSize: '12px', maxWidth: '198px' }}
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

        <div class="mp-popup-control-row">
          <span class="mp-popup-control-label">
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
          <div class="mp-popup-control-row">
            <span class="mp-popup-control-label">
              {lang === 'en' ? 'Style' : '译文样式'}
            </span>
            {config.webpage.theme === 'mask' ? (
              <button
                type="button"
                class="mp-btn mp-btn--ghost mp-btn--sm"
                data-testid="popup-toggle-mask"
                onClick={() => void dispatchTabAction('margin:cmd:toggle-mask')}
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

      {/* Tier 3: Active Channel + Quick Feature Toggles + Site Rule Footer */}
      <footer class="mp-popup-footer">
        <button
          type="button"
          class="mp-popup-channel-bar"
          data-testid="popup-route-webpage"
          onClick={() => openOptionsTarget('providers')}
          title={
            lang === 'en'
              ? 'Configure translation provider & model'
              : '点击配置翻译服务渠道与模型'
          }
        >
          <span class="mp-popup-control-label">
            {lang === 'en' ? 'Channel' : '主力渠道'}
          </span>
          <span class="mp-popup-channel-value">
            <span class="mp-popup-channel-summary">{webpageSummary}</span>
            <span class="mp-popup-channel-arrow" aria-hidden="true">
              {lang === 'en' ? 'Config ↗' : '配置 ↗'}
            </span>
          </span>
        </button>

        <div class="mp-popup-quick-row">
          <button
            type="button"
            class="mp-popup-toggle-pill"
            data-testid="popup-toggle-selection"
            aria-pressed={config.selection.enabled ? 'true' : 'false'}
            onClick={() =>
              void persistUserPatch((d) => {
                d.selection.enabled = !d.selection.enabled;
                if (d.selection.enabled && d.selection.triggerMode === 'off') {
                  d.selection.triggerMode = 'icon';
                }
              })
            }
          >
            <span class="mp-popup-toggle-dot" />
            <span>{lang === 'en' ? 'Selection' : '划词翻译'}</span>
          </button>

          <button
            type="button"
            class="mp-popup-toggle-pill"
            data-testid="popup-toggle-hover"
            aria-pressed={config.hover.enabled ? 'true' : 'false'}
            onClick={() =>
              void persistUserPatch((d) => {
                d.hover.enabled = !d.hover.enabled;
              })
            }
          >
            <span class="mp-popup-toggle-dot" />
            <span>{lang === 'en' ? 'Ctrl+Hover' : 'Ctrl+悬停'}</span>
          </button>

          <button
            type="button"
            class="mp-btn mp-btn--sm"
            data-testid="popup-open-pdf"
            onClick={handleOpenPdfReader}
            title={
              lang === 'en'
                ? 'Open Bilingual PDF Reader'
                : '打开双语 PDF 阅读器'
            }
          >
            {lang === 'en' ? 'PDF ↗' : '双语 PDF ↗'}
          </button>
        </div>

        <div class="mp-popup-site-bar">
          {tabDomain ? (
            <>
              <span class="mp-popup-site-host" title={tabDomain.hostname}>
                {tabDomain.hostname}
              </span>
              <button
                type="button"
                data-testid="popup-domain-toggle"
                class={
                  isDomainExcluded
                    ? 'mp-btn mp-btn--solid mp-btn--sm'
                    : 'mp-btn mp-btn--sm'
                }
                onClick={handleToggleDomainExclude}
              >
                {isDomainExcluded
                  ? lang === 'en'
                    ? 'Disabled · Enable'
                    : '已禁用 · 点击恢复'
                  : lang === 'en'
                    ? 'Disable on site'
                    : '在此网站禁用'}
              </button>
            </>
          ) : (
            <span class="mp-muted">
              {lang === 'en'
                ? 'Browser internal page — script injection unavailable'
                : '当前浏览器内部页面不支持注入脚本'}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
