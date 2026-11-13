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
  // YouTube & social channel/owner/button/metadata custom elements
  'YTD-CHANNEL-NAME',
  'YTD-VIDEO-OWNER-RENDERER',
  'YTD-VIDEO-META-BLOCK',
  'YTD-BADGE-SUPPORTED-RENDERER',
  'YTD-BUTTON-RENDERER',
  'YTD-SUBSCRIBE-BUTTON-RENDERER',
  'YTD-TOGGLE-BUTTON-RENDERER',
  'YTD-MENU-RENDERER',
  'YTD-AUTHOR-COMMENT-BADGE-RENDERER',
  'YTD-LIVE-CHAT-FRAME',
  'YT-BUTTON-SHAPE',
  'YT-BUTTON-VIEW-MODEL',
  'YT-CONTENT-METADATA-VIEW-MODEL',
  'YT-DECORATED-AVATAR-VIEW-MODEL',
  'TP-YT-PAPER-BUTTON',
  'TP-YT-PAPER-TOOLTIP',
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
  'tweetButton',
  'tweetButtonInline',
  'toolBar',
  'socialContext',
]);

const EXCLUDED_ELEMENT_IDS: ReadonlySet<string> = new Set([
  'channel-name',
  'owner-sub-count',
  'subscriber-count',
  'metadata-line',
  'info-strings',
  'author-text',
  'country-code',
  'published-time-text',
]);

const EXCLUDED_ELEMENT_CLASSES: ReadonlySet<string> = new Set([
  'DraftEditor-root',
  'DraftEditor-editorContainer',
  'public-DraftEditorPlaceholder-root',
  'public-DraftEditorPlaceholder-inner',
  'public-DraftEditor-content',
  'ProseMirror',
  'ql-container',
  'ql-editor',
  'ql-blank',
  'cm-editor',
  'monaco-editor',
  'ace_editor',
  'x-middot-group',
  'ytp-caption-window-container',
  'ytp-chrome-controls',
  'ytp-chrome-top-buttons',
]);

const EXCLUDED_ARIA_ROLES: ReadonlySet<string> = new Set([
  'navigation',
  'menubar',
  'tablist',
  'toolbar',
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'listbox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'switch',
  'slider',
  'scrollbar',
  'tooltip',
]);

const COMPOSER_LANDMARK_TAGS: ReadonlySet<string> = new Set([
  'MAIN',
  'ARTICLE',
  'SECTION',
  'ASIDE',
  'HEADER',
  'FOOTER',
  'NAV',
  'TABLE',
  'UL',
  'OL',
  'FORM',
]);

const COMPOSER_OVERLAY_DISQUALIFYING_DESCENDANTS_SELECTOR = [
  'article',
  'section',
  'main',
  'aside',
  'nav',
  'header',
  'footer',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'input',
  'textarea',
  'button',
  'a',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
  '[role="button"]',
  '[role="link"]',
  '[data-testid="tweetText"]',
  '[data-testid="cellInnerDiv"]',
  '[data-testid="primaryColumn"]',
  '[data-testid="sidebarColumn"]',
  'ytd-watch-metadata',
  'ytd-rich-item-renderer',
  'yt-lockup-view-model',
].join(', ');

const COMPOSER_ANCESTOR_DISQUALIFYING_SELECTOR = [
  'article',
  'section',
  '[data-testid="tweetText"]',
  '[data-testid="cellInnerDiv"]',
].join(', ');

const RICH_TEXT_COMPOSER_SURFACE_SELECTOR = [
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
  'textarea',
].join(', ');

const INPUT_PLACEHOLDER_CLASS_RE =
  /(?:^|[-_])(?:editor|input|textarea|composer|draft|slate|lexical|tiptap)[-_]?placeholder(?:$|[-_])/i;

const PLACEHOLDER_CLASS_STRUCTURAL_DESCENDANTS_SELECTOR =
  'h1, h2, h3, h4, h5, h6, p, article, section, a, button, ytd-watch-metadata';

