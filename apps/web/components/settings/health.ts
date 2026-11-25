import type { DoctorFindingWire } from "@auni/shared";

/** Each part Auni checks, by the name the owner knows it by. */
const PARTS: Readonly<Record<string, string>> = {
  version: "Auni",
  database: "Auni's records",
  runner: "Auni's work",
  service: "Keeping Auni running",
  rpc: "Networks",
  brain: "Your AI",
  wallet: "Your wallet",
  apps: "Apps",
  web: "This web app",
  "always-on": "Reaching Auni",
};

export function partName(check: string): string {
  return PARTS[check] ?? check;
}

/** How Auni stands, in a line, and what of it needs the owner, first. */
export function healthOf(findings: readonly DoctorFindingWire[]): {
  readonly headline: string;
  readonly needs: readonly DoctorFindingWire[];
} {
  const needs = findings.filter(({ status }) => status === "fix");
  return {
    headline:
      needs.length === 0
        ? "Everything's working"
        : needs.length === 1
          ? "1 thing needs you"
          : `${needs.length} things need you`,
    needs,
  };
}
