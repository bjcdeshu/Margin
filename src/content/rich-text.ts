import {
  getBlockSourceContainer,
  isAtomicInlineElement,
  isBlockBoundaryElement,
  isExcludedElement,
} from './dom-walker';
import { inspectOriginalLinkAppearance } from './effective-text-style';

export const INLINE_FORMATTING_TAGS: ReadonlySet<string> = new Set([
  'A',
  'STRONG',
  'B',
  'EM',
  'I',
  'U',
  'S',
  'MARK',
  'SPAN',
  'SMALL',
  'SUB',
  'SUP',
  'ABBR',
  'CITE',
  'Q',
  'TIME',
  'DEL',
  'INS',
  'DFN',
  'BDI',
  'BDO',
]);

const SAFE_FORMATTING_ATTRS: ReadonlySet<string> = new Set([
  'href',
  'target',
  'rel',
  'title',
  'class',
  'dir',
  'lang',
]);

const SAFE_IMG_EXTRA_ATTRS: ReadonlySet<string> = new Set([
  'src',
  'alt',
  'width',
  'height',
  'loading',
  'decoding',
]);

const SAFE_SVG_ATTRS: ReadonlySet<string> = new Set([
  'viewbox',
  'width',
  'height',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-rule',
  'clip-rule',
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'transform',
  'opacity',
  'aria-hidden',
  'focusable',
  'role',
  'xmlns',
]);

const SAFE_MATH_ATTRS: ReadonlySet<string> = new Set([
  'aria-hidden',
  'role',
  'mathvariant',
  'display',
  'xmlns',
  'encoding',
]);

const FORBIDDEN_ATOMIC_SUBTAGS: ReadonlySet<string> = new Set([
  'SCRIPT',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'FOREIGNOBJECT',
]);

