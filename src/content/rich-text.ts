import {
  BLOCK_BOUNDARY_TAGS,
  getBlockSourceContainer,
  isAtomicInlineElement,
  isExcludedElement,
} from './dom-walker';

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
}

export interface ReconstructedRichDom {
  fragment: DocumentFragment;
  fallbackPlain: boolean;
}

export interface RichDomLocaleOptions {
  stripSourceLocaleAttrs?: boolean;
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
      const upperTag = el.tagName.toUpperCase();
      if (
        el.hasAttribute('data-margin-injected') ||
        el.hasAttribute('data-margin-host') ||
        BLOCK_BOUNDARY_TAGS.has(upperTag) ||
        isExcludedElement(el, { insideParagraph: true })
      ) {
        return;
      }
      if (upperTag === 'BR') {
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

      if (isAtomicInlineElement(el, { insideParagraph: true })) {
        const id = nextId++;
        tokens.set(id, { id, kind: 'atomic', originalElement: el });
        plainChars += el.textContent ?? '';
        out += `<m${id}/>`;
        continue;
      }

      const upperTag = el.tagName.toUpperCase();
      if (BLOCK_BOUNDARY_TAGS.has(upperTag)) {
        continue;
      }

      if (isExcludedElement(el, { insideParagraph: true })) {
        continue;
      }

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
  };
}

function createPlainFragment(doc: Document, cleanText: string): DocumentFragment {
  const frag = doc.createDocumentFragment();
  frag.appendChild(doc.createTextNode(cleanText));
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
    fragment: createPlainFragment(doc, stripResidualMarkers(translatedText)),
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
