import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultMarginConfig } from '@shared/constants';
import type {
  DiagnosticSnapshot,
  TranslateBatchRequest,
  TranslateBatchResponse,
} from '@shared/types';
import {
  InputQuickTranslator,
  computeCjkRatio,
  deepActiveElement,
  resolveEditableTarget,
  resolveInputTargetLanguage,
} from '../../src/content/input-translate';

function mockDiag(): DiagnosticSnapshot {
  return {
    schemaVersion: 1,
    product: 'Margin',
    version: '2.0.0',
    time: new Date().toISOString(),
    scene: 'input',
    codec: 'yaml',
    provider: {
      id: 'google-free',
      preset: 'google-free',
      protocol: 'google-web',
      endpointOrigin: 'https://translate.googleapis.com',
      endpointPath: '/translate_a/single',
      model: 'gtx',
    },
    parameters: {
      temperatureTrace: 'omitted-default',
      thinkingMode: 'provider-default',
      stream: false,
    },
    httpStatus: 200,
    kind: 'ok',
    retryable: false,
    attempts: 1,
    latencyMs: 25,
  };
}

describe('input-translate: Triple-Space, Alt+I, CJK direction, ShadowRoot, Escape cancel & Ctrl+Z undo', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('computes CJK character ratios and selects en vs zh-CN target direction accurately', () => {
    const config = createDefaultMarginConfig();
    expect(computeCjkRatio('请帮我审查这个 PR')).toBeGreaterThanOrEqual(0.15);
    expect(resolveInputTargetLanguage('请帮我审查这个 PR', config)).toBe('en');
    expect(resolveInputTargetLanguage('今天 fix 了一个 bug', config)).toBe('en');

    expect(
      computeCjkRatio('Please review this pull request before merging'),
    ).toBe(0);
    expect(
      resolveInputTargetLanguage(
        'Please review this pull request before merging',
        config,
      ),
    ).toBe('zh-CN');
  });

  it('triggers on Triple-Space within 650ms, updates controlled input listeners, and restores original text on Ctrl+Z', async () => {
    const config = createDefaultMarginConfig();
    let fakeNow = 1000;
    const sentRequests: TranslateBatchRequest[] = [];

    const translator = new InputQuickTranslator({
      config,
      now: () => fakeNow,
      transport: async (req): Promise<TranslateBatchResponse> => {
        sentRequests.push(req);
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: [
            {
              id: 1,
              trans: 'We need to refactor the authentication middleware.',
            },
          ],
          diagnostic: mockDiag(),
        };
      },
    });
    translator.mount();

    const textarea = document.createElement('textarea');
    textarea.value = '我们需要重构认证中间件  ';
    document.body.appendChild(textarea);
    textarea.focus();

    const inputEvents: string[] = [];
    textarea.addEventListener('input', () => {
      inputEvents.push(textarea.value);
    });

    // Spread outside 650ms window -> should NOT trigger
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }),
    );
    fakeNow += 400;
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }),
    );
    fakeNow += 400; // 800ms since 1st press -> 1st press pruned
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }),
    );
    expect(sentRequests).toHaveLength(0);

    // Reset with non-space key, then 3 consecutive Spaces within 650ms!
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    fakeNow += 50;
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }),
    );
    fakeNow += 180;
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }),
    );
    fakeNow += 180;
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ' ',
        code: 'Space',
        bubbles: true,
        cancelable: true,
      }),
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]?.toLang).toBe('en');
    expect(sentRequests[0]?.items[0]?.text).toBe('我们需要重构认证中间件');
    expect(textarea.value).toBe(
      'We need to refactor the authentication middleware.',
    );
    expect(inputEvents).toContain(
      'We need to refactor the authentication middleware.',
    );

    // Press Ctrl+Z -> restores exact original Chinese text and fires InputEvent!
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        code: 'KeyZ',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(textarea.value).toBe('我们需要重构认证中间件');
    expect(inputEvents[inputEvents.length - 1]).toBe('我们需要重构认证中间件');

    translator.destroy();
  });

  it('supports [contenteditable] editors, open ShadowRoot inputs via deepActiveElement, and skips password inputs', async () => {
    const config = createDefaultMarginConfig();
    const translator = new InputQuickTranslator({
      config,
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: [{ id: 1, trans: `Translated:${req.items[0]?.text}` }],
        diagnostic: mockDiag(),
      }),
    });
    translator.mount();

    // 1. Password input MUST be rejected
    const pwd = document.createElement('input');
    pwd.type = 'password';
    pwd.value = 'super-secret-password';
    document.body.appendChild(pwd);
    pwd.focus();
    expect(resolveEditableTarget(pwd)).toBeNull();
    expect(await translator.translateActiveElement()).toBe(false);
    expect(pwd.value).toBe('super-secret-password');

    // 2. Rich [contenteditable="true"] editor (ProseMirror / Discourse style)
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const innerP = document.createElement('p');
    innerP.textContent = '起草一条论坛回复';
    editor.appendChild(innerP);
    document.body.appendChild(editor);
    editor.focus();

    expect(resolveEditableTarget(innerP)).toBe(editor);
    expect(await translator.translateTarget(editor)).toBe(true);
    expect(editor.textContent).toBe('Translated:起草一条论坛回复');

    // Cmd+Z (Mac metaKey) undo on contenteditable
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(editor.textContent).toBe('起草一条论坛回复');

    // 3. Input nested inside an open ShadowRoot (`Alt+I` / `translateActiveElement`)
    const webComponentHost = document.createElement('div');
    const openShadow = webComponentHost.attachShadow({ mode: 'open' });
    const shadowInput = document.createElement('input');
    shadowInput.type = 'search';
    shadowInput.value = '分布式事务一致性';
    openShadow.appendChild(shadowInput);
    document.body.appendChild(webComponentHost);
    shadowInput.focus();

    expect(deepActiveElement(document)).toBe(shadowInput);
    expect(await translator.translateActiveElement()).toBe(true);
    expect(shadowInput.value).toBe('Translated:分布式事务一致性');

    translator.destroy();
  });

  it('shows non-focus-stealing Shadow DOM status pill and aborts cleanly on Escape without mutating draft', async () => {
    const config = createDefaultMarginConfig();
    const captured: { signal: AbortSignal | null } = { signal: null };

    const translator = new InputQuickTranslator({
      config,
      transport: (_req, _cb, signal) => {
        captured.signal = signal;
        return new Promise<TranslateBatchResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      },
    });
    translator.mount();

    const input = document.createElement('input');
    input.type = 'text';
    input.value = '保留未完成草稿原文';
    document.body.appendChild(input);
    input.focus();

    const pendingPromise = translator.translateActiveElement();

    // Pill is mounted inside ShadowRoot without stealing focus from `input`
    expect(document.activeElement).toBe(input);
    const pillShadow = translator.getPillShadowRoot();
    expect(pillShadow).not.toBeNull();
    expect(pillShadow?.querySelector('.label')?.textContent).toBe(
      'Margin · Translating…',
    );
    expect(pillShadow?.querySelector('.cancel-btn')?.textContent).toBe('Esc');

    // Press Escape -> aborts request, hides pill, preserves original input value!
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );

    const completed = await pendingPromise;
    expect(completed).toBe(false);
    expect(captured.signal?.aborted).toBe(true);
    expect(input.value).toBe('保留未完成草稿原文');

    translator.destroy();
  });
});