const SAFE_KATEX_STYLE_RE = /^[a-zA-Z0-9\s:;.,#%()+-]*$/;

export type RichTokenDescriptor =
  | {
      id: number;
      kind: 'paired';
      originalElement: Element;
    }
  | {
      id: number;
      kind: 'atomic';
      originalElement: Element;
    };

export interface TokenizedParagraph {
  text: string;
  hasRichTags: boolean;
  plainTextLength: number;
  tokens: Map<number, RichTokenDescriptor>;
  preservesNewlines?: boolean;
}

export interface TokenizedSegment extends TokenizedParagraph {
  sepBefore: string;
  plain: string;
}

export interface ReconstructedRichDom {
  fragment: DocumentFragment;
  fallbackPlain: boolean;
}

export interface RichDomLocaleOptions {
  stripSourceLocaleAttrs?: boolean;
  preserveLinkAppearance?: boolean;
}

const clonedLinkOriginMap = new WeakMap<Element, Element>();

export function bindClonedLinkOrigin(
  cloneAnchor: Element,
  origAnchor: Element,
): void {
  clonedLinkOriginMap.set(cloneAnchor, origAnchor);
}

export function getClonedLinkOrigin(cloneAnchor: Element): Element | undefined {
  return clonedLinkOriginMap.get(cloneAnchor);
}

export function applyPreservedLinkAppearance(
  cloneAnchor: Element,
  origAnchor: Element,
): void {
  const { color, noUnderline } = inspectOriginalLinkAppearance(origAnchor);
  if (noUnderline) {
    cloneAnchor.setAttribute('data-margin-no-underline', 'true');
  } else {
    cloneAnchor.removeAttribute('data-margin-no-underline');
  }

  if (cloneAnchor instanceof HTMLElement) {
    if (color) {
      cloneAnchor.setAttribute('data-margin-has-link-color', 'true');
      cloneAnchor.style.setProperty('--margin-link-color', color);
    } else {
      cloneAnchor.removeAttribute('data-margin-has-link-color');
      cloneAnchor.style.removeProperty('--margin-link-color');
      if (!cloneAnchor.getAttribute('style')?.trim()) {
        cloneAnchor.removeAttribute('style');
      }
    }
  }
}

export function refreshClonedLinksAppearance(rootEl: ParentNode): void {
  const anchors = rootEl.querySelectorAll('a');
  for (let i = 0; i < anchors.length; i++) {
    const cloneAnchor = anchors[i];
    const origAnchor = clonedLinkOriginMap.get(cloneAnchor);
    if (origAnchor && origAnchor.isConnected) {
      applyPreservedLinkAppearance(cloneAnchor, origAnchor);
    }
  }
}

function escapeLiteralMarkerInRawText(raw: string): string {
  return raw.replace(/<(\/?)m(?=\d)/gi, '<$1m\u200B');
}

function unescapeLiteralMarkerInRawText(raw: string): string {
  return raw.replace(/<(\/?)m\u200B(?=\d)/gi, '<$1m');
}

/**
 * Validates `href` values and strips `javascript:`, `vbscript:`, `data:`, and `file:` schemes.
 */
export function sanitizeSafeHref(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  const compact = trimmed.replace(/[\u0000-\u0020\u007F-\u009F]+/g, '');
  if (/^(?:javascript|vbscript|data|file):/i.test(compact)) {
    return null;
  }
  return trimmed;
}

/**
 * Validates `img[src]` values, allowing https/http/relative URLs and raster image data URLs
 * while blocking `javascript:`, `vbscript:`, and scriptable `data:image/svg+xml`.
 */
export function sanitizeSafeImageSrc(rawSrc: string): string | null {
  const trimmed = rawSrc.trim();
  if (!trimmed) return null;
  const compact = trimmed.replace(/[\u0000-\u0020\u007F-\u009F]+/g, '');
  if (/^(?:javascript|vbscript|file):/i.test(compact)) {
    return null;
  }
  if (/^data:/i.test(compact)) {
    if (/^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(compact)) {
      return trimmed;
    }
    return null;
  }
  return trimmed;
}

/**
 * Clones a formatting element shallowly via `cloneNode(false)` and retains ONLY
 * verified safe attributes (`href, target, rel, title, class, dir, lang`),
 * optionally stripping source `lang`/`dir` attributes when `stripSourceLocaleAttrs` is enabled.
 */
export function cloneFormattingElementSafely(
  origEl: Element,
  options?: RichDomLocaleOptions,
): Element {
  const stripLocaleAttrs = Boolean(options?.stripSourceLocaleAttrs);
  const clone = origEl.cloneNode(false) as Element;
  const attrNames: string[] = [];
  for (let i = 0; i < clone.attributes.length; i++) {
    attrNames.push(clone.attributes[i].name);
  }

  for (const attrName of attrNames) {
    const lower = attrName.toLowerCase();
    if (
      lower.startsWith('on') ||
      !SAFE_FORMATTING_ATTRS.has(lower) ||
      (stripLocaleAttrs && (lower === 'lang' || lower === 'dir' || lower === 'xml:lang'))
    ) {
      clone.removeAttribute(attrName);
      continue;
    }
    if (lower === 'href') {
      const safeHref = sanitizeSafeHref(origEl.getAttribute(attrName) ?? '');
      if (safeHref === null) {
        clone.removeAttribute(attrName);
      } else {
        clone.setAttribute('href', safeHref);
      }
    }
  }

  if (options?.preserveLinkAppearance && origEl.tagName.toUpperCase() === 'A') {
    bindClonedLinkOrigin(clone, origEl);
    applyPreservedLinkAppearance(clone, origEl);
  }

  return clone;
}

/**
 * Reconstructs an atomic inline element (`code`, `.katex`, `mjx-container`, `img`, `svg`)
 * strictly via `cloneNode(false)` + attribute whitelisting + `document.createTextNode(...)`.
 */
export function cloneAtomicNodeSafely(
  origNode: Node,
  doc: Document,
  context: { inSvg?: boolean; inMath?: boolean } = {},
): Node {
  if (origNode.nodeType === Node.TEXT_NODE) {
    return doc.createTextNode(origNode.nodeValue ?? '');
  }

  if (origNode.nodeType !== Node.ELEMENT_NODE) {
    return doc.createDocumentFragment();
  }

  const el = origNode as Element;
  const upperTag = el.tagName.toUpperCase();
  if (FORBIDDEN_ATOMIC_SUBTAGS.has(upperTag)) {
    return doc.createDocumentFragment();
  }

  const inSvg =
    context.inSvg ||
    upperTag === 'SVG' ||
    el.namespaceURI === 'http://www.w3.org/2000/svg';
  const inMath =
    context.inMath ||
    upperTag === 'MATH' ||
    upperTag === 'MJX-CONTAINER' ||
    el.classList?.contains('katex') ||
    el.classList?.contains('katex-display') ||
    el.classList?.contains('MathJax');

  const clone = el.cloneNode(false) as Element;
  const attrNames: string[] = [];
  for (let i = 0; i < clone.attributes.length; i++) {
    attrNames.push(clone.attributes[i].name);
  }

  for (const attrName of attrNames) {
    const lower = attrName.toLowerCase();
    if (lower.startsWith('on')) {
      clone.removeAttribute(attrName);
      continue;
    }

    if (lower === 'href' || lower === 'xlink:href') {
      if (inSvg) {
        clone.removeAttribute(attrName);
      } else {
        const safeHref = sanitizeSafeHref(el.getAttribute(attrName) ?? '');
        if (safeHref === null) {
          clone.removeAttribute(attrName);
        } else {
          clone.setAttribute('href', safeHref);
        }
      }
      continue;
    }

    if (upperTag === 'IMG' && lower === 'src') {
      const safeSrc = sanitizeSafeImageSrc(el.getAttribute(attrName) ?? '');
      if (safeSrc === null) {
        clone.removeAttribute(attrName);
      } else {
        clone.setAttribute('src', safeSrc);
      }
      continue;
    }

    if (SAFE_FORMATTING_ATTRS.has(lower)) {
      continue;
    }
    if (upperTag === 'IMG' && SAFE_IMG_EXTRA_ATTRS.has(lower)) {
      continue;
    }
    if (inSvg && SAFE_SVG_ATTRS.has(lower)) {
      continue;
    }
    if (inMath && SAFE_MATH_ATTRS.has(lower)) {
      continue;
    }
    if (inMath && lower === 'style') {
      const styleVal = el.getAttribute(attrName) ?? '';
      if (
        SAFE_KATEX_STYLE_RE.test(styleVal) &&
        !/url\s*\(|expression\s*\(|javascript:/i.test(styleVal)
      ) {
        continue;
      }
    }

    clone.removeAttribute(attrName);
  }

  for (let i = 0; i < el.childNodes.length; i++) {
    const childClone = cloneAtomicNodeSafely(el.childNodes[i], doc, {
      inSvg,
      inMath,
    });
    clone.appendChild(childClone);
  }

  return clone;
}

/**
 * Strips any residual or mangled `<mN>`, `</mN>`, or `<mN/>` markers from translated text.
 */
export function stripResidualMarkers(text: string): string {
  const withoutTags = text
    .replace(/<\/?m\d+(?:\s+[^>]*?)?\s*\/?>/gi, '')
    .replace(/<\/?m\d+[^\s>]*$/gi, '');
  return unescapeLiteralMarkerInRawText(withoutTags).replace(/ {2,}/g, ' ').trim();
}

function blockPreservesNewlines(blockEl: HTMLElement): boolean {
  const inlineWs = blockEl.style?.whiteSpace?.trim().toLowerCase() ?? '';
  if (inlineWs.startsWith('pre')) {
    return true;
  }
  if (blockEl.isConnected) {
    const view = blockEl.ownerDocument?.defaultView;
    if (view && typeof view.getComputedStyle === 'function') {
      try {
        const computedWs = view.getComputedStyle(blockEl).whiteSpace?.trim().toLowerCase() ?? '';
        if (computedWs.startsWith('pre')) {
          return true;
        }
      } catch {
        // Ignore computed-style errors on detached documents
      }
    }
  }
  return false;
}

/**
 * Tokenizes an HTML paragraph block into `<mN>` rich markers + plain text metadata.
 */
export function tokenizeParagraph(
  blockEl: HTMLElement,
  options: { enableRichHtml?: boolean } = {},
): TokenizedParagraph {
  const enableRichHtml = options.enableRichHtml ?? true;
  const sourceContainer = getBlockSourceContainer(blockEl);
  const preserveNewlines = blockPreservesNewlines(blockEl);
  const tokens = new Map<number, RichTokenDescriptor>();
  let plainChars = '';
  let nextId = 0;

  if (!enableRichHtml) {
    const brSentinel = '\uE000';
    const collectPlain = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        plainChars += node.nodeValue ?? '';
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      if (
        el.hasAttribute('data-margin-injected') ||
        el.hasAttribute('data-margin-host')
      ) {
        return;
      }
      if (el.getAttribute('data-margin-orig-wrap') === 'true') {
        for (let i = 0; i < el.childNodes.length; i++) {
          collectPlain(el.childNodes[i]);
        }
        return;
      }
      if (
        isBlockBoundaryElement(el) ||
        isExcludedElement(el, { insideParagraph: true })
      ) {
        return;
      }
      if (el.tagName.toUpperCase() === 'BR') {
        plainChars += brSentinel;
        return;
      }
      for (let i = 0; i < el.childNodes.length; i++) {
        collectPlain(el.childNodes[i]);
      }
    };

    for (let i = 0; i < sourceContainer.childNodes.length; i++) {
      collectPlain(sourceContainer.childNodes[i]);
    }
    const normalized = (
      preserveNewlines
        ? plainChars.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ')
        : plainChars.replace(/\s+/g, ' ')
    )
      .split(brSentinel)
      .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ''))
      .join('\n')
      .trim();
    return {
      text: normalized,
      hasRichTags: false,
      plainTextLength: normalized.length,
      tokens,
      preservesNewlines: preserveNewlines,
    };
  }

  const serializeNodes = (nodes: NodeListOf<ChildNode> | ChildNode[]): string => {
    let out = '';
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === Node.TEXT_NODE) {
        const val = node.nodeValue ?? '';
        plainChars += val;
        out += escapeLiteralMarkerInRawText(val);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      const el = node as Element;
      if (
        el.hasAttribute('data-margin-injected') ||
        el.hasAttribute('data-margin-host')
      ) {
        continue;
      }
      if (el.getAttribute('data-margin-orig-wrap') === 'true') {
        out += serializeNodes(el.childNodes);
        continue;
      }

      if (isAtomicInlineElement(el, { insideParagraph: true })) {
        const id = nextId++;
        tokens.set(id, { id, kind: 'atomic', originalElement: el });
        plainChars += el.textContent ?? '';
        out += `<m${id}/>`;
        continue;
      }

      if (isBlockBoundaryElement(el)) {
        continue;
      }

      if (isExcludedElement(el, { insideParagraph: true })) {
        continue;
      }

      const upperTag = el.tagName.toUpperCase();
      if (INLINE_FORMATTING_TAGS.has(upperTag)) {
        const reservedId = nextId++;
        const inner = serializeNodes(el.childNodes);
        if (!inner.trim()) {
          // Empty formatting wrapper: preserve whitespace if any without emitting an empty <mN></mN> tag
          out += inner;
          continue;
        }
        tokens.set(reservedId, {
          id: reservedId,
          kind: 'paired',
          originalElement: el,
        });
        out += `<m${reservedId}>${inner}</m${reservedId}>`;
        continue;
      }

      // Unknown inline wrapper: unwrap and keep inner content
      out += serializeNodes(el.childNodes);
    }
    return out;
  };

  const rawSerialized = serializeNodes(sourceContainer.childNodes);
  const serialized = preserveNewlines
    ? rawSerialized.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').trim()
    : rawSerialized.replace(/\s+/g, ' ').trim();
  const normalizedPlain = plainChars.replace(/\s+/g, ' ').trim();

  return {
    text: serialized,
    hasRichTags: tokens.size > 0,
    plainTextLength: normalizedPlain.length,
    tokens,
    preservesNewlines: preserveNewlines,
  };
}

