"use client";

import { Archive, Ellipsis, PenLine, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui/auni-dialog";
import { holdsNothing } from "@/components/specialist/use-specialists";
import type { Specialist } from "@/lib/data/views";

import { ActsDialog } from "./acts-dialog";
import { RenameDialog } from "./rename-dialog";
import { retireAsk, useRetireSpecialist } from "./use-specialist-manage";

const ITEM =
  "h-9 gap-2.5 rounded-[9px] px-2.5 text-[14px] text-ink focus:bg-foreground/[0.045] focus:text-ink [&_svg]:text-faint";

type Open = "rename" | "acts" | "retire" | null;

/**
 * What you can change about a specialist, behind its "…": its name, how
 * Auni acts, and retiring it while it holds nothing; once retired, its name
 * alone. Money moves, its pot, and retiring one with money in it are asked
 * for in its conversation.
 */
export function SpecialistMenu({
  specialist,
  defaultOpen = false,
}: {
  readonly specialist: Specialist;
  /** Opens the menu on mount; for design review. */
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState<Open>(null);
  const retire = useRetireSpecialist(specialist);
  const live = specialist.status !== "retired";
  const dialog = (name: Exclude<Open, null>) => ({
    open: open === name,
    onOpenChange: (next: boolean) => setOpen(next ? name : null),
  });

  return (
    <>
      <DropdownMenu modal={false} defaultOpen={defaultOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${specialist.name} options`}
            className="flex size-8 flex-none items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-ink data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-ink"
          >
            <Ellipsis aria-hidden className="size-[18px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="w-[216px] rounded-[14px] border-foreground/[0.08] p-1.5 shadow-menu"
        >
          <DropdownMenuItem className={ITEM} onSelect={() => setOpen("rename")}>
            <PenLine aria-hidden className="size-4" />
            Rename
          </DropdownMenuItem>
          {live ? (
            <DropdownMenuItem className={ITEM} onSelect={() => setOpen("acts")}>
              <SlidersHorizontal aria-hidden className="size-4" />
              How Auni acts
            </DropdownMenuItem>
          ) : null}
          {live && holdsNothing(specialist) ? (
            <DropdownMenuItem className={ITEM} onSelect={() => setOpen("retire")}>
              <Archive aria-hidden className="size-4" />
              Retire
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog specialist={specialist} {...dialog("rename")} />
      {live ? <ActsDialog specialist={specialist} {...dialog("acts")} /> : null}
      <ConfirmDialog {...retireAsk(specialist.name)} onConfirm={retire} {...dialog("retire")} />
    </>
  );
}