const UI_BUTTON_STRUCTURAL_DESCENDANTS_SELECTOR = [
  'article',
  'section',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  '[data-testid="tweetText"]',
  '[data-testid="trend"]',
  '[data-testid="card.wrapper"]',
  '[data-testid="news_sidebar"]',
].join(', ');

const GROUP_ROLE_CONTENT_DESCENDANTS_SELECTOR =
  'article, section, blockquote, [data-testid="tweetText"]';

const STANDALONE_INLINE_CANDIDATE_TAGS: ReadonlySet<string> = new Set([
  'SPAN',
  'LABEL',
  'A',
  'YT-FORMATTED-STRING',
  'YT-ATTRIBUTED-STRING',
]);

const HEADING_TAGS: ReadonlySet<string> = new Set([
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
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

function hasPointerEventsNone(el: Element): boolean {
  if (el instanceof HTMLElement && el.style) {
    const inlinePe = el.style.pointerEvents?.trim().toLowerCase();
    if (inlinePe === 'none') {
      return true;
    }
  }
  if (el.isConnected) {
    const view = el.ownerDocument?.defaultView;
    if (view && typeof view.getComputedStyle === 'function') {
      try {
        if (
          view.getComputedStyle(el).pointerEvents?.trim().toLowerCase() ===
          'none'
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

function countCjkOrKanaHangulChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (CJK_OR_KANA_HANGUL_RE.test(ch)) {
      count += 1;
    }
  }
  return count;
}

function hasExplicitInputPlaceholderClass(el: Element): boolean {
  const classList = el.classList;
  if (!classList || classList.length === 0) {
    return false;
  }

  let matchedToken = false;
  for (let i = 0; i < classList.length; i++) {
    const token = classList[i];
    if (!token || token.includes(':')) {
      continue;
    }
    if (token === 'is-editor-empty') {
      matchedToken = true;
      break;
    }
    if (!/placeholder/i.test(token)) {
      continue;
    }
    const kebabToken = token.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
    if (INPUT_PLACEHOLDER_CLASS_RE.test(kebabToken)) {
      matchedToken = true;
      break;
    }
  }

  if (!matchedToken) {
    return false;
  }

  if (el.children.length > 2 || hasNestedBlockChildren(el)) {
    return false;
  }

  return el.querySelector(PLACEHOLDER_CLASS_STRUCTURAL_DESCENDANTS_SELECTOR) === null;
}

/**
 * Detects rich-text composer placeholder overlays (e.g. Draft.js, Lexical, Slate,
 * or obfuscated React overlays using `pointer-events: none` next to a `[role="textbox"]`
 * or `[contenteditable="true"]` input surface).
 */
function isComposerPlaceholderOverlay(el: Element): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  if (!hasPointerEventsNone(el)) {
    return false;
  }

  const elTag = el.tagName.toUpperCase();
  if (COMPOSER_LANDMARK_TAGS.has(elTag)) {
    return false;
  }
  if (el.children.length > 2) {
    return false;
  }
  if ((el.textContent?.trim().length ?? 0) > 120) {
    return false;
  }
  if (el.querySelector(COMPOSER_OVERLAY_DISQUALIFYING_DESCENDANTS_SELECTOR) !== null) {
    return false;
  }

  const body = el.ownerDocument?.body;
  const docEl = el.ownerDocument?.documentElement;
  let anc: Element | null = parent;

  for (let depth = 0; depth <= 1 && anc; depth++) {
    if (anc === body || anc === docEl) break;
    const ancTag = anc.tagName.toUpperCase();
    if (COMPOSER_LANDMARK_TAGS.has(ancTag)) {
      break;
    }
    if (anc.children.length > 4) {
      break;
    }
    if (anc.querySelector(COMPOSER_ANCESTOR_DISQUALIFYING_SELECTOR) !== null) {
      break;
    }
    if (anc.isConnected && typeof anc.getBoundingClientRect === 'function') {
      try {
        const rect = anc.getBoundingClientRect();
        if (rect.height > 0 && rect.height > 180) {
          break;
        }
      } catch {
        // Ignore geometry errors on detached/foreign documents
      }
    }
    if (isContentEditableNode(anc) || ancTag === 'TEXTAREA') {
      return true;
    }
    const ancRole = anc.getAttribute('role')?.trim().toLowerCase();
    if (ancRole === 'textbox') {
      return true;
    }
    if (anc.querySelector(RICH_TEXT_COMPOSER_SURFACE_SELECTOR) !== null) {
      return true;
    }
    anc = anc.parentElement;
  }

  return false;
}

function isUiButtonRoleElement(
  el: Element,
  options: { insideParagraph?: boolean },
): boolean {
  const tag = el.tagName.toUpperCase();
  if (options.insideParagraph && tag !== 'BUTTON') {
    return false;
  }
  // Preserve multi-block clickable card containers (e.g. React Native Web Pressable news/quote cards)
  if (el.querySelector(UI_BUTTON_STRUCTURAL_DESCENDANTS_SELECTOR) !== null) {
    return false;
  }
  const normalizedText = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (hasNestedBlockChildren(el) && normalizedText.length > 12) {
    return false;
  }
  if (tag !== 'BUTTON') {
    const leafProse = collectTranslatableProse(el).replace(/\s+/g, ' ').trim();
    if (
      (leafProse.length > 24 && /\s/.test(leafProse)) ||
      countCjkOrKanaHangulChars(leafProse) >= 10
    ) {
      return false;
    }
  }
  return true;
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

  const elemId = el.getAttribute('id')?.trim();
  if (elemId) {
    const lowerId = elemId.toLowerCase();
    if (
      EXCLUDED_ELEMENT_IDS.has(lowerId) ||
      lowerId.startsWith('placeholder-')
    ) {
      return true;
    }
  }

  const testId = el.getAttribute('data-testid');
  if (
    testId &&
    (EXCLUDED_DATA_TESTIDS.has(testId) ||
      testId.includes('tweetTextarea') ||
      testId.startsWith('UserAvatar-Container-') ||
      testId.startsWith('User-Avatar-Container-'))
  ) {
    return true;
  }

  if (
    el.hasAttribute('data-placeholder') ||
    el.hasAttribute('data-slate-placeholder') ||
    el.hasAttribute('data-lexical-editor') ||
    el.hasAttribute('data-slate-editor')
  ) {
    return true;
  }

  const classList = el.classList;
  if (classList && classList.length > 0) {
    for (let i = 0; i < classList.length; i++) {
      if (EXCLUDED_ELEMENT_CLASSES.has(classList[i])) {
        return true;
      }
    }
  }

  if (hasExplicitInputPlaceholderClass(el)) {
    return true;
  }

  const role = el.getAttribute('role')?.trim().toLowerCase();
  if (role) {
    if (role === 'group') {
      if (el.querySelector(GROUP_ROLE_CONTENT_DESCENDANTS_SELECTOR) === null) {
        return true;
      }
    } else if (EXCLUDED_ARIA_ROLES.has(role)) {
      return true;
    }
    if (role === 'button' && isUiButtonRoleElement(el, options)) {
      return true;
    }
  }

  if (el.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true') {
    return true;
  }

  if (el.getAttribute('translate')?.toLowerCase() === 'no') {
    return true;
  }

  if (
    classList?.contains('notranslate') ||
    classList?.contains('margin-notranslate')
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

  if (isComposerPlaceholderOverlay(el)) {
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
      if (isExcludedElement(elem, { insideParagraph: true })) {
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

interface DirectInlineChildSummary {
  nonMarginElementCount: number;
  inlineProseChildren: Element[];
}

function inspectDirectInlineChildren(el: Element): DirectInlineChildSummary {
  const sourceContainer = getBlockSourceContainer(el);
  let nonMarginElementCount = 0;
  const inlineProseChildren: Element[] = [];

  for (let i = 0; i < sourceContainer.children.length; i++) {
    const child = sourceContainer.children[i];
    if (
      child.hasAttribute('data-margin-injected') ||
      child.hasAttribute('data-margin-host') ||
      child.getAttribute('data-margin-orig-wrap') === 'true'
    ) {
      continue;
    }
    nonMarginElementCount += 1;

    if (
      isExcludedElement(child) ||
      isAtomicInlineElement(child, { insideParagraph: false })
    ) {
      continue;
    }
    const childTag = child.tagName.toUpperCase();
    if (!BLOCK_BOUNDARY_TAGS.has(childTag) && !hasNestedBlockChildren(child)) {
      inlineProseChildren.push(child);
    }
  }

  return { nonMarginElementCount, inlineProseChildren };
}

function getDelegatedFlexSingleInlineChild(parentEl: Element): Element | null {
  if (!isFlexOrGridContainer(parentEl)) return null;
  if (hasDirectBareNonWhitespaceText(parentEl)) return null;

  const { nonMarginElementCount, inlineProseChildren } =
    inspectDirectInlineChildren(parentEl);
  if (inlineProseChildren.length !== 1) return null;

  const onlyChild = inlineProseChildren[0];
  const childTag = onlyChild.tagName.toUpperCase();
  if (!STANDALONE_INLINE_CANDIDATE_TAGS.has(childTag)) {
    return null;
  }

  const parentTag = parentEl.tagName.toUpperCase();
  if (HEADING_TAGS.has(parentTag)) {
    // Plain single-child headings (`<h1><yt-formatted-string>Title</yt-formatted-string></h1>`)
    // mount directly on `<h1..h6>` outside Polymer/framework inline wrappers; only delegate
    // when the heading has sibling controls (`nonMarginElementCount >= 2`) or wraps an `<a>`.
    if (nonMarginElementCount < 2 && childTag !== 'A') {
      return null;
    }
  }

  return onlyChild;
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

  // If `el` has NO bare text nodes and exactly 1 delegatable standalone inline child
  // alongside block children (e.g. `<div style="display:flex"><span>Card Title</span><div>Body</div></div>`),
  // let that standalone child element be extracted directly instead of the outer wrapper.
  const { inlineProseChildren } = inspectDirectInlineChildren(el);
  if (
    inlineProseChildren.length === 1 &&
    STANDALONE_INLINE_CANDIDATE_TAGS.has(
      inlineProseChildren[0].tagName.toUpperCase(),
    )
  ) {
    return false;
  }
  return inlineProseChildren.length >= 1;
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
  let delegatedFromParent = false;
  if (parentHasBlocks) {
    const parentTag = parent.tagName.toUpperCase();
    if (!isCandidateBlockTag(parentTag) || isExcludedElement(parent)) {
      delegatedFromParent = true;
    } else {
      const { inlineProseChildren } = inspectDirectInlineChildren(parent);
      delegatedFromParent =
        inlineProseChildren.length === 1 && inlineProseChildren[0] === el;
    }
  } else {
    delegatedFromParent = getDelegatedFlexSingleInlineChild(parent) === el;
  }

  if (!delegatedFromParent) return false;
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

  // Flex/grid card or heading row with no bare text and a single delegatable inline candidate child
  // (`<span>`, `<a>`, `<label>`, `<yt-formatted-string>`, `<yt-attributed-string>`) alongside controls
  // delegates to that child so the block translation stacks inside the text cell instead of as a flex sibling.
  if (
    (tag === 'DIV' ||
      tag === 'SECTION' ||
      tag === 'ARTICLE' ||
      tag === 'ASIDE' ||
      HEADING_TAGS.has(tag)) &&
    getDelegatedFlexSingleInlineChild(el) !== null
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
 * Finds the nearest enclosing readable paragraph block for hover or SPA upward ancestor targeting.
 */
export function findClosestParagraphBlock(
  target: Node | null,
  options?: ExtractBlocksOptions,
): HTMLElement | null {
  if (!target) return null;
  const startEl: Element | null =
    target.nodeType === Node.ELEMENT_NODE
      ? (target as Element)
      : target.parentElement;
  if (!startEl) return null;

  const ownerDoc = startEl.ownerDocument;
  const body = ownerDoc?.body ?? null;
  const docEl = ownerDoc?.documentElement ?? null;

  // Reject immediately if target sits anywhere inside an excluded container or Margin Shadow host
  let ancestor: Element | null = startEl;
  while (ancestor && ancestor !== body && ancestor !== docEl) {
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
  while (curr && curr !== body && curr !== docEl) {
    if (
      !curr.hasAttribute('data-margin-injected') &&
      !curr.hasAttribute('data-margin-orig-wrap') &&
      (isReadableLeafBlock(curr, options) ||
        isMixedInlineAndBlockContainer(curr, options))
    ) {
      return curr;
    }
    curr = curr.parentElement;
  }
  return null;
}

const SOCIAL_COMMUNITY_DOMAINS = [
  'x.com',
  'twitter.com',
  'threads.net',
  'bsky.app',
  'reddit.com',
  'news.ycombinator.com',
] as const;

const DEVELOPER_DOCS_DOMAINS = [
  'github.com',
  'gitlab.com',
  'stackoverflow.com',
  'developer.mozilla.org',
  'npmjs.com',
  'pypi.org',
  'crates.io',
  'huggingface.co',
  'cloud.google.com',
] as const;

const ACADEMIC_RESEARCH_DOMAINS = [
  'arxiv.org',
  'openreview.net',
  'nature.com',
  'science.org',
  'acm.org',
  'ieee.org',
  'scholar.google.com',
] as const;

const VIDEO_CREATOR_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'twitch.tv',
  'vimeo.com',
] as const;

const EDITORIAL_JOURNALISM_DOMAINS = [
  'nytimes.com',
  'economist.com',
  'bloomberg.com',
  'ft.com',
  'theverge.com',
  'arstechnica.com',
  'substack.com',
  'medium.com',
] as const;

const PROSE_SAMPLER_SKIP_TAGS: ReadonlySet<string> = new Set([
  ...EXCLUDED_SUBTREE_TAGS,
  ...ATOMIC_INLINE_TAGS,
  'TIME',
]);

function matchesDomainGroup(
  host: string,
  candidates: readonly string[],
): boolean {
  for (const base of candidates) {
    if (host === base || host.endsWith(`.${base}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Infers an editorial register & terminology style guide from the current domain/URL
 * so webpage, selection, input, and subtitle prompts adapt automatically across site genres.
 */
export function inferDomainStyleGuide(
  domain: string,
  url?: string,
): string | undefined {
  let host = String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '');

  if (!host && url) {
    try {
      host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
    } catch {
      host = '';
    }
  }

  if (!host) {
    return undefined;
  }

  // Note: `docs.*` subdomains (e.g. `docs.rs`, `docs.python.org`, `docs.github.com`) always use engineering register
  if (
    host.startsWith('docs.') ||
    host.includes('.docs.') ||
    matchesDomainGroup(host, DEVELOPER_DOCS_DOMAINS)
  ) {
    return 'Software engineering & developer documentation register: crisp, accurate technical prose; preserve code identifiers, CLI flags, file paths, API names, and error literals verbatim.';
  }

  if (matchesDomainGroup(host, SOCIAL_COMMUNITY_DOMAINS)) {
    return 'Social & tech community register: concise, authentic internet/conversational tone; preserve creator voice, humor/irony, @handles, #hashtags, $tickers, and slang naturally.';
  }

  if (matchesDomainGroup(host, ACADEMIC_RESEARCH_DOMAINS)) {
    return 'Academic & research register: rigorous scholarly style, precise domain terminology, and exact logical qualifiers.';
  }

  if (matchesDomainGroup(host, VIDEO_CREATOR_DOMAINS)) {
    return 'Video & creator platform register: natural spoken rhythm suitable for video titles, chapters, and creator commentary.';
  }

  if (matchesDomainGroup(host, EDITORIAL_JOURNALISM_DOMAINS)) {
    return 'Editorial & journalism register: fluent, publication-grade journalistic prose with clear narrative flow.';
  }

  return undefined;
}

function shouldSkipElementInProseSample(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (PROSE_SAMPLER_SKIP_TAGS.has(tag)) {
    return true;
  }

  if (
    el.hasAttribute('data-margin-injected') ||
    el.hasAttribute('data-margin-host') ||
    el.hasAttribute('data-margin-block') ||
    el.hasAttribute('data-margin-inline')
  ) {
    return true;
  }

  if (
    el.hasAttribute('hidden') &&
    el.getAttribute('data-margin-orig-wrap') !== 'true'
  ) {
    return true;
  }

  if (el.hasAttribute('is-empty')) {
    return true;
  }

  if (el.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true') {
    return true;
  }

  if (isContentEditableNode(el)) {
    return true;
  }

  if (
    el.hasAttribute('data-placeholder') ||
    el.hasAttribute('data-slate-placeholder') ||
    el.hasAttribute('data-lexical-editor') ||
    el.hasAttribute('data-slate-editor')
  ) {
    return true;
  }

  const elemId = el.getAttribute('id')?.trim();
  if (elemId) {
    const lowerId = elemId.toLowerCase();
    if (
      EXCLUDED_ELEMENT_IDS.has(lowerId) ||
      lowerId.startsWith('placeholder-')
    ) {
      return true;
    }
  }

  const testId = el.getAttribute('data-testid');
  if (
    testId &&
    (EXCLUDED_DATA_TESTIDS.has(testId) ||
      testId.includes('tweetTextarea') ||
      testId.startsWith('UserAvatar-Container-') ||
      testId.startsWith('User-Avatar-Container-'))
  ) {
    return true;
  }

  const classList = el.classList;
  if (classList && classList.length > 0) {
    for (let i = 0; i < classList.length; i++) {
      const cls = classList[i];
      if (EXCLUDED_ELEMENT_CLASSES.has(cls)) {
        return true;
      }
    }
    for (const cls of ATOMIC_INLINE_CLASSES) {
      if (classList.contains(cls)) {
        return true;
      }
    }
    for (const cls of SCREEN_READER_ONLY_CLASSES) {
      if (classList.contains(cls)) {
        return true;
      }
    }
  }

  if (hasExplicitInputPlaceholderClass(el)) {
    return true;
  }

  if (el instanceof HTMLElement && el.style) {
    const display = el.style.display?.trim().toLowerCase();
    const visibility = el.style.visibility?.trim().toLowerCase();
    if (
      display === 'none' ||
      visibility === 'hidden' ||
      visibility === 'collapse'
    ) {
      return true;
    }
    if (
      el.style.pointerEvents?.trim().toLowerCase() === 'none' &&
      isComposerPlaceholderOverlay(el)
    ) {
      return true;
    }
  }

  const role = el.getAttribute('role')?.trim().toLowerCase();
  if (role) {
    if (role === 'group') {
      if (el.querySelector(GROUP_ROLE_CONTENT_DESCENDANTS_SELECTOR) === null) {
        return true;
      }
    } else if (EXCLUDED_ARIA_ROLES.has(role)) {
      return true;
    } else if (role === 'button') {
      if (el.querySelector(UI_BUTTON_STRUCTURAL_DESCENDANTS_SELECTOR) === null) {
        const compact = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (
          !(compact.length > 24 && /\s/.test(compact)) &&
          countCjkOrKanaHangulChars(compact) < 10
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Fast (< 1ms) visible prose sampler for automatic page language detection.
 * Skips scripts, styles, code/pre, SVG, form inputs, UI buttons/chrome, and Margin's
 * own injected nodes, collecting up to `maxChars` of readable page text.
 */
export function samplePageProseForLanguageDetection(
  root: ParentNode | null = typeof document !== 'undefined'
    ? document.body
    : null,
  maxChars = 900,
): string {
  if (!root || maxChars <= 0) {
    return '';
  }
  if (root instanceof Element && shouldSkipElementInProseSample(root)) {
    return '';
  }

  const chunks: string[] = [];
  let totalLen = 0;

  const walk = (parent: ParentNode): void => {
    for (
      let node = parent.firstChild;
      node && totalLen < maxChars;
      node = node.nextSibling
    ) {
      if (node.nodeType === Node.TEXT_NODE) {
        const cleaned = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
        if (!cleaned) continue;
        if (
          /^https?:\/\/\S+$/i.test(cleaned) ||
          AT_HANDLE_RE.test(cleaned) ||
          METRIC_COUNTER_RE.test(cleaned) ||
          RELATIVE_TIMESTAMP_RE.test(cleaned)
        ) {
          continue;
        }
        const remaining = maxChars - totalLen;
        const slice =
          cleaned.length > remaining ? cleaned.slice(0, remaining) : cleaned;
        chunks.push(slice);
        totalLen += slice.length + 1;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (shouldSkipElementInProseSample(el)) {
          continue;
        }
        walk(el);
      }
    }
  };

  walk(root);
  return chunks.join(' ').slice(0, maxChars).trim();
}

const X_STATUS_URL_RE = /(?:^|\/\/|\.)(?:x|twitter)\.com\/[^/?#]+\/status\/\d+/i;

const THREAD_SKIP_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'SVG',
]);

/**
 * Extracts the focal tweet plain text (capped to `maxChars`, default 280) on X/Twitter
 * status threads in ~0.2ms local DOM time with zero network RTT, ignoring Margin-injected nodes.
 */
export function extractFocalThreadContext(
  doc: Document,
  rawUrl: string,
  maxChars = 280,
): string | undefined {
  if (!rawUrl || maxChars <= 0 || !X_STATUS_URL_RE.test(rawUrl)) {
    return undefined;
  }
  const focalTweet = doc.querySelector('[data-testid="tweetText"]');
  if (!focalTweet) {
    return undefined;
  }

  let rawBuffer = '';
  const collectText = (parent: ParentNode): void => {
    for (
      let node = parent.firstChild;
      node && rawBuffer.length < maxChars * 2;
      node = node.nextSibling
    ) {
      if (node.nodeType === Node.TEXT_NODE) {
        rawBuffer += node.nodeValue ?? '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (
          el.hasAttribute('data-margin-injected') ||
          el.hasAttribute('data-margin-host') ||
          THREAD_SKIP_TAGS.has(el.tagName.toUpperCase())
        ) {
          continue;
        }
        collectText(el);
      }
    }
  };

  collectText(focalTweet);
  const normalized = rawBuffer.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxChars
    ? normalized.slice(0, maxChars).trim()
    : normalized;
}

/**
 * Extracts zero-latency local page context (`title`, `domain`, compact summary, focal
 * X/Twitter `threadContext`, and automatic domain `styleGuide`) without blocking pre-requests.
 */
export function extractPageContext(
  doc: Document = document,
  urlOverride?: string,
): PageContextPayload {
  const rawUrl =
    urlOverride?.trim() ||
    doc.location?.href ||
    (typeof location !== 'undefined' ? location.href : '');
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
  const styleGuide = inferDomainStyleGuide(domain, rawUrl);
  const threadContext = extractFocalThreadContext(doc, rawUrl);

  return {
    url: rawUrl,
    domain,
    title,
    summary: combinedSummary || undefined,
    ...(styleGuide ? { styleGuide } : {}),
    ...(threadContext ? { threadContext } : {}),
  };
}
