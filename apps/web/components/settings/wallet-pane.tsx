"use client";

import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  KeyRound,
  Plus,
  ShieldCheck,
  WalletMinimal,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useAddMissingKey, useMe, useRefreshMe } from "@/components/personalization/use-me";
import { WithdrawDialog } from "@/components/withdraw/withdraw-dialog";
import { cn } from "@/lib/utils";

import { BringSolanaDialog } from "./bring-solana-dialog";
import { SETTINGS_BUTTON, SettingsRow, SettingsSection } from "./settings-layout";
import { WalletKeysDialog } from "./wallet-keys-dialog";

const ADDRESS_ON = { solana: "a Solana address", evm: "an EVM address" } as const;

export function WalletPane({ highlightedTarget }: { readonly highlightedTarget: string | null }) {
  const { wallets, walletLacks, bringSolana } = useMe();
  const refreshMe = useRefreshMe();
  const addKey = useAddMissingKey();
  const { openAddMoney } = useAppDialogs();
  const [open, setOpen] = useState<"withdraw" | "keys" | "bring" | null>(null);
  const [brought, setBrought] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (id: string, value: string) => {
    void navigator.clipboard.writeText(value);
    setCopied(id);
    window.setTimeout(() => setCopied((prev) => (prev === id ? null : prev)), 1800);
  };

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        id="setting-wallet-addresses"
        highlighted={highlightedTarget === "setting-wallet-addresses"}
        title="Local wallet addresses"
        description="Self-custody keys stored on this machine (OS keychain or 0600 file). Only moves you approve are ever signed."
        action={
          <button type="button" onClick={() => openAddMoney()} className={SETTINGS_BUTTON}>
            <Plus className="size-3.5" />
            Add money
          </button>
        }
      >
        {wallets?.evm ? (
          <SettingsRow
            label="EVM address"
            description="Same address on Monad, Base, Arbitrum, Polygon, and Ethereum."
          >
            <div className="flex items-center gap-2">
              <code className="rounded-control bg-surface px-2.5 py-1 font-mono text-caption text-ink">
                {wallets.evm.slice(0, 8)}…{wallets.evm.slice(-6)}
              </code>
              <button
                type="button"
                onClick={() => copy("evm", wallets.evm!)}
                className={SETTINGS_BUTTON}
              >
                {copied === "evm" ? (
                  <>
                    <Check className="size-3.5 text-positive" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" />
                    Copy
                  </>
                )}
              </button>
            </div>
          </SettingsRow>
        ) : null}

        {wallets?.solana ? (
          <SettingsRow label="Solana address" description="Used for Solana tokens and stocks.">
            <div className="flex items-center gap-2">
              <code className="rounded-control bg-surface px-2.5 py-1 font-mono text-caption text-ink">
                {wallets.solana.slice(0, 8)}…{wallets.solana.slice(-6)}
              </code>
              <button
                type="button"
                onClick={() => copy("solana", wallets.solana!)}
                className={SETTINGS_BUTTON}
              >
                {copied === "solana" ? (
                  <>
                    <Check className="size-3.5 text-positive" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" />
                    Copy
                  </>
                )}
              </button>
            </div>
          </SettingsRow>
        ) : null}

        {!wallets?.evm && !wallets?.solana ? (
          <div className="px-4 py-4 text-meta text-muted-foreground sm:px-5">
            No wallet yet. Auni creates one on this computer when you send your first take.
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        id="setting-wallet-actions"
        highlighted={highlightedTarget === "setting-wallet-actions"}
        title="Actions & key management"
        description="Withdraw funds or export your private keys for safekeeping."
      >
        <ActionRow
          disabled={!wallets?.evm}
          icon={<ArrowUpRight aria-hidden className="size-4" />}
          label="Withdraw"
          hint="Send USDC out to any EVM or Solana address"
          onSelect={() => setOpen("withdraw")}
        />
        {walletLacks ? (
          <ActionRow
            disabled={addKey.isPending}
            icon={<WalletMinimal aria-hidden className="size-4" />}
            label={`Add ${ADDRESS_ON[walletLacks]}`}
            hint="Generate a new local key beside your existing wallet"
            onSelect={() => addKey.mutate()}
          />
        ) : null}
        {bringSolana ? (
          <ActionRow
            disabled={false}
            icon={<KeyRound aria-hidden className="size-4" />}
            label="Import an existing Solana key"
            hint="Paste a Base58 private key into core's private field"
            onSelect={() => setOpen("bring")}
          />
        ) : null}
        <ActionRow
          disabled={!wallets?.evm && !wallets?.solana}
          icon={<ShieldCheck aria-hidden className="size-4" />}
          label="Show wallet keys"
          hint="Requires owner step-up proof"
          onSelect={() => setOpen("keys")}
        />
      </SettingsSection>

      {addKey.isSuccess || addKey.isError || brought ? (
        <p role="status" className="px-1 text-meta leading-[1.5] text-muted-foreground">
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
    </div>
  );
}

function ActionRow({
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
        "flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-foreground/[0.025] disabled:cursor-not-allowed disabled:opacity-55 sm:px-5",
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium text-ink">{label}</span>
        {hint ? <span className="mt-0.5 block text-meta text-muted-foreground">{hint}</span> : null}
      </span>
      <ChevronRight aria-hidden className="-mr-1 size-4 text-faint" />
    </button>
  );
}
