import type { ReactNode } from "react";

/** The soft fill behind first run and every notice before the app. */
const ONBOARDING_FILL = "bg-linear-to-b from-background to-floor";

export function OnboardingBackdrop({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className={`relative flex min-h-dvh items-stretch justify-center overflow-x-hidden sm:items-center sm:p-6 ${ONBOARDING_FILL}`}
    >
      {children}
    </main>
  );
}
