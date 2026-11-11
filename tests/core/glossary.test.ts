import { describe, expect, it } from 'vitest';
import {
  buildGlossaryPromptVars,
  matchGlossaryEntries,
  protectGlossaryTokens,
  resolveGlossaryTarget,
  restoreGlossaryTokens,
} from '../../src/core/prompts';
import type { GlossaryEntry } from '@shared/types';

describe('Glossary Matcher, Keep-Original (v: "") & Non-AI Placeholder Engine', () => {
  const userGlossary: GlossaryEntry[] = [
    { k: 'LLM', v: '' },
    { k: 'LLMs', v: '' },
    { k: '大模型', v: 'Large Model' },
    { k: 'Artifact', v: '构建产物', domain: '*.github.com' },
    { k: 'm1', v: 'SHOULD_NEVER_TOUCH_RICH_TAG' },
  ];

  it('resolves empty v: "" to preserve source k verbatim (LLM -> LLM, LLMs -> LLMs)', () => {
    expect(resolveGlossaryTarget({ k: 'LLM', v: '' })).toBe('LLM');
    expect(resolveGlossaryTarget({ k: 'LLMs', v: '   ' })).toBe('LLMs');
    expect(resolveGlossaryTarget({ k: 'Transformer', v: '变换器' })).toBe(
      '变换器',
    );
  });

  it('matches longest-key-first with ASCII word boundaries and CJK substring matching', () => {
    // Only `LLMs` appears -> `LLMs` claims span first, so `LLM` is NOT falsely matched inside `LLMs`!
    const pluralOnly = matchGlossaryEntries(
      ['Modern LLMs outperform older ALLMIGHTY systems.'],
      userGlossary,
    );
    expect(pluralOnly.map((m) => m.key)).toEqual(['LLMs']);

    // Both `LLMs` and `LLM` (even adjacent to CJK) + CJK substring `"大模型"` match!
    const mixed = matchGlossaryEntries(
      ['基于LLM的应用与开源大模型正在推动LLMs普及。'],
      userGlossary,
    );
    expect(mixed.map((m) => [m.key, m.target])).toEqual([
      ['LLMs', 'LLMs'],
      ['LLM', 'LLM'],
      ['大模型', 'Large Model'],
    ]);
  });

  it('filters domain-scoped terms and separates imt_terms_with_domain vs without_domain', () => {
    const nonMatchingSite = buildGlossaryPromptVars(
      ['Download the Artifact for this LLM.'],
      userGlossary,
      'https://news.ycombinator.com/item?id=1',
    );
    expect(nonMatchingSite.imt_terms).toBe("'LLM': 'LLM'");
    expect(nonMatchingSite.imt_terms_with_domain).toBe('');

    const matchingSite = buildGlossaryPromptVars(
      ['Download the Artifact for this LLM.'],
      userGlossary,
      'https://actions.github.com/workflows',
    );
    expect(matchingSite.imt_terms).toBe(
      "'Artifact': '构建产物', 'LLM': 'LLM'",
    );
    expect(matchingSite.imt_terms_with_domain).toBe("'Artifact': '构建产物'");
    expect(matchingSite.imt_terms_without_domain).toBe("'LLM': 'LLM'");
  });

  it('protects non-AI MT tokens as <m-g id="0"/> without corrupting <m1> rich tags, and restores tolerantly', () => {
    const batch = [
      'Click <m1>LLMs</m1> to learn how an LLM works.',
      'Another LLM example.',
    ];

    const { texts, placeholderMap } = protectGlossaryTokens(batch, userGlossary);

    // `<m1>` tag is untouched even though `{ k: "m1" }` is in glossary!
    expect(texts[0]).toBe(
      'Click <m1><m-g id="0"/></m1> to learn how an <m-g id="1"/> works.',
    );
    expect(texts[1]).toBe('Another <m-g id="1"/> example.');

    // Simulate DeepLX / Google Web mutating tag spacing & case
    const mtTranslated0 =
      '点击 <m1><m-g id="0"/></m1> 了解 <M-G id = "1" /> 的工作原理。';
    const mtTranslated1 = '另一个 ＜m-g id="1"/＞ 示例。';

    expect(restoreGlossaryTokens(mtTranslated0, placeholderMap)).toBe(
      '点击 <m1>LLMs</m1> 了解 LLM 的工作原理。',
    );
    expect(restoreGlossaryTokens(mtTranslated1, placeholderMap)).toBe(
      '另一个 LLM 示例。',
    );
  });
});
