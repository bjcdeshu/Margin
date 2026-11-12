import { beforeEach, describe, expect, it } from 'vitest';
import {
  extractPageContext,
  extractParagraphBlocks,
  findClosestParagraphBlock,
} from '../../src/content/dom-walker';

describe('dom-walker: smart paragraph extraction & math/code protection', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.title = 'Margin Test Article';
  });

  it('extracts readable leaf blocks and leaf text divs without duplicating wrapper containers', () => {
    document.body.innerHTML = `
      <article>
        <h1>Understanding Distributed Consensus</h1>
        <div class="wrapper">
          <div class="leaf-callout">Important note for systems engineers.</div>
        </div>
        <blockquote>
          <p>Safety means nothing bad ever happens.</p>
          <p>Liveness means something good eventually happens.</p>
        </blockquote>
        <ul>
          <li>Leader election phase</li>
          <li>Log replication phase</li>
        </ul>
        <table>
          <tr>
            <th>Metric</th>
            <th>42</th>
            <td>99.99%</td>
            <td>Tail latency under partition</td>
          </tr>
        </table>
      </article>
    `;

    const blocks = extractParagraphBlocks(document.body);
    const texts = blocks.map((el) => el.textContent?.trim());

    expect(texts).toEqual([
      'Understanding Distributed Consensus',
      'Important note for systems engineers.',
      'Safety means nothing bad ever happens.',
      'Liveness means something good eventually happens.',
      'Leader election phase',
      'Log replication phase',
      'Metric',
      'Tail latency under partition',
    ]);
  });

  it('never splits sentences containing inline .katex, mjx-container, math, code, kbd, svg, or img', () => {
    document.body.innerHTML = `
      <p id="math-para">
        Given <span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html" aria-hidden="true"><span class="base">x + y</span></span></span>
        and <mjx-container class="MathJax" jax="CHTML"><mjx-math><mjx-mi>z</mjx-mi></mjx-math></mjx-container>,
        run <code>cargo test --release</code> or press <kbd>Ctrl+C</kbd> next to
        <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4"></circle></svg>
        and <img src="https://example.com/diagram.png" alt="diagram" /> to verify convergence.
      </p>
      <p id="pure-code"><code>npm install --save-dev vitest</code></p>
      <p id="pure-katex"><span class="katex">E = mc^2</span></p>
    `;

    const blocks = extractParagraphBlocks(document.body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe('math-para');
  });

  it('skips pre, script, style, textarea, input, contenteditable, translate="no", .notranslate, and injected nodes', () => {
    document.body.innerHTML = `
      <p id="keep-1">Translate this opening paragraph.</p>
      <pre><code>function ignoredPreBlock() { return true; }</code></pre>
      <script>const ignored = "do not translate";</script>
      <style>.ignored { content: "do not translate"; }</style>
      <noscript>Please enable JavaScript to view this page.</noscript>
      <textarea>User draft inside textarea</textarea>
      <input type="text" value="User draft inside input" />
      <div contenteditable="true"><p>Rich editor draft paragraph</p></div>
      <div translate="no"><p>Explicitly marked translate=no</p></div>
      <p class="notranslate">Explicitly marked .notranslate</p>
      <p data-margin-injected="true">Already injected translation node</p>
      <p hidden>Hidden paragraph element</p>
      <p id="keep-inline-notranslate">Deploy <span translate="no">Margin</span> to production today.</p>
    `;

    const blocks = extractParagraphBlocks(document.body);
    expect(blocks.map((b) => b.id)).toEqual([
      'keep-1',
      'keep-inline-notranslate',
    ]);
  });

  it('resolves closest readable paragraph block for hover while ignoring excluded zones and Margin hosts', () => {
    document.body.innerHTML = `
      <p id="p-hover">Read the <a id="inner-link" href="https://example.com">architecture guide</a> carefully.</p>
      <div class="notranslate"><p id="p-no">Untranslatable block</p></div>
      <div data-margin-host="selection-popover"><p id="p-host">Popover text</p></div>
    `;

    const link = document.getElementById('inner-link')!;
    expect(findClosestParagraphBlock(link)?.id).toBe('p-hover');
    expect(findClosestParagraphBlock(link.firstChild)?.id).toBe('p-hover');
    expect(findClosestParagraphBlock(document.getElementById('p-no'))).toBeNull();
    expect(findClosestParagraphBlock(document.getElementById('p-host'))).toBeNull();
  });

  it('extracts compact local page context without blocking network calls', () => {
    const meta = document.createElement('meta');
    meta.name = 'description';
    meta.content = 'Clean-room browser translation architecture.';
    document.head.appendChild(meta);
    document.body.innerHTML = `
      <h1>Margin Design Overview</h1>
      <p>Zero-bloat modular Manifest V3 extension.</p>
    `;

    const ctx = extractPageContext(document);
    expect(ctx.title).toBe('Margin Test Article');
    expect(ctx.summary).toContain('Clean-room browser translation architecture.');
    expect(ctx.summary).toContain('Margin Design Overview');
  });

  it('excludes X/Twitter UI chrome (@handles, User-Name, timestamps, counters, action groups, targetLang prose, .sr-only) while extracting real tweetText', () => {
    document.body.innerHTML = `
      <nav role="navigation"><a href="/home">Home</a><a href="/explore">Explore</a></nav>
      <article>
        <div data-testid="User-Avatar-Container-ubuntu">Avatar</div>
        <div data-testid="User-Name">
          <span>Ubuntu</span>
          <span>@ubuntu</span>
          <time datetime="2026-11-12T00:00:00Z">8h</time>
        </div>
        <div id="tweet-en" data-testid="tweetText">
          Ubuntu 26.04 LTS introduces faster container sandboxing and kernel-level observability.
        </div>
        <div data-testid="tweet-text-show-more-link">Show more</div>
        <div role="group" aria-label="42K views">
          <span>312</span>
          <span>1.4K</span>
          <span>8.8K</span>
          <span>42K</span>
        </div>
      </article>
      <article>
        <div id="tweet-zh" data-testid="tweetText">这是一条已经是简体中文的推文内容，无需再次重复翻译。</div>
      </article>
      <span class="sr-only" id="sr-noise">Screen reader status announcement</span>
      <p id="standalone-handle">@torvalds</p>
      <p id="standalone-reltime">14m</p>
    `;

    const blocks = extractParagraphBlocks(document.body, { targetLang: 'zh-CN' });
    expect(blocks.map((b) => b.id)).toEqual(['tweet-en']);
  });

  it('preserves headings with <button>, labels with <input>, parent text in nested <li>, mixed <div>, <summary>, <caption>, and flex card <span>', () => {
    document.body.innerHTML = `
      <h2 id="h2-btn">Quickstart Guide <button type="button">Copy link</button></h2>
      <label id="lbl-input"><input type="checkbox" /> Enable automatic background sync</label>
      <ul>
        <li id="parent-li">
          Core consensus invariants
          <ul>
            <li id="child-li">Election safety across quorums</li>
          </ul>
        </li>
      </ul>
      <div id="mixed-div">
        Direct introductory prose inside wrapper
        <div id="nested-div">Nested callout explanation</div>
      </div>
      <details open>
        <summary id="sum-el">Advanced networking options</summary>
        <section id="sec-el">Configure custom DNS over HTTPS resolvers.</section>
      </details>
      <table>
        <caption id="cap-el">Quarterly latency percentiles</caption>
      </table>
      <div style="display:flex">
        <span id="card-span">Zero-dependency streaming parser</span>
        <button type="button">Open</button>
      </div>
    `;

    const blocks = extractParagraphBlocks(document.body, { targetLang: 'zh-CN' });
    expect(blocks.map((b) => b.id)).toEqual([
      'h2-btn',
      'lbl-input',
      'parent-li',
      'child-li',
      'mixed-div',
      'nested-div',
      'sum-el',
      'sec-el',
      'cap-el',
      'card-span',
    ]);
  });
});
