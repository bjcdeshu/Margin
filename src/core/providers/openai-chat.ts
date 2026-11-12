import type { ProviderConfig } from '@shared/types';
import { readSseStream } from './sse';
import {
  DEFAULT_AI_CONNECT_TIMEOUT_MS,
  DEFAULT_SSE_IDLE_TIMEOUT_MS,
  createLinkedTimeoutScope,
} from './timeout';
import { type AiCompletionRequestParams, ProviderHttpError } from './types';

function extractOpenAiContentString(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const rec = part as Record<string, unknown>;
          if (typeof rec.text === 'string') return rec.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function applyOpenAiThinkingPolicy(
  body: Record<string, unknown>,
  provider: Pick<ProviderConfig, 'preset' | 'model' | 'thinkingPolicy'>,
): void {
  const { thinkingPolicy, preset, model } = provider;
  if (thinkingPolicy.mode === 'provider-default') {
    // Never inject hardcoded `thinking: disabled` by default (fixes Harley #129 on glm5.3-fs)
    return;
  }

  const isZhipuModel = preset === 'zhipu' || /^glm-/i.test(model.trim());
  const isOpenAiReasoning = /^(?:o[1-9]|gpt-(?:[5-9]|\d{2,}))(?:[-._]|$)/i.test(
    model.trim(),
  );
  const isQwenModel = /\b(?:qwen|qwq)/i.test(model.trim());

  if (thinkingPolicy.mode === 'disabled') {
    if (isZhipuModel) {
      body.thinking = { type: 'disabled' };
    } else if (isOpenAiReasoning) {
      body.reasoning_effort = 'low';
    } else if (isQwenModel) {
      body.enable_thinking = false;
    } else {
      body.thinking = { type: 'disabled' };
    }
    return;
  }

  if (thinkingPolicy.mode === 'enabled') {
    if (isZhipuModel) {
      body.thinking = { type: 'enabled' };
    } else if (isOpenAiReasoning) {
      body.reasoning_effort = 'medium';
    } else if (isQwenModel) {
      body.enable_thinking = true;
      if (thinkingPolicy.budgetTokens) {
        body.thinking_budget = thinkingPolicy.budgetTokens;
      }
    } else {
      body.thinking = {
        type: 'enabled',
        ...(thinkingPolicy.budgetTokens
          ? { budget_tokens: thinkingPolicy.budgetTokens }
          : {}),
      };
    }
  }
}

export function buildOpenAiChatRequestBody(params: {
  provider: ProviderConfig;
  systemPrompt: string;
  userPrompt: string;
  imageDataUrl?: string;
  effectiveTemperature?: number;
  stream: boolean;
}): Record<string, unknown> {
  const {
    provider,
    systemPrompt,
    userPrompt,
    imageDataUrl,
    effectiveTemperature,
    stream,
  } = params;

  const messages: Array<Record<string, unknown>> = [];
  if (systemPrompt.trim() !== '') {
    messages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  if (imageDataUrl) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        {
          type: 'image_url',
          image_url: { url: imageDataUrl },
        },
      ],
    });
  } else {
    messages.push({
      role: 'user',
      content: userPrompt,
    });
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
  };

  // Strictly include `temperature` ONLY when resolved to a finite custom value.
  // Never force `0` or Zhipu `0.01`!
  if (
    effectiveTemperature !== undefined &&
    Number.isFinite(effectiveTemperature)
  ) {
    body.temperature = effectiveTemperature;
  }

  if (stream) {
    body.stream = true;
  }

  applyOpenAiThinkingPolicy(body, provider);
  return body;
}

export async function executeOpenAiChatCall(
  params: AiCompletionRequestParams,
): Promise<{ content: string; httpStatus: number }> {
  const {
    provider,
    endpoint,
    apiKey,
    systemPrompt,
    userPrompt,
    imageDataUrl,
    effectiveTemperature,
    stream,
    onDelta,
    fetchImpl,
    requestTimeoutMs = DEFAULT_AI_CONNECT_TIMEOUT_MS,
    streamIdleTimeoutMs = DEFAULT_SSE_IDLE_TIMEOUT_MS,
    signal,
  } = params;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(stream ? { Accept: 'text/event-stream' } : {}),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(provider.extraHeaders ?? {}),
  };

  const body = buildOpenAiChatRequestBody({
    provider,
    systemPrompt,
    userPrompt,
    imageDataUrl,
    effectiveTemperature,
    stream,
  });

  const scope = createLinkedTimeoutScope(requestTimeoutMs, signal, 'connect');
  try {
    const response = await scope.race(
      fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: scope.signal,
      }),
    );

    if (!response.ok) {
      const errorText = new TextDecoder('utf-8').decode(
        await scope.race(response.arrayBuffer()),
      );
      throw new ProviderHttpError({
        status: response.status,
        bodyText: errorText,
        endpoint,
        usedApiKey: apiKey,
      });
    }

    if (stream) {
      // Headers arrived; switch from connect timer to per-chunk SSE idle timer
      scope.clearTimer();
      let fullContent = '';
      await readSseStream(
        response,
        (frame) => {
          const trimmed = frame.data.trim();
          if (!trimmed) return;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            return;
          }
          if (parsed.error) {
            throw new ProviderHttpError({
              status: 502,
              bodyText: JSON.stringify(parsed.error),
              endpoint,
              usedApiKey: apiKey,
            });
          }
          const choices = parsed.choices;
          if (!Array.isArray(choices) || choices.length === 0) return;
          const firstChoice = choices[0] as Record<string, unknown> | undefined;
          const deltaObj = firstChoice?.delta as
            | Record<string, unknown>
            | undefined;
          const deltaText = extractOpenAiContentString(
            deltaObj?.content ?? firstChoice?.text,
          );
          if (deltaText) {
            fullContent += deltaText;
            onDelta?.(deltaText);
          }
        },
        scope.signal,
        streamIdleTimeoutMs,
      );

      return { content: fullContent, httpStatus: response.status };
    }

    const rawText = new TextDecoder('utf-8').decode(
      await scope.race(response.arrayBuffer()),
    );
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      throw new Error(`Invalid JSON from OpenAI-compatible endpoint: ${rawText.slice(0, 200)}`);
    }

    if (json.error && !Array.isArray(json.choices)) {
      throw new ProviderHttpError({
        status: 502,
        bodyText: JSON.stringify(json.error),
        endpoint,
        usedApiKey: apiKey,
      });
    }

    const choices = json.choices;
    const firstChoice = Array.isArray(choices)
      ? (choices[0] as Record<string, unknown> | undefined)
      : undefined;
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    const content = extractOpenAiContentString(
      message?.content ?? firstChoice?.text ?? '',
    );

    return {
      content,
      httpStatus: response.status,
    };
  } finally {
    scope.cleanup();
  }
}
