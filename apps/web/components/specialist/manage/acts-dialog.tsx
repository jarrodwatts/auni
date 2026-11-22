"use client";

import { useState } from "react";

import { SpecialistOrb } from "@/components/specialist/specialist-orb";
import { auniDialogTitleClass } from "@/components/ui/auni-dialog";
import { Dialog, DialogDescription, DialogTitle, focusDialogTitle } from "@/components/ui/dialog";

import { ManageDialogContent, ManageFooter, ModeDetail, ModeSwitch } from "./dialog-parts";
import { useDialogSave } from "./use-specialist-manage";
import type { Specialist } from "@/lib/data/views";

function ActsForm({
  specialist,
  onDone,
}: {
  readonly specialist: Specialist;
  readonly onDone: () => void;
}) {
  const [actMode, setActMode] = useState(specialist.rules.actMode);
  const { save, pending, failed } = useDialogSave(specialist.id, onDone);

  return (
    <>
      <div className="flex items-center gap-3 px-6 pt-6 pb-5">
        <SpecialistOrb specialist={specialist} size={32} />
        <div className="min-w-0">
          <DialogTitle className={auniDialogTitleClass}>How Auni acts</DialogTitle>
          <DialogDescription className="truncate text-[13px] text-muted-foreground">
            For {specialist.name}
          </DialogDescription>
        </div>
      </div>

      <div className="flex flex-col gap-3 px-6">
        <ModeSwitch mode={actMode} onChange={setActMode} />
        <ModeDetail mode={actMode} />
      </div>

      <ManageFooter
        failed={failed}
        pending={pending}
        canSave
        onCancel={onDone}
        // Only a real change is sent, so a save never rewrites what chat set meanwhile.
        onSave={() => void save(actMode === specialist.rules.actMode ? {} : { actMode })}
        className="pt-6"
      />
    </>
  );
}

/** How Auni acts for one specialist: the same rule chat and the composer chip change. */
export function ActsDialog({
  specialist,
  open,
  onOpenChange,
}: {
  readonly specialist: Specialist;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ManageDialogContent className="sm:max-w-[400px]" onOpenAutoFocus={focusDialogTitle}>
        {/* Content unmounts on close, so every open starts from the specialist as it is now. */}
        <ActsForm specialist={specialist} onDone={() => onOpenChange(false)} />
      </ManageDialogContent>
    </Dialog>
  );
}
