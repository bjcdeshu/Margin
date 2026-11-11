import type {
  AssistantConfig,
  BatchItemInput,
  BatchItemOutput,
  GlossaryEntry,
  PageContextPayload,
  PromptCodecId,
  TranslationScene,
} from '@shared/types';

export interface CodecEncodeInput {
  scene: TranslationScene | 'service-test';
  fromLang: string;
  toLang: string;
  items: BatchItemInput[];
  assistant?: AssistantConfig;
  context?: PageContextPayload;
  glossary?: readonly GlossaryEntry[];
}

export interface EncodedPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface CodecStreamParser {
  /** Feed a raw SSE delta string and return newly completed batch items (if any). */
  push(delta: string): BatchItemOutput[];
  /** Finalize stream parsing and return all decoded batch items (Plus any final un-emitted items via `newlyReady`). */
  finish(): {
    allItems: BatchItemOutput[];
    newlyReady: BatchItemOutput[];
  };
}

export interface PromptCodec {
  readonly id: PromptCodecId;
  encode(input: CodecEncodeInput): EncodedPrompt;
  decode(
    rawOutput: string,
    items: readonly BatchItemInput[],
    options?: {
      scene?: TranslationScene | 'service-test';
      assistant?: AssistantConfig;
    },
  ): BatchItemOutput[];
  createStreamParser(
    items: readonly BatchItemInput[],
    options?: {
      scene?: TranslationScene | 'service-test';
      assistant?: AssistantConfig;
    },
  ): CodecStreamParser;
}
