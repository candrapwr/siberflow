/**
 * Parse a Server-Sent Events response body into a stream of parsed JSON
 * payloads. Yields one value per `data: <json>` line. Stops on `[DONE]`.
 * Ignores other SSE fields (event:, id:, retry:) — relies on the JSON
 * payload itself carrying any type discriminator.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") return;
          try {
            yield JSON.parse(payload);
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
