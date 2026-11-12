export type WireProtocol =
  | 'openai-chat'
  | 'anthropic-messages'
  | 'deeplx'
  | 'google-web';

export type ProviderPreset =
  | 'openai'
  | 'deepseek'
  | 'zhipu'
  | 'anthropic'
  | 'deeplx'
  | 'google-free'
  | 'custom';

export type PromptCodecId = 'yaml' | 'delimiter' | 'json-batch' | 'single-text';

export type TranslationScene =
  | 'webpage'
  | 'input'
  | 'subtitle'
  | 'hover'
  | 'selection'
  | 'pdf'
  | 'image';

export type TranslationTheme = 'none' | 'mask' | 'opacity' | 'weakening';

export type DisplayMode = 'bilingual' | 'target-only';

export type UiColorMode = 'paper' | 'night' | 'system';

export type SelectionTriggerMode = 'off' | 'icon' | 'dot' | 'instant';

export type HoverModifierKey = 'none' | 'ctrl' | 'alt' | 'shift' | 'meta';

export type TemperaturePolicy =
  | { mode: 'omit' }
  | { mode: 'custom'; value: number; forceOnReasoning?: boolean };

export type ThinkingPolicy =
  | { mode: 'provider-default' }
  | { mode: 'disabled' }
  | { mode: 'enabled'; budgetTokens?: number };

export type TemperatureTrace =
  | 'omitted-default'
  | 'omitted-capability-cache'
  | 'omitted-reasoning-guard'
  | 'sent-provider-custom'
  | 'sent-assistant-custom'
  | 'retried-after-400';

export interface ModelCapabilityEntry {
  supportsTemperature?: boolean;
  learnedFromStatus?: number;
  updatedAt: number;
}

export type ModelCapabilityMap = Record<string, ModelCapabilityEntry>;

export interface ResolvedTemperature {
  value: number | undefined;
  trace: Exclude<TemperatureTrace, 'retried-after-400'>;
}

export interface ProviderConfig {
  id: string;
  name: string;
  preset: ProviderPreset;
  protocol: WireProtocol;
  enabled: boolean;
  baseUrl: string;
  endpoints?: string[];
  apiKeys: string[];
  model: string;
  models: string[];
  assistantId?: string;
  enableContext: boolean;
  enableRichHtml: boolean;
  stream: 'auto' | 'on' | 'off';
  rateLimitRps: number;
  maxConcurrency: number;
  maxBatchCount?: number;
  maxSubtitleBatchCount?: number;
  maxCharsPerBatch?: number;
  temperaturePolicy: TemperaturePolicy;
  thinkingPolicy: ThinkingPolicy;
  extraHeaders?: Record<string, string>;
}

export interface AssistantConfig {
  id: string;
  name: string;
  codec: PromptCodecId;
  enableRichHtml: boolean;
  temperaturePolicy: TemperaturePolicy;
  maxBatchCount: number;
  maxSubtitleBatchCount: number;
  maxCharsPerBatch: number;
  separator: string;
  systemPrompt: string;
  prompt: string;
  multipleSystemPrompt?: string;
  multiplePrompt?: string;
  subtitlePrompt?: string;
  env: Record<string, string>;
}

export interface GlossaryEntry {
  k: string;
  /** Empty string "" preserves source token `k` untranslated. */
  v: string;
  domain?: string;
  caseSensitive?: boolean;
}

export interface ThemePatternRule {
  pattern: string;
  theme: TranslationTheme;
}

export interface UrlPatternConfig {
  includeMatches: string[];
  excludeMatches: string[];
  skipPrivateNetworks: boolean;
}

export interface WebpageSettings {
  displayMode: DisplayMode;
  theme: TranslationTheme;
  themePatterns: ThemePatternRule[];
  lineBreakMaxTextCount: number;
  enableRichHtml: boolean;
  autoTranslateMatches: boolean;
}

export interface InputTranslateSettings {
  enabled: boolean;
  tripleSpaceTrigger: boolean;
  tripleSpaceWindowMs: number;
  targetLang: string;
  fallbackTargetLang: string;
}

