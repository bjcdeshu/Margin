import type { GlossaryEntry } from '@shared/types';
import { matchesUrlGlob } from '@shared/url-match';

export interface ResolvedGlossaryMatch {
  entry: GlossaryEntry;
  key: string;
  target: string;
  hasDomain: boolean;
}

export interface GlossaryPromptVars {
  matched: ResolvedGlossaryMatch[];
  imt_terms: string;
  imt_terms_with_domain: string;
  imt_terms_without_domain: string;
}

export interface ProtectedGlossaryBatch {
  texts: string[];
  placeholderMap: Map<number, string>;
}

const PROTECTED_INLINE_TAG_RE = /<\/?m(?:\d+|-g\b)[^>]*>/gi;
const RESTORE_GLOSSARY_TAG_RE =
  /[<＜]\s*m-g\s+id\s*=\s*["'“”]?(\d+)["'“”]?\s*(?:\/[>＞]|[>＞]\s*[<＜]\s*\/\s*m-g\s*[>＞])/gi;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAsciiWordChar(ch: string): boolean {
  return /^[A-Za-z0-9_]$/.test(ch);
}

/**
 * Resolves the effective replacement target for a glossary entry.
 * Per Margin & Immersive Translate specification, `v: ""` preserves `k` verbatim
 * (e.g. `{ k: "LLM", v: "" }` -> `"LLM"`).
 */
export function resolveGlossaryTarget(entry: GlossaryEntry): string {
  const trimmedV = String(entry.v ?? '').trim();
  return trimmedV !== '' ? trimmedV : entry.k.trim();
}

export function isGlossaryEntryApplicable(
  entry: GlossaryEntry,
  domainOrUrl?: string,
): boolean {
  const key = String(entry.k ?? '').trim();
  if (!key) return false;

  const domainPattern = String(entry.domain ?? '').trim();
  if (!domainPattern) return true;

  const rawTarget = String(domainOrUrl ?? '').trim();
  if (!rawTarget) return false;

  const normalizedUrl = /^https?:\/\//i.test(rawTarget)
    ? rawTarget
    : `https://${rawTarget.replace(/^\/+/, '')}/`;

  return matchesUrlGlob(normalizedUrl, domainPattern);
}

function buildTermRegExp(key: string, caseSensitive?: boolean): RegExp {
  const escaped = escapeRegExp(key);
  const firstChar = key[0] ?? '';
  const lastChar = key[key.length - 1] ?? '';

  const prefix = isAsciiWordChar(firstChar) ? '(?<![A-Za-z0-9_])' : '';
  const suffix = isAsciiWordChar(lastChar) ? '(?![A-Za-z0-9_])' : '';
  const flags = caseSensitive ? 'g' : 'gi';

  return new RegExp(`${prefix}${escaped}${suffix}`, flags);
}

interface CompiledGlossaryItem {
  entry: GlossaryEntry;
  key: string;
  target: string;
  hasDomain: boolean;
  regex: RegExp;
  order: number;
}

function compileGlossary(
  glossary: readonly GlossaryEntry[],
  domainOrUrl?: string,
): CompiledGlossaryItem[] {
  const items: CompiledGlossaryItem[] = [];
  glossary.forEach((entry, index) => {
    if (!isGlossaryEntryApplicable(entry, domainOrUrl)) return;
    const key = entry.k.trim();
    const target = resolveGlossaryTarget(entry);
    const hasDomain = Boolean(entry.domain && entry.domain.trim());
    items.push({
      entry,
      key,
      target,
      hasDomain,
      regex: buildTermRegExp(key, entry.caseSensitive),
      order: index,
    });
  });

  // Longest-key-first so e.g. `LLMs` matches before `LLM`
  items.sort((a, b) => {
    const lenDiff = b.key.length - a.key.length;
    return lenDiff !== 0 ? lenDiff : a.order - b.order;
  });

  // Deduplicate identical keys (keeping first/longest priority)
  const seen = new Set<string>();
  return items.filter((item) => {
    const dedupKey = item.entry.caseSensitive
      ? `cs:${item.key}`
      : `ci:${item.key.toLowerCase()}`;
    if (seen.has(dedupKey)) return false;
    seen.add(dedupKey);
    return true;
  });
}

interface SpanMatch {
  start: number;
  end: number;
  item: CompiledGlossaryItem;
}

