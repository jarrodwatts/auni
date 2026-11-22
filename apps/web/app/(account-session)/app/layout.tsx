import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ProductRoute } from "@/components/app/product-route";
import { TITLE_TEMPLATE } from "@/lib/site";

export const metadata: Metadata = {
  description: "Talk with auni about your money, positions and plans.",
  robots: {
    follow: false,
    index: false,
  },
  title: { default: "Your money", template: TITLE_TEMPLATE },
};

export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <ProductRoute>{children}</ProductRoute>;
}
