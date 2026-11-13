import { describe, expect, it } from 'vitest';
import {
  isEditorialSerifFontFamily,
  normalizeTargetBcp47Lang,
  resolveTargetFontFamilyCss,
  resolveTargetTextDir,
} from '@shared/index';

describe('locale-typography: BCP-47 normalization, RTL/LTR direction & CJK Han-Unification font stacks', () => {
  it('normalizes target language codes into canonical BCP-47 tags and returns empty string for auto/empty', () => {
    expect(normalizeTargetBcp47Lang(undefined)).toBe('');
    expect(normalizeTargetBcp47Lang('')).toBe('');
    expect(normalizeTargetBcp47Lang('   ')).toBe('');
    expect(normalizeTargetBcp47Lang('auto')).toBe('');
    expect(normalizeTargetBcp47Lang('AUTO')).toBe('');

    expect(normalizeTargetBcp47Lang('zh')).toBe('zh-CN');
    expect(normalizeTargetBcp47Lang('zh-cn')).toBe('zh-CN');
    expect(normalizeTargetBcp47Lang('zh_CN')).toBe('zh-CN');
    expect(normalizeTargetBcp47Lang('zh-hans')).toBe('zh-CN');
    expect(normalizeTargetBcp47Lang('zh-Hans-CN')).toBe('zh-CN');

    expect(normalizeTargetBcp47Lang('zh-tw')).toBe('zh-TW');
    expect(normalizeTargetBcp47Lang('zh_TW')).toBe('zh-TW');
    expect(normalizeTargetBcp47Lang('zh-hk')).toBe('zh-TW');
    expect(normalizeTargetBcp47Lang('zh-hant')).toBe('zh-TW');
    expect(normalizeTargetBcp47Lang('zh-Hant-HK')).toBe('zh-TW');

    expect(normalizeTargetBcp47Lang('ja')).toBe('ja');
    expect(normalizeTargetBcp47Lang('jp')).toBe('ja');
    expect(normalizeTargetBcp47Lang('ja-JP')).toBe('ja');

    expect(normalizeTargetBcp47Lang('ko')).toBe('ko');
    expect(normalizeTargetBcp47Lang('kr')).toBe('ko');
    expect(normalizeTargetBcp47Lang('ko-KR')).toBe('ko');

    expect(normalizeTargetBcp47Lang('en')).toBe('en');
    expect(normalizeTargetBcp47Lang('en-us')).toBe('en-US');
    expect(normalizeTargetBcp47Lang('pt-br')).toBe('pt-BR');
    expect(normalizeTargetBcp47Lang('pt_BR')).toBe('pt-BR');
    expect(normalizeTargetBcp47Lang('es-419')).toBe('es-419');
    expect(normalizeTargetBcp47Lang('sr-latn')).toBe('sr-Latn');
    expect(normalizeTargetBcp47Lang('ar')).toBe('ar');
  });

  it('resolves explicit ltr/rtl text direction for target languages and null when empty', () => {
    expect(resolveTargetTextDir('')).toBeNull();
    expect(resolveTargetTextDir('auto')).toBeNull();

    for (const rtlTag of ['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'dv', 'yi', 'ar-SA', 'az-Arab']) {
      expect(resolveTargetTextDir(rtlTag)).toBe('rtl');
    }

    for (const ltrTag of ['zh-CN', 'zh-TW', 'ja', 'ko', 'en', 'fr', 'de', 'es', 'ru', 'pt-BR', 'vi', 'th']) {
      expect(resolveTargetTextDir(ltrTag)).toBe('ltr');
    }
  });

  it('detects genuine editorial serif host typography while rejecting SimSun/MingLiU bare fallbacks, UA defaults, and sans-serif stacks', () => {
    expect(isEditorialSerifFontFamily(null)).toBe(false);
    expect(isEditorialSerifFontFamily(undefined)).toBe(false);
    expect(isEditorialSerifFontFamily('')).toBe(false);

    // Bare Windows CJK bitmap fallbacks & single-token unstyled UA default must NOT trigger serif
    expect(isEditorialSerifFontFamily('SimSun')).toBe(false);
    expect(isEditorialSerifFontFamily('"SimSun"')).toBe(false);
    expect(isEditorialSerifFontFamily('NSimSun')).toBe(false);
    expect(isEditorialSerifFontFamily('MingLiU')).toBe(false);
    expect(isEditorialSerifFontFamily('PMingLiU')).toBe(false);
    expect(isEditorialSerifFontFamily('SimSun, serif')).toBe(false);
    expect(isEditorialSerifFontFamily('"Times New Roman"')).toBe(false);

    // Sans-serif and monospace stacks (including X's Japanese/Korean classes) must return false
    expect(
      isEditorialSerifFontFamily(
        '"Segoe UI", Meiryo, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      ),
    ).toBe(false);
    expect(
      isEditorialSerifFontFamily('"Segoe UI", "Malgun Gothic", system-ui, sans-serif'),
    ).toBe(false);
    expect(isEditorialSerifFontFamily('Inter, Georgia, sans-serif')).toBe(false);
    expect(isEditorialSerifFontFamily('JetBrains Mono, Consolas, monospace')).toBe(false);

    // Genuine editorial serif stacks must return true
    expect(isEditorialSerifFontFamily('Georgia, serif')).toBe(true);
    expect(isEditorialSerifFontFamily('Georgia')).toBe(true);
    expect(isEditorialSerifFontFamily('"Times New Roman", Times, serif')).toBe(true);
    expect(isEditorialSerifFontFamily('"EB Garamond", Garamond, serif')).toBe(true);
    expect(isEditorialSerifFontFamily('Palatino, "Palatino Linotype", serif')).toBe(true);
    expect(isEditorialSerifFontFamily('Charter, Georgia, serif')).toBe(true);
    expect(isEditorialSerifFontFamily('"Merriweather", Georgia, serif')).toBe(true);
    expect(isEditorialSerifFontFamily('"Lora", serif')).toBe(true);
    expect(isEditorialSerifFontFamily('"Source Serif 4", serif')).toBe(true);
    expect(isEditorialSerifFontFamily('"Noto Serif SC", "Songti SC", serif')).toBe(true);
    expect(isEditorialSerifFontFamily('"STSong", serif')).toBe(true);
    expect(isEditorialSerifFontFamily('"Hiragino Mincho ProN", "Yu Mincho", serif')).toBe(true);
    expect(isEditorialSerifFontFamily('"Batang", serif')).toBe(true);
  });

  it('builds locale-pure CJK & Western font stacks without mixing Japanese Meiryo or Korean Malgun Gothic into Chinese stacks', () => {
    const zhCnSans = resolveTargetFontFamilyCss('zh-CN');
    expect(zhCnSans.startsWith('-apple-system, BlinkMacSystemFont')).toBe(true);
    expect(zhCnSans).toContain('"PingFang SC"');
    expect(zhCnSans).toContain('"Microsoft YaHei UI"');
    expect(zhCnSans).toContain('"Microsoft YaHei"');
    expect(zhCnSans).toContain('"Noto Sans SC"');
    expect(zhCnSans).not.toContain('Meiryo');
    expect(zhCnSans).not.toContain('Malgun Gothic');
    expect(zhCnSans.indexOf('"Microsoft YaHei"')).toBeLessThan(
      zhCnSans.indexOf('system-ui'),
    );

    const zhCnSerif = resolveTargetFontFamilyCss('zh-CN', { serif: true });
    expect(zhCnSerif).toContain('Georgia');
    expect(zhCnSerif).toContain('"Songti SC"');
    expect(zhCnSerif).toContain('"SimSun"');
    expect(zhCnSerif).not.toContain('Meiryo');

    const zhTwSans = resolveTargetFontFamilyCss('zh-TW');
    expect(zhTwSans).toContain('"PingFang TC"');
    expect(zhTwSans).toContain('"Microsoft JhengHei UI"');
    expect(zhTwSans).toContain('"Microsoft JhengHei"');
    expect(zhTwSans).not.toContain('Meiryo');
    expect(zhTwSans).not.toContain('Malgun Gothic');

    const zhTwSerif = resolveTargetFontFamilyCss('zh-TW', { serif: true });
    expect(zhTwSerif).toContain('"Songti TC"');
    expect(zhTwSerif).toContain('"MingLiU"');

    const jaSans = resolveTargetFontFamilyCss('ja');
    expect(jaSans).toContain('"Hiragino Sans"');
    expect(jaSans).toContain('"Yu Gothic UI"');
    expect(jaSans).toContain('"Meiryo"');
    expect(jaSans).not.toContain('Microsoft YaHei');

    const jaSerif = resolveTargetFontFamilyCss('ja', { serif: true });
    expect(jaSerif).toContain('"Hiragino Mincho ProN"');
    expect(jaSerif).toContain('"Yu Mincho"');

    const koSans = resolveTargetFontFamilyCss('ko');
    expect(koSans).toContain('"Apple SD Gothic Neo"');
    expect(koSans).toContain('"Malgun Gothic"');
    expect(koSans).not.toContain('Meiryo');

    const koSerif = resolveTargetFontFamilyCss('ko', { serif: true });
    expect(koSerif).toContain('"AppleMyungjo"');
    expect(koSerif).toContain('"Batang"');

    const arSans = resolveTargetFontFamilyCss('ar');
    expect(arSans).toContain('"Segoe UI"');
    expect(arSans).toContain('"Noto Sans"');
    expect(arSans).not.toContain('Meiryo');
    expect(arSans).not.toContain('Malgun Gothic');
  });
});
