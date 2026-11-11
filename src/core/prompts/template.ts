import { getEnglishLanguageName } from '@shared/constants';
import type {
  AssistantConfig,
  BatchItemInput,
  GlossaryEntry,
  PageContextPayload,
  TranslationScene,
} from '@shared/types';
import { buildGlossaryPromptVars } from './glossary';

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

const DEFAULT_OPTIONAL_PROMPT_VARS: Readonly<Record<string, string>> = {
  title_prompt: '',
  summary_prompt: '',
  terms_prompt: '',
  sub_summary_prompt: '',
  sub_terms_prompt: '',
  style_prompt: '',
  html_only: '',
  extra_prompt: '',
};

export function hasRichMarkupInItems(items: readonly BatchItemInput[]): boolean {
  return items.some(
    (item) => item.hasRichTags === true || /<\/?m\d+\b/i.test(item.text),
  );
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
    imt_source_field: imtSourceField,
    imt_trans_field: imtTransField,
    imt_sub_source_field: rawEnv.imt_sub_source_field || imtSourceField,
    imt_sub_trans_field: rawEnv.imt_sub_trans_field || imtTransField,
    ...extraVars,
  };

  // Evaluate `assistant.env` entries (excluding item row templates expanded per-item)
  const ITEM_TEMPLATE_KEYS = new Set(['imt_yaml_item', 'imt_subtitle_yaml_item']);
  const envEntries = Object.entries(rawEnv).filter(
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
      const imtRefs = refs.filter((r) => r.startsWith('imt_'));
      if (
        imtRefs.length > 0 &&
        imtRefs.every((r) => String(baseVars[r] ?? '').trim() === '')
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
            r.startsWith('imt_') ||
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
  scene: TranslationScene | 'service-test',
  itemCount: number,
): { systemTemplate: string; userTemplate: string } {
  const systemTemplate =
    itemCount > 1 && assistant.multipleSystemPrompt?.trim()
      ? assistant.multipleSystemPrompt
      : assistant.systemPrompt;

  let userTemplate = assistant.prompt;
  if (scene === 'subtitle' && assistant.subtitlePrompt?.trim()) {
    userTemplate = assistant.subtitlePrompt;
  } else if (itemCount > 1 && assistant.multiplePrompt?.trim()) {
    userTemplate = assistant.multiplePrompt;
  }

  return { systemTemplate, userTemplate };
}
