"use client";

import {
  ETHEREUM,
  filledUsd,
  NETWORK_KEYS,
  NETWORKS,
  type ActionCardWire,
  type ActionWire,
} from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, MessageCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { mustPairAgain, PairAgain } from "@/components/auth/pair-again";
import type { EdgeScene } from "@/components/brand/edge-pose";
import type { AskAgentHandler } from "@/components/cards/ask-agent";
import { LogoImage } from "@/components/brand/marks";
import { TextSwap } from "@/components/motion/text-swap";
import { WithdrawReviewDialog } from "@/components/withdraw/withdraw-review-dialog";
import { actionKey, decideAction, tapFailed, retryAction, useLiveAction } from "@/lib/data/actions";
import { cn } from "@/lib/utils";

import { actionCardContent, figureWidth, withFilled } from "./action-card-content";
import { FooterMorph, StepError } from "./plan-funnel";
import { FullAddress, isAddress } from "./full-address";
import { edgeScene } from "./edge-scene";
import { MoneyButton, MoneyButtons, MoneyCardFrame, MoneyMark } from "./money-card-parts";
import { FailedActions, MoveList } from "./move-list";
import { ProofNote } from "./proof-note";
import { reportable } from "./failed-step";
import { actionRows, didnt, failureOf, headerLine, STAYED } from "./move-rows";
import { formatExactUsd } from "@/lib/money";
import styles from "./money-card.module.css";
import { untapped } from "./untapped";
import { useFailed } from "./use-failed";

/** How long a move that lands while watched holds its ticked steps before folding to the receipt. */
const LANDED_MS = 1_400;

