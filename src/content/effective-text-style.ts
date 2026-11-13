export interface EffectiveHostTextStyle {
  color: string | null;
  fontSize: string | null;
  lineHeight: string | null;
  fontWeight: string | null;
  letterSpacing: string | null;
}

export interface OriginalLinkAppearance {
  color: string | null;
  noUnderline: boolean;
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const FUNC_COLOR_RE =
  /^(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(\s*[a-zA-Z0-9.+%\s,/-]+\s*\)$/i;

const FORBIDDEN_CSS_CHARS_RE = /[;{}\\"'<>`]/;
const FORBIDDEN_CSS_TOKENS_RE = /url\s*\(|expression\s*\(|javascript:/i;

const SAFE_TYPOGRAPHY_VALUE_RE = /^[-+a-zA-Z0-9.%\s]+$/;

const IGNORED_STYLE_WALK_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'SVG',
  'IMG',
  'MATH',
  'CODE',
  'KBD',
  'SAMP',
  'VAR',
  'SUP',
  'SUB',
  'MJX-CONTAINER',
  'BR',
  'WBR',
  'TEMPLATE',
]);

const DOMINANT_CHILD_TEXT_SHARE = 0.6;
const MAX_CARRIER_DESCENT_DEPTH = 12;

const EFFECTIVE_STYLE_VAR_ENTRIES = [
  ['color', '--margin-effective-color'],
  ['fontSize', '--margin-effective-font-size'],
  ['lineHeight', '--margin-effective-line-height'],
  ['fontWeight', '--margin-effective-font-weight'],
  ['letterSpacing', '--margin-effective-letter-spacing'],
] as const;

/**
 * Validates computed CSS color strings before setting custom properties.
 * Accepts `rgb(...)`, `rgba(...)`, `hsl(...)`, `hsla(...)`, `oklch(...)`, `oklab(...)`,
 * `lab(...)`, `lch(...)`, `color(...)`, and `#hex`, while strictly rejecting `;`, `{`, `}`, `url(`, `\`.
 */
export function isSafeCssColorValue(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (FORBIDDEN_CSS_CHARS_RE.test(trimmed) || FORBIDDEN_CSS_TOKENS_RE.test(trimmed)) {
    return false;
  }
  if (HEX_COLOR_RE.test(trimmed)) {
    return true;
  }
  if (!FUNC_COLOR_RE.test(trimmed)) {
    return false;
  }
  // Ensure no inner parentheses exist beyond the outer function call
  const openIdx = trimmed.indexOf('(');
  const inner = trimmed.slice(openIdx + 1, -1);
  if (!inner.trim() || inner.includes('(') || inner.includes(')')) {
    return false;
  }
  return true;
}

function isZeroAlphaColor(trimmedColor: string): boolean {
  if (/^#(?:[0-9a-fA-F]{3}0|[0-9a-fA-F]{6}00)$/.test(trimmedColor)) {
    return true;
  }
  if (
    /^(?:rgba|hsla)\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*0(?:\.0+)?\s*\)$/i.test(
      trimmedColor,
    )
  ) {
    return true;
  }
  if (/\/\s*0(?:\.0+)?%?\s*\)$/.test(trimmedColor)) {
    return true;
  }
  return false;
}

function sanitizeUsableColor(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!isSafeCssColorValue(trimmed) || isZeroAlphaColor(trimmed)) {
    return null;
  }
  return trimmed;
}

