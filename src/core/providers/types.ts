import type {
  AssistantConfig,
  BatchItemInput,
  BatchItemOutput,
  DiagnosticSnapshot,
  GlossaryEntry,
  PageContextPayload,
  ProviderConfig,
  RequestPriority,
  TranslationScene,
} from '@shared/types';
import type { ProviderExecutionPool } from './pool';

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly endpoint: string;
  readonly usedApiKey?: string;

  constructor(params: {
    status: number;
    bodyText: string;
    endpoint: string;
    usedApiKey?: string;
  }) {
    const snippet = params.bodyText.trim().slice(0, 300);
    super(
      snippet
        ? `HTTP ${params.status}: ${snippet}`
        : `HTTP ${params.status} error from upstream provider`,
    );
    this.name = 'ProviderHttpError';
    this.status = params.status;
    this.bodyText = params.bodyText;
    this.endpoint = params.endpoint;
    this.usedApiKey = params.usedApiKey;
  }
}

export interface ProviderRuntimeEnv {
  fetchImpl?: typeof fetch;
  pool?: ProviderExecutionPool;
  retryBaseDelayMs?: number;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  signal?: AbortSignal;
  priority?: RequestPriority;
}

export interface AiCompletionRequestParams {
  provider: ProviderConfig;
  scene?: TranslationScene | 'service-test';
  endpoint: string;
  apiKey?: string;
  systemPrompt: string;
  userPrompt: string;
  imageDataUrl?: string;
  effectiveTemperature?: number;
  omitReasoningEffort?: boolean;
  stream: boolean;
  onDelta?: (delta: string) => void;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecuteBatchOptions extends ProviderRuntimeEnv {
  scene: TranslationScene | 'service-test';
  provider: ProviderConfig;
  assistant?: AssistantConfig;
  fromLang: string;
  toLang: string;
  items: BatchItemInput[];
  context?: PageContextPayload;
  glossary?: readonly GlossaryEntry[];
  stream?: boolean;
  onDelta?: (delta: string) => void;
  onItemReady?: (item: BatchItemOutput) => void;
}

export interface ExecuteBatchResult {
  ok: boolean;
  items: BatchItemOutput[];
  diagnostic: DiagnosticSnapshot;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface ExecuteVisionOptions extends ProviderRuntimeEnv {
  provider: ProviderConfig;
  assistant?: AssistantConfig;
  systemPrompt: string;
  userPrompt: string;
  imageDataUrl: string;
}

export interface ExecuteVisionResult {
  ok: boolean;
  rawText: string;
  diagnostic: DiagnosticSnapshot;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
