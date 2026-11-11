import { SUPPORTED_LANGUAGES } from '@shared/constants';
import type {
  DisplayMode,
  PromptCodecId,
  ProviderPreset,
  SelectionTriggerMode,
  TemperatureTrace,
  TranslationScene,
  TranslationTheme,
  UiColorMode,
} from '@shared/types';

export type UiLang = 'zh-CN' | 'en';

export interface BilingualText {
  'zh-CN': string;
  en: string;
}

export function pickText(lang: UiLang, pair: BilingualText): string {
  return lang === 'en' ? pair.en : pair['zh-CN'];
}

export function formatLanguageOption(code: string, uiLang: UiLang): string {
  const entry = SUPPORTED_LANGUAGES.find((item) => item.code === code);
  if (!entry) return code;
  if (code === 'auto') {
    return uiLang === 'en' ? 'Auto Detect' : '自动检测';
  }
  return uiLang === 'en'
    ? `${entry.englishName} (${entry.code})`
    : `${entry.nativeName} · ${entry.englishName}`;
}

export function labelForColorMode(mode: UiColorMode, lang: UiLang): string {
  switch (mode) {
    case 'paper':
      return lang === 'en' ? 'Paper' : '暖纸白 Paper';
    case 'night':
      return lang === 'en' ? 'Night' : '暖炭黑 Night';
    case 'system':
      return lang === 'en' ? 'System' : '跟随系统';
  }
}

export function shortLabelForColorMode(mode: UiColorMode, lang: UiLang): string {
  switch (mode) {
    case 'paper':
      return lang === 'en' ? 'Paper' : '纸白';
    case 'night':
      return lang === 'en' ? 'Night' : '夜读';
    case 'system':
      return lang === 'en' ? 'Auto' : '系统';
  }
}

export function labelForDisplayMode(mode: DisplayMode, lang: UiLang): string {
  return mode === 'bilingual'
    ? lang === 'en'
      ? 'Bilingual'
      : '双语对照'
    : lang === 'en'
      ? 'Target Only'
      : '仅译文';
}

export function labelForTheme(theme: TranslationTheme, lang: UiLang): string {
  switch (theme) {
    case 'none':
      return lang === 'en' ? 'Clean' : '无样式';
    case 'mask':
      return lang === 'en' ? 'Blur Mask' : '模糊遮罩 Mask';
    case 'opacity':
      return lang === 'en' ? 'Soft Opacity' : '淡化';
    case 'weakening':
      return lang === 'en' ? 'Muted Ink' : '弱化';
  }
}

export function labelForScene(scene: TranslationScene, lang: UiLang): string {
  const map: Record<TranslationScene, BilingualText> = {
    webpage: { 'zh-CN': '网页正文翻译', en: 'Webpage Translation' },
    input: { 'zh-CN': '输入框快捷翻译', en: 'Input-Box Quick Translate' },
    subtitle: { 'zh-CN': '视频与 YouTube 字幕', en: 'Video & YouTube Subtitles' },
    hover: { 'zh-CN': '悬停段落翻译', en: 'Hover Paragraph' },
    selection: { 'zh-CN': '划词翻译浮层', en: 'Selection Popover' },
    pdf: { 'zh-CN': '双语 PDF 阅读器', en: 'Bilingual PDF Reader' },
    image: { 'zh-CN': '图片与漫画视觉翻译', en: 'Vision Image & Manga' },
  };
  return pickText(lang, map[scene]);
}

export function labelForCodec(codec: PromptCodecId, lang: UiLang): string {
  switch (codec) {
    case 'yaml':
      return lang === 'en' ? '<yaml> Structured' : '<yaml> 结构化';
    case 'delimiter':
      return lang === 'en' ? '%% Delimiter' : '%% 分隔符';
    case 'json-batch':
      return lang === 'en' ? 'JSON Batch' : 'JSON 批处理';
    case 'single-text':
      return lang === 'en' ? 'Single Sentence' : '单句直译';
  }
}

export function labelForSelectionMode(mode: SelectionTriggerMode, lang: UiLang): string {
  switch (mode) {
    case 'off':
      return lang === 'en' ? 'Off' : '关闭';
    case 'icon':
      return lang === 'en' ? 'Icon' : '图标';
    case 'dot':
      return lang === 'en' ? 'Dot' : '圆点';
    case 'instant':
      return lang === 'en' ? 'Instant' : '立即翻译';
  }
}

export function labelForPreset(preset: ProviderPreset, lang: UiLang): string {
  const map: Record<ProviderPreset, BilingualText> = {
    openai: { 'zh-CN': 'OpenAI / 兼容网关', en: 'OpenAI / Compatible' },
    deepseek: { 'zh-CN': 'DeepSeek / 兼容接口', en: 'DeepSeek / Compatible' },
    zhipu: { 'zh-CN': '智谱清言 (Zhipu GLM)', en: 'Zhipu GLM' },
    anthropic: { 'zh-CN': 'Anthropic Claude', en: 'Anthropic Claude' },
    deeplx: { 'zh-CN': 'DeepLX 翻译服务', en: 'DeepLX' },
    'google-free': { 'zh-CN': 'Google 免费网页翻译', en: 'Google Translate (Free)' },
    custom: { 'zh-CN': '自定义 OpenAI 兼容渠道', en: 'Custom OpenAI-Compatible' },
  };
  return pickText(lang, map[preset]);
}

export function describeTemperatureResolution(params: {
  trace: TemperatureTrace;
  value?: number;
  model: string;
  assistantName?: string;
  lang: UiLang;
}): string {
  const { trace, value, model, assistantName, lang } = params;
  switch (trace) {
    case 'omitted-reasoning-guard':
      return lang === 'en'
        ? `Effective request: Auto-omitted (reasoning model ${model} detected)`
        : `实际请求：自动省略 (检测到推理模型 ${model})`;
    case 'omitted-capability-cache':
      return lang === 'en'
        ? `Effective request: Auto-omitted (cached HTTP 400 rejection for ${model})`
        : `实际请求：自动省略 (已缓存 ${model} 的 400 拒绝记录)`;
    case 'sent-provider-custom':
      return lang === 'en'
        ? `Effective request: Send provider custom ${value}`
        : `实际请求：发送渠道自定义 ${value}`;
    case 'sent-assistant-custom':
      return lang === 'en'
        ? `Effective request: Inherit assistant ${value}${assistantName ? ` (${assistantName})` : ''}`
        : `实际请求：继承助手 ${value}${assistantName ? ` (${assistantName})` : ''}`;
    case 'retried-after-400':
      return lang === 'en'
        ? 'Effective request: Stripped & retried after HTTP 400'
        : '实际请求：400 报错后已自动剥离重试';
    case 'omitted-default':
    default:
      return lang === 'en'
        ? 'Effective request: Omit temperature (server default)'
        : '实际请求：不发送 temperature (使用服务端默认)';
  }
}
