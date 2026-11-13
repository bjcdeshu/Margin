import { beforeEach, describe, expect, it } from 'vitest';
import {
  cloneFormattingElementSafely,
  reconstructRichDom,
  refreshClonedLinksAppearance,
  stripResidualMarkers,
  tokenizeParagraph,
} from '../../src/content/rich-text';

describe('rich-text: <mN> tokenizer, zero-innerHTML reconstructor & per-item fallback', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('tokenizes atomic inline code/KaTeX as <mN/> and formatting links/bold as <mN>text</mN>, then reconstructs clickable links', () => {
    const p = document.createElement('p');
    p.innerHTML =
      'Run <code>npm test</code> and read <a href="https://example.com/docs" target="_blank" rel="noopener" title="Docs" class="doc-link">the <strong>full guide</strong></a> after checking <span class="katex"><span class="katex-html">x^2</span></span>.';
    document.body.appendChild(p);

    const tokenized = tokenizeParagraph(p);
    expect(tokenized.hasRichTags).toBe(true);
    expect(tokenized.text).toBe(
      'Run <m0/> and read <m1>the <m2>full guide</m2></m1> after checking <m3/>.',
    );

    // Simulate natural target-language reordering (<m3/> moved earlier in sentence)
    const translated =
      '在检查 <m3/> 后运行 <m0/> 并阅读<m1><m2>完整指南</m2></m1>。';
    const result = reconstructRichDom(translated, tokenized, document);

    expect(result.fallbackPlain).toBe(false);

    const host = document.createElement('div');
    host.appendChild(result.fragment);

    const link = host.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener');
    expect(link?.getAttribute('title')).toBe('Docs');
    expect(link?.className).toBe('doc-link');
    expect(link?.querySelector('strong')?.textContent).toBe('完整指南');

    const code = host.querySelector('code');
    expect(code?.textContent).toBe('npm test');

    const katex = host.querySelector('.katex');
    expect(katex?.textContent).toBe('x^2');
    expect(host.textContent).toBe(
      '在检查 x^2 后运行 npm test 并阅读完整指南。',
    );
  });

  it('strips onclick/onerror/onload handlers, dangerous attributes, and javascript:/data: hrefs', () => {
    const p = document.createElement('p');
    p.innerHTML = [
      'Click <a href="javascript:alert(1)" onclick="window.__pwn=1" data-secret="xyz" lang="en">evil link</a>,',
      'visit <a href="https://safe.example/path" onmouseover="evil()">safe link</a>,',
      'inspect <img src="https://safe.example/pic.png" alt="pic" onerror="evil()" />,',
      'and view <svg viewBox="0 0 10 10" onload="evil()"><circle cx="5" cy="5" r="4" onclick="evil()"></circle></svg>.',
    ].join(' ');
    const origSvg = p.querySelector('svg')!;
    const evilScript = document.createElement('script');
    evilScript.textContent =
      'globalThis.__marginSvgScriptExec = (globalThis.__marginSvgScriptExec || 0) + 1;';
    origSvg.appendChild(evilScript);
    document.body.appendChild(p);
    (globalThis as Record<string, unknown>).__marginSvgScriptExec = 0;

    const tokenized = tokenizeParagraph(p);
    const result = reconstructRichDom(
      '点击<m0>恶意链接</m0>，访问<m1>安全链接</m1>，查看 <m2/> 与 <m3/>。',
      tokenized,
      document,
    );

    expect(result.fallbackPlain).toBe(false);
    const out = document.createElement('div');
    out.appendChild(result.fragment);
    document.body.appendChild(out);
    expect((globalThis as Record<string, unknown>).__marginSvgScriptExec).toBe(0);

    const links = out.querySelectorAll('a');
    expect(links).toHaveLength(2);
    // javascript: href stripped, onclick & data-secret stripped, safe lang preserved
    expect(links[0]?.hasAttribute('href')).toBe(false);
    expect(links[0]?.hasAttribute('onclick')).toBe(false);
    expect(links[0]?.hasAttribute('data-secret')).toBe(false);
    expect(links[0]?.getAttribute('lang')).toBe('en');

    // Safe https href kept, onmouseover stripped
    expect(links[1]?.getAttribute('href')).toBe('https://safe.example/path');
    expect(links[1]?.hasAttribute('onmouseover')).toBe(false);

    // img src kept, onerror stripped
    const img = out.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://safe.example/pic.png');
    expect(img?.hasAttribute('onerror')).toBe(false);

    // svg script element and onload/onclick stripped
    const svg = out.querySelector('svg');
    expect(svg?.hasAttribute('onload')).toBe(false);
    expect(svg?.querySelector('script')).toBeNull();
    expect(svg?.querySelector('circle')?.hasAttribute('onclick')).toBe(false);
  });

  it('tolerates LLMs expanding atomic <m0/> to empty <m0></m0>', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Execute <code>vitest run</code> now.';
    document.body.appendChild(p);

    const tokenized = tokenizeParagraph(p);
    const result = reconstructRichDom('立即执行 <m0></m0>。', tokenized, document);
    expect(result.fallbackPlain).toBe(false);

    const out = document.createElement('div');
    out.appendChild(result.fragment);
    expect(out.querySelector('code')?.textContent).toBe('vitest run');
  });

  it('degrades ONLY mangled paragraphs to clean plain text while preserving rich links on batch siblings', () => {
    const p1 = document.createElement('p');
    p1.innerHTML = 'First item with <a href="https://a.example">link A</a>.';
    const p2 = document.createElement('p');
    p2.innerHTML =
      'Second item with <a href="https://b.example">link B</a> and <strong>emphasis</strong>.';
    const p3 = document.createElement('p');
    p3.innerHTML = 'Third item with <a href="https://c.example">link C</a>.';
    document.body.append(p1, p2, p3);

    const t1 = tokenizeParagraph(p1);
    const t2 = tokenizeParagraph(p2);
    const t3 = tokenizeParagraph(p3);

    // Sibling 1: valid rich tags
    const r1 = reconstructRichDom('第一段包含<m0>链接 A</m0>。', t1, document);
    // Sibling 2: model dropped <m1> AND hallucinated <m9>
    const r2 = reconstructRichDom(
      '第二段包含<m0>链接 B</m0>与<m9>幻觉标签</m9>但漏掉了加粗。',
      t2,
      document,
    );
    // Sibling 3: valid rich tags
    const r3 = reconstructRichDom('第三段包含<m0>链接 C</m0>。', t3, document);

    expect(r1.fallbackPlain).toBe(false);
    expect(r2.fallbackPlain).toBe(true);
    expect(r3.fallbackPlain).toBe(false);

    const d1 = document.createElement('div');
    d1.appendChild(r1.fragment);
    expect(d1.querySelector('a')?.getAttribute('href')).toBe('https://a.example');

    const d2 = document.createElement('div');
    d2.appendChild(r2.fragment);
    expect(d2.querySelector('a')).toBeNull();
    expect(d2.textContent).toBe('第二段包含链接 B与幻觉标签但漏掉了加粗。');
    expect(d2.textContent).not.toMatch(/<\/?m\d+/);

    const d3 = document.createElement('div');
    d3.appendChild(r3.fragment);
    expect(d3.querySelector('a')?.getAttribute('href')).toBe('https://c.example');
  });

  it('catches overlapping and unclosed <mN> tags and strips all residual markers cleanly', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Read <a href="https://x.example">alpha</a> and <em>beta</em>.';
    document.body.appendChild(p);
    const tokenized = tokenizeParagraph(p);

    const overlapping = reconstructRichDom(
      '阅读 <m0>阿尔法 与 <m1>贝塔</m0></m1>。',
      tokenized,
      document,
    );
    expect(overlapping.fallbackPlain).toBe(true);
    const div1 = document.createElement('div');
    div1.appendChild(overlapping.fragment);
    expect(div1.textContent).toBe('阅读 阿尔法 与 贝塔。');

    const unclosed = reconstructRichDom(
      '阅读 <m0>阿尔法 与 <m1>贝塔</m1>',
      tokenized,
      document,
    );
    expect(unclosed.fallbackPlain).toBe(true);
    const div2 = document.createElement('div');
    div2.appendChild(unclosed.fragment);
    expect(div2.textContent).toBe('阅读 阿尔法 与 贝塔');

    expect(stripResidualMarkers('测试 <m0/> 残留 <m12>文本</m12> <m3')).toBe(
      '测试 残留 文本',
    );
  });

  it('preserves multi-paragraph newlines on pre-line/pre-wrap blocks while collapsing HTML indentation newlines on normal prose and skipping nested blocks/buttons', () => {
    const tweet = document.createElement('div');
    tweet.style.whiteSpace = 'pre-line';
    tweet.textContent = 'First paragraph of the announcement.\n\nSecond paragraph with key details.';
    document.body.appendChild(tweet);

    const tweetTokens = tokenizeParagraph(tweet);
    expect(tweetTokens.text).toBe(
      'First paragraph of the announcement.\n\nSecond paragraph with key details.',
    );

    const indentedP = document.createElement('p');
    indentedP.innerHTML = `
      Formatted HTML source
      with indentation line breaks
      that render as spaces.
    `;
    document.body.appendChild(indentedP);

    const pTokens = tokenizeParagraph(indentedP);
    expect(pTokens.text).toBe(
      'Formatted HTML source with indentation line breaks that render as spaces.',
    );

    const headingWithBtn = document.createElement('h2');
    headingWithBtn.innerHTML = 'Architecture Overview <button type="button">Copy</button>';
    const nestedLi = document.createElement('li');
    nestedLi.innerHTML = 'Parent item title <ul><li>Nested child bullet</li></ul>';
    document.body.append(headingWithBtn, nestedLi);

    expect(tokenizeParagraph(headingWithBtn).text).toBe('Architecture Overview');
    expect(tokenizeParagraph(nestedLi).text).toBe('Parent item title');
  });

  it('strips source lang and dir from cloned X Japanese/Arabic inline formatting spans when stripSourceLocaleAttrs is enabled while keeping backwards-compatible default', () => {
    const rawAnchor = document.createElement('a');
    rawAnchor.setAttribute('href', 'https://x.com/i/status/1');
    rawAnchor.setAttribute('lang', 'en');
    rawAnchor.setAttribute('dir', 'rtl');
    rawAnchor.className = 'r-1tl8opc';

    // Default (backwards-compatible): keeps safe lang and dir
    const defaultClone = cloneFormattingElementSafely(rawAnchor);
    expect(defaultClone.getAttribute('lang')).toBe('en');
    expect(defaultClone.getAttribute('dir')).toBe('rtl');
    expect(defaultClone.className).toBe('r-1tl8opc');

    // stripSourceLocaleAttrs: true strips lang and dir while keeping href and class
    const strippedClone = cloneFormattingElementSafely(rawAnchor, {
      stripSourceLocaleAttrs: true,
    });
    expect(strippedClone.hasAttribute('lang')).toBe(false);
    expect(strippedClone.hasAttribute('dir')).toBe(false);
    expect(strippedClone.getAttribute('href')).toBe('https://x.com/i/status/1');
    expect(strippedClone.className).toBe('r-1tl8opc');

    // Simulate X Japanese tweet with emoji splitting text into <span lang="ja" class="css-1jxf684 r-1tl8opc">
    const tweet = document.createElement('div');
    tweet.setAttribute('data-testid', 'tweetText');
    tweet.setAttribute('lang', 'ja');
    tweet.className = 'r-1tl8opc';
    tweet.innerHTML =
      '<span lang="ja" dir="rtl" class="css-1jxf684 r-1tl8opc">すみません</span><img alt="😭" src="https://abs-0.twimg.com/emoji/v2/svg/1f62d.svg"><span lang="ja" class="css-1jxf684 r-1tl8opc">卒論でWordを使ってる</span>';
    document.body.appendChild(tweet);

    const tokenized = tokenizeParagraph(tweet);
    expect(tokenized.text).toBe(
      '<m0>すみません</m0><m1/><m2>卒論でWordを使ってる</m2>',
    );

    const reconstructed = reconstructRichDom(
      '<m0>不好意思</m0><m1/><m2>谁现在还在毕业论文里用Word写东西</m2>',
      tokenized,
      document,
      { stripSourceLocaleAttrs: true },
    );
    expect(reconstructed.fallbackPlain).toBe(false);

    const out = document.createElement('div');
    out.appendChild(reconstructed.fragment);

    const spans = out.querySelectorAll('span.css-1jxf684.r-1tl8opc');
    expect(spans).toHaveLength(2);
    expect(spans[0]?.hasAttribute('lang')).toBe(false);
    expect(spans[0]?.hasAttribute('dir')).toBe(false);
    expect(spans[0]?.textContent).toBe('不好意思');
    expect(spans[1]?.hasAttribute('lang')).toBe(false);
    expect(spans[1]?.textContent).toBe('谁现在还在毕业论文里用Word写东西');

    const emojiImg = out.querySelector('img');
    expect(emojiImg?.getAttribute('alt')).toBe('😭');
    expect(emojiImg?.getAttribute('src')).toBe(
      'https://abs-0.twimg.com/emoji/v2/svg/1f62d.svg',
    );
  });

  it('preserves host link color & no-underline on stripped-ID YouTube titles and X mentions when preserveLinkAppearance is enabled and refreshes on live theme switches', () => {
    document.documentElement.setAttribute('dark', '');
    const style = document.createElement('style');
    style.textContent = `
      html[dark] { --yt-spec-text-primary: rgb(241, 241, 241); }
      html:not([dark]) { --yt-spec-text-primary: rgb(15, 15, 15); }
      a { color: rgb(62, 166, 255); text-decoration: underline; }
      #video-title { color: var(--yt-spec-text-primary); text-decoration: none; }
      .x-mention { color: rgb(29, 155, 240); text-decoration: none; }
      .prose-link { color: rgb(96, 165, 250); text-decoration: underline; }
    `;
    document.head.appendChild(style);

    const polymerH3 = document.createElement('h3');
    polymerH3.innerHTML = `<a id="video-title" class="yt-simple-endpoint" href="/watch?v=2"><yt-formatted-string>CYCLING THE WORLD</yt-formatted-string></a>`;
    const tweet = document.createElement('div');
    tweet.innerHTML = `Follow <a class="x-mention" href="https://x.com/FromSoftware">@FromSoftware</a> and <a class="prose-link" href="/guide">the guide</a>.`;
    document.body.append(polymerH3, tweet);

    // 1. Default (preserveLinkAppearance: false/omitted) adds zero link-appearance attributes
    const polymerTokenized = tokenizeParagraph(polymerH3);
    const defaultResult = reconstructRichDom(
      '<m0>单车环游世界</m0>',
      polymerTokenized,
      document,
    );
    const defaultHost = document.createElement('div');
    defaultHost.appendChild(defaultResult.fragment);
    const defaultLink = defaultHost.querySelector('a')!;
    expect(defaultLink.hasAttribute('id')).toBe(false);
    expect(defaultLink.hasAttribute('data-margin-has-link-color')).toBe(false);
    expect(defaultLink.hasAttribute('data-margin-no-underline')).toBe(false);

    // 2. preserveLinkAppearance: true captures #video-title white + no-underline even though `id` is stripped!
    const preservedPolymer = reconstructRichDom(
      '<m0>单车环游世界</m0>',
      polymerTokenized,
      document,
      { stripSourceLocaleAttrs: true, preserveLinkAppearance: true },
    );
    const polymerOut = document.createElement('span');
    polymerOut.appendChild(preservedPolymer.fragment);
    document.body.appendChild(polymerOut);

    const clonedPolymerLink = polymerOut.querySelector('a') as HTMLAnchorElement;
    expect(clonedPolymerLink.hasAttribute('id')).toBe(false);
    expect(clonedPolymerLink.getAttribute('data-margin-no-underline')).toBe('true');
    expect(clonedPolymerLink.getAttribute('data-margin-has-link-color')).toBe('true');
    expect(
      clonedPolymerLink.style.getPropertyValue('--margin-link-color'),
    ).toBe('rgb(241, 241, 241)');

    // 3. Mixed mention (no-underline blue) + prose link (underlined blue)
    const tweetTokenized = tokenizeParagraph(tweet);
    const preservedTweet = reconstructRichDom(
      '关注 <m0>@FromSoftware</m0> 并阅读<m1>技术指南</m1>。',
      tweetTokenized,
      document,
      { stripSourceLocaleAttrs: true, preserveLinkAppearance: true },
    );
    const tweetOut = document.createElement('span');
    tweetOut.appendChild(preservedTweet.fragment);
    document.body.appendChild(tweetOut);

    const [clonedMention, clonedProse] = Array.from(
      tweetOut.querySelectorAll('a'),
    ) as HTMLAnchorElement[];
    expect(clonedMention.getAttribute('data-margin-no-underline')).toBe('true');
    expect(clonedMention.style.getPropertyValue('--margin-link-color')).toBe(
      'rgb(29, 155, 240)',
    );
    expect(clonedProse.hasAttribute('data-margin-no-underline')).toBe(false);
    expect(clonedProse.style.getPropertyValue('--margin-link-color')).toBe(
      'rgb(96, 165, 250)',
    );

    // 4. Live Dark -> Light toggle refreshes `--margin-link-color` from WeakMap origin
    document.documentElement.removeAttribute('dark');
    refreshClonedLinksAppearance(polymerOut);
    expect(
      clonedPolymerLink.style.getPropertyValue('--margin-link-color'),
    ).toBe('rgb(15, 15, 15)');

    document.head.innerHTML = '';
    document.documentElement.removeAttribute('dark');
  });
});
