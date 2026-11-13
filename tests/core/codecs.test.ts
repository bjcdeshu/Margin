import { describe, expect, it, vi } from 'vitest';
import { importLegacyConfig } from '../../src/core/migration';
import {
  buildDefaultJsonBatchSystemPrompt,
  cleanPartialStreamingTrans,
  DEFAULT_JSON_BATCH_SYSTEM_PROMPT,
  delimiterPromptCodec,
  expandAssistantPrompts,
  jsonBatchCodec,
  singleTextMtCodec,
  yamlPromptCodec,
} from '../../src/core/prompts';
import {
  executeBatchWithProvider,
  ProviderExecutionPool,
} from '../../src/core/providers';
import {
  BUILTIN_ASSISTANTS,
  createDefaultMarginConfig,
} from '@shared/constants';
import type { AssistantConfig } from '@shared/types';

describe('YamlPromptCodec (Aloxaf "泛用翻译大师" compatibility)', () => {
  it('expands env variables in two passes and prunes empty imt_* sections (aJ parity)', () => {
    const customAloxaf: AssistantConfig = {
      ...structuredClone(BUILTIN_ASSISTANTS['builtin-yaml']),
      id: 'custom',
      prompt:
        '{{context_header}}{{terms_prompt}}{{html_only}}Translate from {{from}} to {{to}}:\n<yaml>\n{{yaml}}\n</yaml>',
      env: {
        ...BUILTIN_ASSISTANTS['builtin-yaml'].env,
        context_header: '--- Context ---\n{{title_prompt}}{{summary_prompt}}',
        html_only: 'Preserve <mN> tags strictly.\n',
      },
    };

    // Case 1: No context and no matching glossary terms, plain text -> all optional headers prune to ""!
    const plainEncoded = yamlPromptCodec.encode({
      scene: 'webpage',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Line one\nLine two' }],
      assistant: customAloxaf,
      glossary: [{ k: 'LLM', v: '' }], // not present in text
    });

    expect(plainEncoded.userPrompt).not.toContain('Document Title:');
    expect(plainEncoded.userPrompt).not.toContain('Context Summary:');
    expect(plainEncoded.userPrompt).not.toContain('--- Context ---');
    expect(plainEncoded.userPrompt).not.toContain('Required Glossary:');
    expect(plainEncoded.userPrompt).not.toContain('Preserve <mN> tags');
    // Multi-line block scalar indentation (`    Line two`)
    expect(plainEncoded.userPrompt).toContain(
      '- id: 1\n  src: |-\n    Line one\n    Line two',
    );
    expect(plainEncoded.userPrompt).toContain(
      'Translate from English to Simplified Chinese:',
    );

    // Case 2: Title + Glossary match + Rich `<m1>` tag -> sections expand cleanly!
    const richEncoded = yamlPromptCodec.encode({
      scene: 'webpage',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Modern <m1>LLMs</m1> scale well.', hasRichTags: true }],
      assistant: customAloxaf,
      context: {
        url: 'https://example.com/post',
        domain: 'example.com',
        title: 'Scaling Laws',
      },
      glossary: [
        { k: 'LLM', v: '' },
        { k: 'LLMs', v: '' },
      ],
    });

    expect(richEncoded.userPrompt).toContain('--- Context ---');
    expect(richEncoded.userPrompt).toContain('Document Title: Scaling Laws');
    expect(richEncoded.userPrompt).not.toContain('Context Summary:');
    expect(richEncoded.userPrompt).toContain("Required Glossary: 'LLMs': 'LLMs'");
    expect(richEncoded.userPrompt).toContain('Preserve <mN> tags strictly.');
  });

  it('safely quotes subtitle flow items containing colons or quotes', () => {
    const encoded = yamlPromptCodec.encode({
      scene: 'subtitle',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [
        { id: 10, text: 'Host: Welcome to "Margin": Episode 1' },
        { id: 11, text: 'Simple subtitle line' },
      ],
    });

    expect(encoded.userPrompt).toContain(
      '- id: 1\n  src: "Host: Welcome to \\"Margin\\": Episode 1"',
    );
    expect(encoded.userPrompt).toContain('- id: 2\n  src: Simple subtitle line');
  });

  it('strips <think>/<yaml>/fences and recovers unescaped colons, quotes, and id gaps strictly by numeric id', () => {
    const rawLlmOutput = `
<think>
Item 2 was empty or skipped; item 1 and item 3 have colons and quotes!
</think>
<yaml>
\`\`\`yaml
- id: 1
  thinking: Author note: keep "LLM" and ratio 16:9: exact
  trans: 作者注: 保留 "LLM" 以及比例 16:9: 精确
- id: 3
  thinking: Out-of-order / gap after 1: handle "gracefully"
  trans: 跳过第2项后的第3项: "不会错位串行"
\`\`\`
</yaml>
`;

    const inputItems = [
      { id: 101, text: 'First paragraph' },
      { id: 102, text: 'Second paragraph (dropped by LLM)' },
      { id: 103, text: 'Third paragraph' },
    ];

    const decoded = yamlPromptCodec.decode(rawLlmOutput, inputItems);

    // Crucial: `id: 3` maps strictly to `inputItems[2]` (`id: 103`), NEVER shifting into `inputItems[1]` (`id: 102`)!
    expect(decoded).toEqual([
      {
        id: 101,
        thinking: 'Author note: keep "LLM" and ratio 16:9: exact',
        trans: '作者注: 保留 "LLM" 以及比例 16:9: 精确',
      },
      {
        id: 103,
        thinking: 'Out-of-order / gap after 1: handle "gracefully"',
        trans: '跳过第2项后的第3项: "不会错位串行"',
      },
    ]);
  });

  it('emits progressive item-ready events during <yaml> SSE streaming', () => {
    const items = [
      { id: 1, text: 'Hello' },
      { id: 2, text: 'World' },
    ];
    const parser = yamlPromptCodec.createStreamParser(items);

    expect(parser.push('<think>Thinking...\n- id: 1\n  trans: Fake')).toEqual([]);
    expect(parser.push('</think>\n<yaml>\n- id: 1\n  trans: 你好\n')).toEqual([
      { id: 1, trans: '你好', partial: true },
    ]);
    // Starting `- id: 2` proves `- id: 1` is complete!
    const ready1 = parser.push('- id: 2\n  trans: 世');
    expect(ready1).toEqual([{ id: 1, trans: '你好' }]);

    const finished = parser.finish();
    expect(finished.newlyReady).toEqual([{ id: 2, trans: '世' }]);
    expect(finished.allItems).toEqual([
      { id: 1, trans: '你好' },
      { id: 2, trans: '世' },
    ]);
  });

  it('expands built-in conditional macros when omitted from env, injects <mN> tag rules, and recovers multi-line & inner-quoted scalars', () => {
    // Replicates imported user assistant where `env` omitted title_prompt/summary_prompt/terms_prompt & html_only
    const importedStyleAst: AssistantConfig = {
      ...structuredClone(BUILTIN_ASSISTANTS['builtin-yaml']),
      id: 'imported-custom',
      systemPrompt: 'Translate into {{to}} inside <yaml>...</yaml>.',
      prompt: '{{title_prompt}}{{summary_prompt}}{{terms_prompt}}<yaml>\n{{yaml}}\n</yaml>',
      env: {
        imt_yaml_item: '- id: {{id}}\n  src: |-\n    {{text}}',
        imt_source_field: 'src',
        imt_trans_field: 'trans',
      },
    };

    const richEncoded = yamlPromptCodec.encode({
      scene: 'webpage',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Click <m0>here</m0> to read about LLMs.', hasRichTags: true }],
      assistant: importedStyleAst,
      context: {
        url: 'https://example.com/guide',
        domain: 'example.com',
        title: 'Agentic Architecture',
        summary: 'Practical guide',
      },
      glossary: [{ k: 'LLMs', v: '' }],
    });

    expect(richEncoded.userPrompt).toContain('Document Title: Agentic Architecture');
    expect(richEncoded.userPrompt).toContain('Context Summary: Practical guide');
    expect(richEncoded.userPrompt).toContain("Required Glossary: 'LLMs': 'LLMs'");
    expect(richEncoded.systemPrompt).toContain('<m0>');

    // Plain-text batch with no context/glossary prunes all optional macros and omits <m0> rule
    const plainEncoded = yamlPromptCodec.encode({
      scene: 'webpage',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Simple plain text.' }],
      assistant: importedStyleAst,
    });
    expect(plainEncoded.userPrompt).toBe(
      '<yaml>\n- id: 1\n  src: |-\n    Simple plain text.\n</yaml>',
    );
    expect(plainEncoded.systemPrompt).not.toContain('<m0>');

    // Multi-line unindented trans + outer quotes wrapping unescaped inner quotes + prose-wrapped ```yaml fence
    const trickyOutput = `Here is the YAML translation you requested:
\`\`\`yaml
- id: 1
  trans: 第一行译文
第二行未缩进续行: 依然完整保留
- id: 2
  trans: "点击 <m0>这里</m0> 阅读 "第 2 部分: 架构""
\`\`\`
Hope this helps!`;

    const decoded = yamlPromptCodec.decode(
      trickyOutput,
      [
        { id: 10, text: 'Line 1\nLine 2' },
        { id: 20, text: 'Click <m0>here</m0> to read "Part 2: Architecture"', hasRichTags: true },
      ],
      { scene: 'webpage', assistant: importedStyleAst },
    );

    expect(decoded).toEqual([
      { id: 10, trans: '第一行译文\n第二行未缩进续行: 依然完整保留' },
      { id: 20, trans: '点击 <m0>这里</m0> 阅读 "第 2 部分: 架构"' },
    ]);

    // Streaming guard: pre-<yaml> reasoning prose with `- id: 1` must NEVER poison emitted items
    const streamItems = [{ id: 1, text: 'Hello' }];
    const sp = yamlPromptCodec.createStreamParser(streamItems, {
      scene: 'webpage',
      assistant: importedStyleAst,
    });
    expect(sp.push('Let me plan:\n- id: 1\n  trans: WRONG_DRAFT\n- id: 2\n  trans: X\n')).toEqual([]);
    const readyAfterYaml = sp.push('<yaml>\n- id: 1\n  trans: 正确译文\n</yaml>');
    expect(readyAfterYaml).toEqual([{ id: 1, trans: '正确译文' }]);
  });
});

