"use client";

import type { BriefSchedule } from "@auni/shared";
import { LoaderCircle, Plus, X } from "lucide-react";
import { useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useOwner } from "@/components/auth/owner-provider";
import {
  useAddWatchedWallet,
  useMe,
  useRemoveWatchedWallet,
  useUpdateMe,
} from "@/components/personalization/use-me";
import { useShowThinking } from "@/components/places/stored-state";
import { ChoicePills } from "@/components/ui/choice-pills";
import { Switch } from "@/components/ui/switch";
import { UNNAMED_OWNER } from "@/lib/account-display";
import { browserWallet, connect } from "@/lib/browser-wallet";
import { CoreApiError } from "@/lib/core";
import { LOOKS, useLook } from "@/lib/look";
import { cn } from "@/lib/utils";

import { briefChoice, briefFor, type BriefChoice } from "./brief";
import {
  Refusal,
  Saved,
  SAVED_MS,
  Setting,
  SETTINGS_BUTTON,
  SETTINGS_INPUT,
  SETTINGS_PRIMARY_BUTTON,
  SettingsGroup,
} from "./settings-layout";

/** Core's own words when it turns something down, else ours. */
function refusal(error: unknown, otherwise: string): string {
  return error instanceof CoreApiError && error.detail ? error.detail : otherwise;
}

/** The time zone this browser is in, when it can say. */
function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** "0x5aAe…eAed": the ends people check an address by. */
const short = (address: string) =>
  address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

/**
 * You: what Auni calls you and when it's your morning, what it tells you unasked and where,
 * what it knows about you (which the owner can read and correct), and how it looks here.
 */
export function YouPane() {
  return (
    <>
      <Basics />
      <Messages />
      <Known />
      <Look />
    </>
  );
}

function Basics() {
  const me = useMe();
  const { setOwner } = useOwner();
  const update = useUpdateMe();
  const [typed, setTyped] = useState<string | null>(null);
  const [saved, setSaved] = useState<"name" | "zone" | null>(null);
  const name = (typed ?? me.name ?? "").trim();
  const changed = typed !== null && name !== "" && name !== (me.name ?? "");
  const here = browserTimeZone();

  const flash = (what: "name" | "zone") => {
    setSaved(what);
    window.setTimeout(() => setSaved((now) => (now === what ? null : now)), SAVED_MS);
  };
  const saveName = async () => {
    if (!changed) return setTyped(null);
    setOwner(await update.mutateAsync({ name }));
    setTyped(null);
    flash("name");
  };

  return (
    <SettingsGroup>
      <Setting id="setting-name" label="Your name" hint="What Auni calls you.">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
        >
          {saved === "name" ? <Saved /> : null}
          <input
            aria-label="Your name"
            maxLength={40}
            autoComplete="given-name"
            placeholder={UNNAMED_OWNER}
            value={typed ?? me.name ?? ""}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={() => void saveName().catch(() => undefined)}
            className={cn(SETTINGS_INPUT, "w-full sm:w-[200px]")}
          />
        </form>
      </Setting>
      <Setting
        id="setting-time-zone"
        label="Time zone"
        hint={`${me.timeZone.replaceAll("_", " ")}. Your brief and anything on the clock follow it.`}
      >
        {saved === "zone" ? (
          <Saved>Updated</Saved>
        ) : here && here !== me.timeZone ? (
          <button
            type="button"
            disabled={update.isPending}
            onClick={async () => {
              setOwner(await update.mutateAsync({ time_zone: here }));
              flash("zone");
            }}
            className={SETTINGS_BUTTON}
          >
            Use {here.replaceAll("_", " ")}
          </button>
        ) : null}
      </Setting>
      {update.isError ? (
        <div className="px-4 py-3 sm:px-5">
          <Refusal>{refusal(update.error, "That wasn't saved. Try again.")}</Refusal>
        </div>
      ) : null}
    </SettingsGroup>
  );
}