function findNonOverlappingMatches(
  text: string,
  compiled: readonly CompiledGlossaryItem[],
): SpanMatch[] {
  if (!text || compiled.length === 0) return [];

  const claimed = new Uint8Array(text.length);

  // Pre-claim inline rich-text `<m0/>`, `<m1>...</m1>`, and `<m-g .../>` tags
  PROTECTED_INLINE_TAG_RE.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = PROTECTED_INLINE_TAG_RE.exec(text)) !== null) {
    claimed.fill(1, tagMatch.index, tagMatch.index + tagMatch[0].length);
  }

  const matches: SpanMatch[] = [];

  for (const item of compiled) {
    item.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = item.regex.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (end <= start) {
        item.regex.lastIndex = start + 1;
        continue;
      }
      let overlaps = false;
      for (let i = start; i < end; i++) {
        if (claimed[i] === 1) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        claimed.fill(1, start, end);
        matches.push({ start, end, item });
      }
    }
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

export function matchGlossaryEntries(
  texts: readonly string[],
  glossary: readonly GlossaryEntry[],
  domainOrUrl?: string,
): ResolvedGlossaryMatch[] {
  const compiled = compileGlossary(glossary, domainOrUrl);
  if (compiled.length === 0 || texts.length === 0) return [];

  const matchedSet = new Set<CompiledGlossaryItem>();
  for (const text of texts) {
    const spans = findNonOverlappingMatches(text, compiled);
    for (const span of spans) {
      matchedSet.add(span.item);
    }
  }

  // Return in deterministic longest-key-first priority order
  return compiled
    .filter((item) => matchedSet.has(item))
    .map((item) => ({
      entry: item.entry,
      key: item.key,
      target: item.target,
      hasDomain: item.hasDomain,
    }));
}

export function formatGlossaryListForPrompt(
  matches: readonly ResolvedGlossaryMatch[],
): string {
  if (matches.length === 0) return '';
  return matches.map((m) => `'${m.key}': '${m.target}'`).join(', ');
}

export function buildGlossaryPromptVars(
  texts: readonly string[],
  glossary: readonly GlossaryEntry[],
  domainOrUrl?: string,
): GlossaryPromptVars {
  const matched = matchGlossaryEntries(texts, glossary, domainOrUrl);
  const withDomain = matched.filter((m) => m.hasDomain);
  const withoutDomain = matched.filter((m) => !m.hasDomain);

  return {
    matched,
    imt_terms: formatGlossaryListForPrompt(matched),
    imt_terms_with_domain: formatGlossaryListForPrompt(withDomain),
    imt_terms_without_domain: formatGlossaryListForPrompt(withoutDomain),
  };
}

/**
 * Wraps matched glossary terms in `<m-g id="0"/>` neutral XML placeholders
 * for non-AI MT engines (DeepLX, Google Translate Web) so `v: ""` terms like
 * `LLM` / `LLMs` or custom domain translations survive MT untouched.
 */
export function protectGlossaryTokens(
  texts: readonly string[],
  glossary: readonly GlossaryEntry[],
  domainOrUrl?: string,
): ProtectedGlossaryBatch {
  const compiled = compileGlossary(glossary, domainOrUrl);
  const placeholderMap = new Map<number, string>();
  if (compiled.length === 0 || texts.length === 0) {
    return { texts: [...texts], placeholderMap };
  }

  const targetToId = new Map<string, number>();
  let nextId = 0;

  const protectedTexts = texts.map((text) => {
    const spans = findNonOverlappingMatches(text, compiled);
    if (spans.length === 0) return text;

    let out = '';
    let cursor = 0;
    for (const span of spans) {
      out += text.slice(cursor, span.start);
      const effectiveTarget = span.item.target;
      let id = targetToId.get(effectiveTarget);
      if (id === undefined) {
        id = nextId++;
        targetToId.set(effectiveTarget, id);
        placeholderMap.set(id, effectiveTarget);
      }
      out += `<m-g id="${id}"/>`;
      cursor = span.end;
    }
    out += text.slice(cursor);
    return out;
  });

  return {
    texts: protectedTexts,
    placeholderMap,
  };
}

/**
 * Restores `<m-g id="0"/>` placeholders back to their target glossary strings,
 * tolerating extra spaces, case shifts, or fullwidth brackets injected by MT engines.
 */
export function restoreGlossaryTokens(
  translatedText: string,
  placeholderMap: ReadonlyMap<number, string>,
): string {
  if (!translatedText || placeholderMap.size === 0) {
    return translatedText;
  }
  return translatedText.replace(RESTORE_GLOSSARY_TAG_RE, (fullMatch, rawId: string) => {
    const id = Number.parseInt(rawId, 10);
    const replacement = placeholderMap.get(id);
    return replacement !== undefined ? replacement : fullMatch;
  });
}
