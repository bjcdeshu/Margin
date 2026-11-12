import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectTranslatableProse,
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

  it('excludes rich-text composer placeholders, Draft.js/tweetTextarea, pointer-events:none overlays, and YouTube channel/owner metadata while preserving titles & clickable news cards', () => {
    document.body.innerHTML = `
      <!-- X Draft.js Composer -->
      <div class="DraftEditor-root">
        <div class="public-DraftEditorPlaceholder-root">
          <div class="public-DraftEditorPlaceholder-inner" id="placeholder-tweet">What’s happening?</div>
        </div>
        <div class="DraftEditor-editorContainer">
          <div class="public-DraftEditor-content" contenteditable="true" role="textbox" data-testid="tweetTextarea_0"></div>
        </div>
      </div>

      <!-- Obfuscated React/Lexical composer with pointer-events:none sibling placeholder -->
      <div class="x-obfuscated-composer">
        <div id="obfuscated-ph" style="pointer-events: none; position: absolute;">Write a reply...</div>
        <div><div role="textbox" contenteditable="true"></div></div>
      </div>

      <!-- Explicit data-placeholder & [data-testid*="tweetTextarea"] -->
      <div data-testid="tweetTextarea_0_label">Post your reply</div>
      <div data-placeholder="Ask anything...">Ask anything...</div>
      <div class="customInputPlaceholder">Enter search query</div>

      <!-- YouTube Watch Metadata: Title vs Channel/Owner/Subscribe -->
      <ytd-watch-metadata>
        <div id="title">
          <h1 id="yt-watch-h1" style="max-height: 5.6rem; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;">
            <yt-formatted-string>Yubi, No. 21 Swordfighter Puppet No Damage Hellwalker – Phantom Blade Zero</yt-formatted-string>
          </h1>
        </div>
        <div id="bottom-row">
          <ytd-video-owner-renderer>
            <div id="upload-info">
              <ytd-channel-name id="channel-name">
                <div id="text-container"><a href="/@ONGBAL">옹발이 ONGBAL</a></div>
              </ytd-channel-name>
              <ytd-badge-supported-renderer>Verified</ytd-badge-supported-renderer>
              <yt-formatted-string id="owner-sub-count">475K subscribers</yt-formatted-string>
            </div>
          </ytd-video-owner-renderer>
          <tp-yt-paper-button role="button">Join</tp-yt-paper-button>
          <div role="button" id="sub-btn">Subscribe</div>
        </div>
        <ytd-video-meta-block>
          <div id="metadata-line"><span>78K views</span><span>1 day ago</span></div>
        </ytd-video-meta-block>
      </ytd-watch-metadata>

      <!-- Clickable X Today's News card with role="button" wrapping multiple prose blocks -->
      <div role="button" tabindex="0" class="todays-news-card">
        <div id="news-headline" style="display: -webkit-box; -webkit-line-clamp: 2; overflow: hidden;">
          Comma in Passwords Tip Circulates as CSV Leak Defense...
        </div>
        <div id="news-meta">Trending now · Other · 2,367 posts</div>
      </div>
    `;

    const blocks = extractParagraphBlocks(document.body, { targetLang: 'zh-CN' });
    expect(blocks.map((b) => b.id)).toEqual([
      'yt-watch-h1',
      'news-headline',
      'news-meta',
    ]);
  });

  it('extracts X.com timeline, Today’s News, NFL, Pressable prose cards, and Tailwind posts under React Native Web box-none (pointer-events: none) columns while excluding composer placeholders & UI buttons', () => {
    const style = document.createElement('style');
    style.textContent = `
      .r-105ug2t { pointer-events: none !important; }
      .r-1loqt21 { pointer-events: auto !important; }
    `;
    document.head.appendChild(style);

    document.body.innerHTML = `
      <div id="react-root">
        <div class="css-175oi2r r-105ug2t" style="pointer-events: none;">
          <main role="main" class="r-105ug2t" style="pointer-events: none;">
            <!-- Primary Timeline Column with inline Draft.js Composer + Feed -->
            <div data-testid="primaryColumn" class="r-105ug2t" style="pointer-events: none;">
              <div class="composer-shell r-1loqt21" style="pointer-events: auto;">
                <div class="composer-editor-box">
                  <div id="whats-happening-ph" style="pointer-events: none;">What’s happening?</div>
                  <div>
                    <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>
                  </div>
                </div>
                <div role="button" id="post-btn">Post</div>
              </div>

              <section class="r-1loqt21" style="pointer-events: auto;">
                <div data-testid="cellInnerDiv">
                  <article>
                    <div id="timeline-tweet-1" data-testid="tweetText">
                      <span>React Native Web box-none wrappers no longer prune timeline tweets.</span>
                    </div>
                    <!-- Grouped quote tweet inside role="group" -->
                    <div role="group">
                      <div role="button" tabindex="0" data-testid="card.wrapper">
                        <div id="quoted-tweet-1" data-testid="tweetText">
                          <span>Quoted release notes inside grouped Pressable card.</span>
                        </div>
                      </div>
                    </div>
                    <!-- Pure metric action bar role="group" -> still excluded -->
                    <div role="group" aria-label="120 replies, 940 reposts">
                      <span>120</span><span>940</span>
                    </div>
                  </article>
                </div>

                <!-- Tailwind v4 X post with placeholder:* utility classes and .x-middot-group author header -->
                <article class="flex flex-col gap-1 placeholder:text-gray-400 has-[:placeholder-shown]:opacity-100">
                  <div class="x-middot-group">
                    <a href="/OpenAI"><div id="x-tailwind-author">OpenAI</div></a>
                  </div>
                  <div id="tailwind-post-prose" class="placeholder:text-zinc-500">
                    Tailwind placeholder utility variants never wipe post cards or inline <span role="button">expandable notes</span>.
                  </div>
                </article>
              </section>
            </div>

            <!-- Sidebar Column with Search combobox + Today's News + NFL + Pressable cards -->
            <div data-testid="sidebarColumn" class="r-105ug2t" style="pointer-events: none;">
              <div class="search-wrap r-1loqt21" style="pointer-events: auto;">
                <input data-testid="SearchBox_Search_Input" role="combobox" placeholder="Search" />
              </div>

              <aside class="r-1loqt21" style="pointer-events: auto;">
                <h2 id="todays-news-heading">Today’s News</h2>

                <!-- Short multi-block Pressable news row (< 36 chars headline) -->
                <div role="button" tabindex="0">
                  <div id="short-news-head">SpaceX Launches Starship Test</div>
                  <div id="short-news-meta">Trending now · Science</div>
                </div>

                <!-- Leaf RNW Pressable prose card (no nested block children) -->
                <div role="button" tabindex="0" id="leaf-pressable-card">
                  <span>Developers adopt zero-latency streaming batch codecs across browser extensions</span>
                </div>

                <!-- NFL sports row -->
                <div role="button" tabindex="0">
                  <div id="nfl-matchup-prose">Commanders advance to conference championship game</div>
                </div>

                <!-- Compact UI buttons -> excluded -->
                <div role="button" id="follow-btn">Follow</div>
                <div role="button" id="subscribe-btn">Subscribe</div>
              </aside>
            </div>
          </main>
        </div>
      </div>
    `;

    const blocks = extractParagraphBlocks(document.body, { targetLang: 'zh-CN' });
    expect(blocks.map((b) => b.id)).toEqual([
      'timeline-tweet-1',
      'quoted-tweet-1',
      'tailwind-post-prose',
      'todays-news-heading',
      'short-news-head',
      'short-news-meta',
      'leaf-pressable-card',
      'nfl-matchup-prose',
    ]);

    // Inline role="button" span inside paragraph prose is preserved by collectTranslatableProse
    const tailwindProseEl = document.getElementById('tailwind-post-prose')!;
    expect(collectTranslatableProse(tailwindProseEl)).toContain('expandable notes');

    // Hover upward resolution works inside .r-105ug2t box-none columns too
    const tweetSpan = document.querySelector('#timeline-tweet-1 span')!;
    expect(
      findClosestParagraphBlock(tweetSpan, { targetLang: 'zh-CN' })?.id,
    ).toBe('timeline-tweet-1');
  });

  it('prevents flex H1..H6 / DIV delegation black holes with <yt-attributed-string> & inline tags, preserves player-placeholder wrappers & in-player titles, and resolves foreign ownerDocument in findClosestParagraphBlock', () => {
    document.body.innerHTML = `
      <header id="masthead">
        <span id="country-code">DE</span>
      </header>

      <div class="player-placeholder">
        <div class="ytp-chrome-top">
          <div class="ytp-title">
            <div id="ytp-title-box" class="ytp-title-text">
              <a class="ytp-title-link" href="/watch?v=AOJwkm3yixU">Full Boss Fight Walkthrough</a>
            </div>
          </div>
          <div class="ytp-chrome-top-buttons">Watch later</div>
        </div>
      </div>

      <div class="continuation-placeholder">
        <ytd-watch-metadata>
          <!-- Single-child flex H1 with <yt-formatted-string>: mounts directly on H1, NOT inside Polymer child -->
          <h1 id="flex-h1-single-fmt" style="display: flex;">
            <yt-formatted-string id="inner-yt-fmt">Single Child Flex Watch Title</yt-formatted-string>
          </h1>

          <!-- Single-child flex H1 with <yt-attributed-string>: never falls into 0-block delegation black hole -->
          <h1 id="flex-h1-single-attr" style="display: flex;">
            <yt-attributed-string><span>Attributed Watch Heading Title</span></yt-attributed-string>
          </h1>

          <!-- Flex H1 with sibling control <button>: delegates cleanly to <yt-attributed-string> -->
          <h1 id="flex-h1-with-btn" style="display: flex;">
            <yt-attributed-string id="delegated-yt-attr"><span>Heading Alongside Action Button</span></yt-attributed-string>
            <button type="button">Share</button>
          </h1>

          <!-- Flex DIV with non-standalone inline <strong>: never delegates into rejected <strong> -->
          <div id="flex-div-strong" style="display: flex;">
            <strong>Pinned Creator Note</strong>
          </div>
        </ytd-watch-metadata>

        <div id="comment-header">
          <a id="published-time-text" href="/watch?v=AOJwkm3yixU&lc=1">1 day ago</a>
        </div>
      </div>

      <!-- Explicit TipTap / editor placeholder classes are still excluded on leaf nodes -->
      <p class="is-editor-empty" id="tiptap-empty">Write a comment...</p>
      <div class="lexical-placeholder" id="lexical-empty">Add a public comment...</div>
    `;

    const blocks = extractParagraphBlocks(document.body, { targetLang: 'zh-CN' });
    expect(blocks.map((b) => b.id)).toEqual([
      'ytp-title-box',
      'flex-h1-single-fmt',
      'flex-h1-single-attr',
      'delegated-yt-attr',
      'flex-div-strong',
    ]);

    const innerFmt = document.getElementById('inner-yt-fmt')!;
    expect(findClosestParagraphBlock(innerFmt, { targetLang: 'zh-CN' })?.id).toBe(
      'flex-h1-single-fmt',
    );

    // Foreign Document support in findClosestParagraphBlock
    const foreignDoc = document.implementation.createHTMLDocument('Foreign');
    foreignDoc.body.innerHTML = `
      <article>
        <h1 id="foreign-h1"><span id="foreign-span">Foreign Document Heading</span></h1>
        <p id="foreign-zh">这是一段无需再次翻译的纯中文段落。</p>
      </article>
    `;
    const foreignSpan = foreignDoc.getElementById('foreign-span')!;
    const foreignZh = foreignDoc.getElementById('foreign-zh')!;
    expect(
      findClosestParagraphBlock(foreignSpan, { targetLang: 'zh-CN' })?.id,
    ).toBe('foreign-h1');
    expect(
      findClosestParagraphBlock(foreignZh, { targetLang: 'zh-CN' }),
    ).toBeNull();
  });
});
