"use client";

import type { ActionPlanLeg, ActionStatus, FailureKind, PlanMove } from "@auni/shared";

import type { LiveLeg } from "@/lib/data/proposals";

import { withFilled } from "./action-card-content";
import type { Words } from "./move-rows";

interface Live {
  readonly status: ActionStatus;
  readonly error: string | null;
  readonly failureKind: FailureKind | null;
  /** Whether core runs it again on a tap, once it didn't go through. */
  readonly retryable: boolean;
  /** Allowed and on its way, rather than waiting its turn. */
  readonly started: boolean;
  /** Held for the owner to check again or close; its `error` says why. */
  readonly held: boolean;
}

export type Leg = Pick<
  ActionPlanLeg,
  "actionReference" | "venue" | "logoUrl" | "amount" | "flow" | "note" | "cost" | "perp" | "verbs"
> &
  Live & {
    readonly name: string;
    readonly why: string;
    /** Optional face logo when a move specifies its own app mark. */
    readonly card?: ActionPlanLeg["card"];
    /** What its logo shows, by name, drawn as initials without one; a plan's row is named by its move. */
    readonly logoName: string | null;
    /** What it does ("Close", "Open"), said where a card both puts money in and brings some back. */
    readonly verb?: string;
    /** What its row says as it runs, when its own card has words for that; a pick's are made from its name. */
    readonly words?: Words;
  };
export type Move = Omit<PlanMove, "status"> & Live;

/**
 * A move as its card carried it, with where it stands now: a move that filled
 * shows what it really moved rather than what its preview priced.
 */
export function withLive<
  T extends {
    readonly actionReference: string;
    readonly status: ActionStatus;
    readonly amount?: ActionPlanLeg["amount"];
  },
>(leg: T, live: readonly LiveLeg[] | undefined): T & Omit<Live, "status"> {
  const current = live?.find(({ id }) => id === leg.actionReference);
  return {
    ...withFilled(leg, current?.filledUsd),
    status: current?.status ?? leg.status,
    error: current?.error ?? null,
    failureKind: current?.failureKind ?? null,
    retryable: current?.retryable ?? false,
    started: current?.started ?? false,
    held: current?.held ?? false,
  };
}
