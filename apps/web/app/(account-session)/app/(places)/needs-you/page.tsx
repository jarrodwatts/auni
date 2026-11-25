import type { Metadata } from "next";

import { NeedsYouPlace } from "@/components/places/needs-you-place";

export const metadata: Metadata = { title: "Needs you" };

export default function NeedsYouPage() {
  return <NeedsYouPlace />;
}
