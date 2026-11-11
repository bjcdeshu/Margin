export interface SseEventFrame {
  event?: string;
  data: string;
}

function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (typeof chunk === 'string') {
    return new TextEncoder().encode(chunk);
  }
  return new Uint8Array(0);
}

/**
 * Decodes an HTTP Server-Sent Events (SSE) stream strictly via `TextDecoder('utf-8')`
 * over raw `ArrayBuffer` / `Uint8Array` byte chunks so misconfigured proxy charsets
 * never corrupt multi-byte CJK UTF-8 sequences.
 */
export async function readSseStream(
  response: Response,
  onEvent: (frame: SseEventFrame) => void | 'stop',
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) {
    // Fallback if test mock omitted ReadableStream body
    const text = new TextDecoder('utf-8').decode(await response.arrayBuffer());
    parseSseTextChunk(text + '\n\n', { buffer: '' }, onEvent);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const state = { buffer: '' };

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      const { value, done } = await reader.read();
      if (done) {
        const trailing = decoder.decode();
        if (trailing) {
          state.buffer += trailing;
        }
        if (state.buffer.trim() !== '') {
          parseSseTextChunk('\n\n', state, onEvent);
        }
        break;
      }

      const bytes = toUint8Array(value);
      const decodedText = decoder.decode(bytes, { stream: true });
      const shouldStop = parseSseTextChunk(decodedText, state, onEvent);
      if (shouldStop) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore already released reader
    }
  }
}

function parseSseTextChunk(
  chunkText: string,
  state: { buffer: string },
  onEvent: (frame: SseEventFrame) => void | 'stop',
): boolean {
  state.buffer += chunkText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  let boundaryIdx: number;
  while ((boundaryIdx = state.buffer.indexOf('\n\n')) !== -1) {
    const rawBlock = state.buffer.slice(0, boundaryIdx);
    state.buffer = state.buffer.slice(boundaryIdx + 2);

    if (!rawBlock.trim()) continue;

    let eventName: string | undefined;
    const dataLines: string[] = [];

    for (const line of rawBlock.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }

      if (field === 'event') {
        eventName = value.trim();
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }

    if (dataLines.length === 0 && !eventName) {
      continue;
    }

    const data = dataLines.join('\n');
    if (data.trim() === '[DONE]') {
      return true;
    }

    const action = onEvent({
      ...(eventName ? { event: eventName } : {}),
      data,
    });
    if (action === 'stop') {
      return true;
    }
  }

  return false;
}
