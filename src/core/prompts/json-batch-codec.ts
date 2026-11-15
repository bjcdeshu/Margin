import { getEnglishLanguageName } from '@shared/constants';
import type {
  AssistantConfig,
  BatchItemInput,
  BatchItemOutput,
  TranslationScene,
} from '@shared/types';
import {
  buildExpandedPromptVariables,
  cleanPartialStreamingTrans,
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

const TRANS_FIELD_NAMES = new Set(['trans', 'translation', 'target', 'text']);

function extractEntryFromObjectRecord(
  rec: Record<string, unknown>,
): RawJsonBatchEntry | null {
  const id =
    typeof rec.id === 'number'
      ? rec.id
      : Number.parseInt(String(rec.id ?? ''), 10);
  const trans = rec.trans ?? rec.translation ?? rec.target ?? rec.text;
  if (Number.isFinite(id) && typeof trans === 'string') {
    return { id, trans };
  }
  return null;
}

function scanJsonObjectsInStream(text: string): {
  completeObjects: string[];
  trailingUnclosedObject: string | null;
} {
  const completeObjects: string[] = [];
  const braceStack: number[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      braceStack.push(i);
    } else if (ch === '}') {
      const startIdx = braceStack.pop();
      if (startIdx !== undefined) {
        completeObjects.push(text.slice(startIdx, i + 1));
      }
    }
  }

  const trailingUnclosedObject =
    braceStack.length > 0 ? text.slice(braceStack[braceStack.length - 1]) : null;

  return { completeObjects, trailingUnclosedObject };
}

export function stripIncompleteTrailingJsonEscape(rawBody: string): string {
  // Trailing run of backslashes: only strip 1 backslash when the run has odd length
  const trailingSlashes = /\\+$/.exec(rawBody);
  if (trailingSlashes) {
    return trailingSlashes[0].length % 2 === 1 ? rawBody.slice(0, -1) : rawBody;
  }

  // Incomplete `\uXXXX` escape (`\u`, `\u0`, `\u00`, `\u004`): only strip when preceded by an odd number of backslashes
  const incompleteUnicode = /(\\+)(u[0-9a-fA-F]{0,3})$/.exec(rawBody);
  if (incompleteUnicode && incompleteUnicode[1].length % 2 === 1) {
    return rawBody.slice(0, -(1 + incompleteUnicode[2].length));
  }

  return rawBody;
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
        const entry = extractEntryFromObjectRecord(
          item as Record<string, unknown>,
        );
        if (entry) {
          entries.push(entry);
        }
      }
      if (entries.length > 0) return entries;
    }
  } catch {
    // Fall through to object-level recovery for partial/streaming JSON
  }

  const { completeObjects } = scanJsonObjectsInStream(cleaned);
  const recovered: RawJsonBatchEntry[] = [];
  for (const objStr of completeObjects) {
    try {
      const parsedObj = JSON.parse(objStr) as unknown;
      if (parsedObj && typeof parsedObj === 'object' && !Array.isArray(parsedObj)) {
        const entry = extractEntryFromObjectRecord(
          parsedObj as Record<string, unknown>,
        );
        if (entry) {
          recovered.push(entry);
        }
      }
    } catch {
      // Skip malformed partial entry
    }
  }
  return recovered;
}

function readJsonStringToken(
  src: string,
  openQuoteIdx: number,
): { closed: boolean; rawContent: string; nextIdx: number } {
  let escaped = false;
  for (let i = openQuoteIdx + 1; i < src.length; i++) {
    const ch = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      return {
        closed: true,
        rawContent: src.slice(openQuoteIdx + 1, i),
        nextIdx: i + 1,
      };
    }
  }
  return {
    closed: false,
    rawContent: src.slice(openQuoteIdx + 1),
    nextIdx: src.length,
  };
}

function skipCompleteJsonValue(src: string, startIdx: number): number | null {
  let i = startIdx;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (i >= src.length) return null;

  const ch = src[i];
  if (ch === '"') {
    const strTok = readJsonStringToken(src, i);
    return strTok.closed ? strTok.nextIdx : null;
  }
  if (ch === '{' || ch === '[') {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return null;
  }

  // Primitive value (number, true, false, null): ends at `,` or whitespace before `,`
  let j = i;
  while (j < src.length && !/[,}\]\s]/.test(src[j])) {
    j++;
  }
  return j > i ? j : null;
}