describe('DelimiterPromptCodec ("通用翻译" %% streaming & mismatch recovery)', () => {
  it('streams completed %% segments progressively while withholding <think> blocks', () => {
    const items = [
      { id: 1, text: 'Para A' },
      { id: 2, text: 'Para B' },
      { id: 3, text: 'Para C' },
    ];

    const parser = delimiterPromptCodec.createStreamParser(items);

    // Unclosed <think> containing `%%` must NEVER emit premature items
    expect(parser.push('<think>Let us split with \n\n%%\n\n first')).toEqual([]);
    expect(parser.push('</think>段落一译文')).toEqual([
      { id: 1, trans: '段落一译文', partial: true },
    ]);

    // First delimiter completed -> item 1 emits finalized, item 2 emits partial preview!
    expect(parser.push('\n\n%%\n\n段落二')).toEqual([
      { id: 1, trans: '段落一译文' },
      { id: 2, trans: '段落二', partial: true },
    ]);

    // Second delimiter completed -> item 2 emits finalized, item 3 emits partial preview!
    expect(parser.push('完整译文\n%%\n段落三开始')).toEqual([
      { id: 2, trans: '段落二完整译文' },
      { id: 3, trans: '段落三开始', partial: true },
    ]);

    // Stream ends -> item 3 emits in `finish()`
    const done = parser.finish();
    expect(done.newlyReady).toEqual([{ id: 3, trans: '段落三开始' }]);
    expect(done.allItems).toEqual([
      { id: 1, trans: '段落一译文' },
      { id: 2, trans: '段落二完整译文' },
      { id: 3, trans: '段落三开始' },
    ]);
  });

  it('recovers gracefully from %% delimiter underflow (< N) and overflow (> N)', () => {
    const items = [
      { id: 1, text: 'One' },
      { id: 2, text: 'Two' },
      { id: 3, text: 'Three' },
    ];

    // Underflow: only 2 segments returned for 3 items -> returns first 2 without crashing
    const under = delimiterPromptCodec.decode('第一段\n\n%%\n\n第二段', items);
    expect(under).toEqual([
      { id: 1, trans: '第一段' },
      { id: 2, trans: '第二段' },
    ]);

    // Overflow: 4 segments returned for 3 items -> merges extra segment into final slot
    const over = delimiterPromptCodec.decode(
      '第一段\n\n%%\n\n第二段\n\n%%\n\n第三段上半\n\n%%\n\n第三段下半',
      items,
    );
    expect(over).toEqual([
      { id: 1, trans: '第一段' },
      { id: 2, trans: '第二段' },
      { id: 3, trans: '第三段上半\n\n第三段下半' },
    ]);
  });
});