type PairedTokenDescriptor = Extract<RichTokenDescriptor, { kind: 'paired' }>;
type AtomicTokenDescriptor = Extract<RichTokenDescriptor, { kind: 'atomic' }>;

type LexItem =
  | { kind: 'word'; value: string }
  | { kind: 'ws'; value: string }
  | { kind: 'open'; id: number; descriptor: PairedTokenDescriptor }
  | { kind: 'close'; id: number; descriptor: PairedTokenDescriptor }
  | { kind: 'atomic'; id: number; descriptor: AtomicTokenDescriptor };

interface CandidateBreak {
  start: number;
  end: number;
  sep: string;
}

interface RawSegmentChunk {
  items: LexItem[];
  sepBefore: string;
}

type SegTreeNode =
  | { kind: 'word'; value: string }
  | { kind: 'ws'; value: string }
  | { kind: 'atomic'; descriptor: AtomicTokenDescriptor }
  | { kind: 'paired'; descriptor: PairedTokenDescriptor; children: SegTreeNode[] };

const CJK_SENTENCE_END_END_RE = /[。！？]+['"”’）\]]*$/u;
const CJK_INTERNAL_SENTENCE_SPLIT_RE = /([。！？]+['"”’）\]]*)(?=.)/gu;
const LATIN_SENTENCE_END_RE = /[.!?…]+['"”’)\]]*$/u;
const COMMON_ABBREV_RE = /^(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc|fig|no|vol)\.$/i;

export function extractPlainFromTokenized(t: TokenizedParagraph): string {
  return computePlainFromTokenized(t.text, t.tokens);
}

function computePlainFromTokenized(
  text: string,
  tokens: ReadonlyMap<number, RichTokenDescriptor>,
): string {
  if (!text) return '';
  const markerRe = /<(\/?)m(\d+)(\s*\/)?>/g;
  let plain = '';
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = markerRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      plain += unescapeLiteralMarkerInRawText(text.slice(lastIdx, match.index));
    }
    const [, closingSlash, idStr, selfClose] = match;
    if (!closingSlash && selfClose) {
      const desc = tokens.get(Number(idStr));
      if (desc?.kind === 'atomic') {
        plain += desc.originalElement.textContent ?? '';
      }
    }
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    plain += unescapeLiteralMarkerInRawText(text.slice(lastIdx));
  }
  return plain.replace(/\s+/g, ' ').trim();
}

function pushRawTextIntoLexItems(raw: string, out: LexItem[]): void {
  if (!raw) return;
  const parts = raw.split(/([ \t\f\v\n]+)/g);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const isWs = /^[ \t\f\v\n]+$/.test(part);
    const prev = out[out.length - 1];
    if (isWs) {
      if (prev?.kind === 'ws') {
        prev.value += part;
      } else {
        out.push({ kind: 'ws', value: part });
      }
    } else if (prev?.kind === 'word') {
      prev.value += part;
    } else {
      out.push({ kind: 'word', value: part });
    }
  }
}

function lexTokenizedParagraph(t: TokenizedParagraph): LexItem[] {
  const out: LexItem[] = [];
  const markerRe = /<(\/?)m(\d+)(\/)?>/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = markerRe.exec(t.text)) !== null) {
    if (match.index > lastIdx) {
      pushRawTextIntoLexItems(t.text.slice(lastIdx, match.index), out);
    }
    const [fullMatch, closingSlash, idStr, selfClose] = match;
    const id = Number(idStr);
    const desc = t.tokens.get(id);

    if (!desc) {
      pushRawTextIntoLexItems(fullMatch, out);
    } else if (!closingSlash && selfClose && desc.kind === 'atomic') {
      out.push({ kind: 'atomic', id, descriptor: desc });
    } else if (!closingSlash && !selfClose && desc.kind === 'paired') {
      out.push({ kind: 'open', id, descriptor: desc });
    } else if (closingSlash && !selfClose && desc.kind === 'paired') {
      out.push({ kind: 'close', id, descriptor: desc });
    } else {
      pushRawTextIntoLexItems(fullMatch, out);
    }

    lastIdx = match.index + fullMatch.length;
  }

  if (lastIdx < t.text.length) {
    pushRawTextIntoLexItems(t.text.slice(lastIdx), out);
  }

  return out;
}

