export interface RawPdfTextItem {
  str: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

export interface ExtractedPdfPage {
  paragraphs: string[];
  totalChars: number;
  isLikelyScanned: boolean;
}

interface PositionedToken {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasEOL: boolean;
}

interface VisualLine {
  y: number;
  minX: number;
  maxX: number;
  height: number;
  text: string;
}

const MATH_OR_FORMULA_TOKEN_RE =
  /[∑∏∫∮∂∇√∞≈≠≤≥±×÷∈∉⊂⊃⊆⊇∪∩∀∃⇒⇔→←α-ωΑ-Ω]|\\[a-zA-Z]+|[_^]\{?[0-9a-zA-Z+-]+\}?/;

const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

export function looksLikeFormulaText(text: string): boolean {
  return MATH_OR_FORMULA_TOKEN_RE.test(text);
}

function joinLineTokens(tokens: PositionedToken[]): string {
  if (tokens.length === 0) return '';
  const sorted = [...tokens].sort((a, b) => a.x - b.x);
  let out = '';

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const piece = cur.str;
    if (!piece) continue;

    if (out.length === 0) {
      out = piece;
      continue;
    }

    const prev = sorted[i - 1];
    const prevEnd = prev.x + Math.max(prev.width, 0);
    const gap = cur.x - prevEnd;
    const refHeight = Math.max(cur.height, prev.height, 10);

    const prevLast = out[out.length - 1] ?? '';
    const nextFirst = piece[0] ?? '';
    const alreadySpaced = /\s/.test(prevLast) || /\s/.test(nextFirst);
    const cjkAdjacent = CJK_CHAR_RE.test(prevLast) && CJK_CHAR_RE.test(nextFirst);
    const tightPunctuation =
      /[([/{-]/.test(prevLast) || /[.,;:!?%)\]}]/.test(nextFirst);

    if (!alreadySpaced && !cjkAdjacent && !tightPunctuation && gap > refHeight * 0.18) {
      out += ' ';
    }
    out += piece;
  }

  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Joins two consecutive PDF lines inside the same paragraph:
 * - Joins soft hyphenated ASCII wraps (`"trans-" + "former"` -> `"transformer"`)
 * - Preserves compound capitalized/numeric hyphens (`"UTF-" + "8"` -> `"UTF-8"`)
 * - Preserves inline math & formula spacing cleanly.
 */
export function joinWrappedPdfLines(prevLine: string, nextLine: string): string {
  const left = prevLine.trimEnd();
  const right = nextLine.trimStart();
  if (!left) return right;
  if (!right) return left;

  // Soft ASCII word hyphenation across line break: e.g. "inter-" + "national" -> "international"
  if (/[A-Za-z]{2,}-$/.test(left) && /^[a-z]/.test(right)) {
    return `${left.slice(0, -1)}${right}`;
  }

  // Compound hyphenated token at wrap: e.g. "UTF-" + "8" or "Self-" + "Attention"
  if (/-$/.test(left) && /^[A-Z0-9]/.test(right)) {
    return `${left}${right}`;
  }

  // Adjacent CJK characters wrap without spaces
  const lastChar = left[left.length - 1] ?? '';
  const firstChar = right[0] ?? '';
  if (CJK_CHAR_RE.test(lastChar) && CJK_CHAR_RE.test(firstChar)) {
    return `${left}${right}`;
  }

  return `${left} ${right}`;
}

/**
 * Groups raw `page.getTextContent().items` into clean reading paragraphs,
 * merging soft line-wrap hyphenation, preserving inline formulas, and detecting
 * scanned/image pages (`totalChars < 15`).
 */
export function extractParagraphsFromTextItems(
  rawItems: readonly RawPdfTextItem[],
): ExtractedPdfPage {
  const tokens: PositionedToken[] = [];

  for (const item of rawItems) {
    if (typeof item.str !== 'string') continue;
    const x = Number(item.transform?.[4] ?? 0);
    const y = Number(item.transform?.[5] ?? 0);
    const scaleY = Math.abs(Number(item.transform?.[3] ?? 0));
    const height = Number(item.height) > 0 ? Number(item.height) : scaleY || 12;
    const width = Number(item.width ?? item.str.length * height * 0.5);

    if (item.str.trim().length === 0 && !item.hasEOL) {
      continue;
    }

    tokens.push({
      str: item.str,
      x,
      y,
      width,
      height,
      hasEOL: Boolean(item.hasEOL),
    });
  }

  if (tokens.length === 0) {
    return { paragraphs: [], totalChars: 0, isLikelyScanned: true };
  }

  // Group into visual lines (PDF coordinates have y increasing bottom-to-top)
  const lineBuckets: PositionedToken[][] = [];
  for (const tok of tokens) {
    const lastBucket = lineBuckets[lineBuckets.length - 1];
    if (!lastBucket) {
      lineBuckets.push([tok]);
      if (tok.hasEOL) {
        lineBuckets.push([]);
      }
      continue;
    }
    if (lastBucket.length === 0) {
      lastBucket.push(tok);
      if (tok.hasEOL) {
        lineBuckets.push([]);
      }
      continue;
    }
    const refTok = lastBucket[0];
    const tol = Math.max(refTok.height, tok.height, 10) * 0.42;
    const sameBaseline = Math.abs(tok.y - refTok.y) <= tol;

    if (sameBaseline) {
      lastBucket.push(tok);
      if (tok.hasEOL) {
        lineBuckets.push([]);
      }
    } else {
      lineBuckets.push([tok]);
      if (tok.hasEOL) {
        lineBuckets.push([]);
      }
    }
  }

  const visualLines: VisualLine[] = [];
  for (const bucket of lineBuckets) {
    if (bucket.length === 0) continue;
    const text = joinLineTokens(bucket);
    if (!text) continue;

    const ys = bucket.map((b) => b.y);
    const xs = bucket.map((b) => b.x);
    const endXs = bucket.map((b) => b.x + Math.max(b.width, 0));
    const heights = bucket.map((b) => b.height);

    visualLines.push({
      y: ys.reduce((a, b) => a + b, 0) / ys.length,
      minX: Math.min(...xs),
      maxX: Math.max(...endXs),
      height: Math.max(...heights, 10),
      text,
    });
  }

  // Sort top-to-bottom if coordinates are valid non-zero PDF coordinates
  const hasRealCoords = visualLines.some((l) => l.y !== 0);
  if (hasRealCoords) {
    visualLines.sort((a, b) => b.y - a.y);
  }

  const paragraphs: string[] = [];
  let currentPara = '';
  let prevLine: VisualLine | null = null;

  for (const line of visualLines) {
    if (!prevLine) {
      currentPara = line.text;
      prevLine = line;
      continue;
    }

    const verticalDrop = hasRealCoords ? Math.abs(prevLine.y - line.y) : line.height * 1.2;
    const refHeight = Math.max(prevLine.height, line.height, 10);
    const fontJump = Math.abs(prevLine.height - line.height) > refHeight * 0.24;
    const largeGap = verticalDrop > refHeight * 1.62;
    const standaloneEquation =
      looksLikeFormulaText(line.text) &&
      line.text.length < 90 &&
      Math.abs(line.minX - prevLine.minX) > refHeight * 1.5;

    const prevEndedSentence = /[.!?。！？:：]$/.test(prevLine.text.trim());
    const bulletStart = /^(?:[-•*▪]|\d+[.)]|\([a-z0-9]+\))\s+/i.test(line.text);

    if (largeGap || fontJump || bulletStart || standaloneEquation || (prevEndedSentence && verticalDrop > refHeight * 1.35)) {
      if (currentPara.trim()) {
        paragraphs.push(currentPara.trim());
      }
      currentPara = line.text;
    } else {
      currentPara = joinWrappedPdfLines(currentPara, line.text);
    }

    prevLine = line;
  }

