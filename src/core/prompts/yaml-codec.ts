import { BUILTIN_ASSISTANTS } from '@shared/constants';
import type {
  AssistantConfig,
  BatchItemInput,
  BatchItemOutput,
  TranslationScene,
} from '@shared/types';
import { parse as parseYaml } from 'yaml';
import {
  expandAssistantPrompts,
  extractStreamableVisibleText,
  formatYamlItemRow,
  stripThinkingBlocks,
} from './template';
import type {
  CodecEncodeInput,
  CodecStreamParser,
  EncodedPrompt,
  PromptCodec,
} from './types';

export { formatYamlItemRow };

export function extractCleanYamlPayload(
  rawText: string,
  allowUnclosedTag = false,
  expectYamlTag = false,
): string {
  const stripped = stripThinkingBlocks(rawText);
  if (!stripped) return '';

  // 1. Prefer explicit `<yaml>...</yaml>` wrapper when present
  const closedMatches = Array.from(
    stripped.matchAll(/<yaml\b[^>]*>([\s\S]*?)<\/yaml>/gi),
  );
  let body: string | null =
    closedMatches.length > 0
      ? closedMatches[closedMatches.length - 1][1]
      : null;

  if (body === null) {
    const unclosed = /<yaml\b[^>]*>([\s\S]*)$/i.exec(stripped);
    if (unclosed) {
      body = unclosed[1];
    }
  }

  // 2. If no `<yaml>` tag is present, check for ```yaml ... ``` or ``` ... ``` fences (even when surrounded by prose)
  if (body === null) {
    const closedFence =
      /```(?:yaml|yml)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i.exec(stripped);
    if (closedFence) {
      return closedFence[1].trim();
    }
    if (allowUnclosedTag) {
      const unclosedFence = /```(?:yaml|yml)?[ \t]*\r?\n([\s\S]*)$/i.exec(
        stripped,
      );
      if (unclosedFence) {
        return unclosedFence[1].trim();
      }
      // During streaming, if the prompt explicitly expects `<yaml>`, wait until `<yaml>` or ```yaml opens
      // so pre-tag reasoning prose never leaks into emittedIds!
      if (expectYamlTag) {
        return '';
      }
    }
    body = stripped;
  }

  body = body.trim();

  // Strip surrounding ```yaml ... ``` or ``` ... ``` markdown code fences inside `<yaml>`
  const innerClosedFence =
    /```(?:yaml|yml)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i.exec(body);
  if (innerClosedFence) {
    return innerClosedFence[1].trim();
  }
  const fenced = /^```(?:yaml|yml)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n```[ \t]*)?$/i.exec(
    body,
  );
  if (fenced) {
    body = fenced[1].trim();
  }

  return body;
}

interface RawParsedYamlItem {
  id: number;
  trans: string;
  thinking?: string;
}

function unquoteScalarIfWrapped(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return parsed;
      }
    } catch {
      const inner = trimmed.slice(1, -1);
      // Keep verbatim ONLY when the line starts and ends with two distinct quoted phrases
      // (e.g. `"Hello" world: "ok"`), while unwrapping outer-wrapped scalars that contain
      // unescaped inner quotes (e.g. `"点击 <m0>这里</m0> 阅读 "第 2 部分""` or `"He said "hi" now"`).
      const looksLikeSeparateQuotedPhrases =
        /^[^"]+"(?:[\s,:;.!?)}\]]|$)/.test(inner) &&
        /(?:^|[\s,:;([{\-])"[^"]+$/.test(inner) &&
        (inner.match(/"/g)?.length ?? 0) % 2 === 0;
      if (looksLikeSeparateQuotedPhrases) {
        return trimmed;
      }
      return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    const inner = trimmed.slice(1, -1);
    if (!/(?<!')'(?!')/.test(inner)) {
      return inner.replace(/''/g, "'");
    }
    const looksLikeSeparateSingleQuotedPhrases =
      /^[^']+'(?:[\s,:;.!?)}\]]|$)/.test(inner) &&
      /(?:^|[\s,:;([{\-])'[^']+$/.test(inner) &&
      (inner.match(/'/g)?.length ?? 0) % 2 === 0;
    if (looksLikeSeparateSingleQuotedPhrases) {
      return trimmed;
    }
    return inner.replace(/''/g, "'");
  }
  return trimmed;
}

function isYamlScalarBoundaryLine(
  line: string,
  itemIndent: number,
  propIndent: number,
  knownSchemaKeys: ReadonlySet<string>,
): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (
    trimmed === '---' ||
    trimmed === '...' ||
    trimmed.startsWith('```') ||
    /^<\/yaml\b/i.test(trimmed)
  ) {
    return true;
  }

  const bareDashMatch = /^([ \t]*)-\s*$/.exec(line);
  if (bareDashMatch && bareDashMatch[1].length <= propIndent) {
    return true;
  }

  const listMatch = /^([ \t]*)-\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
  if (
    listMatch &&
    listMatch[1].length <= propIndent &&
    knownSchemaKeys.has(listMatch[2])
  ) {
    return true;
  }

  const propMatch = /^([ \t]*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
  if (propMatch && knownSchemaKeys.has(propMatch[2])) {
    const indentLen = propMatch[1].length;
    if (
      (indentLen > itemIndent && indentLen <= propIndent + 2) ||
      (itemIndent === 0 && indentLen === 0)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Tolerant line-by-line `- id:` state-machine parser for `<yaml>` responses.
 * Recovers cleanly when LLMs emit unescaped colons (`:` / `：`), unescaped
 * quotes (`"` / `'`), or unindented multi-line breaks inside `thinking` or `trans`.
 */
export function parseYamlItemsStateMachine(
  yamlText: string,
  transFieldCandidates: readonly string[],
  sourceFieldCandidates: readonly string[],
): RawParsedYamlItem[] {
  if (!yamlText.trim()) return [];

  const knownSchemaKeys = new Set<string>([
    'id',
    'thinking',
    'thought',
    'trans',
    'translation',
    'target',
    'src',
    'source',
    ...transFieldCandidates,
    ...sourceFieldCandidates,
  ]);

  const lines = yamlText.replace(/\r\n?/g, '\n').split('\n');
  const rawRecords: Array<{
    fields: Record<string, string>;
    itemIndent: number;
    propIndent: number;
  }> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---' || trimmed === '...' || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    const listMatch = /^([ \t]*)-\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(
      line,
    );
    if (listMatch && knownSchemaKeys.has(listMatch[2])) {
      const itemIndent = listMatch[1].length;
      const propIndent = itemIndent + 2;
      const key = listMatch[2];
      const rest = listMatch[3];
      const record = {
        fields: {} as Record<string, string>,
        itemIndent,
        propIndent,
      };
      rawRecords.push(record);
      const consumed = readFieldValue(
        lines,
        i,
        itemIndent,
        propIndent,
        rest,
        knownSchemaKeys,
      );
      record.fields[key] = consumed.value;
      i = consumed.nextIndex;
      continue;
    }

    // Bare `-` followed by indented `id: ...` on the next line
    const bareDashMatch = /^([ \t]*)-\s*$/.exec(line);
    if (bareDashMatch) {
      const itemIndent = bareDashMatch[1].length;
      rawRecords.push({
        fields: {},
        itemIndent,
        propIndent: itemIndent + 2,
      });
      i++;
      continue;
    }

    const currentRecord = rawRecords[rawRecords.length - 1];
    if (currentRecord) {
      const propMatch = /^([ \t]+)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(
        line,
      );
      if (propMatch) {
        const indentLen = propMatch[1].length;
        const key = propMatch[2];
        const rest = propMatch[3];
        if (
          knownSchemaKeys.has(key) &&
          indentLen > currentRecord.itemIndent &&
          indentLen <= currentRecord.propIndent + 2
        ) {
          currentRecord.propIndent = indentLen;
          const consumed = readFieldValue(
            lines,
            i,
            currentRecord.itemIndent,
            indentLen,
            rest,
            knownSchemaKeys,
          );
          currentRecord.fields[key] = consumed.value;
          i = consumed.nextIndex;
          continue;
        }
      }
    }

    i++;
  }

  const parsed: RawParsedYamlItem[] = [];
  for (const rec of rawRecords) {
    const idVal = Number.parseInt(
      unquoteScalarIfWrapped(rec.fields.id ?? ''),
      10,
    );
    if (!Number.isFinite(idVal)) continue;

    let transVal: string | undefined;
    for (const candidate of transFieldCandidates) {
      if (rec.fields[candidate] !== undefined) {
        transVal = rec.fields[candidate];
        break;
      }
    }
    if (transVal === undefined) continue;

    const thinkingVal = rec.fields.thinking ?? rec.fields.thought;
    parsed.push({
      id: idVal,
      trans: transVal,
      ...(thinkingVal !== undefined && thinkingVal.trim() !== ''
        ? { thinking: thinkingVal }
        : {}),
    });
  }

  return parsed;
}

function readFieldValue(
  lines: readonly string[],
  startLineIndex: number,
  itemIndent: number,
  propIndent: number,
  restAfterColon: string,
  knownSchemaKeys: ReadonlySet<string>,
): { value: string; nextIndex: number } {
  const trimmedRest = restAfterColon.trim();

  // Block scalar (`|`, `|-`, `|+`, `>`, `>-`, `>+`)
  const blockIndicator = /^([|>])([-+]?)\d*$/.exec(trimmedRest);
  if (blockIndicator) {
    const style = blockIndicator[1];
    const chomp = blockIndicator[2];
    const blockLines: string[] = [];
    let idx = startLineIndex + 1;
    let contentIndent: number | null = null;

    while (idx < lines.length) {
      const nextLine = lines[idx];
      if (nextLine.trim() === '') {
        blockLines.push('');
        idx++;
        continue;
      }
      const leading = /^([ \t]*)/.exec(nextLine)?.[1].length ?? 0;
      if (leading <= propIndent) {
        break;
      }
      if (contentIndent === null) {
        contentIndent = leading;
      }
      blockLines.push(nextLine.slice(Math.min(contentIndent, leading)));
      idx++;
    }

    // Trim trailing empty lines unless `|+` keep chomping was requested
    if (chomp !== '+') {
      while (
        blockLines.length > 0 &&
        blockLines[blockLines.length - 1] === ''
      ) {
        blockLines.pop();
      }
    }

    let joined: string;
    if (style === '>') {
      // Folded block scalar: single newlines fold to spaces; blank lines become `\n`
      joined = blockLines
        .join('\n')
        .replace(/([^\n])\n([^\n])/g, '$1 $2');
    } else {
      joined = blockLines.join('\n');
    }
    if (chomp === '+' && blockLines.length > 0) {
      joined += '\n';
    }
    return { value: joined, nextIndex: idx };
  }

  // Flow / inline scalar (preserving both deeper-indented folded lines AND unindented multi-line LLM outputs)
  let acc = trimmedRest;
  let pendingBlankLine = false;

  let idx = startLineIndex + 1;
  while (idx < lines.length) {
    const nextLine = lines[idx];
    const nextTrimmed = nextLine.trim();

    if (nextTrimmed === '') {
      let peek = idx + 1;
      while (peek < lines.length && lines[peek].trim() === '') {
        peek++;
      }
      if (
        peek < lines.length &&
        !isYamlScalarBoundaryLine(
          lines[peek],
          itemIndent,
          propIndent,
          knownSchemaKeys,
        )
      ) {
        pendingBlankLine = true;
        idx++;
        continue;
      }
      break;
    }

    if (
      isYamlScalarBoundaryLine(nextLine, itemIndent, propIndent, knownSchemaKeys)
    ) {
      break;
    }

    const leading = /^([ \t]*)/.exec(nextLine)?.[1].length ?? 0;
    if (acc === '') {
      acc = nextTrimmed;
    } else if (pendingBlankLine) {
      acc += `\n\n${nextTrimmed}`;
    } else if (leading <= propIndent) {
      // LLM emitted an unindented or property-level line break inside a scalar: preserve `\n`!
      acc += `\n${nextTrimmed}`;
    } else {
      acc += ` ${nextTrimmed}`;
    }
    pendingBlankLine = false;
    idx++;
  }

  if (acc === '') {
    return { value: '', nextIndex: idx };
  }

  return { value: unquoteScalarIfWrapped(acc), nextIndex: idx };
}

function tryPrimaryYamlLibraryParse(
  yamlText: string,
  transFieldCandidates: readonly string[],
): RawParsedYamlItem[] | null {
  try {
    const doc: unknown = parseYaml(yamlText, {
      strict: true,
      uniqueKeys: false,
    });
    if (!Array.isArray(doc)) return null;

    const results: RawParsedYamlItem[] = [];
    for (const rawEntry of doc) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        return null;
      }
      const obj = rawEntry as Record<string, unknown>;
      const rawId = obj.id;
      const id =
        typeof rawId === 'number'
          ? rawId
          : Number.parseInt(String(rawId ?? '').trim(), 10);
      if (!Number.isFinite(id)) continue;

      let transValue: string | undefined;
      for (const candidate of transFieldCandidates) {
        const val = obj[candidate];
        if (val !== undefined && val !== null) {
          // If an unescaped colon caused `yaml` to parse `trans` as a nested object, reject library parse!
          if (typeof val === 'object') {
            return null;
          }
          transValue = String(val);
          break;
        }
      }

      if (transValue === undefined) continue;

      const rawThinking = obj.thinking ?? obj.thought;
      if (rawThinking !== undefined && rawThinking !== null && typeof rawThinking === 'object') {
        return null;
      }

      results.push({
        id,
        trans: transValue,
        ...(rawThinking !== undefined &&
        rawThinking !== null &&
        String(rawThinking).trim() !== ''
          ? { thinking: String(rawThinking) }
          : {}),
      });
    }

    return results;
  } catch {
    return null;
  }
}

