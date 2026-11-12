import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('renders 3-tier hierarchy, cycles Paper/Night/Auto theme, toggles Selection/Hover pills, and persists domain exclusion safely', async () => {
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
        />,
        container,
      );
    });
    await flushMicrotasks();

    // Must NOT show Saved pill on initial read-only hydration
    expect(container.querySelector('[data-testid="popup-save-pill"]')).toBeNull();

    // Tier 1 Hero + Tier 2 Reading Controls + Tier 3 Channel/Quick/Site bar
    expect(container.textContent).toContain('Margin');
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

    // 1-click site rule toggle: 在此网站禁用 -> 已禁用 · 点击恢复
    const domainBtn = container.querySelector(
      '[data-testid="popup-domain-toggle"]',
    ) as HTMLButtonElement;
    expect(domainBtn.textContent).toContain('在此网站禁用');

    await act(async () => {
      domainBtn.click();
    });
    await flushMicrotasks();

    const updatedCfg = await getMarginConfig();
    expect(updatedCfg.urlRules.excludeMatches).toContain(
      'https://news.ycombinator.com/*',
    );
    expect(domainBtn.textContent).toContain('已禁用 · 点击恢复');

    // Snapshot-verified Save pill appears after user-initiated action
    const savePill = container.querySelector('[data-testid="popup-save-pill"]');
    expect(savePill?.textContent).toBe('已保存');
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
