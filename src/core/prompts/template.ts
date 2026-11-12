import { BUILTIN_ASSISTANTS, getEnglishLanguageName } from '@shared/constants';
import type {
  AssistantConfig,
  BatchItemInput,
  GlossaryEntry,
  PageContextPayload,
  TranslationScene,
} from '@shared/types';
import { buildGlossaryPromptVars } from './glossary';

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

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

const DEFAULT_OPTIONAL_PROMPT_VARS: Readonly<Record<string, string>> = {
  title_prompt: '',
  summary_prompt: '',
  terms_prompt: '',
  glossary_prompt: '',
  sub_summary_prompt: '',
  sub_terms_prompt: '',
  style_prompt: '',
  html_only: '',
  extra_prompt: '',
  title: '',
  summary: '',
  styleGuide: '',
  style_guide: '',
  domain: '',
  url: '',
  terms: '',
  keepOriginalInstruction: '',
  glossaryMappingInstruction: '',
  glossaryInstruction: '',
};

const BUILTIN_CONDITIONAL_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  title_prompt: 'Document Title: {{imt_title}}\n',
  summary_prompt: 'Context Summary: {{imt_summary}}\n',
  style_prompt: 'Style Guide: {{styleGuide}}\n',
  glossary_prompt: '{{glossaryInstruction}}\n',
  terms_prompt: 'Required Glossary: {{imt_terms}}\n',
  sub_summary_prompt: 'Video Context: {{imt_summary}}\n',
  sub_terms_prompt: 'Required Glossary: {{imt_terms}}\n',
};

const PRUNABLE_DYNAMIC_VARS = new Set([
  'title',
  'summary',
  'styleGuide',
  'style_guide',
  'domain',
  'url',
  'terms',
  'keepOriginalInstruction',
  'glossaryMappingInstruction',
  'glossaryInstruction',
]);

function isPrunableContextOrGlossaryVar(name: string): boolean {
  return name.startsWith('imt_') || PRUNABLE_DYNAMIC_VARS.has(name);
}

const RICH_TAG_MARKER_RE = /<\/?m(?:\d+|N)\b/i;

const DEFAULT_RICH_TAG_INSTRUCTION =
  'HTML Tag Rule: When the source contains inline <m0>...</m0>, <m1>...</m1> tags, preserve every <mN>...</mN> tag pair and its exact numeric index around the corresponding translated phrase without adding, dropping, or renaming tags.';

export function hasRichMarkupInItems(items: readonly BatchItemInput[]): boolean {
  return items.some(
    (item) => item.hasRichTags === true || /<\/?m\d+\b/i.test(item.text),
  );
}

/**
 * Ensures custom imported prompts that omitted `{{html_only}}` still instruct
 * the model to preserve `<m0>...</m0>` inline markup placeholders whenever the
 * encoded batch actually contains rich inline tags.
 */
export function ensureRichTagInstruction(
  systemPrompt: string,
  userPrompt: string,
  items: readonly BatchItemInput[],
): string {
  if (!hasRichMarkupInItems(items)) {
    return systemPrompt;
  }
  if (
    RICH_TAG_MARKER_RE.test(systemPrompt) ||
    RICH_TAG_MARKER_RE.test(userPrompt)
  ) {
    return systemPrompt;
  }
  return systemPrompt
    ? `${systemPrompt}\n\n${DEFAULT_RICH_TAG_INSTRUCTION}`
    : DEFAULT_RICH_TAG_INSTRUCTION;
}

export function stripThinkingBlocks(raw: string): string {
  if (!raw) return '';
  // Remove complete `<think>...</think>` blocks first
  const withoutComplete = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  // If an unclosed `<think>` appears at the start with no closing tag, strip only if nothing else exists
  if (/<think\b[^>]*>/i.test(withoutComplete) && !/<\/think>/i.test(withoutComplete)) {
    return withoutComplete.replace(/<think\b[^>]*>[\s\S]*$/i, '').trim();
  }
  return withoutComplete.trim();
}

