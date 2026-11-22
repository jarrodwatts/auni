import {
  actionQuoteWireSchema,
  actionWireSchema,
  pickDetailWireSchema,
  type ActionQuoteWire,
  type ActionRecordId,
  type ActionWire,
  type PickDetailWire,
} from "@auni/shared";
import { skipToken, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

import { CoreApiError, requestCore } from "@/lib/core";

/**
 * The taps on an action card or a withdrawal: Allow, Decline, Try again, and
 * a held move's Check again and Close, and the live read behind them. Each
 * reads or moves core's action row (POST /actions/:id/allow, /decline, /retry,
 * /check, /close, GET /actions/:id and /quote).
 */

const actionResponseSchema = z.object({ action: actionWireSchema });

/** What a card says when a tap's answer was lost: core may have it, and runs a move once. */
export const NOT_REACHED =
  "Auni couldn't confirm that went through. Trying again won't send it twice.";

export async function readAction(
  actionReference: ActionRecordId,
  signal?: AbortSignal,
): Promise<ActionWire> {
  const body = await requestCore(`actions/${actionReference}`, { method: "GET", signal });
  return actionResponseSchema.parse(body).action;
}

/** How often a move that is running is read again; one waiting or settled stays still. */
export const RUNNING_POLL_MS = 2_000;
/** How often a held move is: Auni reads it again by itself every ten minutes, and may settle it. */
const HELD_POLL_MS = 30_000;

/** Where an action's live read is kept, so a tap's answer can replace it. */
export const actionKey = (actionReference: ActionRecordId | null) =>
  ["action", actionReference] as const;

/** An action's live read, again every RUNNING_POLL_MS while it runs; none while there's no id. */
export function useLiveAction(actionReference: ActionRecordId | null): UseQueryResult<ActionWire> {
  return useQuery({
    queryKey: actionKey(actionReference),
    queryFn:
      actionReference === null ? skipToken : ({ signal }) => readAction(actionReference, signal),
    refetchInterval: ({ state: { data } }) =>
      data?.status !== "running"
        ? false
        : data.phase === "needs_owner"
          ? HELD_POLL_MS
          : RUNNING_POLL_MS,
  });
}

/**
 * One of the owner's two taps on a held move: Check again has Auni read it now, Close ends it
 * as it stands (POST /actions/:id/check, /close). Neither sends anything. A move no longer held
 * comes back as it is.
 */
export async function heldTap(
  actionReference: ActionRecordId,
  tap: "check" | "close",
): Promise<ActionWire> {
  try {
    const body = await requestCore(`actions/${actionReference}/${tap}`, { method: "POST" });
    return actionResponseSchema.parse(body).action;
  } catch (error) {
    if (error instanceof CoreApiError && error.code === "not_held")
      return readAction(actionReference);
    throw error;
  }
}

/** One tap on a single-action card; a row that already moved on comes back as it is. */
export async function decideAction(
  actionReference: ActionRecordId,
  decision: "allow" | "decline",
): Promise<ActionWire> {
  try {
    const body = await requestCore(`actions/${actionReference}/${decision}`, { method: "POST" });
    return actionResponseSchema.parse(body).action;
  } catch (error) {
    // Refused because the row had already moved on: read it as it is now.
    if (error instanceof CoreApiError && error.code === "not_awaiting_permission") {
      return readAction(actionReference);
    }
    throw error;
  }
}

/**
 * Try again on a step that didn't go through, as the run the card showed
 * failing (`attempts`): core runs it once more, or answers why not with a
 * CoreApiError (see retryProblem).
 */
export async function retryAction(
  actionReference: ActionRecordId,
  attempts: number,
): Promise<ActionWire> {
  const body = await requestCore(`actions/${actionReference}/retry`, {
    method: "POST",
    body: JSON.stringify({ attempts }),
  });
  return actionResponseSchema.parse(body).action;
}

const quoteResponseSchema = z.object({ quote: actionQuoteWireSchema });

/** A failed step priced again now, against what was approved (GET /actions/:id/quote); read only. */
export async function readQuote(
  actionReference: ActionRecordId,
  signal?: AbortSignal,
): Promise<ActionQuoteWire> {
  const body = await requestCore(`actions/${actionReference}/quote`, { method: "GET", signal });
  return quoteResponseSchema.parse(body).quote;
}

const pickDetailResponseSchema = z.object({ detail: pickDetailWireSchema.nullable() });

/** A pick's line and numbers for its card (GET /actions/:id/detail); null when there's nothing to chart. */
export async function readPickDetail(
  actionReference: ActionRecordId,
  signal?: AbortSignal,
): Promise<PickDetailWire | null> {
  const body = await requestCore(`actions/${actionReference}/detail`, { method: "GET", signal });
  return pickDetailResponseSchema.parse(body).detail;
}
