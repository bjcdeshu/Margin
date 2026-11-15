import type { ProviderConfig } from '@shared/types';
import {
  DEFAULT_MT_REQUEST_TIMEOUT_MS,
  createLinkedTimeoutScope,
} from './timeout';
import { ProviderHttpError, describeBodyMetadata } from './types';

const DEEPLX_LANG_MAP: Readonly<Record<string, string>> = {
  auto: 'auto',
  'zh-CN': 'ZH',
  'zh-TW': 'ZH-HANT',
  en: 'EN',
  ja: 'JA',
  ko: 'KO',
  fr: 'FR',
  de: 'DE',
  es: 'ES',
  ru: 'RU',
  pt: 'PT',
  it: 'IT',
  ar: 'AR',
  vi: 'VI',
  th: 'TH',
};

export function mapToDeepLXLang(code: string, role: 'source' | 'target'): string {
  const mapped = DEEPLX_LANG_MAP[code];
  if (mapped) {
    return role === 'target' && mapped === 'auto' ? 'ZH' : mapped;
  }
  const base = code.split('-')[0]?.toUpperCase() || 'EN';
  return base === 'AUTO' && role === 'target' ? 'ZH' : base;
}

export function joinMtBatchChunk(texts: readonly string[]): {
  payloadText: string;
  mode: 'single' | 'double-newline' | 'indexed-marker';
} {
  if (texts.length <= 1) {
    return { payloadText: texts[0] ?? '', mode: 'single' };
  }
  const hasInternalDoubleNewline = texts.some((t) => /\r?\n\s*\r?\n/.test(t));
  if (!hasInternalDoubleNewline) {
    return {
      payloadText: texts.join('\n\n'),
      mode: 'double-newline',
    };
  }
  return {
    payloadText: texts.map((t, idx) => `[[#${idx + 1}]]\n${t}`).join('\n'),
    mode: 'indexed-marker',
  };
}

export function splitMtBatchChunk(
  translated: string,
  expectedCount: number,
  mode: 'single' | 'double-newline' | 'indexed-marker',
): string[] {
  if (expectedCount <= 1 || mode === 'single') {
    return [translated.trim()];
  }

  if (mode === 'indexed-marker') {
    const out = new Array<string>(expectedCount).fill('');
    const seenIndices = new Set<number>();
    const markerRe = /\[\[#(\d+)\]\]\s*([\s\S]*?)(?=\[\[#\d+\]\]|$)/g;
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(translated)) !== null) {
      const idx = Number.parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < expectedCount && !seenIndices.has(idx)) {
        out[idx] = m[2].trim();
        seenIndices.add(idx);
      }
    }
    if (seenIndices.size === expectedCount) {
      return out;
    }
    return Array.from(seenIndices).map((idx) => out[idx]);
  }

  const parts = translated.split(/\r?\n\s*\r?\n/).map((s) => s.trim());
  if (parts.length === expectedCount) {
    return parts;
  }

  return parts;
}

async function fetchSingleDeepLXPayload(params: {
  provider: ProviderConfig;
  endpoint: string;
  apiKey?: string;
  payloadText: string;
  fromLang: string;
  toLang: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs: number;
}): Promise<{ translatedText: string; httpStatus: number }> {
  const {
    provider,
    endpoint,
    apiKey,
    payloadText,
    fromLang,
    toLang,
    fetchImpl,
    signal,
    requestTimeoutMs,
  } = params;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(provider.extraHeaders ?? {}),
  };

  const payload = {
    text: payloadText,
    source_lang: mapToDeepLXLang(fromLang, 'source'),
    target_lang: mapToDeepLXLang(toLang, 'target'),
  };

  const scope = createLinkedTimeoutScope(requestTimeoutMs, signal, 'connect');
  let response: Response;
  let rawBody: string;
  try {
    response = await scope.race(
      fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
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
      endpoint,
      usedApiKey: apiKey,
    });
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Invalid JSON from DeepLX endpoint (${describeBodyMetadata(rawBody, response)})`,
    );
  }

  if (typeof json.code === 'number' && json.code >= 400) {
    throw new ProviderHttpError({
      status: json.code,
      bodyText: rawBody,
      endpoint,
      usedApiKey: apiKey,
    });
  }

  let translatedText = '';
  if (typeof json.data === 'string' && json.data.length > 0) {
    translatedText = json.data;
  } else if (
    Array.isArray(json.alternatives) &&
    typeof json.alternatives[0] === 'string'
  ) {
    translatedText = json.alternatives[0];
  } else if (
    Array.isArray(json.translations) &&
    json.translations[0] &&
    typeof (json.translations[0] as Record<string, unknown>).text === 'string'
  ) {
    translatedText = (json.translations[0] as Record<string, unknown>)
      .text as string;
  } else if (typeof json.text === 'string') {
    translatedText = json.text;
  } else if (payloadText.trim() === '') {
    translatedText = '';
  } else {
    const topKeys = Object.keys(json).slice(0, 8).join(',') || 'none';
    throw new Error(
      `DeepLX response missing translated data field (chars=${rawBody.length}, keys=${topKeys})`,
    );
  }

  return {
    translatedText,
    httpStatus: response.status,
  };
}

export async function executeDeepLXCall(params: {
  provider: ProviderConfig;
  endpoint: string;
  apiKey?: string;
  texts: readonly string[];
  fromLang: string;
  toLang: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}): Promise<{ translations: string[]; httpStatus: number }> {
  const {
    provider,
    endpoint,
    apiKey,
    texts,
    fromLang,
    toLang,
    fetchImpl,
    signal,
    requestTimeoutMs = DEFAULT_MT_REQUEST_TIMEOUT_MS,
  } = params;

  if (texts.length === 0) {
    return { translations: [], httpStatus: 200 };
  }

  const { payloadText, mode } = joinMtBatchChunk(texts);
  const batchRes = await fetchSingleDeepLXPayload({
    provider,
    endpoint,
    apiKey,
    payloadText,
    fromLang,
    toLang,
    fetchImpl,
    signal,
    requestTimeoutMs,
  });

  const splitItems = splitMtBatchChunk(
    batchRes.translatedText,
    texts.length,
    mode,
  );
  if (splitItems.length === texts.length) {
    return {
      translations: splitItems,
      httpStatus: batchRes.httpStatus,
    };
  }

  // Fallback to exact 1-to-1 per-item calls when MT under/over-splits batch delimiters
  const fallbackTranslations: string[] = [];
  let lastStatus = batchRes.httpStatus;
  for (const singleText of texts) {
    if (singleText.trim() === '') {
      fallbackTranslations.push('');
      continue;
    }
    const singleRes = await fetchSingleDeepLXPayload({
      provider,
      endpoint,
      apiKey,
      payloadText: singleText,
      fromLang,
      toLang,
      fetchImpl,
      signal,
      requestTimeoutMs,
    });
    lastStatus = singleRes.httpStatus;
    fallbackTranslations.push(singleRes.translatedText.trim());
  }

  return {
    translations: fallbackTranslations,
    httpStatus: lastStatus,
  };
}
