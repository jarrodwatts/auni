import type { z } from "zod";

import type { TurnTrigger } from "../conversation/history.ts";
import { keepCutTurn, runConversationTurn } from "../conversation/turn.ts";
import { turnKind } from "./kinds.ts";
import { defineJob } from "./queue.ts";

/** A message's turn goes by the message's id; any other by its job's. */
const turnId = (data: z.infer<typeof turnKind.data>, jobId: string) =>
  "messageId" in data ? data.messageId : jobId;

const triggerOf = (data: z.infer<typeof turnKind.data>): TurnTrigger =>
  "messageId" in data
    ? { kind: "message", messageId: data.messageId }
    : {
        kind: "background",
        reason: data.reason,
        ...(data.fires ? { fires: data.fires } : {}),
        ...(data.briefed ? { briefed: data.briefed } : {}),
      };

/**
 * One turn of a thread. It ends, cut off, when the machine sleeps or Auni stops. A turn can move
 * money, so one cut off midway is never simply run again: what it showed is kept, with a line
 * saying so and a reply that asks again (keepCutTurn), and one that had ended is left as it is.
 * A background turn that did nothing before it failed or was cut off runs again, as this same
 * job (conversation/turn.ts).
 */
export const turnJob = defineJob({
  kind: turnKind,
  endsOnSleep: true,
  run: (data, job) =>
    runConversationTurn({
      threadId: data.threadId,
      turnId: turnId(data, job.id),
      trigger: triggerOf(data),
      ended: job.signal,
      queuedAt: job.createdAt,
    }),
  cutShort: (data, job) =>
    keepCutTurn({
      threadId: data.threadId,
      turnId: turnId(data, job.id),
      trigger: triggerOf(data),
      firstRun: job.attempts <= 1,
    }),
});