function alignParsedItemsStrictlyById(
  parsedItems: readonly RawParsedYamlItem[],
  inputItems: readonly BatchItemInput[],
): BatchItemOutput[] {
  if (parsedItems.length === 0 || inputItems.length === 0) return [];

  const bySlotIndex = new Map<number, RawParsedYamlItem>();

  for (const parsed of parsedItems) {
    // 1. Primary 1..N wire slot alignment (`wireId = index + 1`)
    if (parsed.id >= 1 && parsed.id <= inputItems.length) {
      bySlotIndex.set(parsed.id - 1, parsed);
      continue;
    }
    // 2. Fallback exact `BatchItemInput.id` match when caller passes custom non-1..N IDs directly in decode tests
    const directIdx = inputItems.findIndex((it) => it.id === parsed.id);
    if (directIdx !== -1 && !bySlotIndex.has(directIdx)) {
      bySlotIndex.set(directIdx, parsed);
    }
  }

  const outputs: BatchItemOutput[] = [];
  inputItems.forEach((inputItem, idx) => {
    const hit = bySlotIndex.get(idx);
    if (!hit) return;
    outputs.push({
      id: inputItem.id,
      trans: hit.trans,
      ...(hit.thinking ? { thinking: hit.thinking } : {}),
    });
  });

  return outputs;
}

