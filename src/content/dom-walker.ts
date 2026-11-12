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
  'SUMMARY',
  'CAPTION',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'ASIDE',
]);

export const BLOCK_BOUNDARY_TAGS: ReadonlySet<string> = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'AUDIO',
  'BLOCKQUOTE',
  'CANVAS',
  'CAPTION',
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
  'IFRAME',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TEXTAREA',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
  'VIDEO',
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
  'NAV',
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

const SCREEN_READER_ONLY_CLASSES = [
  'sr-only',
  'visually-hidden',
  'screen-reader-text',
] as const;

const EXCLUDED_DATA_TESTIDS: ReadonlySet<string> = new Set([
  'User-Name',
  'UserAvatar-Container-unknown',
  'tweet-text-show-more-link',
  'app-bar-back',
  'SideNav_AccountSwitcher_Button',
  'logged_out_read_replies_pivot',
]);

const EXCLUDED_ARIA_ROLES: ReadonlySet<string> = new Set([
  'group',
  'navigation',
  'menubar',
  'tablist',
  'toolbar',
]);

const STANDALONE_INLINE_CANDIDATE_TAGS: ReadonlySet<string> = new Set([
  'SPAN',
  'LABEL',
  'A',
]);

const CJK_OR_KANA_HANGUL_RE =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
const HAN_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const KANA_OR_HANGUL_RE = /[\u3040-\u30FF\uAC00-\uD7AF]/;
const UNICODE_LETTER_RE = /\p{L}/u;
const AT_HANDLE_RE = /^@[\w.-]+$/;
const METRIC_COUNTER_RE = /^[$€£¥₩+-]?[\d.,:\s/%]+[kmbw]?$/i;
const RELATIVE_TIMESTAMP_RE =
  /^·?\s*\d+\s*(?:s|m|h|d|w|mo|y|yr|sec|min|hr)s?(?:\s+ago)?$/i;

export interface ExtractBlocksOptions {
  targetLang?: string;
}

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
    if (
      classList?.contains('notranslate') ||
      classList?.contains('margin-notranslate')
    ) {
      return true;
    }
  }

  return false;
}

