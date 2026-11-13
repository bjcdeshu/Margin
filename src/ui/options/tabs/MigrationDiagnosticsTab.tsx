import { useEffect, useState } from 'preact/hooks';
import { exportMarginConfig, importLegacyConfig } from '@core/migration';
import { BRAND } from '@shared/brand';
import { resolveProviderIdForScene } from '@shared/constants';
import { sendRuntimeMessage } from '@shared/messaging';
import {
  clearCapabilityCache,
  clearDiagnosticsLog,
  getCapabilityCache,
  getDiagnosticsLog,
} from '@shared/storage';
import type {
  DiagnosticSnapshot,
  LegacyImportResult,
  MarginConfig,
  ModelCapabilityMap,
} from '@shared/types';
import {
  EditorialBadge,
  EmptyState,
  FieldRow,
  Icon,
  Metric,
  SettingGroup,
  StatusPill,
} from '../../components';

export interface StagedMigrationState {
  rawImportText: string;
  importError: string | null;
  importPreview: LegacyImportResult | null;
  importApplied: boolean;
}

export interface MigrationDiagnosticsTabProps {
  draft: MarginConfig;
  capabilityCache: ModelCapabilityMap;
  onRefreshCapabilityCache: (next: ModelCapabilityMap) => void;
  onApplyImportedConfig: (importedConfig: MarginConfig) => Promise<void>;
  stagedImport?: StagedMigrationState;
  onStagedImportChange?: (
    updater:
      | StagedMigrationState
      | ((prev: StagedMigrationState) => StagedMigrationState),
  ) => void;
}

async function copyTextSafe(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  if (typeof document !== 'undefined') {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : true;
    ta.remove();
    return ok;
  }
  return false;
}