function isTransparentRunItem(item: LexItem): boolean {
  return item.kind === 'ws' || item.kind === 'open' || item.kind === 'close';
}

function countNewlinesInRange(
  items: readonly LexItem[],
  start: number,
  end: number,
): number {
  let count = 0;
  for (let i = start; i < end; i++) {
    const it = items[i];
    if (it.kind === 'ws') {
      for (let c = 0; c < it.value.length; c++) {
        if (it.value.charCodeAt(c) === 10 /* \n */) {
          count += 1;
        }
      }
    }
  }
  return count;
}

function hasWhitespaceInRange(
  items: readonly LexItem[],
  start: number,
  end: number,
): boolean {
  for (let i = start; i < end; i++) {
    const it = items[i];
    if (it.kind === 'ws' && it.value.length > 0) {
      return true;
    }
  }
  return false;
}

function hasContentItemInRange(
  items: readonly LexItem[],
  start: number,
  end: number,
): boolean {
  for (let i = start; i < end; i++) {
    if (items[i].kind === 'word' || items[i].kind === 'atomic') {
      return true;
    }
  }
  return false;
}

function findMaximalNewlineBreaks(
  items: readonly LexItem[],
  minNewlines: number,
  sep: string,
): CandidateBreak[] {
  const breaks: CandidateBreak[] = [];
  let i = 0;
  while (i < items.length) {
    if (!isTransparentRunItem(items[i])) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < items.length && isTransparentRunItem(items[i])) {
      i += 1;
    }
    const end = i;
    if (
      countNewlinesInRange(items, start, end) >= minNewlines &&
      hasContentItemInRange(items, 0, start) &&
      hasContentItemInRange(items, end, items.length)
    ) {
      breaks.push({ start, end, sep });
    }
  }
  return breaks;
}

function splitCjkWordsForSentencePass(items: readonly LexItem[]): LexItem[] {
  const expanded: LexItem[] = [];
  for (const it of items) {
    if (it.kind !== 'word') {
      expanded.push(it);
      continue;
    }
    let last = 0;
    let m: RegExpExecArray | null;
    CJK_INTERNAL_SENTENCE_SPLIT_RE.lastIndex = 0;
    while ((m = CJK_INTERNAL_SENTENCE_SPLIT_RE.exec(it.value)) !== null) {
      const cutPos = m.index + m[1].length;
      expanded.push({ kind: 'word', value: it.value.slice(last, cutPos) });
      last = cutPos;
    }
    if (last < it.value.length) {
      expanded.push({ kind: 'word', value: it.value.slice(last) });
    }
  }
  return expanded;
}

