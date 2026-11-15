import type { ProviderConfig } from '@shared/types';
import { readSseStream } from './sse';
import {
  DEFAULT_AI_CONNECT_TIMEOUT_MS,
  DEFAULT_SSE_IDLE_TIMEOUT_MS,
  createLinkedTimeoutScope,
} from './timeout';
import {
  type AiCompletionRequestParams,
  ProviderHttpError,
  ProviderTruncatedResponseError,
  describeBodyMetadata,
} from './types';

export const ANTHROPIC_API_VERSION = '2023-06-01';

function buildAnthropicImageBlock(imageDataUrl: string): Record<string, unknown> {
  const dataUrlMatch = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(
    imageDataUrl.trim(),
  );
  if (dataUrlMatch) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUrlMatch[1].toLowerCase(),
        data: dataUrlMatch[2].replace(/\s+/g, ''),
      },
    };
  }
  return {
    type: 'image',
    source: {
      type: 'url',
      url: imageDataUrl,
    },
  };
}

export function buildAnthropicMessagesRequestBody(params: {
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

  const thinkingPolicy = provider.thinkingPolicy;
  const thinkingEnabled = thinkingPolicy.mode === 'enabled';
  const budgetTokens =
    thinkingPolicy.mode === 'enabled'
      ? (thinkingPolicy.budgetTokens ?? 2048)
      : 2048;
  const maxTokens = thinkingEnabled
    ? Math.max(8192, budgetTokens + 8192)
    : 8192;

  const userContent = imageDataUrl
    ? [
        buildAnthropicImageBlock(imageDataUrl),
        { type: 'text', text: userPrompt },
      ]
    : [{ type: 'text', text: userPrompt }];

  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: userContent,
      },
    ],
  };

  if (systemPrompt.trim() !== '') {
    body.system = systemPrompt;
  }

  // Anthropic forbids custom temperature when extended thinking is enabled
  if (
    !thinkingEnabled &&
    effectiveTemperature !== undefined &&
    Number.isFinite(effectiveTemperature)
  ) {
    body.temperature = effectiveTemperature;
  }

  if (thinkingEnabled) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: budgetTokens,
    };
  }

  if (stream) {
    body.stream = true;
  }

  return body;
}

export async function executeAnthropicMessagesCall(
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
    'anthropic-version': ANTHROPIC_API_VERSION,
    ...(stream ? { Accept: 'text/event-stream' } : {}),
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    ...(provider.extraHeaders ?? {}),
  };

  const body = buildAnthropicMessagesRequestBody({
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
      scope.clearTimer();
      let fullContent = '';
      let stopReason: string | null = null;
      let sawMessageStop = false;

      const sseSummary = await readSseStream(
        response,
        (frame) => {
          if (frame.event === 'message_stop') {
            sawMessageStop = true;
          }
          const trimmed = frame.data.trim();
          if (!trimmed) {
            return sawMessageStop ? 'stop' : undefined;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            return sawMessageStop ? 'stop' : undefined;
          }

          const eventType = String(parsed.type ?? frame.event ?? '');
          if (eventType === 'error') {
            throw new ProviderHttpError({
              status: 502,
              bodyText: JSON.stringify(parsed.error ?? parsed),
              endpoint,
              usedApiKey: apiKey,
            });
          }

          const delta = parsed.delta as Record<string, unknown> | undefined;
          const msgObj = parsed.message as Record<string, unknown> | undefined;
          const candidateStopReason =
            typeof delta?.stop_reason === 'string' && delta.stop_reason
              ? delta.stop_reason
              : typeof parsed.stop_reason === 'string' && parsed.stop_reason
                ? parsed.stop_reason
                : typeof msgObj?.stop_reason === 'string' && msgObj.stop_reason
                  ? msgObj.stop_reason
                  : null;
          if (candidateStopReason) {
            stopReason = candidateStopReason;
          }

          if (eventType === 'message_stop' || sawMessageStop) {
            sawMessageStop = true;
            return 'stop';
          }
          if (eventType === 'content_block_delta') {
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              fullContent += delta.text;
              onDelta?.(delta.text);
            }
          }
          return undefined;
        },
        scope.signal,
        streamIdleTimeoutMs,
      );

      if (stopReason === 'max_tokens' || stopReason === 'refusal') {
        throw new ProviderTruncatedResponseError({
          reason: stopReason,
          protocol: 'anthropic-messages',
          httpStatus: response.status,
        });
      }

      const hasTerminalStop =
        sawMessageStop ||
        sseSummary.sawDone ||
        stopReason === 'end_turn' ||
        stopReason === 'stop_sequence' ||
        stopReason === 'stop';
      if (!hasTerminalStop) {
        throw new ProviderTruncatedResponseError({
          reason: 'premature-eof',
          protocol: 'anthropic-messages',
          httpStatus: response.status,
        });
      }

      return { content: fullContent, httpStatus: response.status };
    }

    const rawText = new TextDecoder('utf-8').decode(
      await scope.race(response.arrayBuffer()),
    );
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Invalid JSON from Anthropic endpoint (${describeBodyMetadata(rawText, response)})`,
      );
    }

    if (json.type === 'error' || json.error) {
      throw new ProviderHttpError({
        status: 502,
        bodyText: JSON.stringify(json.error ?? json),
        endpoint,
        usedApiKey: apiKey,
      });
    }

    const stopReason =
      typeof json.stop_reason === 'string' ? json.stop_reason : null;
    if (stopReason === 'max_tokens' || stopReason === 'refusal') {
      throw new ProviderTruncatedResponseError({
        reason: stopReason,
        protocol: 'anthropic-messages',
        httpStatus: response.status,
      });
    }

    const contentBlocks = Array.isArray(json.content) ? json.content : [];
    const textParts: string[] = [];
    for (const block of contentBlocks) {
      if (block && typeof block === 'object') {
        const rec = block as Record<string, unknown>;
        if (rec.type === 'text' && typeof rec.text === 'string') {
          textParts.push(rec.text);
        }
      }
    }

    return {
      content: textParts.join(''),
      httpStatus: response.status,
    };
  } finally {
    scope.cleanup();
  }
}
