import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createDefaultMarginConfig } from '@shared/constants';
import {
  getCapabilityCache,
  getMarginConfig,
  onMarginConfigChanged,
  saveMarginConfig,
} from '@shared/storage';
import type { MarginConfig, ModelCapabilityMap } from '@shared/types';
import { BRAND } from '@shared/brand';
import {
  EditorialBadge,
  Icon,
  PaperShell,
  createSaveTracker,
  useUiColorMode,
  type NavRailItem,
} from '../components';
import { GeneralTab } from './tabs/GeneralTab';
import {
  MigrationDiagnosticsTab,
  type StagedMigrationState,
} from './tabs/MigrationDiagnosticsTab';
import { PromptsGlossaryTab } from './tabs/PromptsGlossaryTab';
import { ProvidersTab } from './tabs/ProvidersTab';
import { ScenesRulesTab } from './tabs/ScenesRulesTab';
import { SiteRulesTab } from './tabs/SiteRulesTab';

export type CanonicalOptionsTabId =
  | 'general'
  | 'providers'
  | 'subtitles'
  | 'prompts'
  | 'rules'
  | 'migration';

export type OptionsTabId = CanonicalOptionsTabId | 'scenes';

export interface OptionsAppProps {
  initialTab?: OptionsTabId;
}

function normalizeTabId(tab?: string | null): CanonicalOptionsTabId {
  if (tab === 'scenes' || tab === 'subtitles') return 'subtitles';
  if (
    tab === 'general' ||
    tab === 'providers' ||
    tab === 'prompts' ||
    tab === 'rules' ||
    tab === 'migration'
  ) {
    return tab;
  }
  return 'general';
}

function resolveInitialTab(explicitTab?: OptionsTabId): CanonicalOptionsTabId {
  if (explicitTab) return normalizeTabId(explicitTab);
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('tab');
    if (fromQuery) return normalizeTabId(fromQuery);
    const fromHash = window.location.hash.replace(/^#/, '');
    if (fromHash) return normalizeTabId(fromHash);
  }
  return 'general';
}

