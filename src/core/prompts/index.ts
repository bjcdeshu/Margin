import type { PromptCodecId } from '@shared/types';
import { delimiterPromptCodec, DelimiterPromptCodec } from './delimiter-codec';
import { jsonBatchCodec, JsonBatchCodec } from './json-batch-codec';
import { singleTextMtCodec, SingleTextMtCodec } from './single-text-codec';
import type { PromptCodec } from './types';
import { yamlPromptCodec, YamlPromptCodec } from './yaml-codec';

export * from './types';
export * from './glossary';
export * from './template';
export * from './yaml-codec';
export * from './delimiter-codec';
export * from './json-batch-codec';
export * from './single-text-codec';

const CODEC_REGISTRY: Readonly<Record<PromptCodecId, PromptCodec>> = {
  yaml: yamlPromptCodec,
  delimiter: delimiterPromptCodec,
  'json-batch': jsonBatchCodec,
  'single-text': singleTextMtCodec,
};

export function getPromptCodec(codecId: PromptCodecId): PromptCodec {
  return CODEC_REGISTRY[codecId] ?? jsonBatchCodec;
}

export {
  YamlPromptCodec,
  DelimiterPromptCodec,
  JsonBatchCodec,
  SingleTextMtCodec,
};