describe('JsonBatchCodec & SingleTextMtCodec', () => {
  it('encodes & aligns JSON batches strictly by id and strips fences', () => {
    const items = [
      { id: 5, text: 'Alpha' },
      { id: 6, text: 'Beta' },
    ];
    const enc = jsonBatchCodec.encode({
      scene: 'webpage',
      fromLang: 'en',
      toLang: 'zh-CN',
      items,
    });
    expect(enc.userPrompt).toBe('[{"id":1,"src":"Alpha"},{"id":2,"src":"Beta"}]');

    const dec = jsonBatchCodec.decode(
      '```json\n[{"id":2,"trans":"贝塔"},{"id":1,"trans":"阿尔法"}]\n```',
      items,
    );
    expect(dec).toEqual([
      { id: 5, trans: '阿尔法' },
      { id: 6, trans: '贝塔' },
    ]);
  });

  it('encodes & decodes single-text MT responses cleanly', () => {
    const out = singleTextMtCodec.decode('<think>ok</think>简洁译文', [
      { id: 9, text: 'Concise text' },
    ]);
    expect(out).toEqual([{ id: 9, trans: '简洁译文' }]);
  });

  it('ships v2.2.0 Editorial BUILTIN_ASSISTANTS (zero-thinking fast YAML default + Aloxaf thinking preset + scene prompts) and routes request.scene in engine.ts', async () => {
    const fastYaml = BUILTIN_ASSISTANTS['builtin-yaml'];
    const thinkingYaml = BUILTIN_ASSISTANTS['builtin-yaml-thinking'];
    const fastDelim = BUILTIN_ASSISTANTS['builtin-delimiter'];

    expect(fastYaml.name).toBe('Margin 信达雅精译 (Fast Editorial <yaml>)');
    expect(fastYaml.prompt).not.toContain('thinking:');
    expect(fastYaml.systemPrompt).toContain('Never include a `thinking` field');
    expect(fastYaml.inputPrompt).toBeTruthy();
    expect(fastYaml.selectionPrompt).toBeTruthy();
    expect(fastYaml.subtitlePrompt).toBeTruthy();

    expect(thinkingYaml.name).toBe('泛用翻译大师 · 思考精修 (Aloxaf <yaml>)');
    expect(thinkingYaml.systemPrompt).toContain('thinking');
    expect(thinkingYaml.inputPrompt).toBeTruthy();
    expect(thinkingYaml.selectionPrompt).toBeTruthy();
    expect(thinkingYaml.subtitlePrompt).toBeTruthy();

    expect(fastDelim.name).toBe('极速流式直译 (%%)');
    expect(fastDelim.inputPrompt).toBeTruthy();
    expect(fastDelim.selectionPrompt).toBeTruthy();
    expect(fastDelim.subtitlePrompt).toBeTruthy();

    // Verify `expandAssistantPrompts` selects scene-specific templates and interpolates first-class variables
    const inputExpanded = expandAssistantPrompts({
      assistant: fastYaml,
      scene: 'input',
      fromLang: 'zh-CN',
      toLang: 'en',
      items: [{ id: 1, text: '帮我写一条 @openai #LLM 发布推文' }],
      glossary: [{ k: 'LLM', v: '' }],
    });
    expect(inputExpanded.userPrompt).toContain('native-speaker English');
    expect(inputExpanded.userPrompt).toContain('Keep-Original Terms');

    const selectionExpanded = expandAssistantPrompts({
      assistant: fastYaml,
      scene: 'selection',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'ephemeral KV cache' }],
      context: {
        url: 'https://docs.vllm.ai/en/latest/',
        domain: 'docs.vllm.ai',
        title: 'vLLM Architecture Guide',
        styleGuide: 'Crisp systems engineering terminology',
      },
    });
    expect(selectionExpanded.userPrompt).toContain('selected text');
    expect(selectionExpanded.userPrompt).toContain(
      'Document Title: vLLM Architecture Guide',
    );
    expect(selectionExpanded.userPrompt).toContain(
      'Style Guide: Crisp systems engineering terminology',
    );

    // Verify `DEFAULT_JSON_BATCH_SYSTEM_PROMPT` & unset-assistant scene hints in `engine.ts`
    expect(DEFAULT_JSON_BATCH_SYSTEM_PROMPT).toContain('信达雅');
    expect(buildDefaultJsonBatchSystemPrompt('en', 'input')).toContain(
      'Scene Hint (Outbound Input)',
    );
    expect(buildDefaultJsonBatchSystemPrompt('zh-CN', 'selection')).toContain(
      'Scene Hint (Selection)',
    );
    expect(buildDefaultJsonBatchSystemPrompt('zh-CN', 'subtitle')).toContain(
      'Scene Hint (Subtitle)',
    );

    // Verify `executeBatchWithProvider` passes `scene` all the way to prompt expansion
    let capturedUserPrompt = '';
    const mockFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>;
      };
      capturedUserPrompt =
        body.messages?.find((m) => m.role === 'user')?.content ?? '';
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '<yaml>\n- id: 1\n  trans: Shipped v2.2.0 cleanly!\n</yaml>',
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const cfg = createDefaultMarginConfig();
    const res = await executeBatchWithProvider({
      scene: 'input',
      provider: {
        ...cfg.providers['google-free'],
        id: 'oapi-test',
        preset: 'openai',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        apiKeys: ['sk-TEST_FAKE'],
        model: 'gpt-6-luna',
        assistantId: 'builtin-yaml',
      },
      assistant: fastYaml,
      fromLang: 'zh-CN',
      toLang: 'en',
      items: [{ id: 1, text: '干净利落地发布了 v2.2.0！' }],
      fetchImpl: mockFetch as unknown as typeof fetch,
      pool: new ProviderExecutionPool(),
    });
    expect(res.ok).toBe(true);
    expect(capturedUserPrompt).toContain('native-speaker English');
  });

  it('migrates legacy raw.translationLanguagePattern cleanly without flagging ignoredLegacyKeys', () => {
    const imported = importLegacyConfig({
      targetLanguage: 'zh-CN',
      translationLanguagePattern: {
        matches: ['en', 'ja'],
        excludeMatches: ['zh-CN'],
      },
    });
    expect(imported.config.webpage.autoTranslateMode).toBe('foreign');
    expect(imported.config.webpage.autoTranslateMatches).toBe(true);
    expect(imported.config.webpage.autoTranslateLanguages).toEqual(['en', 'ja']);
    expect(imported.stats.ignoredLegacyKeys).toEqual([]);
    expect(
      imported.audit.some(
        (a) => a.code === 'translation-language-pattern-migrated',
      ),
    ).toBe(true);

    const importedOff = importLegacyConfig({
      targetLanguage: 'zh-CN',
      autoTranslateMode: 'off',
      translationLanguagePattern: { matches: ['*'] },
    });
    expect(importedOff.config.webpage.autoTranslateMode).toBe('off');
    expect(importedOff.config.webpage.autoTranslateMatches).toBe(false);
  });
});