/**
 * Strips completed `<think>...</think>` blocks from a streaming buffer.
 * If the buffer currently ends inside an unclosed `<think>` block, withholds
 * the unclosed `<think>...` tail so reasoning tokens never leak as translated items.
 */
export function extractStreamableVisibleText(rawBuffer: string): string {
  if (!rawBuffer) return '';
  const cleaned = rawBuffer.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  const openIdx = cleaned.search(/<think\b[^>]*>/i);
  if (openIdx !== -1) {
    return cleaned.slice(0, openIdx);
  }
  return cleaned;
}

export function interpolateTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  if (!template) return '';
  return template.replace(PLACEHOLDER_RE, (fullMatch, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key] ?? '';
    }
    if (Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONAL_PROMPT_VARS, key)) {
      return DEFAULT_OPTIONAL_PROMPT_VARS[key];
    }
    return fullMatch;
  });
}

export interface BuildTemplateVarsInput {
  scene: TranslationScene | 'service-test';
  fromLang: string;
  toLang: string;
  items: readonly BatchItemInput[];
  assistant?: AssistantConfig;
  context?: PageContextPayload;
  glossary?: readonly GlossaryEntry[];
  extraVars?: Readonly<Record<string, string>>;
}

/**
 * Builds two-pass interpolated template variables with full Aloxaf / Immersive
 * Translate `aJ` conditional empty-section pruning parity:
 * - Any non-`imt_*` `env` template whose referenced `{{imt_*}}` / pruned variables
 *   all evaluate to `""` collapses cleanly to `""` (eliminating dangling headers
 *   such as `"Required Glossary: \n"` or `"Document Title: \n"`).
 * - `html_only` automatically collapses to `""` when the batch is plain text.
 */
