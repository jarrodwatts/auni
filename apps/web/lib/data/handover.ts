import {
  handedOverSchema,
  handoverOfferSchema,
  handoverStatusSchema,
  type HandedOverWire,
  type HandoverOffer,
  type HandoverStatus,
} from "@auni/shared";
import { useQuery } from "@tanstack/react-query";

import { requestCore } from "@/lib/core";

/**
 * Handing Auni over to one of the owner's machines that stays on: core's `GET /handover` (their
 * machines from Tailscale, and how a handover stands), `POST /handover` (the command to run
 * there, shown once) and `DELETE /handover`. Once Auni is handed over, the laptop's core answers
 * every request with where it went.
 */

const HANDOVER_KEY = ["handover"] as const;

async function getHandover(): Promise<HandoverStatus> {
  return handoverStatusSchema.parse(await requestCore("handover", { method: "GET" }));
}

/**
 * How a handover stands, read again every two seconds while one is under way, so the pane
 * follows the new machine as it asks, opens the bundle and takes Auni over.
 */
export function useHandover({ enabled }: { readonly enabled: boolean }) {
  return useQuery({
    queryKey: HANDOVER_KEY,
    queryFn: getHandover,
    enabled,
    refetchInterval: (query) => {
      const stage = query.state.data?.handover?.stage;
      return stage === "waiting" || stage === "handing" || stage === "handed" ? 2_000 : false;
    },
  });
}

/** Opens a handover to one of the owner's machines: the command to run there, shown once. */
export async function offerHandover(machine: string): Promise<HandoverOffer> {
  const body = await requestCore("handover", {
    method: "POST",
    body: JSON.stringify({ machine }),
  });
  return handoverOfferSchema.parse(body);
}

export async function cancelHandover(): Promise<void> {
  await requestCore("handover", { method: "DELETE" });
}

/**
 * Where Auni went, when this one has been handed over (core's 409 `handed_over`); null while it
 * runs here. Read raw, since a handed-over core answers nothing else.
 */
export async function handedOverTo(): Promise<HandedOverWire | null> {
  const response = await fetch("/core/handover", {
    cache: "no-store",
    credentials: "same-origin",
  }).catch(() => null);
  if (response?.status !== 409) return null;
  const said = handedOverSchema.safeParse(await response.json().catch(() => null));
  return said.success ? said.data : null;
}
