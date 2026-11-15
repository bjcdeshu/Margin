import { sanitizeErrorText } from '@core/diagnostics';
import type {
  FetchImageDataUrlRequest,
  FetchImageDataUrlResponse,
} from '@shared/types';
import { isPrivateOrLocalUrl } from '@shared/url-match';

let nextDnrRuleOffset = 0;
export const DNR_SESSION_RULE_BASE = 910_000;
export const DNR_SESSION_RULE_SPAN = 50_000;
export const MAX_DNR_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
export const DEFAULT_DNR_IMAGE_TIMEOUT_MS = 15_000; // 15 s

const MAX_DNR_REGEX_FILTER_LENGTH = 960;
const activeDnrRuleIds = new Set<number>();

function allocateDnrSessionRuleId(): number {
  for (let i = 0; i < DNR_SESSION_RULE_SPAN; i++) {
    const id =
      DNR_SESSION_RULE_BASE + (nextDnrRuleOffset % DNR_SESSION_RULE_SPAN);
    nextDnrRuleOffset = (nextDnrRuleOffset + 1) % DNR_SESSION_RULE_SPAN;
    if (!activeDnrRuleIds.has(id)) {
      return id;
    }
  }
  const fallback =
    DNR_SESSION_RULE_BASE + (nextDnrRuleOffset % DNR_SESSION_RULE_SPAN);
  nextDnrRuleOffset = (nextDnrRuleOffset + 1) % DNR_SESSION_RULE_SPAN;
  return fallback;
}

function isPrivateOrReservedIpv4Octets(
  a: number,
  b: number,
  c: number,
  d: number,
): boolean {
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    !Number.isInteger(c) ||
    !Number.isInteger(d) ||
    a < 0 ||
    a > 255 ||
    b < 0 ||
    b > 255 ||
    c < 0 ||
    c > 255 ||
    d < 0 ||
    d > 255
  ) {
    return true;
  }
  if (a === 0) return true; // 0.0.0.0/8 ("this" network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved/broadcast
  return false;
}

function parseDottedIpv4(text: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

function isPrivateOrLocalIpv6(rawIpv6: string): boolean {
  const clean = rawIpv6.split('%')[0]?.trim().toLowerCase() ?? '';
  if (!clean) return true;

  if (
    clean === '::' ||
    clean === '::1' ||
    /^(?:0+:){7}0+$/.test(clean) ||
    /^(?:0+:){7}0*1$/.test(clean)
  ) {
    return true;
  }

  // Unique Local Addresses fc00::/7 (`fc..` / `fd..`)
  if (/^f[cd][0-9a-f]{0,2}:/i.test(clean)) {
    return true;
  }

  // Link-Local Unicast fe80::/10 (`fe80:` .. `febf:`)
  if (/^fe[89ab][0-9a-f]?:/i.test(clean)) {
    return true;
  }

  // Multicast ff00::/8
  if (/^ff[0-9a-f]{0,2}:/i.test(clean)) {
    return true;
  }

  // 6to4 `2002:xxxx:yyyy::/48` embedding private/reserved IPv4
  const sixToFourMatch = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/i.exec(
    clean,
  );
  if (sixToFourMatch) {
    const hi = Number.parseInt(sixToFourMatch[1], 16);
    const lo = Number.parseInt(sixToFourMatch[2], 16);
    if (
      isPrivateOrReservedIpv4Octets(
        (hi >>> 8) & 0xff,
        hi & 0xff,
        (lo >>> 8) & 0xff,
        lo & 0xff,
      )
    ) {
      return true;
    }
  }

  // IPv4-mapped (`::ffff:a.b.c.d` / `::ffff:xxxx:yyyy`), SIIT (`::ffff:0:...`), NAT64 (`64:ff9b::...`), and IPv4-compatible (`::...`)
  const v4DottedMatch =
    /^(?:::(?:ffff:(?:0:)?)|::|(?:0+:){5}(?:ffff:|0+:)|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(
      clean,
    );
  if (v4DottedMatch) {
    const octets = parseDottedIpv4(v4DottedMatch[1]);
    return octets ? isPrivateOrReservedIpv4Octets(...octets) : true;
  }

  const v4HexMatch =
    /^(?:::(?:ffff:(?:0:)?)|::|(?:0+:){5}(?:ffff:|0+:)|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(
      clean,
    );
  if (v4HexMatch) {
    const hi = Number.parseInt(v4HexMatch[1], 16);
    const lo = Number.parseInt(v4HexMatch[2], 16);
    return isPrivateOrReservedIpv4Octets(
      (hi >>> 8) & 0xff,
      hi & 0xff,
      (lo >>> 8) & 0xff,
      lo & 0xff,
    );
  }

  return false;
}

export function isBlockedImageTargetUrl(rawUrl: string): boolean {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return true;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return true;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return true;
  }

  if (isPrivateOrLocalUrl(trimmed)) {
    return true;
  }

  const rawHost = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!rawHost) {
    return true;
  }

  if (
    rawHost === 'localhost' ||
    rawHost.endsWith('.localhost') ||
    rawHost.endsWith('.local') ||
    rawHost.endsWith('.lan') ||
    rawHost.endsWith('.internal') ||
    rawHost.endsWith('.home.arpa')
  ) {
    return true;
  }

  const ipv4Octets = parseDottedIpv4(rawHost);
  if (ipv4Octets) {
    return isPrivateOrReservedIpv4Octets(...ipv4Octets);
  }

  if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
    return isPrivateOrLocalIpv6(rawHost.slice(1, -1));
  }
  if (rawHost.includes(':')) {
    return isPrivateOrLocalIpv6(rawHost);
  }

  return false;
}

