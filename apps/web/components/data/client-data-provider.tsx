"use client";

import type { Me } from "@auni/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

import { ME_KEY } from "@/components/personalization/use-me";
import { listenLive } from "@/lib/data/live";
import { getMe } from "@/lib/data/me";

/**
 * Owns one browser-session cache for deduplicated product reads, seeded with the owner as
 * OwnerProvider read them, so useMe always has them and every reader shares one copy.
 */
export function ClientDataProvider({
  me,
  children,
}: {
  readonly me: Me;
  readonly children: ReactNode;
}) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnWindowFocus: false,
          // One more try rides out a blip; a read that fails twice shows its error.
          retry: 1,
          staleTime: 15_000,
        },
      },
    });
    // It changes through saves, which write the answer back, and reads asked for (useRefreshMe).
    client.setQueryDefaults(ME_KEY, {
      queryFn: () => getMe(),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
    });
    client.setQueryData(ME_KEY, me);
    return client;
  });

  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ME_KEY });
    const live = listenLive((message) => {
      if (message.topic === "me") refresh();
    });
    return live.close;
  }, [queryClient]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