function resolveTransFieldCandidates(
  scene?: TranslationScene | 'service-test',
  assistant?: AssistantConfig,
): { transFields: string[]; sourceFields: string[] } {
  const env = assistant?.env ?? {};
  const primaryTrans =
    scene === 'subtitle'
      ? env.imt_sub_trans_field || env.imt_trans_field || 'trans'
      : env.imt_trans_field || 'trans';
  const primarySource =
    scene === 'subtitle'
      ? env.imt_sub_source_field || env.imt_source_field || 'src'
      : env.imt_source_field || 'src';

  const transFields = Array.from(
    new Set([primaryTrans, 'trans', 'translation', 'target']),
  );
  const sourceFields = Array.from(new Set([primarySource, 'src', 'source']));
  return { transFields, sourceFields };
}

function parseRawYamlBatch(
  yamlBody: string,
  scene?: TranslationScene | 'service-test',
  assistant?: AssistantConfig,
): RawParsedYamlItem[] {
  if (!yamlBody.trim()) return [];
  const { transFields, sourceFields } = resolveTransFieldCandidates(
    scene,
    assistant,
  );

  const primary = tryPrimaryYamlLibraryParse(yamlBody, transFields);
  const fallback = parseYamlItemsStateMachine(
    yamlBody,
    transFields,
    sourceFields,
  );

  if (primary && primary.length >= fallback.length && primary.length > 0) {
    return primary;
  }
  return fallback.length > 0 ? fallback : (primary ?? []);
}

