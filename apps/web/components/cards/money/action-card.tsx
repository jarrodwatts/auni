"use client";

import { appListing, filledUsd, type ActionCardWire, type ActionWire } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { mustPairAgain, PairAgain } from "@/components/auth/pair-again";
import type { EdgeScene } from "@/components/brand/edge-pose";
import type { AskAgentHandler } from "@/components/cards/ask-agent";
import {
  CardActions,
  CardButton,
  CardFrame,
  CardHead,
  CardReceipt,
} from "@/components/cards/card-parts";
import { TextSwap } from "@/components/motion/text-swap";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WithdrawReviewDialog } from "@/components/withdraw/withdraw-review-dialog";
import { actionKey, decideAction, tapFailed, retryAction, useLiveAction } from "@/lib/data/actions";
import { formatExactUsd } from "@/lib/money";

import { actionCardContent, withFilled } from "./action-card-content";
import { edgeScene } from "./edge-scene";
import { exchangeOf } from "./exchange";
import { heldHeading, onlyWhileNewest, reportable } from "./failed-step";
import { MoneyMark } from "./money-card-parts";
import styles from "./money-card.module.css";
import { MoveBody } from "./move-body";
import { FailedActions, MoveList } from "./move-list";
import { actionRows, didnt, failureOf, headerLine, STAYED } from "./move-rows";
import { FooterMorph, StepError } from "./plan-funnel";
import { ProofNote } from "./proof-note";
import { untapped } from "./untapped";
import { useFailed } from "./use-failed";

/** How long a move that lands while watched holds its ticked steps before folding to the receipt. */
const LANDED_MS = 1_400;

/**
 * One money move, drawn where Auni proposed it, as one object that changes in place:
 *
 *   waiting on you  ->  working  ->  done (a calm receipt)
 *        |                  |
 *        |                  +->  status unknown (held: Check status, Dismiss card)
 *        +->  declined                    +->  didn't go through (why, and whether money moved)
 *
 * The head and its figure stay put while the foot moves from the tap to the steps to the
 * receipt. It reads the move live; the card's own fields are only where it started.
 */
