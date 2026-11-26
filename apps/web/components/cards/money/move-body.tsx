import { ETHEREUM, NETWORK_KEYS, NETWORKS, type FilledFace } from "@auni/shared";
import { ArrowRight, MessageCircle, ShieldCheck } from "lucide-react";
import { LogoImage } from "@/components/brand/marks";
import { cn } from "@/lib/utils";

import { figureWidth } from "./action-card-content";
import type { Exchange } from "./exchange";
import { FullAddress, isAddress } from "./full-address";

type Figure = FilledFace["figures"][number];

/**
 * What a money card says between its head and its buttons: what changes hands, as one leading to
 * the other, then the quiet facts the tap also agrees to. A card no app vouches for heads these
 * with what they are, what Auni saw by running it in a simulation, and says the agent's own note
 * apart and quieter, in a dashed band, since nobody checked it.
 */
export function MoveBody({
  exchange,
  face,
  ready,
}: {
  /** The face's figures as drawn (see exchangeOf), the card's amount already said in its head. */
  readonly exchange: Exchange;
  readonly face: Omit<FilledFace, "logo">;
  /** Still waiting on the tap: what Allow also signs first is said only until then. */
  readonly ready: boolean;
}) {
  const { checks } = face;
  return (
    <div className="mt-5 flex flex-col gap-4 border-t border-border pt-5">
      {checks ? (
        <h4 className="-mb-1 flex items-center gap-1.5 text-meta leading-[18px] font-medium text-ink">
          <ShieldCheck aria-hidden className="size-4 flex-none" strokeWidth={2.2} />
          {checks.checked}
        </h4>
      ) : null}
      {exchange.scene ? <Story {...exchange.scene} /> : null}
      <Facts figures={exchange.facts} />
      {face.scene?.kind === "route" ? <Route {...face.scene} /> : null}
      <Quiet>{face.finePrint}</Quiet>
      {/* What Allow signs before the move itself, in core's words, until it has been allowed. */}
      {ready ? <Quiet>{face.buysFirst}</Quiet> : null}
      {face.warning ? (
        <p className="text-meta leading-[1.45] font-medium text-destructive">{face.warning}</p>
      ) : null}
      {/* Each permission it leaves, whole, in core's words. Its resting orders are its figures. */}
      {face.leaves
        ?.filter((left) => !left.order)
        .map(({ says }, index) => (
          <p key={index} className="text-meta leading-[1.45] font-medium text-destructive">
            {says}
          </p>
        ))}
      {/* Why the card reads this way, said of what the simulation showed. */}
      {checks ? <Quiet>{checks.why}</Quiet> : null}
      {/* The agent's own sentence, named unverified before it is read, and never louder than what was checked. */}
      {checks?.unchecked ? (
        <section className="flex flex-col gap-1.5 rounded-control border border-dashed border-foreground/20 px-4 py-3">
          <h4 className="flex items-center gap-1.5 text-meta leading-[18px] font-medium text-muted-foreground">
            <MessageCircle aria-hidden className="size-4 flex-none" strokeWidth={2.2} />
            {checks.unchecked.heading}
          </h4>
          <blockquote className="text-ui leading-[1.5] text-pretty text-muted-foreground">
            {checks.unchecked.says}
          </blockquote>
        </section>
      ) : null}
    </div>
  );
}

/** What the owner gives, leading to what they get: the move's whole story in one line. */
function Story({ pays, gets }: { readonly pays: Figure; readonly gets: Figure }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3 rounded-control bg-surface px-4 py-3">
      <Side figure={pays} />
      <ArrowRight aria-hidden className="mt-5 size-4 flex-none text-muted-foreground" />
      <Side figure={gets} />
    </div>
  );
}

function Side({ figure }: { readonly figure: Figure }) {
  return (
    <div className="min-w-0">
      <p className="text-caption text-muted-foreground">{figure.label}</p>
      <p className="mt-0.5 text-reading leading-6 font-semibold tracking-[-0.015em] text-ink tabular-nums">
        {figure.value}
      </p>
      {figure.note ? (
        <p className="text-meta leading-[18px] text-muted-foreground tabular-nums">{figure.note}</p>
      ) : null}
    </div>
  );
}

/** The rest of what the tap agrees to, each value read whole: it wraps, and an address is shown in full. */
function Facts({ figures }: { readonly figures: readonly Figure[] }) {
  if (figures.length === 0) return null;
  return (
    // Dense, so short figures still pair up around one that takes a row of its own.
    <dl className="grid grid-flow-row-dense grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      {figures.map((figure) => {
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
            <dd
              className={cn(
                "mt-0.5 text-ui leading-5 font-medium tabular-nums",
                figure.tone === "gain"
                  ? "text-positive"
                  : figure.tone === "loss"
                    ? "text-negative"
                    : "text-ink",
              )}
            >
              {address ? (
                <FullAddress address={figure.value} className="text-ui" split="narrow" />
              ) : (
                figure.value
              )}
              {figure.note ? (
                <span className="ml-1.5 text-meta font-normal text-muted-foreground">
                  {figure.note}
                </span>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Quiet({ children }: { readonly children: string | null | undefined }) {
  if (!children) return null;
  return <p className="text-meta leading-[1.45] text-pretty text-muted-foreground">{children}</p>;
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
        <p className="mt-0.5 truncate text-body font-semibold tracking-[-0.01em] text-ink">
          {value}
        </p>
      </div>
    </div>
  );
  return (
    <div className="flex items-center gap-3">
      {end(from, `Leaves ${from}`, sends)}
      <ArrowRight aria-hidden className="size-4 flex-none text-muted-foreground" />
      {end(to, "Arrives on", to, true)}
    </div>
  );
}