export interface SelectionSettings {
  enabled: boolean;
  triggerMode: SelectionTriggerMode;
}

export interface HoverSettings {
  enabled: boolean;
  modifierKey: HoverModifierKey;
  delayMs: number;
}

export type SubtitleStylePreset = 'youtube-native' | 'cinema-outline' | 'warm-paper';

export interface SubtitleSettings {
  autoEnable: boolean;
  youtubeAutoEnable: boolean;
  preTranslate: boolean;
  displayMode: 'bilingual' | 'target-only' | 'source-only';
  fontSizePercent: number;
  sourceScalePercent: number;
  translationScalePercent: number;
  stylePreset: SubtitleStylePreset;
  position: 'bottom' | 'top';
}

export interface SceneRoutingConfig {
  webpage: string;
  input: string | 'inherit';
  subtitle: string | 'inherit';
  hover: string | 'inherit';
  selection: string | 'inherit';
  pdf: string | 'inherit';
  image: string | 'inherit';
}

export interface MarginConfig {
  schemaVersion: 2;
  uiColorMode: UiColorMode;
  interfaceLang: 'zh-CN' | 'en';
  sourceLang: string;
  targetLang: string;
  routing: SceneRoutingConfig;
  providers: Record<string, ProviderConfig>;
  providerOrder: string[];
  assistants: Record<string, AssistantConfig>;
  glossary: GlossaryEntry[];
  webpage: WebpageSettings;
  input: InputTranslateSettings;
  selection: SelectionSettings;
  hover: HoverSettings;
  subtitles: SubtitleSettings;
  urlRules: UrlPatternConfig;
}

export interface PageContextPayload {
  url: string;
  domain: string;
  title?: string;
  summary?: string;
  styleGuide?: string;
}

export interface BatchItemInput {
  id: number;
  text: string;
  hasRichTags?: boolean;
}

export interface BatchItemOutput {
  id: number;
  trans: string;
  thinking?: string;
  fallbackPlain?: boolean;
}

export type DiagnosticKind =
  | 'ok'
  | 'auth-error'
  | 'rate-limit'
  | 'unsupported-param-recovered'
  | 'bad-request'
  | 'upstream-error'
  | 'network-error'
  | 'invalid-response';

export interface DiagnosticSnapshot {
  schemaVersion: 1;
  product: string;
  version: string;
  time: string;
  scene: TranslationScene | 'service-test';
  codec: PromptCodecId;
  provider: {
    id: string;
    preset: ProviderPreset;
    protocol: WireProtocol;
    endpointOrigin: string;
    endpointPath: string;
    model: string;
  };
  parameters: {
    temperatureTrace: TemperatureTrace;
    temperatureSent?: number;
    thinkingMode: ThinkingPolicy['mode'];
    stream: boolean;
  };
  httpStatus?: number;
  kind: DiagnosticKind;
  retryable: boolean;
  attempts: number;
  latencyMs: number;
  sanitizedError?: string;
}

export interface TranslateBatchRequest {
  requestId: string;
  scene: TranslationScene | 'service-test';
  providerId?: string;
  fromLang: string;
  toLang: string;
  items: BatchItemInput[];
  context?: PageContextPayload;
}

