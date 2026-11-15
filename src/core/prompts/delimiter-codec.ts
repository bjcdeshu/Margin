import { BUILTIN_ASSISTANTS } from '@shared/constants';
import type {
  AssistantConfig,
  BatchItemInput,
  BatchItemOutput,
  TranslationScene,
} from '@shared/types';
import {
  cleanPartialStreamingTrans,
  expandAssistantPrompts,
  extractStreamableVisibleText,
  stripThinkingBlocks,
} from './template';
import type {
  CodecEncodeInput,
  CodecStreamParser,
  EncodedPrompt,
  PromptCodec,
} from './types';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveSeparatorToken(assistant?: AssistantConfig): {
  joinSeparator: string;
  lineSplitRegex: RegExp;
  inlineFallbackRegex: RegExp;
} {
  const joinSeparator =
    assistant?.separator && assistant.separator.length > 0
      ? assistant.separator
      : BUILTIN_ASSISTANTS['builtin-delimiter'].separator;

  const coreToken = joinSeparator.trim() || '%%';
  const escapedCore = escapeRegExp(coreToken);

  return {
    joinSeparator,
    // Primary split: delimiter on its own line (`\n\n%%\n\n` or `\n%%\n` with optional horizontal whitespace)
    lineSplitRegex: new RegExp(`\\r?\\n[ \\t]*${escapedCore}[ \\t]*\\r?\\n`, 'g'),
    // Fallback split: inline ` %% ` when an LLM collapses line breaks around `%%`
    inlineFallbackRegex: new RegExp(`\\s*${escapedCore}\\s*`, 'g'),
  };
}

function cleanOuterDelimiterArtifacts(
  text: string,
  coreToken: string,
): string {
  const escaped = escapeRegExp(coreToken);
  const leadingRe = new RegExp(`^(?:\\s*${escaped}\\s*)+`);
  const trailingRe = new RegExp(`(?:\\s*${escaped}\\s*)+$`);
  return text.replace(leadingRe, '').replace(trailingRe, '').trim();
}

export function cleanPartialDelimiterTrans(
  rawSegment: string,
  coreToken = '%%',
): string {
  if (!rawSegment) return '';
  const token = coreToken.trim() || '%%';
  const escaped = escapeRegExp(token);

  let s = rawSegment.replace(new RegExp(`^(?:\\s*${escaped}\\s*)+`), '');
  s = s.replace(new RegExp(`(?:\\s*${escaped}\\s*)+$`), '');

  // Strip any trailing half-typed prefix of `coreToken` (e.g. trailing `%` when delimiter is `%%`)
  for (let len = token.length - 1; len >= 1; len--) {
    const pfx = escapeRegExp(token.slice(0, len));
    const partialRe = new RegExp(`\\s*${pfx}$`);
    if (partialRe.test(s)) {
      s = s.replace(partialRe, '');
      break;
    }
  }

  return cleanPartialStreamingTrans(s);
}

export function splitDelimiterSegments(
  cleanedText: string,
  expectedCount: number,
  assistant?: AssistantConfig,
  allowEmptyFirstSegment = false,
): string[] {
  if (!cleanedText.trim() || expectedCount <= 0) return [];

  const { joinSeparator, lineSplitRegex, inlineFallbackRegex } =
    resolveSeparatorToken(assistant);
  const coreToken = joinSeparator.trim() || '%%';
  const escapedCore = escapeRegExp(coreToken);

  if (expectedCount === 1) {
    return [cleanOuterDelimiterArtifacts(cleanedText, coreToken)];
  }

  let normalized = cleanedText;
  const leadingLineDelimRe = new RegExp(`^(?:\\s*${escapedCore}[ \\t]*\\r?\\n)+`);
  const trailingLineDelimRe = new RegExp(`(?:\\r?\\n[ \\t]*${escapedCore}\\s*)+$`);
  if (!allowEmptyFirstSegment) {
    normalized = normalized.replace(leadingLineDelimRe, '');
  }
  normalized = normalized.replace(trailingLineDelimRe, '');
  if (!normalized.trim()) return [];

  lineSplitRegex.lastIndex = 0;
  let segments = normalized.split(lineSplitRegex).map((s) => s.trim());

  // Tolerant fallback if LLM omitted surrounding newlines (e.g. `译文A %% 译文B`)
  if (segments.length === 1 && inlineFallbackRegex.test(normalized)) {
    inlineFallbackRegex.lastIndex = 0;
    segments = normalized.split(inlineFallbackRegex).map((s) => s.trim());
  }

  if (!allowEmptyFirstSegment) {
    while (segments.length > 1 && segments[0] === '') {
      segments.shift();
    }
  } else {
    while (segments.length > expectedCount && segments[0] === '') {
      segments.shift();
    }
  }
  while (
    segments.length > expectedCount &&
    segments[segments.length - 1] === ''
  ) {
    segments.pop();
  }

  // Count-mismatch recovery: if LLM produced extra `%%` splits (> expectedCount),
  // preserve slots `0..expectedCount-2` and merge overflow into the final slot so zero translated text is dropped.
  if (segments.length > expectedCount) {
    const head = segments.slice(0, expectedCount - 1);
    const tailMerged = segments
      .slice(expectedCount - 1)
      .filter((s) => s.length > 0)
      .join('\n\n');
    return [...head, tailMerged];
  }

  return segments;
}

export class DelimiterPromptCodec implements PromptCodec {
  readonly id = 'delimiter' as const;

