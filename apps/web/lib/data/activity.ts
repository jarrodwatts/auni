import { activityWireSchema, type ActivityWire, type ThreadId } from "@auni/shared";

import { requestCore } from "@/lib/core";

/**
 * Activity: what happened to the person's money (`GET /activity`), all of it
 * or what one thread took part in, and that they've looked (`POST /activity/seen`).
 */

export async function getActivity(
  only: ThreadId | null,
  signal?: AbortSignal,
): Promise<ActivityWire> {
  const path = only ? `activity?${new URLSearchParams({ thread: only })}` : "activity";
  return activityWireSchema.parse(await requestCore(path, { method: "GET", signal }));
}

export async function markActivitySeen(): Promise<void> {
  await requestCore("activity/seen", { method: "POST" });
}
