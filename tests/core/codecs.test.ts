import { describe, expect, it } from 'vitest';
import {
  delimiterPromptCodec,
  jsonBatchCodec,
  singleTextMtCodec,
  yamlPromptCodec,
} from '../../src/core/prompts';
import { BUILTIN_ASSISTANTS } from '@shared/constants';
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
    expect(parser.push('</think>\n<yaml>\n- id: 1\n  trans: 你好\n')).toEqual([]);
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
    expect(parser.push('</think>段落一译文')).toEqual([]);

    // First delimiter completed -> item 1 emits immediately!
    expect(parser.push('\n\n%%\n\n段落二')).toEqual([
      { id: 1, trans: '段落一译文' },
    ]);

    // Second delimiter completed -> item 2 emits immediately!
    expect(parser.push('完整译文\n%%\n段落三开始')).toEqual([
      { id: 2, trans: '段落二完整译文' },
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
});
