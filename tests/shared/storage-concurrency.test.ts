import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRAND } from '@shared/brand';
import { createDefaultMarginConfig } from '@shared/constants';
import {
  appendDiagnosticSnapshot,
  getCapabilityCache,
  getDiagnosticsLog,
  getMarginConfig,
  recordModelCapability,
  resetMemoryStorageForTests,
  saveMarginConfig,
  updateMarginConfig,
} from '@shared/storage';
import type { DiagnosticSnapshot } from '@shared/types';

function makeDummyDiagnostic(idSuffix: number): DiagnosticSnapshot {
  return {
    schemaVersion: 1,
    product: BRAND.name,
    version: BRAND.version,
    time: new Date(1_700_000_000_000 + idSuffix).toISOString(),
    scene: 'webpage',
    codec: 'yaml',
    provider: {
      id: `prov-${idSuffix}`,
      preset: 'openai',
      protocol: 'openai-chat',
      endpointOrigin: 'https://api.example.com',
      endpointPath: '/v1/chat/completions',
      model: 'gpt-6-luna',
    },
    parameters: {
      temperatureTrace: 'omitted-default',
      thinkingMode: 'provider-default',
      stream: false,
    },
    httpStatus: 200,
    kind: 'ok',
    retryable: false,
    attempts: 1,
    latencyMs: idSuffix,
  };
}

describe('Per-Key Storage Mutex Serialization & Quota Resilience (#127 #9)', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    resetMemoryStorageForTests();
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
  });

  it('serializes concurrent updateMarginConfig, appendDiagnosticSnapshot, recordModelCapability, and legacy backfill writes without lost updates', async () => {
    // Simulate async `chrome.storage.local` with variable read/write latency that previously caused lost RMW updates
    const rawStore: Record<string, unknown> = {
      [BRAND.storageKeyConfig]: {
        ...createDefaultMarginConfig(),
        promptSystemVersion: 2, // triggers backfill write on first access
      },
    };

    let readCounter = 0;
    globalThis.chrome = {
      storage: {
        local: {
          get: async (key: string) => {
            const delay = (readCounter++ % 3) * 4 + 2;
            await new Promise((r) => setTimeout(r, delay));
            return { [key]: structuredClone(rawStore[key]) };
          },
          set: async (items: Record<string, unknown>) => {
            await new Promise((r) => setTimeout(r, 3));
            for (const [k, v] of Object.entries(items)) {
              rawStore[k] = structuredClone(v);
            }
          },
        },
      },
    } as unknown as typeof chrome;

    // 1. Race legacy `getMarginConfig()` backfill against two concurrent `updateMarginConfig()` mutations
    const [backfilled, patchA, patchB] = await Promise.all([
      getMarginConfig(),
      updateMarginConfig((draft) => {
        draft.webpage.theme = 'mask';
      }),
      updateMarginConfig((draft) => {
        draft.targetLang = 'ja';
      }),
    ]);

    expect(backfilled.promptSystemVersion).toBe(3);
    expect(patchA.webpage.theme).toBe('mask');
    expect(patchB.webpage.theme).toBe('mask');
    expect(patchB.targetLang).toBe('ja');

    const finalConfig = await getMarginConfig();
    expect(finalConfig.promptSystemVersion).toBe(3);
    expect(finalConfig.webpage.theme).toBe('mask');
    expect(finalConfig.targetLang).toBe('ja');

    // 2. Fire 8 concurrent `appendDiagnosticSnapshot` writes -> all 8 survive!
    await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        appendDiagnosticSnapshot(makeDummyDiagnostic(idx + 1)),
      ),
    );
    const logs = await getDiagnosticsLog();
    expect(logs).toHaveLength(8);
    expect(new Set(logs.map((l) => l.provider.id)).size).toBe(8);

    // 3. Fire concurrent `recordModelCapability` updates on same & distinct keys -> merged without clobbering!
    const sharedKey = 'https://api.example.com::gpt-6-luna';
    await Promise.all([
      recordModelCapability(sharedKey, {
        supportsTemperature: false,
        learnedFromStatus: 400,
        updatedAt: Date.now(),
      }),
      recordModelCapability(sharedKey, {
        supportsReasoningEffort: false,
        learnedFromStatus: 400,
        updatedAt: Date.now(),
      }),
      recordModelCapability('https://api.example.com::other-model', {
        supportsTemperature: false,
        updatedAt: Date.now(),
      }),
    ]);

    const capCache = await getCapabilityCache();
    expect(capCache[sharedKey]?.supportsTemperature).toBe(false);
    expect(capCache[sharedKey]?.supportsReasoningEffort).toBe(false);
    expect(
      capCache['https://api.example.com::other-model']?.supportsTemperature,
    ).toBe(false);
  });

  it('swallows QUOTA_BYTES errors on telemetry/capability/backfill writes while still propagating errors on explicit config saves', async () => {
    globalThis.chrome = {
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {
            throw new Error('QUOTA_BYTES quota exceeded');
          },
        },
      },
    } as unknown as typeof chrome;

    // Best-effort paths MUST NOT throw
    const cfg = await getMarginConfig();
    expect(cfg.schemaVersion).toBe(2);
    await expect(
      appendDiagnosticSnapshot(makeDummyDiagnostic(99)),
    ).resolves.toBeUndefined();
    await expect(
      recordModelCapability('https://api.example.com::m', {
        supportsTemperature: false,
        updatedAt: Date.now(),
      }),
    ).resolves.toBeUndefined();

    // Explicit user config saves MUST still reject so Options/Popup UI can report failure
    await expect(saveMarginConfig(cfg)).rejects.toThrow(/QUOTA_BYTES/);
    await expect(
      updateMarginConfig((d) => {
        d.targetLang = 'fr';
      }),
    ).rejects.toThrow(/QUOTA_BYTES/);
  });
});
