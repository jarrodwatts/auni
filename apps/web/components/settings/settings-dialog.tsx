"use client";

import type { Me, UpdateMeRequest } from "@auni/shared";
import {
  ArrowUpRight,
  ChevronRight,
  KeyRound,
  LifeBuoy,
  LoaderCircle,
  Server,
  UserRound,
  WalletMinimal,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useShowThinking } from "@/components/places/stored-state";
import { Mascot } from "@/components/brand/mascot";
import {
  useAddMissingKey,
  useMe,
  useRefreshMe,
  useUpdateMe,
} from "@/components/personalization/use-me";
import {
  auniDialogCardClass,
  auniDialogOutlineButtonClass,
  auniDialogOverlayClass,
  auniDialogPrimaryButtonClass,
} from "@/components/ui/auni-dialog";
import { Button } from "@/components/ui/button";
import { ChoicePills } from "@/components/ui/choice-pills";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  focusDialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { UNNAMED_OWNER } from "@/lib/account-display";
import type { SettingsSection } from "@/lib/app-links";
import { LOOKS, useLook } from "@/lib/look";
import { cn } from "@/lib/utils";

import { KeepRunning } from "./always-on-pane";
import { HelpPane } from "./help-pane";
import { FIELD, GROUP, ROW, ROW_HINT, ROW_LABEL, ROW_TEXT } from "./rows";
import { BringSolanaDialog } from "./bring-solana-dialog";
import { WalletKeysDialog } from "./wallet-keys-dialog";
import { WithdrawDialog } from "@/components/withdraw/withdraw-dialog";

interface SectionEntry {
  readonly id: SettingsSection;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly lede: string;
}

const SECTIONS: readonly [SectionEntry, ...SectionEntry[]] = [
  {
    id: "profile",
    label: "Profile",
    icon: UserRound,
    lede: "Who Auni is talking to, how it shows its work, and where it writes to you.",
  },
  {
    id: "wallet",
    label: "Wallet",
    icon: WalletMinimal,
    lede: "Your wallet's keys are yours. Only you can move money out or show them.",
  },
  {
    id: "machine",
    label: "Where Auni runs",
    icon: Server,
    lede: "How your devices reach Auni, and whether it keeps running while you're away.",
  },
  {
    id: "help",
    label: "Help",
    icon: LifeBuoy,
    lede: "When something isn't working, your own AI can look into it with you.",
  },
];

interface Draft {
  readonly name?: string;
}

/**
 * Settings as one popup that never scrolls: a short list of sections and one
 * short pane. Panes with fields save together; the rest only need Done.
 */
