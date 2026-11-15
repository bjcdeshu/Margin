import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DNR_SESSION_RULE_BASE,
  fetchImageDataUrlWithDnr,
  initializeBackgroundServiceWorker,
  isBlockedImageTargetUrl,
  resetBackgroundServiceWorkerForTests,
  sweepOrphanedDnrSessionRules,
} from '../../src/background';
import { BRAND } from '@shared/brand';

const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const VALID_WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe('Background Sender Isolation & Hardened DNR Image Fetching (#127 #3)', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    resetBackgroundServiceWorkerForTests();
  });

  afterEach(() => {
    resetBackgroundServiceWorkerForTests();
    globalThis.chrome = originalChrome;
  });

  it('rejects external runtime onMessage and onConnect senders while accepting own extension ID and sweeping orphaned DNR rules on SW startup', async () => {
    type MessageListener = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (resp?: unknown) => void,
    ) => boolean | void;
    type ConnectListener = (port: chrome.runtime.Port) => void;

    const messageListeners: MessageListener[] = [];
    const connectListeners: ConnectListener[] = [];
    const removedRuleBatches: number[][] = [];

    globalThis.chrome = {
      runtime: {
        id: BRAND.pinnedExtensionId,
        onMessage: {
          addListener: (fn: MessageListener) => messageListeners.push(fn),
        },
        onConnect: {
          addListener: (fn: ConnectListener) => connectListeners.push(fn),
        },
      },
      declarativeNetRequest: {
        getSessionRules: vi.fn(async () => [
          { id: 42 },
          { id: DNR_SESSION_RULE_BASE },
          { id: DNR_SESSION_RULE_BASE + 49_999 },
          { id: DNR_SESSION_RULE_BASE + 50_000 },
        ]),
        updateSessionRules: vi.fn(
          async (opts: chrome.declarativeNetRequest.UpdateRuleOptions) => {
            if (opts.removeRuleIds) {
              removedRuleBatches.push(opts.removeRuleIds);
            }
          },
        ),
      },
    } as unknown as typeof chrome;

    initializeBackgroundServiceWorker();
    await new Promise((r) => setTimeout(r, 10));

    // Startup sweep removed ONLY owned session rules in [910000, 959999]
    expect(removedRuleBatches).toEqual([
      [DNR_SESSION_RULE_BASE, DNR_SESSION_RULE_BASE + 49_999],
    ]);

    const onMessage = messageListeners[0]!;
    const sendResponseExternal = vi.fn();

    // 1. External extension ID -> rejected synchronously (`false`)
    const keptOpenExternalExt = onMessage(
      { type: 'margin:get-translation-cache-stats' },
      { id: 'malicious-other-extension-id' },
      sendResponseExternal,
    );
    expect(keptOpenExternalExt).toBe(false);
    expect(sendResponseExternal).not.toHaveBeenCalled();

    // 2. External webpage origin without extension ID -> rejected synchronously (`false`)
    const keptOpenWebOrigin = onMessage(
      { type: 'margin:get-translation-cache-stats' },
      { origin: 'https://evil.example.com' } as chrome.runtime.MessageSender,
      sendResponseExternal,
    );
    expect(keptOpenWebOrigin).toBe(false);
    expect(sendResponseExternal).not.toHaveBeenCalled();

    // 3. Own extension ID -> accepted (`true`) and resolves RPC response
    let ownResolved: unknown;
    const ownDone = new Promise<void>((resolve) => {
      const keptOpenOwn = onMessage(
        { type: 'margin:get-translation-cache-stats' },
        { id: BRAND.pinnedExtensionId },
        (resp) => {
          ownResolved = resp;
          resolve();
        },
      );
      expect(keptOpenOwn).toBe(true);
    });
    await ownDone;
    expect(ownResolved).toMatchObject({ ok: true });

    // 4. External `onConnect` port -> immediately disconnected without attaching listeners
    const externalDisconnect = vi.fn();
    const externalAddMsgListener = vi.fn();
    connectListeners[0]!({
      name: BRAND.streamPortName,
      sender: { id: 'foreign-extension-id' },
      disconnect: externalDisconnect,
      postMessage: vi.fn(),
      onMessage: { addListener: externalAddMsgListener },
      onDisconnect: { addListener: vi.fn() },
    } as unknown as chrome.runtime.Port);
    expect(externalDisconnect).toHaveBeenCalledTimes(1);
    expect(externalAddMsgListener).not.toHaveBeenCalled();

    // 5. Own `onConnect` port -> accepted and attaches stream message listener
    const ownDisconnect = vi.fn();
    const ownAddMsgListener = vi.fn();
    connectListeners[0]!({
      name: BRAND.streamPortName,
      sender: { id: BRAND.pinnedExtensionId },
      disconnect: ownDisconnect,
      postMessage: vi.fn(),
      onMessage: { addListener: ownAddMsgListener },
      onDisconnect: { addListener: vi.fn() },
    } as unknown as chrome.runtime.Port);
    expect(ownDisconnect).not.toHaveBeenCalled();
    expect(ownAddMsgListener).toHaveBeenCalledTimes(1);
  });

  it('blocks private, loopback, link-local, ULA, and IPv4-mapped IPv6 targets both pre-fetch and post-redirect', async () => {
    const blockedUrls = [
      'http://127.0.0.1/secret.png',
      'http://127.0.1.2:8080/a.png',
      'http://0.0.0.0/a.png',
      'http://localhost/a.png',
      'http://localhost./a.png',
      'http://sub.localhost/a.png',
      'http://printer.local/a.png',
      'http://10.1.2.3/a.png',
      'http://172.16.0.1/a.png',
      'http://172.31.255.255/a.png',
      'http://192.168.1.1/a.png',
      'http://169.254.169.254/latest/meta-data/iam',
      'http://[::1]/a.png',
      'http://[::]/a.png',
      'http://[fc00::1]/a.png',
      'http://[fd12:3456:789a::1]/a.png',
      'http://[fe80::1]/a.png',
      'http://[::ffff:127.0.0.1]/a.png',
      'http://[::ffff:169.254.169.254]/a.png',
      'http://[::ffff:10.0.0.1]/a.png',
      'http://[::ffff:0.0.0.0]/a.png',
      'file:///etc/passwd',
    ];

    for (const url of blockedUrls) {
      expect(isBlockedImageTargetUrl(url)).toBe(true);
    }

    expect(isBlockedImageTargetUrl('https://i.pximg.net/img/comic.png')).toBe(
      false,
    );
    expect(isBlockedImageTargetUrl('http://172.32.0.1/public.png')).toBe(false);

    const fetchNeverCalled = vi.fn();
    const dnrNeverCalled = { updateSessionRules: vi.fn() };
    const preBlocked = await fetchImageDataUrlWithDnr(
      {
        imageUrl: 'http://169.254.169.254/latest/meta-data/',
        refererUrl: 'https://example.com/',
      },
      {
        fetchImpl: fetchNeverCalled as unknown as typeof fetch,
        dnrApi: dnrNeverCalled,
      },
    );
    expect(preBlocked.ok).toBe(false);
    expect(fetchNeverCalled).not.toHaveBeenCalled();
    expect(dnrNeverCalled.updateSessionRules).not.toHaveBeenCalled();

    // Post-redirect SSRF guard (`response.url` redirected from public host to loopback/link-local)
    const redirectFetch = vi.fn(async () => {
      const resp = new Response(VALID_PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
      Object.defineProperty(resp, 'url', {
        value: 'http://127.0.0.1:9000/internal-admin.png',
      });
      return resp;
    });
    const dnrRedirectSpy = { updateSessionRules: vi.fn(async () => undefined) };

    const postRedirectBlocked = await fetchImageDataUrlWithDnr(
      {
        imageUrl: 'https://cdn.example.com/avatar.png',
        refererUrl: 'https://example.com/',
      },
      {
        fetchImpl: redirectFetch as unknown as typeof fetch,
        dnrApi: dnrRedirectSpy,
      },
    );
    expect(postRedirectBlocked.ok).toBe(false);
    expect(postRedirectBlocked.error).toMatch(/redirect|private|loopback/i);
    // Session rule was still cleaned up in `finally`
    expect(dnrRedirectSpy.updateSessionRules).toHaveBeenCalledTimes(2);
  });

  it('normalizes UTF-8 CJK image URLs to ASCII, escapes DNR metacharacters, and scopes session rules to TAB_ID_NONE (-1)', async () => {
    let capturedRule: chrome.declarativeNetRequest.Rule | undefined;
    let fetchedUrl = '';

    const dnrApi = {
      updateSessionRules: vi.fn(
        async (opts: chrome.declarativeNetRequest.UpdateRuleOptions) => {
          if (opts.addRules?.[0]) {
            capturedRule = opts.addRules[0];
          }
        },
      ),
    };

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      fetchedUrl = String(input);
      return new Response(VALID_WEBP_BYTES, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    });

    const cjkAndMetaUrl =
      'https://cdn.example.com/漫画/第1話*cover^v2|final.webp?sig=a*b^c';
    const result = await fetchImageDataUrlWithDnr(
      {
        imageUrl: cjkAndMetaUrl,
        refererUrl: 'https://manga.example.com/作品/1',
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        dnrApi,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe('image/webp');
    expect(fetchedUrl).toBe(new URL(cjkAndMetaUrl).href);
    expect(/^[\x20-\x7e]+$/.test(fetchedUrl)).toBe(true);

    expect(capturedRule).toBeDefined();
    expect(capturedRule!.condition.tabIds).toEqual([-1]);
    expect(capturedRule!.condition.regexFilter).toBeDefined();
    // Strictly ASCII so Chrome `updateSessionRules` never throws `Non-ASCII characters are not allowed`
    expect(/^[\x20-\x7e]+$/.test(capturedRule!.condition.regexFilter!)).toBe(
      true,
    );

    // Exact anchored regex matches the normalized URL and NOT wildcard/prefix neighbors
    const compiled = new RegExp(capturedRule!.condition.regexFilter!);
    expect(fetchedUrl).toContain('*cover');
    expect(compiled.test(fetchedUrl)).toBe(true);
    expect(compiled.test(`${fetchedUrl}&extra=1`)).toBe(false);
    expect(compiled.test(fetchedUrl.replace('*cover', 'WILDCARDcover'))).toBe(
      false,
    );
  });

  it('enforces fetch/body timeout, 20 MB byte cap, and strict image MIME / magic-byte validation (rejecting HTML & JSON 200 responses)', async () => {
    const dnrApi = {
      getSessionRules: vi.fn(async () => []),
      updateSessionRules: vi.fn(async () => undefined),
    };

    // 1. Timeout enforcement on hung fetch (and rule cleanup)
    const hungFetch = vi.fn(() => new Promise<Response>(() => {}));
    const timedOut = await fetchImageDataUrlWithDnr(
      {
        imageUrl: 'https://cdn.example.com/slow.png',
        refererUrl: 'https://example.com/',
      },
      {
        fetchImpl: hungFetch as unknown as typeof fetch,
        dnrApi,
        timeoutMs: 25,
      },
    );
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toMatch(/timed out/i);

    // 2. Streaming body exceeding `maxImageBytes` cancels stream early without OOM
    let cancelCalled = false;
    const oversizedStreamFetch = vi.fn(async () => {
      const rs = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          ctrl.enqueue(new Uint8Array(600));
        },
        cancel() {
          cancelCalled = true;
        },
      });
      return new Response(rs, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });

    const tooLarge = await fetchImageDataUrlWithDnr(
      {
        imageUrl: 'https://cdn.example.com/huge.png',
        refererUrl: 'https://example.com/',
      },
      {
        fetchImpl: oversizedStreamFetch as unknown as typeof fetch,
        dnrApi,
        maxImageBytes: 1024,
      },
    );
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge.error).toMatch(/maximum|exceeds/i);
    expect(cancelCalled).toBe(true);

    // 3. HTTP 200 `text/html` anti-bot challenge -> rejected (NEVER coerced to `image/jpeg`!)
    const htmlFetch = vi.fn(
      async () =>
        new Response('<!DOCTYPE html><html><body>Login Required</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );
    const htmlRes = await fetchImageDataUrlWithDnr(
      {
        imageUrl: 'https://cdn.example.com/login-wall.jpg',
        refererUrl: 'https://example.com/',
      },
      { fetchImpl: htmlFetch as unknown as typeof fetch, dnrApi },
    );
    expect(htmlRes.ok).toBe(false);
    expect(htmlRes.mimeType).toBeUndefined();

    // 4. HTTP 200 `application/json` OR spoofed `image/jpeg` header wrapping JSON error -> rejected!
    const spoofedJsonFetch = vi.fn(
      async () =>
        new Response('{"error":"hotlink blocked"}', {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
    );
    const jsonRes = await fetchImageDataUrlWithDnr(
      {
        imageUrl: 'https://cdn.example.com/error.jpg',
        refererUrl: 'https://example.com/',
      },
      { fetchImpl: spoofedJsonFetch as unknown as typeof fetch, dnrApi },
    );
    expect(jsonRes.ok).toBe(false);

    // Verify `sweepOrphanedDnrSessionRules` returns 0 cleanly when nothing is orphaned
    expect(await sweepOrphanedDnrSessionRules(dnrApi)).toBe(0);
  });

  it('intercepts 3xx redirects hop-by-hop via redirect: "manual", blocking private Location targets BEFORE any outbound loopback request', async () => {
    const seenCalls: Array<{ url: string; init?: RequestInit }> = [];
    const dnrApi = {
      updateSessionRules: vi.fn(async () => undefined),
    };

    // 1. Public -> Loopback 302: rejected BEFORE ever sending a 2nd fetch to 127.0.0.1!
    const ssrfRedirectFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        seenCalls.push({ url: String(input), init });
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:8080/internal-admin.png' },
        });
      },
    );

    const blocked = await fetchImageDataUrlWithDnr(
      {
        imageUrl: 'https://cdn.example.com/public-jump.png',
        refererUrl: 'https://example.com/post/1',
      },
      {
        fetchImpl: ssrfRedirectFetch as unknown as typeof fetch,
        dnrApi,
      },
    );

    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/redirect|private|loopback/i);
    expect(ssrfRedirectFetch).toHaveBeenCalledTimes(1);
    expect(seenCalls[0]?.init?.redirect).toBe('manual');
    expect(seenCalls[0]?.init?.credentials).toBe('include');

    // 2. Public -> Cross-Origin Public 302 -> 200 WebP: follows hop safely and drops credentials to 'omit'
    seenCalls.length = 0;
    const crossOriginRedirectFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seenCalls.push({ url, init });
        if (seenCalls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://img2.other-cdn.example/final.webp' },
          });
        }
        return new Response(VALID_WEBP_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        });
      },
    );

    const followed = await fetchImageDataUrlWithDnr(
      {
        imageUrl: 'https://cdn.example.com/hop1.webp',
        refererUrl: 'https://example.com/gallery',
      },
      {
        fetchImpl: crossOriginRedirectFetch as unknown as typeof fetch,
        dnrApi,
      },
    );

    expect(followed.ok).toBe(true);
    expect(followed.mimeType).toBe('image/webp');
    expect(seenCalls).toHaveLength(2);
    expect(seenCalls[0]?.init?.credentials).toBe('include');
    expect(seenCalls[1]?.url).toBe('https://img2.other-cdn.example/final.webp');
    expect(seenCalls[1]?.init?.credentials).toBe('omit');
  });
});