export function MigrationDiagnosticsTab({
  draft,
  capabilityCache,
  onRefreshCapabilityCache,
  onApplyImportedConfig,
  stagedImport,
  onStagedImportChange,
}: MigrationDiagnosticsTabProps) {
  const lang = draft.interfaceLang;

  // Fallback local state when rendered standalone without lifted state
  const [localStaged, setLocalStaged] = useState<StagedMigrationState>({
    rawImportText: '',
    importError: null,
    importPreview: null,
    importApplied: false,
  });

  const currentStaged = stagedImport ?? localStaged;
  const updateStaged = onStagedImportChange ?? setLocalStaged;
  const { rawImportText, importError, importPreview, importApplied } =
    currentStaged;

  // Exporter state
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [exportedPreview, setExportedPreview] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  // Diagnostics state
  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot[]>([]);
  const [diagNotice, setDiagNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getDiagnosticsLog().then((logs) => {
      if (active) setDiagnostics(logs);
    });
    return () => {
      active = false;
    };
  }, []);

  const parseImportInput = (jsonText: string) => {
    const trimmed = jsonText.trim();
    if (!trimmed) {
      updateStaged((prev) => ({
        ...prev,
        rawImportText: jsonText,
        importApplied: false,
        importPreview: null,
        importError:
          lang === 'en'
            ? 'Please paste or choose a JSON configuration file.'
            : '请先粘贴或选择配置文件 JSON。',
      }));
      return;
    }
    try {
      const result = importLegacyConfig(trimmed, draft);
      updateStaged({
        rawImportText: jsonText,
        importError: null,
        importPreview: result,
        importApplied: false,
      });
    } catch (err) {
      updateStaged({
        rawImportText: jsonText,
        importError: err instanceof Error ? err.message : String(err),
        importPreview: null,
        importApplied: false,
      });
    }
  };

  const handleFileUpload = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      parseImportInput(content);
    };
    reader.readAsText(file);
  };

  const handleConfirmApplyImport = async () => {
    if (!importPreview) return;
    await onApplyImportedConfig(importPreview.config);
    updateStaged((prev) => ({
      ...prev,
      importApplied: true,
    }));
  };

  const handleGenerateExport = async (downloadFile: boolean) => {
    const json = exportMarginConfig(draft, { includeSecrets });
    setExportedPreview(json);

    if (downloadFile && typeof document !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const suffix = includeSecrets ? 'full-backup' : 'redacted';
      link.href = url;
      link.download = `margin-config-${suffix}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExportStatus(
        lang === 'en' ? 'Downloaded configuration JSON' : '已下载配置文件 JSON',
      );
    } else {
      await copyTextSafe(json);
      setExportStatus(
        includeSecrets
          ? lang === 'en'
            ? 'Copied full backup JSON (includes API keys)'
            : '已复制完整备份 JSON（含 API 密钥）'
          : lang === 'en'
            ? 'Copied redacted configuration JSON (zero API keys)'
            : '已复制脱敏配置 JSON（已剥离所有密钥）',
      );
    }
  };

  const handleCopyDiagnosticReport = async () => {
    const latestLogs = await getDiagnosticsLog();
    const latestCache = await getCapabilityCache();
    setDiagnostics(latestLogs);
    onRefreshCapabilityCache(latestCache);

    const report = {
      schemaVersion: BRAND.diagnosticSchemaVersion,
      product: BRAND.name,
      version: BRAND.version,
      exportedAt: new Date().toISOString(),
      capabilityCache: latestCache,
      diagnostics: latestLogs,
    };
    await copyTextSafe(JSON.stringify(report, null, 2));
    setDiagNotice(
      lang === 'en'
        ? 'Copied zero-secret diagnostic JSON to clipboard'
        : '已复制脱敏诊断报告 JSON 到剪贴板',
    );
  };

  const handleClearCapabilityCache = async () => {
    await clearCapabilityCache();
    onRefreshCapabilityCache({});
    setDiagNotice(
      lang === 'en'
        ? 'Cleared model capability cache'
        : '已清空模型能力缓存（400 温度拒绝记忆）',
    );
  };

  const handleClearDiagnostics = async () => {
    await clearDiagnosticsLog();
    setDiagnostics([]);
    setDiagNotice(lang === 'en' ? 'Cleared diagnostics log' : '已清空诊断日志');
  };

  const handleClearTranslationCache = async () => {
    try {
      await sendRuntimeMessage({ type: 'margin:clear-translation-cache' });
    } catch {
      // Ignore when background runtime is unavailable (e.g. standalone preview/tests)
    }
    setDiagNotice(
      lang === 'en'
        ? 'Cleared background & page translation cache'
        : '已清空后台与页面译文缓存',
    );
  };

  const previewPrimaryId = importPreview
    ? resolveProviderIdForScene(
        'webpage',
        importPreview.config.routing,
        importPreview.config.providers,
      )
    : null;
  const previewPrimaryProvider =
    importPreview && previewPrimaryId
      ? importPreview.config.providers[previewPrimaryId]
      : undefined;

  const en = lang === 'en';
  const capabilityCount = Object.keys(capabilityCache).length;
  const okCount = diagnostics.filter((snap) => snap.kind === 'ok').length;
  const latencySamples = diagnostics
    .map((snap) => snap.latencyMs)
    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));
  const medianLatency =
    latencySamples.length > 0
      ? [...latencySamples].sort((a, b) => a - b)[Math.floor(latencySamples.length / 2)]
      : null;

  return (
    <div>
      {/* Section 1: 1-Click Legacy JSON Importer */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {en
                ? '1-Click Legacy JSON Importer'
                : '一键导入配置 (Immersive / myAItranslate / Margin JSON)'}
            </h2>
            <p class="mp-section-desc">
              {en
                ? 'Imports channels, custom <yaml>/%% assistants, glossary, and inherit routing while repairing "temperatre" typos.'
                : '自动迁移翻译渠道、Aloxaf <yaml>/%% 助手、术语库与场景联动，修复 "temperatre" 拼写并剔除悬浮球冗余项。'}
            </p>
          </div>
        </div>

        {/* Immediate Top Summary + Apply CTA (Zero scrolling required after file upload/parse!) */}
        {importPreview ? (
          <div
            class="mp-card mp-audit-card"
            data-state={importApplied ? 'applied' : 'pending'}
            data-testid="import-audit-summary"
          >
            <div class="mp-audit-head">
              <div class="mp-row">
                <span class="mp-audit-glyph" aria-hidden="true">
                  <Icon name={importApplied ? 'check' : 'shield'} size={14} />
                </span>
                <strong class="mp-audit-title">
                  {importApplied
                    ? en
                      ? 'Import Audit Summary (Applied)'
                      : '配置迁移审计摘要（已正式应用）'
                    : en
                      ? 'Import Audit Summary (Pending Apply)'
                      : '配置迁移审计摘要（待确认应用）'}
                </strong>
                {!importApplied ? (
                  <StatusPill tone="accent" dataTestId="import-pending-warning">
                    {en
                      ? 'Not yet active — click Apply Now'
                      : '尚未写入生效 · 请点击右侧「立即应用导入配置」'}
                  </StatusPill>
                ) : (
                  <StatusPill tone="ok">{en ? 'Active in Browser' : '已写入浏览器生效'}</StatusPill>
                )}
              </div>

              <button
                type="button"
                class={importApplied ? 'mp-btn' : 'mp-btn mp-btn--solid'}
                data-testid="apply-import-btn"
                onClick={() => void handleConfirmApplyImport()}
              >
                <Icon name={importApplied ? 'refresh' : 'download'} size={13} />
                {importApplied
                  ? en
                    ? 'Re-apply Imported Config'
                    : '已应用（点击可重新写入）'
                  : en
                    ? 'Apply Imported Config Now'
                    : '立即应用导入配置'}
              </button>
            </div>

            {/* Key Stats */}
            <div class="mp-metric-grid mp-audit-metrics">
              <Metric
                icon="cpu"
                label={en ? 'Providers' : '导入渠道'}
                value={importPreview.stats.providersImported}
              />
              <Metric
                icon="sparkle"
                label={en ? 'Assistants' : '导入助手'}
                value={importPreview.stats.assistantsImported}
              />
              <Metric
                icon="book"
                label={en ? 'Glossary' : '术语条目'}
                value={importPreview.stats.glossaryEntriesImported}
              />
              <Metric
                icon="check"
                label={en ? 'Normalized Fixes' : '自动规范化修复'}
                value={importPreview.stats.normalizedFields}
              />
            </div>

            {/* Scene Routing & Ignored Keys Preview */}
            <dl class="mp-kv">
              <dt>{en ? 'Primary Routing' : '解析后主服务路由'}</dt>
              <dd>
                <span class="mp-mono mp-kv-strong">
                  webpage →{' '}
                  {previewPrimaryProvider
                    ? `${previewPrimaryProvider.name} (${previewPrimaryProvider.model})`
                    : previewPrimaryId}
                </span>
              </dd>
              <dt>{en ? 'Scene Routes' : '场景路由'}</dt>
              <dd>
                <span class="mp-mono">
                  input={importPreview.config.routing.input}, subtitle=
                  {importPreview.config.routing.subtitle}, image={importPreview.config.routing.image}
                </span>
              </dd>
              {importPreview.stats.ignoredLegacyKeys.length > 0 ? (
                <>
                  <dt>{en ? 'Dropped Legacy Clutter' : '已忽略旧版悬浮球/侧栏冗余键'}</dt>
                  <dd>
                    <span class="mp-mono">{importPreview.stats.ignoredLegacyKeys.join(', ')}</span>
                  </dd>
                </>
              ) : null}
            </dl>

            {/* Collapsible Detailed Audit Log Entries so CTA stays concise */}
            {importPreview.audit.length > 0 ? (
              <details class="mp-audit-details">
                <summary class="mp-audit-summary">
                  <Icon name="chevron-right" size={12} class="mp-audit-chevron" />
                  <span>
                    {en
                      ? `View detailed audit entries (${importPreview.audit.length})`
                      : `展开查看详细迁移审计明细 (${importPreview.audit.length} 条)`}
                  </span>
                </summary>
                <div class="mp-flat-list mp-audit-list">
                  {importPreview.audit.map((item, idx) => (
                    <div key={idx} class="mp-flat-item mp-audit-item">
                      <StatusPill
                        tone={
                          item.level === 'warning'
                            ? 'danger'
                            : item.level === 'normalized'
                              ? 'ok'
                              : 'mono'
                        }
                      >
                        {item.level}
                      </StatusPill>
                      <span>{item.message}</span>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        {importError ? (
          <div class="mp-editorial-note mp-editorial-note--danger mp-row mp-row--tight">
            <StatusPill tone="danger">{en ? 'Parse Error' : '解析错误'}</StatusPill>{' '}
            <span class="mp-grow">{importError}</span>
          </div>
        ) : null}

        <div class="mp-code-frame">
          <div class="mp-code-frame-head">
            <span class="mp-frame-label">
              <Icon name="upload" size={12} />
              <span>{en ? 'Choose JSON File or Paste Below' : '选择 JSON 配置文件或直接粘贴'}</span>
            </span>
            <input
              type="file"
              class="mp-file-input"
              accept=".json,application/json"
              aria-label={en ? 'Import Legacy JSON File' : '选择旧版 JSON 配置文件'}
              onChange={(e) => {
                const file = (e.currentTarget as HTMLInputElement).files?.[0];
                handleFileUpload(file);
              }}
            />
          </div>
          <textarea
            class="mp-textarea mp-textarea--mono"
            data-testid="legacy-json-textarea"
            placeholder='{"translationServices": ..., "customAiAssistants": ...}'
            value={rawImportText}
            onInput={(e) => {
              const text = (e.currentTarget as HTMLTextAreaElement).value;
              updateStaged((prev) => ({
                ...prev,
                rawImportText: text,
              }));
            }}
          />
          <div class="mp-code-frame-foot">
            <span class="mp-frame-hint mp-tnum">
              {rawImportText.trim()
                ? en
                  ? `${rawImportText.length.toLocaleString()} chars`
                  : `${rawImportText.length.toLocaleString()} 字符`
                : 'Immersive · myAItranslate · Margin'}
            </span>
            <button
              type="button"
              class="mp-btn mp-btn--solid mp-btn--sm"
              data-testid="parse-legacy-json-btn"
              onClick={() => parseImportInput(rawImportText)}
            >
              <Icon name="search" size={12} />
              {en ? 'Preview Import & Audit' : '解析并预览迁移报告'}
            </button>
          </div>
        </div>
      </section>

      {/* Section 2: Export Configuration */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {en ? 'Export Configuration' : '导出配置与本机备份'}
            </h2>
            <p class="mp-section-desc">
              {en
                ? 'Redacted export strips all API keys by default so you can share setups safely.'
                : '默认导出脱敏配置（自动清空 apiKeys）；仅在勾选下方选项时导出含密钥的完整备份。'}
            </p>
          </div>
          <StatusPill tone={includeSecrets ? 'danger' : 'ok'}>
            {includeSecrets
              ? en
                ? 'Includes keys'
                : '含密钥'
              : en
                ? 'Redacted'
                : '已脱敏'}
          </StatusPill>
        </div>

        <SettingGroup>
          <FieldRow
            label={en ? 'Include API Keys for Local Backup' : '包含 API 密钥用于本机备份'}
            hint={
              includeSecrets
                ? en
                  ? 'Caution: exported JSON will contain plaintext API keys. Keep strictly private.'
                  : '注意：勾选后导出的 JSON 含明文 API 密钥，仅供本机或私密迁移备份，请勿公开分享。'
                : en
                  ? 'Unchecked (default): exports safe redacted configuration without API keys.'
                  : '未勾选（默认）：导出零密钥脱敏配置，可安全分享。'
            }
          >
            <input
              type="checkbox"
              class="mp-checkbox"
              data-testid="export-include-secrets-checkbox"
              checked={includeSecrets}
              onChange={(e) => {
                setIncludeSecrets((e.currentTarget as HTMLInputElement).checked);
                setExportedPreview(null);
              }}
            />
          </FieldRow>
        </SettingGroup>

        <div class="mp-row mp-action-row">
          <button
            type="button"
            class="mp-btn mp-btn--solid"
            data-testid="export-copy-btn"
            onClick={() => void handleGenerateExport(false)}
          >
            <Icon name={includeSecrets ? 'lock' : 'shield'} size={13} />
            {includeSecrets
              ? en
                ? 'Copy Full Backup JSON'
                : '复制完整备份配置'
              : en
                ? 'Export Redacted Config (Copy)'
                : '导出脱敏配置'}
          </button>

          <button type="button" class="mp-btn" onClick={() => void handleGenerateExport(true)}>
            <Icon name="download" size={13} />
            {en ? 'Download .json File' : '下载 .json 文件'}
          </button>

          {exportStatus ? (
            <EditorialBadge tone="ok">{exportStatus}</EditorialBadge>
          ) : null}
        </div>

        {exportedPreview ? (
          <div class="mp-code-frame mp-export-frame">
            <div class="mp-code-frame-head">
              <span class="mp-frame-label">
                <Icon name="file" size={12} />
                <span>{en ? 'JSON preview' : 'JSON 预览'}</span>
              </span>
              <span class="mp-row mp-row--tight">
                <span class="mp-pill mp-pill--mono">
                  {exportedPreview.length.toLocaleString()} {en ? 'chars' : '字符'}
                </span>
                <StatusPill tone={includeSecrets ? 'danger' : 'ok'}>
                  {includeSecrets ? (en ? 'full backup' : '完整备份') : en ? 'redacted' : '脱敏'}
                </StatusPill>
              </span>
            </div>
            <textarea
              readOnly
              class="mp-textarea mp-textarea--mono"
              data-testid="export-json-preview"
              value={exportedPreview}
            />
          </div>
        ) : null}
      </section>

      {/* Section 3: Zero-Secret Diagnostics Log */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {en ? 'Zero-Secret Diagnostics Log' : '零密钥脱敏诊断与能力缓存'}
            </h2>
            <p class="mp-section-desc">
              {en
                ? 'Inspect HTTP statuses, latency, and temperature traces without ever recording prompts or API keys.'
                : '记录每次请求的端点路径、延迟、温度策略轨迹 (temperatureTrace) 与 400 自动剥离缓存，绝不记录密钥或正文。'}
            </p>
          </div>
          <button
            type="button"
            class="mp-btn mp-btn--solid"
            data-testid="copy-diagnostics-btn"
            onClick={() => void handleCopyDiagnosticReport()}
          >
            <Icon name="pulse" size={13} />
            {en ? 'Copy Redacted Diagnostic JSON' : '复制脱敏诊断报告 JSON'}
          </button>
        </div>

        <div class="mp-card mp-diag-card">
          <div class="mp-metric-grid">
            <Metric icon="pulse" label={en ? 'Snapshots' : '诊断快照'} value={diagnostics.length} />
            <Metric
              icon="check"
              label={en ? 'Succeeded' : '成功'}
              value={okCount}
              unit={diagnostics.length > 0 ? `/ ${diagnostics.length}` : undefined}
            />
            <Metric
              icon="bolt"
              label={en ? 'Median latency' : '延迟中位数'}
              value={medianLatency ?? '—'}
              unit={medianLatency !== null ? 'ms' : undefined}
            />
            <Metric
              icon="database"
              label={en ? 'Capability cache' : '能力缓存'}
              value={capabilityCount}
            />
          </div>
          <div class="mp-diag-actions">
            <button
              type="button"
              class="mp-btn mp-btn--sm"
              onClick={() => void handleClearTranslationCache()}
            >
              <Icon name="refresh" size={12} />
              {en ? 'Clear Translation Cache' : '清空译文缓存'}
            </button>
            <button
              type="button"
              class="mp-btn mp-btn--sm"
              onClick={() => void handleClearCapabilityCache()}
            >
              <Icon name="database" size={12} />
              {en
                ? `Clear Capability Cache (${capabilityCount})`
                : `清空能力缓存 (${capabilityCount})`}
            </button>
            <button
              type="button"
              class="mp-btn mp-btn--ghost mp-btn--sm"
              onClick={() => void handleClearDiagnostics()}
            >
              <Icon name="trash" size={12} />
              {en ? 'Clear Log' : '清空日志'}
            </button>
          </div>
        </div>

        {diagNotice ? (
          <div class="mp-editorial-note mp-editorial-note--ok">{diagNotice}</div>
        ) : null}

        {diagnostics.length === 0 ? (
          <div class="mp-diag-empty">
            <EmptyState title={en ? 'No diagnostic entries recorded yet.' : '暂无最近诊断记录'}>
              {en
                ? 'Run “Test Connection” on a channel or translate a page to see redacted snapshots here.'
                : '点击渠道页「测试连接」或触发翻译后将在此显示脱敏快照。'}
            </EmptyState>
          </div>
        ) : (
          <div class="mp-flat-list mp-diag-list">
            {diagnostics.map((snap, idx) => (
              <div key={`${snap.time}-${idx}`} class="mp-flat-item mp-diag-row">
                <span
                  class={snap.kind === 'ok' ? 'mp-diag-dot mp-diag-dot--ok' : 'mp-diag-dot mp-diag-dot--danger'}
                  aria-hidden="true"
                />
                <StatusPill tone={snap.kind === 'ok' ? 'ok' : 'danger'}>
                  {snap.kind} {snap.httpStatus ? `(${snap.httpStatus})` : ''}
                </StatusPill>
                <span class="mp-mono mp-diag-provider">
                  {snap.provider.id} · {snap.provider.model}
                </span>
                <StatusPill tone="mono">{snap.parameters.temperatureTrace}</StatusPill>
                <span class="mp-diag-meta mp-tnum">
                  {snap.scene} · {snap.latencyMs}ms
                </span>
                {snap.sanitizedError ? (
                  <div class="mp-diag-error mp-mono">{snap.sanitizedError}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
