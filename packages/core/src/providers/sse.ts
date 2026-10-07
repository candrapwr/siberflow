/**
 * Parse a Server-Sent Events response body into a stream of parsed JSON
 * payloads. Yields one value per `data: <json>` line. Stops on `[DONE]`.
 * Ignores other SSE fields (event:, id:, retry:) — relies on the JSON
 * payload itself carrying any type discriminator.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  options: {
    idleTimeoutMs?: number | (() => number);
    initialTimeoutMs?: number;
  } = {},
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const idleTimeout = options.idleTimeoutMs ?? 0;
  const resolveIdleTimeoutMs = () =>
    typeof idleTimeout === "function" ? idleTimeout() : idleTimeout;
  const initialTimeoutMs = options.initialTimeoutMs ?? resolveIdleTimeoutMs();
  const startedAt = Date.now();
  let lastPayloadAt: number | null = null;

  try {
    while (true) {
      const readPromise = reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const activeTimeoutMs =
        lastPayloadAt === null ? initialTimeoutMs : resolveIdleTimeoutMs();
      const elapsed = Date.now() - (lastPayloadAt ?? startedAt);
      const remainingMs = Math.max(1, activeTimeoutMs - elapsed);
      let result: ReadableStreamReadResult<Uint8Array> | "idle-timeout";
      try {
        result = activeTimeoutMs > 0
          ? await Promise.race([
              readPromise,
              new Promise<"idle-timeout">((resolve) => {
                timer = setTimeout(() => resolve("idle-timeout"), remainingMs);
              }),
            ])
          : await readPromise;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      if (result === "idle-timeout") {
        // A few OpenAI-compatible gateways leave the HTTP stream open after
        // their final content chunk and omit both finish_reason and [DONE].
        // Cancel the pending read, then let the provider finalize the content
        // already collected instead of holding the agent/UI busy forever.
        await reader.cancel("SSE idle timeout").catch(() => undefined);
        await readPromise.catch(() => undefined);
        return;
      }

      const { done, value } = result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);

        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") return;
          try {
            const parsed = JSON.parse(payload);
            lastPayloadAt = Date.now();
            yield parsed;
          } catch {
            // skip malformed SSE chunk
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
