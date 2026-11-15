import type { ProviderConfig } from '@shared/types';
import { joinMtBatchChunk, splitMtBatchChunk } from './deeplx';
import {
  DEFAULT_MT_REQUEST_TIMEOUT_MS,
  createLinkedTimeoutScope,
} from './timeout';
import { ProviderHttpError, describeBodyMetadata } from './types';

export const DEFAULT_GOOGLE_WEB_MAX_CHARS = 2800;

const CHUNK_SEPARATOR_ENCODED_OVERHEAD = 18;

export function measureGoogleWebEncodedLength(text: string): number {
  return Math.max(text.length, encodeURIComponent(text).length);
}

export function chunkTextsForGoogleWeb(
  texts: readonly string[],
  maxCharsPerChunk = DEFAULT_GOOGLE_WEB_MAX_CHARS,
): string[][] {
  if (texts.length === 0) return [];
  const limit = Math.max(200, maxCharsPerChunk);
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentEncodedLen = 0;

  for (const text of texts) {
    const encodedLen = measureGoogleWebEncodedLength(text);
    const costWithSep =
      current.length > 0
        ? encodedLen + CHUNK_SEPARATOR_ENCODED_OVERHEAD
        : encodedLen;
    if (current.length > 0 && currentEncodedLen + costWithSep > limit) {
      chunks.push(current);
      current = [text];
      currentEncodedLen = encodedLen;
    } else {
      current.push(text);
      currentEncodedLen += costWithSep;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function splitOversizedTextForGoogleWeb(
  text: string,
  maxEncodedChars = DEFAULT_GOOGLE_WEB_MAX_CHARS,
): string[] {
  const limit = Math.max(200, maxEncodedChars);
  if (!text || measureGoogleWebEncodedLength(text) <= limit) {
    return [text];
  }

  const pieces: string[] = [];
  const tokenRe = /<\/?m(?:-g\b[^>]*|\d+)\/?>|[\s\S]/gu;
  const breakCharRe = /^(?:\n|[.!?。！？；;])/;

  let current = '';
  let currentEncoded = 0;
  let lastNaturalBreakCharIdx = -1;

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const tok = m[0];
    const tokCost = measureGoogleWebEncodedLength(tok);

    if (current.length > 0 && currentEncoded + tokCost > limit) {
      if (
        lastNaturalBreakCharIdx > 0 &&
        lastNaturalBreakCharIdx >= Math.floor(current.length * 0.25)
      ) {
        const head = current.slice(0, lastNaturalBreakCharIdx);
        const tail = current.slice(lastNaturalBreakCharIdx);
        pieces.push(head);
        current = tail + tok;
        currentEncoded = measureGoogleWebEncodedLength(current);
      } else {
        pieces.push(current);
        current = tok;
        currentEncoded = tokCost;
      }
      lastNaturalBreakCharIdx = breakCharRe.test(tok) ? current.length : -1;
      continue;
    }

    current += tok;
    currentEncoded += tokCost;
    if (breakCharRe.test(tok) || (tok === ' ' && currentEncoded >= limit * 0.5)) {
      lastNaturalBreakCharIdx = current.length;
    }
  }

  if (current.length > 0) {
    pieces.push(current);
  }
  return pieces;
}

function parseGoogleGtxResponse(rawJson: unknown): string {
  if (!Array.isArray(rawJson)) {
    throw new Error('Unexpected Google Translate response root structure.');
  }
  const sentences = rawJson[0];
  if (!Array.isArray(sentences)) {
    // Alternative `{ sentences: [{ trans }] }` structure
    throw new Error('Unexpected Google Translate sentences structure.');
  }
  return sentences
    .map((tuple) => {
      if (Array.isArray(tuple) && typeof tuple[0] === 'string') {
        return tuple[0];
      }
      return '';
    })
    .join('');
}

async function fetchGoogleWebPayload(params: {
  provider: ProviderConfig;
  endpoint: string;
  sl: string;
  tl: string;
  payloadText: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs: number;
}): Promise<{ translatedText: string; httpStatus: number }> {
  const {
    provider,
    endpoint,
    sl,
    tl,
    payloadText,
    fetchImpl,
    signal,
    requestTimeoutMs,
  } = params;

  const url = new URL(endpoint);
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', sl);
  url.searchParams.set('tl', tl);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', payloadText);

  const scope = createLinkedTimeoutScope(requestTimeoutMs, signal, 'connect');
  let response: Response;
  let rawBody: string;
  try {
    response = await scope.race(
      fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          ...(provider.extraHeaders ?? {}),
        },
        signal: scope.signal,
      }),
    );
    rawBody = new TextDecoder('utf-8').decode(
      await scope.race(response.arrayBuffer()),
    );
  } finally {
    scope.cleanup();
  }

  if (!response.ok) {
    throw new ProviderHttpError({
      status: response.status,
      bodyText: rawBody,
      endpoint: url.toString(),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error(
      `Invalid JSON from Google Translate endpoint (${describeBodyMetadata(rawBody, response)})`,
    );
  }

  return {
    translatedText: parseGoogleGtxResponse(parsed),
    httpStatus: response.status,
  };
}

export async function executeGoogleWebCall(params: {
  provider: ProviderConfig;
  endpoint: string;
  texts: readonly string[];
  fromLang: string;
  toLang: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  maxCharsPerChunk?: number;
}): Promise<{ translations: string[]; httpStatus: number }> {
  const {
    provider,
    endpoint,
    texts,
    fromLang,
    toLang,
    fetchImpl,
    signal,
    requestTimeoutMs = DEFAULT_MT_REQUEST_TIMEOUT_MS,
    maxCharsPerChunk = DEFAULT_GOOGLE_WEB_MAX_CHARS,
  } = params;

  if (texts.length === 0) {
    return { translations: [], httpStatus: 200 };
  }

  const sl = !fromLang || fromLang === 'auto' ? 'auto' : fromLang;
  const tl = !toLang || toLang === 'auto' ? 'zh-CN' : toLang;
  const limit = Math.max(200, maxCharsPerChunk);

  const chunks = chunkTextsForGoogleWeb(texts, limit);
  const allTranslations: string[] = [];
  let lastStatus = 200;

  const translateSingleItem = async (singleText: string): Promise<string> => {
    if (singleText.trim() === '') {
      return '';
    }
    const pieces = splitOversizedTextForGoogleWeb(singleText, limit);
    if (pieces.length === 1) {
      const res = await fetchGoogleWebPayload({
        provider,
        endpoint,
        sl,
        tl,
        payloadText: pieces[0],
        fetchImpl,
        signal,
        requestTimeoutMs,
      });
      lastStatus = res.httpStatus;
      return res.translatedText.trim();
    }

    const CJK_SEAM_CHAR_RE =
      /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
    const translatedPieces: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece.trim() === '') {
        translatedPieces.push(piece);
        continue;
      }
      const leadingBreak = /^\r?\n/.exec(piece)?.[0] ?? '';
      const trailingBreak = /\r?\n$/.exec(piece)?.[0] ?? '';
      const res = await fetchGoogleWebPayload({
        provider,
        endpoint,
        sl,
        tl,
        payloadText: piece,
        fetchImpl,
        signal,
        requestTimeoutMs,
      });
      lastStatus = res.httpStatus;
      let pieceTrans = res.translatedText.trim();
      if (leadingBreak && !pieceTrans.startsWith('\n')) {
        pieceTrans = leadingBreak + pieceTrans;
      }
      if (trailingBreak && !pieceTrans.endsWith('\n')) {
        pieceTrans = pieceTrans + trailingBreak;
      }

      if (translatedPieces.length > 0 && pieceTrans.length > 0) {
        const prevTrans = translatedPieces[translatedPieces.length - 1];
        const prevSrc = pieces[i - 1] ?? '';
        const hadHorizontalSpaceAtSeam =
          /[ \t]$/.test(prevSrc) || /^[ \t]/.test(piece);
        const alreadyHasWhitespaceSeam =
          /\s$/.test(prevTrans) || /^\s/.test(pieceTrans);
        const lastPrevChar = prevTrans.slice(-1);
        const firstCurrChar = pieceTrans.slice(0, 1);
        const isCjkSeam =
          CJK_SEAM_CHAR_RE.test(lastPrevChar) ||
          CJK_SEAM_CHAR_RE.test(firstCurrChar);
        if (
          !alreadyHasWhitespaceSeam &&
          !isCjkSeam &&
          (hadHorizontalSpaceAtSeam || /[.!?;:,]$/.test(prevTrans))
        ) {
          pieceTrans = ` ${pieceTrans}`;
        }
      }
      translatedPieces.push(pieceTrans);
    }
    return translatedPieces.join('').trim();
  };

  for (const chunk of chunks) {
    if (chunk.length === 1) {
      allTranslations.push(await translateSingleItem(chunk[0]));
      continue;
    }

    const { payloadText, mode } = joinMtBatchChunk(chunk);
    const res = await fetchGoogleWebPayload({
      provider,
      endpoint,
      sl,
      tl,
      payloadText,
      fetchImpl,
      signal,
      requestTimeoutMs,
    });
    lastStatus = res.httpStatus;

    const splitItems = splitMtBatchChunk(
      res.translatedText,
      chunk.length,
      mode,
    );
    if (splitItems.length === chunk.length) {
      allTranslations.push(...splitItems);
    } else {
      // Fallback to 1-to-1 per-item translation when Google collapses or injects extra paragraph breaks
      for (const itemText of chunk) {
        allTranslations.push(await translateSingleItem(itemText));
      }
    }
  }

  return {
    translations: allTranslations,
    httpStatus: lastStatus,
  };
}