function extractTrailingPartialJsonEntry(
  visible: string,
): RawJsonBatchEntry | null {
  const { trailingUnclosedObject } = scanJsonObjectsInStream(visible);
  if (!trailingUnclosedObject || !trailingUnclosedObject.startsWith('{')) {
    return null;
  }

  let foundId: number | null = null;
  let foundTrans: string | null = null;

  let idx = 1; // skip opening `{`
  const len = trailingUnclosedObject.length;

  while (idx < len) {
    while (idx < len && /[\s,]/.test(trailingUnclosedObject[idx])) idx++;
    if (idx >= len || trailingUnclosedObject[idx] !== '"') break;

    const keyTok = readJsonStringToken(trailingUnclosedObject, idx);
    if (!keyTok.closed) break;
    let keyName: string;
    try {
      keyName = JSON.parse(`"${keyTok.rawContent}"`) as string;
    } catch {
      break;
    }
    idx = keyTok.nextIdx;

    while (idx < len && /\s/.test(trailingUnclosedObject[idx])) idx++;
    if (idx >= len || trailingUnclosedObject[idx] !== ':') break;
    idx++;
    while (idx < len && /\s/.test(trailingUnclosedObject[idx])) idx++;
    if (idx >= len) break;

    if (keyName === 'id') {
      if (trailingUnclosedObject[idx] === '"') {
        const idStrTok = readJsonStringToken(trailingUnclosedObject, idx);
        if (!idStrTok.closed) break;
        const parsedId = Number.parseInt(idStrTok.rawContent, 10);
        if (Number.isFinite(parsedId)) {
          foundId = parsedId;
        }
        idx = idStrTok.nextIdx;
      } else {
        const numMatch = /^(\d+)/.exec(trailingUnclosedObject.slice(idx));
        if (!numMatch) break;
        const parsedId = Number.parseInt(numMatch[1], 10);
        if (Number.isFinite(parsedId)) {
          foundId = parsedId;
        }
        idx += numMatch[1].length;
      }
      continue;
    }

    if (TRANS_FIELD_NAMES.has(keyName) && trailingUnclosedObject[idx] === '"') {
      const valTok = readJsonStringToken(trailingUnclosedObject, idx);
      const safeBody = valTok.closed
        ? valTok.rawContent
        : stripIncompleteTrailingJsonEscape(valTok.rawContent);
      try {
        foundTrans = JSON.parse(`"${safeBody}"`) as string;
      } catch {
        return null;
      }
      if (!valTok.closed) {
        break;
      }
      idx = valTok.nextIdx;
      continue;
    }

    const nextIdx = skipCompleteJsonValue(trailingUnclosedObject, idx);
    if (nextIdx === null) {
      break;
    }
    idx = nextIdx;
  }

  if (foundId !== null && Number.isFinite(foundId) && foundTrans !== null) {
    return { id: foundId, trans: foundTrans };
  }
  return null;
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
    if (vars.threadContext) {
      contextLines.push(
        `Thread / Post Topic (context only — do NOT translate): ${vars.threadContext}`,
      );
    }
    if (vars.prevContext) {
      contextLines.push(
        `Preceding Context (for pronoun/tone continuity only — do NOT translate): ${vars.prevContext}`,
      );
    }
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
    const lastEmittedPartialById = new Map<number, string>();

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

        const trailingPartial = extractTrailingPartialJsonEntry(visible);
        if (trailingPartial) {
          const alignedPartial = alignJsonEntries([trailingPartial], items)[0];
          if (alignedPartial && !emittedIds.has(alignedPartial.id)) {
            const cleaned = cleanPartialStreamingTrans(alignedPartial.trans);
            if (
              cleaned.replace(/\s+/g, '').length >= 2 &&
              lastEmittedPartialById.get(alignedPartial.id) !== cleaned
            ) {
              lastEmittedPartialById.set(alignedPartial.id, cleaned);
              newlyReady.push({
                id: alignedPartial.id,
                trans: cleaned,
                partial: true,
              });
            }
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