function findSentenceCandidateBreaks(items: readonly LexItem[]): CandidateBreak[] {
  const breaks: CandidateBreak[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== 'word') continue;

    const isCjkEnd = CJK_SENTENCE_END_END_RE.test(it.value);
    const isLatinEnd =
      !isCjkEnd &&
      LATIN_SENTENCE_END_RE.test(it.value) &&
      !COMMON_ABBREV_RE.test(it.value);

    if (!isCjkEnd && !isLatinEnd) continue;

    let runEnd = i + 1;
    while (runEnd < items.length && isTransparentRunItem(items[runEnd])) {
      runEnd += 1;
    }
    if (!hasContentItemInRange(items, runEnd, items.length)) {
      continue;
    }
    const hasWs = hasWhitespaceInRange(items, i + 1, runEnd);
    if (isLatinEnd && !hasWs) {
      continue;
    }
    breaks.push({
      start: i + 1,
      end: runEnd,
      sep: hasWs ? ' ' : '',
    });
    if (runEnd > i + 1) {
      i = runEnd - 1;
    }
  }
  return breaks;
}

function findWhitespaceCandidateBreaks(items: readonly LexItem[]): CandidateBreak[] {
  const breaks: CandidateBreak[] = [];
  let i = 0;
  while (i < items.length) {
    if (!isTransparentRunItem(items[i])) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < items.length && isTransparentRunItem(items[i])) {
      i += 1;
    }
    const end = i;
    if (
      hasWhitespaceInRange(items, start, end) &&
      hasContentItemInRange(items, 0, start) &&
      hasContentItemInRange(items, end, items.length)
    ) {
      breaks.push({ start, end, sep: ' ' });
    }
  }
  return breaks;
}

function estimateSliceSerializedLength(
  items: readonly LexItem[],
  start: number,
  end: number,
): number {
  let len = 0;
  for (let i = start; i < end; i++) {
    const it = items[i];
    if (it.kind === 'word' || it.kind === 'ws') {
      len += it.value.length;
    } else if (it.kind === 'atomic') {
      len += 5;
    } else if (it.kind === 'open' || it.kind === 'close') {
      len += 5;
    }
  }
  return len;
}

function selectGreedyCuts(
  items: readonly LexItem[],
  candidates: readonly CandidateBreak[],
  maxChars: number,
): CandidateBreak[] {
  if (candidates.length === 0) return [];
  const chosen: CandidateBreak[] = [];
  let sliceStart = 0;
  let accLen = 0;
  let openDepth = 0;

  const updateDepth = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (items[k].kind === 'open') openDepth += 1;
      else if (items[k].kind === 'close') openDepth = Math.max(0, openDepth - 1);
    }
  };

  for (let idx = 0; idx < candidates.length; idx++) {
    const cand = candidates[idx];
    const sliceLen = estimateSliceSerializedLength(items, sliceStart, cand.start);
    updateDepth(sliceStart, cand.start);
    const nextEnd =
      idx + 1 < candidates.length ? candidates[idx + 1].start : items.length;
    const nextSliceLen = estimateSliceSerializedLength(items, cand.end, nextEnd);
    const betweenBreakLen = estimateSliceSerializedLength(
      items,
      cand.start,
      cand.end,
    );
    const currentTotal = accLen + sliceLen;
    const tagSlack = openDepth * 10;

    if (
      currentTotal > 0 &&
      currentTotal + betweenBreakLen + nextSliceLen + tagSlack > maxChars
    ) {
      chosen.push(cand);
      accLen = 0;
    } else {
      accLen = currentTotal + betweenBreakLen;
    }

    updateDepth(cand.start, cand.end);
    sliceStart = cand.end;
  }

  return chosen;
}

function applyBreaksToChunk(
  chunk: RawSegmentChunk,
  cuts: readonly CandidateBreak[],
): RawSegmentChunk[] {
  if (cuts.length === 0) return [chunk];
  const { items } = chunk;
  const result: RawSegmentChunk[] = [];
  const openStack: PairedTokenDescriptor[] = [];
  let currentItems: LexItem[] = [];
  let currentSep = chunk.sepBefore;
  let cutIdx = 0;
  let i = 0;

  const popMatching = (id: number) => {
    for (let s = openStack.length - 1; s >= 0; s--) {
      if (openStack[s].id === id) {
        openStack.splice(s, 1);
        return;
      }
    }
  };

  while (i < items.length) {
    if (cutIdx < cuts.length && i === cuts[cutIdx].start) {
      const cut = cuts[cutIdx++];
      for (let s = openStack.length - 1; s >= 0; s--) {
        const d = openStack[s];
        currentItems.push({ kind: 'close', id: d.id, descriptor: d });
      }
      result.push({ items: currentItems, sepBefore: currentSep });

      for (let k = cut.start; k < cut.end; k++) {
        const ev = items[k];
        if (ev.kind === 'open') {
          openStack.push(ev.descriptor);
        } else if (ev.kind === 'close') {
          popMatching(ev.id);
        }
      }

      currentItems = openStack.map((d) => ({
        kind: 'open',
        id: d.id,
        descriptor: d,
      }));
      currentSep = cut.sep;
      i = cut.end;
      continue;
    }

    const ev = items[i++];
    if (ev.kind === 'open') {
      openStack.push(ev.descriptor);
    } else if (ev.kind === 'close') {
      popMatching(ev.id);
    }
    currentItems.push(ev);
  }

  result.push({ items: currentItems, sepBefore: currentSep });
  return result;
}

function treeHasContent(nodes: readonly SegTreeNode[]): boolean {
  for (const n of nodes) {
    if (n.kind === 'word' || n.kind === 'atomic') {
      return true;
    }
    if (n.kind === 'paired' && treeHasContent(n.children)) {
      return true;
    }
  }
  return false;
}

function pruneWhitespaceOnlyWrappers(nodes: SegTreeNode[]): SegTreeNode[] {
  const out: SegTreeNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'paired') {
      const cleanedChildren = pruneWhitespaceOnlyWrappers(n.children);
      if (!treeHasContent(cleanedChildren)) {
        out.push(...cleanedChildren);
      } else {
        out.push({
          kind: 'paired',
          descriptor: n.descriptor,
          children: cleanedChildren,
        });
      }
    } else {
      out.push(n);
    }
  }
  return out;
}

