export const BRAND = {
  name: 'Margin',
  slug: 'margin',
  version: '2.3.0',
  tagline: 'Quiet editorial translation for web, input, video, PDF & images',
  pinnedExtensionId: 'gdkbmfndollgfmblnielgfdpeoabekbf',
  storageKeyConfig: 'margin:config:v2',
  storageKeyCapabilityCache: 'margin:model-capabilities:v1',
  storageKeyDiagnostics: 'margin:diagnostics:v1',
  streamPortName: 'margin:translate-stream',
  cssPrefix: 'margin',
  domAttrPrefix: 'data-margin',
  eventPrefix: 'margin:',
  ytBridgeSourceMain: 'margin-yt-main',
  ytBridgeSourceIsolated: 'margin-yt-isolated',
  diagnosticSchemaVersion: 1,
} as const;

export type BrandInfo = typeof BRAND;
