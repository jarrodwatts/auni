import { ASK_DONE, type ActionStatus, type AskCardWire } from "@auni/shared";

/** Where an ask stands, as its card says it: waiting on the owner's tap, or how it ended. */
type AskStanding =
  | { readonly kind: "waiting" }
  | { readonly kind: "working" }
  | { readonly kind: "ended"; readonly label: string; readonly tone: "done" | "quiet" };

export function askStanding(
  ask: AskCardWire["ask"],
  status: ActionStatus,
  error: string | null,
): AskStanding {
  switch (status) {
    case "awaiting_permission":
      return { kind: "waiting" };
    case "running":
      return { kind: "working" };
    case "done":
      return { kind: "ended", label: ASK_DONE[ask], tone: "done" };
    case "failed":
      return { kind: "ended", label: error ?? "Didn't go through", tone: "quiet" };
    case "cancelled":
      return { kind: "ended", label: "Declined", tone: "quiet" };
    case "replaced":
      return { kind: "ended", label: "Replaced by a newer card", tone: "quiet" };
    case "retracted":
      return { kind: "ended", label: error ?? "Taken back by Auni", tone: "quiet" };
  }
}