export function OptionsApp({ initialTab }: OptionsAppProps = {}) {
  const [activeTab, setActiveTab] = useState<CanonicalOptionsTabId>(() =>
    resolveInitialTab(initialTab),
  );
  const [draft, setDraft] = useState<MarginConfig>(() => createDefaultMarginConfig());
  const [persistedBaseline, setPersistedBaseline] = useState<MarginConfig | null>(null);
  const [capabilityCache, setCapabilityCache] = useState<ModelCapabilityMap>({});
  const [hydrated, setHydrated] = useState(false);

  // Lifted staged migration state so switching tabs never discards uploaded JSON previews
  const [stagedImport, setStagedImport] = useState<StagedMigrationState>({
    rawImportText: '',
    importError: null,
    importPreview: null,
    importApplied: false,
  });

  const trackerRef = useRef(createSaveTracker());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const hydratedRef = useRef(hydrated);
  hydratedRef.current = hydrated;
  const pendingFlushRef = useRef<(() => void) | null>(null);

  const registerPendingFlush = useCallback((fn: (() => void) | null) => {
    pendingFlushRef.current = fn;
  }, []);

  const [saveState, setSaveState] = useState(() => trackerRef.current.getState());

  useUiColorMode(draft.uiColorMode);

  useEffect(() => {
    const tracker = trackerRef.current;
    const unsubTracker = tracker.subscribe(setSaveState);

    let mounted = true;
    void Promise.all([getMarginConfig(), getCapabilityCache()]).then(([loaded, caps]) => {
      if (!mounted) return;
      tracker.hydrateReadOnly(loaded);
      const cloned = structuredClone(loaded);
      draftRef.current = cloned;
      hydratedRef.current = true;
      setDraft(cloned);
      setPersistedBaseline(structuredClone(loaded));
      setCapabilityCache(caps);
      setHydrated(true);
    });

    const unsubStorage = onMarginConfigChanged((incoming) => {
      if (!mounted) return;
      const wasDirtyBeforeSync = tracker.isDirty(draftRef.current);
      const matchedUserSave = tracker.observePersisted(incoming);
      setPersistedBaseline(structuredClone(incoming));
      if (matchedUserSave || !wasDirtyBeforeSync) {
        const nextClone = structuredClone(incoming);
        draftRef.current = nextClone;
        setDraft(nextClone);
      }
    });

    return () => {
      mounted = false;
      unsubTracker();
      unsubStorage();
      tracker.dispose();
    };
  }, []);

  const mutateDraft = useCallback((mutator: (next: MarginConfig) => void) => {
    if (!hydratedRef.current) return;
    const next = structuredClone(draftRef.current);
    mutator(next);
    draftRef.current = next;
    setDraft(next);
  }, []);

  const isDirty = hydrated && trackerRef.current.isDirty(draft);

  const commitConfigSave = useCallback(async (targetConfig: MarginConfig) => {
    if (!hydratedRef.current) return;
    const normalized = trackerRef.current.beginUserSave(targetConfig);
    draftRef.current = normalized;
    setDraft(normalized);

    try {
      await saveMarginConfig(normalized);
      const persisted = await getMarginConfig();
      const confirmedLatest = trackerRef.current.observePersisted(persisted);
      if (confirmedLatest) {
        const synced = structuredClone(persisted);
        setPersistedBaseline(structuredClone(persisted));
        draftRef.current = synced;
        setDraft(synced);
      }
    } catch (err) {
      trackerRef.current.failSave(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleSaveChanges = useCallback(async () => {
    if (!hydratedRef.current) return;
    pendingFlushRef.current?.();
    await commitConfigSave(draftRef.current);
  }, [commitConfigSave]);

  const handleRevertDraft = () => {
    if (!persistedBaseline) return;
    const reverted = structuredClone(persistedBaseline);
    draftRef.current = reverted;
    setDraft(reverted);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        pendingFlushRef.current?.();
        if (trackerRef.current.isDirty(draftRef.current)) {
          void commitConfigSave(draftRef.current);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commitConfigSave]);

  const lang = draft.interfaceLang;

  const navItems: readonly NavRailItem<CanonicalOptionsTabId>[] = useMemo(
    () => [
      {
        id: 'general',
        group: lang === 'en' ? 'Core' : '核心',
        icon: 'book',
        label: lang === 'en' ? 'Reading & General' : '常规与阅读',
        subtitle: lang === 'en' ? 'Languages, Style & Routing' : '语言、排版样式与渠道路由',
      },
      {
        id: 'providers',
        group: lang === 'en' ? 'Core' : '核心',
        icon: 'cpu',
        label: lang === 'en' ? 'AI & Translation Channels' : 'AI 与翻译渠道',
        subtitle: lang === 'en' ? 'Endpoints, Keys & Models' : '接口、密钥池与连通测试',
      },
      {
        id: 'subtitles',
        group: lang === 'en' ? 'Craft' : '体验与精译',
        icon: 'film',
        label: lang === 'en' ? 'Subtitles & Interaction' : '视频字幕与交互',
        subtitle: lang === 'en' ? '16:9 Preview, Input & Hover' : '字幕比例预览、三击空格与划词',
      },
      {
        id: 'prompts',
        group: lang === 'en' ? 'Craft' : '体验与精译',
        icon: 'sparkle',
        label: lang === 'en' ? 'Prompts & Glossary' : '提示词与术语库',
        subtitle: lang === 'en' ? '<yaml>, %% & Keep-Terms' : '自定义助手与原词保护',
      },
      {
        id: 'rules',
        group: lang === 'en' ? 'System' : '规则与维护',
        icon: 'shield',
        label: lang === 'en' ? 'Site URL Rules' : '站点规则',
        subtitle: lang === 'en' ? 'Auto-Translate & Exclusions' : '白名单与排除域名规则',
      },
      {
        id: 'migration',
        group: lang === 'en' ? 'System' : '规则与维护',
        icon: 'layers',
        label: lang === 'en' ? 'Migration & Diagnostics' : '配置迁移与诊断',
        subtitle: lang === 'en' ? '1-Click Import & Logs' : '一键导入、备份导出与日志',
      },
    ],
    [lang],
  );

  const isMacPlatform =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform ?? '');
  const saveShortcut = isMacPlatform ? '⌘S' : 'Ctrl+S';

  const activeNavIndex = Math.max(
    0,
    navItems.findIndex((item) => item.id === activeTab),
  );
  const activeNavItem = navItems[activeNavIndex];

  const hasUnappliedImport = Boolean(
    stagedImport.importPreview && !stagedImport.importApplied,
  );

  const headerActions = (
    <>
      {hasUnappliedImport && activeTab !== 'migration' ? (
        <button
          type="button"
          class="mp-btn mp-btn--sm mp-btn--ghost"
          style={{ color: 'var(--accent-ink)' }}
          onClick={() => setActiveTab('migration')}
        >
          <span class="mp-dot" aria-hidden="true" />
          {lang === 'en' ? '1 Import Pending Apply →' : '有待应用的导入配置 →'}
        </button>
      ) : null}

      <div class="mp-savebar" aria-live="polite">
        {saveState.status === 'saving' ? (
          <EditorialBadge tone="accent" pulse dataTestId="options-save-status">
            {lang === 'en' ? 'Saving…' : '正在保存…'}
          </EditorialBadge>
        ) : saveState.status === 'error' ? (
          <EditorialBadge tone="danger" dataTestId="options-save-status">
            {lang === 'en' ? 'Save Failed' : `保存失败: ${saveState.errorMessage ?? ''}`}
          </EditorialBadge>
        ) : isDirty ? (
          <EditorialBadge tone="accent" dataTestId="options-unsaved-pill">
            {lang === 'en' ? 'Unsaved edits' : '有未保存更改'}
          </EditorialBadge>
        ) : saveState.status === 'saved' ? (
          <EditorialBadge tone="ok" dataTestId="options-save-status">
            {lang === 'en' ? 'Saved' : '已保存'}
          </EditorialBadge>
        ) : null}

        {isDirty && persistedBaseline ? (
          <button
            type="button"
            class="mp-btn mp-btn--ghost mp-btn--sm"
            onClick={handleRevertDraft}
          >
            <Icon name="restore" size={13} />
            {lang === 'en' ? 'Revert' : '放弃修改'}
          </button>
        ) : null}

        <button
          type="button"
          class="mp-btn mp-btn--solid"
          data-testid="options-save-btn"
          title={lang === 'en' ? `Save (${saveShortcut})` : `保存设置 (${saveShortcut})`}
          disabled={!hydrated || !isDirty || saveState.status === 'saving'}
          onClick={() => void handleSaveChanges()}
        >
          {lang === 'en' ? 'Save Changes' : '保存设置'}
          <kbd class="mp-kbd">{saveShortcut}</kbd>
        </button>
      </div>
    </>
  );

  const masthead = activeNavItem ? (
    <header class="mp-tab-masthead">
      <span class="mp-tab-masthead-eyebrow">
        {`${String(activeNavIndex + 1).padStart(2, '0')} · ${activeNavItem.group ?? 'Studio'}`}
      </span>
      <h1 class="mp-tab-masthead-title">{activeNavItem.label}</h1>
      {activeNavItem.subtitle ? (
        <p class="mp-tab-masthead-desc">{activeNavItem.subtitle}</p>
      ) : null}
    </header>
  ) : null;

  const navFooter = (
    <>
      <div class="mp-nav-footer-row">
        <span>Margin Studio</span>
        <span class="mp-pill mp-pill--mono">v{BRAND.version}</span>
      </div>
      <div class="mp-nav-footer-row">
        <span>{lang === 'en' ? 'Save draft' : '保存草稿'}</span>
        <kbd class="mp-kbd">{saveShortcut}</kbd>
      </div>
    </>
  );

  return (
    <div data-hydrated={hydrated ? 'true' : 'false'}>
      <PaperShell
        subtitle={
          lang === 'en'
            ? 'Quiet Paper Editorial Settings Studio'
            : '编辑部式双语阅读与翻译设置工作台'
        }
        headerActions={headerActions}
        navItems={navItems}
        activeNav={activeTab}
        navFooter={navFooter}
        masthead={masthead}
        onSelectNav={(nextTab) => {
          pendingFlushRef.current?.();
          setActiveTab(nextTab);
        }}
      >
        {activeTab === 'general' ? (
          <GeneralTab draft={draft} onMutate={mutateDraft} />
        ) : null}

        {activeTab === 'providers' ? (
          <ProvidersTab
            draft={draft}
            capabilityCache={capabilityCache}
            onRefreshCapabilityCache={setCapabilityCache}
            onMutate={mutateDraft}
            registerPendingFlush={registerPendingFlush}
            onEnsureSavedBeforeTest={async () => {
              pendingFlushRef.current?.();
              if (trackerRef.current.isDirty(draftRef.current)) {
                await commitConfigSave(draftRef.current);
              }
            }}
          />
        ) : null}

        {activeTab === 'subtitles' ? (
          <ScenesRulesTab draft={draft} onMutate={mutateDraft} />
        ) : null}

        {activeTab === 'prompts' ? (
          <PromptsGlossaryTab
            draft={draft}
            onMutate={mutateDraft}
            registerPendingFlush={registerPendingFlush}
            onEnsureSavedBeforeTest={async () => {
              pendingFlushRef.current?.();
              if (trackerRef.current.isDirty(draftRef.current)) {
                await commitConfigSave(draftRef.current);
              }
            }}
          />
        ) : null}

        {activeTab === 'rules' ? (
          <SiteRulesTab draft={draft} onMutate={mutateDraft} />
        ) : null}

        {activeTab === 'migration' ? (
          <MigrationDiagnosticsTab
            draft={draft}
            capabilityCache={capabilityCache}
            onRefreshCapabilityCache={setCapabilityCache}
            stagedImport={stagedImport}
            onStagedImportChange={setStagedImport}
            onApplyImportedConfig={async (importedConfig) => {
              await commitConfigSave(importedConfig);
            }}
          />
        ) : null}
      </PaperShell>
    </div>
  );
}
