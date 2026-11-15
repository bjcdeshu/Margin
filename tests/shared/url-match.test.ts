import { describe, expect, it } from 'vitest';
import {
  applySiteAutoRule,
  getSiteAutoRule,
  isPrivateOrLocalUrl,
  matchesUrlGlob,
} from '@shared/url-match';
import type { UrlPatternConfig } from '@shared/types';

describe('url-match glob & site rule hardening (#127 #15)', () => {
  it('supports schemeless host/path/* patterns without misinterpreting slashes as subdomains', () => {
    expect(
      matchesUrlGlob('https://github.com/openai/codex', 'github.com/openai/*'),
    ).toBe(true);
    expect(
      matchesUrlGlob('http://github.com:8080/openai/codex', 'github.com/openai/*'),
    ).toBe(true);
    expect(
      matchesUrlGlob('https://github.com/anthropics/claude', 'github.com/openai/*'),
    ).toBe(false);
    expect(
      matchesUrlGlob('https://evilgithub.com/openai/codex', 'github.com/openai/*'),
    ).toBe(false);
    expect(
      matchesUrlGlob('https://sub.github.com/openai/codex', 'github.com/openai/*'),
    ).toBe(false);

    // Bare host shorthand still matches root domain and subdomains cleanly
    expect(matchesUrlGlob('https://news.ycombinator.com/item?id=1', 'ycombinator.com')).toBe(
      true,
    );
    expect(matchesUrlGlob('https://ycombinator.com/', 'ycombinator.com')).toBe(true);
    expect(matchesUrlGlob('https://evilycombinator.com/', 'ycombinator.com')).toBe(
      false,
    );
  });

  it('bounds host wildcards strictly within the authority host so query/path spoofing never matches', () => {
    const pattern = '*://*.bank.com/*';
    expect(matchesUrlGlob('https://bank.com/login', pattern)).toBe(true);
    expect(matchesUrlGlob('https://sub.bank.com/dashboard', pattern)).toBe(true);
    expect(matchesUrlGlob('https://a.b.bank.com:8443/account', pattern)).toBe(true);

    // Must NEVER match target host appearing only in query string, path, or suffix-spoofed domain!
    expect(
      matchesUrlGlob('https://evil.com/?redirect=https://a.bank.com/login', pattern),
    ).toBe(false);
    expect(
      matchesUrlGlob('https://evil.com/https://a.bank.com/login', pattern),
    ).toBe(false);
    expect(matchesUrlGlob('https://evilbank.com/login', pattern)).toBe(false);
    expect(
      matchesUrlGlob('https://a.bank.com@evil.com/login', pattern),
    ).toBe(false);
  });

  it('preserves non-default ports in applySiteAutoRule/getSiteAutoRule and deletes ONLY canonical per-host rules', () => {
    const initialRules: UrlPatternConfig = {
      includeMatches: [
        '*://*.example.com/*',
        'https://app.example.com/docs/*',
      ],
      excludeMatches: ['*://app.example.com:9000/*'],
      skipPrivateNetworks: true,
    };

    // Non-default port `:8443` gets its own canonical `*://app.example.com:8443/*` rule
    const with8443Never = applySiteAutoRule(
      'https://app.example.com:8443/dashboard',
      'never',
      initialRules,
    );
    expect(with8443Never.excludeMatches).toContain('*://app.example.com:8443/*');
    expect(with8443Never.excludeMatches).toContain('*://app.example.com:9000/*');
    expect(
      getSiteAutoRule('https://app.example.com:8443/dashboard', with8443Never),
    ).toBe('never');
    expect(
      getSiteAutoRule('https://app.example.com/docs/intro', with8443Never),
    ).toBe('always');

    // Resetting `https://app.example.com/settings` to `follow` removes ONLY canonical rules for `app.example.com`,
    // keeping user wildcard `*://*.example.com/*`, path rule `https://app.example.com/docs/*`, and `:8443` / `:9000` rules intact!
    const with443Always = applySiteAutoRule(
      'https://app.example.com/settings',
      'always',
      with8443Never,
    );
    expect(with443Always.includeMatches).toContain('*://app.example.com/*');

    const backToFollow = applySiteAutoRule(
      'https://app.example.com/settings',
      'follow',
      with443Always,
    );
    expect(backToFollow.includeMatches).toEqual([
      '*://*.example.com/*',
      'https://app.example.com/docs/*',
    ]);
    expect(backToFollow.excludeMatches).toEqual([
      '*://app.example.com:9000/*',
      '*://app.example.com:8443/*',
    ]);
  });

  it('detects RFC1918, link-local 169.254/16, 0.0.0.0/8, CGNAT, localhost., and IPv6 ULA/link-local/IPv4-mapped addresses in isPrivateOrLocalUrl', () => {
    const privateUrls = [
      'http://127.0.0.1:11434/v1',
      'http://0.0.0.0:8080/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.24.0.5/translate',
      'http://172.16.0.1/',
      'http://172.31.255.254/',
      'http://192.168.1.10/',
      'http://100.64.10.2/',
      'http://localhost:3000/',
      'http://localhost.:3000/',
      'http://ollama.localhost/v1',
      'http://printer.local/',
      'http://router.home.arpa/',
      'http://metadata.internal/',
      'http://[::1]:11434/',
      'http://[::]:8080/',
      'http://[fc00::1]/',
      'http://[fd12:3456:789a::1]:8000/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]:8080/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:10.0.0.1]/',
      'http://[::ffff:0.0.0.0]/',
    ];
    for (const u of privateUrls) {
      expect(isPrivateOrLocalUrl(u), `Expected private/local: ${u}`).toBe(true);
    }

    const publicUrls = [
      'https://api.openai.com/v1/chat/completions',
      'https://8.8.8.8/dns-query',
      'https://172.15.255.255/',
      'https://172.32.0.1/',
      'https://100.128.0.1/',
      'https://[2606:4700:4700::1111]/',
      'https://[::ffff:8.8.8.8]/',
    ];
    for (const u of publicUrls) {
      expect(isPrivateOrLocalUrl(u), `Expected public: ${u}`).toBe(false);
    }
  });
});