describe('v2.3.0 Intra-Item Streaming & Context Window Macros', () => {
  it('cleanPartialStreamingTrans strips trailing incomplete tags, unclosed quotes, and block-chomp markers', () => {
    expect(cleanPartialStreamingTrans('你好<')).toBe('你好');
    expect(cleanPartialStreamingTrans('你好<m0')).toBe('你好');
    expect(cleanPartialStreamingTrans('点击<m0>这里</m0')).toBe('点击<m0>这里');
    expect(cleanPartialStreamingTrans('术语<m-g id="0"')).toBe('术语');
    expect(cleanPartialStreamingTrans('译文内容</yam')).toBe('译文内容');
    expect(cleanPartialStreamingTrans('"第一行\\n正在翻译')).toBe(
      '第一行\n正在翻译',
    );
    expect(cleanPartialStreamingTrans("'正在单引号流式")).toBe('正在单引号流式');
    expect(cleanPartialStreamingTrans('|-')).toBe('');
  });

  it('yamlPromptCodec.createStreamParser streams 1-item & multi-item partial: true previews and transitions cleanly to finalized', () => {
    // 1-item batch live partial: true emission before </yaml>
    const singleItems = [{ id: 42, text: 'Hello world' }];
    const singleParser = yamlPromptCodec.createStreamParser(singleItems);
    expect(singleParser.push('<yaml>\n- id: 1\n  trans: 你好<m0')).toEqual([
      { id: 42, trans: '你好', partial: true },
    ]);
    expect(singleParser.push('>世界</m0')).toEqual([
      { id: 42, trans: '你好<m0>世界', partial: true },
    ]);
    expect(singleParser.push('></yam')).toEqual([
      { id: 42, trans: '你好<m0>世界</m0>', partial: true },
    ]);
    // Completing `</yaml>` finalizes the single item (`partial` omitted)
    const finalizedSingle = singleParser.push('l>');
    expect(finalizedSingle).toEqual([{ id: 42, trans: '你好<m0>世界</m0>' }]);
    expect(finalizedSingle[0].partial).toBeUndefined();
    expect(singleParser.finish().newlyReady).toEqual([]);

    // Unclosed quote inside 1-item YAML stream strips leading quote during partial preview
    const quotedParser = yamlPromptCodec.createStreamParser(singleItems);
    expect(quotedParser.push('<yaml>\n- id: 1\n  trans: "正在流式')).toEqual([
      { id: 42, trans: '正在流式', partial: true },
    ]);
    expect(quotedParser.push('"\n</yaml>')).toEqual([
      { id: 42, trans: '正在流式' },
    ]);

    // Multi-item batch partial -> finalized transition
    const multiItems = [
      { id: 10, text: 'First' },
      { id: 20, text: 'Second' },
    ];
    const multiParser = yamlPromptCodec.createStreamParser(multiItems);
    expect(multiParser.push('<yaml>\n- id: 1\n  trans: <m0>第一')).toEqual([
      { id: 10, trans: '<m0>第一', partial: true },
    ]);
    expect(multiParser.push('句</m')).toEqual([
      { id: 10, trans: '<m0>第一句', partial: true },
    ]);
    expect(multiParser.push('0>。\n- id: 2\n  trans: 第二')).toEqual([
      { id: 10, trans: '<m0>第一句</m0>。' },
      { id: 20, trans: '第二', partial: true },
    ]);
    const doneMulti = multiParser.push('句\n</yaml>');
    expect(doneMulti).toEqual([{ id: 20, trans: '第二句' }]);
    expect(doneMulti[0].partial).toBeUndefined();
    expect(multiParser.finish().allItems).toEqual([
      { id: 10, trans: '<m0>第一句</m0>。' },
      { id: 20, trans: '第二句' },
    ]);
  });

  it('delimiterPromptCodec.createStreamParser streams 1-item batches progressively (regression guard) and strips trailing half-typed %', () => {
    // 1-item batch: previously suppressed by `items.length <= 1` early exit
    const singleParser = delimiterPromptCodec.createStreamParser([
      { id: 7, text: 'Single tweet' },
    ]);
    expect(singleParser.push('单条')).toEqual([
      { id: 7, trans: '单条', partial: true },
    ]);
    expect(singleParser.push('推文%')).toEqual([
      { id: 7, trans: '单条推文', partial: true },
    ]);
    expect(singleParser.push('%译文')).toEqual([
      { id: 7, trans: '单条推文%%译文', partial: true },
    ]);
    const singleDone = singleParser.finish();
    expect(singleDone.newlyReady).toEqual([{ id: 7, trans: '单条推文%%译文' }]);
    expect(singleDone.newlyReady[0].partial).toBeUndefined();

    // Multi-item batch: trailing half-typed `%` stripped during partial preview, finalized on `\n\n%%\n\n`
    const multiParser = delimiterPromptCodec.createStreamParser([
      { id: 1, text: 'A' },
      { id: 2, text: 'B' },
    ]);
    expect(multiParser.push('第一段内容\n\n%')).toEqual([
      { id: 1, trans: '第一段内容', partial: true },
    ]);
    expect(multiParser.push('%\n\n第二段')).toEqual([
      { id: 1, trans: '第一段内容' },
      { id: 2, trans: '第二段', partial: true },
    ]);
    expect(multiParser.finish().newlyReady).toEqual([{ id: 2, trans: '第二段' }]);
  });

  it('singleTextMtCodec and jsonBatchCodec stream partial: true previews safely including dangling JSON escapes', () => {
    // SingleTextMtCodec: 1-item & multi-item
    const st1 = singleTextMtCodec.createStreamParser([{ id: 1, text: 'One' }]);
    expect(st1.push('正在<m0')).toEqual([
      { id: 1, trans: '正在', partial: true },
    ]);
    expect(st1.push('>翻译</m0>')).toEqual([
      { id: 1, trans: '正在<m0>翻译</m0>', partial: true },
    ]);
    expect(st1.finish().newlyReady).toEqual([
      { id: 1, trans: '正在<m0>翻译</m0>' },
    ]);

    const st2 = singleTextMtCodec.createStreamParser([
      { id: 1, text: 'One' },
      { id: 2, text: 'Two' },
    ]);
    expect(st2.push('段落一')).toEqual([
      { id: 1, trans: '段落一', partial: true },
    ]);
    expect(st2.push('\n\n段落二')).toEqual([
      { id: 1, trans: '段落一' },
      { id: 2, trans: '段落二', partial: true },
    ]);
    expect(st2.finish().newlyReady).toEqual([{ id: 2, trans: '段落二' }]);

    // JsonBatchCodec: trailing unclosed `"trans": "..."` with dangling `\` and `\u00`
    const jp = jsonBatchCodec.createStreamParser([
      { id: 101, text: 'First' },
      { id: 102, text: 'Second' },
    ]);
    expect(jp.push('[{"id":1,"trans":"你好\\')).toEqual([
      { id: 101, trans: '你好', partial: true },
    ]);
    expect(jp.push('n世界\\u00')).toEqual([
      { id: 101, trans: '你好\n世界', partial: true },
    ]);
    expect(jp.push('41"},{"id":2,"trans":"第二')).toEqual([
      { id: 101, trans: '你好\n世界A' },
      { id: 102, trans: '第二', partial: true },
    ]);
    expect(jp.push('项"}]')).toEqual([{ id: 102, trans: '第二项' }]);
    const jpDone = jp.finish();
    expect(jpDone.newlyReady).toEqual([]);
    expect(jpDone.allItems).toEqual([
      { id: 101, trans: '你好\n世界A' },
      { id: 102, trans: '第二项' },
    ]);
  });

  it('expands {{threadContext}}, {{prevContext}}, {{thread_prompt}}, and {{context_window_prompt}} and prunes cleanly with zero orphan blank lines when omitted', () => {
    const ast = BUILTIN_ASSISTANTS['builtin-yaml'];

    const withContext = expandAssistantPrompts({
      assistant: ast,
      scene: 'webpage',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Then we shipped it.' }],
      context: {
        url: 'https://x.com/dev/status/2',
        domain: 'x.com',
        threadContext: 'Margin v2.3.0 release thread',
        prevContext: 'We fixed the streaming jitter first.',
      },
    });
    expect(withContext.userPrompt).toContain(
      'Thread / Post Topic (context only — do NOT translate): Margin v2.3.0 release thread',
    );
    expect(withContext.userPrompt).toContain(
      'Preceding Context (for pronoun/tone continuity only — do NOT translate): We fixed the streaming jitter first.',
    );

    const withoutContext = expandAssistantPrompts({
      assistant: ast,
      scene: 'webpage',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Plain sentence.' }],
      context: {
        url: 'https://example.com',
        domain: 'example.com',
        threadContext: '   ',
        prevContext: '',
      },
    });
    expect(withoutContext.userPrompt).not.toContain('Thread / Post Topic');
    expect(withoutContext.userPrompt).not.toContain('Preceding Context');
    expect(withoutContext.userPrompt).not.toContain('\n\n');
    expect(withoutContext.userPrompt).toBe(
      'Translate into Simplified Chinese:\n<yaml>\n- id: 1\n  src: |-\n    Plain sentence.\n</yaml>',
    );

    // Direct {{threadContext}} / {{prevContext}} variables in custom assistant templates also prune cleanly
    const customDirect: AssistantConfig = {
      ...structuredClone(ast),
      id: 'direct-vars',
      prompt: '{{thread_prompt}}{{context_window_prompt}}Text: {{yaml}}',
      env: {
        ...ast.env,
        thread_prompt: 'Topic={{threadContext}}\n',
        context_window_prompt: 'Prev={{prevContext}}\n',
      },
    };
    const customEmpty = expandAssistantPrompts({
      assistant: customDirect,
      scene: 'webpage',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Hi' }],
    });
    expect(customEmpty.userPrompt).toBe('Text: - id: 1\n  src: |-\n    Hi');
    expect(customEmpty.userPrompt).not.toContain('Topic=');
    expect(customEmpty.userPrompt).not.toContain('Prev=');

    // Default json-batch codec (no assistant) also includes threadContext & prevContext when provided and omits when empty
    const jsonWithCtx = jsonBatchCodec.encode({
      scene: 'webpage',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Hello' }],
      context: {
        url: 'https://x.com/a/1',
        domain: 'x.com',
        threadContext: 'AI Agents thread',
        prevContext: 'Earlier tweet',
      },
    });
    expect(jsonWithCtx.userPrompt).toContain('Thread / Post Topic');
    expect(jsonWithCtx.userPrompt).toContain('AI Agents thread');
    expect(jsonWithCtx.userPrompt).toContain('Preceding Context');
    expect(jsonWithCtx.userPrompt).toContain('Earlier tweet');

    const jsonWithoutCtx = jsonBatchCodec.encode({
      scene: 'webpage',
      fromLang: 'en',
      toLang: 'zh-CN',
      items: [{ id: 1, text: 'Hello' }],
    });
    expect(jsonWithoutCtx.userPrompt).toBe('[{"id":1,"src":"Hello"}]');
  });
});
