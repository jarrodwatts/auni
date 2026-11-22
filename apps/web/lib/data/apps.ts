import { appsWireSchema, type AppsWire } from "@auni/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { requestCore } from "@/lib/core";

import { listenLive } from "./live";
import { acceptPrivate, clearPrivate } from "./private";

/** The apps as the owner sees them: core's `GET /apps`, and the switch on `PATCH /apps/:id`. */

const APPS_KEY = ["apps"] as const;

async function getApps(): Promise<AppsWire> {
  return appsWireSchema.parse(await requestCore("apps", { method: "GET" }));
}

/** Turns an app on or off; core's answer is every app as it stands after. */
async function switchApp(id: string, on: boolean): Promise<AppsWire> {
  const body = await requestCore(`apps/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ on }),
  });
  return appsWireSchema.parse(body);
}

/**
 * Saves secrets an app declared (its API key, its bot token) through its private field, by each
 * one's key, once its service took them: if it refuses one, none is saved. They are in use from
 * Auni's next step, with no restart, and core never sends them back. What core says of them when
 * the service couldn't be asked, or null.
 */
export function saveAppSecrets(field: string, typed: Readonly<Record<string, string>>) {
  return acceptPrivate(field, typed);
}

/** Forgets one of an app's secrets: the app works as if it was never given. */
export function clearAppSecret(field: string, key: string): Promise<void> {
  return clearPrivate(field, key);
}

/**
 * Every app as it stands now. It is read again whenever core says a setting was saved (a key
 * pasted here, in another tab or on a card; an app switched), so nothing waits for a reload.
 */
export function useApps() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const read = () => void queryClient.invalidateQueries({ queryKey: APPS_KEY });
    const live = listenLive((message) => {
      if (message.topic === "apps") read();
    }, read);
    return live.close;
  }, [queryClient]);
  return useQuery({ queryKey: APPS_KEY, queryFn: getApps, refetchOnWindowFocus: true });
}

/** Reads the apps again, for what changed outside this list (a chat paired, a key saved). */
export function useRefreshApps(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.invalidateQueries({ queryKey: APPS_KEY }), [queryClient]);
}

/** Flips an app's switch, keeping core's answer as how the apps stand. */
export function useSwitchApp(): (id: string, on: boolean) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (id, on) => {
      queryClient.setQueryData(APPS_KEY, await switchApp(id, on));
    },
    [queryClient],
  );
}
