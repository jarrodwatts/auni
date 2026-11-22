"use client";

import type { ActionRecordId } from "@auni/shared";
import { useQueries, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import type { AskAgentHandler } from "@/components/cards/ask-agent";
import { CoreApiError } from "@/lib/core";
import { heldTap, readQuote } from "@/lib/data/actions";
import { retryProposal, type LiveProposal } from "@/lib/data/proposals";

import {
  askAbout,
  failedStep,
  HELD_TAP_FAILED,
  retryProblem,
  STILL_HELD,
  type FailedAction,
  type Failure,
} from "./failed-step";
import type { Failed } from "./move-list";
import type { MoveRow } from "./move-rows";

/** A quote is a fresh read of a market: kept a little while, never polled. */
const QUOTE_FRESH_MS = 30_000;

/**
 * A card's steps that didn't go through: each one's reason and next steps,
 * by its action's id, and what a tap on one does. A price that moved is
 * quoted again first, read only, to say whether it is back inside what was
 * approved. Try again runs `retry` (core runs the card's failed steps again,
 * or says why not) and shows what core answers in the card's live read at
 * `queryKey`; Add money opens the funding flow; Ask Auni asks in the
 * conversation. A held step's Check again has core read it now, and its Close
 * asks once what closing means before it closes; the card's live read then
 * shows where the step stands.
 */
export function useFailed<T>(
  failures: readonly { readonly key: string; readonly failure: Failure }[],
  queryKey: QueryKey,
  retry: () => Promise<T>,
  onAskAgent: AskAgentHandler | undefined,
): Failed {
  const queryClient = useQueryClient();
  const { openAddMoney } = useAppDialogs();
  const [busy, setBusy] = useState<FailedAction | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The held step whose Close was tapped once and waits on a yes.
  const [closing, setClosing] = useState<string | null>(null);
  const quotes = useQueries({
    queries: failures.map(({ key, failure }) => ({
      queryKey: ["action-quote", key],
      queryFn: ({ signal }: { readonly signal: AbortSignal }) =>
        readQuote(key as ActionRecordId, signal),
      enabled: failure.kind === "price",
      staleTime: QUOTE_FRESH_MS,
      retry: false,
    })),
  });
  const steps = new Map(
    failures.map(({ key, failure }, index) => [
      key,
      failedStep(failure, quotes[index]?.data ?? null, onAskAgent !== undefined, closing === key),
    ]),
  );
  const heldKeys = new Set(failures.flatMap(({ key, failure }) => (failure.held ? [key] : [])));
  const act =
    (step: { readonly key: string; readonly label: string; readonly reason: string }) =>
    (action: FailedAction) => {
      if (action === "add_money") return openAddMoney();
      if (action === "ask")
        return void onAskAgent?.(askAbout(step.label, step.reason, heldKeys.has(step.key)));
      if (action === "keep") return setClosing(null);
      // Close asks first what it means; the second tap closes.
      if (action === "close" && closing !== step.key) return setClosing(step.key);
      setBusy(action);
      setProblem(null);
      if (action === "check" || action === "close") {
        void heldTap(step.key as ActionRecordId, action)
          .then((now) => {
            if (action === "check" && now.phase === "needs_owner") setProblem(STILL_HELD);
            return queryClient.invalidateQueries({ queryKey });
          })
          .catch(() => setProblem(HELD_TAP_FAILED))
          .finally(() => {
            setBusy(null);
            setClosing(null);
          });
        return;
      }
      void retry()
        .then((now) => queryClient.setQueryData(queryKey, now))
        .catch((caught: unknown) => {
          // Whatever core said, the card shows where it stands now.
          void queryClient.invalidateQueries({ queryKey });
          setProblem(retryProblem(caught instanceof CoreApiError ? (caught.code ?? null) : null));
        })
        .finally(() => setBusy(null));
    };
  return { steps, act, busy, problem };
}

/** A proposal card's failed rows (see useFailed): Try again runs the card's failed legs again. */
export function useProposalFailed(
  proposalId: string,
  queryKey: QueryKey,
  live: LiveProposal | undefined,
  rows: readonly MoveRow[],
  onAskAgent: AskAgentHandler | undefined,
): Failed {
  return useFailed(
    rows.flatMap((row) => (row.failure ? [{ key: row.key, failure: row.failure }] : [])),
    queryKey,
    // As the runs the card showed, so a tap from a screen behind runs nothing.
    () => retryProposal(proposalId, live?.runs ?? 0),
    onAskAgent,
  );
}
