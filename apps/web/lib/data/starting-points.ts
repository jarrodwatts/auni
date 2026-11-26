import {
  startingPointsWireSchema,
  type StartingPoint,
  type StartingPointsWire,
} from "@auni/shared";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { requestCore } from "@/lib/core";

import { listenLive } from "./live";

/** A new chat's starting points: core's `GET /starting-points`. */

const POLL_MS = 2_000;
/** How long new ones are waited for, read every POLL_MS: about a minute. */
const WAIT_MS = 60_000;
/**
 * How often the app, open on any page, reads them again. A read past the hour they stand asks
 * core for new ones, so they're written before a new chat needs them, and it shows them at once.
 */
const KEEP_MS = 5 * 60_000;
const KEY = ["starting-points"] as const;

/** Core's answer, and since when new ones have been waited for, unbroken. */
interface Read extends StartingPointsWire {
  readonly waitingSince: number;
}

const reader = (client: QueryClient) => async (): Promise<Read> => {
  const wire = startingPointsWireSchema.parse(
    await requestCore("starting-points", { method: "GET" }),
  );
  const before = client.getQueryData<Read>(KEY);
  return { ...wire, waitingSince: before?.pending ? before.waitingSince : Date.now() };
};

/** None saved, new ones on their way, and not yet a minute of waiting for them. */
function waitingOn(read: Read | undefined): boolean {
  return (
    read !== undefined &&
    read.pending &&
    read.points.length === 0 &&
    Date.now() - read.waitingSince < WAIT_MS
  );
}

/** The one read both a new chat and the app's shell keep, polling while new ones are written. */
function useRead() {
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => void client.invalidateQueries({ queryKey: KEY });
    const live = listenLive((message) => {
      if (message.topic === "starting-points") refresh();
    }, refresh);
    return live.close;
  }, [client]);
  return useQuery({
    queryKey: KEY,
    queryFn: reader(client),
    refetchInterval: ({ state }) => (waitingOn(state.data) ? POLL_MS : KEEP_MS),
  });
}

/**
 * The saved starting points, for a new chat. While there are none yet and core is writing them,
 * it reads again every two seconds for up to a minute; `waiting` is that time.
 */
export function useStartingPoints(): {
  readonly points: readonly StartingPoint[];
  readonly waiting: boolean;
  readonly pending: boolean;
} {
  const query = useRead();
  return {
    points: query.data?.points ?? [],
    waiting: query.isPending || waitingOn(query.data),
    pending: query.data?.pending ?? false,
  };
}

/** The same points, kept read wherever the app is open, so a new chat never waits for them. */
export function useStartingPointsKept(): readonly StartingPoint[] {
  return useRead().data?.points ?? [];
}
