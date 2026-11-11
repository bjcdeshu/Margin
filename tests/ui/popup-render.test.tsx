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

describe('Quiet Paper Popup Sheet (PopupApp)', () => {
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

  it('renders editorial controls, live scene routing summary, and toggles domain exclusion with snapshot-verified save', async () => {
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
    seeded.routing.input = 'inherit';
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

    // Renders primary action & PDF reader link
    expect(container.textContent).toContain('Margin');
    expect(container.textContent).toContain('翻译当前页面 (Alt+A)');
    expect(container.textContent).toContain('打开双语 PDF 阅读器');
    expect(container.textContent).toContain('模糊遮罩 Mask');

    // Renders live resolved scene routing summary
    const webRoute = container.querySelector('[data-testid="popup-route-webpage"]');
    const inputRoute = container.querySelector('[data-testid="popup-route-input"]');
    expect(webRoute?.textContent).toContain('OpenAI · gpt-6-luna');
    expect(inputRoute?.textContent).toContain('跟随网页 · gpt-6-luna');

    // Domain is currently allowed -> click 1-click Exclude Current Domain
    const domainBtn = container.querySelector(
      '[data-testid="popup-domain-toggle"]',
    ) as HTMLButtonElement;
    expect(domainBtn).not.toBeNull();
    expect(domainBtn.textContent).toContain('排除当前域名');

    await act(async () => {
      domainBtn.click();
    });
    await flushMicrotasks();

    const updatedCfg = await getMarginConfig();
    expect(updatedCfg.urlRules.excludeMatches).toContain('https://news.ycombinator.com/*');
    expect(domainBtn.textContent).toContain('允许当前域名');

    // Snapshot-verified Save pill appears after user-initiated action
    const savePill = container.querySelector('[data-testid="popup-save-pill"]');
    expect(savePill?.textContent).toBe('已保存');
  });
});