/** What Auni tells the owner without being asked, when, and where. */
function Messages() {
  const me = useMe();
  const { setOwner } = useOwner();
  const update = useUpdateMe();
  const { openSettings } = useAppDialogs();
  const choice = briefChoice(me.brief);
  const at = me.brief?.at ?? "08:00";
  const paired = me.channels.filter((channel) => channel.paired);

  const setBrief = async (next: BriefChoice, time: string) => {
    const brief: BriefSchedule | null = briefFor(next, time, me.brief);
    setOwner(await update.mutateAsync({ brief }));
  };

  return (
    <SettingsGroup title="Messages from Auni">
      <Setting
        id="setting-brief"
        label="Daily brief"
        hint="How your positions and watches stand, and anything waiting on you."
        stacked
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ChoicePills
            label="Daily brief"
            options={[
              { value: "day", name: "Every day" },
              { value: "weekdays", name: "Weekdays" },
              ...(choice === "days" ? [{ value: "days" as const, name: "Some days" }] : []),
              ...(choice === "month" ? [{ value: "month" as const, name: "Monthly" }] : []),
              { value: "off", name: "Off" },
            ]}
            value={choice}
            disabled={update.isPending}
            onChange={(next) => void setBrief(next, at)}
          />
          {choice !== "off" ? (
            <label className="flex items-center gap-2 text-meta text-muted-foreground">
              at
              <input
                type="time"
                aria-label="Brief time"
                value={at}
                disabled={update.isPending}
                onChange={(event) => {
                  if (/^\d{2}:\d{2}$/u.test(event.target.value))
                    void setBrief(choice, event.target.value);
                }}
                className={cn(SETTINGS_INPUT, "h-8 px-2.5 tabular-nums")}
              />
            </label>
          ) : null}
        </div>
      </Setting>
      <Setting
        id="setting-home"
        label="Where Auni messages you"
        hint={
          paired.length === 0 ? (
            <>
              When a move lands or a watch fires.{" "}
              <button
                type="button"
                onClick={() => openSettings("devices")}
                className="font-medium text-ink underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground/60"
              >
                Add Telegram
              </button>{" "}
              to hear on your phone.
            </>
          ) : (
            "When a move lands or a watch fires."
          )
        }
        stacked
      >
        <ChoicePills
          label="Where Auni messages you"
          options={[
            { value: "", name: "Where we last talked" },
            { value: "web", name: "Only here" },
            ...paired.map((channel) => ({ value: channel.id, name: `${channel.name} too` })),
          ]}
          value={me.home ?? ""}
          disabled={update.isPending}
          onChange={(picked) => update.mutate({ home_channel: picked || null })}
        />
      </Setting>
    </SettingsGroup>
  );
}

/**
 * What Auni knows about the owner: the paragraph it keeps, which they can correct, and the
 * public things it reads to write it (an X handle, wallets it may only look at).
 */
function Known() {
  const me = useMe();
  const { setOwner } = useOwner();
  const update = useUpdateMe();
  const [editing, setEditing] = useState<string | null>(null);
  const topics = me.profileSignals?.xTopics ?? [];

  return (
    <SettingsGroup id="setting-known" title="What Auni knows about you">
      <div className="px-4 py-4 sm:px-5">
        {editing !== null ? (
          <div className="flex flex-col gap-3">
            <textarea
              aria-label="What Auni knows about you"
              rows={4}
              maxLength={1200}
              value={editing}
              onChange={(event) => setEditing(event.target.value)}
              placeholder="Into AI chips and Solana. Prefers holding to trading with leverage."
              className={cn(SETTINGS_INPUT, "h-auto min-h-[96px] w-full py-2.5 leading-[1.5]")}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={update.isPending}
                onClick={async () => {
                  setOwner(await update.mutateAsync({ profile_summary: editing.trim() || null }));
                  setEditing(null);
                }}
                className={SETTINGS_PRIMARY_BUTTON}
              >
                Save
              </button>
              <button type="button" onClick={() => setEditing(null)} className={SETTINGS_BUTTON}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-ui leading-[1.55]",
                  me.profileSummary ? "text-ink" : "text-muted-foreground",
                )}
              >
                {me.profileSummary ??
                  "Nothing yet. Auni writes this as it learns what you're into, from your chats and what you add below."}
              </p>
              {topics.length > 0 ? (
                <p className="mt-2 text-meta text-muted-foreground">{topics.join(", ")}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setEditing(me.profileSummary ?? "")}
              className={SETTINGS_BUTTON}
            >
              {me.profileSummary ? "Edit" : "Write it"}
            </button>
          </div>
        )}
      </div>
      <XHandle />
      <Watched />
    </SettingsGroup>
  );
}

