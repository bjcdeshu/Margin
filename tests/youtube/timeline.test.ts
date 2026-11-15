import { describe, expect, it } from 'vitest';
import type { SubtitleCue, YoutubeRawJson3Event } from '@shared/types';
import {
  alignSubtitleTranslation,
  extractTextTrackCues,
  findActiveCueIndex,
  mergeAlignedSubtitleTrack,
  normalizeYoutubeEvents,
  parseWebVtt,
  parseWebVttTimestamp,
  parseYoutubeTimedTextPayload,
  stripVttMarkup,
} from '../../src/youtube/timeline';

/**
 * Clean-room replica of `abnormal-events.json` fixture cases:
 * - Zero-duration initial cue + rolling `aAppend: 1` suffix cue on `wWinId: 1`
 * - Overlapping 5000ms duration cue trimmed to distanceToNext (1000ms)
 * - Duplicate `(tStartMs, text)` cues keeping Math.max(0, 100) = 100ms
 * - Negative `tStartMs: -10` cue discarded
 */
const ABNORMAL_EVENTS_FIXTURE: { events: YoutubeRawJson3Event[] } = {
  events: [
    {
      tStartMs: 0,
      dDurationMs: 0,
      wWinId: 1,
      segs: [{ utf8: 'Hello' }],
    },
    {
      tStartMs: 400,
      dDurationMs: 600,
      wWinId: 1,
      aAppend: 1,
      segs: [{ utf8: ' world' }],
    },
    {
      tStartMs: 1000,
      dDurationMs: 5000,
      segs: [{ utf8: 'Second cue' }],
    },
    {
      tStartMs: 2000,
      segs: [{ utf8: 'Third cue' }],
    },
    {
      tStartMs: 2000,
      dDurationMs: 100,
      segs: [{ utf8: 'Third cue' }],
    },
    {
      tStartMs: -10,
      dDurationMs: 1000,
      segs: [{ utf8: 'Invalid' }],
    },
  ],
};