/**
 * One money action the agent took on its own, drawn where it took it. The
 * header and figures stay put while the foot of the card moves from the ask
 * to on its way to done. It reads the action live; the card's own fields are
 * only where it started.
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
  const context = content.context ?? "";
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
      <MoneyCardFrame label={content.title} phase="expired">
        <Receipt
          mark={<MoneyMark muted mark={content.mark} size={38} />}
          title={content.title}
          detail={ended}
        />
      </MoneyCardFrame>
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
    // One the owner closed while it was held says so, whichever way it ended (core's CLOSED).
    const closed = state.run.settledBy === "owner";
    const done = step === "done" && !closed;
    const title = closed
      ? `Closed: ${content.title}`
      : done
        ? content.receipt.title
        : didnt(content.title);
    const auni: EdgeScene = done
      ? { kind: "landed" }
      : onAskAgent && !closed
        ? { kind: "attention", row: null, settled: true }
        : { kind: "failed" };
    return (
      <MoneyCardFrame auni={live.data ? auni : null} label={title} phase="confirmed">
        <Receipt
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
            !done && !closed ? (
              <span className="flex flex-wrap items-center gap-2">
                {failed ? (
                  <FailedActions
                    actions={failed.actions}
                    busy={busy}
                    onAct={act({ key: card.actionReference, label: title, reason: failed.reason })}
                  />
                ) : null}
                {/* Written up for Auni's maintainers, which the owner posts themselves. */}
                {reportable(state.failureKind) ? (
                  <button
                    type="button"
                    onClick={() => openReport({ action: card.actionReference })}
                    className="h-8 flex-none rounded-full bg-foreground/[0.06] px-3.5 text-meta font-semibold text-ink transition-[background-color,transform] hover:bg-foreground/[0.09] active:scale-[.98]"
                    data-testid="report-it"
                  >
                    Report it
                  </button>
                ) : null}
              </span>
            ) : null
          }
        />
      </MoneyCardFrame>
    );
  }

  const moves = shown.amount.baseUnits !== "0";
  const detail = content.figures.filter((figure) => figure.value !== amount);
  // A held move keeps its card as it was asked, so what it was stays in view; only its foot
  // changes, from steps that turn to where it stands and the owner's two taps.
  const phase = landing ? "after" : step === "running" ? "running" : "before";
  const line = headerLine({
    done: landing ? 1 : 0,
    flow: moves ? card.flow : null,
    own: context || null,
    phase,
    total: 1,
  });
  const rows = actionRows(card, state, { working: content.working, done: content.receipt.title });

  return (
    <MoneyCardFrame
      auni={
        !live.data
          ? null
          : step === "held"
            ? { kind: "attention", row: null, settled: true }
            : edgeScene({ phase, retry: false, rows })
      }
      label={step === "held" ? `Not confirmed: ${content.title}` : content.title}
      phase="open"
    >
      {/* One header, read like a holding: what it is on the left, the money on the right. */}
      <div className="flex items-center gap-3">
        <MoneyMark
          done={landing}
          mark={content.mark}
          ring={landing ? "landed" : step === "running" ? "working" : null}
        />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-reading leading-[1.3] font-semibold tracking-[-0.015em] text-balance text-ink">
            {moves && !content.note ? subject(content.title) : content.title}
          </p>
          {line.text ? (
            <p className="mt-0.5 text-meta leading-[18px] text-muted-foreground">
              {/* Its own line can be all that names what's bought (a prediction's question), so it wraps. */}
              <TextSwap
                className={line.working ? styles.shimmer : undefined}
                text={line.text}
                wrap
              />
            </p>
          ) : null}
        </div>
        {moves ? (
          <div className="flex-none pl-1 text-right">
            <p className="text-card-money text-ink">{amount}</p>
            <p className="mt-0.5 text-meta leading-4 text-muted-foreground">
              {landing
                ? "done"
                : step === "held"
                  ? "not confirmed"
                  : step === "running"
                    ? "on its way"
                    : card.flow === "back"
                      ? "coming back"
                      : (content.note ?? amountNote(content.title))}
            </p>
          </div>
        ) : null}
      </div>
      {/* A card no app vouches for says first that what follows is what Auni saw by running it. */}
      {content.checks ? (
        <CheckHeading checked className="mt-5 border-t border-foreground/[0.06] pt-5">
          {content.checks.checked}
        </CheckHeading>
      ) : null}
      {detail.length > 0 ? (
        <dl
          className={cn(
            // Dense, so short figures still pair up around one that takes a row of its own.
            "grid grid-flow-row-dense grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3",
            content.checks ? "mt-3.5" : "mt-5 border-t border-foreground/[0.06] pt-5",
          )}
        >
          {detail.map((figure) => {
            const address = isAddress(figure.value);
            const width = figureWidth(figure, address);
            return (
              <div
                key={`${figure.label}:${figure.value}`}
                className={cn(
                  "min-w-0",
                  width === "wide" && "col-span-2 sm:col-span-1",
                  width === "row" && "col-span-full",
                )}
              >
                <dt className="text-caption text-muted-foreground">{figure.label}</dt>
                {/* Every value is read whole: it wraps, and a whole address is drawn to be checked. */}
                <dd className="mt-0.5 text-body leading-[1.4] font-semibold tracking-[-0.01em] break-words text-ink tabular-nums">
                  {address ? (
                    <FullAddress
                      address={figure.value}
                      className="text-ui font-normal tracking-normal"
                      split="narrow"
                    />
                  ) : (
                    figure.value
                  )}
                  {figure.note ? (
                    <span className="ml-1.5 text-meta font-normal tracking-normal text-muted-foreground">
                      {figure.note}
                    </span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {content.scene?.kind === "route" ? <Route {...content.scene} /> : null}
      {content.finePrint ? (
        <p className="mt-4 text-meta leading-[1.45] text-muted-foreground">{content.finePrint}</p>
      ) : null}
      {/* What Allow signs before the move itself, in core's words, until it has been allowed. */}
      {content.buysFirst && step === "ready" ? (
        <p className="mt-4 text-meta leading-[1.45] text-muted-foreground">{content.buysFirst}</p>
      ) : null}
      {content.warning ? (
        // A token's name is its maker's, unbroken at any length: it wraps, never runs off the card.
        <p className="mt-3 text-meta leading-[1.45] font-medium break-words text-destructive">
          {content.warning}
        </p>
      ) : null}
      {/* Below everything checked: the agent's own sentence, named unchecked before it is read. */}
      {content.checks?.unchecked ? (
        <figure className="mt-5 border-t border-foreground/[0.06] pt-5">
          <figcaption>
            <CheckHeading>{content.checks.unchecked.heading}</CheckHeading>
          </figcaption>
          <blockquote className="mt-2 text-body leading-[1.5] text-pretty text-ink">
            {content.checks.unchecked.says}
          </blockquote>
        </figure>
      ) : null}
      {content.checks ? (
        <p className="mt-4 text-meta leading-[1.45] text-muted-foreground">{content.checks.why}</p>
      ) : null}
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
                {card.proofWhy ?? "Auni can't vouch for this one on a tap, so it checks it's you."}
              </ProofNote>
            ) : null}
            <StepError>{failure}</StepError>
            <MoneyButtons>
              <MoneyButton
                busy={pending === "decline"}
                disabled={pending !== null}
                tone="quiet"
                onClick={() => void decide("decline")}
              >
                Not now
              </MoneyButton>
              <MoneyButton
                disabled={pending !== null}
                tone="primary"
                onClick={() => (withdraws ? setReviewing(true) : void decide("allow"))}
              >
                {content.action}
              </MoneyButton>
            </MoneyButtons>
          </>
        ) : step === "held" && failed ? (
          <div className="rounded-card border border-foreground/[0.08] px-4 py-3.5">
            <p className="text-ui leading-5 font-semibold tracking-[-0.01em] text-ink">
              Not confirmed
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
                  label: `Not confirmed: ${content.title}`,
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
    </MoneyCardFrame>
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

/**
 * What the words under it are, on a card no app vouches for: what Auni saw by running the
 * transaction, or what the agent says of it, which nobody checked. The two read as a pair.
 */
function CheckHeading({
  checked = false,
  children,
  className,
}: {
  readonly checked?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const Icon = checked ? CircleCheck : MessageCircle;
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-meta leading-[18px] font-medium",
        checked ? "text-ink" : "text-muted-foreground",
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn("size-4 flex-none", checked && "text-primary")}
        strokeWidth={2.2}
      />
      {children}
    </p>
  );
}

/** The chains Auni has artwork for, by name: its networks', and Ethereum's coin; any other is named without a mark. */
const CHAIN_LOGOS: Readonly<Record<string, string | null>> = {
  ...Object.fromEntries(NETWORK_KEYS.map((key) => [NETWORKS[key].name, NETWORKS[key].logo])),
  Ethereum: ETHEREUM.logoUrl,
};

/** A move between chains: where it leaves with what, and where it lands. */
function Route({
  from,
  sends,
  to,
}: {
  readonly from: string;
  readonly sends: string;
  readonly to: string;
}) {
  const end = (chain: string, label: string, value: string, right = false) => (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2.5",
        right && "flex-row-reverse text-right",
      )}
    >
      <LogoImage fallback={null} size={26} src={CHAIN_LOGOS[chain] ?? null} />
      <div className="min-w-0">
        <p className="truncate text-caption text-muted-foreground">{label}</p>
        <p className="mt-0.5 truncate text-body font-semibold tracking-[-0.01em] text-ink tabular-nums">
          {value}
        </p>
      </div>
    </div>
  );
  return (
    <div className="mt-5 flex items-center gap-3 border-t border-foreground/[0.06] pt-5">
      {end(from, `Leaves ${from}`, sends)}
      <ArrowRight aria-hidden className="size-4 flex-none text-muted-foreground" />
      {end(to, "Arrives on", to, true)}
    </div>
  );
}

/** A settled move: its mark, what happened in past tense, and what it means now. */
function Receipt({
  mark,
  title,
  detail,
  whole = false,
  amount,
  trailing,
}: {
  readonly mark: ReactNode;
  readonly title: string;
  readonly detail: string;
  /** Why a move failed is read to its end, where what a done one means now keeps to two lines. */
  readonly whole?: boolean;
  /** What it spent or brought back, drawn as the receipt's figure, as a plan's row draws its own. */
  readonly amount?: string | null;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 sm:flex-nowrap">
      {mark}
      <div className="min-w-0 flex-1">
        <p className="text-body leading-5 font-semibold tracking-[-0.01em] text-pretty text-ink">
          {title}
        </p>
        {detail ? (
          <p
            className={cn(
              "mt-0.5 text-meta leading-[1.4] text-pretty text-muted-foreground tabular-nums",
              !whole && "line-clamp-2",
            )}
          >
            {detail}
          </p>
        ) : null}
      </div>
      {amount ? (
        <span className="flex-none self-center text-body leading-5 font-semibold tracking-[-0.01em] text-ink tabular-nums">
          {amount}
        </span>
      ) : null}
      {/* On a phone the next step drops under the words, so they keep the width. */}
      {trailing ? (
        <span className="flex-none max-sm:basis-full max-sm:pl-[52px]">{trailing}</span>
      ) : null}
    </div>
  );
}
