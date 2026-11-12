import type { GlossaryEntry, MarginConfig } from '@shared/types';

export interface GlossaryPackDefinition {
  id: string;
  name: string;
  badge: string;
  description: string;
  defaultEnabled: boolean;
  entries: GlossaryEntry[];
}

function keep(
  terms: readonly string[],
  group: string,
  options?: { caseSensitive?: boolean },
): GlossaryEntry[] {
  return terms.map((k) => ({
    k,
    v: '',
    group,
    ...(options?.caseSensitive ? { caseSensitive: true } : {}),
  }));
}

function mapped(
  pairs: ReadonlyArray<readonly [string, string]>,
  group: string,
): GlossaryEntry[] {
  return pairs.map(([k, v]) => ({
    k,
    v,
    group,
  }));
}

export const BUILTIN_GLOSSARY_PACKS: readonly GlossaryPackDefinition[] = [
  {
    id: 'ai-agent-infra',
    name: 'AI · 大模型与算力基建',
    badge: 'AI / Infra',
    description:
      '大模型、Agent 编排、推理引擎 (vLLM / KV Cache) 与 GPU 算力硬件核心术语。',
    defaultEnabled: true,
    entries: [
      ...keep(
        [
          'LLM',
          'LLMs',
          'Agent',
          'Agents',
          'Subagent',
          'Subagents',
          'Swarm',
          'MCP',
          'Skill',
          'Skills',
          'System Prompt',
          'Prompt',
          'Token',
          'Tokens',
          'RAG',
          'LoRA',
          'QLoRA',
          'Transformer',
          'vLLM',
          'SGLang',
          'KV Cache',
          'CUDA',
          'NVLink',
          'HBM',
          'CoWoS',
          'SOTA',
          'RLHF',
          'DPO',
          'GRPO',
          'MoE',
          'FlashAttention',
        ],
        'ai-agent-infra',
      ),
      ...mapped(
        [
          ['Context Window', '上下文窗口'],
          ['Fine-tuning', '微调'],
          ['Post-training', '后训练'],
          ['Pre-training', '预训练'],
          ['Test-time Compute', '测试时算力'],
          ['Chain-of-Thought', '思维链'],
          ['Hallucination', '幻觉'],
          ['Quantization', '量化'],
          ['Distillation', '蒸馏'],
          ['Guardrails', '安全护栏'],
          ['Tool Calling', '工具调用'],
          ['Function Calling', '函数调用'],
          ['Hyperscaler', '超大规模云厂商'],
          ['Inference', '推理'],
          ['Speculative Decoding', '投机解码'],
          ['Context Engineering', '上下文工程'],
        ],
        'ai-agent-infra',
      ),
    ],
  },
  {
    id: 'dev-cloud-web',
    name: '开发 · GitHub 与云原生',
    badge: 'Dev / Cloud',
    description:
      'GitHub 协作流、现代 Web 架构、API 协议与云原生基础设施高频工程词汇。',
    defaultEnabled: true,
    entries: [
      ...keep(
        [
          'GitHub',
          'GitHub Actions',
          'Pull Request',
          'Rebase',
          'Worktree',
          'CI/CD',
          'Webhook',
          'Endpoint',
          'WebSocket',
          'gRPC',
          'GraphQL',
          'Shadow DOM',
          'Docker',
          'Kubernetes',
          'Cloudflare',
          'Turnstile',
          'OAuth',
          'JWT',
        ],
        'dev-cloud-web',
      ),
      ...keep(
        ['PR', 'Issue', 'Commit', 'SSE', 'DOM', 'SSR', 'CSR', 'IAM', 'ADC'],
        'dev-cloud-web',
        { caseSensitive: true },
      ),
      ...mapped(
        [
          ['Rate Limit', '速率限制'],
          ['Cold Start', '冷启动'],
          ['Idempotency', '幂等性'],
          ['Throughput', '吞吐量'],
          ['Backpressure', '背压'],
          ['Open Source', '开源'],
          ['Deadlock', '死锁'],
          ['Race Condition', '竞态条件'],
          ['Reverse Proxy', '反向代理'],
        ],
        'dev-cloud-web',
      ),
    ],
  },
  {
    id: 'screenwriting-narrative',
    name: '影视叙事 · 短剧与网文创作',
    badge: 'Narrative',
    description:
      '剧作结构、叙事节拍、人物弧光与短剧/轻小说/条漫创作专业术语。',
    defaultEnabled: true,
    entries: [
      ...mapped(
        [
          ['Logline', '一句话故事梗概'],
          ['Beat Sheet', '节拍表'],
          ['Story Beat', '叙事节拍'],
          ['Opening Hook', '开篇钩子'],
          ['Cliffhanger', '卡点悬念'],
          ['Plot Twist', '剧情反转'],
          ['Character Arc', '人物弧光'],
          ['Worldbuilding', '世界观设定'],
          ['Showrunner', '剧集主创'],
          ['Screenplay', '剧本'],
          ['Screenwriter', '编剧'],
          ['Subtext', '潜台词'],
          ['Voiceover', '旁白'],
          ['Monologue', '独白'],
          ['Protagonist', '主角'],
          ['Antagonist', '反派'],
          ['Short Drama', '短剧'],
          ['Micro-drama', '微短剧'],
          ['Vertical Drama', '竖屏短剧'],
          ['Light Novel', '轻小说'],
          ['Webtoon', '条漫'],
          ['Foreshadowing', '伏笔'],
          ['Three-Act Structure', '三幕式结构'],
        ],
        'screenwriting-narrative',
      ),
    ],
  },
  {
    id: 'gaming-tech-culture',
    name: '游戏动作 · 科技社区热词',
    badge: 'Gaming / Culture',
    description:
      '动作游戏机制、独立游戏发版与 X / Hacker News / GitHub 社区高频缩写。',
    defaultEnabled: true,
    entries: [
      ...keep(
        ['DLC', 'NPC', 'FPS', 'RPG', 'MMORPG', 'Roguelike', 'TL;DR', 'LGTM', 'WIP', 'Steam'],
        'gaming-tech-culture',
      ),
      ...keep(['GOAT', 'FOMO'], 'gaming-tech-culture', { caseSensitive: true }),
      ...mapped(
        [
          ['Phantom Blade Zero', '影之刃零'],
          ['Soulslike', '类魂'],
          ['No Damage', '无伤'],
          ['Speedrun', '速通'],
          ['Hitbox', '判定框'],
          ['Cooldown', '冷却时间'],
          ['Early Access', '抢先体验'],
          ['Patch Notes', '更新日志'],
          ['Indie Game', '独立游戏'],
          ['Parry', '弹反'],
          ['New Game Plus', '二周目'],
        ],
        'gaming-tech-culture',
      ),
    ],
  },
];

