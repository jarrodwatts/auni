import { specialistIdSchema } from "@auni/shared";
import type { Metadata } from "next";

import { ActivityScreen } from "@/components/activity/activity-screen";

export const metadata: Metadata = { title: "Activity" };

/** `?specialist=<id>` opens it filtered to that specialist, as its page's record links. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ specialist?: string | string[] }>;
}) {
  const only = specialistIdSchema.safeParse((await searchParams).specialist);
  return <ActivityScreen initialOnly={only.success ? only.data : null} />;
}
