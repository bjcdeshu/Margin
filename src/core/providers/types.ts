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

export type TruncationReason =
  | 'length'
  | 'content_filter'
  | 'max_tokens'
  | 'refusal'
  | 'premature-eof';

export class ProviderTruncatedResponseError extends Error {
  readonly reason: TruncationReason;
  readonly httpStatus?: number;
  readonly retryable: boolean;

  constructor(params: {
    reason: TruncationReason;
    protocol: 'openai-chat' | 'anthropic-messages';
    httpStatus?: number;
    message?: string;
  }) {
    const retryable = params.reason === 'premature-eof';
    const defaultMessage =
      params.reason === 'premature-eof'
        ? `Upstream ${params.protocol} SSE stream ended prematurely without a terminal stop marker.`
        : `Upstream ${params.protocol} completion terminated incomplete (reason: ${params.reason}).`;
    super(params.message ?? defaultMessage);
    this.name = 'ProviderTruncatedResponseError';
    this.reason = params.reason;
    this.httpStatus = params.httpStatus;
    this.retryable = retryable;
  }
}

export function describeBodyMetadata(
  rawBody: string,
  response?: Pick<Response, 'headers'>,
): string {
  const contentType =
    response?.headers?.get?.('content-type')?.split(';')[0]?.trim() || 'unknown';
  const trimmed = rawBody.trimStart();
  const shape = /<!doctype\s+html|<html\b/i.test(trimmed)
    ? 'html'
    : trimmed.startsWith('{')
      ? 'json-object-prefix'
      : trimmed.startsWith('[')
        ? 'json-array-prefix'
        : trimmed.length === 0
          ? 'empty'
          : 'non-json';
  return `chars=${rawBody.length}, contentType=${contentType}, shape=${shape}`;
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
