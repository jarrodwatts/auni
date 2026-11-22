"use client";

import type { SpecialistUpdateCardWire } from "@auni/shared";
import { Check, Undo2 } from "lucide-react";

import {
  useSpecialistUpdate,
  useUndoSpecialistUpdate,
} from "@/components/specialist/manage/use-specialist-manage";
import { describeSpecialistUpdate } from "@/components/specialist/manage/update-summary";
import { cn } from "@/lib/utils";

type Standing = "loading" | "undoable" | "undone" | "superseded" | "retired" | "widens";

function useStanding(card: SpecialistUpdateCardWire) {
  const record = useSpecialistUpdate(card.specialistId, card.updateId);
  const undo = useUndoSpecialistUpdate(card.specialistId, card.updateId);
  const outcome = undo.data?.status;
  const standing: Standing =
    outcome === "undone" || outcome === "already_undone" || record.data?.undoneAt
      ? "undone"
      : outcome === "superseded"
        ? "superseded"
        : outcome === "retired"
          ? "retired"
          : outcome === "widens"
            ? "widens"
            : record.isSuccess
              ? "undoable"
              : "loading";
  return { standing, undo };
}

/**
 * The one-line record a chat edit to a specialist leaves under Auni's reply,
 * with Undo. Undo is refused quietly when a later change touched the same
 * fields, and says why when it would let the specialist act on its own with
 * more money than before: only the person's own go-ahead can allow that.
 */
export function SpecialistUpdateCard({ card }: { readonly card: SpecialistUpdateCardWire }) {
  const { lead, details } = describeSpecialistUpdate(card.changes);
  const { standing, undo } = useStanding(card);
  const undone = standing === "undone";

  return (
    <div
      className="my-2 flex w-full min-w-0 items-start gap-2.5 py-1 text-[14px] leading-5"
      data-standing={standing}
      data-testid="specialist-update"
    >
      <span
        aria-hidden
        className={cn(
          "mt-px flex size-[18px] flex-none items-center justify-center rounded-full text-background transition-colors",
          undone ? "bg-foreground/[0.12]" : "bg-ink",
        )}
      >
        {undone ? (
          <Undo2 className="size-[11px] text-muted-foreground" strokeWidth={2.6} />
        ) : (
          <Check className="size-[11px]" strokeWidth={3} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 sm:line-clamp-1">
          <span
            className={cn(
              "font-medium whitespace-nowrap",
              undone ? "text-muted-foreground" : "text-ink",
            )}
          >
            {lead}
          </span>
          {details.map((detail) => (
            <span key={detail} className="ml-2.5 text-muted-foreground">
              {detail}
            </span>
          ))}
        </p>
        {standing === "widens" ? (
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Undoing this now would let it act on its own with more money than before. To allow that,
            choose Act on its own below, or tap Allow on a card.
          </p>
        ) : null}
      </div>
      <span className="flex flex-none items-center gap-3">
        {standing === "undoable" ? (
          <button
            type="button"
            disabled={undo.isPending}
            onClick={() => undo.mutate()}
            className="-mx-1.5 -my-0.5 rounded-md px-1.5 py-0.5 font-medium text-ink transition-colors hover:bg-foreground/[0.05] disabled:text-faint"
          >
            {undo.isError ? "Try again" : "Undo"}
          </button>
        ) : null}
        {standing === "undone" ? <span className="text-muted-foreground">Undone</span> : null}
        {standing === "superseded" ? <span className="text-faint">Changed again since</span> : null}
      </span>
    </div>
  );
}
