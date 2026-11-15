import { describe, expect, it } from 'vitest';
import { createDefaultMarginConfig } from '@shared/constants';
import type {
  DiagnosticSnapshot,
  SubtitleCue,
  TranslateBatchRequest,
  TranslateBatchResponse,
} from '@shared/types';
import {
  applySubtitleBatchResponse,
  buildSubtitleBatchRequest,
  DEFAULT_SUBTITLE_BATCH_COUNT,
  resolveSubtitleBatchLimits,
  resolveSubtitleLimitsFromConfig,
  SUBTITLE_ANTI_SPILLOVER_STYLE_GUIDE,
  SubtitleBatchScheduler,
} from '../../src/youtube/batching';

function makeMockDiagnostic(): DiagnosticSnapshot {
  return {
    schemaVersion: 1,
    product: 'Margin',
    version: '2.0.0',
    time: new Date().toISOString(),
    scene: 'subtitle',
    codec: 'yaml',
    provider: {
      id: 'openai-bytb6BIB',
      preset: 'openai',
      protocol: 'openai-chat',
      endpointOrigin: 'https://api.openai.com',
      endpointPath: '/v1/chat/completions',
      model: 'gpt-6-luna',
    },
    parameters: {
      temperatureTrace: 'omitted-reasoning-guard',
      thinkingMode: 'provider-default',
      stream: false,
    },
    httpStatus: 200,
    kind: 'ok',
    retryable: false,
    attempts: 1,
    latencyMs: 120,
  };
}

describe('P0-2 independent subtitle batching & id anti-spillover lock', () => {
  it('resolves subtitle batch limit (default 17) completely independent of webpage batching', () => {
    expect(resolveSubtitleBatchLimits()).toEqual({
      maxBatchCount: DEFAULT_SUBTITLE_BATCH_COUNT,
      maxCharsPerBatch: 4096,
    });

    // Webpage maxBatchCount (4) never overrides subtitle batching (17)
    const cfg = createDefaultMarginConfig();
    cfg.providers['openai-bytb6BIB'] = {
      ...cfg.providers['google-free'],
      id: 'openai-bytb6BIB',
      preset: 'openai',
      protocol: 'openai-chat',
      model: 'gpt-6-luna',
      assistantId: 'custom',
      maxBatchCount: 4,
      maxSubtitleBatchCount: 12,
    };
    cfg.assistants['custom'] = {
      ...cfg.assistants['builtin-yaml'],
      id: 'custom',
      maxBatchCount: 4,
      maxSubtitleBatchCount: 17,
      maxCharsPerBatch: 4096,
    };
    cfg.routing.webpage = 'openai-bytb6BIB';
    cfg.routing.subtitle = 'inherit';

    const resolved = resolveSubtitleLimitsFromConfig(cfg);
    expect(resolved).toEqual({
      providerId: 'openai-bytb6BIB',
      maxBatchCount: 17,
      maxCharsPerBatch: 4096,
    });

    // Safely normalizes float strings & invalid non-positive values
    expect(
      resolveSubtitleBatchLimits({
        assistant: { maxSubtitleBatchCount: 0 as number },
        provider: { maxSubtitleBatchCount: '5.9' as unknown as number },
      }).maxBatchCount,
    ).toBe(5);

    expect(
      resolveSubtitleBatchLimits({
        assistant: { maxSubtitleBatchCount: -3 },
        provider: { maxSubtitleBatchCount: Number.NaN },
      }).maxBatchCount,
    ).toBe(17);
  });

  it('locks cue boundaries strictly by numeric id even when LLM returns out-of-order or partial items', () => {
    const cues: SubtitleCue[] = [
      { tStartMs: 1000, dDurationMs: 2000, text: 'Cue one' },
      { tStartMs: 3000, dDurationMs: 2000, text: 'Cue two' },
      { tStartMs: 5000, dDurationMs: 2000, text: 'Cue three' },
      { tStartMs: 7000, dDurationMs: 2000, text: 'Cue four' },
    ];

    const built = buildSubtitleBatchRequest({
      entries: cues.map((cue, cueIndex) => ({ cueIndex, cue })),
      fromLang: 'en',
      toLang: 'zh-CN',
      providerId: 'openai-bytb6BIB',
      pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      videoTitle: 'Demo Lecture',
    });

    expect(built.request.scene).toBe('subtitle');
    expect(built.request.items.map((i) => i.id)).toEqual([1, 2, 3, 4]);
    expect(built.request.context?.styleGuide).toBe(
      SUBTITLE_ANTI_SPILLOVER_STYLE_GUIDE,
    );

    // Out-of-order response with missing id=2 and hallucinated id=99
    const updated = applySubtitleBatchResponse(
      cues,
      {
        ok: true,
        items: [
          { id: 4, trans: '第四条字幕' },
          { id: 99, trans: '幻觉条目' },
          { id: 1, trans: '第一条字幕\n换行清洗' },
          { id: 3, trans: '第三条字幕' },
        ],
      },
      built.idToCueIndex,
    );

    expect(updated.sort((a, b) => a - b)).toEqual([0, 2, 3]);
    expect(cues.map((c) => c.trans)).toEqual([
      '第一条字幕 换行清洗',
      undefined, // id=2 missing -> stays undefined, NEVER shifts id=3 into slot 2!
      '第三条字幕',
      '第四条字幕',
    ]);
  });

  it('strips LLM-echoed subtitle markup (<b>, <font>, <br>, ASS) in applySubtitleBatchResponse while preserving code angle brackets', () => {
    const cues: SubtitleCue[] = [
      { tStartMs: 0, dDurationMs: 2000, text: 'We were wrong, not a little' },
      { tStartMs: 2000, dDurationMs: 2000, text: 'Hello World' },
      { tStartMs: 4000, dDurationMs: 2000, text: 'vector<int> && a < b && c > d' },
      { tStartMs: 6000, dDurationMs: 2000, text: 'Untouched when tag-only' },
    ];

    const idToCueIndex = new Map<number, number>([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
    ]);

    const updated = applySubtitleBatchResponse(
      cues,
      {
        ok: true,
        items: [
          { id: 1, trans: '<b>结果我们错了，而且错得</b>' },
          { id: 2, trans: '{\\an8}<font color="#ff0">你好</font><br>世界' },
          { id: 3, trans: '<i>使用</i> vector<int> 且满足 a < b && c > d' },
          { id: 4, trans: '<b>   </b>' },
        ],
      },
      idToCueIndex,
    );

    expect(updated).toEqual([0, 1, 2]);
    expect(cues.map((c) => c.trans)).toEqual([
      '结果我们错了，而且错得',
      '你好 世界',
      '使用 vector<int> 且满足 a < b && c > d',
      undefined,
    ]);
  });
});