function makeGlossaryOverrideKey(key: string, domain?: string): string {
  return `${key.trim().toLowerCase()}@@${(domain ?? '').trim().toLowerCase()}`;
}

/**
 * Merges user `config.glossary` with enabled `BUILTIN_GLOSSARY_PACKS`.
 * - User entries override matching built-in pack entries on `(k.lower, domain.lower)`.
 * - User entries with `enabled === false` are omitted AND suppress any matching built-in entry.
 */
export function resolveEffectiveGlossary(
  config: Pick<MarginConfig, 'glossary' | 'enabledGlossaryPacks'>,
): GlossaryEntry[] {
  const enabledPackSet = new Set<string>(
    Array.isArray(config.enabledGlossaryPacks)
      ? config.enabledGlossaryPacks
      : BUILTIN_GLOSSARY_PACKS.filter((p) => p.defaultEnabled).map((p) => p.id),
  );

  const claimedOrSuppressed = new Set<string>();
  const activeUserEntries: GlossaryEntry[] = [];

  for (const rawEntry of config.glossary ?? []) {
    if (!rawEntry || typeof rawEntry.k !== 'string') continue;
    const trimmedK = rawEntry.k.trim();
    if (!trimmedK) continue;

    const overrideKey = makeGlossaryOverrideKey(trimmedK, rawEntry.domain);
    claimedOrSuppressed.add(overrideKey);

    if (rawEntry.enabled === false) {
      continue;
    }

    activeUserEntries.push(rawEntry);
  }

  const packEntries: GlossaryEntry[] = [];
  for (const pack of BUILTIN_GLOSSARY_PACKS) {
    if (!enabledPackSet.has(pack.id)) continue;
    for (const entry of pack.entries) {
      if (entry.enabled === false) continue;
      const overrideKey = makeGlossaryOverrideKey(entry.k, entry.domain);
      if (claimedOrSuppressed.has(overrideKey)) continue;
      claimedOrSuppressed.add(overrideKey);
      packEntries.push(entry);
    }
  }

  return [...activeUserEntries, ...packEntries];
}

/**
 * Parses bulk plain-text glossary rules:
 * - `source = target` or `source => target` -> `{ k: source, v: target }`
 * - Bare `KeepOriginalTerm` (or `KeepOriginalTerm =`) -> `{ k: KeepOriginalTerm, v: "" }`
 * - Lines starting with `#` and blank lines are ignored.
 */
export function parseGlossaryBulkText(text: string): GlossaryEntry[] {
  const deduped = new Map<string, GlossaryEntry>();
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    let k = '';
    let v = '';

    const arrowIdx = trimmed.indexOf('=>');
    if (arrowIdx !== -1) {
      k = trimmed.slice(0, arrowIdx).trim();
      v = trimmed.slice(arrowIdx + 2).trim();
    } else {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        k = trimmed.slice(0, eqIdx).trim();
        v = trimmed.slice(eqIdx + 1).trim();
      } else {
        k = trimmed;
        v = '';
      }
    }

    if (!k) continue;
    let domain: string | undefined;
    const domainTargetMatch = /^(.*?)\s+@([*A-Za-z0-9.-]+)$/.exec(v);
    if (domainTargetMatch) {
      v = domainTargetMatch[1].trim();
      domain = domainTargetMatch[2].trim();
    } else if (v === '') {
      const domainKeyMatch = /^(.*?)\s+@([*A-Za-z0-9.-]+)$/.exec(k);
      if (domainKeyMatch) {
        k = domainKeyMatch[1].trim();
        domain = domainKeyMatch[2].trim();
      }
    }
    if (!k) continue;
    const dedupKey = `${k.toLowerCase()}@@${(domain ?? '').toLowerCase()}`;
    deduped.set(dedupKey, {
      k,
      v,
      ...(domain ? { domain } : {}),
    });
  }

  return Array.from(deduped.values());
}

/**
 * Formats glossary entries into clean bulk-editable text (`source = target` or bare `KeepOriginalTerm`).
 */
export function formatGlossaryBulkText(entries: readonly GlossaryEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry || entry.enabled === false) continue;
    const k = String(entry.k ?? '').trim();
    if (!k) continue;
    const v = String(entry.v ?? '').trim();
    const domainSuffix = entry.domain?.trim() ? ` @${entry.domain.trim()}` : '';
    lines.push(v === '' ? `${k}${domainSuffix}` : `${k} = ${v}${domainSuffix}`);
  }
  return lines.join('\n');
}
