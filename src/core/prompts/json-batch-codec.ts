import { getEnglishLanguageName } from '@shared/constants';
import type {
  AssistantConfig,
  BatchItemInput,
  BatchItemOutput,
  TranslationScene,
} from '@shared/types';
import {
  buildExpandedPromptVariables,
  extractStreamableVisibleText,
  interpolateTemplate,
  selectPromptsForBatch,
  stripThinkingBlocks,
} from './template';
import type {
  CodecEncodeInput,
  CodecStreamParser,
  EncodedPrompt,
  PromptCodec,
} from './types';

function extractJsonBody(raw: string): string {
  const stripped = stripThinkingBlocks(raw);
  if (!stripped) return '';

  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n```[ \t]*)?$/i.exec(
    stripped,
  );
  if (fenced) {
    return fenced[1].trim();
  }

  const firstBracket = stripped.indexOf('[');
  const lastBracket = stripped.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return stripped.slice(firstBracket, lastBracket + 1);
  }

  return stripped;
}

interface RawJsonBatchEntry {
  id: number;
  trans: string;
}

function parseJsonBatchEntries(cleaned: string): RawJsonBatchEntry[] {
  if (!cleaned) return [];

  try {
    const parsed: unknown = JSON.parse(cleaned);
    const list: unknown[] | null = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as Record<string, unknown>).items)
        ? ((parsed as Record<string, unknown>).items as unknown[])
        : null;

    if (list) {
      const entries: RawJsonBatchEntry[] = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const id =
          typeof rec.id === 'number'
            ? rec.id
            : Number.parseInt(String(rec.id ?? ''), 10);
        const trans = rec.trans ?? rec.translation ?? rec.target ?? rec.text;
        if (Number.isFinite(id) && typeof trans === 'string') {
          entries.push({ id, trans });
        }
      }
      if (entries.length > 0) return entries;
    }
  } catch {
    // Fall through to object-level regex recovery for partial/streaming JSON
  }

  const recovered: RawJsonBatchEntry[] = [];
  const objRe =
    /\{\s*"id"\s*:\s*"?(\d+)"?\s*,\s*"(?:trans|translation|target)"\s*:\s*("(?:\\.|[^"\\])*")\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(cleaned)) !== null) {
    const id = Number.parseInt(m[1], 10);
    try {
      const trans = JSON.parse(m[2]) as string;
      if (Number.isFinite(id)) {
        recovered.push({ id, trans });
      }
    } catch {
      // Skip malformed partial entry
    }
  }
  return recovered;
}

function alignJsonEntries(
  entries: readonly RawJsonBatchEntry[],
  items: readonly BatchItemInput[],
): BatchItemOutput[] {
  const bySlot = new Map<number, string>();
  for (const entry of entries) {
    if (entry.id >= 1 && entry.id <= items.length) {
      bySlot.set(entry.id - 1, entry.trans);
      continue;
    }
    const directIdx = items.findIndex((it) => it.id === entry.id);
    if (directIdx !== -1 && !bySlot.has(directIdx)) {
      bySlot.set(directIdx, entry.trans);
    }
  }

  const out: BatchItemOutput[] = [];
  items.forEach((item, idx) => {
    const trans = bySlot.get(idx);
    if (trans !== undefined) {
      out.push({ id: item.id, trans });
    }
  });
  return out;
}

export class JsonBatchCodec implements PromptCodec {
  readonly id = 'json-batch' as const;

  encode(input: CodecEncodeInput): EncodedPrompt {
    const payloadJson = JSON.stringify(
      input.items.map((item, idx) => ({
        id: idx + 1,
        src: item.text,
      })),
    );

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
          json: payloadJson,
          text: payloadJson,
        },
      });
      const { systemTemplate, userTemplate } = selectPromptsForBatch(
        input.assistant,
        input.scene,
        input.items.length,
      );
      return {
        systemPrompt: interpolateTemplate(systemTemplate, vars).trim(),
        userPrompt: interpolateTemplate(userTemplate, vars).trim(),
      };
    }

    const vars = buildExpandedPromptVariables({
      scene: input.scene,
      fromLang: input.fromLang,
      toLang: input.toLang,
      items: input.items,
      context: input.context,
      glossary: input.glossary,
    });

    const toName = getEnglishLanguageName(input.toLang);
    const contextLines: string[] = [];
    if (vars.imt_title) contextLines.push(`Document Title: ${vars.imt_title}`);
    if (vars.imt_theme) contextLines.push(`Context Summary: ${vars.imt_theme}`);
    if (vars.imt_style_guide) {
      contextLines.push(`Style Guide: ${vars.imt_style_guide}`);
    }
    if (vars.imt_terms) {
      contextLines.push(`Required Glossary: ${vars.imt_terms}`);
    }

    const subtitleRule =
      input.scene === 'subtitle'
        ? ' Keep each translation strictly inside its matching `id`; never shift trailing words across cues.'
        : '';

    const systemPrompt =
      `You are a meticulous editorial translator. Translate every item naturally into ${toName} while preserving inline <mN> tags verbatim.${subtitleRule} Respond ONLY with a valid JSON array of objects \`[{"id":1,"trans":"..."}]\`.`;

    const prefix = contextLines.length > 0 ? `${contextLines.join('\n')}\n` : '';
    const userPrompt = `${prefix}${payloadJson}`;

    return { systemPrompt, userPrompt };
  }

  decode(
    rawOutput: string,
    items: readonly BatchItemInput[],
    _options?: {
      scene?: TranslationScene | 'service-test';
      assistant?: AssistantConfig;
    },
  ): BatchItemOutput[] {
    const cleaned = extractJsonBody(rawOutput);
    const entries = parseJsonBatchEntries(cleaned);
    return alignJsonEntries(entries, items);
  }

  createStreamParser(
    items: readonly BatchItemInput[],
    options?: {
      scene?: TranslationScene | 'service-test';
      assistant?: AssistantConfig;
    },
  ): CodecStreamParser {
    let buffer = '';
    const emittedIds = new Set<number>();

    return {
      push: (delta: string): BatchItemOutput[] => {
        buffer += delta;
        const visible = extractStreamableVisibleText(buffer);
        if (!visible) return [];
        const entries = parseJsonBatchEntries(visible);
        const aligned = alignJsonEntries(entries, items);
        const newlyReady: BatchItemOutput[] = [];
        for (const out of aligned) {
          if (!emittedIds.has(out.id)) {
            emittedIds.add(out.id);
            newlyReady.push(out);
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
        return { allItems, newlyReady };
      },
    };
  }
}

export const jsonBatchCodec = new JsonBatchCodec();