describe('SubtitleBatchScheduler playhead priority & navigation cancellation', () => {
  it('dispatches [currentTime - 2s, currentTime + 35s] immediately on seek ahead of background lookahead', async () => {
    // 30 cues spaced 10s apart: 0s, 10s, ..., 290s
    const cues: SubtitleCue[] = Array.from({ length: 30 }, (_, idx) => ({
      tStartMs: idx * 10_000,
      dDurationMs: 4_000,
      text: `Line ${idx}`,
    }));

    const dispatchedFirstTexts: string[] = [];
    const deferredResolvers: Array<() => void> = [];

    const scheduler = new SubtitleBatchScheduler({
      maxImmediateConcurrency: 2,
      translateBatch: (req: TranslateBatchRequest) => {
        dispatchedFirstTexts.push(req.items[0]?.text ?? '');
        return new Promise<TranslateBatchResponse>((resolve) => {
          deferredResolvers.push(() => {
            resolve({
              ok: true,
              requestId: req.requestId,
              providerId: 'openai-bytb6BIB',
              model: 'gpt-6-luna',
              items: req.items.map((item) => ({
                id: item.id,
                trans: `译:${item.text}`,
              })),
              diagnostic: makeMockDiagnostic(),
            });
          });
        });
      },
    });

    scheduler.configure({
      fromLang: 'en',
      toLang: 'zh-CN',
      preTranslate: true,
      maxBatchCount: 5,
      maxCharsPerBatch: 4096,
    });

    // 1. Start at 0ms -> Immediate window [0, 35_000] covers cues 0..3 ("Line 0".."Line 3")
    scheduler.loadCues('video-alpha', cues, 0);
    expect(dispatchedFirstTexts).toEqual(['Line 0']);

    // Resolve initial immediate batch -> triggers 1st sequential lookahead batch starting at 40s ("Line 4")
    deferredResolvers.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchedFirstTexts).toEqual(['Line 0', 'Line 4']);

    // 2. While "Line 4" lookahead is still in-flight, user seeks to 200_000ms (200s -> "Line 20")!
    scheduler.updatePlayhead(200_000);

    // Immediate seek window [198s, 235s] ("Line 20".."Line 23") is dispatched RIGHT AWAY without waiting!
    expect(dispatchedFirstTexts).toEqual(['Line 0', 'Line 4', 'Line 20']);

    // Drain remaining batches and verify lookahead continues from >235s ("Line 24") before wrapping back
    while (deferredResolvers.length > 0) {
      deferredResolvers.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await scheduler.waitForIdle();

    expect(dispatchedFirstTexts[3]).toBe('Line 24');
    expect(scheduler.getCues()[20]?.trans).toBe('译:Line 20');
    expect(scheduler.getCues().every((c) => c.trans?.startsWith('译:'))).toBe(
      true,
    );
  });

  it('cancels stale in-flight requests on video navigation so old translations never leak', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveStale!: (res: TranslateBatchResponse) => void;

    const scheduler = new SubtitleBatchScheduler({
      translateBatch: (req, signal) => {
        capturedSignal = signal;
        return new Promise<TranslateBatchResponse>((resolve) => {
          resolveStale = (res) => resolve(res);
          void req;
        });
      },
    });

    scheduler.loadCues(
      'old-video',
      [{ tStartMs: 0, dDurationMs: 2000, text: 'Old video cue' }],
      0,
    );
    expect(capturedSignal?.aborted).toBe(false);

    // Navigate to new video (empty track initially)
    scheduler.cancelAll();
    expect(capturedSignal?.aborted).toBe(true);

    // Late resolution from old video is ignored safely
    resolveStale({
      ok: true,
      requestId: 'stale',
      providerId: 'openai-bytb6BIB',
      model: 'gpt-6-luna',
      items: [{ id: 1, trans: '旧视频译文' }],
      diagnostic: makeMockDiagnostic(),
    });
    await Promise.resolve();

    expect(scheduler.getCues()[0]?.trans).toBeUndefined();
  });

  it('retries failed cues on explicit seek and cancelAll up to bounded maxCueRetries without spinning on linear ticks (Finding #14)', async () => {
    let attempts = 0;
    let shouldFail = true;

    const scheduler = new SubtitleBatchScheduler({
      maxCueRetries: 2,
      translateBatch: async (req) => {
        attempts += 1;
        if (shouldFail) {
          throw new Error('Transient network error');
        }
        return {
          ok: true,
          requestId: req.requestId,
          providerId: 'openai-bytb6BIB',
          model: 'gpt-6-luna',
          items: req.items.map((item) => ({ id: item.id, trans: `恢复:${item.text}` })),
          diagnostic: makeMockDiagnostic(),
        };
      },
    });

    // 1. Initial load fails -> attempt #1
    scheduler.loadCues(
      'retry-video',
      [{ tStartMs: 0, dDurationMs: 5000, text: 'Hello retry' }],
      100,
    );
    await scheduler.waitForIdle();
    expect(attempts).toBe(1);
    expect(scheduler.getCues()[0]?.trans).toBeUndefined();

    // Linear playback tick (+250ms < 1500ms) does NOT burn retry budget
    scheduler.updatePlayhead(350);
    await scheduler.waitForIdle();
    expect(attempts).toBe(1);

    // 2. Explicit seek (+2000ms >= 1500ms) retries -> attempt #2 (retry #1, still failing)
    scheduler.updatePlayhead(2500);
    await scheduler.waitForIdle();
    expect(attempts).toBe(2);

    // 3. Disable/re-enable via cancelAll() + updatePlayhead retries -> attempt #3 (retry #2, still failing)
    scheduler.cancelAll();
    scheduler.updatePlayhead(2600);
    await scheduler.waitForIdle();
    expect(attempts).toBe(3);

    // 4. Retry cap (maxCueRetries=2 -> 3 total attempts) reached -> further seeks/cancelAll do NOT spin!
    shouldFail = false;
    scheduler.updatePlayhead(0);
    await scheduler.waitForIdle();
    expect(attempts).toBe(3);
    expect(scheduler.getCues()[0]?.trans).toBeUndefined();

    // 5. Fresh track load resets failure counter and recovers on explicit backward seek after 1 blip
    attempts = 0;
    shouldFail = true;
    scheduler.loadCues(
      'retry-video-2',
      [{ tStartMs: 0, dDurationMs: 5000, text: 'Recover cue' }],
      2000,
    );
    await scheduler.waitForIdle();
    expect(attempts).toBe(1);

    shouldFail = false;
    scheduler.updatePlayhead(500); // backward seek -> retries and succeeds!
    await scheduler.waitForIdle();
    expect(attempts).toBe(2);
    expect(scheduler.getCues()[0]?.trans).toBe('恢复:Recover cue');
  });
});