export function buildExpandedPromptVariables(
  input: BuildTemplateVarsInput,
): Record<string, string> {
  const {
    scene,
    fromLang,
    toLang,
    items,
    assistant,
    context,
    glossary = [],
    extraVars = {},
  } = input;

  const domainOrUrl = context?.url || context?.domain;
  const glossaryVars = buildGlossaryPromptVars(
    items.map((it) => it.text),
    glossary,
    domainOrUrl,
  );

  const richBatch = hasRichMarkupInItems(items);
  const rawEnv = assistant?.env ?? {};

  const fromName =
    fromLang === 'auto' ? 'Auto Detect' : getEnglishLanguageName(fromLang);
  const toName = getEnglishLanguageName(toLang);

  const imtSourceField =
    scene === 'subtitle'
      ? rawEnv.imt_sub_source_field || rawEnv.imt_source_field || 'src'
      : rawEnv.imt_source_field || 'src';
  const imtTransField =
    scene === 'subtitle'
      ? rawEnv.imt_sub_trans_field || rawEnv.imt_trans_field || 'trans'
      : rawEnv.imt_trans_field || 'trans';

  const baseVars: Record<string, string> = {
    ...DEFAULT_OPTIONAL_PROMPT_VARS,
    from: fromName,
    from_lang: fromName,
    to: toName,
    to_lang: toName,
    content_type: richBatch ? 'html' : 'text',
    title: String(context?.title ?? '').trim(),
    summary: String(context?.summary ?? '').trim(),
    styleGuide: String(context?.styleGuide ?? '').trim(),
    style_guide: String(context?.styleGuide ?? '').trim(),
    domain: String(context?.domain ?? '').trim(),
    url: String(context?.url ?? '').trim(),
    imt_title: String(context?.title ?? '').trim(),
    imt_url: String(context?.url ?? '').trim(),
    imt_domain: String(context?.domain ?? '').trim(),
    imt_theme: String(context?.summary ?? '').trim(),
    imt_summary: String(context?.summary ?? '').trim(),
    imt_description: String(context?.summary ?? '').trim(),
    imt_style_guide: String(context?.styleGuide ?? '').trim(),
    imt_terms: glossaryVars.imt_terms,
    imt_terms_with_domain: glossaryVars.imt_terms_with_domain,
    imt_terms_without_domain: glossaryVars.imt_terms_without_domain,
    keepOriginalInstruction: glossaryVars.keepOriginalInstruction,
    glossaryMappingInstruction: glossaryVars.glossaryMappingInstruction,
    glossaryInstruction: glossaryVars.glossaryInstruction,
    terms: glossaryVars.terms,
    imt_source_field: imtSourceField,
    imt_trans_field: imtTransField,
    imt_sub_source_field: rawEnv.imt_sub_source_field || imtSourceField,
    imt_sub_trans_field: rawEnv.imt_sub_trans_field || imtTransField,
    ...extraVars,
  };

  // Evaluate `assistant.env` entries (with built-in conditional header fallbacks when omitted)
  const ITEM_TEMPLATE_KEYS = new Set(['imt_yaml_item', 'imt_subtitle_yaml_item']);
  const effectiveEnv: Record<string, string> = {
    ...BUILTIN_CONDITIONAL_ENV_DEFAULTS,
    ...rawEnv,
  };
  const envEntries = Object.entries(effectiveEnv).filter(
    ([k]) => !ITEM_TEMPLATE_KEYS.has(k),
  );

  const resolvedEnv: Record<string, string> = {};
  const prunedKeys = new Set<string>();

  // Pass 1: Direct `imt_*` & `html_only` conditional pruning (`aJ` parity)
  for (const [key, rawTemplate] of envEntries) {
    const tpl = String(rawTemplate ?? '');
    if (key === 'html_only' && !richBatch) {
      resolvedEnv[key] = '';
      prunedKeys.add(key);
      continue;
    }

    if (!key.startsWith('imt_')) {
      const refs = Array.from(tpl.matchAll(PLACEHOLDER_RE), (m) => m[1]);
      const condRefs = refs.filter(isPrunableContextOrGlossaryVar);
      if (
        condRefs.length > 0 &&
        condRefs.every((r) => String(baseVars[r] ?? '').trim() === '')
      ) {
        resolvedEnv[key] = '';
        prunedKeys.add(key);
        continue;
      }
    }

    resolvedEnv[key] = tpl;
  }

  // Pass 2..3: Nested `env` expansion & transitive empty-wrapper pruning
  for (let pass = 0; pass < 3; pass++) {
    const mergedLookup: Record<string, string> = {
      ...baseVars,
      ...resolvedEnv,
      ...extraVars,
    };

    for (const [key] of envEntries) {
      if (prunedKeys.has(key)) continue;
      const currentTpl = resolvedEnv[key] ?? '';
      if (!key.startsWith('imt_')) {
        const refs = Array.from(currentTpl.matchAll(PLACEHOLDER_RE), (m) => m[1]);
        const dynamicRefs = refs.filter(
          (r) =>
            isPrunableContextOrGlossaryVar(r) ||
            Object.prototype.hasOwnProperty.call(resolvedEnv, r),
        );
        if (
          dynamicRefs.length > 0 &&
          dynamicRefs.every((r) => String(mergedLookup[r] ?? '').trim() === '')
        ) {
          resolvedEnv[key] = '';
          prunedKeys.add(key);
          continue;
        }
      }
      resolvedEnv[key] = interpolateTemplate(currentTpl, mergedLookup);
    }
  }

  // Ensure `html_only` stays empty on plain-text batches even if not in `env`
  if (!richBatch) {
    resolvedEnv.html_only = '';
  }

  return {
    ...baseVars,
    ...resolvedEnv,
    ...extraVars,
  };
}

