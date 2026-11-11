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
import { FieldRow, StatusPill } from '../../components';

export interface MigrationDiagnosticsTabProps {
  draft: MarginConfig;
  capabilityCache: ModelCapabilityMap;
  onRefreshCapabilityCache: (next: ModelCapabilityMap) => void;
  onApplyImportedConfig: (importedConfig: MarginConfig) => Promise<void>;
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
}: MigrationDiagnosticsTabProps) {
  const lang = draft.interfaceLang;

  // Legacy Importer state
  const [rawImportText, setRawImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<LegacyImportResult | null>(null);
  const [importApplied, setImportApplied] = useState(false);

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
    setImportError(null);
    setImportApplied(false);
    const trimmed = jsonText.trim();
    if (!trimmed) {
      setImportPreview(null);
      setImportError(
        lang === 'en' ? 'Please paste or choose a JSON configuration file.' : '请先粘贴或选择配置文件 JSON。',
      );
      return;
    }
    try {
      const result = importLegacyConfig(trimmed, draft);
      setImportPreview(result);
    } catch (err) {
      setImportPreview(null);
      setImportError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFileUpload = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      setRawImportText(content);
      parseImportInput(content);
    };
    reader.readAsText(file);
  };

  const handleConfirmApplyImport = async () => {
    if (!importPreview) return;
    await onApplyImportedConfig(importPreview.config);
    setImportApplied(true);
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
        ? 'Cleared background translation cache'
        : '已清空后台译文缓存',
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

  return (
    <div>
      {/* Section 1: 1-Click Legacy JSON Importer */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en'
                ? '1-Click Legacy JSON Importer'
                : '一键导入旧版配置 (Immersive / myAItranslate v1 JSON)'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Imports channels, custom <yaml>/%% assistants, glossary, and inherit routing while repairing "temperatre" typos and dropping float-ball clutter.'
                : '自动迁移翻译渠道、Aloxaf <yaml>/%% 助手、术语库与 inherit 场景联动，自动修复 "temperatre" 拼写并剔除悬浮球冗余项。'}
            </p>
          </div>
        </div>

        <FieldRow
          stacked
          label={lang === 'en' ? 'Choose JSON File or Paste Below' : '选择 JSON 配置文件或直接粘贴'}
        >
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="file"
                accept=".json,application/json"
                aria-label={lang === 'en' ? 'Import Legacy JSON File' : '选择旧版 JSON 配置文件'}
                onChange={(e) => {
                  const file = (e.currentTarget as HTMLInputElement).files?.[0];
                  handleFileUpload(file);
                }}
              />
              <button
                type="button"
                class="mp-btn mp-btn--solid"
                data-testid="parse-legacy-json-btn"
                onClick={() => parseImportInput(rawImportText)}
              >
                {lang === 'en' ? 'Preview Import & Audit' : '解析并预览迁移报告'}
              </button>
            </div>

            <textarea
              class="mp-textarea mp-textarea--mono"
              data-testid="legacy-json-textarea"
              placeholder='{"translationServices": ..., "customAiAssistants": ...}'
              value={rawImportText}
              onInput={(e) => setRawImportText((e.currentTarget as HTMLTextAreaElement).value)}
            />
          </div>
        </FieldRow>

        {importError ? (
          <div class="mp-editorial-note" style={{ borderLeftColor: 'var(--danger-ink)' }}>
            <StatusPill tone="danger">{lang === 'en' ? 'Parse Error' : '解析错误'}</StatusPill>{' '}
            {importError}
          </div>
        ) : null}

        {importPreview ? (
          <div
            class="mp-editorial-note"
            data-testid="import-audit-summary"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              padding: '14px 16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <strong style={{ fontSize: '13.5px', color: 'var(--ink)' }}>
                {importApplied
                  ? lang === 'en'
                    ? 'Import Audit Summary (Applied)'
                    : '配置迁移审计摘要（已正式应用）'
                  : lang === 'en'
                    ? 'Import Audit Summary (Ready to Apply)'
                    : '配置迁移审计摘要（待确认应用）'}
              </strong>

              <button
                type="button"
                class="mp-btn mp-btn--solid"
                data-testid="apply-import-btn"
                onClick={() => void handleConfirmApplyImport()}
              >
                {importApplied
                  ? lang === 'en'
                    ? 'Re-apply Imported Config'
                    : '已应用（点击可重新写入）'
                  : lang === 'en'
                    ? 'Apply Imported Config'
                    : '确认应用导入配置'}
              </button>
            </div>

            {/* Key Stats */}
            <div class="mp-chip-list">
              <StatusPill tone="accent">
                {lang === 'en'
                  ? `Providers: ${importPreview.stats.providersImported}`
                  : `导入渠道: ${importPreview.stats.providersImported}`}
              </StatusPill>
              <StatusPill tone="accent">
                {lang === 'en'
                  ? `Assistants: ${importPreview.stats.assistantsImported}`
                  : `导入助手: ${importPreview.stats.assistantsImported}`}
              </StatusPill>
              <StatusPill tone="neutral">
                {lang === 'en'
                  ? `Glossary: ${importPreview.stats.glossaryEntriesImported}`
                  : `术语条目: ${importPreview.stats.glossaryEntriesImported}`}
              </StatusPill>
              <StatusPill tone="ok">
                {lang === 'en'
                  ? `Normalized Fixes: ${importPreview.stats.normalizedFields}`
                  : `自动规范化修复: ${importPreview.stats.normalizedFields}`}
              </StatusPill>
            </div>

            {/* Scene Routing & Ignored Keys Preview */}
            <div style={{ fontSize: '12px', color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div>
                {lang === 'en' ? 'Primary Routing:' : '解析后主服务路由：'}{' '}
                <span class="mp-mono" style={{ color: 'var(--ink)' }}>
                  webpage → {previewPrimaryProvider ? `${previewPrimaryProvider.name} (${previewPrimaryProvider.model})` : previewPrimaryId}
                </span>
                {' · '}
                <span class="mp-mono">
                  input={importPreview.config.routing.input}, subtitle={importPreview.config.routing.subtitle}, image={importPreview.config.routing.image}
                </span>
              </div>
              {importPreview.stats.ignoredLegacyKeys.length > 0 ? (
                <div>
                  {lang === 'en' ? 'Dropped Legacy Clutter:' : '已忽略旧版悬浮球/侧栏冗余键：'}{' '}
                  <span class="mp-mono">{importPreview.stats.ignoredLegacyKeys.join(', ')}</span>
                </div>
              ) : null}
            </div>

            {/* Audit Log Entries */}
            {importPreview.audit.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '4px', borderTop: '1px solid var(--rule-soft)' }}>
                {importPreview.audit.map((item, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '12px' }}>
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
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Section 2: Export Configuration */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Export Configuration' : '导出配置与本机备份'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Redacted export strips all API keys by default so you can share setups safely.'
                : '默认导出脱敏配置（自动清空 apiKeys）；仅在勾选下方选项时导出含密钥的完整备份。'}
            </p>
          </div>
        </div>

        <FieldRow
          label={
            lang === 'en'
              ? 'Include API Keys for Local Backup'
              : '包含 API 密钥用于本机备份'
          }
          hint={
            includeSecrets
              ? lang === 'en'
                ? 'Caution: exported JSON will contain plaintext API keys. Keep strictly private.'
                : '注意：勾选后导出的 JSON 含明文 API 密钥，仅供本机或私密迁移备份，请勿公开分享。'
              : lang === 'en'
                ? 'Unchecked (default): exports safe redacted configuration without API keys.'
                : '未勾选（默认）：导出零密钥脱敏配置，可安全分享。'
          }
        >
          <input
            type="checkbox"
            data-testid="export-include-secrets-checkbox"
            checked={includeSecrets}
            onChange={(e) => {
              setIncludeSecrets((e.currentTarget as HTMLInputElement).checked);
              setExportedPreview(null);
            }}
          />
        </FieldRow>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', paddingTop: '6px' }}>
          <button
            type="button"
            class="mp-btn mp-btn--solid"
            data-testid="export-copy-btn"
            onClick={() => void handleGenerateExport(false)}
          >
            {includeSecrets
              ? lang === 'en'
                ? 'Copy Full Backup JSON'
                : '复制完整备份配置'
              : lang === 'en'
                ? 'Export Redacted Config (Copy)'
                : '导出脱敏配置'}
          </button>

          <button
            type="button"
            class="mp-btn"
            onClick={() => void handleGenerateExport(true)}
          >
            {lang === 'en' ? 'Download .json File' : '下载 .json 文件'}
          </button>

          {exportStatus ? <StatusPill tone="ok">{exportStatus}</StatusPill> : null}
        </div>

        {exportedPreview ? (
          <textarea
            readOnly
            class="mp-textarea mp-textarea--mono"
            data-testid="export-json-preview"
            style={{ marginTop: '10px', minHeight: '96px' }}
            value={exportedPreview}
          />
        ) : null}
      </section>

      {/* Section 3: Zero-Secret Diagnostics Log */}
      <section class="mp-section">
        <div class="mp-section-head">
          <div>
            <h2 class="mp-section-title">
              {lang === 'en' ? 'Zero-Secret Diagnostics Log' : '零密钥脱敏诊断与能力缓存'}
            </h2>
            <p class="mp-section-desc">
              {lang === 'en'
                ? 'Inspect HTTP statuses, latency, and temperature traces without ever recording prompts or API keys.'
                : '记录每次请求的端点路径、延迟、温度策略轨迹 (temperatureTrace) 与 400 自动剥离缓存，绝不记录密钥或正文。'}
            </p>
          </div>

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button
              type="button"
              class="mp-btn mp-btn--solid"
              data-testid="copy-diagnostics-btn"
              onClick={() => void handleCopyDiagnosticReport()}
            >
              {lang === 'en'
                ? 'Copy Redacted Diagnostic JSON'
                : '复制脱敏诊断报告 JSON'}
            </button>
            <button
              type="button"
              class="mp-btn mp-btn--sm"
              onClick={() => void handleClearTranslationCache()}
            >
              {lang === 'en' ? 'Clear Translation Cache' : '清空译文缓存'}
            </button>
            <button
              type="button"
              class="mp-btn mp-btn--sm"
              onClick={() => void handleClearCapabilityCache()}
            >
              {lang === 'en'
                ? `Clear Capability Cache (${Object.keys(capabilityCache).length})`
                : `清空能力缓存 (${Object.keys(capabilityCache).length})`}
            </button>
            <button
              type="button"
              class="mp-btn mp-btn--ghost mp-btn--sm"
              onClick={() => void handleClearDiagnostics()}
            >
              {lang === 'en' ? 'Clear Log' : '清空日志'}
            </button>
          </div>
        </div>

        {diagNotice ? (
          <div class="mp-editorial-note">
            <StatusPill tone="ok">{diagNotice}</StatusPill>
          </div>
        ) : null}

        {diagnostics.length === 0 ? (
          <p class="mp-muted" style={{ fontSize: '12.5px', margin: '8px 0 0' }}>
            {lang === 'en'
              ? 'No diagnostic entries recorded yet.'
              : '暂无最近诊断记录。点击渠道页「测试连接」或触发翻译后将在此显示脱敏快照。'}
          </p>
        ) : (
          <div class="mp-flat-list">
            {diagnostics.map((snap, idx) => (
              <div
                key={`${snap.time}-${idx}`}
                class="mp-flat-item"
                style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <StatusPill tone={snap.kind === 'ok' ? 'ok' : 'danger'}>
                    {snap.kind} {snap.httpStatus ? `(${snap.httpStatus})` : ''}
                  </StatusPill>
                  <span class="mp-mono">
                    {snap.provider.id} · {snap.provider.model}
                  </span>
                  <StatusPill tone="mono">{snap.parameters.temperatureTrace}</StatusPill>
                  <span class="mp-muted" style={{ fontSize: '12px' }}>
                    {snap.scene} · {snap.latencyMs}ms
                  </span>
                </div>
                {snap.sanitizedError ? (
                  <div class="mp-muted mp-mono" style={{ width: '100%', fontSize: '11.5px' }}>
                    {snap.sanitizedError}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
