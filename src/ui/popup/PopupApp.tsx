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
  updateMarginConfig,
} from '@shared/storage';
import type {
  DisplayMode,
  MarginConfig,
  TabPageState,
  TranslationTheme,
  UiColorMode,
} from '@shared/types';
import {
  applySiteAutoRule,
  getSiteAutoRule,
  isUnsupportedBrowserUrl,
  type SiteAutoRuleState,
} from '@shared/url-match';
import {
  EditorialBadge,
  Icon,
  SegmentedControl,
  createSaveTracker,
  formatLanguageOption,
  labelForDisplayMode,
  normalizeConfigForSave,
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
      return lang === 'en' ? 'Paper' : '纸白';
    case 'night':
      return lang === 'en' ? 'Night' : '夜读';
    case 'system':
      return lang === 'en' ? 'Auto' : '自动';
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
  const siteAutoRule: SiteAutoRuleState = useMemo(() => {
    if (!activeTab.url || !tabDomain) return 'follow';
    return getSiteAutoRule(activeTab.url, config.urlRules);
  }, [activeTab.url, tabDomain, config.urlRules]);

  const autoMode = config.webpage.autoTranslateMode ?? 'foreign';
  const followModeBadge =
    autoMode === 'foreign'
      ? lang === 'en'
        ? '(Foreign Auto)'
        : '(非中自动)'
      : autoMode === 'whitelist'
        ? lang === 'en'
          ? '(Whitelist)'
          : '(仅白名单)'
        : lang === 'en'
          ? '(Manual)'
          : '(手动)';

  const handleSelectSiteAutoRule = async (nextState: SiteAutoRuleState) => {
    if (!hydratedRef.current || !activeTab.url || !tabDomain) return;
    const targetUrl = activeTab.url;

    if (nextState !== siteAutoRule) {
      const optimistic = structuredClone(configRef.current);
      optimistic.urlRules = applySiteAutoRule(
        targetUrl,
        nextState,
        optimistic.urlRules,
      );
      const normalizedOptimistic = trackerRef.current.beginUserSave(optimistic);
      syncConfigState(normalizedOptimistic);

      const seq = ++saveSeqRef.current;
      try {
        await updateMarginConfig((draft) => {
          draft.urlRules = applySiteAutoRule(
            targetUrl,
            nextState,
            draft.urlRules,
          );
          return normalizeConfigForSave(draft);
        });
        const persisted = await getMarginConfig();
        trackerRef.current.observePersisted(persisted);
        if (seq === saveSeqRef.current) {
          syncConfigState(persisted);
        }
      } catch (err) {
        trackerRef.current.failSave(
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
    }

    const shouldTranslateNow = nextState === 'always' && !pageState.active;
    const shouldRestoreNow = nextState === 'never' && pageState.active;

    if ((shouldTranslateNow || shouldRestoreNow) && activeTab.id !== undefined) {
      const res = await sendTabCommand(activeTab.id, {
        type: 'margin:cmd:toggle-page',
      });
      if (res.ok) {
        const returnedState = extractDispatchedPageState(res.result);
        if (returnedState) {
          setPageState(returnedState);
        } else {
          setPageState((prev) => ({
            ...prev,
            active: shouldTranslateNow,
          }));
        }
        setCommandNotice({
          text: shouldTranslateNow
            ? lang === 'en'
              ? 'Site set to Always Translate · Bilingual mode enabled'
              : '已设为「此站必翻」并开启当前页面翻译'
            : lang === 'en'
              ? 'Site set to Never Translate · Restored original page'
              : '已设为「此站不翻」并还原网页原文',
        });
      } else if (shouldRestoreNow) {
        setPageState((prev) => ({ ...prev, active: false }));
        setCommandNotice(null);
      } else if (shouldTranslateNow && res.unsupportedPage) {
        setCommandNotice({
          text:
            lang === 'en'
              ? 'This page does not support content script injection.'
              : '当前页面不支持注入翻译脚本',
          isError: true,
        });
      }
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

  const translating = pageState.inFlightBlocks > 0;
  const themeIcon =
    config.uiColorMode === 'night' ? 'moon' : config.uiColorMode === 'system' ? 'auto' : 'sun';

  return (
    <div class="mp-popup-sheet" data-hydrated={hydrated ? 'true' : 'false'}>
      {/* Header: editorial wordmark + live state badge + theme cycler + Studio gear */}
      <header class="mp-popup-header">
        <div class="mp-popup-header-brand">
          <span class="mp-wordmark">{BRAND.name}</span>
          {saveState.status === 'saved' ? (
            <EditorialBadge tone="ok" dataTestId="popup-save-pill">
              {lang === 'en' ? 'Saved' : '已保存'}
            </EditorialBadge>
          ) : pageState.lastError ? (
            <EditorialBadge tone="danger" dataTestId="popup-page-badge">
              {lang === 'en' ? 'Error' : '翻译异常'}
            </EditorialBadge>
          ) : translating ? (
            <EditorialBadge tone="accent" pulse dataTestId="popup-page-badge">
              {lang === 'en'
                ? `Translating · ${pageState.translatedBlocks}`
                : `翻译中 · ${pageState.translatedBlocks}`}
            </EditorialBadge>
          ) : pageState.active ? (
            <EditorialBadge tone="ok" dataTestId="popup-page-badge">
              {lang === 'en'
                ? `Active · ${pageState.translatedBlocks}`
                : `双语已开启${pageState.translatedBlocks > 0 ? ` · ${pageState.translatedBlocks}` : ''}`}
            </EditorialBadge>
          ) : (
            <span class="mp-popup-version">v{BRAND.version}</span>
          )}
        </div>

        <div class="mp-popup-header-actions">
          <button
            type="button"
            class="mp-popup-theme-btn"
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
            <Icon name={themeIcon} />
            <span>{formatThemeCycleLabel(config.uiColorMode, lang)}</span>
          </button>
          <button
            type="button"
            class="mp-icon-btn"
            data-testid="popup-open-settings"
            aria-label={lang === 'en' ? 'Open Settings' : '打开设置'}
            title={
              lang === 'en'
                ? 'Open Margin Studio (options.html)'
                : '打开 Margin Studio 详细设置'
            }
            onClick={() => openOptionsTarget()}
          >
            <Icon name="gear" size={15} />
          </button>
        </div>
      </header>

      {/* Tier 1: Primary page action */}
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
            <span class="mp-popup-hero-label">
              <Icon name={pageState.active ? 'restore' : 'languages'} size={15} />
              <span>
                {pageState.active
                  ? lang === 'en'
                    ? 'Restore Original'
                    : '还原网页原文'
                  : lang === 'en'
                    ? 'Translate Page'
                    : '翻译当前页面'}
              </span>
            </span>
            <kbd class="mp-popup-kbd">Alt+A</kbd>
          </button>

          <button
            type="button"
            class="mp-btn mp-popup-secondary-btn"
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
            <span>{lang === 'en' ? 'Full' : '全文'}</span>
            <kbd class="mp-popup-kbd">Alt+W</kbd>
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

      {/* Tier 2: Reading controls — one grouped surface, hairline rows */}
      <section
        class="mp-popup-card"
        aria-label={lang === 'en' ? 'Reading Preferences' : '阅读与排版偏好'}
      >
        <div class="mp-popup-control-row">
          <label class="mp-popup-control-label" htmlFor="popup-target-lang">
            <Icon name="globe" />
            {lang === 'en' ? 'Target Language' : '目标语言'}
          </label>
          <select
            id="popup-target-lang"
            class="mp-select"
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
            <Icon name="columns" />
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

        <div class="mp-popup-control-row">
          <span class="mp-popup-control-label">
            <Icon name="type" />
            {lang === 'en' ? 'Style' : '译文样式'}
          </span>
          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Translation Theme' : '译文样式'}
            options={themeOptions}
            value={config.webpage.theme}
            onChange={(theme) =>
              void persistUserPatch((d) => {
                d.webpage.theme = theme;
              })
            }
          />
        </div>

        {config.webpage.theme === 'mask' ? (
          <div class="mp-popup-control-row mp-popup-control-row--sub">
            <button
              type="button"
              class="mp-btn mp-btn--ghost mp-btn--sm"
              data-testid="popup-toggle-mask"
              onClick={() => void dispatchTabAction('margin:cmd:toggle-mask')}
            >
              <Icon name="eye" size={13} />
              <span>{lang === 'en' ? 'Reveal Mask' : '显隐遮罩'}</span>
              <kbd class="mp-kbd">Alt+M</kbd>
            </button>
          </div>
        ) : null}
      </section>

      {/* Tier 3: Active channel + quick capabilities + per-site rule */}
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
            <Icon name="route" />
            {lang === 'en' ? 'Channel' : '主力渠道'}
          </span>
          <span class="mp-popup-channel-value">
            <span class="mp-popup-channel-live" aria-hidden="true" />
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
            class="mp-popup-toggle-pill mp-popup-toggle-pill--launch"
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
              <div class="mp-popup-site-meta">
                <span class="mp-popup-site-domain">
                  <Icon name="globe" size={13} />
                  <span class="mp-popup-site-host" title={tabDomain.hostname}>
                    {tabDomain.hostname}
                  </span>
                </span>
                <span
                  class="mp-popup-site-status"
                  data-rule={siteAutoRule}
                  data-testid="popup-site-rule-status"
                >
                  {siteAutoRule === 'follow'
                    ? `${lang === 'en' ? 'Global' : '跟随全局'} ${followModeBadge}`
                    : siteAutoRule === 'always'
                      ? lang === 'en'
                        ? 'Rule: Always'
                        : '规则: 此站必翻'
                      : lang === 'en'
                        ? 'Rule: Never'
                        : '规则: 此站不翻'}
                </span>
              </div>

              <div
                class="mp-popup-site-pills"
                role="radiogroup"
                aria-label={
                  lang === 'en'
                    ? 'Site Auto-Translate Rule'
                    : '当前网站自动翻译规则'
                }
                data-testid="popup-site-rule-group"
              >
                <button
                  type="button"
                  role="radio"
                  class="mp-popup-site-pill"
                  data-testid="popup-site-rule-follow"
                  aria-checked={siteAutoRule === 'follow' ? 'true' : 'false'}
                  onClick={() => void handleSelectSiteAutoRule('follow')}
                >
                  <span>{lang === 'en' ? 'Follow' : '跟随全局'}</span>
                  <span class="mp-popup-site-sub">{followModeBadge}</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  class="mp-popup-site-pill"
                  data-testid="popup-site-rule-always"
                  aria-checked={siteAutoRule === 'always' ? 'true' : 'false'}
                  onClick={() => void handleSelectSiteAutoRule('always')}
                >
                  {lang === 'en' ? 'Always' : '此站必翻'}
                </button>
                <button
                  type="button"
                  role="radio"
                  class="mp-popup-site-pill"
                  data-testid="popup-site-rule-never"
                  aria-checked={siteAutoRule === 'never' ? 'true' : 'false'}
                  onClick={() => void handleSelectSiteAutoRule('never')}
                >
                  {lang === 'en' ? 'Never' : '此站不翻'}
                </button>
              </div>
            </>
          ) : (
            <span class="mp-popup-site-empty">
              <Icon name="lock" size={13} />
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