function trimEdgeSpineWhitespace(nodes: SegTreeNode[], trimAllWs: boolean): void {
  const trimStart = (list: SegTreeNode[]) => {
    while (list.length > 0) {
      const first = list[0];
      if (first.kind === 'ws' && (trimAllWs || first.value.includes('\n'))) {
        list.shift();
      } else {
        break;
      }
    }
    const head = list[0];
    if (head && head.kind === 'paired') {
      trimStart(head.children);
    }
  };

  const trimEnd = (list: SegTreeNode[]) => {
    while (list.length > 0) {
      const last = list[list.length - 1];
      if (last.kind === 'ws' && (trimAllWs || last.value.includes('\n'))) {
        list.pop();
      } else {
        break;
      }
    }
    const tail = list[list.length - 1];
    if (tail && tail.kind === 'paired') {
      trimEnd(tail.children);
    }
  };

  trimStart(nodes);
  trimEnd(nodes);
}

function finalizeSegmentChunk(
  chunk: RawSegmentChunk,
  preservesNewlines: boolean,
  trimInnerBoundaryWs = false,
): TokenizedSegment | null {
  const rootChildren: SegTreeNode[] = [];
  const stack: Array<{ descriptor: PairedTokenDescriptor | null; children: SegTreeNode[] }> = [
    { descriptor: null, children: rootChildren },
  ];

  for (const it of chunk.items) {
    const top = stack[stack.length - 1];
    if (it.kind === 'word') {
      top.children.push({ kind: 'word', value: it.value });
    } else if (it.kind === 'ws') {
      top.children.push({ kind: 'ws', value: it.value });
    } else if (it.kind === 'atomic') {
      top.children.push({ kind: 'atomic', descriptor: it.descriptor });
    } else if (it.kind === 'open') {
      const children: SegTreeNode[] = [];
      stack.push({ descriptor: it.descriptor, children });
    } else if (it.kind === 'close') {
      if (stack.length > 1) {
        const closed = stack.pop()!;
        if (closed.descriptor) {
          stack[stack.length - 1].children.push({
            kind: 'paired',
            descriptor: closed.descriptor,
            children: closed.children,
          });
        } else {
          stack[stack.length - 1].children.push(...closed.children);
        }
      }
    }
  }

  while (stack.length > 1) {
    const dangling = stack.pop()!;
    if (dangling.descriptor) {
      stack[stack.length - 1].children.push({
        kind: 'paired',
        descriptor: dangling.descriptor,
        children: dangling.children,
      });
    } else {
      stack[stack.length - 1].children.push(...dangling.children);
    }
  }

  let pruned = pruneWhitespaceOnlyWrappers(rootChildren);
  if (!treeHasContent(pruned)) {
    return null;
  }

  // Trim outer root-level whitespace + newline/split-exposed edge whitespace on wrapper spines
  while (pruned.length > 0 && pruned[0].kind === 'ws') {
    pruned.shift();
  }
  while (pruned.length > 0 && pruned[pruned.length - 1].kind === 'ws') {
    pruned.pop();
  }
  trimEdgeSpineWhitespace(pruned, trimInnerBoundaryWs);
  pruned = pruneWhitespaceOnlyWrappers(pruned);
  if (!treeHasContent(pruned)) {
    return null;
  }

  const localTokens = new Map<number, RichTokenDescriptor>();
  let nextLocalId = 0;
  let plainAcc = '';

  const serializeTree = (nodes: readonly SegTreeNode[]): string => {
    let acc = '';
    for (const n of nodes) {
      if (n.kind === 'word' || n.kind === 'ws') {
        acc += n.value;
        plainAcc += unescapeLiteralMarkerInRawText(n.value);
      } else if (n.kind === 'atomic') {
        const localId = nextLocalId++;
        localTokens.set(localId, {
          id: localId,
          kind: 'atomic',
          originalElement: n.descriptor.originalElement,
        });
        acc += `<m${localId}/>`;
        plainAcc += n.descriptor.originalElement.textContent ?? '';
      } else if (n.kind === 'paired') {
        const localId = nextLocalId++;
        localTokens.set(localId, {
          id: localId,
          kind: 'paired',
          originalElement: n.descriptor.originalElement,
        });
        const inner = serializeTree(n.children);
        acc += `<m${localId}>${inner}</m${localId}>`;
      }
    }
    return acc;
  };

  const text = serializeTree(pruned).trim();
  const plain = plainAcc.replace(/\s+/g, ' ').trim();
  if (!text) {
    return null;
  }

  return {
    text,
    hasRichTags: localTokens.size > 0,
    plainTextLength: plain.length,
    tokens: localTokens,
    preservesNewlines,
    sepBefore: chunk.sepBefore,
    plain,
  };
}

/**
 * Pure post-tokenization paragraph splitter for newline-preserving (`white-space: pre-*`) blocks.
 * - Non-`pre-*` blocks return a single unchanged segment so ordinary `<p>` cache keys survive.
 * - Splits on maximal runs of whitespace + paired `<mN>`/`</mN>` tags containing `>= 2` `\n`s
 *   (handling straddling `<m0>P1\n</m0><m1>\nP2</m1>`), closing and re-opening active wrappers.
 * - Drops whitespace-only paired wrappers and densely renumbers `<m0..mK>` per segment.
 * - Applies oversize guards on single `\n` (`> softMaxChars`) and sentence ends (`> hardMaxChars`).
 */
