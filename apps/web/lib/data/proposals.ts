import {
  filledUsd,
  proposalWireSchema,
  type ActionStatus,
  type FailureKind,
  type ProposalWire,
} from "@auni/shared";

import { requestCore } from "@/lib/core";

/**
 * A specialist card's legs, live from core: GET /proposals/:id, one tap that
 * allows or declines every waiting leg (POST /proposals/:id/allow,
 * /decline), and Try again on the ones that didn't go through (/retry).
 */

export interface LiveLeg {
  readonly id: string;
  readonly status: ActionStatus;
  readonly error: string | null;
  /** Why it didn't go through, as core recorded it. */
  readonly failureKind: FailureKind | null;
  /** Whether core runs it again with its card on a tap, once it didn't go through. */
  readonly retryable: boolean;
  /** Running and past the queue: allowed legs wait their turn, picks behind the money moves. */
  readonly started: boolean;
  /** Held: it stopped where Auni can't tell what it did, and waits on the owner (`error` says why). */
  readonly held: boolean;
  /** What a sale that filled brought back, or a buy spent, in dollars (see filledUsd). */
  readonly filledUsd: string | null;
}

/** The chain whose dollars the waiting legs spend, and how many more they need. */
type ProposalFunding = NonNullable<ProposalWire["funding"]>;

export interface LiveProposal {
  readonly legs: readonly LiveLeg[];
  /** Non-null only for a signed-in person whose waiting legs are short of money. */
  readonly funding: ProposalFunding | null;
  /** The specialist's first money going in, whose success is celebrated. */
  readonly opens: boolean;
  /** How many runs its legs have had between them, which Try again says it saw. */
  readonly runs: number;
}

export function toLiveProposal(body: unknown): LiveProposal {
  const { actions, funding, opens } = proposalWireSchema.parse(body);
  return {
    legs: actions.map(({ id, status, error, failureKind, retryable, phase, run }) => ({
      id,
      status,
      error,
      failureKind,
      retryable,
      started: phase !== null && phase !== "queued",
      held: phase === "needs_owner",
      filledUsd: filledUsd(run),
    })),
    funding,
    opens,
    runs: actions.reduce((sum, action) => sum + action.attempts, 0),
  };
}

export async function getProposal(proposalId: string, signal?: AbortSignal): Promise<LiveProposal> {
  const body = await requestCore(`proposals/${proposalId}`, { method: "GET", signal });
  return toLiveProposal(body);
}

/**
 * Try again on a card's legs that didn't go through, as the card's `runs`
 * it showed; core runs them again from where they stopped, or answers why
 * not with a CoreApiError (see retryProblem).
 */
export async function retryProposal(proposalId: string, runs: number): Promise<LiveProposal> {
  const body = await requestCore(`proposals/${proposalId}/retry`, {
    method: "POST",
    body: JSON.stringify({ attempts: runs }),
  });
  return toLiveProposal(body);
}

export async function decideProposal(
  proposalId: string,
  decision: "allow" | "decline",
): Promise<LiveProposal> {
  const body = await requestCore(`proposals/${proposalId}/${decision}`, { method: "POST" });
  return toLiveProposal(body);
}
