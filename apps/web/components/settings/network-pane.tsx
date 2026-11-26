"use client";

import type { NetworkKey } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";

import { PairAgain } from "@/components/auth/pair-again";
import { SecretInput, secretRefusal } from "@/components/private-input/secret-input";
import { CoreApiError } from "@/lib/core";
import { acceptPrivate, clearPrivate } from "@/lib/data/private";
import { RPCS_KEY, useRpcs } from "@/lib/data/system";
import { cn } from "@/lib/utils";

import {
  SETTINGS_BUTTON,
  SETTINGS_PRIMARY_BUTTON,
  SettingsBadge,
  SettingsRow,
  SettingsSection,
} from "./settings-layout";

function isPairAgain(error: unknown): boolean {
  return error instanceof CoreApiError && error.code === "pair_again";
}

const SOURCE_BADGE = {
  own: { label: "Custom RPC", tone: "accent" as const },
  alchemy: { label: "Alchemy", tone: "ok" as const },
  public: { label: "Public", tone: "neutral" as const },
};

/**
 * Network & RPC configuration: reads non-secret status from `GET /system/rpcs` and writes
 * Alchemy keys and custom RPC URLs exclusively through core's `/private/:id` secret fields
 * (requiring owner step-up proof and never caching secrets in React Query).
 */
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
      <div className="flex items-center justify-center gap-2 rounded-card border border-foreground/[0.08] bg-card py-12 text-meta text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        Reading RPC configuration…
      </div>
    );
  }

  if (rpcs.isError || !rpcs.data) {
    return (
      <div className="rounded-card border border-foreground/[0.08] bg-card p-5 text-meta text-destructive">
        Could not load network settings.
      </div>
    );
  }

  const data = rpcs.data;
  const alchemyField = data.alchemy.field;

  const submitAlchemy = async (value: string | null) => {
    if (!alchemyField) return;
    setAlchemyError(null);
    setPairAgainFor(null);
    setAlchemySaving(true);
    try {
      if (value === null) await clearPrivate(alchemyField, "apiKey");
      else await acceptPrivate(alchemyField, { apiKey: value });
      await queryClient.invalidateQueries({ queryKey: RPCS_KEY });
      setAlchemyDraft("");
      setAlchemySaved(true);
      window.setTimeout(() => setAlchemySaved(false), 2000);
    } catch (error) {
      if (isPairAgain(error)) setPairAgainFor("alchemy");
      else setAlchemyError(secretRefusal(error));
    } finally {
      setAlchemySaving(false);
    }
  };

  const submitRpc = async (field: string | null, url: string | null) => {
    if (!field) return;
    setRpcError(null);
    setPairAgainFor(null);
    setRpcSaving(true);
    try {
      if (url === null) await clearPrivate(field, "url");
      else await acceptPrivate(field, { url });
      await queryClient.invalidateQueries({ queryKey: RPCS_KEY });
      setEditingChain(null);
      setRpcDraft("");
    } catch (error) {
      if (isPairAgain(error)) setPairAgainFor("rpc");
      else setRpcError(secretRefusal(error));
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
        description="One key upgrades all supported chains from rate-limited public RPCs to Alchemy. Sent through Auni's private field directly to your local settings file."
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
            !alchemyField
              ? "ALCHEMY_API_KEY is exported by your machine's environment, so Auni cannot overwrite it here."
              : data.alchemy.set
                ? "Key is stored in your local .env file and never displayed again. Paste a new key to replace it."
                : "Optional. Public RPCs work out of the box."
          }
          stacked
        >
          {alchemyField ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[220px] flex-1">
                  <SecretInput
                    label="Alchemy API key"
                    labelHidden
                    value={alchemyDraft}
                    placeholder={
                      data.alchemy.set ? "Paste replacement key…" : "Paste Alchemy API key…"
                    }
                    disabled={alchemySaving}
                    onChange={(value) => {
                      setAlchemyDraft(value);
                      setAlchemyError(null);
                    }}
                    onEnter={() => {
                      if (alchemyDraft.trim()) void submitAlchemy(alchemyDraft.trim());
                    }}
                  />
                </div>
                <button
                  type="button"
                  disabled={!alchemyDraft.trim() || alchemySaving}
                  onClick={() => void submitAlchemy(alchemyDraft.trim())}
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
                  <span className="inline-flex items-center gap-1 text-caption text-positive">
                    <Check className="size-3.5" />
                    Saved
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          {alchemyError ? <p className="text-meta text-destructive">{alchemyError}</p> : null}
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
        description={`Precedence: Custom URL (${data.settingsFile}) → Alchemy → Public RPCs. Custom URLs are write-only and sent through Auni's private field.`}
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
                  {chain.envLocked ? <SettingsBadge>Env locked</SettingsBadge> : null}
                </span>
              }
              description={
                chain.customHost ? (
                  <code className="font-mono text-caption break-all text-ink-soft">
                    {chain.customHost} (write-only override)
                  </code>
                ) : (
                  <span className="font-mono text-caption text-faint">{chain.envVar}</span>
                )
              }
            >
              {editing && chain.field ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-[240px] flex-1">
                      <SecretInput
                        label={`${chain.name} RPC URL`}
                        labelHidden
                        value={rpcDraft}
                        placeholder={
                          chain.customHost
                            ? "Paste replacement RPC URL…"
                            : "https://your-rpc-endpoint.example"
                        }
                        disabled={rpcSaving}
                        onChange={(value) => {
                          setRpcDraft(value);
                          setRpcError(null);
                        }}
                        onEnter={() => {
                          if (rpcDraft.trim()) void submitRpc(chain.field, rpcDraft.trim());
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      disabled={!rpcDraft.trim() || rpcSaving}
                      onClick={() => void submitRpc(chain.field, rpcDraft.trim())}
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
                        onClick={() => void submitRpc(chain.field, null)}
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
                  </div>
                  {rpcError ? <p className="text-meta text-destructive">{rpcError}</p> : null}
                  {pairAgainFor === "rpc" ? (
                    <PairAgain then="Then save the custom RPC URL again." />
                  ) : null}
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  {chain.field ? (
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
