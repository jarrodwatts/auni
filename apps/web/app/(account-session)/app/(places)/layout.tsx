import type { ReactNode } from "react";

import { PlaceWorkspace } from "@/components/places/place-workspace";

export default function PlacesLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <PlaceWorkspace>{children}</PlaceWorkspace>;
}