function XHandle() {
  const me = useMe();
  const { setOwner } = useOwner();
  const update = useUpdateMe();
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const shown = typed ?? (me.xHandle ? `@${me.xHandle}` : "");

  const save = async (handle: string | null) => {
    setError(null);
    try {
      setOwner(await update.mutateAsync({ x_handle: handle }));
      setTyped(null);
      setSaved(true);
      window.setTimeout(() => setSaved(false), SAVED_MS);
    } catch (caught) {
      setError(refusal(caught, "That handle wasn't saved. Check it and try again."));
    }
  };

  return (
    <Setting
      id="setting-x"
      label="Your X handle"
      hint="Auni reads your public posts for what you care about. No sign-in."
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save(shown.trim() || null);
        }}
      >
        {saved ? <Saved /> : null}
        <input
          aria-label="Your X handle"
          value={shown}
          placeholder="@handle"
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(event) => {
            setTyped(event.target.value);
            setError(null);
          }}
          className={cn(SETTINGS_INPUT, "w-full sm:w-[160px]")}
        />
        {typed !== null ? (
          <button type="submit" disabled={update.isPending} className={SETTINGS_PRIMARY_BUTTON}>
            Save
          </button>
        ) : me.xHandle ? (
          <button
            type="button"
            aria-label="Remove your X handle"
            disabled={update.isPending}
            onClick={() => void save(null)}
            className={SETTINGS_BUTTON}
          >
            Remove
          </button>
        ) : null}
      </form>
      {error ? (
        <div className="mt-2">
          <Refusal>{error}</Refusal>
        </div>
      ) : null}
    </Setting>
  );
}

