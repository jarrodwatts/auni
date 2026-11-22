"use client";

import { ArrowUpRight, LayoutGrid, Plus, ReceiptText, Settings } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useStartNew } from "@/components/app/use-start-conversation";
import { APPS_HREF } from "@/lib/app-links";

import { PortfolioMark } from "./place-marks";
import type { SearchItem } from "./search-items";
import { ICON_CLASS_NAME, ICON_STROKE, NewMark } from "./sidebar-rows";

const ICON = { className: ICON_CLASS_NAME, strokeWidth: ICON_STROKE, "aria-hidden": true } as const;

interface Page {
  readonly key: string;
  readonly title: string;
  readonly mark: ReactNode;
  /** The other words people reach for when they mean it. */
  readonly names: readonly string[];
}

const PLACES: readonly (Page & { readonly href: string })[] = [
  {
    key: "portfolio",
    title: "Portfolio",
    href: "/app",
    mark: <PortfolioMark className={ICON_CLASS_NAME} />,
    names: ["home", "money", "balance", "cash"],
  },
  {
    key: "new",
    title: "New chat",
    href: "/app/new",
    mark: <NewMark />,
    names: ["start", "specialist", "chat"],
  },
  {
    key: "activity",
    title: "Activity",
    href: "/app/activity",
    mark: <ReceiptText {...ICON} />,
    names: ["history", "transactions", "receipts", "what happened"],
  },
  {
    key: "apps",
    title: "Apps",
    href: APPS_HREF,
    mark: <LayoutGrid {...ICON} />,
    names: ["connect", "services", "venues", "keys", "api key", "chat apps", "ai", "plugins"],
  },
];

const POPUPS: readonly (Page & {
  readonly key: "add-money" | "withdraw" | "settings";
})[] = [
  {
    key: "add-money",
    title: "Add money",
    mark: <Plus {...ICON} />,
    names: ["deposit", "fund", "top up", "buy"],
  },
  {
    key: "withdraw",
    title: "Withdraw",
    mark: <ArrowUpRight {...ICON} />,
    names: ["cash out", "take out", "send", "move money out"],
  },
  {
    key: "settings",
    title: "Settings",
    mark: <Settings {...ICON} />,
    names: ["profile", "account", "wallet", "keys", "preferences"],
  },
];

/** The app's own pages and popups, each with the names it answers to. */
export function useSearchPages(withdraw: () => void) {
  const { openAddMoney, openSettings } = useAppDialogs();
  const startNew = useStartNew();
  return useMemo(() => {
    const run = {
      "add-money": () => openAddMoney(),
      withdraw,
      settings: () => openSettings(),
    };
    const places = PLACES.map(({ names, ...page }) => ({
      names,
      item: {
        ...page,
        key: `page:${page.key}`,
        ...(page.key === "new" ? { onClick: startNew } : {}),
      } satisfies SearchItem,
    }));
    const popups = POPUPS.map(({ names, ...page }) => ({
      names,
      item: { ...page, key: `page:${page.key}`, run: run[page.key] } satisfies SearchItem,
    }));
    return [...places, ...popups];
  }, [openAddMoney, openSettings, startNew, withdraw]);
}
