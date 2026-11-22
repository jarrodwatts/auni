import { threadIdSchema } from "@auni/shared";
import type { Metadata } from "next";

import { ActivityScreen } from "@/components/activity/activity-screen";

export const metadata: Metadata = { title: "Activity" };

/** `?thread=<id>` opens it filtered to that thread, as its inspector panel links. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string | string[] }>;
}) {
  const only = threadIdSchema.safeParse((await searchParams).thread);
  return <ActivityScreen initialOnly={only.success ? only.data : null} />;
}
