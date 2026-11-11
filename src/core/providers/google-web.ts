import type { ProviderConfig } from '@shared/types';
import { joinMtBatchChunk, splitMtBatchChunk } from './deeplx';
import { ProviderHttpError } from './types';

export const DEFAULT_GOOGLE_WEB_MAX_CHARS = 2800;

export function chunkTextsForGoogleWeb(
  texts: readonly string[],
  maxCharsPerChunk = DEFAULT_GOOGLE_WEB_MAX_CHARS,
): string[][] {
  if (texts.length === 0) return [];
  const limit = Math.max(200, maxCharsPerChunk);
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (const text of texts) {
    const cost = text.length + 8;
    if (current.length > 0 && currentChars + cost > limit) {
      chunks.push(current);
      current = [text];
      currentChars = text.length;
    } else {
      current.push(text);
      currentChars += cost;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
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

export async function executeGoogleWebCall(params: {
  provider: ProviderConfig;
  endpoint: string;
  texts: readonly string[];
  fromLang: string;
  toLang: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
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
    maxCharsPerChunk = DEFAULT_GOOGLE_WEB_MAX_CHARS,
  } = params;

  if (texts.length === 0) {
    return { translations: [], httpStatus: 200 };
  }

  const sl = !fromLang || fromLang === 'auto' ? 'auto' : fromLang;
  const tl = !toLang || toLang === 'auto' ? 'zh-CN' : toLang;

  const chunks = chunkTextsForGoogleWeb(texts, maxCharsPerChunk);
  const allTranslations: string[] = [];
  let lastStatus = 200;

  for (const chunk of chunks) {
    const { payloadText, mode } = joinMtBatchChunk(chunk);
    const url = new URL(endpoint);
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', sl);
    url.searchParams.set('tl', tl);
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', payloadText);

    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        ...(provider.extraHeaders ?? {}),
      },
      signal,
    });

    lastStatus = response.status;
    const rawBody = new TextDecoder('utf-8').decode(await response.arrayBuffer());

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
        `Invalid JSON from Google Translate endpoint: ${rawBody.slice(0, 200)}`,
      );
    }

    const translatedChunk = parseGoogleGtxResponse(parsed);
    const splitItems = splitMtBatchChunk(translatedChunk, chunk.length, mode);
    allTranslations.push(...splitItems);
  }

  return {
    translations: allTranslations,
    httpStatus: lastStatus,
  };
}
