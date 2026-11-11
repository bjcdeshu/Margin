import type { PageContextPayload } from '@shared/types';

export const READABLE_LEAF_TAGS: ReadonlySet<string> = new Set([
  'P',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'DD',
  'DT',
  'FIGCAPTION',
  'TD',
  'TH',
]);

export const BLOCK_BOUNDARY_TAGS: ReadonlySet<string> = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DETAILS',
  'DIALOG',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

export const EXCLUDED_SUBTREE_TAGS: ReadonlySet<string> = new Set([
  'PRE',
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'BUTTON',
  'IFRAME',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'TEMPLATE',
  'HEAD',
  'META',
  'LINK',
  'OBJECT',
  'EMBED',
]);

export const ATOMIC_INLINE_TAGS: ReadonlySet<string> = new Set([
  'CODE',
  'KBD',
  'SAMP',
  'VAR',
  'MATH',
  'MJX-CONTAINER',
  'SVG',
  'IMG',
  'BR',
  'WBR',
]);

const ATOMIC_INLINE_CLASSES = [
  'katex',
  'katex-display',
  'MathJax',
  'MathJax_Display',
  'math-inline',
] as const;

const CJK_OR_KANA_HANGUL_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
const UNICODE_LETTER_RE = /\p{L}/u;

/**
 * Returns the container holding the original source DOM nodes of a block
 * (unwrapping Margin's reversible target-only source wrapper when active).
 */
export function getBlockSourceContainer(blockEl: Element): Element {
  for (let i = 0; i < blockEl.children.length; i++) {
    const child = blockEl.children[i];
    if (child.getAttribute('data-margin-orig-wrap') === 'true') {
      return child;
    }
  }
  return blockEl;
}

/**
 * Returns true if `el` is an inline math, code, SVG, image, or inline-untranslatable
 * node that must remain atomic (`<mN/>`) inside a paragraph and never split sentences.
 */
export function isAtomicInlineElement(
  el: Element,
  options: { insideParagraph?: boolean } = {},
): boolean {
  const tag = el.tagName.toUpperCase();
  if (ATOMIC_INLINE_TAGS.has(tag)) {
    return true;
  }

  const classList = el.classList;
  if (classList) {
    for (const cls of ATOMIC_INLINE_CLASSES) {
      if (classList.contains(cls)) {
        return true;
      }
    }
  }

  if (options.insideParagraph) {
    if (el.getAttribute('translate')?.toLowerCase() === 'no') {
      return true;
    }
    if (classList?.contains('notranslate') || classList?.contains('margin-notranslate')) {
      return true;
    }
  }

  return false;
}

