import {
  DEFAULT_SSE_IDLE_TIMEOUT_MS,
  ProviderTimeoutError,
} from './timeout';

export interface SseEventFrame {
  event?: string;
  data: string;
}

export interface SseStreamSummary {
  sawDone: boolean;
  stoppedByCallback: boolean;
}

interface SseParseState {
  buffer: string;
  pendingCr: boolean;
  sawDone: boolean;
  stoppedByCallback: boolean;
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

async function readChunkWithIdleGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs = DEFAULT_SSE_IDLE_TIMEOUT_MS,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) {
    void reader.cancel().catch(() => undefined);
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  let guardError: Error | null = null;

  const guardPromise = new Promise<never>((_, reject) => {
    if (signal) {
      onAbort = () => {
        const err = new DOMException('The operation was aborted.', 'AbortError');
        guardError = err;
        reject(err);
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new ProviderTimeoutError(idleTimeoutMs, 'stream-idle');
        guardError = err;
        reject(err);
        void reader.cancel().catch(() => undefined);
      }, idleTimeoutMs);
    }
  });

  try {
    const result = await Promise.race([reader.read(), guardPromise]);
    if (guardError) {
      throw guardError;
    }
    return result;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
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
  idleTimeoutMs = DEFAULT_SSE_IDLE_TIMEOUT_MS,
): Promise<SseStreamSummary> {
  if (!response.body) {
    // Fallback if test mock omitted ReadableStream body
    const text = new TextDecoder('utf-8').decode(await response.arrayBuffer());
    const state: SseParseState = {
      buffer: '',
      pendingCr: false,
      sawDone: false,
      stoppedByCallback: false,
    };
    parseSseTextChunk(text + '\n\n', state, onEvent);
    return {
      sawDone: state.sawDone,
      stoppedByCallback: state.stoppedByCallback,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const state: SseParseState = {
    buffer: '',
    pendingCr: false,
    sawDone: false,
    stoppedByCallback: false,
  };
  let reachedNaturalEof = false;

  try {
    while (true) {
      const { value, done } = await readChunkWithIdleGuard(
        reader,
        signal,
        idleTimeoutMs,
      );
      if (done) {
        reachedNaturalEof = true;
        const trailing = decoder.decode();
        if (trailing) {
          const stopped = parseSseTextChunk(trailing, state, onEvent);
          if (stopped) break;
        }
        if (state.pendingCr) {
          state.pendingCr = false;
          const stopped = parseSseTextChunk('\n', state, onEvent);
          if (stopped) break;
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
        break;
      }
    }
    return {
      sawDone: state.sawDone,
      stoppedByCallback: state.stoppedByCallback,
    };
  } finally {
    if (!reachedNaturalEof) {
      void reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore already released reader
    }
  }
}

function parseSseTextChunk(
  chunkText: string,
  state: SseParseState,
  onEvent: (frame: SseEventFrame) => void | 'stop',
): boolean {
  if (chunkText.length === 0) {
    return false;
  }

  let text = chunkText;
  if (state.pendingCr) {
    state.pendingCr = false;
    if (!text.startsWith('\n')) {
      text = `\n${text}`;
    }
  }
  if (text.endsWith('\r')) {
    state.pendingCr = true;
    text = text.slice(0, -1);
  }

  state.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

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
      state.sawDone = true;
      return true;
    }

    const action = onEvent({
      ...(eventName ? { event: eventName } : {}),
      data,
    });
    if (action === 'stop') {
      state.stoppedByCallback = true;
      return true;
    }
  }

  return false;
}
