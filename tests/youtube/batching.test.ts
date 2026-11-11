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
});
