"use client";

import {
  Check,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Wallet,
} from "lucide-react";
import { useState } from "react";

import { useOwner } from "@/components/auth/owner-provider";
import {
  useAddWatchedWallet,
  useMe,
  useRefreshSignals,
  useRemoveWatchedWallet,
  useUpdateMe,
} from "@/components/personalization/use-me";
import { browserWallet, connect } from "@/lib/browser-wallet";
import { CoreApiError } from "@/lib/core";
import { useRefreshStartingPoints } from "@/lib/data/starting-points";
import { cn } from "@/lib/utils";

import {
  SETTINGS_BUTTON,
  SETTINGS_INPUT,
  SETTINGS_PRIMARY_BUTTON,
  SettingsBadge,
  SettingsRow,
  SettingsSection,
} from "./settings-layout";

function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof CoreApiError && error.detail) return error.detail;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * Effortless personalization: inspect/edit what Auni inferred, connect public X handle and
 * watch-only external wallets (zero keys needed), and refresh tailored starting prompts.
 */
export function PersonalizationPane({
  highlightedTarget,
}: {
  readonly highlightedTarget: string | null;
}) {
  const me = useMe();
  const { setOwner } = useOwner();
  const updateMe = useUpdateMe();
  const addWatched = useAddWatchedWallet();
  const removeWatched = useRemoveWatchedWallet();
  const refreshSignals = useRefreshSignals();
  const refreshPrompts = useRefreshStartingPoints();

  const [xDraft, setXDraft] = useState<string | null>(null);
  const [xError, setXError] = useState<string | null>(null);
  const [xSaved, setXSaved] = useState(false);

  const [walletInput, setWalletInput] = useState("");
  const [walletError, setWalletError] = useState<string | null>(null);
  const [connectingBrowser, setConnectingBrowser] = useState(false);

  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");

  const [promptsQueued, setPromptsQueued] = useState(false);

  const xDisplayed = xDraft ?? (me.xHandle ? `@${me.xHandle}` : "");
  const hasBrowserWallet = browserWallet() !== null;

  const saveX = async () => {
    setXError(null);
    const cleaned = xDisplayed.trim();
    try {
      const updated = await updateMe.mutateAsync({ x_handle: cleaned || null });
      setOwner(updated);
      setXDraft(null);
      setXSaved(true);
      window.setTimeout(() => setXSaved(false), 2000);
    } catch (error) {
      setXError(errorMessage(error, "Enter a valid X handle (e.g. @vitalikbuterin)."));
    }
  };

  const addAddress = async (address: string, label?: string) => {
    setWalletError(null);
    const trimmed = address.trim();
    if (!trimmed) return;
    try {
      const updated = await addWatched.mutateAsync({
        address: trimmed,
        ...(label ? { label } : {}),
      });
      setOwner(updated);
      setWalletInput("");
    } catch (error) {
      setWalletError(
        errorMessage(error, "Enter an EVM 0x address, an .eth ENS name, or a Solana address."),
      );
    }
  };

  const connectBrowser = async () => {
    const provider = browserWallet();
    if (!provider) return;
    setConnectingBrowser(true);
    setWalletError(null);
    try {
      const address = await connect(provider);
      await addAddress(address, "Browser wallet");
    } catch (error) {
      setWalletError(errorMessage(error, "Could not read an address from your browser wallet."));
    } finally {
      setConnectingBrowser(false);
    }
  };

  const signals = me.profileSignals;
  const topics = signals?.xTopics ?? [];
  const watchedHoldings = signals?.watchedHoldings ?? [];

  return (
    <div className="flex flex-col gap-5">
      {/* What Auni knows */}
      <SettingsSection
        id="setting-profile-summary"
        highlighted={highlightedTarget === "setting-profile-summary"}
        title="What Auni knows about you"
        description="Automatically inferred from your connected signals and chats. Inspect, edit, or clear anytime."
        action={
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={refreshSignals.isPending}
              onClick={async () => {
                const updated = await refreshSignals.mutateAsync();
                setOwner(updated);
              }}
              className={SETTINGS_BUTTON}
            >
              <RefreshCw className={cn("size-3.5", refreshSignals.isPending && "animate-spin")} />
              Refresh
            </button>
            {!editingSummary ? (
              <button
                type="button"
                onClick={() => {
                  setSummaryDraft(me.profileSummary ?? "");
                  setEditingSummary(true);
                }}
                className={SETTINGS_BUTTON}
              >
                <Pencil className="size-3.5" />
                Edit
              </button>
            ) : null}
          </div>
        }
      >
        <SettingsRow stacked>
          {editingSummary ? (
            <div className="flex flex-col gap-2.5">
              <textarea
                rows={4}
                maxLength={1200}
                value={summaryDraft}
                onChange={(event) => setSummaryDraft(event.target.value)}
                placeholder="e.g. Interested in AI infrastructure, Solana DeFi, and macro rate cuts. Prefers spot positions over high leverage."
                className={cn(SETTINGS_INPUT, "h-auto min-h-[88px] w-full py-2.5 leading-5")}
              />
              <div className="flex items-center justify-end gap-2">
                {me.profileSummary ? (
                  <button
                    type="button"
                    disabled={updateMe.isPending}
                    onClick={async () => {
                      const updated = await updateMe.mutateAsync({ profile_summary: null });
                      setOwner(updated);
                      setEditingSummary(false);
                    }}
                    className={cn(SETTINGS_BUTTON, "mr-auto text-destructive")}
                  >
                    Clear summary
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setEditingSummary(false)}
                  className={SETTINGS_BUTTON}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={updateMe.isPending}
                  onClick={async () => {
                    const updated = await updateMe.mutateAsync({
                      profile_summary: summaryDraft.trim() || null,
                    });
                    setOwner(updated);
                    setEditingSummary(false);
                  }}
                  className={SETTINGS_PRIMARY_BUTTON}
                >
                  Save
                </button>
              </div>
            </div>
          ) : me.profileSummary ? (
            <div className="flex flex-col gap-2.5">
              <p className="text-ui leading-[1.55] text-ink-soft">{me.profileSummary}</p>
              {topics.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {topics.map((topic) => (
                    <SettingsBadge key={topic} tone="accent">
                      {topic}
                    </SettingsBadge>
                  ))}
                </div>
              ) : null}
              {signals?.refreshedAt ? (
                <p className="text-caption text-faint">
                  Last updated {new Date(signals.refreshedAt).toLocaleString()}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-meta leading-[1.5] text-muted-foreground">
              Nothing inferred yet. Add your public X handle or a watch-only wallet below and Auni
              will read them in the background to tailor your starting ideas automatically.
            </p>
          )}
        </SettingsRow>
      </SettingsSection>

      {/* X / Twitter handle */}
      <SettingsSection
        id="setting-x-handle"
        highlighted={highlightedTarget === "setting-x-handle"}
        title="X / Twitter"
        description="Public handle only, with no login or API key needed. Auni reads your public bio to infer themes you care about."
      >
        <SettingsRow
          label="Public handle"
          description={
            signals?.xBio
              ? `Read bio: "${signals.xBio.slice(0, 120)}${signals.xBio.length > 120 ? "…" : ""}"`
              : "Paste @handle or x.com/handle"
          }
        >
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void saveX();
            }}
          >
            <input
              value={xDisplayed}
              placeholder="@handle"
              onChange={(event) => {
                setXDraft(event.target.value);
                setXError(null);
              }}
              className={cn(SETTINGS_INPUT, "w-[180px]")}
            />
            <button type="submit" disabled={updateMe.isPending} className={SETTINGS_PRIMARY_BUTTON}>
              {updateMe.isPending ? <LoaderCircle className="size-3.5 animate-spin" /> : "Save"}
            </button>
            {me.xHandle ? (
              <button
                type="button"
                disabled={updateMe.isPending}
                onClick={async () => {
                  const updated = await updateMe.mutateAsync({ x_handle: null });
                  setOwner(updated);
                  setXDraft(null);
                }}
                className={SETTINGS_BUTTON}
              >
                Clear
              </button>
            ) : null}
            {xSaved ? (
              <span className="inline-flex items-center gap-1 text-caption text-positive">
                <Check className="size-3.5" />
                Saved
              </span>
            ) : null}
          </form>
        </SettingsRow>
        {xError ? (
          <div className="px-4 py-2.5 text-meta text-destructive sm:px-5">{xError}</div>
        ) : null}
      </SettingsSection>

      {/* Watch-only external wallets */}
      <SettingsSection
        id="setting-watched-wallets"
        highlighted={highlightedTarget === "setting-watched-wallets"}
        title="Watch-only wallets"
        description="Read-only public addresses so Auni knows what you already hold elsewhere. Never asks for keys or signatures."
        action={
          hasBrowserWallet ? (
            <button
              type="button"
              disabled={connectingBrowser || addWatched.isPending}
              onClick={() => void connectBrowser()}
              className={SETTINGS_BUTTON}
            >
              {connectingBrowser ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Wallet className="size-3.5" />
              )}
              Connect browser wallet
            </button>
          ) : null
        }
      >
        <SettingsRow stacked>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addAddress(walletInput);
            }}
          >
            <input
              value={walletInput}
              placeholder="0x…, name.eth, or Solana address"
              disabled={addWatched.isPending}
              onChange={(event) => {
                setWalletInput(event.target.value);
                setWalletError(null);
              }}
              className={cn(SETTINGS_INPUT, "min-w-[220px] flex-1 font-mono text-meta")}
            />
            <button
              type="submit"
              disabled={!walletInput.trim() || addWatched.isPending}
              className={SETTINGS_PRIMARY_BUTTON}
            >
              {addWatched.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" />
              )}
              Add
            </button>
          </form>
          {walletError ? <p className="text-meta text-destructive">{walletError}</p> : null}
        </SettingsRow>

        {me.watchedWallets.length > 0 ? (
          me.watchedWallets.map((w) => (
            <SettingsRow
              key={w.address}
              label={
                <span className="flex items-center gap-2">
                  <span className="font-mono text-meta text-ink">
                    {w.label ?? shortAddress(w.address)}
                  </span>
                  <SettingsBadge tone="neutral">
                    {w.chain === "evm" ? "EVM" : "Solana"}
                  </SettingsBadge>
                </span>
              }
              description={w.label ? shortAddress(w.address) : undefined}
            >
              <button
                type="button"
                aria-label={`Remove ${w.label ?? w.address}`}
                disabled={removeWatched.isPending}
                onClick={async () => {
                  const updated = await removeWatched.mutateAsync(w.address);
                  setOwner(updated);
                }}
                className={cn(SETTINGS_BUTTON, "text-muted-foreground hover:text-destructive")}
              >
                <Trash2 className="size-3.5" />
                Remove
              </button>
            </SettingsRow>
          ))
        ) : (
          <div className="px-4 py-3 text-meta text-muted-foreground sm:px-5">
            No watch-only addresses added yet (up to 5).
          </div>
        )}

        {watchedHoldings.length > 0 ? (
          <SettingsRow
            label="Detected external holdings"
            description="Used to tailor starting prompts and market news."
            stacked
          >
            <div className="flex flex-wrap gap-1.5">
              {watchedHoldings.slice(0, 10).map((h) => (
                <SettingsBadge key={`${h.symbol}-${h.chain}`} tone="neutral">
                  {h.symbol} (${Math.round(Number(h.usdValue)).toLocaleString()})
                </SettingsBadge>
              ))}
            </div>
          </SettingsRow>
        ) : null}
      </SettingsSection>

      {/* Starting prompts refresh */}
      <SettingsSection
        title="Starting prompts"
        description="Regenerate the tailored ideas shown on your New Chat screen from live markets and your signals."
      >
        <SettingsRow
          label="Tailored starting ideas"
          description="Updates automatically as your holdings or signals change."
        >
          <div className="flex items-center gap-2">
            {promptsQueued ? (
              <span className="inline-flex items-center gap-1 text-caption text-positive">
                <Check className="size-3.5" />
                Refreshing
              </span>
            ) : null}
            <button
              type="button"
              disabled={refreshPrompts.isPending}
              onClick={async () => {
                await refreshPrompts.mutateAsync();
                setPromptsQueued(true);
                window.setTimeout(() => setPromptsQueued(false), 3000);
              }}
              className={SETTINGS_BUTTON}
            >
              <Sparkles className="size-3.5" />
              Refresh prompts now
            </button>
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
