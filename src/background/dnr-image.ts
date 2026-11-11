import { sanitizeErrorText } from '@core/diagnostics';
import type {
  FetchImageDataUrlRequest,
  FetchImageDataUrlResponse,
} from '@shared/types';

let nextDnrRuleOffset = 0;
const DNR_SESSION_RULE_BASE = 910_000;
const DNR_SESSION_RULE_SPAN = 50_000;

function allocateDnrSessionRuleId(): number {
  const id = DNR_SESSION_RULE_BASE + (nextDnrRuleOffset % DNR_SESSION_RULE_SPAN);
  nextDnrRuleOffset = (nextDnrRuleOffset + 1) % DNR_SESSION_RULE_SPAN;
  return id;
}

function inferImageMimeType(
  headerContentType: string | null,
  bytes: Uint8Array,
): string {
  if (headerContentType) {
    const clean = headerContentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (clean.startsWith('image/')) {
      return clean;
    }
  }

  // Magic-byte sniffing for CDNs returning `application/octet-stream`
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
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }

  return 'image/jpeg';
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
  dnrApi?: Pick<typeof chrome.declarativeNetRequest, 'updateSessionRules'>;
}

/**
 * Fetches an anti-hotlink (`403`) image as a `data:<mime>;base64,...` URL by installing
 * a short-lived `chrome.declarativeNetRequest.updateSessionRules` rule injecting
 * `Referer` and `Origin` headers for the target image URL and removing it in `finally`.
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

  let effectiveReferer = refererUrl;
  let refererOrigin = parsedImageUrl.origin;
  if (refererUrl) {
    try {
      const parsedRef = new URL(refererUrl);
      if (/^https?:$/i.test(parsedRef.protocol)) {
        effectiveReferer = parsedRef.toString();
        refererOrigin = parsedRef.origin;
      }
    } catch {
      effectiveReferer = parsedImageUrl.origin + '/';
    }
  } else {
    effectiveReferer = `${parsedImageUrl.origin}/`;
  }

  const dnrApi =
    deps.dnrApi ??
    (typeof globalThis.chrome !== 'undefined'
      ? globalThis.chrome?.declarativeNetRequest
      : undefined);

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const ruleId = allocateDnrSessionRuleId();
  let ruleInstalled = false;

  try {
    if (dnrApi?.updateSessionRules) {
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
            condition: {
              urlFilter: imageUrl,
              resourceTypes: [
                'xmlhttprequest',
                'image',
                'other',
              ] as chrome.declarativeNetRequest.ResourceType[],
            },
          },
        ],
      });
      ruleInstalled = true;
    }

    const response = await fetchImpl(imageUrl, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `Image fetch failed with HTTP ${response.status}`,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const mimeType = inferImageMimeType(
      response.headers.get('content-type'),
      bytes,
    );
    const base64 = arrayBufferToBase64(arrayBuffer);

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
    if (ruleInstalled && dnrApi?.updateSessionRules) {
      try {
        await dnrApi.updateSessionRules({ removeRuleIds: [ruleId] });
      } catch {
        // Ignore session cleanup errors on SW shutdown
      }
    }
  }
}
