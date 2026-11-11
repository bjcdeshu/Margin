import { describe, expect, it } from 'vitest';
import {
  ProviderExecutionPool,
  resolveDeepLXEndpoints,
  resolveEndpointForProvider,
  resolveProviderEndpoint,
} from '../../src/core/providers';
import { PROVIDER_PRESETS } from '@shared/constants';

const OPENAI_DEFAULT = PROVIDER_PRESETS.openai.defaultEndpoint;
const ZHIPU_DEFAULT = PROVIDER_PRESETS.zhipu.defaultEndpoint;
const ANTHROPIC_DEFAULT = PROVIDER_PRESETS.anthropic.defaultEndpoint;
const DEEPLX_DEFAULT = PROVIDER_PRESETS.deeplx.defaultEndpoint;

describe('P0-1 resolveProviderEndpoint & provider endpoint helpers', () => {
  it('completes OpenAI-compatible base URLs without mutating stored input', () => {
    const storedBaseUrl = 'proxy.example.com/v1';
    expect(resolveProviderEndpoint(OPENAI_DEFAULT, storedBaseUrl)).toBe(
      'https://proxy.example.com/v1/chat/completions',
    );
    // Stored string remains untouched
    expect(storedBaseUrl).toBe('proxy.example.com/v1');

    expect(
      resolveProviderEndpoint(OPENAI_DEFAULT, 'https://proxy.example.com'),
    ).toBe('https://proxy.example.com/v1/chat/completions');

    expect(
      resolveProviderEndpoint(OPENAI_DEFAULT, 'https://proxy.example.com/'),
    ).toBe('https://proxy.example.com/v1/chat/completions');

    expect(
      resolveProviderEndpoint(OPENAI_DEFAULT, 'https://proxy.example.com/v1/'),
    ).toBe('https://proxy.example.com/v1/chat/completions');

    expect(
      resolveProviderEndpoint(
        OPENAI_DEFAULT,
        'https://proxy.example.com/openai/v1',
      ),
    ).toBe('https://proxy.example.com/openai/v1/chat/completions');
  });

  it('inherits Zhipu /api/paas/v4/chat/completions and Anthropic /v1/messages paths on root /', () => {
    expect(
      resolveProviderEndpoint(ZHIPU_DEFAULT, 'https://zhipu-gateway.example.com'),
    ).toBe('https://zhipu-gateway.example.com/api/paas/v4/chat/completions');

    expect(
      resolveProviderEndpoint(ANTHROPIC_DEFAULT, 'claude-proxy.example.com'),
    ).toBe('https://claude-proxy.example.com/v1/messages');

    expect(
      resolveProviderEndpoint(
        ANTHROPIC_DEFAULT,
        'https://proxy.example.com/v1',
      ),
    ).toBe('https://proxy.example.com/v1/messages');

    expect(
      resolveProviderEndpoint(
        ANTHROPIC_DEFAULT,
        'https://proxy.example.com/anthropic/v1',
      ),
    ).toBe('https://proxy.example.com/anthropic/v1/messages');
  });

  it('preserves explicit custom paths, ports, userinfo, query strings, and hashes', () => {
    expect(
      resolveProviderEndpoint(
        OPENAI_DEFAULT,
        'http://user:pass@127.0.0.1:8080/v1?token=test#debug',
      ),
    ).toBe('http://user:pass@127.0.0.1:8080/v1/chat/completions?token=test#debug');

    expect(
      resolveProviderEndpoint(
        OPENAI_DEFAULT,
        'https://corp.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
      ),
    ).toBe(
      'https://corp.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
    );

    expect(
      resolveProviderEndpoint(
        OPENAI_DEFAULT,
        'https://proxy.example.com/custom/endpoint',
      ),
    ).toBe('https://proxy.example.com/custom/endpoint');

    // Does not leak default port :1188 when user enters a portless HTTPS DeepLX host
    expect(
      resolveProviderEndpoint(DEEPLX_DEFAULT, 'https://deeplx.example.com'),
    ).toBe('https://deeplx.example.com/translate');
  });

  it('resolves protocol-aware default endpoints and comma-separated DeepLX URL pools', () => {
    expect(
      resolveEndpointForProvider({
        preset: 'custom',
        protocol: 'anthropic-messages',
        baseUrl: 'gateway.example.com/v1',
      }),
    ).toBe('https://gateway.example.com/v1/messages');

    const deeplxUrls = resolveDeepLXEndpoints({
      baseUrl: 'https://d1.example.com/translate, d2.example.com',
      endpoints: undefined,
    });
    expect(deeplxUrls).toEqual([
      'https://d1.example.com/translate',
      'https://d2.example.com/translate',
    ]);
  });
});

describe('ProviderExecutionPool multi-key rotation, 429 cooldown, concurrency & RPS', () => {
  it('rotates API keys round-robin and cools down 429 keys for 30s', () => {
    let fakeNow = 1_000_000;
    const pool = new ProviderExecutionPool({ now: () => fakeNow });
    const keys = ['key-alpha', 'key-beta', 'key-gamma'];

    expect(pool.acquireApiKey('openai-1', keys)).toBe('key-alpha');
    expect(pool.acquireApiKey('openai-1', keys)).toBe('key-beta');
    expect(pool.acquireApiKey('openai-1', keys)).toBe('key-gamma');
    expect(pool.acquireApiKey('openai-1', keys)).toBe('key-alpha');

    // Mark `key-beta` rate-limited on HTTP 429 (30s cooldown)
    pool.markKeyRateLimited('openai-1', 'key-beta');
    expect(pool.isKeyCoolingDown('openai-1', 'key-beta')).toBe(true);

    // Next rotations skip `key-beta` cleanly while healthy keys continue immediately
    expect(pool.acquireApiKey('openai-1', keys)).toBe('key-gamma');
    expect(pool.acquireApiKey('openai-1', keys)).toBe('key-alpha');
    expect(pool.acquireApiKey('openai-1', keys)).toBe('key-gamma');

    // Advance clock past 30s cooldown -> `key-beta` re-enters healthy rotation
    fakeNow += 30_001;
    expect(pool.isKeyCoolingDown('openai-1', 'key-beta')).toBe(false);
    expect(pool.acquireApiKey('openai-1', keys)).toBe('key-alpha');
    expect(pool.acquireApiKey('openai-1', keys)).toBe('key-beta');
  });

  it('enforces per-provider maxConcurrency and sliding-window rateLimitRps', async () => {
    let fakeNow = 5_000;
    const sleepCalls: number[] = [];
    const pool = new ProviderExecutionPool({
      now: () => fakeNow,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        fakeNow += ms;
      },
    });

    const providerMeta = {
      id: 'limited-provider',
      maxConcurrency: 2,
      rateLimitRps: 2,
    };

    let active = 0;
    let peakActive = 0;

    const tasks = [1, 2, 3, 4].map((idx) =>
      pool.schedule(providerMeta, undefined, async () => {
        active++;
        peakActive = Math.max(peakActive, active);
        await Promise.resolve();
        active--;
        return idx;
      }),
    );

    const results = await Promise.all(tasks);
    expect(results).toEqual([1, 2, 3, 4]);
    expect(peakActive).toBeLessThanOrEqual(2);
    // 4 requests at 2 RPS must trigger sliding-window sleep after the first 2 requests
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(1000);
  });
});