export function SettingsDialog({
  open,
  section,
  onSectionChange,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly section: SettingsSection;
  readonly onSectionChange: (section: SettingsSection) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const profile = useMe();
  const refreshMe = useRefreshMe();
  const updateProfile = useUpdateMe();
  const [draft, setDraft] = useState<Draft>({});
  // The chat apps Auni may write to change outside this popup (a pairing, in Apps).
  useEffect(() => {
    if (open) refreshMe();
  }, [open, refreshMe]);
  const saving = updateProfile.isPending;
  const current = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];

  const close = () => {
    setDraft({});
    updateProfile.reset();
    onOpenChange(false);
  };

  // Only what differs from the saved profile; nothing to save means the pane just closes.
  const update: UpdateMeRequest = {
    ...(draft.name !== undefined && draft.name.trim() && draft.name.trim() !== profile.name
      ? { name: draft.name.trim() }
      : {}),
  };
  const dirty = Object.keys(update).length > 0;

  const save = async () => {
    if (!dirty) return close();
    try {
      await updateProfile.mutateAsync(update);
      close();
    } catch {
      // updateProfile.isError shows the error line.
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className={cn(
          auniDialogCardClass,
          "grid grid-rows-[auto_1fr] overflow-hidden p-0 sm:h-[480px] sm:max-w-[720px] sm:grid-cols-[208px_1fr] sm:grid-rows-1 sm:p-0",
        )}
        overlayClassName={auniDialogOverlayClass}
        showCloseButton={false}
        onOpenAutoFocus={focusDialogTitle}
      >
        <nav className="flex flex-col gap-3 border-b border-foreground/[0.06] bg-sidebar p-4 sm:border-r sm:border-b-0 sm:p-5">
          <div className="flex items-center gap-2.5 px-1 sm:mb-3">
            <Mascot alt="" size={30} state="listening" />
            <DialogTitle className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
              Settings
            </DialogTitle>
          </div>
          <ul className="auni-scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1 sm:mx-0 sm:flex-col sm:gap-0.5 sm:px-0">
            {SECTIONS.map((entry) => (
              <li key={entry.id} className="flex-none">
                <button
                  type="button"
                  aria-current={entry.id === current.id ? "page" : undefined}
                  onClick={() => {
                    updateProfile.reset();
                    onSectionChange(entry.id);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[14px] whitespace-nowrap transition-colors duration-200",
                    entry.id === current.id
                      ? "bg-foreground/[0.06] font-medium text-ink"
                      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-ink",
                  )}
                >
                  <entry.icon aria-hidden className="hidden size-4 sm:block" />
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-h-0 flex-col">
          <div
            key={section}
            className="auni-field-in min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-1 sm:px-7 sm:pt-7"
          >
            <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
              {current.label}
            </h3>
            <DialogDescription className="mt-1 text-[13.5px] leading-[1.5] text-muted-foreground">
              {current.lede}
            </DialogDescription>
            <div className="mt-5">
              {current.id === "profile" ? (
                <ProfilePane
                  draft={draft}
                  onChange={(change) => setDraft((previous) => ({ ...previous, ...change }))}
                />
              ) : current.id === "wallet" ? (
                <WalletPane />
              ) : current.id === "machine" ? (
                <MachinePane />
              ) : (
                <HelpPane />
              )}
            </div>
          </div>
          <div className="flex flex-none items-center justify-end gap-3 px-5 pt-3 pb-5 sm:px-7 sm:pb-6">
            {updateProfile.isError ? (
              <p role="alert" className="mr-auto min-w-0 text-[12.5px] text-destructive">
                Your changes could not be saved. Try again.
              </p>
            ) : null}
            {dirty ? (
              <Button
                className={cn(auniDialogOutlineButtonClass, "w-auto flex-1 px-6 sm:flex-none")}
                disabled={saving}
                onClick={close}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            ) : null}
            <Button
              className={cn(auniDialogPrimaryButtonClass, "w-auto flex-1 px-8 sm:flex-none")}
              disabled={saving}
              onClick={dirty ? () => void save() : close}
              type="button"
            >
              {saving ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
              {dirty ? "Save" : "Done"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProfilePane({
  draft,
  onChange,
}: {
  readonly draft: Draft;
  readonly onChange: (change: Draft) => void;
}) {
  const { name, channels, home } = useMe();
  const [showThinking, setShowThinking] = useShowThinking();
  const paired = channels.filter((channel) => channel.paired);
  return (
    <div className={GROUP}>
      <label className={ROW}>
        <span className={cn(ROW_TEXT, ROW_LABEL)}>Name</span>
        <input
          maxLength={40}
          autoComplete="name"
          placeholder={UNNAMED_OWNER}
          value={draft.name ?? name ?? ""}
          onChange={(event) => onChange({ name: event.target.value })}
          className={FIELD}
        />
      </label>
      {/* Kept on this device and applied at once: nothing to save. */}
      <div className={ROW}>
        <span className={ROW_TEXT}>
          <span id="settings-thinking-label" className={ROW_LABEL}>
            Show Auni&apos;s thinking
          </span>
          <span className={ROW_HINT}>Shows its reasoning between steps</span>
        </span>
        <Switch
          aria-labelledby="settings-thinking-label"
          checked={showThinking}
          onCheckedChange={setShowThinking}
        />
      </div>
      {paired.length > 0 ? <HomePicker home={home} paired={paired} /> : null}
      <LookPicker />
    </div>
  );
}

/**
 * Which look Auni wears: light unless the owner picks another, Auni's dark or one an app brings. Kept on this device and applied at once, as the thinking switch is:
 * nothing to save.
 */
function LookPicker() {
  const [look, setLook] = useLook();
  return (
    <div className={cn(ROW, "flex-wrap")}>
      <span className={ROW_TEXT}>
        <span className={ROW_LABEL}>Look</span>
        <span className={ROW_HINT}>On this device</span>
      </span>
      <ChoicePills
        label="Look"
        options={LOOKS.map(({ id, name }) => ({ value: id, name }))}
        // With none picked, Auni wears light.
        value={look ?? "light"}
        onChange={(picked) => setLook(picked === "light" ? null : picked)}
        className="flex-wrap justify-end"
      />
    </div>
  );
}

/**
 * Where what Auni says unasked goes, once a chat app is paired (in Apps). Applied at once, as
 * the agent's set_notices would: nothing to save.
 */
function HomePicker({
  home,
  paired,
}: {
  readonly home: string | null;
  readonly paired: readonly Me["channels"][number][];
}) {
  const updateProfile = useUpdateMe();
  return (
    <div className={cn(ROW, "flex-wrap gap-y-1.5")}>
      <span className={ROW_TEXT}>
        <span className={ROW_LABEL}>When Auni speaks up</span>
        <span className={ROW_HINT}>
          {updateProfile.isError
            ? "That couldn't be saved. Try again."
            : "A move landing, a watch, your daily brief"}
        </span>
      </span>
      <ChoicePills
        label="When Auni speaks up"
        options={[
          { value: "", name: "Where I last talked" },
          { value: "web", name: "Only this app" },
          ...paired.map((channel) => ({ value: channel.id, name: `${channel.name} too` })),
        ]}
        value={home ?? ""}
        onChange={(picked) => updateProfile.mutate({ home_channel: picked || null })}
        disabled={updateProfile.isPending}
        className="-ml-3 basis-full flex-wrap"
      />
    </div>
  );
}

/** The network a wallet brought with one key alone has no address on, as a row names it. */
const ADDRESS_ON = { solana: "a Solana address", evm: "an EVM address" } as const;

/** Withdraw, and the keys. */
function WalletPane() {
  const { wallets, walletLacks, bringSolana } = useMe();
  const refreshMe = useRefreshMe();
  const addKey = useAddMissingKey();
  const [open, setOpen] = useState<"withdraw" | "keys" | "bring" | null>(null);
  const [brought, setBrought] = useState(false);

  return (
    <>
      <div className={GROUP}>
        <LinkRow
          disabled={!wallets?.evm}
          icon={<ArrowUpRight aria-hidden className="size-4" />}
          label="Withdraw"
          onSelect={() => setOpen("withdraw")}
        />
        {walletLacks ? (
          <LinkRow
            disabled={addKey.isPending}
            icon={<WalletMinimal aria-hidden className="size-4" />}
            label={`Add ${ADDRESS_ON[walletLacks]}`}
            hint="A new key, made on this computer"
            onSelect={() => addKey.mutate()}
          />
        ) : null}
        {bringSolana ? (
          <LinkRow
            disabled={false}
            icon={<KeyRound aria-hidden className="size-4" />}
            label="Add a Solana key you already hold"
            onSelect={() => setOpen("bring")}
          />
        ) : null}
        <LinkRow
          disabled={!wallets?.evm && !wallets?.solana}
          icon={<KeyRound aria-hidden className="size-4" />}
          label="Show wallet keys"
          onSelect={() => setOpen("keys")}
        />
      </div>
      {addKey.isSuccess || addKey.isError || brought ? (
        <p role="status" className="mt-3 px-1 text-[12.5px] leading-[1.5] text-muted-foreground">
          {addKey.isSuccess || brought
            ? "Your new address is ready. Open Show wallet keys and save its key with your backup."
            : "The address wasn't made. Try again."}
        </p>
      ) : null}
      {bringSolana ? (
        <BringSolanaDialog
          field={bringSolana}
          open={open === "bring"}
          onOpenChange={(next) => setOpen(next ? "bring" : null)}
          onDone={() => {
            setOpen(null);
            setBrought(true);
            refreshMe();
          }}
        />
      ) : null}
      <WithdrawDialog
        open={open === "withdraw"}
        onOpenChange={(next) => setOpen(next ? "withdraw" : null)}
      />
      <WalletKeysDialog
        open={open === "keys"}
        onOpenChange={(next) => setOpen(next ? "keys" : null)}
      />
    </>
  );
}

/** A hint that wraps rather than cut a sentence short. */
const SENTENCE = "mt-0.5 block text-[12.5px] leading-4 text-pretty text-muted-foreground";

/**
 * Where Auni runs: always on, the machine and the Tailscale account whose devices reach it; else
 * this computer's browser. Then whether that machine keeps Auni running, as core reads it.
 */
/**
 * Where Auni runs and whether it keeps running: one place. On this computer alone, it offers to
 * hand Auni over to one of the owner's machines that stays on (always-on-pane.tsx).
 */
function MachinePane() {
  const { reach } = useMe();
  const { host } = new URL(reach.address);
  return (
    <>
      <div className={GROUP}>
        <div className={ROW}>
          <span className={ROW_TEXT}>
            {reach.through === "tailscale" ? (
              <>
                <span className={ROW_LABEL}>Runs on {host.split(".")[0]}</span>
                <span className={SENTENCE}>
                  Reached through Tailscale, from devices signed in as {reach.owner}
                </span>
              </>
            ) : (
              <>
                <span className={ROW_LABEL}>Runs on this computer</span>
                <span className={SENTENCE}>Open it in a browser here, at {host}</span>
              </>
            )}
          </span>
        </div>
        <div className={ROW}>
          <span className={ROW_TEXT}>
            <span className={ROW_LABEL}>
              {reach.staysOn.stays ? "Keeps running" : "Not always running"}
            </span>
            <span className={SENTENCE}>{reach.staysOn.says}</span>
          </span>
        </div>
      </div>
      {reach.through === "this-computer" ? <KeepRunning /> : null}
    </>
  );
}

function LinkRow({
  disabled,
  icon,
  label,
  hint,
  onSelect,
}: {
  readonly disabled: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly hint?: string;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        ROW,
        "w-full text-left transition-colors hover:bg-foreground/[0.025] disabled:cursor-not-allowed disabled:opacity-55",
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className={ROW_TEXT}>
        <span className={ROW_LABEL}>{label}</span>
        {hint ? <span className={ROW_HINT}>{hint}</span> : null}
      </span>
      <ChevronRight aria-hidden className="-mr-1 size-4 text-faint" />
    </button>
  );
}