export function ActionCard({
  card,
  onAskAgent,
}: {
  readonly card: ActionCardWire;
  readonly onAskAgent?: AskAgentHandler | undefined;
}) {
  const queryClient = useQueryClient();
  const { openReport } = useAppDialogs();
  const [pending, setPending] = useState<"allow" | "decline" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // This browser has no proof to give that the owner is here: the way on is to pair it again.
  const [pairAgain, setPairAgain] = useState(false);
  // Money leaving Auni is confirmed on the withdraw step, never with the card's own tap.
  const withdraws = card.tool === "withdraw_usdc";
  // A move core's approval ladder says takes proof the owner is at the computer goes only with
  // it; a withdrawal checks on its step.
  const takesProof = !withdraws && card.takesProof === true;
  const [reviewing, setReviewing] = useState(false);
  const [watched, setWatched] = useState(false);
  const [folded, setFolded] = useState(false);
  const queryKey = actionKey(card.actionReference);
  const live = useLiveAction(card.actionReference);
  const state: Pick<
    ActionWire,
    "status" | "phase" | "error" | "failureKind" | "retryable" | "attempts" | "txs" | "run"
  > = live.data ?? {
    status: card.status,
    phase: null,
    error: card.error,
    failureKind: null,
    retryable: false,
    attempts: 1,
    txs: [],
    run: {},
  };
  // Once it fills, it says what it really moved rather than what the card priced.
  const shown = withFilled(card, filledUsd(state.run));
  const content = actionCardContent(shown);
  const landed = watched && state.status === "done";
  useEffect(() => {
    if (!landed) return undefined;
    const timer = window.setTimeout(() => setFolded(true), LANDED_MS);
    return () => window.clearTimeout(timer);
  }, [landed]);
  const amount = formatExactUsd(shown.amount.baseUnits, shown.amount.currency.decimals);
  // Held: it stopped where Auni can't tell what it did, and waits on the owner (core's HELD).
  const held = state.status === "running" && state.phase === "needs_owner";
  // Once it didn't go through, or is held: why, where the money is, and what can help.
  const { steps, act, busy, problem } = useFailed(
    state.status === "failed" || held
      ? [{ key: card.actionReference, failure: failureOf({ ...state, held }, STAYED) }]
      : [],
    queryKey,
    () => retryAction(card.actionReference, state.attempts),
    onAskAgent,
  );
  const failed = steps.get(card.actionReference);

  const decide = async (decision: "allow" | "decline") => {
    setPending(decision);
    setFailure(null);
    setPairAgain(false);
    try {
      // Core judges the proof a card takes from the tap itself (its auth/proof.ts).
      const next = await decideAction(card.actionReference, decision);
      if (next) queryClient.setQueryData(queryKey, next);
    } catch (caught) {
      // This browser paired over 15 minutes ago: core refused, and nothing was sent.
      if (mustPairAgain(caught)) return void setPairAgain(true);
      // It may have gone through regardless; the card reads where it stands.
      void queryClient.invalidateQueries({ queryKey });
      setFailure(tapFailed(caught));
    } finally {
      setPending(null);
    }
  };

  const ended = untapped([state]);
  if (ended) {
    return (
      <CardFrame label={content.title} phase="expired">
        <CardReceipt
          mark={<MoneyMark muted mark={content.mark} size={38} />}
          title={content.title}
          detail={ended}
        />
      </CardFrame>
    );
  }

  const settled = state.status === "done" || state.status === "failed";
  // A move seen running that lands holds its ticked steps a moment; one already done is just its receipt.
  if (!settled && !held && (state.status === "running" || pending === "allow") && !watched)
    setWatched(true);
  const landing = watched && state.status === "done" && !folded;
  const step = landing
    ? "running"
    : held
      ? "held"
      : state.status === "running" || pending === "allow"
        ? "running"
        : settled
          ? state.status
          : "ready";

  if (step === "done" || step === "failed") {
    // One the owner dismissed while it was held says so, whichever way it ended (core's CLOSED).
    const closed = state.run.settledBy === "owner";
    const done = step === "done" && !closed;
    const title = closed
      ? `Dismissed: ${content.title}`
      : done
        ? content.receipt.title
        : didnt(content.title);
    const auni: EdgeScene = done
      ? { kind: "landed" }
      : onAskAgent && !closed
        ? { kind: "attention", row: null, settled: true }
        : { kind: "failed" };
    const report = !done && !closed && reportable(state.failureKind);
    return (
      <CardFrame
        auni={live.data ? auni : null}
        label={title}
        phase="confirmed"
        tone={!done && !closed ? "failed" : null}
      >
        <CardReceipt
          mark={
            <MoneyMark
              done={done}
              failed={step === "failed" && !closed}
              muted={closed}
              mark={content.mark}
              size={38}
            />
          }
          title={title}
          detail={
            done
              ? (state.run.filled ?? content.receipt.detail ?? "")
              : closed
                ? [sentence(content.context), state.error].filter(Boolean).join(" ")
                : (problem ?? failed?.reason ?? STAYED)
          }
          whole={!done}
          amount={done ? content.receipt.amount : null}
          trailing={
            !done && !closed && (failed?.actions.length || report) ? (
              <div className="flex flex-wrap items-center gap-2">
                {failed ? (
                  <FailedActions
                    actions={failed.actions}
                    busy={busy}
                    onAct={act({ key: card.actionReference, label: title, reason: failed.reason })}
                  />
                ) : null}
                {/* Written up for Auni's maintainers, which the owner posts themselves. */}
                {report ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    // Alone, its words line up with the reason above, not its padding: always with
                    // no other way on, and once the conversation moves past the ones that go then.
                    className={
                      !failed?.actions.length
                        ? "-ml-3"
                        : failed.actions.every(onlyWhileNewest)
                          ? styles.aloneOnceMovedOn
                          : undefined
                    }
                    onClick={() => openReport({ action: card.actionReference })}
                    data-testid="report-it"
                  >
                    Report a problem
                  </Button>
                ) : null}
              </div>
            ) : null
          }
        />
      </CardFrame>
    );
  }

  const moves = shown.amount.baseUnits !== "0";
  // A held move keeps its card as it was asked, so what it was stays in view; only its foot
  // changes, from steps that turn to where it stands and the owner's two taps.
  const phase = landing ? "after" : step === "running" ? "running" : "before";
  const line = headerLine({
    done: landing ? 1 : 0,
    flow: moves ? card.flow : null,
    own: content.context || null,
    phase,
    total: 1,
  });
  const rows = actionRows(card, state, { working: content.working, done: content.receipt.title });
  // The amount is said once, in the head; what it gets for it goes under the title.
  const exchange = exchangeOf(content.figures, amount);
  const venue = appListing(card.venue)?.name ?? null;
  const heading = heldHeading(state.run.held, venue);

  return (
    <CardFrame
      // Auni peeks over a card only while it waits on the owner: for the tap, or for a held
      // move's check. Once tapped it ducks away, and comes back up only to cheer a landing.
      auni={
        !live.data
          ? null
          : step === "held"
            ? { kind: "attention", row: null, settled: true }
            : edgeScene({ phase, retry: false, rows })
      }
      label={step === "held" ? `${heading.badge}: ${content.title}` : content.title}
      phase="open"
      tone={step === "ready" || step === "held" ? "waiting" : null}
    >
      <CardHead
        mark={
          <MoneyMark
            done={landing}
            mark={content.mark}
            ring={landing ? "landed" : step === "running" ? "working" : null}
          />
        }
        title={moves && !content.note ? subject(content.title) : content.title}
        line={
          exchange.result || line.text ? (
            <>
              {exchange.result ? (
                <span className="block text-ui leading-5 font-medium text-ink tabular-nums">
                  {exchange.result}
                </span>
              ) : null}
              {/* Its own line can be all that names what's bought (a prediction's question), so it wraps. */}
              {line.text ? (
                <TextSwap
                  className={line.working ? styles.shimmer : undefined}
                  text={line.text}
                  wrap
                />
              ) : null}
            </>
          ) : null
        }
        figure={
          moves
            ? {
                value: amount,
                note: landing
                  ? "done"
                  : step === "held"
                    ? heading.note
                    : step === "running"
                      ? "on its way"
                      : (content.note ??
                        (card.flow === "back" ? "coming back" : amountNote(content.title))),
              }
            : null
        }
      />
      <MoveBody exchange={exchange} face={content} ready={step === "ready"} />
      <FooterMorph stepKey={step}>
        {step === "ready" ? (
          <>
            {pairAgain ? (
              <PairAgain
                className="mb-4"
                then={`Then come back and tap ${content.action} again. This card waits, and nothing was sent.`}
              />
            ) : takesProof ? (
              <ProofNote className="mb-4">
                {card.proofWhy ??
                  "Nothing vouches for this one but its simulation, so confirm it's you first."}
              </ProofNote>
            ) : null}
            <StepError>{failure}</StepError>
            <CardActions
              decline={{
                busy: pending === "decline",
                disabled: pending !== null,
                onClick: () => void decide("decline"),
              }}
            >
              <CardButton
                disabled={pending !== null}
                tone="primary"
                onClick={() => (withdraws ? setReviewing(true) : void decide("allow"))}
              >
                <span className="truncate">{content.action}</span>
              </CardButton>
            </CardActions>
          </>
        ) : step === "held" && failed ? (
          // Held is no failure: it says calmly where it stands, and that nothing is sent again.
          <div className="border-t border-border pt-4">
            <p className="flex flex-wrap items-center gap-2 text-ui leading-5 font-semibold text-ink">
              {heading.title}
              <Badge tone="waiting">{heading.badge}</Badge>
            </p>
            <p
              aria-live="polite"
              className="mt-1 text-meta leading-[1.5] text-pretty text-muted-foreground"
            >
              {problem ?? failed.reason}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <FailedActions
                actions={failed.actions}
                busy={busy}
                onAct={act({
                  key: card.actionReference,
                  label: `${heading.badge}: ${content.title}`,
                  reason: failed.reason,
                })}
              />
            </div>
          </div>
        ) : (
          <MoveList rows={rows} />
        )}
      </FooterMorph>
      {withdraws ? (
        <WithdrawReviewDialog
          actionReference={card.actionReference}
          open={reviewing}
          onOpenChange={setReviewing}
          onSent={(action) => queryClient.setQueryData(queryKey, action)}
        />
      ) : null}
    </CardFrame>
  );
}

/** A card's own line as a sentence other words can follow: "Rate cut in December" gains its stop. */
function sentence(words: string | null | undefined): string | null {
  if (!words) return null;
  return /[.?!]$/u.test(words) ? words : `${words}.`;
}

/** Under a "$50" headline, "Buy Nvidia for $50" reads "Nvidia", "Withdraw $10 from X" "From X". */
function subject(title: string): string {
  const rest = title
    .replace(/^\S+\s+/u, "")
    .replace(/^\$[\d,.]+\s+(of\s+)?/u, "")
    .replace(/\s+for\s+\$[\d,.]+$/u, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const MOVES = new Set(["buy", "sell", "withdraw", "deposit", "send", "move", "add"]);

/** Under the amount, what it does: "to buy", or the move's own word ("Long") when it isn't a plain one. */
function amountNote(title: string): string {
  const verb = title.split(" ")[0] ?? "";
  return MOVES.has(verb.toLowerCase()) ? `to ${verb.toLowerCase()}` : verb;
}
