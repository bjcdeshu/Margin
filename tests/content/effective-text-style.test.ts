import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEffectiveHostTextStyle,
  inspectOriginalLinkAppearance,
  isSafeCssColorValue,
  resolveEffectiveHostTextStyle,
} from '../../src/content/effective-text-style';

function normalizeExpectedWhite(val: string | null): boolean {
  if (!val) return false;
  const lower = val.trim().toLowerCase();
  return lower === '#f1f1f1' || lower === 'rgb(241, 241, 241)';
}

describe('effective-text-style: color sanitizer, dominant carrier walk & link appearance inspector', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('dark');
    document.documentElement.removeAttribute('style');
  });

  it('validates safe CSS color values across modern color spaces while rejecting injection tokens', () => {
    expect(isSafeCssColorValue('rgb(241, 241, 241)')).toBe(true);
    expect(isSafeCssColorValue('rgba(29, 155, 240, 0.92)')).toBe(true);
    expect(isSafeCssColorValue('rgb(241 241 241 / 80%)')).toBe(true);
    expect(isSafeCssColorValue('hsl(210, 50%, 60%)')).toBe(true);
    expect(isSafeCssColorValue('hsla(210, 50%, 60%, 0.75)')).toBe(true);
    expect(isSafeCssColorValue('oklch(0.72 0.14 250 / 0.9)')).toBe(true);
    expect(isSafeCssColorValue('oklab(0.75 -0.05 -0.1)')).toBe(true);
    expect(isSafeCssColorValue('lab(70% -10 20)')).toBe(true);
    expect(isSafeCssColorValue('lch(70% 25 240deg)')).toBe(true);
    expect(isSafeCssColorValue('color(display-p3 1 0.5 0 / 0.8)')).toBe(true);
    expect(isSafeCssColorValue('#f1f1f1')).toBe(true);
    expect(isSafeCssColorValue('#fff')).toBe(true);
    expect(isSafeCssColorValue('#f1f1f1ff')).toBe(true);

    expect(isSafeCssColorValue('')).toBe(false);
    expect(isSafeCssColorValue(null)).toBe(false);
    expect(isSafeCssColorValue(undefined)).toBe(false);
    expect(isSafeCssColorValue('#12')).toBe(false);
    expect(isSafeCssColorValue('#12345')).toBe(false);
    expect(isSafeCssColorValue('rgb(0, 0, 0); background: red')).toBe(false);
    expect(isSafeCssColorValue('#fff} body { display: none')).toBe(false);
    expect(isSafeCssColorValue('color(srgb 1 0 0) {')).toBe(false);
    expect(isSafeCssColorValue('url(https://evil.example/a.png)')).toBe(false);
    expect(isSafeCssColorValue('rgb(0, 0, 0)\\29')).toBe(false);
    expect(isSafeCssColorValue('rgb(calc(1 + 2), 0, 0)')).toBe(false);
    expect(isSafeCssColorValue('var(--yt-spec-text-primary)')).toBe(false);
  });

  it('resolves YouTube Dark Mode lockup card, Watch H1, target-only wrapped source, and badge + title siblings', () => {
    document.documentElement.setAttribute('dark', '');
    document.documentElement.style.fontSize = '10px';

    const style = document.createElement('style');
    style.textContent = `
      html[dark] { --yt-spec-text-primary: #f1f1f1; }
      .yt-lockup-metadata-view-model__heading-reset {
        margin: 0;
        font-size: inherit;
        font-weight: inherit;
      }
      .yt-lockup-metadata-view-model__title {
        color: var(--yt-spec-text-primary);
        font-size: 16px;
        line-height: 22px;
        font-weight: 500;
        text-decoration: none;
      }
      .badge {
        color: #ff4e45;
        font-size: 11px;
        font-weight: 700;
      }
      h1.watch-h1 {
        font-size: 10px;
        font-weight: 400;
      }
      yt-formatted-string.watch-title {
        color: var(--yt-spec-text-primary);
        font-size: 20px;
        line-height: 28px;
        font-weight: 700;
      }
    `;
    document.head.appendChild(style);

    // 1. YouTube yt-lockup-view-model dark card
    const h3 = document.createElement('h3');
    h3.className = 'yt-lockup-metadata-view-model__heading-reset';
    h3.innerHTML = `
      <a class="yt-lockup-metadata-view-model__title" href="/watch?v=1">
        <span class="yt-core-attributed-string" role="text">my first solo trip to bangkok!</span>
      </a>
    `;
    document.body.appendChild(h3);

    const cardStyle = resolveEffectiveHostTextStyle(h3);
    expect(normalizeExpectedWhite(cardStyle.color)).toBe(true);
    expect(cardStyle.fontSize).toBe('16px');
    expect(cardStyle.lineHeight).toBe('22px');
    expect(cardStyle.fontWeight).toBe('500');

    // Apply & clean custom properties on target container
    const targetSpan = document.createElement('span');
    applyEffectiveHostTextStyle(targetSpan, cardStyle);
    expect(
      normalizeExpectedWhite(
        targetSpan.style.getPropertyValue('--margin-effective-color'),
      ),
    ).toBe(true);
    expect(
      targetSpan.style.getPropertyValue('--margin-effective-font-size'),
    ).toBe('16px');
    expect(
      targetSpan.style.getPropertyValue('--margin-effective-line-height'),
    ).toBe('22px');
    expect(
      targetSpan.style.getPropertyValue('--margin-effective-font-weight'),
    ).toBe('500');

    applyEffectiveHostTextStyle(targetSpan, {
      color: null,
      fontSize: null,
      lineHeight: null,
      fontWeight: null,
      letterSpacing: null,
    });
    expect(
      targetSpan.style.getPropertyValue('--margin-effective-color'),
    ).toBe('');
    expect(
      targetSpan.style.getPropertyValue('--margin-effective-font-size'),
    ).toBe('');

    // 2. Reversible target-only wrapper (.margin-orig-source[data-margin-orig-wrap="true"] with hidden)
    const wrapper = document.createElement('span');
    wrapper.className = 'margin-orig-source';
    wrapper.setAttribute('data-margin-orig-wrap', 'true');
    wrapper.hidden = true;
    wrapper.style.setProperty('display', 'none', 'important');
    while (h3.firstChild) {
      wrapper.appendChild(h3.firstChild);
    }
    h3.appendChild(wrapper);
    const injectedDummy = document.createElement('span');
    injectedDummy.setAttribute('data-margin-injected', 'true');
    injectedDummy.textContent = '我的第一次曼谷独自旅行！';
    h3.appendChild(injectedDummy);

    const wrappedCardStyle = resolveEffectiveHostTextStyle(h3);
    expect(normalizeExpectedWhite(wrappedCardStyle.color)).toBe(true);
    expect(wrappedCardStyle.fontSize).toBe('16px');
    expect(wrappedCardStyle.lineHeight).toBe('22px');
    expect(wrappedCardStyle.fontWeight).toBe('500');

    // 3. Badge + Title sibling (`LIVE` < 60%, `a.title` >= 60%)
    const badgeH3 = document.createElement('h3');
    badgeH3.className = 'yt-lockup-metadata-view-model__heading-reset';
    badgeH3.innerHTML = `<span class="badge">LIVE</span> <a class="yt-lockup-metadata-view-model__title" href="/watch?v=live">Elden Ring Pro Plays Phantom Blade Zero</a>`;
    document.body.appendChild(badgeH3);

    const badgeCardStyle = resolveEffectiveHostTextStyle(badgeH3);
    expect(normalizeExpectedWhite(badgeCardStyle.color)).toBe(true);
    expect(badgeCardStyle.fontSize).toBe('16px');
    expect(badgeCardStyle.fontWeight).toBe('500');

    // 4. Watch H1 > yt-formatted-string
    const watchH1 = document.createElement('h1');
    watchH1.className = 'watch-h1';
    watchH1.innerHTML = `<yt-formatted-string class="watch-title">PHANTOM BLADE Ø DAY 7 | Hellwalker Difficulty</yt-formatted-string>`;
    document.body.appendChild(watchH1);

    const watchStyle = resolveEffectiveHostTextStyle(watchH1);
    expect(normalizeExpectedWhite(watchStyle.color)).toBe(true);
    expect(watchStyle.fontSize).toBe('20px');
    expect(watchStyle.lineHeight).toBe('28px');
    expect(watchStyle.fontWeight).toBe('700');
  });

  it('keeps blockEl as primary carrier when direct non-whitespace text exists and inspects original link appearance accurately', () => {
    const style = document.createElement('style');
    style.textContent = `
      .tweet-body { color: rgb(231, 233, 234); font-size: 15px; font-weight: 400; }
      .mention-link { color: rgb(29, 155, 240); text-decoration: none; }
      .prose-para { color: rgb(212, 212, 216); font-size: 16px; font-weight: 400; }
      .prose-para strong { font-weight: 700; color: rgb(255, 255, 255); }
      .prose-link { color: rgb(96, 165, 250); text-decoration: underline; }
    `;
    document.head.appendChild(style);

    const tweet = document.createElement('div');
    tweet.className = 'tweet-body';
    tweet.setAttribute('data-testid', 'tweetText');
    tweet.innerHTML = `Huge congratulations to <a class="mention-link" href="https://x.com/FromSoftware">@FromSoftware</a> on the launch!`;
    document.body.appendChild(tweet);

    const tweetStyle = resolveEffectiveHostTextStyle(tweet);
    expect(tweetStyle.color).toBe('rgb(231, 233, 234)');
    expect(tweetStyle.fontSize).toBeNull();
    expect(tweetStyle.fontWeight).toBeNull();

    const para = document.createElement('p');
    para.className = 'prose-para';
    para.innerHTML = `<strong>Important Lead Note:</strong> Read the <a class="prose-link" href="/docs">official technical guide</a> today.`;
    document.body.appendChild(para);

    const paraStyle = resolveEffectiveHostTextStyle(para);
    expect(paraStyle.color).toBe('rgb(212, 212, 216)');
    expect(paraStyle.fontWeight).toBeNull();

    const mentionAnchor = tweet.querySelector('a.mention-link')!;
    const mentionAppearance = inspectOriginalLinkAppearance(mentionAnchor);
    expect(mentionAppearance.color).toBe('rgb(29, 155, 240)');
    expect(mentionAppearance.noUnderline).toBe(true);

    const proseAnchor = para.querySelector('a.prose-link')!;
    const proseAppearance = inspectOriginalLinkAppearance(proseAnchor);
    expect(proseAppearance.color).toBe('rgb(96, 165, 250)');
    expect(proseAppearance.noUnderline).toBe(false);
  });
});