function sniffImageMagicMimeType(bytes: Uint8Array): string | null {
  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A (or 4-byte signature in synthetic fixtures)
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  // GIF: GIF87a / GIF89a
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  // ISO BMFF (`ftyp`): AVIF / HEIC
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis') {
      return 'image/avif';
    }
    if (
      brand === 'heic' ||
      brand === 'heix' ||
      brand === 'mif1' ||
      brand === 'msf1'
    ) {
      return 'image/heic';
    }
  }
  // BMP: BM
  if (bytes.length >= 14 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  // ICO: 00 00 01 00
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  ) {
    return 'image/x-icon';
  }
  // TIFF: II*\0 or MM\0*
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
      (bytes[0] === 0x4d &&
        bytes[1] === 0x4d &&
        bytes[2] === 0x00 &&
        bytes[3] === 0x2a))
  ) {
    return 'image/tiff';
  }

  return null;
}

function looksLikeStructuredTextDocument(bytes: Uint8Array): boolean {
  const sampleLen = Math.min(bytes.length, 256);
  let text = '';
  for (let i = 0; i < sampleLen; i++) {
    text += String.fromCharCode(bytes[i]);
  }
  const trimmed = text.replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return (
    trimmed.startsWith('<!doctype html') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<head') ||
    trimmed.startsWith('<body') ||
    trimmed.startsWith('<script') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[')
  );
}

function validateAndInferImageMimeType(
  headerContentType: string | null,
  bytes: Uint8Array,
): string | null {
  if (bytes.length === 0) {
    return null;
  }

  const sniffed = sniffImageMagicMimeType(bytes);
  if (sniffed) {
    return sniffed;
  }

  const cleanHeader =
    headerContentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!cleanHeader.startsWith('image/')) {
    return null;
  }

  if (cleanHeader === 'image/svg+xml') {
    const sample = new TextDecoder('utf-8', { fatal: false })
      .decode(bytes.subarray(0, Math.min(bytes.length, 512)))
      .toLowerCase();
    return sample.includes('<svg') ? 'image/svg+xml' : null;
  }

  if (looksLikeStructuredTextDocument(bytes)) {
    return null;
  }

  return cleanHeader;
}

