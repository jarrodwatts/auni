import { z } from "zod";

// Handing Auni over from the laptop to one of the owner's machines that stays on, as Settings
// shows it: `GET /handover` (the owner's machines, and how a handover stands), `POST /handover`
// (the command to run there), `DELETE /handover` (call it off). Once Auni is handed over, every
// request to the laptop's Auni is answered 409 `handed_over`, with where it went.

const handoverMachineSchema = z.object({
  id: z.string(),
  /** Its name on the tailnet: "home-server". */
  name: z.string(),
  /** As Tailscale says it: linux, macOS, windows, iOS, android. */
  os: z.string(),
  online: z.boolean(),
  /** Linux and macOS, and Windows inside WSL: a phone can't run Auni. */
  runsAuni: z.boolean(),
  /** The machine Auni runs on now. */
  here: z.boolean(),
});

export const handoverStatusSchema = z.object({
  tailnet: z.discriminatedUnion("state", [
    z.object({ state: z.literal("missing") }),
    z.object({ state: z.literal("off") }),
    z.object({ state: z.literal("on"), machines: z.array(handoverMachineSchema) }),
  ]),
  /** The handover under way or last ended, or null for none since Auni started. */
  handover: z
    .object({
      stage: z.enum(["waiting", "handing", "handed", "taken", "ended"]),
      machine: z.string(),
      expiresAt: z.iso.datetime(),
      ended: z
        .enum([
          "expired",
          "wrong_code",
          "cancelled",
          "cut_short",
          "no_answer",
          "declined",
          "failed",
        ])
        .optional(),
    })
    .nullable(),
});

/** What `POST /handover` answers: the one command the owner runs on the new machine, shown once. */
export const handoverOfferSchema = z.object({
  command: z.string(),
  machine: z.string(),
  expiresAt: z.iso.datetime(),
});

/** Where Auni went, which the laptop's Auni answers every request with once it's handed over. */
export const handedOverSchema = z.object({
  error: z.literal("handed_over"),
  to: z.string(),
  machine: z.string(),
  at: z.string(),
});

export type HandoverMachine = z.infer<typeof handoverMachineSchema>;
export type HandoverStatus = z.infer<typeof handoverStatusSchema>;
export type HandoverOffer = z.infer<typeof handoverOfferSchema>;
export type HandedOverWire = z.infer<typeof handedOverSchema>;
