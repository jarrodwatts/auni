/** One server-sent event: its type ("message" unless named), its id, and its data lines joined. */
interface SseFrame {
  readonly event: string;
  readonly id: string | null;
  readonly data: string;
}

/**
 * The frames of a text/event-stream body, as the HTML spec reads them: fields up to a blank line,
 * comment lines (": keep-alive") skipped, multi-line data joined with newlines. A frame cut off
 * by the stream ending is dropped, as a browser drops it.
 */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  let buffer = "";
  let event = "";
  let id: string | null = null;
  let data: string[] = [];
  const decoder = new TextDecoder();
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    // A lone CR as a line end is left out: one split across chunks would end a frame early.
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") {
        if (data.length > 0) yield { event: event || "message", id, data: data.join("\n") };
        event = "";
        id = null;
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "data") data.push(value);
    }
  }
}
