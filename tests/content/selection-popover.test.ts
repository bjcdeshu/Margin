import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultMarginConfig } from '@shared/constants';
import {
  getMarginConfig,
  resetMemoryStorageForTests,
  saveMarginConfig,
} from '@shared/storage';
import type {
  DiagnosticSnapshot,
  TranslateBatchRequest,
  TranslateBatchResponse,
} from '@shared/types';
import { syncFullscreenFloatingVisibility } from '../../src/content/renderer';
import {
  SELECTION_POPOVER_CSS,
  SelectionPopover,
} from '../../src/content/selection-popover';

function mockSelectionDiag(): DiagnosticSnapshot {
  return {
    schemaVersion: 1,
    product: 'Margin',
    version: '2.0.0',
    time: new Date().toISOString(),
    scene: 'selection',
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
    latencyMs: 30,
  };
}

describe('selection-popover: Shadow isolation, trigger modes, <a> link safety, window.blur, Pin/Copy & drag release', () => {
  beforeEach(() => {
    resetMemoryStorageForTests();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.title = 'Selection Test Page';
    window.getSelection()?.removeAllRanges();
  });

  it('enforces Shadow DOM host reset and px-only sizing (zero rem units)', () => {
    expect(SELECTION_POPOVER_CSS).toContain('all: initial !important');
    expect(SELECTION_POPOVER_CSS).toContain('font-size: 16px !important');
    // Verify no `rem` units appear anywhere in SELECTION_POPOVER_CSS
    expect(SELECTION_POPOVER_CSS).not.toMatch(/\d(?:\.\d+)?rem\b/);
  });

  it('supports off, icon, dot, and instant trigger modes, Pin toggle, Copy button, and NEVER closes on window.blur', async () => {
    const config = createDefaultMarginConfig();
    config.selection.enabled = true;
    config.selection.triggerMode = 'icon';

    let copiedClipboard = '';
    const popover = new SelectionPopover({
      config,
      clipboardWrite: async (text) => {
        copiedClipboard = text;
      },
      transport: async (req): Promise<TranslateBatchResponse> => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: [{ id: 1, trans: `精选译文：${req.items[0]?.text}` }],
        diagnostic: mockSelectionDiag(),
      }),
    });
    popover.mount();

    // 1. `icon` mode presents trigger icon first
    popover.presentForSelection('Quiet editorial typography', { x: 120, y: 140 });
    expect(popover.state).toBe('trigger');
    const shadow = popover.getShadowRoot()!;
    const iconBtn = shadow.querySelector(
      '[data-part="trigger-icon"]',
    ) as HTMLButtonElement;
    const dotBtn = shadow.querySelector(
      '[data-part="trigger-dot"]',
    ) as HTMLButtonElement;
    expect(iconBtn.style.display).toBe('inline-flex');
    expect(dotBtn.style.display).toBe('none');

    // Click icon -> opens card and translates
    iconBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(popover.state).toBe('card');
    expect(popover.currentTranslation).toBe(
      '精选译文：Quiet editorial typography',
    );

    // 2. Dispatching `window.blur` MUST NOT close the popover!
    window.dispatchEvent(new Event('blur'));
    expect(popover.state).toBe('card');

    // 3. Copy button copies translation to clipboard
    const copyBtn = shadow.querySelector(
      '[data-action="copy"]',
    ) as HTMLButtonElement;
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(copiedClipboard).toBe('精选译文：Quiet editorial typography');
    expect(copyBtn.getAttribute('data-copied')).toBe('true');

    // 4. Pin toggle keeps card open on outside pointerdown & Escape
    const pinBtn = shadow.querySelector(
      '[data-action="pin"]',
    ) as HTMLButtonElement;
    pinBtn.click();
    expect(popover.isPinned).toBe(true);

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover.state).toBe('card');

    // Unpin -> outside pointerdown closes cleanly
    pinBtn.click();
    expect(popover.isPinned).toBe(false);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(popover.state).toBe('closed');

    // 5. `dot` mode & `instant` mode & `off` mode
    const dotCfg = structuredClone(config);
    dotCfg.selection.triggerMode = 'dot';
    popover.updateConfig(dotCfg);
    popover.presentForSelection('Dot trigger phrase', { x: 80, y: 90 });
    expect(popover.state).toBe('trigger');
    expect(dotBtn.style.display).toBe('inline-flex');
    expect(iconBtn.style.display).toBe('none');

    const instantCfg = structuredClone(config);
    instantCfg.selection.triggerMode = 'instant';
    popover.updateConfig(instantCfg);
    popover.presentForSelection('Instant phrase', { x: 80, y: 90 });
    await new Promise((r) => setTimeout(r, 10));
    expect(popover.state).toBe('card');
    expect(popover.currentTranslation).toBe('精选译文：Instant phrase');

    const offCfg = structuredClone(config);
    offCfg.selection.triggerMode = 'off';
    popover.updateConfig(offCfg);
    expect(popover.state).toBe('closed');

    popover.destroy();
  });

  it('allows selecting text inside <a href> links without navigating while preserving normal link clicks', () => {
    const config = createDefaultMarginConfig();
    config.selection.enabled = true;
    config.selection.triggerMode = 'icon';

    let fakeNow = 5000;
    const popover = new SelectionPopover({
      config,
      now: () => fakeNow,
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: [{ id: 1, trans: '链接内译文' }],
        diagnostic: mockSelectionDiag(),
      }),
    });
    popover.mount();

    const link = document.createElement('a');
    link.href = 'https://example.com/article';
    link.textContent = 'Read the complete distributed systems paper';
    document.body.appendChild(link);

    // A) Normal click with collapsed selection -> NOT prevented
    link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    link.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const normalClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(normalClick);
    expect(normalClick.defaultPrevented).toBe(false);

    // B) Drag-selecting text inside `<a href>` -> opens trigger AND prevents synthetic click navigation!
    const range = document.createRange();
    range.selectNodeContents(link);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    link.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }),
    );
    fakeNow += 80;
    link.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 160, clientY: 20 }),
    );

    expect(popover.state).toBe('trigger');

    fakeNow += 10;
    const postSelectClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(postSelectClick);
    expect(postSelectClick.defaultPrevented).toBe(true);

    popover.destroy();
  });

  it('releases card header dragging on both window pointerup and window pointercancel, and hides during fullscreen', async () => {
    const config = createDefaultMarginConfig();
    config.selection.enabled = true;
    config.selection.triggerMode = 'instant';

    const popover = new SelectionPopover({
      config,
      transport: async (req) => ({
        ok: true,
        requestId: req.requestId,
        providerId: 'google-free',
        model: 'gtx',
        items: [{ id: 1, trans: '可拖拽卡片译文' }],
        diagnostic: mockSelectionDiag(),
      }),
    });
    popover.mount();

    popover.presentForSelection('Draggable text', { x: 50, y: 50 });
    await new Promise((r) => setTimeout(r, 10));

    const shadow = popover.getShadowRoot()!;
    const header = shadow.querySelector('[data-part="card-header"]') as HTMLElement;
    const card = shadow.querySelector('[data-part="card"]') as HTMLElement;

    // 1. Drag and release via window `pointerup`
    header.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        clientX: 60,
        clientY: 60,
      }),
    );
    expect(popover.isDragging).toBe(true);

    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 160, clientY: 130 }),
    );
    expect(parseFloat(card.style.left)).toBeGreaterThan(50);

    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(popover.isDragging).toBe(false);

    // 2. Drag and release via window `pointercancel`
    header.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        clientX: 160,
        clientY: 130,
      }),
    );
    expect(popover.isDragging).toBe(true);

    window.dispatchEvent(new PointerEvent('pointercancel'));
    expect(popover.isDragging).toBe(false);

    // 3. Auto-hide floating Margin popovers when document.fullscreenElement is active
    const host = document.querySelector(
      '[data-margin-host="selection-popover"]',
    ) as HTMLElement;
    expect(host.hasAttribute('data-margin-fullscreen-hidden')).toBe(false);

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.body,
    });
    syncFullscreenFloatingVisibility(document);
    expect(host.getAttribute('data-margin-fullscreen-hidden')).toBe('true');

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: null,
    });
    syncFullscreenFloatingVisibility(document);
    expect(host.hasAttribute('data-margin-fullscreen-hidden')).toBe(false);

    popover.destroy();
  });

  it('passes pageContext in selection TranslateBatchRequest and supports + 存术语 quick-collect (Mapped + Keep-Original upsert & invalidated context guard)', async () => {
    const config = createDefaultMarginConfig();
    config.selection.enabled = true;
    config.selection.triggerMode = 'instant';
    config.uiColorMode = 'night';
    await saveMarginConfig(config);

    document.title = 'Scaling Laws for Compute-Optimal LLMs';
    const capturedRequests: TranslateBatchRequest[] = [];

    const popover = new SelectionPopover({
      config,
      getUrl: () => 'https://arxiv.org/abs/2203.15556',
      transport: async (req): Promise<TranslateBatchResponse> => {
        capturedRequests.push(req);
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'google-free',
          model: 'gtx',
          items: [{ id: 1, trans: '上下文窗口' }],
          diagnostic: mockSelectionDiag(),
        };
      },
    });
    popover.mount();

    // 1. Short crisp term (<= 80 chars) shows `+ 存术语` and passes arxiv.org pageContext
    popover.presentForSelection('Context Window', { x: 100, y: 120 });
    await new Promise((r) => setTimeout(r, 15));

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.context?.domain).toBe('arxiv.org');
    expect(capturedRequests[0]?.context?.title).toBe(
      'Scaling Laws for Compute-Optimal LLMs',
    );
    expect(capturedRequests[0]?.context?.styleGuide).toContain(
      'Academic & research',
    );

    const host = document.querySelector(
      '[data-margin-host="selection-popover"]',
    ) as HTMLElement;
    expect(host.getAttribute('data-display-mode')).toBe('night');

    const shadow = popover.getShadowRoot()!;
    const collectBtn = shadow.querySelector(
      '[data-action="collect-glossary"]',
    ) as HTMLButtonElement;
    const editorRow = shadow.querySelector(
      '[data-part="glossary-editor"]',
    ) as HTMLElement;
    const sourceLabel = shadow.querySelector(
      '[data-part="glossary-source"]',
    ) as HTMLElement;
    const targetInput = shadow.querySelector(
      '[data-part="glossary-target-input"]',
    ) as HTMLInputElement;
    const keepOrigBtn = shadow.querySelector(
      '[data-action="glossary-keep-original"]',
    ) as HTMLButtonElement;
    const saveBtn = shadow.querySelector(
      '[data-action="glossary-save"]',
    ) as HTMLButtonElement;
    const statusEl = shadow.querySelector(
      '[data-part="glossary-status"]',
    ) as HTMLElement;

    expect(collectBtn.hidden).toBe(false);
    expect(editorRow.hidden).toBe(true);

    // 2. Click `+ 存术语` -> opens compact editor pre-filled with current translation, save Mapped entry
    collectBtn.click();
    expect(editorRow.hidden).toBe(false);
    expect(sourceLabel.textContent).toBe('Context Window');
    expect(targetInput.value).toBe('上下文窗口');
    expect(keepOrigBtn.getAttribute('aria-pressed')).toBe('false');

    targetInput.value = '上下文视窗';
    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 15));

    expect(statusEl.textContent).toBe('已存入术语库 ✓');
    expect(collectBtn.textContent).toBe('已存入术语库 ✓');

    const afterMapped = await getMarginConfig();
    const mappedMatches = afterMapped.glossary.filter(
      (g) => g.k.toLowerCase() === 'context window' && !g.domain,
    );
    expect(mappedMatches).toHaveLength(1);
    expect(mappedMatches[0]).toMatchObject({
      k: 'Context Window',
      v: '上下文视窗',
      enabled: true,
      group: 'custom',
    });

    // 3. Re-select case-variant `context window`, click `保留原文` -> sets target to "" and updates existing entry without duplicating!
    popover.presentForSelection('context window', { x: 100, y: 120 });
    await new Promise((r) => setTimeout(r, 15));

    collectBtn.click();
    keepOrigBtn.click();
    expect(targetInput.value).toBe('');
    expect(keepOrigBtn.getAttribute('aria-pressed')).toBe('true');

    saveBtn.click();
    await new Promise((r) => setTimeout(r, 15));

    const afterKeepOrig = await getMarginConfig();
    const keepOrigMatches = afterKeepOrig.glossary.filter(
      (g) => g.k.toLowerCase() === 'context window' && !g.domain,
    );
    expect(keepOrigMatches).toHaveLength(1);
    expect(keepOrigMatches[0]).toMatchObject({
      k: 'context window',
      v: '',
      enabled: true,
      group: 'custom',
    });

    // 4. Long selections (> 80 chars) hide `+ 存术语` cleanly
    popover.presentForSelection('Long passage selection '.repeat(5), {
      x: 100,
      y: 120,
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(collectBtn.hidden).toBe(true);
    expect(editorRow.hidden).toBe(true);

    popover.destroy();
  });
});
