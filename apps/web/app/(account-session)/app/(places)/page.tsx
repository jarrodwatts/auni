import { threadIdSchema } from "@auni/shared";
import type { Metadata } from "next";

import { MoneyScreen } from "@/components/portfolio/money-screen";

export const metadata: Metadata = { title: "Money" };

/** `?take=<id>` opens that take, as a link from its chat does. */
export default async function MoneyPage({
  searchParams,
}: {
  searchParams: Promise<{ take?: string | string[] }>;
}) {
  const take = threadIdSchema.safeParse((await searchParams).take);
  return <MoneyScreen openTake={take.success ? take.data : null} />;
}