function escapeRe2(input: string): string {
  return input.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function toAsciiUrlString(href: string): string {
  // WHATWG `URL.href` is already ASCII, but percent-encode any stray non-printable/non-ASCII byte defensively
  return href.replace(/[^\x20-\x7e]/g, (ch) => encodeURIComponent(ch));
}

function buildDnrSessionRuleCondition(
  asciiHref: string,
): chrome.declarativeNetRequest.RuleCondition {
  const tabIdNone =
    typeof globalThis.chrome !== 'undefined' &&
    typeof globalThis.chrome?.tabs?.TAB_ID_NONE === 'number'
      ? globalThis.chrome.tabs.TAB_ID_NONE
      : -1;

  const resourceTypes = [
    'xmlhttprequest',
    'image',
    'other',
  ] as chrome.declarativeNetRequest.ResourceType[];

  const escapedRegex = `^${escapeRe2(asciiHref)}$`;
  if (escapedRegex.length <= MAX_DNR_REGEX_FILTER_LENGTH) {
    return {
      regexFilter: escapedRegex,
      isUrlFilterCaseSensitive: true,
      tabIds: [tabIdNone],
      resourceTypes,
    };
  }

  // Fallback for ultra-long (>960 chars) signed CDN URLs: replace DNR separator `^` with `*` and anchor start/end
  const safeUrlFilterBody = asciiHref.replace(/\^/g, '*');
  return {
    urlFilter: safeUrlFilterBody.endsWith('|')
      ? `|${safeUrlFilterBody.slice(0, -1)}*`
      : `|${safeUrlFilterBody}|`,
    isUrlFilterCaseSensitive: true,
    tabIds: [tabIdNone],
    resourceTypes,
  };
}

async function readResponseBytesWithCap(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<
  | { ok: true; arrayBuffer: ArrayBuffer; bytes: Uint8Array }
  | { ok: false; error: string }
> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredBytes = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      void response.body?.cancel().catch(() => {});
      return {
        ok: false,
        error: `Image size (${declaredBytes} bytes) exceeds maximum limit (${maxBytes} bytes).`,
      };
    }
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      return {
        ok: false,
        error: `Image size (${ab.byteLength} bytes) exceeds maximum limit (${maxBytes} bytes).`,
      };
    }
    return { ok: true, arrayBuffer: ab, bytes: new Uint8Array(ab) };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error('Image fetch timed out.');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          error: `Image exceeds maximum size limit (${maxBytes} bytes).`,
        };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    ok: true,
    arrayBuffer: combined.buffer,
    bytes: combined,
  };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export interface DnrFetchDependencies {
  fetchImpl?: typeof fetch;
  dnrApi?: Pick<typeof chrome.declarativeNetRequest, 'updateSessionRules'> &
    Partial<Pick<typeof chrome.declarativeNetRequest, 'getSessionRules'>>;
  timeoutMs?: number;
  maxImageBytes?: number;
}

/**
 * Sweeps any leftover owned DNR session rules in `[910000, 959999]` surviving
 * from a previously terminated MV3 Service Worker instance.
 */
export async function sweepOrphanedDnrSessionRules(
  dnrApi?: Pick<
    typeof chrome.declarativeNetRequest,
    'getSessionRules' | 'updateSessionRules'
  >,
): Promise<number> {
  const api =
    dnrApi ??
    (typeof globalThis.chrome !== 'undefined'
      ? globalThis.chrome?.declarativeNetRequest
      : undefined);
  if (
    !api ||
    typeof api.getSessionRules !== 'function' ||
    typeof api.updateSessionRules !== 'function'
  ) {
    return 0;
  }

  try {
    const existingRules = await api.getSessionRules();
    const orphanedIds = existingRules
      .map((rule) => rule.id)
      .filter(
        (id) =>
          id >= DNR_SESSION_RULE_BASE &&
          id < DNR_SESSION_RULE_BASE + DNR_SESSION_RULE_SPAN &&
          !activeDnrRuleIds.has(id),
      );
    if (orphanedIds.length > 0) {
      await api.updateSessionRules({ removeRuleIds: orphanedIds });
    }
    return orphanedIds.length;
  } catch {
    return 0;
  }
}

/**
 * Fetches an anti-hotlink (`403`) image as a `data:<mime>;base64,...` URL by installing
 * a short-lived `chrome.declarativeNetRequest.updateSessionRules` rule injecting
 * `Referer` and `Origin` headers scoped strictly to the background SW (`TAB_ID_NONE`)
 * and removing it in `finally`.
 */
