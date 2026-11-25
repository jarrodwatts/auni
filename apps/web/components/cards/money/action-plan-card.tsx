"use client";

import { AMOUNT, type ActionPlanCardWire, type ActionStatus } from "@auni/shared";
import { useEffect, useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import type { AskAgentHandler } from "@/components/cards/ask-agent";
import { TextSwap } from "@/components/motion/text-swap";
import { useRefreshMoney } from "@/components/portfolio/use-portfolio";
import { formatExactUsd } from "@/lib/money";

import { planPermissions } from "./action-card-content";
import { ArrivedLine } from "./arrived-line";
import { edgeScene } from "./edge-scene";
import { needingYou } from "./failed-step";
import { MoneyCardFrame, MoneyMark, NeedsYou } from "./money-card-parts";
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
  ProposalReceipt,
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
  const venues = new Set(card.legs.map((leg) => leg.venue));
  const mark = {
    kind: "integration",
    integration: venues.size === 1 ? card.legs[0]!.venue : "auni",
  } as const;
  const count = (status: ActionStatus) => legs.filter((leg) => leg.status === status).length;
  const waiting = count("awaiting_permission");
  // A held leg has stopped: it waits on the person, as one that didn't go through does.
  const held = legs.filter((leg) => leg.held).length;
  const running = count("running") - held;
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
      <MoneyCardFrame label={card.title} phase="expired">
        <ProposalReceipt
          mark={<MoneyMark muted mark={mark} size={38} />}
          name={card.title}
          status={ended}
        />
      </MoneyCardFrame>
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
    <MoneyCardFrame
      auni={step === "loading" ? null : edgeScene({ phase, retry: needsYou > 0, rows })}
      label={card.title}
      phase="open"
    >
      <div className="flex items-center gap-3">
        <MoneyMark mark={mark} />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-reading leading-[1.3] font-semibold tracking-[-0.015em] text-balance text-ink">
            {card.title}
          </h3>
          {line.text ? (
            <p className="mt-0.5 flex items-center gap-2 text-meta leading-[18px] text-muted-foreground">
              <span className="flex min-w-0">
                <TextSwap className={line.working ? styles.shimmer : undefined} text={line.text} />
              </span>
              <NeedsYou count={needsYou} />
            </p>
          ) : null}
        </div>
        {units > 0n ? (
          <div className="flex-none pl-1 text-right">
            <p className="text-card-money text-ink">
              <RollingNumber value={total} />
            </p>
            <p className="mt-0.5 text-meta leading-4 text-muted-foreground">
              <TextSwap text={amountNote(phase, flow, done === 0)} />
            </p>
          </div>
        ) : null}
      </div>
      <div className="mt-5 border-t border-foreground/[0.06] pt-5 pb-1.5">
        <MoveList rows={rows} failed={step === "settled" ? failed : null} />
        {finished ? null : <PaysWith lines={card.paysWith ?? []} />}
        {step === "ready" || step === "fund" ? <Costs costs={card.costs} /> : null}
        {/* Everything its moves leave able to act on the money, since one tap grants it all. */}
        {step === "ready" || step === "fund"
          ? permissions.map((says, index) => (
              <p
                key={index}
                className="mt-3 text-[12.5px] leading-[1.45] font-medium break-words text-destructive"
              >
                {says}
              </p>
            ))
          : null}
        {step === "ready" || step === "fund" ? <CardNote says={card.buysFirst} /> : null}
        {step === "ready" || step === "fund" ? <CardNote says={card.pricedLater} /> : null}
        <ArrivedLine />
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
                openAddMoney(wholeDollars(funding.needUsd));
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
    </MoneyCardFrame>
  );
}
