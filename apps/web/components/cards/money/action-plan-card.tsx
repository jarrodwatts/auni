"use client";

import { AMOUNT, type ActionPlanCardWire, type ActionStatus } from "@auni/shared";
import { useState } from "react";

import type { AskAgentHandler } from "@/components/cards/ask-agent";
import { TextSwap } from "@/components/motion/text-swap";
import { formatExactUsd } from "@/lib/money";

import {
  CardNote,
  Costs,
  FooterMorph,
  PaysWith,
  ProposalReceipt,
  ReadyStep,
} from "./specialist-funnel";
import { withLive, type Leg, type Move } from "./specialist-legs";
import { edgeScene } from "./edge-scene";
import { needingYou } from "./failed-step";
import { MoneyCardFrame, MoneyMark, NeedsYou } from "./money-card-parts";
import styles from "./money-card.module.css";
import { ArrivedLine } from "./arrived-line";
import { MoveList } from "./move-list";
import { amountNote, headerLine, moveRows, planLeg } from "./move-rows";
import { headline, sum } from "./pick-money";
import { useProposalFailed } from "./use-failed";
import { untapped } from "./untapped";
import { useProposal } from "./use-proposal";

/**
 * Several moves outside a specialist, allowed with one tap: "close these three
 * positions", or "buy $5 of NVIDIA" paid from cash that has to move first.
 * Each row is one move, read live, the moves that only get the cash there
 * first, as on a specialist's card. The list tells the run; the foot of the
 * card holds only the ask, and the finish.
 */
export function ActionPlanCard({
  card,
  onAskAgent,
}: {
  readonly card: ActionPlanCardWire;
  readonly onAskAgent?: AskAgentHandler | undefined;
}) {
  // Read again only while something is on its way; a waiting or settled card stays still.
  const { live, queryKey, decide, pending, error } = useProposal(card.proposalId);

  const legs: readonly Leg[] = card.legs.map((leg) => withLive(planLeg(leg), live.data?.legs));
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
  // Only a finish watched happening makes Auni hop, never a card reopened later.
  const [watched, setWatched] = useState(false);
  if (running > 0 && !watched) setWatched(true);
  const rows = moveRows(moves, legs);
  const failed = useProposalFailed(card.proposalId, queryKey, live.data, rows, onAskAgent);

  const ended = untapped([...legs, ...moves]);
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

  const step =
    !live.data && !live.isError
      ? "loading"
      : done === legs.length
        ? "done"
        : running > 0 || pending === "allow"
          ? "running"
          : waiting > 0
            ? "ready"
            : "settled";
  const finished = step === "done" || step === "settled";
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
      flat={finished}
      label={card.title}
      phase="open"
    >
      <div className="flex items-center gap-3">
        <MoneyMark mark={mark} />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[16.5px] leading-[1.3] font-semibold tracking-[-0.015em] text-balance text-ink">
            {card.title}
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
        {units > 0n ? (
          <div className="flex-none pl-1 text-right">
            <p className="text-[26px] leading-[1.1] font-semibold tracking-[-0.035em] text-ink tabular-nums">
              {total}
            </p>
            <p className="mt-0.5 text-[13px] leading-4 text-muted-foreground">
              <TextSwap text={amountNote(phase, flow, done === 0)} />
            </p>
          </div>
        ) : null}
      </div>
      <div className="mt-5 border-t border-foreground/[0.06] pt-5 pb-1.5">
        <MoveList rows={rows} failed={step === "settled" ? failed : null} />
        {finished ? null : <PaysWith lines={card.paysWith ?? []} />}
        {step === "ready" ? <Costs costs={card.costs} /> : null}
        {step === "ready" ? <CardNote says={card.buysFirst} /> : null}
        {step === "ready" ? <CardNote says={card.pricedLater} /> : null}
        <ArrivedLine />
      </div>
      {/* Once it runs, the list and the header say it all. */}
      {step === "loading" || step === "ready" ? (
        <FooterMorph stepKey={step}>
          {step === "loading" ? (
            <div className="h-12" />
          ) : (
            <ReadyStep
              error={error}
              landed={false}
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
