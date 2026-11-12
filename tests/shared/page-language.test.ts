import { describe, expect, it } from 'vitest';
import { createDefaultMarginConfig } from '@shared/constants';
import {
  applySiteAutoRule,
  detectPageLanguageSample,
  evaluateAutoTranslateDecision,
  getSiteAutoRule,
} from '@shared/url-match';

describe('Page Language Detection & Foreign-Page Auto-Translate Strategy', () => {
  it('returns low confidence on short/unhydrated SPA shells (< 24 meaningful chars) after stripping URLs, @handles, #tags, and numbers', () => {
    const shell = detectPageLanguageSample({
      htmlLang: 'en',
      sampleText:
        'https://x.com/openai/status/123456 @elonmusk #AI #LLM 2026-11-12 99.5% ... Loading',
      targetLang: 'zh-CN',
    });
    expect(shell.confidence).toBe('low');
    expect(shell.reason).toBe('insufficient-sample');
  });

  it('overrides misleading <html lang="en"> on Chinese web apps when Han ideographs >= 25% and Kana < 3%', () => {
    const mislabeledChineseApp = detectPageLanguageSample({
      htmlLang: 'en',
      sampleText:
        '欢迎来到新一代 AI Agent 开发者社区，支持 GitHub Actions、Docker 与大模型推理部署指南，快速构建高性能应用。',
      targetLang: 'zh-CN',
    });
    expect(mislabeledChineseApp.detectedLang).toBe('zh');
    expect(mislabeledChineseApp.isForeignToTarget).toBe(false);
    expect(mislabeledChineseApp.confidence).toBe('high');

    // Chinese transliterated names using `・` (U+30FB middle dot) must NEVER false-positive as Japanese Kana!
    const middleDotChinese = detectPageLanguageSample({
      htmlLang: 'en',
      sampleText:
        '卡尔・马克思与弗里德里希・恩格斯在十九世纪欧洲思想史上的经典著作导读与学术评析全文索引',
      targetLang: 'zh-CN',
    });
    expect(middleDotChinese.detectedLang).toBe('zh');
    expect(middleDotChinese.isForeignToTarget).toBe(false);
  });

  it('accurately detects Japanese pages (Kanji + Hiragana/Katakana) as foreign to zh-CN', () => {
    const japaneseArticle = detectPageLanguageSample({
      htmlLang: 'ja',
      sampleText:
        '新しい大規模言語モデルの開発により、自然言語処理の精度と推論速度が飛躍的に向上しました。',
      targetLang: 'zh-CN',
    });
    expect(japaneseArticle.detectedLang).toBe('ja');
    expect(japaneseArticle.isForeignToTarget).toBe(true);
    expect(japaneseArticle.confidence).toBe('high');

    // Even if htmlLang is missing or wrong, Hiragana/Katakana >= 3 chars and >= 3% triggers `ja`
    const unlabeledJapanese = detectPageLanguageSample({
      htmlLang: 'en',
      sampleText:
        '影之刃零の最新トレーラーが公開され、高速な剣戟アクションが大きな話題を呼んでいます。',
      targetLang: 'zh-CN',
    });
    expect(unlabeledJapanese.detectedLang).toBe('ja');
    expect(unlabeledJapanese.isForeignToTarget).toBe(true);
  });

  it('detects English, European Latin, Korean, and Russian pages accurately and handles non-Chinese targetLang symmetrically', () => {
    const englishX = detectPageLanguageSample({
      htmlLang: 'en',
      sampleText:
        '@karpathy Post-training and test-time compute scaling are unlocking stronger agentic workflows across real repositories.',
      targetLang: 'zh-CN',
    });
    expect(englishX.detectedLang).toBe('en');
    expect(englishX.isForeignToTarget).toBe(true);
    expect(englishX.confidence).toBe('high');

    const frenchDoc = detectPageLanguageSample({
      htmlLang: 'fr-FR',
      sampleText:
        'Bienvenue dans la documentation technique officielle pour configurer votre environnement de développement.',
      targetLang: 'zh-CN',
    });
    expect(frenchDoc.detectedLang).toBe('fr');
    expect(frenchDoc.isForeignToTarget).toBe(true);

    const koreanPost = detectPageLanguageSample({
      sampleText:
        '인공지능 에이전트 시스템의 성능 최적화와 대규모 언어 모델 추론 가속화 가이드입니다.',
      targetLang: 'zh-CN',
    });
    expect(koreanPost.detectedLang).toBe('ko');
    expect(koreanPost.isForeignToTarget).toBe(true);

    const russianPost = detectPageLanguageSample({
      sampleText:
        'Руководство по настройке распределенных систем и оптимизации задержки сетевых запросов в продакшене.',
      targetLang: 'zh-CN',
    });
    expect(russianPost.detectedLang).toBe('ru');
    expect(russianPost.isForeignToTarget).toBe(true);

    // Symmetric check when user sets `targetLang = 'en'`:
    expect(
      detectPageLanguageSample({
        htmlLang: 'en',
        sampleText:
          'Modern browser extensions isolate styles cleanly inside Shadow DOM roots for reliable typography.',
        targetLang: 'en',
      }).isForeignToTarget,
    ).toBe(false);

    expect(
      detectPageLanguageSample({
        htmlLang: 'zh-CN',
        sampleText:
          '现代浏览器扩展通过隔离渲染树确保双语排版在复杂单页应用中始终保持干净利落。',
        targetLang: 'en',
      }).isForeignToTarget,
    ).toBe(true);
  });

  it('runs in well under 1ms per call on realistic page samples', () => {
    const sample =
      'Understanding KV Cache quantization, FlashAttention, and continuous batching in vLLM for high-throughput LLM serving on modern GPUs. '.repeat(
        15,
      );
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      detectPageLanguageSample({
        htmlLang: 'en',
        sampleText: sample,
        targetLang: 'zh-CN',
      });
    }
    const elapsedPerCallMs = (performance.now() - start) / 100;
    expect(elapsedPerCallMs).toBeLessThan(1);
  });

  it('evaluates all 6 auto-translate decision priorities including hydration recheck, linux.do exclusion, whitelist override, and language filters', () => {
    const cfg = createDefaultMarginConfig();
    const englishSample =
      'Building reliable autonomous coding agents requires crisp tool contracts, deterministic verification, and fast feedback loops.';
    const chineseSample =
      '构建稳定可靠的智能体工作流需要清晰的工具契约、确定性的测试验证以及快速的反馈闭环。';

    // 1. Manual session disable wins first
    expect(
      evaluateAutoTranslateDecision({
        url: 'https://x.com/home',
        targetLang: 'zh-CN',
        webpage: cfg.webpage,
        urlRules: cfg.urlRules,
        htmlLang: 'en',
        sampleText: englishSample,
        manuallyDisabledInSession: true,
      }),
    ).toEqual({
      shouldTranslate: false,
      needsHydrationRecheck: false,
      reason: 'manual-session-off',
    });

    // 2. Non-http(s) scheme skipped
    expect(
      evaluateAutoTranslateDecision({
        url: 'chrome://extensions/',
        targetLang: 'zh-CN',
        webpage: cfg.webpage,
        urlRules: cfg.urlRules,
        sampleText: englishSample,
      }),
    ).toEqual({
      shouldTranslate: false,
      needsHydrationRecheck: false,
      reason: 'unsupported-scheme',
    });

    // 3. Excluded URLs (`https://linux.do/*` & private LAN) skipped
    expect(
      evaluateAutoTranslateDecision({
        url: 'https://linux.do/t/topic/2910452',
        targetLang: 'zh-CN',
        webpage: cfg.webpage,
        urlRules: cfg.urlRules,
        sampleText: englishSample,
      }).reason,
    ).toBe('excluded-url');

    expect(
      evaluateAutoTranslateDecision({
        url: 'http://192.168.1.20:3000/docs',
        targetLang: 'zh-CN',
        webpage: cfg.webpage,
        urlRules: cfg.urlRules,
        sampleText: englishSample,
      }).reason,
    ).toBe('excluded-url');

    // 4. `includeMatches` whitelist works in BOTH `'whitelist'` and `'foreign'` modes (even before hydration!)
    const rulesWithInclude = {
      ...cfg.urlRules,
      includeMatches: ['*://news.ycombinator.com/*'],
    };
    expect(
      evaluateAutoTranslateDecision({
        url: 'https://news.ycombinator.com/item?id=1',
        targetLang: 'zh-CN',
        webpage: { ...cfg.webpage, autoTranslateMode: 'whitelist' },
        urlRules: rulesWithInclude,
        sampleText: 'Loading...',
      }),
    ).toEqual({
      shouldTranslate: true,
      needsHydrationRecheck: false,
      reason: 'whitelist-match',
    });

    expect(
      evaluateAutoTranslateDecision({
        url: 'https://news.ycombinator.com/item?id=1',
        targetLang: 'zh-CN',
        webpage: { ...cfg.webpage, autoTranslateMode: 'foreign' },
        urlRules: rulesWithInclude,
        sampleText: 'Loading...',
      }).reason,
    ).toBe('whitelist-match');

    // 5. `'off'` or `'whitelist'` (non-matching URL) returns `mode-disabled`
    expect(
      evaluateAutoTranslateDecision({
        url: 'https://github.com/openai/openai-node',
        targetLang: 'zh-CN',
        webpage: { ...cfg.webpage, autoTranslateMode: 'whitelist' },
        urlRules: rulesWithInclude,
        sampleText: englishSample,
      }).reason,
    ).toBe('mode-disabled');

    expect(
      evaluateAutoTranslateDecision({
        url: 'https://news.ycombinator.com/item?id=1',
        targetLang: 'zh-CN',
        webpage: { ...cfg.webpage, autoTranslateMode: 'off' },
        urlRules: rulesWithInclude,
        sampleText: englishSample,
      }).reason,
    ).toBe('mode-disabled');

    // 6a. `'foreign'` mode awaits hydration on empty SPA shell
    expect(
      evaluateAutoTranslateDecision({
        url: 'https://x.com/openai/status/1',
        targetLang: 'zh-CN',
        webpage: cfg.webpage,
        urlRules: cfg.urlRules,
        htmlLang: 'en',
        sampleText: '@openai #AI',
      }),
    ).toMatchObject({
      shouldTranslate: false,
      needsHydrationRecheck: true,
      reason: 'awaiting-content',
    });

    // 6b. `'foreign'` mode skips Chinese pages (even with `<html lang="en">`) and translates English pages
    expect(
      evaluateAutoTranslateDecision({
        url: 'https://juejin.cn/post/123',
        targetLang: 'zh-CN',
        webpage: cfg.webpage,
        urlRules: cfg.urlRules,
        htmlLang: 'en',
        sampleText: chineseSample,
      }),
    ).toMatchObject({
      shouldTranslate: false,
      needsHydrationRecheck: false,
      detectedLang: 'zh',
      reason: 'same-language',
    });

    expect(
      evaluateAutoTranslateDecision({
        url: 'https://x.com/openai/status/1',
        targetLang: 'zh-CN',
        webpage: cfg.webpage,
        urlRules: cfg.urlRules,
        htmlLang: 'en',
        sampleText: englishSample,
      }),
    ).toMatchObject({
      shouldTranslate: true,
      needsHydrationRecheck: false,
      detectedLang: 'en',
      reason: 'foreign-page',
    });

    // 6c. `autoTranslateLanguages` restricts foreign languages and allows explicit `zh-tw` opt-in
    expect(
      evaluateAutoTranslateDecision({
        url: 'https://x.com/openai/status/1',
        targetLang: 'zh-CN',
        webpage: { ...cfg.webpage, autoTranslateLanguages: ['ja'] },
        urlRules: cfg.urlRules,
        htmlLang: 'en',
        sampleText: englishSample,
      }),
    ).toMatchObject({
      shouldTranslate: false,
      reason: 'language-filtered',
    });

    expect(
      evaluateAutoTranslateDecision({
        url: 'https://example.tw/article/1',
        targetLang: 'zh-CN',
        webpage: { ...cfg.webpage, autoTranslateLanguages: ['zh-tw'] },
        urlRules: cfg.urlRules,
        htmlLang: 'zh-TW',
        sampleText:
          '臺灣半導體供應鏈與先進封裝產能在全球人工智慧伺服器市場持續擴大領先優勢。',
      }),
    ).toMatchObject({
      shouldTranslate: true,
      detectedLang: 'zh-tw',
      reason: 'foreign-page',
    });
  });

  it('manages per-site quick rules (follow / always / never) cleanly without clobbering linux.do/*', () => {
    const initialRules = createDefaultMarginConfig().urlRules;
    expect(getSiteAutoRule('https://linux.do/t/topic/1', initialRules)).toBe(
      'never',
    );
    expect(getSiteAutoRule('https://x.com/home', initialRules)).toBe('follow');

    const alwaysX = applySiteAutoRule(
      'https://x.com/home',
      'always',
      initialRules,
    );
    expect(getSiteAutoRule('https://x.com/elonmusk', alwaysX)).toBe('always');
    expect(alwaysX.includeMatches).toContain('*://x.com/*');
    expect(alwaysX.excludeMatches).toEqual(['https://linux.do/*']);

    const neverX = applySiteAutoRule('https://x.com/home', 'never', alwaysX);
    expect(getSiteAutoRule('https://x.com/elonmusk', neverX)).toBe('never');
    expect(neverX.includeMatches).toEqual([]);
    expect(neverX.excludeMatches).toEqual([
      'https://linux.do/*',
      '*://x.com/*',
    ]);

    const followX = applySiteAutoRule('https://x.com/home', 'follow', neverX);
    expect(getSiteAutoRule('https://x.com/elonmusk', followX)).toBe('follow');
    expect(followX.includeMatches).toEqual([]);
    expect(followX.excludeMatches).toEqual(['https://linux.do/*']);
  });
});