export function isContentEditableNode(el: Element): boolean {
  const attr = el.getAttribute('contenteditable');
  if (attr !== null) {
    const normalized = attr.trim().toLowerCase();
    if (
      normalized === '' ||
      normalized === 'true' ||
      normalized === 'plaintext-only'
    ) {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return el instanceof HTMLElement && el.isContentEditable === true;
}

function isCssHiddenOrScreenReaderOnly(el: Element): boolean {
  const classList = el.classList;
  if (classList) {
    for (const cls of SCREEN_READER_ONLY_CLASSES) {
      if (classList.contains(cls)) {
        return true;
      }
    }
  }

  if (el instanceof HTMLElement && el.style) {
    const display = el.style.display?.trim().toLowerCase();
    const visibility = el.style.visibility?.trim().toLowerCase();
    if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') {
      return true;
    }
  }

  if (el.isConnected) {
    const view = el.ownerDocument?.defaultView;
    if (view && typeof view.getComputedStyle === 'function') {
      try {
        const cs = view.getComputedStyle(el);
        if (
          cs.display === 'none' ||
          cs.visibility === 'hidden' ||
          cs.visibility === 'collapse'
        ) {
          return true;
        }
        // Detect standard CSS `.sr-only` / `clip: rect(0,0,0,0)` offscreen visually hidden nodes
        if (
          (cs.position === 'absolute' || cs.position === 'fixed') &&
          (cs.clip === 'rect(0px, 0px, 0px, 0px)' ||
            cs.clipPath === 'inset(50%)') &&
          (parseFloat(cs.width) <= 1 || parseFloat(cs.height) <= 1)
        ) {
          return true;
        }
      } catch {
        // Ignore computed-style errors on detached/foreign documents
      }
    }
  }

  return false;
}

/**
 * Returns true if `el` and its entire subtree should be skipped during block discovery
 * (or inline serialization when `options.insideParagraph` is true).
 */
export function isExcludedElement(
  el: Element,
  options: { insideParagraph?: boolean } = {},
): boolean {
  const tag = el.tagName.toUpperCase();
  if (EXCLUDED_SUBTREE_TAGS.has(tag)) {
    return true;
  }
  // Standalone `<time>` (e.g. X/Twitter `8h` timestamp badge) is UI metadata,
  // whereas inline `<time>` inside a prose sentence is preserved by `rich-text.ts`.
  if (!options.insideParagraph && tag === 'TIME') {
    return true;
  }

  if (
    el.hasAttribute('data-margin-injected') ||
    el.hasAttribute('data-margin-host')
  ) {
    return true;
  }

  const testId = el.getAttribute('data-testid');
  if (
    testId &&
    (EXCLUDED_DATA_TESTIDS.has(testId) ||
      testId.startsWith('UserAvatar-Container-') ||
      testId.startsWith('User-Avatar-Container-'))
  ) {
    return true;
  }

  const role = el.getAttribute('role')?.trim().toLowerCase();
  if (role && EXCLUDED_ARIA_ROLES.has(role)) {
    return true;
  }

  if (el.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true') {
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

  if (isCssHiddenOrScreenReaderOnly(el)) {
    return true;
  }

  return false;
}

/**
 * Checks whether `el` contains nested block-level boundary elements (ignoring atomic inline
 * math/code/SVG nodes, inline controls like `<button>`/`<input>`, and Margin's own injected nodes).
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
      if (BLOCK_BOUNDARY_TAGS.has(childTag)) {
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
 * Returns the first direct child of `blockEl` (or its target-only source wrapper) that is itself
 * a block boundary or contains a block boundary — used so mixed containers (`<li>Parent <ul>...</ul></li>`
 * or `<div>Intro <p>...</p></div>`) mount their translation right above the nested block child.
 */
export function findFirstDirectBlockBoundaryChild(
  blockEl: Element,
): Element | null {
  const sourceContainer = getBlockSourceContainer(blockEl);
  for (let i = 0; i < sourceContainer.children.length; i++) {
    const child = sourceContainer.children[i];
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
    if (BLOCK_BOUNDARY_TAGS.has(childTag) || hasNestedBlockChildren(child)) {
      return child;
    }
  }
  return null;
}

/**
 * Collects natural-language prose owned directly by `el` (skipping nested `BLOCK_BOUNDARY_TAGS`
 * subtrees, atomic math/code, and excluded controls/hidden nodes).
 */
export function collectTranslatableProse(el: Element): string {
  const sourceContainer = getBlockSourceContainer(el);
  const chunks: string[] = [];

  const walk = (node: Node, isRoot: boolean): void => {
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
      elem.hasAttribute('data-margin-host')
    ) {
      return;
    }
    if (!isRoot) {
      if (isAtomicInlineElement(elem, { insideParagraph: true })) {
        return;
      }
      const tag = elem.tagName.toUpperCase();
      if (BLOCK_BOUNDARY_TAGS.has(tag)) {
        return;
      }
      if (isExcludedElement(elem, { insideParagraph: false })) {
        return;
      }
    }
    for (let i = 0; i < elem.childNodes.length; i++) {
      walk(elem.childNodes[i], false);
    }
  };

  walk(sourceContainer, true);
  return chunks.join('');
}

function isPredominantlyTargetLanguage(prose: string, targetLang?: string): boolean {
  if (!targetLang) return false;
  const normalizedTarget = targetLang.trim().toLowerCase();
  if (normalizedTarget.startsWith('zh')) {
    if (KANA_OR_HANGUL_RE.test(prose)) {
      return false;
    }
    let totalLetters = 0;
    let hanCount = 0;
    for (const ch of prose) {
      if (UNICODE_LETTER_RE.test(ch)) {
        totalLetters += 1;
        if (HAN_CHAR_RE.test(ch)) {
          hanCount += 1;
        }
      }
    }
    if (totalLetters >= 2 && hanCount / totalLetters >= 0.65) {
      return true;
    }
  }
  return false;
}

export function hasTranslatableProse(el: Element, targetLang?: string): boolean {
  const prose = collectTranslatableProse(el).replace(/\s+/g, ' ').trim();
  if (!prose) return false;

  // Skip bare URLs, @handles, pure numeric/engagement counters (42K, 8.8K), and short relative timestamps (8h, 3h)
  if (/^https?:\/\/\S+$/i.test(prose)) return false;
  if (AT_HANDLE_RE.test(prose)) return false;
  if (METRIC_COUNTER_RE.test(prose)) return false;
  if (RELATIVE_TIMESTAMP_RE.test(prose)) return false;

  if (isPredominantlyTargetLanguage(prose, targetLang)) {
    return false;
  }

  if (CJK_OR_KANA_HANGUL_RE.test(prose)) return true;
  if (prose.length < 2) return false;
  return UNICODE_LETTER_RE.test(prose);
}

function isCandidateBlockTag(tag: string): boolean {
  return READABLE_LEAF_TAGS.has(tag) || tag === 'DIV';
}

function hasDirectBareNonWhitespaceText(el: Element): boolean {
  const sourceContainer = getBlockSourceContainer(el);
  for (let i = 0; i < sourceContainer.childNodes.length; i++) {
    const node = sourceContainer.childNodes[i];
    if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim()) {
      return true;
    }
  }
  return false;
}