export async function fetchImageDataUrlWithDnr(
  payload: FetchImageDataUrlRequest,
  deps: DnrFetchDependencies = {},
): Promise<FetchImageDataUrlResponse> {
  const imageUrl = String(payload.imageUrl ?? '').trim();
  const refererUrl = String(payload.refererUrl ?? '').trim();

  if (!/^https?:\/\//i.test(imageUrl)) {
    return {
      ok: false,
      error: 'Only http:// and https:// image URLs can be fetched.',
    };
  }

  let parsedImageUrl: URL;
  try {
    parsedImageUrl = new URL(imageUrl);
  } catch {
    return {
      ok: false,
      error: 'Invalid image URL.',
    };
  }

  const asciiTargetHref = toAsciiUrlString(parsedImageUrl.href);
  if (
    isBlockedImageTargetUrl(imageUrl) ||
    isBlockedImageTargetUrl(asciiTargetHref)
  ) {
    return {
      ok: false,
      error: 'Blocked private, loopback, or link-local image URL.',
    };
  }

  let effectiveReferer = `${parsedImageUrl.origin}/`;
  let refererOrigin = parsedImageUrl.origin;
  if (refererUrl) {
    try {
      const parsedRef = new URL(refererUrl);
      if (/^https?:$/i.test(parsedRef.protocol)) {
        effectiveReferer = toAsciiUrlString(parsedRef.href);
        refererOrigin = parsedRef.origin;
      }
    } catch {
      effectiveReferer = `${parsedImageUrl.origin}/`;
    }
  }

  const dnrApi =
    deps.dnrApi ??
    (typeof globalThis.chrome !== 'undefined'
      ? globalThis.chrome?.declarativeNetRequest
      : undefined);

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = Math.max(
    1,
    deps.timeoutMs ?? DEFAULT_DNR_IMAGE_TIMEOUT_MS,
  );
  const maxImageBytes = Math.max(
    1,
    deps.maxImageBytes ?? MAX_DNR_IMAGE_BYTES,
  );

  const ruleId = allocateDnrSessionRuleId();
  activeDnrRuleIds.add(ruleId);
  let ruleInstalled = false;

  const abortController = new AbortController();
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      abortController.abort();
      reject(new Error(`Image fetch timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  // Prevent unhandled rejection when main path finishes before timeout
  timeoutPromise.catch(() => {});

  try {
    const installDnrRuleForHref = async (href: string) => {
      if (!dnrApi?.updateSessionRules) return;
      const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [
        {
          header: 'Referer',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: effectiveReferer,
        },
        {
          header: 'Origin',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: refererOrigin,
        },
      ];

      await dnrApi.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [
          {
            id: ruleId,
            priority: 100,
            action: {
              type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
              requestHeaders,
            },
            condition: buildDnrSessionRuleCondition(href),
          },
        ],
      });
      ruleInstalled = true;
    };

    const MAX_DNR_REDIRECTS = 5;
    const initialOrigin = parsedImageUrl.origin;
    let currentHref = asciiTargetHref;
    let credentialsMode: RequestCredentials = 'include';
    let response!: Response;

    for (let hop = 0; hop <= MAX_DNR_REDIRECTS; hop++) {
      await installDnrRuleForHref(currentHref);

      response = await Promise.race([
        fetchImpl(currentHref, {
          method: 'GET',
          credentials: credentialsMode,
          redirect: 'manual',
          signal: abortController.signal,
        }),
        timeoutPromise,
      ]);

      if (response.type === 'opaqueredirect') {
        void response.body?.cancel().catch(() => {});
        return {
          ok: false,
          error: 'Blocked opaque redirect during image fetch.',
        };
      }

      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        if (hop >= MAX_DNR_REDIRECTS) {
          return {
            ok: false,
            error: 'Exceeded maximum allowed image redirects.',
          };
        }
        const locationHeader = response.headers.get('location')?.trim() ?? '';
        if (!locationHeader) {
          return {
            ok: false,
            error: `Image redirect HTTP ${response.status} missing Location header.`,
          };
        }
        let nextParsed: URL;
        try {
          nextParsed = new URL(locationHeader, currentHref);
        } catch {
          return {
            ok: false,
            error: 'Invalid redirect URL during image fetch.',
          };
        }
        if (isBlockedImageTargetUrl(nextParsed.href)) {
          return {
            ok: false,
            error: 'Blocked redirect to private, loopback, or disallowed URL.',
          };
        }
        if (nextParsed.origin !== initialOrigin) {
          credentialsMode = 'omit';
        }
        currentHref = nextParsed.href;
        continue;
      }

      break;
    }

    if (response.url && isBlockedImageTargetUrl(response.url)) {
      void response.body?.cancel().catch(() => {});
      return {
        ok: false,
        error: 'Blocked redirect to private, loopback, or disallowed URL.',
      };
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return {
        ok: false,
        error: `Image fetch failed with HTTP ${response.status}`,
      };
    }

    const bodyResult = await Promise.race([
      readResponseBytesWithCap(response, maxImageBytes, abortController.signal),
      timeoutPromise,
    ]);
    if (!bodyResult.ok) {
      return bodyResult;
    }

    const mimeType = validateAndInferImageMimeType(
      response.headers.get('content-type'),
      bodyResult.bytes,
    );
    if (!mimeType) {
      return {
        ok: false,
        error: 'Response body is not a supported image format.',
      };
    }

    const base64 = arrayBufferToBase64(bodyResult.arrayBuffer);

    return {
      ok: true,
      mimeType,
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: sanitizeErrorText(err) || 'Failed to fetch image data URL.',
    };
  } finally {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
    }
    if (ruleInstalled && dnrApi?.updateSessionRules) {
      try {
        await dnrApi.updateSessionRules({ removeRuleIds: [ruleId] });
      } catch {
        // Ignore session cleanup errors on SW shutdown
      }
    }
    activeDnrRuleIds.delete(ruleId);
  }
}
