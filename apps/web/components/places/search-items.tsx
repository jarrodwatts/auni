"use client";

import type { ThreadId } from "@auni/shared";
import { useQuery } from "@tanstack/react-query";
import { Archive, MessageCircle } from "lucide-react";
import { usePathname } from "next/navigation";
import { useDeferredValue, useMemo, type MouseEvent, type ReactNode } from "react";

import { AssetLogo } from "@/components/brand/marks";
import { useMoney } from "@/components/money/money-provider";
import { chatHref } from "@/lib/app-links";
import { searchThreads } from "@/lib/data/threads";
import type { ThreadSearchResult } from "@/lib/data/views";
import { formatUsdcBalance } from "@/lib/money";

import { matchScore } from "./search-match";
import { useSearchPages } from "./search-pages";
import { ICON_CLASS_NAME, ICON_STROKE, chatAge } from "./sidebar-rows";
import { useRecentPlaces } from "./stored-state";
import { type ChatPlace, useMinute, usePlaces } from "./use-places";

export type SearchItem = {
  readonly key: string;
  readonly title: string;
  readonly detail?: string;
  readonly trailing?: ReactNode;
  readonly mark: ReactNode;
} & (
  | {
      readonly href: string;
      readonly thread?: ThreadId;
      readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
    }
  | { readonly run: () => void }
);

export interface SearchGroup {
  readonly label: string;
  readonly items: readonly SearchItem[];
}

interface Scored {
  readonly item: SearchItem;
  readonly score: number;
}

const LIMIT = { threads: 6, holdings: 4, pages: 4 } as const;
const ARCHIVED = <span className="text-meta text-faint">Archived</span>;
const ICON = { className: ICON_CLASS_NAME, strokeWidth: ICON_STROKE, "aria-hidden": true };

/**
 * Everything a person looks for by name, grouped, best group first: their
 * threads (and words inside them), their holdings, and the app's pages/popups.
 */
export function useSearchGroups(query: string, withdraw: () => void): readonly SearchGroup[] {
  const needle = query.trim();
  const places = usePlaces();
  const pages = useSearchPages(withdraw);
  const said = useWordsSaid(needle);
  const { portfolio } = useMoney();
  const recent = useRecentPlaces();
  const pathname = usePathname();
  const now = useMinute();

  return useMemo(() => {
    const chatItem = ({ thread, take }: ChatPlace, detail?: string): SearchItem => ({
      key: thread.id,
      title: thread.title,
      mark: <MessageCircle {...ICON} />,
      ...(detail
        ? { detail }
        : { trailing: take ? formatUsdcBalance(take.value) : chatAge(thread.updatedAt, now) }),
      href: chatHref(thread.id),
      thread: thread.id,
    });

    if (!needle) {
      const byPath = new Map<string, SearchItem>([
        ...places.chats.map((place) => [chatHref(place.thread.id), chatItem(place)] as const),
        ...pages.flatMap(({ item }) => ("href" in item ? [[item.href, item] as const] : [])),
      ]);
      const here = byPath.get(pathname);
      const items = recent
        .filter((path) => path !== pathname)
        .flatMap((path) => byPath.get(path) ?? [])
        .slice(0, 4);
      const rest = places.chats
        .slice(0, 6)
        .map((place) => chatItem(place))
        .filter(({ key }) => key !== here?.key && !items.some((item) => item.key === key))
        .slice(0, Math.max(0, 6 - items.length));
      const start = pages
        .map(({ item }) => item)
        .filter((item) => !("href" in item) || item.href !== pathname)
        .slice(0, 6);
      return [
        { label: "Recent", items },
        { label: items.length > 0 ? "Chats" : "Jump to", items: rest },
        { label: "Jump to", items: items.length + rest.length > 0 ? [] : start },
      ].filter((found) => found.items.length > 0);
    }

    const score = (item: SearchItem, ...names: (string | null | undefined)[]): Scored => ({
      item,
      score: matchScore(needle, names),
    });

    const archivedItem = (place: ChatPlace, detail?: string): SearchItem => ({
      ...chatItem(place, detail ?? "Archived"),
      mark: <Archive {...ICON} />,
      ...(detail ? { trailing: ARCHIVED } : {}),
    });
    const threadMatches = [
      ...places.chats.map((place) => score(chatItem(place), place.thread.title)),
      ...places.archived.map((place) => score(archivedItem(place), place.thread.title)),
    ].filter(({ score }) => score > 0);
    const shown = new Set(threadMatches.map(({ item }) => item.key));
    for (const result of said) {
      const id = result.thread.id;
      if (shown.has(id) || !result.snippet) continue;
      shown.add(id);
      const chat = places.chats.find(({ thread }) => thread.id === id);
      const archived = places.archived.find(({ thread }) => thread.id === id);
      const item = chat
        ? chatItem(chat, result.snippet)
        : archived
          ? archivedItem(archived, result.snippet)
          : null;
      if (item) threadMatches.push({ item, score: 0.5 });
    }

    const holdings = (portfolio?.holdings ?? []).flatMap((holding) => {
      const matched = score(
        {
          key: `holding:${holding.id}`,
          title: holding.name,
          detail: holding.detail,
          mark: <AssetLogo holding={holding} size={20} />,
          trailing: formatUsdcBalance(BigInt(holding.value.baseUnits)),
          href: "/app",
        },
        holding.name,
      );
      return matched.score > 0 ? [matched] : [];
    });

    const pageMatches = pages
      .map(({ item, names }) => score(item, item.title, ...names))
      .filter(({ score }) => score > 0);

    return [
      group("Chats", threadMatches, LIMIT.threads),
      group("Holdings", holdings, LIMIT.holdings),
      group("Go to", pageMatches, LIMIT.pages),
    ]
      .filter((found) => found.items.length > 0)
      .map((found, index) => ({ found, index }))
      .sort((a, b) => b.found.best - a.found.best || a.index - b.index)
      .map(({ found: { label, items } }) => ({ label, items }));
  }, [needle, now, pages, pathname, places, portfolio, recent, said]);
}

function group(label: string, scored: readonly Scored[], limit: number) {
  const sorted = scored.toSorted((a, b) => b.score - a.score);
  return {
    label,
    best: sorted[0]?.score ?? 0,
    items: sorted.slice(0, limit).map(({ item }) => item),
  };
}

function useWordsSaid(query: string): readonly ThreadSearchResult[] {
  const needle = useDeferredValue(query);
  const search = useQuery({
    queryKey: ["thread-search", needle],
    queryFn: ({ signal }) => searchThreads(needle, signal),
    enabled: needle.length >= 2,
    staleTime: 30_000,
  });
  return search.data ?? EMPTY;
}

const EMPTY: readonly ThreadSearchResult[] = [];
