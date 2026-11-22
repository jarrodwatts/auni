"use client";

import { useState, type FormEvent, type ReactNode } from "react";

import { SpecialistOrb } from "@/components/specialist/specialist-orb";
import { auniDialogTitleClass } from "@/components/ui/auni-dialog";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Specialist } from "@/lib/data/views";
import { cn } from "@/lib/utils";

import { ManageDialogContent, ManageFooter, manageFieldClass } from "./dialog-parts";
import { useDialogSave } from "./use-specialist-manage";

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 flex items-baseline justify-between text-[13.5px] font-medium text-muted-foreground">
        {label}
        {hint ? <span className="font-normal text-faint">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function RenameForm({
  specialist,
  onDone,
}: {
  readonly specialist: Specialist;
  readonly onDone: () => void;
}) {
  const [shortName, setShortName] = useState(specialist.name);
  const [statement, setStatement] = useState(specialist.purpose);
  const { save, pending, failed } = useDialogSave(specialist.id, onDone);
  const name = shortName.trim();
  const words = statement.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save({
      ...(name !== specialist.name ? { name } : {}),
      ...(words !== specialist.purpose ? { purpose: words } : {}),
    });
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-6 pt-6 pb-6">
        <SpecialistOrb specialist={specialist} size={32} />
        <DialogTitle className={auniDialogTitleClass}>Rename</DialogTitle>
        <DialogDescription className="sr-only">
          The short name in the sidebar and the words of the belief.
        </DialogDescription>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-1">
        <Field label="Name" hint={`${name.length}/24`}>
          <input
            value={shortName}
            maxLength={24}
            onChange={(event) => setShortName(event.target.value)}
            className={manageFieldClass}
          />
        </Field>
        <Field label="What you believe">
          <textarea
            value={statement}
            rows={1}
            maxLength={160}
            onChange={(event) => setStatement(event.target.value)}
            onKeyDown={(event) => (event.key === "Enter" ? event.preventDefault() : undefined)}
            className={cn(manageFieldClass, "resize-none field-sizing-content")}
          />
        </Field>
      </div>

      <ManageFooter
        failed={failed}
        pending={pending}
        canSave={name.length > 0 && words.length > 0}
        onCancel={onDone}
        className="pt-6"
      />
    </form>
  );
}

/** The short name the sidebar shows, and the belief in the person's own words. */
export function RenameDialog({
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
      <ManageDialogContent className="sm:max-w-[420px]">
        <RenameForm specialist={specialist} onDone={() => onOpenChange(false)} />
      </ManageDialogContent>
    </Dialog>
  );
}