export interface TranslateBatchResponse {
  ok: boolean;
  requestId: string;
  providerId: string;
  model: string;
  items: BatchItemOutput[];
  diagnostic: DiagnosticSnapshot;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export type TranslateStreamPortMessage =
  | { type: 'start'; payload: TranslateBatchRequest }
  | { type: 'cancel'; requestId: string }
  | { type: 'item-ready'; requestId: string; item: BatchItemOutput }
  | { type: 'delta'; requestId: string; rawDelta: string }
  | { type: 'done'; response: TranslateBatchResponse }
  | {
      type: 'error';
      requestId: string;
      error: { code: string; message: string; retryable: boolean };
      diagnostic?: DiagnosticSnapshot;
    };

export interface VisionBoxRegion {
  /** Normalized 0..1000 coordinates: [ymin, xmin, ymax, xmax] */
  box: [number, number, number, number];
  src: string;
  trans: string;
  vertical?: boolean;
}

export interface TranslateImageRequest {
  requestId: string;
  providerId?: string;
  imageDataUrl: string;
  fromLang: string;
  toLang: string;
  pageUrl?: string;
}

export interface TranslateImageResponse {
  ok: boolean;
  requestId: string;
  providerId: string;
  model: string;
  regions: VisionBoxRegion[];
  fallbackFullText?: string;
  diagnostic: DiagnosticSnapshot;
  error?: { code: string; message: string; retryable: boolean };
}

export interface FetchImageDataUrlRequest {
  imageUrl: string;
  refererUrl: string;
}

export interface FetchImageDataUrlResponse {
  ok: boolean;
  dataUrl?: string;
  mimeType?: string;
  error?: string;
}

export interface SubtitleCue {
  tStartMs: number;
  dDurationMs: number;
  text: string;
  trans?: string;
  wWinId?: number;
}

export interface YoutubeRawJson3Event {
  tStartMs?: number;
  dDurationMs?: number;
  wWinId?: number;
  aAppend?: number;
  text?: string;
  segs?: Array<{ utf8?: string }>;
}

export interface MarginActiveCueState {
  original: string;
  translated: string;
  startMs: number | null;
  endMs: number | null;
  mode: 'bilingual' | 'target-only' | 'source-only';
  fontSizePercent: number;
  sourceScalePercent?: number;
  translationScalePercent?: number;
  stylePreset?: SubtitleStylePreset;
  position: 'bottom' | 'top';
}

export type YoutubeMainBridgeMessage =
  | {
      source: 'margin-yt-main';
      type: 'caption-track-captured';
      videoId: string;
      langCode: string;
      trackUrl: string;
      events: YoutubeRawJson3Event[];
    }
  | {
      source: 'margin-yt-main';
      type: 'playhead-tick';
      videoId: string;
      currentTimeMs: number;
      paused: boolean;
    }
  | {
      source: 'margin-yt-isolated';
      type: 'active-cue-update';
      cue: MarginActiveCueState;
    }
  | {
      source: 'margin-yt-isolated';
      type: 'subtitle-config-update';
      settings: SubtitleSettings;
    };

export interface LegacyImportAuditItem {
  level: 'info' | 'normalized' | 'ignored' | 'warning';
  code: string;
  message: string;
}

export interface LegacyImportResult {
  config: MarginConfig;
  audit: LegacyImportAuditItem[];
  stats: {
    providersImported: number;
    assistantsImported: number;
    glossaryEntriesImported: number;
    normalizedFields: number;
    ignoredLegacyKeys: string[];
  };
}

export interface ExportMarginOptions {
  includeSecrets: boolean;
}

export type RuntimeRpcRequest =
  | { type: 'margin:translate-batch'; payload: TranslateBatchRequest }
  | { type: 'margin:translate-image'; payload: TranslateImageRequest }
  | { type: 'margin:fetch-image-data-url'; payload: FetchImageDataUrlRequest }
  | { type: 'margin:test-provider'; payload: { providerId: string } }
  | { type: 'margin:clear-translation-cache' };

export type RuntimeRpcResponse =
  | TranslateBatchResponse
  | TranslateImageResponse
  | FetchImageDataUrlResponse
  | { ok: boolean; error?: string };

export type TabCommandMessage =
  | { type: 'margin:cmd:toggle-page' }
  | { type: 'margin:cmd:translate-whole-page' }
  | { type: 'margin:cmd:toggle-mask' }
  | { type: 'margin:cmd:translate-input' }
  | { type: 'margin:cmd:translate-context-image'; srcUrl: string };

export type TabControlMessage =
  | { type: 'margin:cmd:get-page-state' }
  | { type: 'margin:cmd:clear-page-cache' };

export type AnyTabMessage = TabCommandMessage | TabControlMessage;

export interface TabPageState {
  active: boolean;
  inFlightBlocks: number;
  translatedBlocks: number;
  maskRevealed: boolean;
  lastError?: string;
}

export interface TabCommandDispatchResult {
  ok: boolean;
  result?: unknown;
  autoInjected?: boolean;
  unsupportedPage?: boolean;
  error?: string;
}
