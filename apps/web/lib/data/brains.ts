import { brainsWireSchema, type BrainsWire } from "@auni/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { ME_KEY } from "@/components/personalization/use-me";
import { requestCore } from "@/lib/core";

import { listenLive } from "./live";
import { acceptPrivate } from "./private";

/**
 * The owner's AI, as core's `GET /brains` says it stands on this computer, and the asks that make
 * one ready from here: install its CLI, start its own sign-in, stop either. What a sign-in shows
 * is the same on every open device, so any of them can finish it.
 */

const BRAINS_KEY = ["brains"] as const;
/** First run's facts carry the brains too (setup.ts), so they're read again with them. */
const SETUP_KEY = ["setup"] as const;
/** A sign-in finished in the owner's own terminal is seen this soon, as nothing else says so. */
const WATCH_MS = 3_000;

const getBrains = async (): Promise<BrainsWire> =>
  brainsWireSchema.parse(await requestCore("brains", { method: "GET" }));

const thinks = (state: string) => state === "ready" || state === "resting";

/** Every brain app as it stands now, read again whenever core says a task moved on. */
export function useBrains() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const read = () => {
      void queryClient.invalidateQueries({ queryKey: BRAINS_KEY });
      void queryClient.invalidateQueries({ queryKey: SETUP_KEY });
    };
    const live = listenLive((message) => {
      if (message.topic === "brains") read();
    }, read);
    return live.close;
  }, [queryClient]);
  return useQuery({
    queryKey: BRAINS_KEY,
    queryFn: getBrains,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: ({ state }) =>
      state.data?.rows.every(({ row }) => thinks(row.state)) ? false : WATCH_MS,
  });
}

/**
 * The brains as last read by whatever reads them (useBrains), without reading them here: first
 * run's question keeps them fresh, so its take knows at once whether an AI can answer it. Taken
 * as known for a minute.
 */
export function useBrainsSeen(): BrainsWire | undefined {
  const { data, isStale } = useQuery({
    queryKey: BRAINS_KEY,
    queryFn: getBrains,
    enabled: false,
    staleTime: 60_000,
  });
  return isStale ? undefined : data;
}

interface Ask {
  readonly id: string;
  readonly kind: "sign-in" | "install" | "stop";
}

/** Asks core to start a brain's sign-in or install, or to stop it; keeps its answer. */
export function useBrainAsk(): (ask: Ask) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (ask) => {
      const id = encodeURIComponent(ask.id);
      const answer =
        ask.kind === "stop"
          ? await requestCore(`brains/${id}/task`, { method: "DELETE" })
          : await requestCore(`brains/${id}/${ask.kind}`, { method: "POST" });
      queryClient.setQueryData(BRAINS_KEY, brainsWireSchema.parse(answer));
    },
    [queryClient],
  );
}

/**
 * Hands the line the owner typed to the CLI's own sign-in prompt, through the private field core
 * declared for it: never a form, the query cache or storage, and core sends nothing of it back.
 */
export function typeIntoSignIn(field: string, line: string): Promise<unknown> {
  return acceptPrivate(field, { line });
}

/** Sets or clears the owner's preferred AI brain (`BRAIN`), taking effect immediately. */
export function useSetPreferredBrain() {
  const queryClient = useQueryClient();
  return useMutation<BrainsWire, unknown, string | null>({
    mutationFn: async (brain) =>
      brainsWireSchema.parse(
        await requestCore("brains/preferred", {
          method: "PUT",
          body: JSON.stringify({ brain }),
        }),
      ),
    onSuccess: (brains) => {
      queryClient.setQueryData(BRAINS_KEY, brains);
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      void queryClient.invalidateQueries({ queryKey: SETUP_KEY });
    },
  });
}
