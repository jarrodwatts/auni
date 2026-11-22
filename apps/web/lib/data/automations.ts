import {
  automationFireWireSchema,
  automationWireSchema,
  type AutomationFireWire,
  type AutomationRuleId,
  type AutomationWire,
  type SpecialistId,
  type ThreadId,
} from "@auni/shared";
import { z } from "zod";

import { requestCore } from "@/lib/core";

/**
 * What Auni watches for a thread or a specialist, when those watches fired
 * and what Auni said, and pausing or deleting one.
 */

export type WatchScope = { readonly threadId: ThreadId } | { readonly specialistId: SpecialistId };

function filter(scope: WatchScope): string {
  return "threadId" in scope
    ? `thread_id=${scope.threadId}`
    : `specialist_id=${scope.specialistId}`;
}

const watchesSchema = z.object({ automations: z.array(automationWireSchema) });
const firesSchema = z.object({ fires: z.array(automationFireWireSchema) });
const watchSchema = z.object({ automation: automationWireSchema });

export async function listWatches(
  scope: WatchScope,
  signal?: AbortSignal,
): Promise<AutomationWire[]> {
  const body = await requestCore(`automations?${filter(scope)}`, { signal });
  return watchesSchema.parse(body).automations;
}

export async function listWatchFires(
  scope: WatchScope,
  signal?: AbortSignal,
): Promise<AutomationFireWire[]> {
  const body = await requestCore(`automations/fires?${filter(scope)}`, { signal });
  return firesSchema.parse(body).fires;
}

export async function setWatchPaused(
  id: AutomationRuleId,
  paused: boolean,
): Promise<AutomationWire> {
  const body = await requestCore(`automations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ paused }),
  });
  return watchSchema.parse(body).automation;
}

export async function deleteWatch(id: AutomationRuleId): Promise<AutomationWire> {
  const body = await requestCore(`automations/${id}`, { method: "DELETE" });
  return watchSchema.parse(body).automation;
}