  if (currentPara.trim()) {
    paragraphs.push(currentPara.trim());
  }

  const totalChars = paragraphs.reduce(
    (sum, p) => sum + p.replace(/\s+/g, '').length,
    0,
  );

  return {
    paragraphs,
    totalChars,
    isLikelyScanned: totalChars < 15,
  };
}

export function canvasToScaledWebpDataUrl(
  sourceCanvas: HTMLCanvasElement,
  maxEdge = 1536,
  quality = 0.86,
): string {
  const srcW = sourceCanvas.width || 1;
  const srcH = sourceCanvas.height || 1;
  const maxDim = Math.max(srcW, srcH);

  if (maxDim <= maxEdge) {
    const webp = sourceCanvas.toDataURL('image/webp', quality);
    return webp.startsWith('data:image/') ? webp : sourceCanvas.toDataURL('image/png');
  }

  const scale = maxEdge / maxDim;
  const targetW = Math.max(1, Math.round(srcW * scale));
  const targetH = Math.max(1, Math.round(srcH * scale));
  const offscreen = document.createElement('canvas');
  offscreen.width = targetW;
  offscreen.height = targetH;
  const ctx = offscreen.getContext('2d');
  if (ctx) {
    ctx.drawImage(sourceCanvas, 0, 0, targetW, targetH);
  }
  const webp = offscreen.toDataURL('image/webp', quality);
  return webp.startsWith('data:image/') ? webp : offscreen.toDataURL('image/png');
}
