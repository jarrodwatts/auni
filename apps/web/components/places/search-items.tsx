"use client";

import type { SpecialistId, ThreadId } from "@auni/shared";
import { useQuery } from "@tanstack/react-query";
import { Archive, MessageCircle } from "lucide-react";
import { usePathname } from "next/navigation";
import { useDeferredValue, useMemo, type MouseEvent, type ReactNode } from "react";

import { SpecialistOrb } from "@/components/specialist/specialist-orb";
import { AssetLogo } from "@/components/specialist/marks";
import { holdsNothing } from "@/components/specialist/use-specialists";
import { useMoney } from "@/components/money/money-provider";
import { chatHref, specialistHref } from "@/lib/app-links";
import { threadPlace } from "@/lib/data/places";
import { searchThreads } from "@/lib/data/threads";
import type { Holding, ThreadSearchResult } from "@/lib/data/views";
import { formatUsdcBalance } from "@/lib/money";

import { matchScore } from "./search-match";
import { useSearchPages } from "./search-pages";
import { ICON_CLASS_NAME, ICON_STROKE, chatAge } from "./sidebar-rows";
import { useRecentPlaces } from "./stored-state";
import { type ChatPlace, type SpecialistPlace, useMinute, usePlaces } from "./use-places";

/** One thing search can take you to or do: a link to follow, or a popup to open. */
export type SearchItem = {
  readonly key: string;
  readonly title: string;
  /** Beside the name, quieter: where it lives, or the words that matched. */
  readonly detail?: string;
  /** At the row's end: its money, how long ago. */
  readonly trailing?: ReactNode;
  readonly mark: ReactNode;
} & (
  | {
      readonly href: string;
      /** The conversation it opens, read ahead as the pointer reaches it. */
      readonly specialist?: SpecialistId;
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

const LIMIT = { specialists: 6, chats: 5, holdings: 4, pages: 4 } as const;
const ARCHIVED = <span className="text-[12.5px] text-faint">Archived</span>;
const ICON = { className: ICON_CLASS_NAME, strokeWidth: ICON_STROKE, "aria-hidden": true };

/**
 * Everything a person looks for by name, grouped, best group first: their
 * specialists, chats (their words too, once core has looked), what they
 * hold, and the app's own pages and popups.
 * Nothing typed yet: where they were last.
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
    const specialistItem = ({ specialist }: SpecialistPlace): SearchItem => ({
      key: specialist.id,
      title: specialist.name,
      mark: <SpecialistOrb specialist={specialist} size={20} />,
      trailing: holdsNothing(specialist)
        ? undefined
        : formatUsdcBalance(BigInt(specialist.value.baseUnits)),
      href: specialistHref(specialist.id),
      specialist: specialist.id,
    });
    const chatItem = ({ thread }: ChatPlace, detail?: string): SearchItem => ({
      key: thread.id,
      title: thread.title,
      mark: <MessageCircle {...ICON} />,
      ...(detail ? { detail } : { trailing: chatAge(thread.updatedAt, now) }),
      href: chatHref(thread.id),
      thread: thread.id,
    });

    if (!needle) {
      const byPath = new Map<string, SearchItem>([
        ...places.specialists.map(
          (place) => [specialistHref(place.specialist.id), specialistItem(place)] as const,
        ),
        ...places.chats.map((place) => [chatHref(place.thread.id), chatItem(place)] as const),
        ...pages.flatMap(({ item }) => ("href" in item ? [[item.href, item] as const] : [])),
      ]);
      const here = byPath.get(pathname);
      const items = recent
        .filter((path) => path !== pathname)
        .flatMap((path) => byPath.get(path) ?? [])
        .slice(0, 4);
      // Their places as the sidebar lists them fill in behind, so a short history never looks empty.
      const rest = [
        ...places.specialists.map(specialistItem),
        ...places.chats.slice(0, 3).map((place) => chatItem(place)),
      ]
        .filter(({ key }) => key !== here?.key && !items.some((item) => item.key === key))
        .slice(0, Math.max(0, 6 - items.length));
      // A new account has no places yet: the app's own pages are where to go.
      const start = pages
        .map(({ item }) => item)
        .filter((item) => !("href" in item) || item.href !== pathname)
        .slice(0, 6);
      return [
        { label: "Recent", items },
        { label: items.length > 0 ? "Your places" : "Jump to", items: rest },
        { label: "Jump to", items: items.length + rest.length > 0 ? [] : start },
      ].filter((found) => found.items.length > 0);
    }

    const score = (item: SearchItem, ...names: (string | null | undefined)[]): Scored => ({
      item,
      score: matchScore(needle, names),
    });

    const specialists = places.specialists
      .map((place) => score(specialistItem(place), place.specialist.name, place.specialist.purpose))
      .filter(({ score }) => score > 0);

    // An archived chat is found as any other, saying it is archived.
    const archivedItem = (place: ChatPlace, detail?: string): SearchItem => ({
      ...chatItem(place, detail ?? "Archived"),
      mark: <Archive {...ICON} />,
      ...(detail ? { trailing: ARCHIVED } : {}),
    });
    const chatMatches = [
      ...places.chats.map((place) => score(chatItem(place), place.thread.title)),
      ...places.archived.map((place) => score(archivedItem(place), place.thread.title)),
    ].filter(({ score }) => score > 0);
    const shown = new Set([...specialists, ...chatMatches].map(({ item }) => item.key));
    // What core found in the words themselves, under the names already matched.
    for (const result of said) {
      const place = threadPlace(result.thread);
      if (shown.has(place) || !result.snippet) continue;
      shown.add(place);
      const specialist = places.specialists.find(({ specialist }) => specialist.id === place);
      const chat = places.chats.find(({ thread }) => thread.id === place);
      const archived = places.archived.find(({ thread }) => thread.id === place);
      const item = specialist
        ? { ...specialistItem(specialist), detail: result.snippet, trailing: undefined }
        : chat
          ? chatItem(chat, result.snippet)
          : archived
            ? archivedItem(archived, result.snippet)
            : null;
      if (item) chatMatches.push({ item, score: 0.5 });
    }

    const holdings = holdingPlaces(places.specialists, portfolio?.loose.other ?? []).flatMap(
      ({ holding, where, place }) => {
        const matched = score(
          {
            key: `${holding.id}:${place?.specialist.id ?? "portfolio"}`,
            title: holding.name,
            detail: where,
            mark: <AssetLogo holding={holding} size={20} />,
            trailing: formatUsdcBalance(BigInt(holding.value.baseUnits)),
            ...(place
              ? { href: specialistHref(place.specialist.id), specialist: place.specialist.id }
              : { href: "/app" }),
          },
          holding.name,
        );
        return matched.score > 0 ? [matched] : [];
      },
    );

    const pageMatches = pages
      .map(({ item, names }) => score(item, item.title, ...names))
      .filter(({ score }) => score > 0);

    return (
      [
        group("Specialists", specialists, LIMIT.specialists),
        group("Chats", chatMatches, LIMIT.chats),
        group("Holdings", holdings, LIMIT.holdings),
        group("Go to", pageMatches, LIMIT.pages),
      ]
        .filter((found) => found.items.length > 0)
        // The group holding the best match leads; ties keep the order above.
        .map((found, index) => ({ found, index }))
        .sort((a, b) => b.found.best - a.found.best || a.index - b.index)
        .map(({ found: { label, items } }) => ({ label, items }))
    );
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

/** Each holding where it lives: inside a specialist, or loose on Portfolio. */
function holdingPlaces(specialists: readonly SpecialistPlace[], loose: readonly Holding[]) {
  return [
    ...specialists.flatMap((place) =>
      place.specialist.holdings.map((holding) => ({
        holding,
        where: `In ${place.specialist.name}`,
        place,
      })),
    ),
    ...loose.map((holding) => ({ holding, where: "On Portfolio", place: null })),
  ];
}

/** Places and chats whose conversation mentions the query, for matches their names miss. */
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
