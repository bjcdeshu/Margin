import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createDefaultMarginConfig } from '@shared/constants';
import {
  getCapabilityCache,
  getMarginConfig,
  onMarginConfigChanged,
  saveMarginConfig,
} from '@shared/storage';
import type { MarginConfig, ModelCapabilityMap } from '@shared/types';
import {
  PaperShell,
  StatusPill,
  createSaveTracker,
  useUiColorMode,
  type NavRailItem,
} from '../components';
import { GeneralTab } from './tabs/GeneralTab';
import { MigrationDiagnosticsTab } from './tabs/MigrationDiagnosticsTab';
import { PromptsGlossaryTab } from './tabs/PromptsGlossaryTab';
import { ProvidersTab } from './tabs/ProvidersTab';
import { ScenesRulesTab } from './tabs/ScenesRulesTab';

export type OptionsTabId =
  | 'general'
  | 'providers'
  | 'prompts'
  | 'scenes'
  | 'migration';

export interface OptionsAppProps {
  initialTab?: OptionsTabId;
}

export function OptionsApp({ initialTab = 'general' }: OptionsAppProps = {}) {
  const [activeTab, setActiveTab] = useState<OptionsTabId>(initialTab);
  const [draft, setDraft] = useState<MarginConfig>(() => createDefaultMarginConfig());
  const [persistedBaseline, setPersistedBaseline] = useState<MarginConfig | null>(null);
  const [capabilityCache, setCapabilityCache] = useState<ModelCapabilityMap>({});
  const [hydrated, setHydrated] = useState(false);

  const trackerRef = useRef(createSaveTracker());
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const [saveState, setSaveState] = useState(() => trackerRef.current.getState());

  useUiColorMode(draft.uiColorMode);

  useEffect(() => {
    const tracker = trackerRef.current;
    const unsubTracker = tracker.subscribe(setSaveState);

    let mounted = true;
    void Promise.all([getMarginConfig(), getCapabilityCache()]).then(([loaded, caps]) => {
      if (!mounted) return;
      tracker.hydrateReadOnly(loaded);
      setDraft(loaded);
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
        setDraft(structuredClone(incoming));
      }
    });

    return () => {
      mounted = false;
      unsubTracker();
      unsubStorage();
      tracker.dispose();
    };
  }, []);

  const isDirty = hydrated && trackerRef.current.isDirty(draft);

  const commitConfigSave = useCallback(async (targetConfig: MarginConfig) => {
    const normalized = trackerRef.current.beginUserSave(targetConfig);
    if (!normalized) return;

    setDraft(normalized);
    try {
      await saveMarginConfig(normalized);
      const persisted = await getMarginConfig();
      trackerRef.current.observePersisted(persisted);
      setPersistedBaseline(structuredClone(persisted));
      setDraft(structuredClone(persisted));
    } catch (err) {
      trackerRef.current.failSave(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleSaveChanges = useCallback(async () => {
    await commitConfigSave(draftRef.current);
  }, [commitConfigSave]);

  const handleRevertDraft = () => {
    if (!persistedBaseline) return;
    setDraft(structuredClone(persistedBaseline));
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (trackerRef.current.isDirty(draftRef.current)) {
          void handleSaveChanges();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSaveChanges]);

  const mutateDraft = useCallback((mutator: (next: MarginConfig) => void) => {
    setDraft((prev) => {
      const next = structuredClone(prev);
      mutator(next);
      return next;
    });
  }, []);

  const lang = draft.interfaceLang;

  const navItems: readonly NavRailItem<OptionsTabId>[] = useMemo(
    () => [
      {
        id: 'general',
        label: lang === 'en' ? 'General & Appearance' : '常规与外观',
        subtitle: lang === 'en' ? 'Theme & Scene Routing' : '主题、语言与场景路由',
      },
      {
        id: 'providers',
        label: lang === 'en' ? 'AI & Translation Channels' : 'AI 与翻译渠道',
        subtitle: lang === 'en' ? 'Models, Keys & Temperature' : '端点、密钥与温度防呆',
      },
      {
        id: 'prompts',
        label: lang === 'en' ? 'Prompts & Glossary' : '提示词与术语库',
        subtitle: lang === 'en' ? '<yaml>, %% & Keep-Terms' : '自定义助手与原词保护',
      },
      {
        id: 'scenes',
        label: lang === 'en' ? 'Input, Subtitles & Rules' : '输入·字幕·站点规则',
        subtitle: lang === 'en' ? 'Triple-Space, PiP & URLs' : '三击空格、双语字幕与排除',
      },
      {
        id: 'migration',
        label: lang === 'en' ? 'Migration & Diagnostics' : '配置迁移与诊断',
        subtitle: lang === 'en' ? '1-Click Import & Logs' : '旧版导入、脱敏导出与日志',
      },
    ],
    [lang],
  );

  const headerActions = (
    <>
      {saveState.status === 'saving' ? (
        <StatusPill tone="accent" dataTestId="options-save-status">
          {lang === 'en' ? 'Saving…' : '正在保存…'}
        </StatusPill>
      ) : saveState.status === 'error' ? (
        <StatusPill tone="danger" dataTestId="options-save-status">
          {lang === 'en' ? 'Save Failed' : `保存失败: ${saveState.errorMessage ?? ''}`}
        </StatusPill>
      ) : isDirty ? (
        <StatusPill tone="accent" dataTestId="options-unsaved-pill">
          {lang === 'en' ? 'Unsaved edits' : '有未保存更改'}
        </StatusPill>
      ) : saveState.status === 'saved' ? (
        <StatusPill tone="ok" dataTestId="options-save-status">
          {lang === 'en' ? 'Saved' : '已保存'}
        </StatusPill>
      ) : null}

      {isDirty && persistedBaseline ? (
        <button type="button" class="mp-btn mp-btn--sm" onClick={handleRevertDraft}>
          {lang === 'en' ? 'Revert' : '放弃修改'}
        </button>
      ) : null}

      <button
        type="button"
        class="mp-btn mp-btn--solid"
        data-testid="options-save-btn"
        disabled={!isDirty || saveState.status === 'saving'}
        onClick={() => void handleSaveChanges()}
      >
        {lang === 'en' ? 'Save Changes' : '保存设置'}
      </button>
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
        onSelectNav={setActiveTab}
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
            onEnsureSavedBeforeTest={async () => {
              if (trackerRef.current.isDirty(draftRef.current)) {
                await commitConfigSave(draftRef.current);
              }
            }}
          />
        ) : null}

        {activeTab === 'prompts' ? (
          <PromptsGlossaryTab draft={draft} onMutate={mutateDraft} />
        ) : null}

        {activeTab === 'scenes' ? (
          <ScenesRulesTab draft={draft} onMutate={mutateDraft} />
        ) : null}

        {activeTab === 'migration' ? (
          <MigrationDiagnosticsTab
            draft={draft}
            capabilityCache={capabilityCache}
            onRefreshCapabilityCache={setCapabilityCache}
            onApplyImportedConfig={async (importedConfig) => {
              await commitConfigSave(importedConfig);
            }}
          />
        ) : null}
      </PaperShell>
    </div>
  );
}
