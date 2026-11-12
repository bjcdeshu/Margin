import type { ProviderConfig } from '@shared/types';
import {
  DEFAULT_MT_REQUEST_TIMEOUT_MS,
  createLinkedTimeoutScope,
} from './timeout';
import { ProviderHttpError } from './types';

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
    const markerRe = /\[\[#(\d+)\]\]\s*([\s\S]*?)(?=\[\[#\d+\]\]|$)/g;
    let matchedCount = 0;
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(translated)) !== null) {
      const idx = Number.parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < expectedCount) {
        out[idx] = m[2].trim();
        matchedCount++;
      }
    }
    if (matchedCount > 0) {
      return out;
    }
  }

  const parts = translated.split(/\r?\n\s*\r?\n/).map((s) => s.trim());
  if (parts.length === expectedCount) {
    return parts;
  }
  if (parts.length > expectedCount) {
    return [
      ...parts.slice(0, expectedCount - 1),
      parts.slice(expectedCount - 1).join('\n\n'),
    ];
  }

  // Fallback if MT collapsed double-newlines to single newlines
  const singleLineParts = translated.split(/\r?\n/).map((s) => s.trim());
  if (singleLineParts.length === expectedCount) {
    return singleLineParts;
  }

  return parts;
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
    throw new Error(`Invalid JSON from DeepLX endpoint: ${rawBody.slice(0, 200)}`);
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
    throw new Error(
      `DeepLX response missing translated data field: ${rawBody.slice(0, 200)}`,
    );
  }

  const translations = splitMtBatchChunk(translatedText, texts.length, mode);
  return {
    translations,
    httpStatus: response.status,
  };
}
