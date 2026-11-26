"use client";

import { AMOUNT, type ActionPlanCardWire, type ActionStatus } from "@auni/shared";
import { useEffect, useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import type { AskAgentHandler } from "@/components/cards/ask-agent";
import { CardFrame, CardHead, CardReceipt } from "@/components/cards/card-parts";
import { TextSwap } from "@/components/motion/text-swap";
import { useRefreshMoney } from "@/components/portfolio/use-portfolio";
import { formatExactUsd } from "@/lib/money";
import { cn } from "@/lib/utils";

import { ArrivedLine } from "./arrived-line";
import { edgeScene } from "./edge-scene";
import { needingYou } from "./failed-step";
import { cardMark, planPermissions } from "./action-card-content";
import { MoneyMark, NeedsYou, PairMark } from "./money-card-parts";
import styles from "./money-card.module.css";
import { MoveList } from "./move-list";
import { amountNote, headerLine, moveRows, planLeg } from "./move-rows";
import { headline, pickVerb, sum } from "./pick-money";
import {
  CardNote,
  Costs,
  FooterMorph,
  FundStep,
  PaysWith,
  ReadyStep,
  RollingNumber,
  wholeDollars,
} from "./plan-funnel";
import { withLive, type Leg, type Move } from "./plan-legs";
import { untapped } from "./untapped";
import { useProposalFailed } from "./use-failed";
import { useProposal } from "./use-proposal";

/** How often a card waiting for money to land checks whether enough has arrived. */
const FUNDING_POLL_MS = 3_000;

/**
 * Several moves or picks allowed with one tap: a basket of takes, "close these
 * three positions", or "buy $5 of NVIDIA" paid from cash that has to move first.
 * Each row is one move, read live, with funding moves first. When cash is short,
 * the card offers Add money inline and turns ready the moment enough arrives.
 */
export function ActionPlanCard({
  card,
  onAskAgent,
}: {
  readonly card: ActionPlanCardWire;
  readonly onAskAgent?: AskAgentHandler | undefined;
}) {
  const { openAddMoney } = useAppDialogs();
  const refreshMoney = useRefreshMoney();
  // Shortfall amount we opened Add money for; keeps polling until it clears.
  const [watchingFor, setWatchingFor] = useState<string | null>(null);
  const { live, queryKey, decide, pending, error } = useProposal(card.proposalId, (data) =>
    watchingFor !== null && data?.funding ? FUNDING_POLL_MS : false,
  );

  const mixed = sum(card.legs, "in") > 0n && sum(card.legs, "back") > 0n;
  const permissions = planPermissions(card);
  const legs: readonly Leg[] = card.legs.map((leg) =>
    withLive({ ...planLeg(leg), ...(mixed ? { verb: pickVerb(leg) } : {}) }, live.data?.legs),
  );
  const moves: readonly Move[] = card.moves.map((move) => withLive(move, live.data?.legs));
  // One venue's moves wear its mark; a mix wears Auni's.
  // Picks of their own (a basket) wear their own logos; a plan of one venue's moves its mark.
  const picks = card.legs.map((leg) => cardMark(leg));
  const pair =
    picks.length > 1 && picks.every((pick) => pick.kind === "image")
      ? ([picks[0]!, picks[1]!] as const)
      : null;
  const venues = new Set(card.legs.map((leg) => leg.venue));
  const mark = {
    kind: "integration",
    integration: venues.size === 1 ? card.legs[0]!.venue : "auni",
  } as const;
  const count = (status: ActionStatus) => legs.filter((leg) => leg.status === status).length;
  const waiting = count("awaiting_permission");
  // A held leg or money move has stopped: it waits on the person, as one that didn't go through does.
  const heldLegs = legs.filter((leg) => leg.held).length;
  const held = heldLegs + moves.filter((move) => move.held).length;
  const running = count("running") - heldLegs;
  const done = count("done");
  // Only a finish watched happening refreshes balances and makes Auni hop.
  const [watched, setWatched] = useState(false);
  if (running > 0 && !watched) setWatched(true);
  const rows = moveRows(moves, legs);
  const failed = useProposalFailed(card.proposalId, queryKey, live.data, rows, onAskAgent);
  const funding = live.data?.funding ?? null;

  const ended = untapped([...legs, ...moves]);
  const step =
    !live.data && !live.isError
      ? "loading"
      : done === legs.length
        ? "done"
        : running > 0 || pending === "allow"
          ? "running"
          : waiting > 0
            ? funding
              ? "fund"
              : "ready"
            : "settled";
  const finished = step === "done" || step === "settled";

  useEffect(() => {
    if (watched && finished) refreshMoney();
  }, [finished, refreshMoney, watched]);

  if (ended) {
    return (
      <CardFrame label={card.title} phase="expired">
        <CardReceipt
          mark={
            pair ? (
              <PairMark muted marks={pair} size={38} />
            ) : (
              <MoneyMark muted mark={mark} size={38} />
            )
          }
          title={card.title}
          detail={ended}
        />
      </CardFrame>
    );
  }

  const phase = finished ? "after" : step === "running" ? "running" : "before";
  // Once it has run, the total is what went through; until then, and when none of it did, what it
  // would move.
  const counted = finished && done > 0 ? legs.filter((leg) => leg.status === "done") : legs;
  const flow = headline(legs);
  const units = sum(counted, flow);
  const total = formatExactUsd(units.toString(), legs[0]?.amount.currency.decimals ?? 6);
  const line = headerLine({
    done,
    held,
    flow: units > 0n ? flow : null,
    // Every row it shows is a move, the ones that only bring the cash included.
    own: `${rows.length} ${rows.length === 1 ? "move" : "moves"}`,
    phase,
    total: legs.length,
  });
  const needsYou = step === "settled" ? needingYou(failed.steps.values()) : 0;

  return (
    <CardFrame
      auni={step === "loading" ? null : edgeScene({ phase, retry: needsYou > 0, rows })}
      label={card.title}
      phase="open"
      // Amber while it waits on the owner: for the tap, for money to land, or for a held row.
      // Red once it settled with steps that didn't go through.
      tone={
        step === "ready" || step === "fund" || held > 0
          ? "waiting"
          : step === "settled"
            ? "failed"
            : null
      }
    >
      <CardHead
        mark={pair ? <PairMark marks={pair} /> : <MoneyMark mark={mark} />}
        title={card.title}
        line={
          line.text ? (
            <span className="flex items-center gap-2">
              <span className="flex min-w-0">
                <TextSwap className={line.working ? styles.shimmer : undefined} text={line.text} />
              </span>
              <NeedsYou count={needsYou} />
            </span>
          ) : null
        }
        figure={
          units > 0n
            ? {
                value: <RollingNumber value={total} />,
                note: <TextSwap text={amountNote(phase, flow, done === 0)} />,
              }
            : null
        }
      />
      <div className="mt-5 border-t border-border pt-5 pb-1.5">
        <MoveList rows={rows} failed={step === "settled" ? failed : null} />
        {finished ? null : <PaysWith lines={card.paysWith ?? []} />}
        {step === "ready" || step === "fund" ? <Costs costs={card.costFigures} /> : null}
        {/* Everything its moves leave behind, in core's words, since one tap agrees to it all: each
            permission in red, and each order it leaves resting, which its rows don't show. */}
        {step === "ready" || step === "fund"
          ? permissions.map(({ says, order }, index) => (
              <p
                key={index}
                className={cn(
                  "mt-3 text-meta leading-[1.45] font-medium",
                  order ? "text-muted-foreground" : "text-destructive",
                )}
              >
                {says}
              </p>
            ))
          : null}
        {step === "ready" || step === "fund" ? <CardNote says={card.buysFirst} /> : null}
        {step === "ready" || step === "fund" ? <CardNote says={card.pricedLater} /> : null}
        <ArrivedLine proposalId={card.proposalId} />
      </div>
      {/* Once it runs, the list and the header say it all. */}
      {step === "loading" || step === "fund" || step === "ready" ? (
        <FooterMorph stepKey={step}>
          {step === "loading" ? (
            <div className="h-12" />
          ) : step === "fund" && funding ? (
            <FundStep
              error={error}
              needUsd={funding.needUsd}
              pending={pending}
              watching={watchingFor === funding.needUsd}
              onAdd={() => {
                setWatchingFor(funding.needUsd);
                openAddMoney({
                  usd: String(wholeDollars(funding.needUsd)),
                  chain: funding.chain,
                });
              }}
              onDecline={() => void decide("decline")}
            />
          ) : (
            <ReadyStep
              error={error}
              landed={watchingFor !== null}
              move={card.action.replaceAll(AMOUNT, total)}
              pending={pending}
              onAllow={() => void decide("allow")}
              onDecline={() => void decide("decline")}
            />
          )}
        </FooterMorph>
      ) : null}
    </CardFrame>
  );
}
