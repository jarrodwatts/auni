"use client";

import { feedbackBlankUrl } from "@auni/shared";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import {
  AuniDialogMascot,
  auniDialogCardClass,
  auniDialogDescriptionClass,
  auniDialogOverlayClass,
  auniDialogTitleClass,
} from "@/components/ui/auni-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { readReport, type ReportAbout } from "@/lib/data/feedback";
import { cn } from "@/lib/utils";

import { FeedbackBody } from "./feedback-body";

/**
 * A problem the owner reports themselves, from a move that failed or from an app's sheet. Core
 * says what it would post from its own records; what happened is theirs to say on GitHub's form,
 * which opens with the rest filled in.
 */
export function ReportDialog({
  about,
  onOpenChange,
}: {
  /** What it is about; null while the dialog is closed. */
  readonly about: ReportAbout | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  // It opens from its link, not from a trigger, so it keeps what had focus (the button that
  // opened it) and hands focus back there as it closes: else a keyboard user loses their place.
  const [opener, setOpener] = useState<Element | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  if ((about !== null) !== wasOpen) {
    setWasOpen(about !== null);
    if (about !== null) setOpener(document.activeElement);
  }
  const report = useQuery({
    queryKey: ["report", about],
    queryFn: ({ signal }) => readReport(about!, signal),
    enabled: about !== null,
    // What a move recorded can change while the dialog is closed (a retry), so it is read each time.
    gcTime: 0,
  });
  return (
    <Dialog open={about !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          auniDialogCardClass,
          "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[480px]",
        )}
        overlayClassName={auniDialogOverlayClass}
        onCloseAutoFocus={(event) => {
          if (!(opener instanceof HTMLElement) || !opener.isConnected) return;
          event.preventDefault();
          opener.focus();
        }}
      >
        <AuniDialogMascot state="listening" />
        <DialogHeader className="mt-3.5 items-center gap-0 text-center sm:text-center">
          <DialogTitle className={auniDialogTitleClass}>
            {report.data?.heading ?? "Report a problem"}
          </DialogTitle>
          <DialogDescription className={auniDialogDescriptionClass}>
            Say what happened on GitHub&apos;s form. Auni fills in the rest, and nothing about your
            money.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-5" data-testid="report-dialog">
          {report.data ? (
            <FeedbackBody feedback={report.data} />
          ) : report.isError ? (
            <div className="flex flex-col gap-3">
              <p
                role="alert"
                className="text-center text-[14px] leading-[1.5] text-muted-foreground"
              >
                Auni couldn&apos;t put the report together just now. Nothing was sent.
              </p>
              <MoneyButton
                tone="primary"
                busy={report.isFetching}
                busyLabel="Trying again"
                onClick={() => void report.refetch()}
              >
                Try again
              </MoneyButton>
              <a
                href={feedbackBlankUrl("bug")}
                target="_blank"
                rel="noreferrer"
                className="text-center text-[13px] leading-5 font-medium text-muted-foreground underline decoration-foreground/20 underline-offset-2 transition-colors hover:text-ink hover:decoration-foreground/50"
              >
                Or write it yourself on GitHub
              </a>
            </div>
          ) : (
            <LoaderCircle aria-hidden className="mx-auto animate-spin text-muted-foreground" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
