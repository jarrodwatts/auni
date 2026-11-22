import {
  aboutWireSchema,
  diagnosticsWireSchema,
  logsWireSchema,
  pairingMintWireSchema,
  remoteAccessWireSchema,
  repairResultSchema,
  rpcsWireSchema,
  tailscaleEnableResultSchema,
  type AboutWire,
  type DiagnosticsWire,
  type LogsWire,
  type NetworkKey,
  type PairingMintWire,
  type RemoteAccessWire,
  type RepairResult,
  type RpcsWire,
  type TailscaleEnableResult,
} from "@auni/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ME_KEY } from "@/components/personalization/use-me";
import { requestCore } from "@/lib/core";

/** Local-first system endpoints under `/system/*`. */

const REMOTE_KEY = ["system", "remote"] as const;
const RPCS_KEY = ["system", "rpcs"] as const;
const DIAGNOSTICS_KEY = ["system", "diagnostics"] as const;
const LOGS_KEY = ["system", "logs"] as const;
const ABOUT_KEY = ["system", "about"] as const;

export function useRemoteAccess(enabled = true) {
  return useQuery<RemoteAccessWire>({
    queryKey: REMOTE_KEY,
    queryFn: async () =>
      remoteAccessWireSchema.parse(await requestCore("system/remote", { method: "GET" })),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export function useEnableTailscale() {
  const queryClient = useQueryClient();
  return useMutation<TailscaleEnableResult, unknown, { readonly port?: number }>({
    mutationFn: async (body) =>
      tailscaleEnableResultSchema.parse(
        await requestCore("system/tailscale/enable", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REMOTE_KEY });
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useDisableTailscale() {
  const queryClient = useQueryClient();
  return useMutation<{ readonly ok: boolean; readonly remote: RemoteAccessWire }>({
    mutationFn: async () => {
      const raw = (await requestCore("system/tailscale/disable", {
        method: "POST",
        body: "{}",
      })) as { ok: boolean; remote: unknown };
      return { ok: Boolean(raw.ok), remote: remoteAccessWireSchema.parse(raw.remote) };
    },
    onSuccess: ({ remote }) => {
      queryClient.setQueryData(REMOTE_KEY, remote);
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useInstallService() {
  const queryClient = useQueryClient();
  return useMutation<{ readonly ok: boolean; readonly remote: RemoteAccessWire }>({
    mutationFn: async () => {
      const raw = (await requestCore("system/service/install", {
        method: "POST",
        body: "{}",
      })) as { ok: boolean; remote: unknown };
      return { ok: Boolean(raw.ok), remote: remoteAccessWireSchema.parse(raw.remote) };
    },
    onSuccess: ({ remote }) => {
      queryClient.setQueryData(REMOTE_KEY, remote);
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useUninstallService() {
  const queryClient = useQueryClient();
  return useMutation<{ readonly ok: boolean; readonly remote: RemoteAccessWire }>({
    mutationFn: async () => {
      const raw = (await requestCore("system/service/uninstall", {
        method: "POST",
        body: "{}",
      })) as { ok: boolean; remote: unknown };
      return { ok: Boolean(raw.ok), remote: remoteAccessWireSchema.parse(raw.remote) };
    },
    onSuccess: ({ remote }) => {
      queryClient.setQueryData(REMOTE_KEY, remote);
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useMintPairingLink() {
  return useMutation<PairingMintWire, unknown, { readonly label?: string } | undefined>({
    mutationFn: async (body) =>
      pairingMintWireSchema.parse(
        await requestCore("system/sessions/pair", {
          method: "POST",
          body: JSON.stringify(body ?? {}),
        }),
      ),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation<RemoteAccessWire, unknown, string>({
    mutationFn: async (id) =>
      remoteAccessWireSchema.parse(
        await requestCore(`system/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
      ),
    onSuccess: (remote) => {
      queryClient.setQueryData(REMOTE_KEY, remote);
    },
  });
}

export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation<{ readonly revoked: number; readonly remote: RemoteAccessWire }>({
    mutationFn: async () => {
      const raw = (await requestCore("system/sessions/revoke-others", {
        method: "POST",
        body: "{}",
      })) as { revoked: number; remote: unknown };
      return {
        revoked: Number(raw.revoked ?? 0),
        remote: remoteAccessWireSchema.parse(raw.remote),
      };
    },
    onSuccess: ({ remote }) => {
      queryClient.setQueryData(REMOTE_KEY, remote);
    },
  });
}

export function useRpcs(enabled = true) {
  return useQuery<RpcsWire>({
    queryKey: RPCS_KEY,
    queryFn: async () => rpcsWireSchema.parse(await requestCore("system/rpcs", { method: "GET" })),
    enabled,
    staleTime: 0,
  });
}

export function useSaveRpc() {
  const queryClient = useQueryClient();
  return useMutation<
    RpcsWire,
    unknown,
    { readonly chain: NetworkKey; readonly url: string | null }
  >({
    mutationFn: async (body) =>
      rpcsWireSchema.parse(
        await requestCore("system/rpcs", { method: "PUT", body: JSON.stringify(body) }),
      ),
    onSuccess: (rpcs) => {
      queryClient.setQueryData(RPCS_KEY, rpcs);
    },
  });
}

export function useSaveAlchemy() {
  const queryClient = useQueryClient();
  return useMutation<RpcsWire, unknown, { readonly apiKey: string | null }>({
    mutationFn: async (body) =>
      rpcsWireSchema.parse(
        await requestCore("system/alchemy", { method: "PUT", body: JSON.stringify(body) }),
      ),
    onSuccess: (rpcs) => {
      queryClient.setQueryData(RPCS_KEY, rpcs);
    },
  });
}

export function useDiagnostics(enabled = true) {
  return useQuery<DiagnosticsWire>({
    queryKey: DIAGNOSTICS_KEY,
    queryFn: async () =>
      diagnosticsWireSchema.parse(await requestCore("system/diagnostics", { method: "GET" })),
    enabled,
    staleTime: 0,
  });
}

export function useRunRepair() {
  const queryClient = useQueryClient();
  return useMutation<RepairResult, unknown, string>({
    mutationFn: async (id) =>
      repairResultSchema.parse(
        await requestCore("system/diagnostics/repair", {
          method: "POST",
          body: JSON.stringify({ id }),
        }),
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(DIAGNOSTICS_KEY, result.diagnostics);
      void queryClient.invalidateQueries({ queryKey: REMOTE_KEY });
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useLogs(enabled = false) {
  return useQuery<LogsWire>({
    queryKey: LOGS_KEY,
    queryFn: async () =>
      logsWireSchema.parse(await requestCore("system/logs?lines=200", { method: "GET" })),
    enabled,
    staleTime: 0,
  });
}

export function useAbout(enabled = true) {
  return useQuery<AboutWire>({
    queryKey: ABOUT_KEY,
    queryFn: async () =>
      aboutWireSchema.parse(await requestCore("system/about", { method: "GET" })),
    enabled,
    staleTime: 60_000,
  });
}

export function useCheckUpdate() {
  const queryClient = useQueryClient();
  return useMutation<AboutWire>({
    mutationFn: async () =>
      aboutWireSchema.parse(await requestCore("system/about?check=1", { method: "GET" })),
    onSuccess: (about) => {
      queryClient.setQueryData(ABOUT_KEY, about);
    },
  });
}