describe('YouTube JSON3 6-step timeline sanitizer (P0-3)', () => {
  it('repairs abnormal-events fixture preserving zero-duration & append cues', () => {
    const normalized = normalizeYoutubeEvents(ABNORMAL_EVENTS_FIXTURE);

    expect(normalized).toHaveLength(3);
    expect(normalized[0]).toMatchObject({
      tStartMs: 0,
      dDurationMs: 1000,
      text: 'Hello world',
      wWinId: 1,
    });
    expect(normalized[1]).toMatchObject({
      tStartMs: 1000,
      dDurationMs: 1000,
      text: 'Second cue',
    });
    expect(normalized[2]).toMatchObject({
      tStartMs: 2000,
      dDurationMs: 100,
      text: 'Third cue',
    });
    expect(normalized.every((cue) => cue.dDurationMs >= 100)).toBe(true);
  });

  it('handles rolling aAppend=1 prefix-extension, suffix concat, and 5000ms proximity window', () => {
    const cues = normalizeYoutubeEvents([
      { tStartMs: 1000, dDurationMs: 800, segs: [{ utf8: 'Machine' }] },
      // Prefix-extension replacement within 5000ms proximity (no wWinId needed)
      {
        tStartMs: 1500,
        dDurationMs: 900,
        aAppend: 1,
        segs: [{ utf8: 'Machine learning' }],
      },
      // Suffix concatenation on same rolling cue
      {
        tStartMs: 2100,
        dDurationMs: 900,
        aAppend: 1,
        segs: [{ utf8: ' rocks' }],
      },
      // Far away (> 1000 + 5000 = 6000ms) with different wWinId -> starts a new cue!
      {
        tStartMs: 9500,
        dDurationMs: 0,
        wWinId: 9,
        aAppend: 1,
        segs: [{ utf8: 'Standalone tail' }],
      },
    ]);

    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({
      tStartMs: 1000,
      dDurationMs: 2000, // 2100 + 900 - 1000 = 2000
      text: 'Machine learning rocks',
    });
    expect(cues[1]).toEqual({
      tStartMs: 9500,
      dDurationMs: 3000, // 3000ms tail fallback
      text: 'Standalone tail',
      wWinId: 9,
    });
  });

  it('normalizes CRLF/LF newlines, drops whitespace-only cues, and clamps durations to [100ms, 30000ms]', () => {
    const normalized = normalizeYoutubeEvents([
      { tStartMs: 0, dDurationMs: 999_999, text: 'Line one\r\nLine two\nLine three' },
      { tStartMs: 40_000, dDurationMs: 0, segs: [{ utf8: '   \n\t  ' }] },
      { tStartMs: 45_000, dDurationMs: 15, segs: [{ utf8: 'Tiny duration' }] },
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toEqual({
      tStartMs: 0,
      dDurationMs: 30_000,
      text: 'Line one Line two Line three',
    });
    expect(normalized[1]).toEqual({
      tStartMs: 45_000,
      dDurationMs: 100,
      text: 'Tiny duration',
    });
  });
});

describe('Monotonic ±1000ms subtitle timestamp aligner', () => {
  it('matches nearest translated cues within ±1000ms and consumes each translated cue at most once', () => {
    const source: SubtitleCue[] = [
      { tStartMs: 1000, dDurationMs: 1500, text: 'First' },
      { tStartMs: 1400, dDurationMs: 1500, text: 'Second close' },
      { tStartMs: 5000, dDurationMs: 1500, text: 'Third unmatched' },
      { tStartMs: 9000, dDurationMs: 1500, text: 'Fourth' },
    ];
    const translated: SubtitleCue[] = [
      { tStartMs: 1250, dDurationMs: 1500, text: '第一句' }, // closer to 1000, consumed once!
      { tStartMs: 6500, dDurationMs: 1500, text: '超出容差' }, // +1500ms from 5000 -> outside ±1000ms
      { tStartMs: 8800, dDurationMs: 1500, text: '第四句' },
      { tStartMs: 8950, dDurationMs: 1500, text: '更近的第四句' }, // 50ms < 200ms -> picked!
    ];

    const aligned = alignSubtitleTranslation(source, translated, 1000);
    expect(aligned).toEqual(['第一句', '', '', '更近的第四句']);
  });

  it('applies aligned track translations only when match ratio >= 0.6', () => {
    const source: SubtitleCue[] = [
      { tStartMs: 0, dDurationMs: 1000, text: 'One' },
      { tStartMs: 2000, dDurationMs: 1000, text: 'Two' },
      { tStartMs: 4000, dDurationMs: 1000, text: 'Three' },
      { tStartMs: 6000, dDurationMs: 1000, text: 'Four' },
      { tStartMs: 8000, dDurationMs: 1000, text: 'Five' },
    ];

    // 3 / 5 = 0.6 -> applied!
    const goodTrans: SubtitleCue[] = [
      { tStartMs: 200, dDurationMs: 1000, text: '一' },
      { tStartMs: 2100, dDurationMs: 1000, text: '二' },
      { tStartMs: 8400, dDurationMs: 1000, text: '五' },
    ];
    const appliedResult = mergeAlignedSubtitleTrack(source, goodTrans);
    expect(appliedResult.applied).toBe(true);
    expect(appliedResult.matchRatio).toBeCloseTo(0.6);
    expect(appliedResult.cues.map((c) => c.trans ?? '')).toEqual([
      '一',
      '二',
      '',
      '',
      '五',
    ]);

    // 2 / 5 = 0.4 < 0.6 -> rejected!
    const sparseResult = mergeAlignedSubtitleTrack(source, goodTrans.slice(0, 2));
    expect(sparseResult.applied).toBe(false);
    expect(sparseResult.matchRatio).toBeCloseTo(0.4);
    expect(sparseResult.cues.every((c) => c.trans === undefined)).toBe(true);
  });
});

describe('WebVTT, TextTrack, TimedText XML & active cue binary search', () => {
  it('parses WebVTT timestamps, strips inline VTT/ruby tags, and ignores NOTE/STYLE blocks', () => {
    expect(parseWebVttTimestamp('01:02:03.450')).toBe(3_723_450);
    expect(parseWebVttTimestamp('02:05.90')).toBe(125_900);

    const sampleVtt = `WEBVTT

STYLE
::cue { color: yellow; }

NOTE Commentary block

1
00:00.500 --> 00:03.000 align:start position:10%
<v Host><c.yellow>Welcome</c> to <b>Margin</b> &amp; AI!</v>

cue-2
00:02.000 --> 00:04.500
<ruby>漢字<rt>かんじ</rt></ruby> <00:02.500>subtitle
`;

    const cues = parseWebVtt(sampleVtt);
    expect(cues).toHaveLength(2);
    // First cue overlapped cue-2 at 2000ms -> trimmed from 2500ms to 1500ms
    expect(cues[0]).toEqual({
      tStartMs: 500,
      dDurationMs: 1500,
      text: 'Welcome to Margin & AI!',
    });
    expect(cues[1]).toEqual({
      tStartMs: 2000,
      dDurationMs: 2500,
      text: '漢字 subtitle',
    });
  });

  it('extracts cues from HTML5 TextTrackCueList and locates active cues via binary search', () => {
    const trackCues = extractTextTrackCues([
      { startTime: 1.2, endTime: 3.4, text: '<i>First</i> HTML5 cue' },
      { startTime: 4.0, endTime: 6.5, text: 'Second HTML5 cue' },
    ]);

    expect(trackCues).toEqual([
      { tStartMs: 1200, dDurationMs: 2200, text: 'First HTML5 cue' },
      { tStartMs: 4000, dDurationMs: 2500, text: 'Second HTML5 cue' },
    ]);

    expect(findActiveCueIndex(trackCues, 500)).toBe(-1);
    expect(findActiveCueIndex(trackCues, 1200)).toBe(0);
    expect(findActiveCueIndex(trackCues, 3399)).toBe(0);
    expect(findActiveCueIndex(trackCues, 3400)).toBe(-1);
    expect(findActiveCueIndex(trackCues, 5000)).toBe(1);
  });

  it('parses YouTube timedtext payloads across JSON3 and SRV3 XML formats', () => {
    const srv3 = `<timedtext><body><p t="500" d="1200">Hello &amp; welcome</p><p t="2000" d="1500"><s>Part 1 </s><s>Part 2</s></p></body></timedtext>`;
    const rawEvents = parseYoutubeTimedTextPayload(srv3);
    const cues = normalizeYoutubeEvents(rawEvents);

    expect(cues).toEqual([
      { tStartMs: 500, dDurationMs: 1200, text: 'Hello & welcome' },
      { tStartMs: 2000, dDurationMs: 1500, text: 'Part 1 Part 2' },
    ]);
  });

  it('strips creator-uploaded HTML/SRT/VTT/ASS markup across JSON3 single seg, split segs, and rolling aAppend=1 cues', () => {
    const cues = normalizeYoutubeEvents([
      // 1. Single seg with <b>...</b> and ASS {\an8}
      {
        tStartMs: 0,
        dDurationMs: 1500,
        segs: [{ utf8: '{\\an8}<b>We were wrong, not a little</b>' }],
      },
      // 2. Tags split across segs[] (including attribute tag & <br>)
      {
        tStartMs: 2000,
        dDurationMs: 1800,
        segs: [
          { utf8: '<b>We ' },
          { utf8: 'were</b> <font ' },
          { utf8: 'color="#ff0">Hello<br>World</font>' },
        ],
      },
      // 3. Tags split across rolling aAppend === 1 cues
      {
        tStartMs: 4000,
        dDurationMs: 600,
        wWinId: 2,
        segs: [{ utf8: '<b>We were' }],
      },
      {
        tStartMs: 4500,
        dDurationMs: 900,
        wWinId: 2,
        aAppend: 1,
        segs: [{ utf8: ' wrong</b>' }],
      },
      // 4. Closing tag token itself split across rolling aAppend === 1 seam
      {
        tStartMs: 6000,
        dDurationMs: 500,
        wWinId: 3,
        segs: [{ utf8: '<i>Split seam</' }],
      },
      {
        tStartMs: 6400,
        dDurationMs: 700,
        wWinId: 3,
        aAppend: 1,
        segs: [{ utf8: 'i>' }],
      },
      // 5. Tag-only noise cue dropped cleanly without emitting empty cue
      {
        tStartMs: 8000,
        dDurationMs: 500,
        segs: [{ utf8: '{\\b1}<b>   </b>{\\b0}' }],
      },
    ]);

    expect(cues).toEqual([
      {
        tStartMs: 0,
        dDurationMs: 1500,
        text: 'We were wrong, not a little',
      },
      {
        tStartMs: 2000,
        dDurationMs: 1800,
        text: 'We were Hello World',
      },
      {
        tStartMs: 4000,
        dDurationMs: 1400,
        text: 'We were wrong',
        wWinId: 2,
      },
      {
        tStartMs: 6000,
        dDurationMs: 1100,
        text: 'Split seam',
        wWinId: 3,
      },
    ]);
  });

  it('sanitizes XML-escaped &lt;b&gt;, <font>, <br/>, <rt>/<rp>, and ASS overrides in SRV3 & legacy XML', () => {
    const srv3 = [
      '<timedtext><body>',
      '<p t="0" d="400" wp="1"/>',
      '<p t="500" d="1500">&lt;b&gt;We were wrong, not a little&lt;/b&gt;</p>',
      '<p t="2200" d="1600">{\\an8}&lt;font color=&quot;#ff0&quot;&gt;Hello&lt;br/&gt;World&lt;/font&gt;</p>',
      '<p t="4000" d="1500">&lt;ruby&gt;漢字&lt;rp&gt;(&lt;/rp&gt;&lt;rt&gt;かんじ&lt;/rt&gt;&lt;rp&gt;)&lt;/rp&gt;&lt;/ruby&gt; &lt;00:11.200&gt;test</p>',
      '<p t="6000" d="500" w="1">&lt;b&gt;We were</p>',
      '<p t="6400" d="800" w="1" a="1"> wrong&lt;/b&gt;</p>',
      '</body></timedtext>',
    ].join('');

    const srv3Events = parseYoutubeTimedTextPayload(srv3);
    expect(srv3Events[0]?.text).toBe('We were wrong, not a little');
    expect(srv3Events[1]?.text).toBe('Hello World');
    expect(srv3Events[2]?.text).toBe('漢字 test');

    const srv3Cues = normalizeYoutubeEvents(srv3Events);
    expect(srv3Cues).toEqual([
      { tStartMs: 500, dDurationMs: 1500, text: 'We were wrong, not a little' },
      { tStartMs: 2200, dDurationMs: 1600, text: 'Hello World' },
      { tStartMs: 4000, dDurationMs: 1500, text: '漢字 test' },
      { tStartMs: 6000, dDurationMs: 1200, text: 'We were wrong', wWinId: 1 },
    ]);

    const legacyXml = `<transcript><text start="1.0" dur="2.5">{\\pos(192,220)}&lt;u&gt;Legacy&lt;/u&gt;&lt;br&gt;&lt;strong&gt;Caption&lt;/strong&gt;</text></transcript>`;
    const legacyEvents = parseYoutubeTimedTextPayload(legacyXml);
    expect(legacyEvents).toEqual([
      { tStartMs: 1000, dDurationMs: 2500, text: 'Legacy Caption' },
    ]);
  });

  it('preserves legitimate programming/math angle brackets across JSON3, WebVTT, TextTrack, and SRV3', () => {
    const codeLine = 'std::vector<int> & Map<string, number>: a < b && c > d';
    const compactMath = 'Loop while 0<i && i<n or a<b && c>d or a<v && b>c';

    expect(stripVttMarkup(`<b>Note:</b> ${codeLine}`)).toBe(`Note: ${codeLine}`);
    expect(stripVttMarkup(compactMath)).toBe(compactMath);

    const json3Cues = normalizeYoutubeEvents([
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: `<b>${codeLine}</b>` }] },
      { tStartMs: 2500, dDurationMs: 2000, segs: [{ utf8: compactMath }] },
    ]);
    expect(json3Cues.map((c) => c.text)).toEqual([codeLine, compactMath]);

    const vtt = `WEBVTT

00:00.000 --> 00:02.000
<v Instructor>Use <b>vector<int></b> and Map<string, number> when a < b && c > d</v>
`;
    expect(parseWebVtt(vtt)[0]?.text).toBe(
      'Use vector<int> and Map<string, number> when a < b && c > d',
    );

    expect(
      extractTextTrackCues([
        { startTime: 0, endTime: 2, text: '<i>Check</i> vector<int> && a < b && c > d' },
      ])[0]?.text,
    ).toBe('Check vector<int> && a < b && c > d');

    const srv3Code = `<timedtext><body><p t="0" d="2000">&lt;b&gt;vector&lt;int&gt;&lt;/b&gt; &amp;&amp; a &lt; b &amp;&amp; c &gt; d</p></body></timedtext>`;
    expect(normalizeYoutubeEvents(parseYoutubeTimedTextPayload(srv3Code))[0]?.text).toBe(
      'vector<int> && a < b && c > d',
    );
  });

  it('stitches split <ruby><rt> furigana across rolling SRV3 a="1" append cues before stripping <rt>', () => {
    const rollingRubySrv3 = `<timedtext><body>
      <p t="1000" d="2000" w="1">&lt;ruby&gt;漢字&lt;rt&gt;かん</p>
      <p t="1500" d="1500" w="1" a="1">じ&lt;/rt&gt;&lt;/ruby&gt;を学ぶ</p>
    </body></timedtext>`;
    const cues = normalizeYoutubeEvents(parseYoutubeTimedTextPayload(rollingRubySrv3));
    expect(cues).toEqual([
      { tStartMs: 1000, dDurationMs: 2000, text: '漢字を学ぶ', wWinId: 1 },
    ]);
  });
});
