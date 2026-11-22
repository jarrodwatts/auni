import { setupWireSchema, type SetupWire } from "@auni/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { requestCore } from "@/lib/core";

/** First run: core's `GET /setup`, and the steps only the owner takes. */

const SETUP_KEY = ["setup"] as const;

const parsed = async (answer: Promise<unknown>): Promise<SetupWire> =>
  setupWireSchema.parse(await answer);

/** Where first run stands. */
export function useSetup() {
  return useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => parsed(requestCore("setup", { method: "GET" })),
    // What each step shows comes from these facts, so they're never taken as fresh for long.
    staleTime: 0,
  });
}

/**
 * Saying the spare key is saved or will be later, or sending the first take (which makes the
 * wallet).
 */
type SetupStep = {
  readonly path: "setup/backup" | "setup/backup/later" | "setup/done";
  readonly body: Record<string, never>;
};

/** Takes one step, keeping core's answer as where first run stands now. */
export function useSetupStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: SetupStep) =>
      parsed(requestCore(path, { method: "POST", body: JSON.stringify(body) })),
    onSuccess: (setup) => queryClient.setQueryData(SETUP_KEY, setup),
  });
}
