import { threadIdSchema } from "@auni/shared";
import { redirect } from "next/navigation";

/** Activity is part of Money now: a link to one thread's opens that take there. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string | string[] }>;
}) {
  const thread = threadIdSchema.safeParse((await searchParams).thread);
  redirect(thread.success ? `/app?take=${thread.data}` : "/app");
}
