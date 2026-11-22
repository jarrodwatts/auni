import type { Metadata } from "next";

import { AppsScreen } from "@/components/apps/apps-screen";

export const metadata: Metadata = { title: "Apps" };

/** `?app=<id>` opens that app's sheet over the list. */
export default function AppsPage() {
  return <AppsScreen />;
}
