"use client";

import type { NetworkKey } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, LoaderCircle, Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";

import { PairAgain } from "@/components/auth/pair-again";
import { CoreApiError } from "@/lib/core";
import { RPCS_KEY, saveAlchemyKey, saveChainRpc, useRpcs } from "@/lib/data/system";
import { cn } from "@/lib/utils";

import {
  SETTINGS_BUTTON,
  SETTINGS_INPUT,
  SETTINGS_PRIMARY_BUTTON,
  SettingsBadge,
  SettingsRow,
  SettingsSection,
} from "./settings-layout";

function isPairAgain(error: unknown): boolean {
  return error instanceof CoreApiError && error.code === "pair_again";
}

function errDetail(error: unknown, fallback: string): string {
  if (error instanceof CoreApiError && error.detail) return error.detail;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

const SOURCE_BADGE = {
  own: { label: "Custom RPC", tone: "accent" as const },
  alchemy: { label: "Alchemy", tone: "ok" as const },
  public: { label: "Public", tone: "neutral" as const },
};

export function NetworkPane({ highlightedTarget }: { readonly highlightedTarget: string | null }) {
  const queryClient = useQueryClient();
  const rpcs = useRpcs(true);

  const [alchemyDraft, setAlchemyDraft] = useState("");
  const [alchemySaving, setAlchemySaving] = useState(false);
  const [alchemyError, setAlchemyError] = useState<string | null>(null);
  const [alchemySaved, setAlchemySaved] = useState(false);

  const [editingChain, setEditingChain] = useState<NetworkKey | null>(null);
  const [rpcDraft, setRpcDraft] = useState("");
  const [rpcSaving, setRpcSaving] = useState(false);
  const [rpcError, setRpcError] = useState<string | null>(null);

  const [pairAgainFor, setPairAgainFor] = useState<"alchemy" | "rpc" | null>(null);

  if (rpcs.isPending && !rpcs.data) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-[16px] border border-foreground/[0.08] bg-card py-12 text-[13px] text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        Reading RPC configuration…
      </div>
    );
  }

  if (rpcs.isError || !rpcs.data) {
    return (
      <div className="rounded-[16px] border border-foreground/[0.08] bg-card p-5 text-[13px] text-destructive">
        Could not load network settings.
      </div>
    );
  }

  const data = rpcs.data;
  const alchemyLocked = data.alchemy.source === "environment";

  const submitAlchemy = async (value: string | null) => {
    setAlchemyError(null);
    setPairAgainFor(null);
    setAlchemySaving(true);
    try {
      const updated = await saveAlchemyKey(value);
      queryClient.setQueryData(RPCS_KEY, updated);
      setAlchemyDraft("");
      setAlchemySaved(true);
      window.setTimeout(() => setAlchemySaved(false), 2000);
    } catch (error) {
      if (isPairAgain(error)) setPairAgainFor("alchemy");
      else setAlchemyError(errDetail(error, "Could not save Alchemy API key."));
    } finally {
      setAlchemySaving(false);
    }
  };

  const submitRpc = async (chain: NetworkKey, url: string | null) => {
    setRpcError(null);
    setPairAgainFor(null);
    setRpcSaving(true);
    try {
      const updated = await saveChainRpc(chain, url);
      queryClient.setQueryData(RPCS_KEY, updated);
      setEditingChain(null);
      setRpcDraft("");
    } catch (error) {
      if (isPairAgain(error)) setPairAgainFor("rpc");
      else setRpcError(errDetail(error, "Could not save RPC URL."));
    } finally {
      setRpcSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Alchemy API key */}
      <SettingsSection
        id="setting-alchemy"
        highlighted={highlightedTarget === "setting-alchemy"}
        title="Alchemy API key"
        description="One key upgrades all supported chains from rate-limited public RPCs to Alchemy. Saved locally to your settings file and applied immediately."
        action={
          <SettingsBadge tone={data.alchemy.set ? "ok" : "neutral"}>
            {data.alchemy.source === "environment"
              ? "Set by shell env"
              : data.alchemy.set
                ? "Configured"
                : "Not set"}
          </SettingsBadge>
        }
      >
        <SettingsRow
          label="API key"
          description={
            alchemyLocked
              ? "ALCHEMY_API_KEY is exported by your machine's environment, so Auni cannot overwrite it here."
              : data.alchemy.set
                ? "Key is stored in your local .env file and never displayed again. Paste a new key to replace it."
                : "Optional. Public RPCs work out of the box."
          }
          stacked
        >
          {!alchemyLocked ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (alchemyDraft.trim()) void submitAlchemy(alchemyDraft.trim());
              }}
            >
              <div className="relative flex min-w-[220px] flex-1 items-center">
                <KeyRound className="pointer-events-none absolute left-2.5 size-3.5 text-faint" />
                <input
                  type="password"
                  value={alchemyDraft}
                  placeholder={
                    data.alchemy.set ? "Paste replacement key…" : "Paste Alchemy API key…"
                  }
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  disabled={alchemySaving}
                  onChange={(event) => {
                    setAlchemyDraft(event.target.value);
                    setAlchemyError(null);
                  }}
                  className={cn(SETTINGS_INPUT, "w-full pl-8 font-mono text-[12.5px]")}
                />
              </div>
              <button
                type="submit"
                disabled={!alchemyDraft.trim() || alchemySaving}
                className={SETTINGS_PRIMARY_BUTTON}
              >
                {alchemySaving ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : data.alchemy.set ? (
                  "Replace"
                ) : (
                  "Save"
                )}
              </button>
              {data.alchemy.set ? (
                <button
                  type="button"
                  disabled={alchemySaving}
                  onClick={() => void submitAlchemy(null)}
                  className={cn(SETTINGS_BUTTON, "text-destructive")}
                >
                  Clear
                </button>
              ) : null}
              {alchemySaved ? (
                <span className="inline-flex items-center gap-1 text-[12px] text-positive">
                  <Check className="size-3.5" />
                  Saved
                </span>
              ) : null}
            </form>
          ) : null}
          {alchemyError ? <p className="text-[12.5px] text-destructive">{alchemyError}</p> : null}
          {pairAgainFor === "alchemy" ? (
            <PairAgain then="Then save your Alchemy API key again." />
          ) : null}
        </SettingsRow>
      </SettingsSection>

      {/* Per-chain RPC URLs */}
      <SettingsSection
        id="setting-chain-rpcs"
        highlighted={highlightedTarget === "setting-chain-rpcs"}
        title="Per-chain RPC endpoints"
        description={`Precedence: Custom URL (${data.settingsFile}) → Alchemy → Public RPCs. Changes clear cached clients immediately.`}
      >
        {data.chains.map((chain) => {
          const badge = SOURCE_BADGE[chain.source];
          const editing = editingChain === chain.key;
          return (
            <SettingsRow
              key={chain.key}
              stacked={editing}
              label={
                <span className="flex items-center gap-2">
                  <span>{chain.name}</span>
                  <SettingsBadge tone={badge.tone}>{badge.label}</SettingsBadge>
                  {chain.envLocked ? <SettingsBadge tone="warn">Env locked</SettingsBadge> : null}
                </span>
              }
              description={
                chain.customHost ? (
                  <code className="font-mono text-[12px] break-all text-ink-soft">
                    {chain.customHost} (write-only override)
                  </code>
                ) : (
                  <span className="font-mono text-[11.5px] text-faint">{chain.envVar}</span>
                )
              }
            >
              {editing ? (
                <div className="flex flex-col gap-2">
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (rpcDraft.trim()) void submitRpc(chain.key, rpcDraft.trim());
                    }}
                  >
                    <input
                      type="password"
                      value={rpcDraft}
                      placeholder={
                        chain.customHost
                          ? "Paste replacement RPC URL…"
                          : "https://your-rpc-endpoint.example"
                      }
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      data-1p-ignore
                      data-lpignore="true"
                      autoFocus
                      disabled={rpcSaving}
                      onChange={(event) => {
                        setRpcDraft(event.target.value);
                        setRpcError(null);
                      }}
                      className={cn(SETTINGS_INPUT, "min-w-[240px] flex-1 font-mono text-[12.5px]")}
                    />
                    <button
                      type="submit"
                      disabled={!rpcDraft.trim() || rpcSaving}
                      className={SETTINGS_PRIMARY_BUTTON}
                    >
                      {rpcSaving ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : chain.customHost ? (
                        "Replace"
                      ) : (
                        "Save"
                      )}
                    </button>
                    {chain.customHost ? (
                      <button
                        type="button"
                        disabled={rpcSaving}
                        onClick={() => void submitRpc(chain.key, null)}
                        className={SETTINGS_BUTTON}
                      >
                        <RotateCcw className="size-3.5" />
                        Reset
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingChain(null);
                        setRpcDraft("");
                        setRpcError(null);
                      }}
                      className={SETTINGS_BUTTON}
                    >
                      Cancel
                    </button>
                  </form>
                  {rpcError ? <p className="text-[12.5px] text-destructive">{rpcError}</p> : null}
                  {pairAgainFor === "rpc" ? (
                    <PairAgain then="Then save the custom RPC URL again." />
                  ) : null}
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  {!chain.envLocked ? (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingChain(chain.key);
                        setRpcDraft("");
                        setRpcError(null);
                        setPairAgainFor(null);
                      }}
                      className={SETTINGS_BUTTON}
                    >
                      <Pencil className="size-3.5" />
                      {chain.customHost ? "Replace" : "Set custom"}
                    </button>
                  ) : null}
                </div>
              )}
            </SettingsRow>
          );
        })}
      </SettingsSection>
    </div>
  );
}
