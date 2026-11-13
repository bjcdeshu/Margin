import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultMarginConfig } from '@shared/constants';
import {
  getMarginConfig,
  resetMemoryStorageForTests,
  saveMarginConfig,
} from '@shared/storage';
import { PopupApp } from '../../src/ui/popup/PopupApp';

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Quiet Paper Popup Sheet (PopupApp — 3-Tier Editorial Hierarchy)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetMemoryStorageForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    render(null, container);
    container.remove();
  });

  it('renders 3-tier hierarchy, cycles Paper/Night/Auto theme, toggles Selection/Hover pills, and drives 3-state site auto-rule pills with immediate tab toggle', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    let simulatedPageActive = false;
    const sendTabSpy = vi.fn(async (_tabId: number, msg: { type: string }) => {
      if (msg.type === 'margin:cmd:toggle-page') {
        simulatedPageActive = !simulatedPageActive;
      }
      return {
        active: simulatedPageActive,
        inFlightBlocks: 0,
        translatedBlocks: simulatedPageActive ? 8 : 0,
        maskRevealed: false,
      };
    });

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        sendMessage: sendTabSpy,
      },
    };

    try {
      const seeded = createDefaultMarginConfig();
      seeded.providers['openai-bytb6BIB'] = {
        ...seeded.providers['google-free'],
        id: 'openai-bytb6BIB',
        name: 'OpenAI',
        preset: 'openai',
        protocol: 'openai-chat',
        model: 'gpt-6-luna',
      };
      seeded.providerOrder = ['openai-bytb6BIB', 'google-free'];
      seeded.routing.webpage = 'openai-bytb6BIB';
      await saveMarginConfig(seeded);

      await act(async () => {
        render(
          <PopupApp
            initialActiveTab={{
              id: 42,
              url: 'https://news.ycombinator.com/item?id=999',
            }}
            initialPageState={{
              active: false,
              inFlightBlocks: 0,
              translatedBlocks: 0,
              maskRevealed: false,
            }}
          />,
          container,
        );
      });
      await flushMicrotasks();

      // Must NOT show Saved pill on initial read-only hydration
      expect(container.querySelector('[data-testid="popup-save-pill"]')).toBeNull();

      // Tier 1 Hero + Tier 2 Reading Controls + Tier 3 Channel/Quick/Site bar
      expect(container.textContent).toContain('Margin');
      expect(container.querySelector('.mp-popup-version')?.textContent).toBe('v2.3.0');
      const heroBtn = container.querySelector(
        '[data-testid="popup-toggle-page"]',
      ) as HTMLButtonElement;
      expect(heroBtn.textContent).toContain('翻译当前页面');
      expect(heroBtn.textContent).toContain('Alt+A');
      expect(container.textContent).toContain('双语 PDF ↗');
      expect(container.textContent).toContain('遮罩');

      // Clickable active channel bar shows primary provider & model
      const webRoute = container.querySelector('[data-testid="popup-route-webpage"]');
      expect(webRoute?.textContent).toContain('OpenAI · gpt-6-luna');
      expect(webRoute?.textContent).toContain('配置 ↗');

      // Theme cycler switches Paper -> Night -> System
      const themeBtn = container.querySelector(
        '[data-testid="popup-theme-cycle"]',
      ) as HTMLButtonElement;
      expect(themeBtn.textContent).toContain('纸白');
      await act(async () => {
        themeBtn.click();
      });
      await flushMicrotasks();
      expect(themeBtn.textContent).toContain('夜读');
      expect((await getMarginConfig()).uiColorMode).toBe('night');

      // Quick toggle pills for Selection & Hover
      const selectionToggle = container.querySelector(
        '[data-testid="popup-toggle-selection"]',
      ) as HTMLButtonElement;
      expect(selectionToggle.getAttribute('aria-pressed')).toBe('true');
      await act(async () => {
        selectionToggle.click();
      });
      await flushMicrotasks();
      expect(selectionToggle.getAttribute('aria-pressed')).toBe('false');
      expect((await getMarginConfig()).selection.enabled).toBe(false);

      // 3-state site auto-rule pills: 跟随全局 (非中自动) -> 此站必翻 -> 此站不翻 -> 跟随全局
      const followBtn = container.querySelector(
        '[data-testid="popup-site-rule-follow"]',
      ) as HTMLButtonElement;
      const alwaysBtn = container.querySelector(
        '[data-testid="popup-site-rule-always"]',
      ) as HTMLButtonElement;
      const neverBtn = container.querySelector(
        '[data-testid="popup-site-rule-never"]',
      ) as HTMLButtonElement;

      expect(followBtn.getAttribute('aria-checked')).toBe('true');
      expect(followBtn.textContent).toContain('跟随全局');
      expect(followBtn.textContent).toContain('(非中自动)');
      expect(alwaysBtn.textContent).toContain('此站必翻');
      expect(neverBtn.textContent).toContain('此站不翻');

      // Click `此站必翻`: persists `*://news.ycombinator.com/*` in includeMatches AND dispatches toggle-page since !pageState.active
      sendTabSpy.mockClear();
      await act(async () => {
        alwaysBtn.click();
      });
      await flushMicrotasks();

      let updatedCfg = await getMarginConfig();
      expect(updatedCfg.urlRules.includeMatches).toContain(
        '*://news.ycombinator.com/*',
      );
      expect(alwaysBtn.getAttribute('aria-checked')).toBe('true');
      expect(sendTabSpy).toHaveBeenCalledWith(42, {
        type: 'margin:cmd:toggle-page',
      });
      expect(heroBtn.textContent).toContain('还原网页原文');

      // Snapshot-verified Save pill appears after user-initiated action
      const savePill = container.querySelector('[data-testid="popup-save-pill"]');
      expect(savePill?.textContent).toBe('已保存');

      // Click `此站不翻`: persists `*://news.ycombinator.com/*` in excludeMatches (preserving `https://linux.do/*`) AND restores original since pageState.active
      sendTabSpy.mockClear();
      await act(async () => {
        neverBtn.click();
      });
      await flushMicrotasks();

      updatedCfg = await getMarginConfig();
      expect(updatedCfg.urlRules.includeMatches).not.toContain(
        '*://news.ycombinator.com/*',
      );
      expect(updatedCfg.urlRules.excludeMatches).toContain(
        '*://news.ycombinator.com/*',
      );
      expect(updatedCfg.urlRules.excludeMatches).toContain('https://linux.do/*');
      expect(neverBtn.getAttribute('aria-checked')).toBe('true');
      expect(sendTabSpy).toHaveBeenCalledWith(42, {
        type: 'margin:cmd:toggle-page',
      });
      expect(heroBtn.textContent).toContain('翻译当前页面');

      // Click `跟随全局`: clears per-site rules for news.ycombinator.com while keeping `https://linux.do/*`
      sendTabSpy.mockClear();
      await act(async () => {
        followBtn.click();
      });
      await flushMicrotasks();

      updatedCfg = await getMarginConfig();
      expect(updatedCfg.urlRules.includeMatches).toEqual([]);
      expect(updatedCfg.urlRules.excludeMatches).toEqual(['https://linux.do/*']);
      expect(followBtn.getAttribute('aria-checked')).toBe('true');
      expect(sendTabSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as Record<string, unknown>).chrome = origChrome;
    }
  });

  it('displays subtle global mode badge on Follow pill for whitelist and off modes', async () => {
    const whitelistCfg = createDefaultMarginConfig();
    whitelistCfg.webpage.autoTranslateMode = 'whitelist';
    whitelistCfg.webpage.autoTranslateMatches = true;
    await saveMarginConfig(whitelistCfg);

    await act(async () => {
      render(
        <PopupApp
          initialActiveTab={{ id: 10, url: 'https://github.com/openai/openai-node' }}
          initialPageState={{
            active: false,
            inFlightBlocks: 0,
            translatedBlocks: 0,
            maskRevealed: false,
          }}
        />,
        container,
      );
    });
    await flushMicrotasks();

    const followBtn = container.querySelector(
      '[data-testid="popup-site-rule-follow"]',
    ) as HTMLButtonElement;
    expect(followBtn.textContent).toContain('(仅白名单)');

    // Update storage to `off` mode and verify live sync
    const offCfg = structuredClone(whitelistCfg);
    offCfg.webpage.autoTranslateMode = 'off';
    offCfg.webpage.autoTranslateMatches = false;
    await act(async () => {
      await saveMarginConfig(offCfg);
    });
    await flushMicrotasks();

    expect(followBtn.textContent).toContain('(手动)');
  });

  it('reflects active bilingual page state (还原网页原文) and surfaces upstream errors clearly', async () => {
    await saveMarginConfig(createDefaultMarginConfig());

    await act(async () => {
      render(
        <PopupApp
          initialActiveTab={{
            id: 77,
            url: 'https://x.com/ubuntu/status/123',
          }}
          initialPageState={{
            active: true,
            inFlightBlocks: 0,
            translatedBlocks: 12,
            maskRevealed: false,
            lastError: 'HTTP 401: Invalid API key',
          }}
        />,
        container,
      );
    });
    await flushMicrotasks();

    const heroBtn = container.querySelector(
      '[data-testid="popup-toggle-page"]',
    ) as HTMLButtonElement;
    expect(heroBtn.textContent).toContain('还原网页原文');

    const banner = container.querySelector('[data-testid="popup-status-banner"]');
    expect(banner?.textContent).toContain('HTTP 401: Invalid API key');

    const badge = container.querySelector('[data-testid="popup-page-badge"]');
    expect(badge?.textContent).toBe('翻译异常');
  });
});
