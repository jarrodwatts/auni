"use client";

import type { ThreadId } from "@auni/shared";
import { Archive, PencilLine } from "lucide-react";
import { useRef, useState } from "react";

import { SpecialistOrb } from "@/components/specialist/specialist-orb";
import { RenameDialog } from "@/components/specialist/manage/rename-dialog";
import {
  retireAsk,
  useRetireSpecialist,
} from "@/components/specialist/manage/use-specialist-manage";
import { holdsNothing } from "@/components/specialist/use-specialists";
import { specialistHref } from "@/lib/app-links";
import { Change } from "@/components/specialist/marks";
import { formatUsdcChange } from "@/lib/money";
import { ConfirmDialog } from "@/components/ui/auni-dialog";
import { cn } from "@/lib/utils";

import { ATTENTION_LABEL, NewTag, WaitingDot } from "./place-marks";
import { RowAction } from "./row-action";
import { FOLD_FADE, ICON_STROKE, PlaceRow } from "./sidebar-rows";
import { teamLine } from "./team";
import type { SpecialistPlace } from "./use-places";

const COLLAPSE_MS = 220;

/**
 * What archiving a retired specialist asks first, since its button sits a hair from the row. Its
 * page and record stay, and search still finds its words.
 */
function archiveAsk(name: string) {
  return {
    title: `Archive “${name}”?`,
    body: "It leaves History. Its page and record stay as they are.",
    verb: "Archive",
  };
}

/**
 * A row's actions show once the pointer rests on it or focus moves in; a
 * touch screen has no resting pointer, so there the open specialist keeps them.
 */
const REVEAL_ACTIONS =
  "group-hover/specialist:opacity-100 group-hover/specialist:pointer-events-auto group-focus-within/specialist:opacity-100 group-focus-within/specialist:pointer-events-auto pointer-coarse:group-data-active/specialist:opacity-100 pointer-coarse:group-data-active/specialist:pointer-events-auto";

/** What the actions cover, one button or two: what trails steps aside, and the name fades out sooner. */
const MAKE_ROOM = {
  one: "group-hover/specialist:pr-10 group-focus-within/specialist:pr-10 pointer-coarse:group-data-active/specialist:pr-12",
  two: "group-hover/specialist:pr-16 group-focus-within/specialist:pr-16 pointer-coarse:group-data-active/specialist:pr-[92px]",
};
const STEP_ASIDE =
  "group-hover/specialist:invisible group-focus-within/specialist:invisible pointer-coarse:group-data-active/specialist:invisible";

/**
 * A teammate: its orb, its name, and how it is going in one line under it, with a dot on the
 * orb while a card waits. One with nothing in it offers to retire it from the row, since there's
 * nothing to sell first. A retired one sits in History, one line, its orb faded, offering to
 * rename it or archive it like a chat, once the person says so.
 */
