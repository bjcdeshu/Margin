import { BUILTIN_ASSISTANTS } from '@shared/constants';
import type {
  AssistantConfig,
  BatchItemInput,
  BatchItemOutput,
  TranslationScene,
} from '@shared/types';
import { parse as parseYaml } from 'yaml';
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

const BLOCK_SCALAR_HEADER_RE =
  /:\s*[|>][-+]?\d*[ \t]*\r?\n([ \t]*)\{\{\s*(?:yaml_)?text\s*\}\}/m;

const NEEDS_YAML_FLOW_QUOTE_RE =
  /(?:^\s|\s$|\n|:[ \t]|:$|[ \t]#|^[-?:,[\]{}#&*!|>'"%@`]|^(?:true|false|null|yes|no|on|off|~|[-+]?\d+(?:\.\d+)?)$)/i;

function needsYamlFlowQuoting(value: string): boolean {
  if (value === '') return true;
  return NEEDS_YAML_FLOW_QUOTE_RE.test(value);
}

export function formatYamlItemRow(
  itemTemplate: string,
  wireId: number,
  rawText: string,
  sharedVars: Readonly<Record<string, string>>,
): string {
  const preExpanded = interpolateTemplate(itemTemplate, {
    ...sharedVars,
    id: String(wireId),
  });

  const normalizedText = String(rawText ?? '').replace(/\r\n?/g, '\n');
  const blockMatch = BLOCK_SCALAR_HEADER_RE.exec(preExpanded);

  if (blockMatch) {
    const templateIndent = blockMatch[1] ?? '';
    const effectiveIndent = templateIndent.length > 0 ? templateIndent : '    ';
    const indentedSubsequent = normalizedText
      .split('\n')
      .map((line, idx) => {
        if (idx === 0) {
          return templateIndent.length > 0 ? line : `${effectiveIndent}${line}`;
        }
        return line.length === 0 ? '' : `${effectiveIndent}${line}`;
      })
      .join('\n');

    return preExpanded.replace(
      /\{\{\s*(?:yaml_)?text\s*\}\}/g,
      () => indentedSubsequent,
    );
  }

  const safeFlow = needsYamlFlowQuoting(normalizedText)
    ? JSON.stringify(normalizedText)
    : normalizedText;

  return preExpanded.replace(/\{\{\s*(?:yaml_)?text\s*\}\}/g, () => safeFlow);
}

export function extractCleanYamlPayload(
  rawText: string,
  allowUnclosedTag = false,
): string {
  const stripped = stripThinkingBlocks(rawText);
  if (!stripped) return '';

  // Prefer explicit `<yaml>...</yaml>` wrapper when present
  const closedMatches = Array.from(
    stripped.matchAll(/<yaml\b[^>]*>([\s\S]*?)<\/yaml>/gi),
  );
  let body =
    closedMatches.length > 0
      ? closedMatches[closedMatches.length - 1][1]
      : stripped;

  if (closedMatches.length === 0 && allowUnclosedTag) {
    const unclosed = /<yaml\b[^>]*>([\s\S]*)$/i.exec(stripped);
    if (unclosed) {
      body = unclosed[1];
    }
  } else if (closedMatches.length === 0) {
    const unclosed = /<yaml\b[^>]*>([\s\S]*)$/i.exec(stripped);
    if (unclosed) {
      body = unclosed[1];
    }
  }

  body = body.trim();

  // Strip surrounding ```yaml ... ``` or ``` ... ``` markdown code fences
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
      // Unescaped inner double-quotes (e.g. `"Hello" world: "ok"`) — keep verbatim!
      return trimmed;
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    const inner = trimmed.slice(1, -1);
    // Only unwrap if there are no unescaped single quotes inside
    if (!/(?<!')'(?!')/.test(inner)) {
      return inner.replace(/''/g, "'");
    }
  }
  return trimmed;
}

/**
 * Tolerant line-by-line `- id:` state-machine parser for `<yaml>` responses.
 * Recovers cleanly when LLMs emit unescaped colons (`:` / `：`) or unescaped
 * quotes (`"` / `'`) inside `thinking` or `trans` flow scalars.
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
      const consumed = readFieldValue(lines, i, propIndent, rest);
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
          const consumed = readFieldValue(lines, i, indentLen, rest);
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
  propIndent: number,
  restAfterColon: string,
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

  // Flow / inline scalar (with optional indented continuation lines)
  const continuation: string[] = [];
  if (trimmedRest !== '') {
    continuation.push(trimmedRest);
  }

  let idx = startLineIndex + 1;
  while (idx < lines.length) {
    const nextLine = lines[idx];
    const nextTrimmed = nextLine.trim();
    if (nextTrimmed === '') {
      // Peek ahead: only continue if a deeper-indented non-empty line follows before next key/item
      let peek = idx + 1;
      while (peek < lines.length && lines[peek].trim() === '') {
        peek++;
      }
      if (peek < lines.length) {
        const peekIndent = /^([ \t]*)/.exec(lines[peek])?.[1].length ?? 0;
        if (peekIndent > propIndent && !/^[ \t]*-\s+/.test(lines[peek])) {
          continuation.push('');
          idx++;
          continue;
        }
      }
      break;
    }

    const leading = /^([ \t]*)/.exec(nextLine)?.[1].length ?? 0;
    if (leading <= propIndent || /^[ \t]*-\s+/.test(nextLine)) {
      break;
    }
    continuation.push(nextTrimmed);
    idx++;
  }

  if (continuation.length === 0) {
    return { value: '', nextIndex: idx };
  }
  if (continuation.length === 1) {
    return { value: unquoteScalarIfWrapped(continuation[0]), nextIndex: idx };
  }

  const combined = continuation.join(' ').replace(/  +/g, ' ').trim();
  return { value: unquoteScalarIfWrapped(combined), nextIndex: idx };
}

function tryPrimaryYamlLibraryParse(
  yamlText: string,
  transFieldCandidates: readonly string[],
): RawParsedYamlItem[] | null {
  try {
    const doc: unknown = parseYaml(yamlText, {
      strict: false,
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
    const baseVars = buildExpandedPromptVariables({
      scene: input.scene,
      fromLang: input.fromLang,
      toLang: input.toLang,
      items: input.items,
      assistant,
      context: input.context,
      glossary: input.glossary,
    });

    const itemTemplate =
      input.scene === 'subtitle'
        ? assistant.env.imt_subtitle_yaml_item ||
          assistant.env.imt_yaml_item ||
          BUILTIN_ASSISTANTS['builtin-yaml'].env.imt_subtitle_yaml_item
        : assistant.env.imt_yaml_item ||
          BUILTIN_ASSISTANTS['builtin-yaml'].env.imt_yaml_item;

    const yamlBlock = input.items
      .map((item, idx) =>
        formatYamlItemRow(itemTemplate, idx + 1, item.text, baseVars),
      )
      .join('\n');

    const fullVars: Record<string, string> = {
      ...baseVars,
      yaml: yamlBlock,
      text: yamlBlock,
    };

    const { systemTemplate, userTemplate } = selectPromptsForBatch(
      assistant,
      input.scene,
      input.items.length,
    );

    return {
      systemPrompt: interpolateTemplate(systemTemplate, fullVars).trim(),
      userPrompt: interpolateTemplate(userTemplate, fullVars).trim(),
    };
  }

  decode(
    rawOutput: string,
    items: readonly BatchItemInput[],
    options?: {
      scene?: TranslationScene | 'service-test';
      assistant?: AssistantConfig;
    },
  ): BatchItemOutput[] {
    const yamlBody = extractCleanYamlPayload(rawOutput, false);
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
    const emittedIds = new Set<number>();

    return {
      push: (delta: string): BatchItemOutput[] => {
        buffer += delta;
        const visible = extractStreamableVisibleText(buffer);
        if (!visible) return [];

        const yamlClosed = /<\/yaml>/i.test(visible);
        const yamlBody = extractCleanYamlPayload(visible, true);
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
          if (!emittedIds.has(out.id) && out.trans.trim() !== '') {
            emittedIds.add(out.id);
            newlyReady.push(out);
          }
        }
        return newlyReady;
      },

      finish: () => {
        const allItems = this.decode(buffer, items, options);
        const newlyReady = allItems.filter((item) => !emittedIds.has(item.id));
        for (const item of newlyReady) {
          emittedIds.add(item.id);
        }
        return { allItems, newlyReady };
      },
    };
  }
}

export const yamlPromptCodec = new YamlPromptCodec();
