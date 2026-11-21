import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECENT_PREFIX_CAPACITY,
  DEFAULT_RECENT_PREFIX_TTL_MS,
  RecentPrefixStore,
  classifySourceChange,
  isBoundarySegmentExpansion,
  normalizePlainForPrefix,
} from '../../src/content/expansion';

describe('expansion: prefix normalization, Show more source classification & RecentPrefixStore', () => {
  it('normalizes plain text by stripping residual <mN> markers, NFKC-folding, and collapsing whitespace', () => {
    expect(
      normalizePlainForPrefix('  Hello  <m0>@AnthropicAI</m0>\n\nworld <m1/>  '),
    ).toBe('Hello @AnthropicAI world');
    expect(normalizePlainForPrefix('Ｆｕｌｌｗｉｄｔｈ\t\ttext…')).toBe(
      'Fullwidth text...',
    );
  });

  it('classifies Unicode ellipsis, ASCII three-dots, half-word cuts, and truncated URLs as expansion', () => {
    // 1. Unicode ellipsis (…)
    expect(
      classifySourceChange(
        'We partnered with @AnthropicAI to benchmark progressive multi-paragraph streaming…',
        'We partnered with @AnthropicAI to benchmark progressive multi-paragraph streaming across 12,000-char essays on X.',
      ),
    ).toBe('expansion');

    // 2. ASCII three dots (...)
    expect(
      classifySourceChange(
        'Distributed consensus systems require strict safety invariants before...',
        'Distributed consensus systems require strict safety invariants before leader election can proceed.',
      ),
    ).toBe('expansion');

    // 3. Mid-word / half-word truncation without ellipsis (within 16-char tail slack)
    expect(
      classifySourceChange(
        'Modern browser extensions isolate host React fibers from reparent',
        'Modern browser extensions isolate host React fibers from reparenting mutations during target-only rendering.',
      ),
    ).toBe('expansion');

    // 4. Truncated URL tail replaced on expansion (within 16-char tail slack)
    expect(
      classifySourceChange(
        'Read the full engineering breakdown and benchmark suite at https://t.co/ab…',
        'Read the full engineering breakdown and benchmark suite at https://margin.dev/blog/x-show-more — zero flicker!',
      ),
    ).toBe('expansion');

    // 5. Identical plain text (even when rich <mN> tags differ) -> 'same'
    expect(
      classifySourceChange(
        'Follow @AnthropicAI for research updates.',
        'Follow <m0>@AnthropicAI</m0>   for\nresearch updates.',
      ),
    ).toBe('same');
  });

  it('classifies shrinks, short prefixes (< 24 chars), and recycled unrelated text as unrelated', () => {
    // 1. Shrink (including shrink with altered trailing punctuation — e.g. Show less or edit)
    expect(
      classifySourceChange(
        'This is a long expanded post with sixty characters of detailed prose.',
        'This is a long expanded post with sixty characters!',
      ),
    ).toBe('unrelated');

    expect(
      classifySourceChange(
        'This is a long expanded post with sixty characters of detailed prose.',
        'This is a long expanded post with sixty…',
      ),
    ).toBe('unrelated');

    // 2. Short shared prefix (< 24 chars)
    expect(
      classifySourceChange(
        'Breaking news today: alpha',
        'Breaking news today: completely different story in recycled cell.',
      ),
    ).toBe('unrelated');

    // 3. Unrelated virtual-scroll cell recycle
    expect(
      classifySourceChange(
        'First author discussing Rust async traits and zero-cost futures in production.',
        'Second author sharing photos from Kyoto autumn foliage trip this weekend.',
      ),
    ).toBe('unrelated');

    // 4. Empty inputs
    expect(classifySourceChange('', 'Some non-empty text that is quite long.')).toBe(
      'unrelated',
    );
    expect(classifySourceChange('Some non-empty text that is quite long.', '')).toBe(
      'unrelated',
    );
  });

  it('supports short boundary-paragraph cuts (< 24 chars) via isBoundarySegmentExpansion while rejecting shrinks', () => {
    expect(
      isBoundarySegmentExpansion(
        'In summary…',
        'In summary, dense per-segment renumbering keeps every paragraph cache key position-independent.',
      ),
    ).toBe(true);

    expect(
      isBoundarySegmentExpansion(
        'In summary, dense per-segment renumbering.',
        'In summary!',
      ),
    ).toBe(false);
  });

  it('enforces LRU capacity (default 64), 10-min TTL, configSig invalidation, clear(), and same-bucket collision disambiguation in RecentPrefixStore', () => {
    expect(DEFAULT_RECENT_PREFIX_CAPACITY).toBe(64);
    expect(DEFAULT_RECENT_PREFIX_TTL_MS).toBe(600_000);

    let fakeNow = 1_000_000;
    const store = new RecentPrefixStore({
      capacity: 3,
      ttlMs: 600_000,
      now: () => fakeNow,
    });

    const pA =
      'Alpha release announcement: we just shipped zero-flicker expansion…';
    const pB =
      'Bravo release announcement: streaming progressive batches saturate…';
    const pC =
      'Charlie release announcement: cross-route carryover pins boundary…';
    const pD =
      'Delta release announcement: React Fiber children stay untouched…';

    store.record({
      configSig: 'sig-v1',
      blockPlain: pA,
      lastSegPlain: pA,
      lastSegSourceText: `<m0>${pA}</m0>`,
      lastSegTranslated: '<m0>Alpha 预览译文……</m0>',
      at: fakeNow,
    });
    fakeNow += 1000;
    store.record({
      configSig: 'sig-v1',
      blockPlain: pB,
      lastSegPlain: pB,
      lastSegSourceText: pB,
      lastSegTranslated: 'Bravo 预览译文……',
      at: fakeNow,
    });
    fakeNow += 1000;
    store.record({
      configSig: 'sig-v1',
      blockPlain: pC,
      lastSegPlain: pC,
      lastSegSourceText: pC,
      lastSegTranslated: 'Charlie 预览译文……',
      at: fakeNow,
    });
    expect(store.size).toBe(3);

    // Match `pA` -> refreshes `pA` as most-recently-used so `pB` becomes LRU victim!
    const hitA = store.match(
      'Alpha release announcement: we just shipped zero-flicker expansion for long-form essays on X!',
      'sig-v1',
    );
    expect(hitA?.lastSegTranslated).toBe('<m0>Alpha 预览译文……</m0>');

    // Insert `pD` (4th entry in capacity=3 store) -> evicts `pB`, keeps `pA` and `pC`
    fakeNow += 1000;
    store.record({
      configSig: 'sig-v1',
      blockPlain: pD,
      lastSegPlain: pD,
      lastSegSourceText: pD,
      lastSegTranslated: 'Delta 预览译文……',
      at: fakeNow,
    });
    expect(store.size).toBe(3);
    expect(
      store.match(
        'Bravo release announcement: streaming progressive batches saturate four parallel connections.',
        'sig-v1',
      ),
    ).toBeNull();
    expect(
      store.match(
        'Alpha release announcement: we just shipped zero-flicker expansion for long-form essays on X!',
        'sig-v1',
      )?.lastSegTranslated,
    ).toBe('<m0>Alpha 预览译文……</m0>');

    // Same-bucket prefix collision (> 24 shared leading chars) disambiguates by exact expansion LCP
    const sharedHead1 =
      '[Engineering Thread 2026] Part 1 covers memory safety in Rust kernels…';
    const sharedHead2 =
      '[Engineering Thread 2026] Part 2 covers eBPF packet scheduling latency…';
    store.clear();
    expect(store.size).toBe(0);

    store.record({
      configSig: 'sig-v1',
      blockPlain: sharedHead1,
      lastSegPlain: sharedHead1,
      lastSegSourceText: sharedHead1,
      lastSegTranslated: '第一部分内核内存安全……',
      at: fakeNow,
    });
    store.record({
      configSig: 'sig-v1',
      blockPlain: sharedHead2,
      lastSegPlain: sharedHead2,
      lastSegSourceText: sharedHead2,
      lastSegTranslated: '第二部分 eBPF 调度延迟……',
      at: fakeNow,
    });

    expect(
      store.match(
        '[Engineering Thread 2026] Part 2 covers eBPF packet scheduling latency under 100Gbps load.',
        'sig-v1',
      )?.lastSegTranslated,
    ).toBe('第二部分 eBPF 调度延迟……');

    // Advance past 10-min TTL (600,001ms) -> entries expire cleanly
    fakeNow += 600_001;
    expect(
      store.match(
        '[Engineering Thread 2026] Part 2 covers eBPF packet scheduling latency under 100Gbps load.',
        'sig-v1',
      ),
    ).toBeNull();
    expect(store.size).toBe(0);

    // Signature mismatch invalidates store immediately
    store.record({
      configSig: 'sig-v1',
      blockPlain: pA,
      lastSegPlain: pA,
      lastSegSourceText: pA,
      lastSegTranslated: 'Alpha 预览译文……',
      at: fakeNow,
    });
    expect(store.size).toBe(1);
    expect(
      store.match(
        'Alpha release announcement: we just shipped zero-flicker expansion for long-form essays on X!',
        'sig-v2-changed-lang',
      ),
    ).toBeNull();
    expect(store.size).toBe(0);
  });
});
