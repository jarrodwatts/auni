"use client";

import type { Me } from "@auni/shared";
import type { ReactNode } from "react";

import { AppDialogs } from "@/components/app/app-dialogs";
import { StartingPointsReady } from "@/components/app/starting-points";
import { BackFromTheTerminal } from "@/components/auth/back-from-the-terminal";
import { ClientDataProvider } from "@/components/data/client-data-provider";
import { MoneyProvider } from "@/components/money/money-provider";
import { TimeZoneSync } from "@/components/personalization/time-zone-sync";
import { StarPrompt } from "@/components/star/star-prompt";

/**
 * The app for the owner's browser, which keeps a new chat's starting points ready from any page. Nothing opens over it by itself: first run ends on Auni's chat
 * and its starting points, and what Auni calls the owner is theirs to set in Settings, Profile.
 * An owner just back from the terminal lands where they were (`BackFromTheTerminal`).
 */
export function AuthenticatedProduct({
  me,
  children,
}: {
  readonly me: Me;
  readonly children: ReactNode;
}) {
  return (
    <ClientDataProvider me={me}>
      <MoneyProvider>
        {children}
        <AppDialogs />
        <TimeZoneSync />
        <BackFromTheTerminal />
        <StartingPointsReady />
        <StarPrompt />
      </MoneyProvider>
    </ClientDataProvider>
  );
}
