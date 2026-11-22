import { z } from "zod";

import { requestCore } from "@/lib/core";

/**
 * A one-time code, good for 15 minutes, that makes whoever sends it to Auni on that chat app, in a
 * direct chat, the owner there; and a link that opens the chat with it.
 */
export async function pairChannel(
  channel: string,
): Promise<{ readonly code: string; readonly hint: string }> {
  return z
    .object({ code: z.string(), hint: z.string() })
    .parse(
      await requestCore(`channels/${encodeURIComponent(channel)}/pairing`, { method: "POST" }),
    );
}
