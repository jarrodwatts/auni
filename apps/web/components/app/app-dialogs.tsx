"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { ReportDialog } from "@/components/feedback/report-dialog";
import { AddMoneyDialog } from "@/components/money/add-money-dialog";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import {
  FUNDING_DIALOG_PARAM,
  REPORT_DIALOG_PARAM,
  SETTINGS_DIALOG_PARAM,
  dialogClosedHref,
  fundingAsked,
  fundingDialogHref,
  reportDialogHref,
  reportSubject,
  settingsDialogHref,
  settingsSection,
  type FundingNeed,
  type ReportSubject,
  type SettingsLink,
} from "@/lib/app-links";

/** Links and openers for the popups, each returning to whatever page it opened over. */
export function useAppDialogs() {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams().toString();

  const addMoneyHref = fundingDialogHref(pathname, search);
  const settingsHref = useCallback(
    (section?: SettingsLink) => settingsDialogHref(pathname, search, section),
    [pathname, search],
  );

  return useMemo(
    () => ({
      addMoneyHref,
      settingsHref,
      /** Opens Add money; from a card, for what it's short of. */
      openAddMoney: (need?: FundingNeed) =>
        router.push(fundingDialogHref(pathname, search, need), { scroll: false }),
      openSettings: (section?: SettingsLink) =>
        router.push(settingsHref(section), { scroll: false }),
      /** Opens Report a problem about a move that failed, or about an app. */
      openReport: (about: ReportSubject) =>
        router.push(reportDialogHref(pathname, search, about), { scroll: false }),
    }),
    [addMoneyHref, pathname, router, search, settingsHref],
  );
}

/** Mounts each popup once for the whole product; each follows the URL. */
export function AppDialogs() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const section = settingsSection(searchParams.get(SETTINGS_DIALOG_PARAM));

  const close = (param: string) =>
    router.replace(dialogClosedHref(pathname, search, param), { scroll: false });

  return (
    <>
      <SettingsDialog
        open={section !== undefined}
        section={section ?? null}
        onSectionChange={(next, step) =>
          step === "back"
            ? router.back()
            : router[step](settingsDialogHref(pathname, search, next ?? undefined), {
                scroll: false,
              })
        }
        onOpenChange={(open) => (open ? undefined : close(SETTINGS_DIALOG_PARAM))}
      />
      <AddMoneyDialog
        asked={fundingAsked(searchParams.get(FUNDING_DIALOG_PARAM))}
        onOpenChange={(open) => (open ? undefined : close(FUNDING_DIALOG_PARAM))}
      />
      <ReportDialog
        about={reportSubject(searchParams.get(REPORT_DIALOG_PARAM))}
        onOpenChange={(open) => (open ? undefined : close(REPORT_DIALOG_PARAM))}
      />
    </>
  );
}