export function isContentEditableNode(el: Element): boolean {
  const attr = el.getAttribute('contenteditable');
  if (attr !== null) {
    const normalized = attr.trim().toLowerCase();
    if (normalized === '' || normalized === 'true' || normalized === 'plaintext-only') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return el instanceof HTMLElement && el.isContentEditable === true;
}

/**
 * Returns true if `el` and its entire subtree should be skipped during block discovery.
 */
export function isExcludedElement(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (EXCLUDED_SUBTREE_TAGS.has(tag)) {
    return true;
  }

  if (
    el.hasAttribute('data-margin-injected') ||
    el.hasAttribute('data-margin-host')
  ) {
    return true;
  }

  if (el.getAttribute('translate')?.toLowerCase() === 'no') {
    return true;
  }

  if (
    el.classList?.contains('notranslate') ||
    el.classList?.contains('margin-notranslate')
  ) {
    return true;
  }

  if (isContentEditableNode(el)) {
    return true;
  }

  if (el.hasAttribute('hidden')) {
    return true;
  }

  if (el instanceof HTMLElement && el.style) {
    const display = el.style.display?.trim().toLowerCase();
    const visibility = el.style.visibility?.trim().toLowerCase();
    if (display === 'none' || visibility === 'hidden') {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether `el` contains nested block-level elements (ignoring atomic inline
 * math/code/SVG nodes and Margin's own injected nodes).
 */
export function hasNestedBlockChildren(el: Element): boolean {
  const sourceContainer = getBlockSourceContainer(el);

  const inspectChildren = (parent: Element): boolean => {
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i];
      if (
        child.hasAttribute('data-margin-injected') ||
        child.hasAttribute('data-margin-host') ||
        child.getAttribute('data-margin-orig-wrap') === 'true'
      ) {
        continue;
      }
      if (isAtomicInlineElement(child, { insideParagraph: true })) {
        continue;
      }
      const childTag = child.tagName.toUpperCase();
      if (BLOCK_BOUNDARY_TAGS.has(childTag) || EXCLUDED_SUBTREE_TAGS.has(childTag)) {
        return true;
      }
      if (inspectChildren(child)) {
        return true;
      }
    }
    return false;
  };

  return inspectChildren(sourceContainer);
}

/**
 * Collects natural-language prose inside a candidate block, skipping atomic math/code
 * and injected translation nodes so pure-code or pure-formula blocks are not sent to APIs.
 */
export function collectTranslatableProse(el: Element): string {
  const sourceContainer = getBlockSourceContainer(el);
  const chunks: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) {
        chunks.push(node.nodeValue);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const elem = node as Element;
    if (
      elem.hasAttribute('data-margin-injected') ||
      elem.hasAttribute('data-margin-host') ||
      isExcludedElement(elem) ||
      isAtomicInlineElement(elem, { insideParagraph: true })
    ) {
      return;
    }
    for (let i = 0; i < elem.childNodes.length; i++) {
      walk(elem.childNodes[i]);
    }
  };

  for (let i = 0; i < sourceContainer.childNodes.length; i++) {
    walk(sourceContainer.childNodes[i]);
  }

  return chunks.join('');
}

export function hasTranslatableProse(el: Element): boolean {
  const prose = collectTranslatableProse(el).replace(/\s+/g, ' ').trim();
  if (!prose) return false;
  if (CJK_OR_KANA_HANGUL_RE.test(prose)) return true;
  if (prose.length < 2) return false;
  // Skip standalone bare URLs
  if (/^https?:\/\/\S+$/i.test(prose)) return false;
  return UNICODE_LETTER_RE.test(prose);
}

export function isReadableLeafBlock(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (isExcludedElement(el)) return false;
  if (isAtomicInlineElement(el, { insideParagraph: false })) return false;

  const tag = el.tagName.toUpperCase();
  if (!READABLE_LEAF_TAGS.has(tag) && tag !== 'DIV') {
    return false;
  }

  if (hasNestedBlockChildren(el)) {
    return false;
  }

  return hasTranslatableProse(el);
}

/**
 * Extracts all readable leaf blocks inside `root` in document order without splitting
 * paragraphs that contain inline math (`.katex`, `mjx-container`, `math`) or `code`.
 */
export function extractParagraphBlocks(root?: ParentNode | null): HTMLElement[] {
  const targetRoot =
    root ?? (typeof document !== 'undefined' ? document.body : null);
  if (!targetRoot) return [];

  const results: HTMLElement[] = [];

  const visit = (el: Element): void => {
    if (isExcludedElement(el)) {
      return;
    }
    // Standalone atomic nodes at block level (e.g. standalone <svg> or <code>) are skipped
    if (isAtomicInlineElement(el, { insideParagraph: false })) {
      return;
    }

    if (isReadableLeafBlock(el)) {
      results.push(el);
      return;
    }

    for (let i = 0; i < el.children.length; i++) {
      visit(el.children[i]);
    }
  };

  if (targetRoot instanceof Element) {
    // Check if an ancestor of targetRoot excludes it
    if (hasExcludedAncestor(targetRoot)) {
      return [];
    }
    visit(targetRoot);
  } else {
    for (let i = 0; i < targetRoot.children.length; i++) {
      visit(targetRoot.children[i]);
    }
  }

  return results;
}

export function hasExcludedAncestor(el: Element): boolean {
  let curr: Element | null = el;
  while (curr) {
    if (isExcludedElement(curr)) return true;
    curr = curr.parentElement;
  }
  return false;
}

/**
 * Finds the nearest enclosing readable paragraph block for hover targeting.
 */
export function findClosestParagraphBlock(target: Node | null): HTMLElement | null {
  if (!target) return null;
  const startEl: Element | null =
    target.nodeType === Node.ELEMENT_NODE
      ? (target as Element)
      : target.parentElement;
  if (!startEl) return null;

  // Reject immediately if target sits anywhere inside an excluded container or Margin Shadow host
  let ancestor: Element | null = startEl;
  while (
    ancestor &&
    ancestor !== document.body &&
    ancestor !== document.documentElement
  ) {
    if (ancestor.hasAttribute('data-margin-host')) {
      return null;
    }
    if (
      !ancestor.hasAttribute('data-margin-injected') &&
      !ancestor.hasAttribute('data-margin-orig-wrap') &&
      isExcludedElement(ancestor)
    ) {
      return null;
    }
    ancestor = ancestor.parentElement;
  }

  let curr: Element | null = startEl;
  while (curr && curr !== document.body && curr !== document.documentElement) {
    if (
      !curr.hasAttribute('data-margin-injected') &&
      !curr.hasAttribute('data-margin-orig-wrap') &&
      isReadableLeafBlock(curr)
    ) {
      return curr;
    }
    curr = curr.parentElement;
  }
  return null;
}

/**
 * Extracts zero-latency local page context (`title`, `domain`, compact summary)
 * without making any blocking LLM pre-request.
 */
export function extractPageContext(doc: Document = document): PageContextPayload {
  const rawUrl = doc.location?.href || (typeof location !== 'undefined' ? location.href : '');
  let domain = '';
  try {
    domain = rawUrl ? new URL(rawUrl).hostname : '';
  } catch {
    domain = '';
  }

  const title = doc.title?.trim() || undefined;
  const summaryParts: string[] = [];

  const metaDesc =
    doc
      .querySelector('meta[name="description"]')
      ?.getAttribute('content')
      ?.trim() ||
    doc
      .querySelector('meta[property="og:description"]')
      ?.getAttribute('content')
      ?.trim();
  if (metaDesc) {
    summaryParts.push(metaDesc);
  }

  const h1Text = doc.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim();
  if (h1Text && h1Text !== title) {
    summaryParts.push(h1Text);
  }

  if (summaryParts.join(' ').length < 180 && doc.body) {
    const blocks = extractParagraphBlocks(doc.body).slice(0, 2);
    for (const blk of blocks) {
      const text = collectTranslatableProse(blk).replace(/\s+/g, ' ').trim();
      if (text && !summaryParts.includes(text)) {
        summaryParts.push(text);
      }
      if (summaryParts.join(' ').length >= 450) break;
    }
  }

  const combinedSummary = summaryParts.join(' — ').slice(0, 450).trim();

  return {
    url: rawUrl,
    domain,
    title,
    summary: combinedSummary || undefined,
  };
}
