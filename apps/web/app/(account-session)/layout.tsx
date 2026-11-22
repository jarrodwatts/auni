import type { ReactNode } from "react";

import { OwnerProvider } from "@/components/auth/owner-provider";
import { Look } from "@/lib/look";

export default function AccountSessionLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <OwnerProvider>
      <Look />
      {children}
    </OwnerProvider>
  );
}
