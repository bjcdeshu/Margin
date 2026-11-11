import { createDefaultMarginConfig } from '@shared/constants';
import type {
  ExportMarginOptions,
  LegacyImportResult,
  MarginConfig,
} from '@shared/types';

/**
 * Wave 0 typed contract stub — owned & implemented in full by Wave 1 `migration-importer`.
 */
export function importLegacyConfig(
  rawInput: string | Record<string, unknown>,
  baseConfig?: MarginConfig,
): LegacyImportResult {
  const parsed =
    typeof rawInput === 'string'
      ? (JSON.parse(rawInput) as Record<string, unknown>)
      : rawInput;

  const config = baseConfig
    ? structuredClone(baseConfig)
    : createDefaultMarginConfig();

  void parsed;

  return {
    config,
    audit: [],
    stats: {
      providersImported: Object.keys(config.providers).length,
      assistantsImported: Object.keys(config.assistants).length,
      glossaryEntriesImported: config.glossary.length,
      normalizedFields: 0,
      ignoredLegacyKeys: [],
    },
  };
}

/**
 * Wave 0 typed contract stub — owned & implemented in full by Wave 1 `migration-importer`.
 */
export function exportMarginConfig(
  config: MarginConfig,
  options: ExportMarginOptions = { includeSecrets: false },
): string {
  const clone = structuredClone(config);
  if (!options.includeSecrets) {
    for (const provider of Object.values(clone.providers)) {
      provider.apiKeys = [];
    }
  }
  return JSON.stringify(clone, null, 2);
}
