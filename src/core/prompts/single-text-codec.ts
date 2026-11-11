import { getEnglishLanguageName } from '@shared/constants';
import type {
  AssistantConfig,
  BatchItemInput,
  BatchItemOutput,
  TranslationScene,
} from '@shared/types';
import {
  buildExpandedPromptVariables,
  interpolateTemplate,
  stripThinkingBlocks,
} from './template';
import type {
  CodecEncodeInput,
  CodecStreamParser,
  EncodedPrompt,
  PromptCodec,
} from './types';

export class SingleTextMtCodec implements PromptCodec {
  readonly id = 'single-text' as const;

  encode(input: CodecEncodeInput): EncodedPrompt {
    const joinedText = input.items.map((it) => it.text).join('\n\n');

    if (input.assistant) {
      const vars = buildExpandedPromptVariables({
        scene: input.scene,
        fromLang: input.fromLang,
        toLang: input.toLang,
        items: input.items,
        assistant: input.assistant,
        context: input.context,
        glossary: input.glossary,
        extraVars: {
          text: joinedText,
        },
      });
      return {
        systemPrompt: interpolateTemplate(
          input.assistant.systemPrompt,
          vars,
        ).trim(),
        userPrompt: interpolateTemplate(input.assistant.prompt, vars).trim(),
      };
    }

    const toName = getEnglishLanguageName(input.toLang);
    const vars = buildExpandedPromptVariables({
      scene: input.scene,
      fromLang: input.fromLang,
      toLang: input.toLang,
      items: input.items,
      context: input.context,
      glossary: input.glossary,
    });
    const glossaryNote = vars.imt_terms
      ? ` Required Glossary: ${vars.imt_terms}.`
      : '';

    return {
      systemPrompt: `Translate the user input faithfully into ${toName}. Preserve any <mN> tags verbatim and output ONLY the translation.${glossaryNote}`,
      userPrompt: joinedText,
    };
  }

  decode(
    rawOutput: string,
    items: readonly BatchItemInput[],
    _options?: {
      scene?: TranslationScene | 'service-test';
      assistant?: AssistantConfig;
    },
  ): BatchItemOutput[] {
    const cleaned = stripThinkingBlocks(rawOutput);
    if (!cleaned && items.every((it) => it.text.trim() !== '')) {
      return [];
    }
    if (items.length === 0) return [];
    if (items.length === 1) {
      return [{ id: items[0].id, trans: cleaned }];
    }

    const parts = cleaned.split(/\r?\n\r?\n/);
    if (parts.length === items.length) {
      return items.map((item, idx) => ({
        id: item.id,
        trans: parts[idx].trim(),
      }));
    }

    const out: BatchItemOutput[] = [];
    for (let i = 0; i < Math.min(items.length, parts.length); i++) {
      if (i === items.length - 1 && parts.length > items.length) {
        out.push({
          id: items[i].id,
          trans: parts.slice(i).join('\n\n').trim(),
        });
      } else {
        out.push({
          id: items[i].id,
          trans: parts[i].trim(),
        });
      }
    }
    return out;
  }

  createStreamParser(
    items: readonly BatchItemInput[],
    options?: {
      scene?: TranslationScene | 'service-test';
      assistant?: AssistantConfig;
    },
  ): CodecStreamParser {
    let buffer = '';
    return {
      push: (delta: string): BatchItemOutput[] => {
        buffer += delta;
        return [];
      },
      finish: () => {
        const allItems = this.decode(buffer, items, options);
        return { allItems, newlyReady: allItems };
      },
    };
  }
}

export const singleTextMtCodec = new SingleTextMtCodec();