export function selectPromptsForBatch(
  assistant: AssistantConfig,
  scene: TranslationScene | 'service-test' = 'webpage',
  itemCount = 1,
): { systemTemplate: string; userTemplate: string } {
  const systemTemplate =
    itemCount > 1 && assistant.multipleSystemPrompt?.trim()
      ? assistant.multipleSystemPrompt
      : assistant.systemPrompt;

  let userTemplate = assistant.prompt;
  if (scene === 'input' && assistant.inputPrompt?.trim()) {
    userTemplate = assistant.inputPrompt;
  } else if (scene === 'selection' && assistant.selectionPrompt?.trim()) {
    userTemplate = assistant.selectionPrompt;
  } else if (scene === 'subtitle' && assistant.subtitlePrompt?.trim()) {
    userTemplate = assistant.subtitlePrompt;
  } else if (itemCount > 1 && assistant.multiplePrompt?.trim()) {
    userTemplate = assistant.multiplePrompt;
  } else if (!userTemplate?.trim() && assistant.multiplePrompt?.trim()) {
    userTemplate = assistant.multiplePrompt;
  }

  return { systemTemplate, userTemplate };
}

export interface ExpandAssistantPromptsInput {
  assistant: AssistantConfig;
  scene?: TranslationScene | 'service-test';
  fromLang: string;
  toLang: string;
  items: readonly BatchItemInput[];
  context?: PageContextPayload;
  glossary?: readonly GlossaryEntry[];
  extraVars?: Readonly<Record<string, string>>;
}

function normalizePromptSpacing(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function expandAssistantPrompts(input: ExpandAssistantPromptsInput): {
  systemPrompt: string;
  userPrompt: string;
  vars: Record<string, string>;
} {
  const scene = input.scene ?? 'webpage';
  const assistant = input.assistant;
  const baseVars = buildExpandedPromptVariables({
    scene,
    fromLang: input.fromLang,
    toLang: input.toLang,
    items: input.items,
    assistant,
    context: input.context,
    glossary: input.glossary,
    extraVars: input.extraVars,
  });

  const computedPayloadVars: Record<string, string> = {};
  const payloadJson = JSON.stringify(
    input.items.map((item, idx) => ({
      id: idx + 1,
      src: item.text,
    })),
  );

  if (input.extraVars?.json === undefined) {
    computedPayloadVars.json = payloadJson;
  }

  if (assistant.codec === 'yaml') {
    if (input.extraVars?.yaml === undefined) {
      const itemTemplate =
        scene === 'subtitle'
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
      computedPayloadVars.yaml = yamlBlock;
      if (input.extraVars?.text === undefined) {
        computedPayloadVars.text = yamlBlock;
      }
    }
  } else if (assistant.codec === 'delimiter') {
    if (input.extraVars?.text === undefined) {
      const sep =
        assistant.separator && assistant.separator.length > 0
          ? assistant.separator
          : BUILTIN_ASSISTANTS['builtin-delimiter'].separator;
      computedPayloadVars.text = input.items.map((it) => it.text).join(sep);
    }
  } else if (assistant.codec === 'json-batch') {
    if (input.extraVars?.text === undefined) {
      computedPayloadVars.text = payloadJson;
    }
  } else if (input.extraVars?.text === undefined) {
    computedPayloadVars.text = input.items.map((it) => it.text).join('\n');
  }

  const vars: Record<string, string> = {
    ...baseVars,
    ...computedPayloadVars,
    ...input.extraVars,
  };

  const { systemTemplate, userTemplate } = selectPromptsForBatch(
    assistant,
    scene,
    input.items.length,
  );

  const rawSystemPrompt = normalizePromptSpacing(
    interpolateTemplate(systemTemplate, vars),
  );
  const userPrompt = interpolateTemplate(userTemplate, vars).trim();
  const userInstructionsOnly = normalizePromptSpacing(
    interpolateTemplate(userTemplate, {
      ...vars,
      yaml: '',
      text: '',
      json: '',
    }),
  );

  return {
    systemPrompt: ensureRichTagInstruction(
      rawSystemPrompt,
      userInstructionsOnly,
      input.items,
    ),
    userPrompt,
    vars,
  };
}