export function SpecialistRow({
  place: { specialist, thread, attention, fresh },
  active,
  folded,
  onArchive,
}: {
  readonly place: SpecialistPlace;
  readonly active: boolean;
  readonly folded: boolean;
  /** Puts a retired one's conversation away; called once the row has folded away. */
  readonly onArchive: (thread: ThreadId) => void;
}) {
  const retired = specialist.status === "retired";
  const empty = holdsNothing(specialist);
  const retirable = !retired && empty && !folded;
  const tidy = retired && !folded && thread !== undefined;
  const [asking, setAsking] = useState<"retire" | "rename" | "archive" | null>(null);
  const [leaving, setLeaving] = useState(false);
  const retireRef = useRef<HTMLButtonElement>(null);
  const archiveRef = useRef<HTMLButtonElement>(null);
  const retire = useRetireSpecialist(specialist);
  const dialog = (name: NonNullable<typeof asking>) => ({
    open: asking === name,
    onOpenChange: (next: boolean) => setAsking(next ? name : null),
  });

  const archive = () => {
    if (!thread) return;
    setLeaving(true);
    window.setTimeout(() => onArchive(thread.id), COLLAPSE_MS);
  };

  const trailing = retired ? (
    <span className="text-[13px] text-faint">Retired</span>
  ) : fresh ? (
    <NewTag />
  ) : null;
  const acting = retirable || tidy;

  return (
    <li
      data-active={active || undefined}
      inert={leaving}
      className={cn(
        "group/specialist relative grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] duration-[220ms] ease-settle motion-reduce:transition-none",
        leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
      )}
    >
      <div className={cn("relative min-h-0", leaving && "overflow-hidden")}>
        <PlaceRow
          active={active}
          folded={folded}
          href={specialistHref(specialist.id)}
          specialist={specialist.id}
          mark={
            <>
              <SpecialistOrb
                specialist={specialist}
                size={retired ? 20 : 24}
                className={retired ? "opacity-45" : undefined}
              />
              {attention ? (
                <WaitingDot
                  attention={attention}
                  className={retired ? "-top-0.5 -right-0.5 size-2" : "-top-1 -right-1 size-2.5"}
                />
              ) : null}
            </>
          }
          title={specialist.name}
          detail={retired ? undefined : <TeamStatus specialist={specialist} />}
          status={attention ? ATTENTION_LABEL[attention] : undefined}
          className={retirable ? MAKE_ROOM.one : tidy ? MAKE_ROOM.two : undefined}
          trailing={trailing && acting ? <span className={STEP_ASIDE}>{trailing}</span> : trailing}
        />
        {acting ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-y-0 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 motion-reduce:transition-none",
              REVEAL_ACTIONS,
              FOLD_FADE,
            )}
          >
            {retirable ? (
              <RowAction
                ref={retireRef}
                label="Retire"
                name={`Retire ${specialist.name}`}
                onClick={() => setAsking("retire")}
              >
                <Archive aria-hidden className="size-4" strokeWidth={ICON_STROKE} />
              </RowAction>
            ) : (
              <>
                <RowAction
                  label="Rename"
                  name={`Rename ${specialist.name}`}
                  onClick={() => setAsking("rename")}
                >
                  <PencilLine aria-hidden className="size-4" strokeWidth={ICON_STROKE} />
                </RowAction>
                <RowAction
                  ref={archiveRef}
                  label="Archive"
                  name={`Archive ${specialist.name}`}
                  onClick={() => setAsking("archive")}
                >
                  <Archive aria-hidden className="size-4" strokeWidth={ICON_STROKE} />
                </RowAction>
              </>
            )}
          </div>
        ) : null}
      </div>
      {retirable ? (
        <ConfirmDialog
          {...retireAsk(specialist.name)}
          returnFocus={retireRef}
          onConfirm={retire}
          {...dialog("retire")}
        />
      ) : null}
      {tidy ? (
        <>
          <RenameDialog specialist={specialist} {...dialog("rename")} />
          <ConfirmDialog
            {...archiveAsk(specialist.name)}
            returnFocus={archiveRef}
            onConfirm={archive}
            {...dialog("archive")}
          />
        </>
      ) : null}
    </li>
  );
}

/**
 * Its one line, as a contact list shows one: what a take has made, in green or red, and how
 * today went; a role's pulse, or what it holds.
 */
function TeamStatus({ specialist }: { readonly specialist: SpecialistPlace["specialist"] }) {
  const line = teamLine(specialist);
  if (line.kind === "words") return line.text;
  const made = formatUsdcChange(line.madeBaseUnits);
  const tone = made.startsWith("+")
    ? "text-positive"
    : made.startsWith("−")
      ? "text-negative"
      : undefined;
  return (
    <span className="tabular-nums">
      <span className={cn("font-medium", tone)}>{made}</span> all time,{" "}
      <Change pct={line.todayPct} period="today" /> today
    </span>
  );
}