export function splitTokenizedIntoSegments(
  t: TokenizedParagraph,
  opts: { softMaxChars: number; hardMaxChars: number },
): TokenizedSegment[] {
  const fallbackPlain = computePlainFromTokenized(t.text, t.tokens);
  if (!t.preservesNewlines || !t.text) {
    return [
      {
        ...t,
        tokens: new Map(t.tokens),
        sepBefore: '',
        plain: fallbackPlain,
      },
    ];
  }

  const softMax = Math.max(64, Math.floor(opts.softMaxChars || 1200));
  const hardMax = Math.max(softMax, Math.floor(opts.hardMaxChars || 2400));

  const lexed = lexTokenizedParagraph(t);
  const paraBreaks = findMaximalNewlineBreaks(lexed, 2, '\n\n');
  let chunks: RawSegmentChunk[] = applyBreaksToChunk(
    { items: lexed, sepBefore: '' },
    paraBreaks,
  );

  // Oversize Pass 2: split chunks exceeding `softMaxChars` on single `\n`
  const splitOnSingleNewline = (chunk: RawSegmentChunk): RawSegmentChunk[] => {
    const finalized = finalizeSegmentChunk(chunk, true);
    if (!finalized || finalized.text.length <= softMax) {
      return [chunk];
    }
    const lineCands = findMaximalNewlineBreaks(chunk.items, 1, '\n');
    if (lineCands.length === 0) {
      return [chunk];
    }
    let chosen = selectGreedyCuts(chunk.items, lineCands, softMax);
    if (chosen.length === 0) {
      chosen = [lineCands[Math.floor(lineCands.length / 2)]];
    }
    const subChunks = applyBreaksToChunk(chunk, chosen);
    if (subChunks.length <= 1) {
      return [chunk];
    }
    return subChunks.flatMap((sc) => splitOnSingleNewline(sc));
  };

  chunks = chunks.flatMap((c) => splitOnSingleNewline(c));

  // Oversize Pass 3: split chunks still exceeding `hardMaxChars` on sentence ends (with whitespace fallback)
  const splitOversizeHard = (chunk: RawSegmentChunk): RawSegmentChunk[] => {
    const finalized = finalizeSegmentChunk(chunk, true);
    if (!finalized || finalized.text.length <= hardMax) {
      return [chunk];
    }
    const cjkPreparedItems = splitCjkWordsForSentencePass(chunk.items);
    const preparedChunk: RawSegmentChunk = {
      items: cjkPreparedItems,
      sepBefore: chunk.sepBefore,
    };
    let cands = findSentenceCandidateBreaks(cjkPreparedItems);
    if (cands.length === 0) {
      cands = findWhitespaceCandidateBreaks(cjkPreparedItems);
    }
    if (cands.length === 0) {
      return [chunk];
    }
    let chosen = selectGreedyCuts(cjkPreparedItems, cands, hardMax);
    if (chosen.length === 0) {
      chosen = [cands[Math.floor(cands.length / 2)]];
    }
    const subChunks = applyBreaksToChunk(preparedChunk, chosen);
    if (subChunks.length <= 1) {
      return [chunk];
    }
    return subChunks.flatMap((sc) => splitOversizeHard(sc));
  };

  chunks = chunks.flatMap((c) => splitOversizeHard(c));

  const segments: TokenizedSegment[] = [];
  const hasMultipleChunks = chunks.length > 1;
  for (const chunk of chunks) {
    const seg = finalizeSegmentChunk(chunk, true, hasMultipleChunks);
    if (seg) {
      segments.push(seg);
    }
  }

  if (segments.length === 0) {
    return [
      {
        ...t,
        tokens: new Map(t.tokens),
        sepBefore: '',
        plain: fallbackPlain,
      },
    ];
  }

  segments[0].sepBefore = '';
  return segments;
}

function createPlainFragment(doc: Document, cleanText: string): DocumentFragment {
  const frag = doc.createDocumentFragment();
  frag.appendChild(doc.createTextNode(cleanText));
  return frag;
}

function cleanFallbackTextSegment(
  rawSeg: string,
  trimStart: boolean,
  trimEnd: boolean,
): string {
  const withoutTags = rawSeg
    .replace(/<\/?m\d+(?:\s+[^>]*?)?\s*\/?>/gi, '')
    .replace(/<\/?m\d+[^\s>]*$/gi, '');
  let cleaned = unescapeLiteralMarkerInRawText(withoutTags).replace(
    / {2,}/g,
    ' ',
  );
  if (trimStart) {
    cleaned = cleaned.replace(/^\s+/, '');
  }
  if (trimEnd) {
    cleaned = cleaned.replace(/\s+$/, '');
  }
  return cleaned;
}

function createFallbackFragmentPreservingAtomics(
  doc: Document,
  translatedText: string,
  tokenized: TokenizedParagraph,
): DocumentFragment {
  let hasAtomicTokens = false;
  for (const desc of tokenized.tokens.values()) {
    if (desc.kind === 'atomic') {
      hasAtomicTokens = true;
      break;
    }
  }
  if (!hasAtomicTokens) {
    return createPlainFragment(doc, stripResidualMarkers(translatedText));
  }

  const atomicRegex = /<m(\d+)(?:\s*\/>|><\/m\1>)/g;
  const usedAtomicIds = new Set<number>();
  const matches: Array<{
    start: number;
    end: number;
    descriptor: Extract<RichTokenDescriptor, { kind: 'atomic' }>;
  }> = [];

  let m: RegExpExecArray | null;
  while ((m = atomicRegex.exec(translatedText)) !== null) {
    const id = Number(m[1]);
    const desc = tokenized.tokens.get(id);
    if (desc && desc.kind === 'atomic' && !usedAtomicIds.has(id)) {
      usedAtomicIds.add(id);
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        descriptor: desc,
      });
    }
  }

  if (matches.length === 0) {
    return createPlainFragment(doc, stripResidualMarkers(translatedText));
  }

  const frag = doc.createDocumentFragment();
  let cursor = 0;

  for (let idx = 0; idx < matches.length; idx++) {
    const hit = matches[idx];
    const seg = cleanFallbackTextSegment(
      translatedText.slice(cursor, hit.start),
      idx === 0,
      false,
    );
    if (seg.length > 0) {
      frag.appendChild(doc.createTextNode(seg));
    }
    frag.appendChild(cloneAtomicNodeSafely(hit.descriptor.originalElement, doc));
    cursor = hit.end;
  }

  const tail = cleanFallbackTextSegment(
    translatedText.slice(cursor),
    false,
    true,
  );
  if (tail.length > 0) {
    frag.appendChild(doc.createTextNode(tail));
  }

  return frag;
}