export class YamlPromptCodec implements PromptCodec {
  readonly id = 'yaml' as const;

  encode(input: CodecEncodeInput): EncodedPrompt {
    const assistant = input.assistant ?? BUILTIN_ASSISTANTS['builtin-yaml'];
    const { systemPrompt, userPrompt } = expandAssistantPrompts({
      assistant,
      scene: input.scene,
      fromLang: input.fromLang,
      toLang: input.toLang,
      items: input.items,
      context: input.context,
      glossary: input.glossary,
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
    const yamlBody = extractCleanYamlPayload(rawOutput, false, false);
    const parsed = parseRawYamlBatch(yamlBody, options?.scene, options?.assistant);
    return alignParsedItemsStrictlyById(parsed, items);
  }

  createStreamParser(
    items: readonly BatchItemInput[],
    options?: {
      scene?: TranslationScene | 'service-test';
      assistant?: AssistantConfig;
    },
  ): CodecStreamParser {
    let buffer = '';
    const emittedTransById = new Map<number, string>();
    const activeAssistant =
      options?.assistant ?? BUILTIN_ASSISTANTS['builtin-yaml'];
    const expectYamlTag =
      /<yaml\b/i.test(activeAssistant.prompt ?? '') ||
      /<yaml\b/i.test(activeAssistant.multiplePrompt ?? '') ||
      /<yaml\b/i.test(activeAssistant.inputPrompt ?? '') ||
      /<yaml\b/i.test(activeAssistant.selectionPrompt ?? '') ||
      /<yaml\b/i.test(activeAssistant.subtitlePrompt ?? '') ||
      /<yaml\b/i.test(activeAssistant.systemPrompt ?? '');

    return {
      push: (delta: string): BatchItemOutput[] => {
        buffer += delta;
        const visible = extractStreamableVisibleText(buffer);
        if (!visible) return [];

        const yamlClosed = /<\/yaml>/i.test(visible);
        const yamlBody = extractCleanYamlPayload(visible, true, expectYamlTag);
        if (!yamlBody) return [];

        const { transFields, sourceFields } = resolveTransFieldCandidates(
          options?.scene,
          options?.assistant,
        );
        const rawItems = parseYamlItemsStateMachine(
          yamlBody,
          transFields,
          sourceFields,
        );

        // An item is guaranteed complete mid-stream once a subsequent `- id:` item has started OR `</yaml>` arrived!
        const completeCount = yamlClosed
          ? rawItems.length
          : Math.max(0, rawItems.length - 1);
        if (completeCount === 0) return [];

        const aligned = alignParsedItemsStrictlyById(
          rawItems.slice(0, completeCount),
          items,
        );
        const newlyReady: BatchItemOutput[] = [];
        for (const out of aligned) {
          if (
            out.trans.trim() !== '' &&
            emittedTransById.get(out.id) !== out.trans
          ) {
            emittedTransById.set(out.id, out.trans);
            newlyReady.push(out);
          }
        }
        return newlyReady;
      },

      finish: () => {
        const allItems = this.decode(buffer, items, options);
        const newlyReady = allItems.filter(
          (item) => emittedTransById.get(item.id) !== item.trans,
        );
        for (const item of newlyReady) {
          emittedTransById.set(item.id, item.trans);
        }
        return { allItems, newlyReady };
      },
    };
  }
}

export const yamlPromptCodec = new YamlPromptCodec();
