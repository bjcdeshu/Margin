import { getEnglishLanguageName } from '@shared/constants';
import type {
  AssistantConfig,
  BatchItemInput,
  BatchItemOutput,
  TranslationScene,
} from '@shared/types';
import {
  buildExpandedPromptVariables,
  ensureRichTagInstruction,
  expandAssistantPrompts,
  extractStreamableVisibleText,
  interpolateTemplate,
  stripThinkingBlocks,
} from './template';
import type {
  CodecEncodeInput,
  CodecStreamParser,
  EncodedPrompt,
  PromptCodec,
} from './types';

export const DEFAULT_JSON_BATCH_SYSTEM_PROMPT = [
  'You are Margin, a senior bilingual editor translating into {{to}} with accuracy, idiomatic rhythm, and authentic register ("信达雅").',
  '1. Idiomatic Prose: Restructure long clauses, nested modifiers, and passive constructions into clean, natural, rhythmic {{to}} prose with zero translationese.',
  '2. Domain & Register: Match tone and terminology to any provided Document Title, Context Summary, and Style Guide.',
  '3. Markup & Token Integrity: Preserve inline <m0>...</m0> / <mN> HTML tags, <m-g id="N"/> placeholders, @handles, #hashtags, URLs, Markdown formatting, and code/CLI identifiers verbatim.',
  '4. Glossary Obedience: Strictly obey any provided Keep-Original terms and Required Term Mappings.',
  '5. JSON Contract: Respond ONLY with a valid JSON array of objects `[{"id":1,"trans":"..."}]` with no commentary or extra fields.',
].join('\n');

export function buildDefaultJsonBatchSystemPrompt(
  toLang: string,
  scene: TranslationScene | 'service-test' = 'webpage',
): string {
  const toName = getEnglishLanguageName(toLang);
  const base = interpolateTemplate(DEFAULT_JSON_BATCH_SYSTEM_PROMPT, {
    to: toName,
    to_lang: toName,
  });
  if (scene === 'input') {
    return `${base}\nScene Hint (Outbound Input): Rewrite and translate into concise, idiomatic, native-speaker ${toName} ready to post or send directly (e.g. on X, GitHub issues/PRs, or chat), preserving @mentions, #hashtags, URLs, Markdown, and inline code verbatim.`;
  }
  if (scene === 'selection') {
    return `${base}\nScene Hint (Selection): Render the selected phrase or passage into crisp, contextually accurate ${toName} without dictionary notes or explanations.`;
  }
  if (scene === 'subtitle') {
    return `${base}\nScene Hint (Subtitle): Use natural spoken rhythm and concise on-screen pacing. Keep each translation strictly inside its matching cue \`id\`; never merge, split, or shift trailing words across adjacent cues.`;
  }
  return base;
}

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
      const { systemPrompt, userPrompt } = expandAssistantPrompts({
        assistant: input.assistant,
        scene: input.scene,
        fromLang: input.fromLang,
        toLang: input.toLang,
        items: input.items,
        context: input.context,
        glossary: input.glossary,
        extraVars: {
          json: payloadJson,
          text: payloadJson,
        },
      });
      return { systemPrompt, userPrompt };
    }

    const vars = buildExpandedPromptVariables({
      scene: input.scene,
      fromLang: input.fromLang,
      toLang: input.toLang,
      items: input.items,
      context: input.context,
      glossary: input.glossary,
    });

    const contextLines: string[] = [];
    if (vars.title) contextLines.push(`Document Title: ${vars.title}`);
    if (vars.summary) contextLines.push(`Context Summary: ${vars.summary}`);
    if (vars.styleGuide) {
      contextLines.push(`Style Guide: ${vars.styleGuide}`);
    }
    if (vars.glossaryInstruction) {
      contextLines.push(vars.glossaryInstruction);
    }

    const rawSystemPrompt = buildDefaultJsonBatchSystemPrompt(
      input.toLang,
      input.scene,
    );
    const systemPrompt = ensureRichTagInstruction(
      rawSystemPrompt,
      '',
      input.items,
    );

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