function countDirectInlineCandidateChildren(el: Element): number {
  const sourceContainer = getBlockSourceContainer(el);
  let count = 0;
  for (let i = 0; i < sourceContainer.children.length; i++) {
    const child = sourceContainer.children[i];
    if (
      child.hasAttribute('data-margin-injected') ||
      child.hasAttribute('data-margin-host') ||
      child.getAttribute('data-margin-orig-wrap') === 'true'
    ) {
      continue;
    }
    if (isExcludedElement(child) || isAtomicInlineElement(child, { insideParagraph: false })) {
      continue;
    }
    const childTag = child.tagName.toUpperCase();
    if (!BLOCK_BOUNDARY_TAGS.has(childTag) && !hasNestedBlockChildren(child)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Returns true when `el` is a mixed inline+block container (e.g. `<li>Parent text <ul><li>Child</li></ul></li>`,
 * `<div>Intro text <p>Body</p></div>`, `<div>Run command:<pre>...</pre></div>`) whose own inline prose
 * should be translated as a block alongside its nested block children.
 */
export function isMixedInlineAndBlockContainer(
  el: Element,
  options?: ExtractBlocksOptions,
): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (isExcludedElement(el)) return false;
  if (isAtomicInlineElement(el, { insideParagraph: false })) return false;

  const tag = el.tagName.toUpperCase();
  if (!isCandidateBlockTag(tag)) return false;
  if (!hasNestedBlockChildren(el)) return false;
  if (!hasTranslatableProse(el, options?.targetLang)) return false;

  // If `el` has direct bare text nodes (e.g. `<li>Parent <ul>...</ul></li>` or `<div>First<p>Second</p></div>`),
  // `el` itself owns the inline prose run.
  if (hasDirectBareNonWhitespaceText(el)) {
    return true;
  }

  // If `el` has NO bare text nodes and exactly 1 standalone `<span>`/`<label>`/`<a>` child
  // alongside block children (e.g. `<div style="display:flex"><span>Card Title</span><div>Body</div></div>`),
  // let that standalone child element be extracted directly instead of the outer wrapper.
  const inlineChildrenCount = countDirectInlineCandidateChildren(el);
  return inlineChildrenCount > 1;
}

function isFlexOrGridContainer(el: Element): boolean {
  if (el instanceof HTMLElement && el.style) {
    const inlineDisplay = el.style.display?.trim().toLowerCase();
    if (
      inlineDisplay === 'flex' ||
      inlineDisplay === 'inline-flex' ||
      inlineDisplay === 'grid' ||
      inlineDisplay === 'inline-grid'
    ) {
      return true;
    }
  }
  if (el.isConnected) {
    const view = el.ownerDocument?.defaultView;
    if (view && typeof view.getComputedStyle === 'function') {
      try {
        const display = view.getComputedStyle(el).display?.trim().toLowerCase();
        return (
          display === 'flex' ||
          display === 'inline-flex' ||
          display === 'grid' ||
          display === 'inline-grid'
        );
      } catch {
        return false;
      }
    }
  }
  return false;
}

function isStandaloneInlineBlockChild(
  el: Element,
  options?: ExtractBlocksOptions,
): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toUpperCase();
  if (!STANDALONE_INLINE_CANDIDATE_TAGS.has(tag)) return false;
  const parent = el.parentElement;
  if (!parent) return false;
  if (hasDirectBareNonWhitespaceText(parent)) return false;
  const parentHasBlocks = hasNestedBlockChildren(parent);
  const parentIsFlexSingle =
    isFlexOrGridContainer(parent) &&
    countDirectInlineCandidateChildren(parent) === 1;
  if (!parentHasBlocks && !parentIsFlexSingle) return false;
  if (isExcludedElement(el) || isAtomicInlineElement(el, { insideParagraph: false })) {
    return false;
  }
  if (hasNestedBlockChildren(el)) return false;
  return hasTranslatableProse(el, options?.targetLang);
}

export function isReadableLeafBlock(
  el: Element,
  options?: ExtractBlocksOptions,
): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (isExcludedElement(el)) return false;
  if (isAtomicInlineElement(el, { insideParagraph: false })) return false;

  const tag = el.tagName.toUpperCase();
  if (!isCandidateBlockTag(tag)) {
    return isStandaloneInlineBlockChild(el, options);
  }

  if (hasNestedBlockChildren(el)) {
    return false;
  }

  // Flex/grid card row with no bare text and a single `<span>`/`<a>`/`<label>` child alongside
  // controls (e.g. `<div style="display:flex"><span>Card title</span><button>Open</button></div>`)
  // delegates to that child so the block translation stacks inside the text cell instead of as a flex sibling.
  if (
    (tag === 'DIV' ||
      tag === 'SECTION' ||
      tag === 'ARTICLE' ||
      tag === 'ASIDE') &&
    isFlexOrGridContainer(el) &&
    !hasDirectBareNonWhitespaceText(el) &&
    countDirectInlineCandidateChildren(el) === 1
  ) {
    return false;
  }

  return hasTranslatableProse(el, options?.targetLang);
}

/**
 * Extracts all readable leaf blocks (plus mixed inline+block containers) inside `root` in document
 * order without splitting paragraphs that contain inline math (`.katex`, `mjx-container`, `math`) or `code`.
 */
export function extractParagraphBlocks(
  root?: ParentNode | null,
  options?: ExtractBlocksOptions,
): HTMLElement[] {
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

    if (isReadableLeafBlock(el, options)) {
      results.push(el);
      return;
    }

    if (isMixedInlineAndBlockContainer(el, options)) {
      results.push(el);
      // Recurse ONLY into children that are or contain block boundaries so inline formatting
      // children already captured by `el`'s own prose run are never extracted twice.
      for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i];
        const childTag = child.tagName.toUpperCase();
        if (BLOCK_BOUNDARY_TAGS.has(childTag) || hasNestedBlockChildren(child)) {
          visit(child);
        }
      }
      return;
    }

    for (let i = 0; i < el.children.length; i++) {
      visit(el.children[i]);
    }
  };

  if (targetRoot instanceof Element) {
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
      (isReadableLeafBlock(curr) || isMixedInlineAndBlockContainer(curr))
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
  const rawUrl =
    doc.location?.href || (typeof location !== 'undefined' ? location.href : '');
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