/** Wallets of the owner's elsewhere, which Auni may read and never move. */
function Watched() {
  const me = useMe();
  const { setOwner } = useOwner();
  const add = useAddWatchedWallet();
  const remove = useRemoveWatchedWallet();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const holdings = me.profileSignals?.watchedHoldings ?? [];

  const watch = async (address: string, label?: string) => {
    setError(null);
    if (!address.trim()) return;
    try {
      setOwner(await add.mutateAsync({ address: address.trim(), ...(label ? { label } : {}) }));
      setTyped("");
    } catch (caught) {
      setError(refusal(caught, "Paste a 0x address, a name.eth or a Solana address."));
    }
  };
  const fromBrowser = async () => {
    const provider = browserWallet();
    if (!provider) return;
    setConnecting(true);
    setError(null);
    try {
      await watch(await connect(provider), "Browser wallet");
    } catch (caught) {
      setError(refusal(caught, "Your browser wallet didn't share an address."));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Setting
      id="setting-watched"
      label="Wallets Auni watches"
      hint="Your wallets elsewhere, so Auni knows what you already hold. It can see them, never move them."
      stacked
    >
      {me.watchedWallets.length > 0 ? (
        <ul className="mb-3 flex flex-col gap-1.5">
          {me.watchedWallets.map((wallet) => (
            <li
              key={wallet.address}
              className="flex items-center gap-3 rounded-control bg-surface py-1.5 pr-1.5 pl-3"
            >
              <span className="min-w-0 flex-1 truncate text-meta text-ink">
                {wallet.label ? `${wallet.label} ` : ""}
                <span className="font-mono text-caption text-muted-foreground">
                  {short(wallet.address)}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Stop watching ${wallet.label ?? wallet.address}`}
                disabled={remove.isPending}
                onClick={async () => setOwner(await remove.mutateAsync(wallet.address))}
                className="grid size-7 place-items-center rounded-control text-faint hover:bg-foreground/[0.06] hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {me.watchedWallets.length < 5 ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void watch(typed);
          }}
        >
          <input
            aria-label="A wallet address to watch"
            value={typed}
            placeholder="0x…, name.eth or a Solana address"
            autoCapitalize="none"
            autoCorrect="off"
            disabled={add.isPending}
            onChange={(event) => {
              setTyped(event.target.value);
              setError(null);
            }}
            className={cn(SETTINGS_INPUT, "min-w-[200px] flex-1")}
          />
          <button
            type="submit"
            disabled={!typed.trim() || add.isPending}
            className={SETTINGS_BUTTON}
          >
            {add.isPending ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Watch
          </button>
          {browserWallet() ? (
            <button
              type="button"
              disabled={connecting || add.isPending}
              onClick={() => void fromBrowser()}
              className={SETTINGS_BUTTON}
            >
              Use my browser wallet
            </button>
          ) : null}
        </form>
      ) : null}
      {error ? (
        <div className="mt-2">
          <Refusal>{error}</Refusal>
        </div>
      ) : null}
      {holdings.length > 0 ? (
        <p className="mt-3 text-meta leading-[1.5] text-muted-foreground">
          Auni sees{" "}
          {holdings
            .slice(0, 6)
            .map(({ symbol }) => symbol)
            .join(", ")}
          {holdings.length > 6 ? ` and ${holdings.length - 6} more` : ""} there.
        </p>
      ) : null}
    </Setting>
  );
}

/** How Auni looks on this device and every other, and whether its thinking shows. */
function Look() {
  const [look, setLook] = useLook();
  const update = useUpdateMe();
  const { setOwner } = useOwner();
  const [thinking, setThinking] = useShowThinking();
  const active = look ?? "light";

  const pick = (id: string) => {
    setLook(id === "light" ? null : id);
    update.mutate({ look: id }, { onSuccess: setOwner });
  };

  return (
    <SettingsGroup title="On screen">
      <Setting id="setting-look" label="Light or dark" hint="On every device you use Auni on.">
        <div role="radiogroup" aria-label="Light or dark" className="flex gap-2">
          {LOOKS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={entry.id === active}
              aria-label={entry.name}
              onClick={() => pick(entry.id)}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-control p-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35",
              )}
            >
              {/* The look itself in miniature, in its own colours whatever the page wears. */}
              <span
                aria-hidden
                className={cn(
                  "flex h-11 w-16 overflow-hidden rounded-control border bg-background transition-[box-shadow,border-color]",
                  entry.id === "dark" ? "look-dark" : "look-light",
                  entry.id === active ? "border-ink ring-2 ring-ink/15" : "border-border",
                )}
              >
                <span className="w-4 border-r border-border bg-sidebar" />
                <span className="flex flex-1 flex-col justify-end gap-1 p-1.5">
                  <span className="h-1 w-7 rounded-full bg-foreground/25" />
                  <span className="h-2.5 w-full rounded-full border border-border bg-card" />
                </span>
              </span>
              <span
                className={cn(
                  "text-caption",
                  entry.id === active ? "font-medium text-ink" : "text-muted-foreground",
                )}
              >
                {entry.name}
              </span>
            </button>
          ))}
        </div>
      </Setting>
      <Setting
        id="setting-thinking"
        inline
        label="Show Auni's thinking"
        hint="Its reasoning, as it works, on this device."
      >
        <Switch
          aria-label="Show Auni's thinking"
          checked={thinking}
          onCheckedChange={setThinking}
        />
      </Setting>
    </SettingsGroup>
  );
}