function sanitizeTypographyToken(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (FORBIDDEN_CSS_CHARS_RE.test(trimmed) || FORBIDDEN_CSS_TOKENS_RE.test(trimmed)) {
    return null;
  }
  if (!SAFE_TYPOGRAPHY_VALUE_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function isOrigSourceWrapper(el: Element): boolean {
  return (
    el.getAttribute('data-margin-orig-wrap') === 'true' ||
    el.classList.contains('margin-orig-source')
  );
}

function isIgnoredForStyleWalk(el: Element): boolean {
  if (
    el.getAttribute('data-margin-injected') === 'true' ||
    el.hasAttribute('data-margin-injected') ||
    el.hasAttribute('data-margin-host')
  ) {
    return true;
  }
  if (isOrigSourceWrapper(el)) {
    return false;
  }
  if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) {
    return true;
  }
  const upperTag = el.tagName.toUpperCase();
  if (IGNORED_STYLE_WALK_TAGS.has(upperTag)) {
    return true;
  }
  const classList = el.classList;
  if (
    classList &&
    (classList.contains('katex') ||
      classList.contains('katex-display') ||
      classList.contains('MathJax'))
  ) {
    return true;
  }
  return false;
}

function findBlockOriginalRoot(blockEl: Element): Element {
  for (let i = 0; i < blockEl.children.length; i++) {
    const child = blockEl.children[i];
    if (isOrigSourceWrapper(child)) {
      return child;
    }
  }
  return blockEl;
}

function hasDirectNonWhitespaceTextNode(container: Element): boolean {
  for (let i = 0; i < container.childNodes.length; i++) {
    const node = container.childNodes[i];
    if (
      node.nodeType === Node.TEXT_NODE &&
      (node.nodeValue ?? '').trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

function collectEligibleRawText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue ?? '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }
  const el = node as Element;
  if (isIgnoredForStyleWalk(el)) {
    return '';
  }
  let out = '';
  for (let i = 0; i < el.childNodes.length; i++) {
    out += collectEligibleRawText(el.childNodes[i]);
  }
  return out;
}

function getEligibleTrimmedLength(el: Element): number {
  return collectEligibleRawText(el).replace(/\s+/g, ' ').trim().length;
}

function safeGetComputedStyle(
  el: Element,
  view: Window | null | undefined,
): CSSStyleDeclaration | null {
  if (!view || typeof view.getComputedStyle !== 'function') {
    return null;
  }
  try {
    return view.getComputedStyle(el);
  } catch {
    return null;
  }
}

function walkDominantCarrierChain(
  startContainer: Element,
  baseCarrier: Element,
): Element[] {
  const chain: Element[] = [baseCarrier];
  if (hasDirectNonWhitespaceTextNode(startContainer)) {
    return chain;
  }

  let currentContainer: Element = startContainer;
  let currentLen = getEligibleTrimmedLength(currentContainer);
  if (currentLen === 0) {
    return chain;
  }

  for (let depth = 0; depth < MAX_CARRIER_DESCENT_DEPTH; depth++) {
    let bestChild: Element | null = null;
    let bestLen = 0;

    for (let i = 0; i < currentContainer.children.length; i++) {
      let candidate: Element = currentContainer.children[i];
      if (isIgnoredForStyleWalk(candidate)) {
        continue;
      }
      if (isOrigSourceWrapper(candidate)) {
        const innerLen = getEligibleTrimmedLength(candidate);
        if (innerLen > bestLen) {
          bestChild = candidate;
          bestLen = innerLen;
        }
        continue;
      }
      const childLen = getEligibleTrimmedLength(candidate);
      if (childLen > bestLen) {
        bestChild = candidate;
        bestLen = childLen;
      }
    }

    if (!bestChild || bestLen === 0) {
      break;
    }
    if (bestLen < currentLen * DOMINANT_CHILD_TEXT_SHARE) {
      break;
    }

    if (!isOrigSourceWrapper(bestChild)) {
      chain.push(bestChild);
    }
    currentContainer = bestChild;
    currentLen = bestLen;

    if (
      !isOrigSourceWrapper(currentContainer) &&
      hasDirectNonWhitespaceTextNode(currentContainer)
    ) {
      break;
    }
  }

  return chain;
}

/**
 * Resolves the effective foreground color and (when carried by an inner wrapper child such as
 * YouTube's `<a class="yt-lockup-metadata-view-model__title">` or `<yt-formatted-string>`)
 * the effective typography (`fontSize`, `lineHeight`, `fontWeight`, `letterSpacing`) of `blockEl`.
 */
export function resolveEffectiveHostTextStyle(
  blockEl: HTMLElement,
): EffectiveHostTextStyle {
  const empty: EffectiveHostTextStyle = {
    color: null,
    fontSize: null,
    lineHeight: null,
    fontWeight: null,
    letterSpacing: null,
  };

  if (!blockEl || !blockEl.isConnected) {
    return empty;
  }

  const view =
    blockEl.ownerDocument?.defaultView ??
    (typeof window !== 'undefined' ? window : null);
  const blockCs = safeGetComputedStyle(blockEl, view);
  if (!blockCs) {
    return empty;
  }

  const sourceRoot = findBlockOriginalRoot(blockEl);
  if (hasDirectNonWhitespaceTextNode(sourceRoot)) {
    return {
      color: sanitizeUsableColor(blockCs.color),
      fontSize: null,
      lineHeight: null,
      fontWeight: null,
      letterSpacing: null,
    };
  }

  const chain = walkDominantCarrierChain(sourceRoot, blockEl);
  const carrierEl = chain[chain.length - 1] ?? blockEl;
  const carrierCs =
    carrierEl === blockEl ? blockCs : safeGetComputedStyle(carrierEl, view);
  if (!carrierCs) {
    return {
      color: sanitizeUsableColor(blockCs.color),
      fontSize: null,
      lineHeight: null,
      fontWeight: null,
      letterSpacing: null,
    };
  }

  let resolvedColor = sanitizeUsableColor(carrierCs.color);
  if (!resolvedColor) {
    for (let i = chain.length - 2; i >= 0; i--) {
      const ancestorCs =
        chain[i] === blockEl ? blockCs : safeGetComputedStyle(chain[i], view);
      const fallbackColor = sanitizeUsableColor(ancestorCs?.color);
      if (fallbackColor) {
        resolvedColor = fallbackColor;
        break;
      }
    }
  }

  if (carrierEl === blockEl) {
    return {
      color: resolvedColor,
      fontSize: null,
      lineHeight: null,
      fontWeight: null,
      letterSpacing: null,
    };
  }

  const pickDistinctTypography = (
    prop: 'fontSize' | 'lineHeight' | 'fontWeight' | 'letterSpacing',
  ): string | null => {
    const safeBlock = sanitizeTypographyToken(blockCs[prop]);
    const safeCarrier = sanitizeTypographyToken(carrierCs[prop]);
    if (safeCarrier !== null) {
      return safeCarrier === safeBlock ? null : safeCarrier;
    }
    for (let i = chain.length - 2; i >= 1; i--) {
      const ancestorCs = safeGetComputedStyle(chain[i], view);
      const fallbackVal = sanitizeTypographyToken(ancestorCs?.[prop]);
      if (fallbackVal !== null) {
        return fallbackVal === safeBlock ? null : fallbackVal;
      }
    }
    return null;
  };

  return {
    color: resolvedColor,
    fontSize: pickDistinctTypography('fontSize'),
    lineHeight: pickDistinctTypography('lineHeight'),
    fontWeight: pickDistinctTypography('fontWeight'),
    letterSpacing: pickDistinctTypography('letterSpacing'),
  };
}

/**
 * Sets or cleans `--margin-effective-*` custom properties on Margin's injected container.
 */
export function applyEffectiveHostTextStyle(
  targetEl: HTMLElement,
  style: EffectiveHostTextStyle,
): void {
  for (const [key, cssVar] of EFFECTIVE_STYLE_VAR_ENTRIES) {
    const raw = style[key];
    const safeVal =
      key === 'color' ? sanitizeUsableColor(raw) : sanitizeTypographyToken(raw);
    if (safeVal) {
      targetEl.style.setProperty(cssVar, safeVal);
    } else {
      targetEl.style.removeProperty(cssVar);
    }
  }
}

/**
 * Inspects an original `<a>` element's computed color and underline state so cloned rich-text
 * links preserve host appearance (e.g., YouTube `#f1f1f1` card title links without underlines,
 * stripped-ID `#video-title` links, X `rgb(29, 155, 240)` `@mention` links, and underlined prose links).
 */
export function inspectOriginalLinkAppearance(
  origAnchor: Element,
): OriginalLinkAppearance {
  if (
    !origAnchor ||
    origAnchor.tagName.toUpperCase() !== 'A' ||
    !origAnchor.isConnected
  ) {
    return { color: null, noUnderline: false };
  }

  const view =
    origAnchor.ownerDocument?.defaultView ??
    (typeof window !== 'undefined' ? window : null);
  const anchorCs = safeGetComputedStyle(origAnchor, view);
  if (!anchorCs) {
    return { color: null, noUnderline: false };
  }

  const rawDecoLine = (
    anchorCs.textDecorationLine ||
    anchorCs.getPropertyValue?.('text-decoration-line') ||
    anchorCs.textDecoration ||
    anchorCs.getPropertyValue?.('text-decoration') ||
    ''
  )
    .trim()
    .toLowerCase();

  const noUnderline =
    rawDecoLine.length > 0 && !rawDecoLine.includes('underline');

  let color = sanitizeUsableColor(anchorCs.color);
  if (!hasDirectNonWhitespaceTextNode(origAnchor)) {
    const chain = walkDominantCarrierChain(origAnchor, origAnchor);
    const innerCarrier = chain[chain.length - 1];
    if (innerCarrier && innerCarrier !== origAnchor) {
      const innerCs = safeGetComputedStyle(innerCarrier, view);
      const innerColor = sanitizeUsableColor(innerCs?.color);
      if (innerColor) {
        color = innerColor;
      }
    }
  }

  return { color, noUnderline };
}
