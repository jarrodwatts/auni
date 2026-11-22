"use client";

import type { ActionStatus, SpecialistProposalCardWire } from "@auni/shared";
import { useEffect, useRef, useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import type { AskAgentHandler } from "@/components/cards/ask-agent";
import { markSpecialistSeen } from "@/components/places/stored-state";
import { SpecialistOrb } from "@/components/specialist/specialist-orb";
import { useSpecialists, useRefreshSpecialists } from "@/components/specialist/use-specialists";
import { TextSwap } from "@/components/motion/text-swap";
import { cn } from "@/lib/utils";

import {
  CardNote,
  FooterMorph,
  FundStep,
  PaysWith,
  ProposalReceipt,
  ReadyStep,
  RollingNumber,
  wholeDollars,
} from "./specialist-funnel";
import { withLive, type Leg, type Move } from "./specialist-legs";
import { edgeScene } from "./edge-scene";
import { needingYou } from "./failed-step";
import { MoneyCardFrame, NeedsYou } from "./money-card-parts";
import styles from "./money-card.module.css";
import { ArrivedLine } from "./arrived-line";
import { MoveList } from "./move-list";
import { amountNote, headerLine, moveRows, splitSide } from "./move-rows";
import { headline, pickVerb, sum } from "./pick-money";
import { dollarsToBaseUnits } from "@/lib/data/usdc";
import { formatExactUsd } from "@/lib/money";
import { useProposalFailed } from "./use-failed";
import { untapped } from "./untapped";
import { useProposal } from "./use-proposal";

const WATCH_POLL_MS = 3_000;
/** How long a shortfall is read again for once the person goes to add money for it. */
const DEPOSIT_WAIT_MS = 10 * 60_000;

/**
 * A whole specialist offered at once, and the whole first run in one card:
 * add money, allow, then watch the picks land. The list tells the
 * run, row by row, under a header that says how it's going. It adds up only
 * the picks: money moves that get the cash there run first, each its own row
 * at the top of the list. Its headline is what the picks put
 * in, what the tap asks of the person; what sells and closes bring back shows
 * on their own rows, and heads the card only when nothing goes in.
 */
export function SpecialistProposalCard({
  card,
  onAskAgent,
}: {
  readonly card: SpecialistProposalCardWire;
  readonly onAskAgent?: AskAgentHandler | undefined;
}) {
  const { openAddMoney } = useAppDialogs();
  // The shortfall money may be on its way for, read again until it's met; a new shortfall asks again.
  const [watchingFor, setWatchingFor] = useState<string | null>(null);
  const giveUp = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(giveUp.current), []);
  const refreshSpecialists = useRefreshSpecialists();
  // Only a card Auni just made plays its reveal; history loads still.
  const [fresh] = useState(() => Date.now() - Date.parse(card.updatedAt) < 60_000);
  // Read again while something is, or may be, on its way; a waiting or settled card stays still.
  const { live, queryKey, decide, pending, error } = useProposal(card.proposalId, (data) =>
    watchingFor !== null && data?.funding?.needUsd === watchingFor ? WATCH_POLL_MS : false,
  );
  // A specialist whose card the owner has in front of them is no news in the sidebar.
  useEffect(() => markSpecialistSeen(card.specialistId), [card.specialistId]);
  // The card carries only the specialist's id; its theme, for the orb's glyph, comes from the list.
  const theme = useSpecialists().data?.find(({ id }) => id === card.specialistId)?.theme;
  const orb = { id: card.specialistId, theme: theme ?? "" };

  // A card that both buys and sells says which each pick does, since a sign is too quiet for that.
  const mixed =
    card.legs.some(({ flow }) => flow === "back") && card.legs.some(({ flow }) => flow === "in");
  // What goes in leads, then what comes back, each largest first.
  const legs: readonly Leg[] = card.legs
    // A pick's reason is Auni's words too, so a pick with no take of its own shows that. It is
    // named by its asset, which is what its logo shows; a prediction without its side.
    .map((leg) =>
      withLive(
        {
          ...leg,
          note: leg.note ?? leg.why,
          logoName: splitSide(leg.name).name,
          ...(mixed ? { verb: pickVerb(leg) } : {}),
        },
        live.data?.legs,
      ),
    )
    .toSorted(
      (left, right) =>
        Number(left.flow === "back") - Number(right.flow === "back") ||
        compareBaseUnits(right.amount.baseUnits, left.amount.baseUnits),
    );
  const moves: readonly Move[] = card.moves.map((move) => withLive(move, live.data?.legs));
  const decimals = legs[0]?.amount.currency.decimals ?? 6;
  const going = sum(legs, "in");
  // A card that only sells or closes puts nothing in: what it brings back is its money.
  const cashingOut = headline(legs) === "back";
  const totalLabel = formatExactUsd(going.toString(), decimals);
  const backLabel = formatExactUsd(sum(legs, "back").toString(), decimals);
  const move = cashingOut
    ? `Sell for ${backLabel}`
    : card.adds
      ? `Add ${totalLabel}`
      : `Start with ${totalLabel}`;
  const count = (status: ActionStatus) => legs.filter((leg) => leg.status === status).length;
  const waiting = count("awaiting_permission");
  // A held leg has stopped: it waits on the person, as one that didn't go through does.
  const held = legs.filter((leg) => leg.held).length;
  const running = count("running") - held;
  const done = count("done");
  const funding = live.data?.funding ?? null;

  // Only a finish watched happening counts as one, never a card reopened later.
  const [watched, setWatched] = useState(false);
  if (live.data && done < legs.length && !watched) setWatched(true);

  const rows = moveRows(moves, legs);
  const failed = useProposalFailed(card.proposalId, queryKey, live.data, rows, onAskAgent);

  // A new specialist's money going in shows on its money pane at once.
  const opened = live.data?.opens === true && legs.length > 0 && done === legs.length;
  useEffect(() => {
    if (opened && watched) refreshSpecialists();
  }, [opened, refreshSpecialists, watched]);

  // Money comes in by sending it to the account; the card reads its shortfall again for a while.
  const addMoney = (needUsd: string) => {
    openAddMoney(wholeDollars(needUsd));
    setWatchingFor(needUsd);
    clearTimeout(giveUp.current);
    giveUp.current = setTimeout(() => setWatchingFor(null), DEPOSIT_WAIT_MS);
  };

  const ended = untapped([...legs, ...moves]);
  if (ended) {
    return (
      <MoneyCardFrame label={card.specialistName} phase="expired">
        <ProposalReceipt
          mark={<SpecialistOrb specialist={orb} size={40} />}
          name={card.specialistName}
          status={ended}
        />
      </MoneyCardFrame>
    );
  }

  const stepKey = footerStep({
    loading: !live.data && !live.isError,
    picks: legs.length,
    done,
    waiting,
    running,
    allowing: pending === "allow",
    shortUsd: funding?.needUsd ?? null,
  });

  // Adding more than the picks cost (bridge fees, or rounding up to whole dollars), the card names
  // the one number, in its header and its start button alike.
  const addingUsd = funding && stepKey === "fund" ? String(wholeDollars(funding.needUsd)) : null;
  const adding =
    addingUsd !== null && Number(addingUsd) > Number(going) / 10 ** decimals
      ? formatExactUsd(dollarsToBaseUnits(addingUsd).toString(), 6)
      : null;

  const renderStep = () => {
    switch (stepKey) {
      // Once it runs, the list and the header say it all.
      case "running":
      case "settled":
      case "done":
        return null;
      case "loading":
        return <div className="h-12" />;
      case "fund":
        return funding ? (
          <FundStep
            error={error}
            needUsd={funding.needUsd}
            pending={pending}
            watching={watchingFor === funding.needUsd}
            onAdd={() => addMoney(funding.needUsd)}
            onDecline={() => void decide("decline")}
          />
        ) : null;
      case "ready":
        return (
          <ReadyStep
            error={error}
            landed={watchingFor !== null}
            move={move}
            pending={pending}
            onAllow={() => void decide("allow")}
            onDecline={() => void decide("decline")}
          />
        );
    }
  };

  // Once it has run, the card is a receipt: what went in or came back, resting on the page.
  const finished = stepKey === "done" || stepKey === "settled";
  const phase = finished ? "after" : stepKey === "running" ? "running" : "before";
  const doneLegs = legs.filter((leg) => leg.status === "done");
  const placed = formatExactUsd(sum(doneLegs, cashingOut ? "back" : "in").toString(), decimals);
  const amount = finished && done > 0 ? placed : cashingOut ? backLabel : (adding ?? totalLabel);
  const line = headerLine({
    done,
    held,
    flow: cashingOut ? "back" : "in",
    own: legs.length === 1 ? "1 pick" : `${legs.length} picks`,
    phase,
    total: legs.length,
  });
  const needsYou = stepKey === "settled" ? needingYou(failed.steps.values()) : 0;
  const footing = renderStep();
  return (
    <MoneyCardFrame
      auni={
        stepKey === "loading"
          ? null
          : edgeScene({ phase: stepKey === "fund" ? "fund" : phase, retry: needsYou > 0, rows })
      }
      flat={finished}
      label={card.specialistName}
      phase="open"
    >
      <div className="flex items-center gap-3">
        <SpecialistOrb specialist={orb} size={44} />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[16.5px] leading-[1.3] font-semibold tracking-[-0.015em] text-balance text-ink">
            {card.specialistName}
          </h3>
          {line.text ? (
            <p className="mt-0.5 flex items-center gap-2 text-[13px] leading-[18px] text-muted-foreground">
              <span className="flex min-w-0">
                <TextSwap className={line.working ? styles.shimmer : undefined} text={line.text} />
              </span>
              <NeedsYou count={needsYou} />
            </p>
          ) : null}
        </div>
        <div className="flex-none pl-1 text-right">
          <p className="text-[26px] leading-[1.1] font-semibold tracking-[-0.035em] text-ink tabular-nums">
            {amount}
          </p>
          <p className="mt-0.5 text-[13px] leading-4 text-muted-foreground">
            {phase === "running" && done > 0 ? (
              // The money counts up as each pick lands.
              <>
                <span className="font-semibold text-ink">
                  <RollingNumber value={placed} />
                </span>{" "}
                {cashingOut ? "back" : "in"}
              </>
            ) : (
              <TextSwap text={amountNote(phase, cashingOut ? "back" : "in", done === 0)} />
            )}
          </p>
        </div>
      </div>
      <div
        className={cn(
          "mt-5 border-t border-foreground/[0.06] pt-5 pb-1.5",
          fresh && "auni-crystallize",
        )}
      >
        <MoveList rows={rows} failed={stepKey === "settled" ? failed : null} />
        {finished ? null : <PaysWith lines={card.paysWith ?? []} />}
        {stepKey === "ready" || stepKey === "fund" ? <CardNote says={card.buysFirst} /> : null}
        {stepKey === "ready" || stepKey === "fund" ? <CardNote says={card.pricedLater} /> : null}
        <ArrivedLine />
      </div>
      {/* While it runs, and once some didn't go through, the list says it all. */}
      {footing ? <FooterMorph stepKey={stepKey}>{footing}</FooterMorph> : null}
    </MoneyCardFrame>
  );
}

/**
 * The step at the foot of a specialist card. While its money moves, and once
 * some of it didn't go through, the card's list tells it.
 */
type FooterStep = "loading" | "fund" | "ready" | "running" | "settled" | "done";

function footerStep(facts: {
  /** Neither the proposal nor an error reading it yet; unreadable, the card goes on as it started. */
  readonly loading: boolean;
  readonly picks: number;
  readonly done: number;
  readonly waiting: number;
  readonly running: number;
  /** The person's allow is on its way to core. */
  readonly allowing: boolean;
  readonly shortUsd: string | null;
}): FooterStep {
  if (facts.loading) return "loading";
  if (facts.done === facts.picks) return "done";
  if (facts.running > 0 || facts.allowing) return "running";
  if (facts.waiting === 0) return "settled";
  return facts.shortUsd === null ? "ready" : "fund";
}

function compareBaseUnits(left: string, right: string): number {
  const difference = BigInt(left) - BigInt(right);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}