/**
 * Reconstructs translated DOM nodes strictly via `cloneNode(false)` + `document.createTextNode(...)`.
 *
 * If the model dropped, duplicated, invalidly nested, or hallucinated `<mN>` markers on this item,
 * gracefully strips residual markers on this item ONLY and returns plain text (`fallbackPlain: true`).
 */
export function reconstructRichDom(
  translatedText: string,
  tokenized: TokenizedParagraph,
  doc: Document = document,
  options?: RichDomLocaleOptions,
): ReconstructedRichDom {
  if (!tokenized.hasRichTags || tokenized.tokens.size === 0) {
    if (/<\/?m\d+/i.test(translatedText)) {
      return {
        fragment: createPlainFragment(doc, stripResidualMarkers(translatedText)),
        fallbackPlain: true,
      };
    }
    return {
      fragment: createPlainFragment(
        doc,
        unescapeLiteralMarkerInRawText(translatedText),
      ),
      fallbackPlain: false,
    };
  }

  const rootFragment = doc.createDocumentFragment();
  const stack: Array<{
    id: number | null;
    tagUpper: string | null;
    node: DocumentFragment | Element;
  }> = [{ id: null, tagUpper: null, node: rootFragment }];

  const usedIds = new Set<number>();
  const markerRegex = /<(\/?)m(\d+)(\s*\/)?>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const fallback = (): ReconstructedRichDom => ({
    fragment: createFallbackFragmentPreservingAtomics(
      doc,
      translatedText,
      tokenized,
    ),
    fallbackPlain: true,
  });

  while ((match = markerRegex.exec(translatedText)) !== null) {
    const [fullMatch, closingSlash, idStr, selfClosingPart] = match;
    const precedingText = translatedText.slice(lastIndex, match.index);

    // Detect malformed marker fragments like `<m1 attr="x">` or unclosed `<m1`
    if (/<\/?m\d+/i.test(precedingText)) {
      return fallback();
    }
    if (precedingText.length > 0) {
      stack[stack.length - 1].node.appendChild(
        doc.createTextNode(unescapeLiteralMarkerInRawText(precedingText)),
      );
    }

    lastIndex = match.index + fullMatch.length;

    const isClosing = closingSlash === '/';
    const isSelfClosing = Boolean(selfClosingPart);
    if (isClosing && isSelfClosing) {
      return fallback();
    }

    const id = Number(idStr);
    const descriptor = tokenized.tokens.get(id);
    if (!descriptor) {
      // Hallucinated <mN> marker
      return fallback();
    }

    if (isSelfClosing) {
      if (descriptor.kind !== 'atomic' || usedIds.has(id)) {
        return fallback();
      }
      usedIds.add(id);
      const clonedAtomic = cloneAtomicNodeSafely(descriptor.originalElement, doc);
      stack[stack.length - 1].node.appendChild(clonedAtomic);
      continue;
    }

    if (!isClosing) {
      if (usedIds.has(id)) {
        return fallback();
      }

      // Tolerate LLMs expanding atomic `<m0/>` to empty `<m0></m0>`
      if (descriptor.kind === 'atomic') {
        const emptyClosePrefix = `</m${id}>`;
        if (translatedText.startsWith(emptyClosePrefix, lastIndex)) {
          lastIndex += emptyClosePrefix.length;
          markerRegex.lastIndex = lastIndex;
          usedIds.add(id);
          const clonedAtomic = cloneAtomicNodeSafely(descriptor.originalElement, doc);
          stack[stack.length - 1].node.appendChild(clonedAtomic);
          continue;
        }
        return fallback();
      }

      const tagUpper = descriptor.originalElement.tagName.toUpperCase();
      // Forbid invalid nested <a> inside <a>
      if (tagUpper === 'A' && stack.some((entry) => entry.tagUpper === 'A')) {
        return fallback();
      }

      usedIds.add(id);
      const clonedFormatting = cloneFormattingElementSafely(
        descriptor.originalElement,
        options,
      );
      stack.push({ id, tagUpper, node: clonedFormatting });
      continue;
    }

    // Closing tag `</mN>`
    if (stack.length <= 1) {
      return fallback();
    }
    const top = stack[stack.length - 1];
    if (top.id !== id) {
      // Overlapping / invalid nesting
      return fallback();
    }
    stack.pop();
    if (top.node.childNodes.length === 0) {
      // Model stripped inner text of a paired tag (e.g. empty <a></a>)
      return fallback();
    }
    stack[stack.length - 1].node.appendChild(top.node);
  }

  const trailingText = translatedText.slice(lastIndex);
  if (/<\/?m\d+/i.test(trailingText)) {
    return fallback();
  }
  if (trailingText.length > 0) {
    stack[stack.length - 1].node.appendChild(
      doc.createTextNode(unescapeLiteralMarkerInRawText(trailingText)),
    );
  }

  // Unclosed tags or dropped tags -> per-paragraph fallback
  if (stack.length !== 1 || usedIds.size !== tokenized.tokens.size) {
    return fallback();
  }

  return {
    fragment: rootFragment,
    fallbackPlain: false,
  };
}