  encode(input: CodecEncodeInput): EncodedPrompt {
    const assistant =
      input.assistant ?? BUILTIN_ASSISTANTS['builtin-delimiter'];
    const { joinSeparator } = resolveSeparatorToken(assistant);

    const joinedText = input.items.map((it) => it.text).join(joinSeparator);
    const { systemPrompt, userPrompt } = expandAssistantPrompts({
      assistant,
      scene: input.scene,
      fromLang: input.fromLang,
      toLang: input.toLang,
      items: input.items,
      context: input.context,
      glossary: input.glossary,
      extraVars: {
        text: joinedText,
      },
    });

    return { systemPrompt, userPrompt };
  }

  decode(
    rawOutput: string,
    items: readonly BatchItemInput[],
    options?: {
      scene?: TranslationScene | 'service-test';
      assistant?: AssistantConfig;
    },
  ): BatchItemOutput[] {
    const stripped = stripThinkingBlocks(rawOutput);
    if (!stripped || items.length === 0) return [];

    const allowEmptyFirstSegment = items[0].text.trim() === '';
    const segments = splitDelimiterSegments(
      stripped,
      items.length,
      options?.assistant,
      allowEmptyFirstSegment,
    );

    const outputs: BatchItemOutput[] = [];
    for (let i = 0; i < Math.min(items.length, segments.length); i++) {
      const seg = segments[i];
      if (seg === undefined) continue;
      // Omit empty segment when source item had non-empty text rather than wiping original text
      if (seg === '' && items[i].text.trim() !== '') {
        continue;
      }
      outputs.push({
        id: items[i].id,
        trans: seg,
      });
    }

    return outputs;
  }

  createStreamParser(
    items: readonly BatchItemInput[],
    options?: {
      scene?: TranslationScene | 'service-test';
      assistant?: AssistantConfig;
    },
  ): CodecStreamParser {
    let buffer = '';
    let nextEmitIndex = 0;
    const emittedIds = new Set<number>();
    const lastEmittedPartialById = new Map<number, string>();
    const { joinSeparator, lineSplitRegex, inlineFallbackRegex } =
      resolveSeparatorToken(options?.assistant);
    const coreToken = joinSeparator.trim() || '%%';
    const escapedCore = escapeRegExp(coreToken);
    const leadingLineDelimRe = new RegExp(
      `^(?:\\s*${escapedCore}[ \\t]*\\r?\\n)+`,
    );
    const bareLeadingDelimOnlyRe = new RegExp(`^\\s*${escapedCore}\\s*$`);

    return {
      push: (delta: string): BatchItemOutput[] => {
        buffer += delta;
        if (items.length === 0) {
          return [];
        }

        const visible = extractStreamableVisibleText(buffer);
        if (!visible) return [];

        const newlyReady: BatchItemOutput[] = [];

        if (items.length === 1) {
          const inputItem = items[0];
          const cleanedPartial = cleanPartialDelimiterTrans(visible, coreToken);
          const nonWsCount = cleanedPartial.replace(/\s+/g, '').length;
          if (
            nonWsCount >= 2 &&
            lastEmittedPartialById.get(inputItem.id) !== cleanedPartial
          ) {
            lastEmittedPartialById.set(inputItem.id, cleanedPartial);
            newlyReady.push({
              id: inputItem.id,
              trans: cleanedPartial,
              partial: true,
            });
          }
          return newlyReady;
        }

        const firstItemNonEmpty = items[0].text.trim() !== '';
        let visibleForSplit = visible;
        if (firstItemNonEmpty) {
          visibleForSplit = visibleForSplit.replace(leadingLineDelimRe, '');
          if (!visibleForSplit || bareLeadingDelimOnlyRe.test(visibleForSplit)) {
            return [];
          }
        }

        lineSplitRegex.lastIndex = 0;
        let parts = visibleForSplit.split(lineSplitRegex);
        if (parts.length <= 1) {
          inlineFallbackRegex.lastIndex = 0;
          parts = visibleForSplit.split(inlineFallbackRegex);
        }

        if (firstItemNonEmpty) {
          while (parts.length > 1 && parts[0].trim() === '') {
            parts.shift();
          }
        }

        // 1. Every segment strictly BEFORE the last segment has already seen its closing `%%` delimiter!
        const completedCount = Math.min(items.length - 1, parts.length - 1);
        while (nextEmitIndex < completedCount) {
          const trans = parts[nextEmitIndex].trim();
          const inputItem = items[nextEmitIndex];
          nextEmitIndex++;
          if (trans !== '' || inputItem.text.trim() === '') {
            emittedIds.add(inputItem.id);
            newlyReady.push({
              id: inputItem.id,
              trans,
            });
          }
        }

        // 2. Intra-item live token preview (`partial: true`) for the active trailing segment!
        if (nextEmitIndex < items.length) {
          const currentInputItem = items[nextEmitIndex];
          const rawTrailing =
            parts.length > items.length
              ? parts.slice(nextEmitIndex).join('\n\n')
              : (parts[nextEmitIndex] ?? '');
          const cleanedPartial = cleanPartialDelimiterTrans(
            rawTrailing,
            coreToken,
          );
          const nonWsCount = cleanedPartial.replace(/\s+/g, '').length;
          if (
            nonWsCount >= 2 &&
            lastEmittedPartialById.get(currentInputItem.id) !== cleanedPartial
          ) {
            lastEmittedPartialById.set(currentInputItem.id, cleanedPartial);
            newlyReady.push({
              id: currentInputItem.id,
              trans: cleanedPartial,
              partial: true,
            });
          }
        }

        return newlyReady;
      },

      finish: () => {
        const allItems = this.decode(buffer, items, options);
        const newlyReady = allItems.filter((it) => !emittedIds.has(it.id));
        for (const it of newlyReady) {
          emittedIds.add(it.id);
        }
        nextEmitIndex = items.length;
        return { allItems, newlyReady };
      },
    };
  }
}

export const delimiterPromptCodec = new DelimiterPromptCodec();
