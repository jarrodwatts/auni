"use client";

import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  KeyRound,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import {
  depositAddresses,
  networksInBrief,
  shortAddress,
} from "@/components/money/portal/deposit-addresses";
import { NetworkMark } from "@/components/money/portal/network-mark";
import { useAddMissingKey, useMe, useRefreshMe } from "@/components/personalization/use-me";
import { WithdrawDialog } from "@/components/withdraw/withdraw-dialog";
import { Row } from "@/components/ui/row";
import { useApps } from "@/lib/data/apps";
import { depositNetworks } from "@/lib/data/portfolio";

import { BringSolanaDialog } from "./bring-solana-dialog";
import { SETTINGS_BUTTON, SettingLink, SettingsGroup } from "./settings-layout";
import { WalletKeysDialog } from "./wallet-keys-dialog";

/** The most network marks shown beside one address. */
const MARKS = 3;

/**
 * Your wallet: the addresses it receives on (one for every EVM network, one for Solana), money
 * in and out, and the keys: shown only after the owner proves it's them, added to where one
 * network is missing, or a Solana key of their own brought in.
 */
export function WalletPane() {
  const { wallets, walletLacks, bringSolana } = useMe();
  const apps = useApps();
  const refreshMe = useRefreshMe();
  const addKey = useAddMissingKey();
  const { openAddMoney } = useAppDialogs();
  const [open, setOpen] = useState<"withdraw" | "keys" | "bring" | null>(null);
  const [added, setAdded] = useState(false);
  const addresses = depositAddresses(depositNetworks(wallets));
  const has = addresses.length > 0;
  // Which wallet app keeps the keys, in its own words: "Keeps your keys on this computer".
  const keeper = apps.data?.apps.find(({ jobs, inUse }) => inUse && jobs.includes("keys"));

  return (
    <>
      <SettingsGroup
        id="setting-addresses"
        title="Your addresses"
        note={
          keeper?.does
            ? `${keeper.does}. Auni signs only the moves you allow.`
            : "Auni signs only the moves you allow."
        }
      >
        {has ? (
          addresses.map(({ address, networks }) => (
            <AddressRow key={address} address={address} networks={networks} />
          ))
        ) : (
          <p className="px-4 py-4 text-meta leading-[1.5] text-muted-foreground sm:px-5">
            No wallet yet. Auni makes one when you send your first take.
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup id="setting-wallet-moves">
        <SettingLink
          icon={<ArrowDownLeft />}
          label="Add money"
          hint="From an exchange or another wallet"
          onClick={() => openAddMoney()}
        />
        <SettingLink
          icon={<ArrowUpRight />}
          label="Withdraw"
          hint="To an exchange or another wallet"
          disabled={!has}
          onClick={() => setOpen("withdraw")}
        />
      </SettingsGroup>

      <SettingsGroup
        id="setting-keys"
        title="Your keys"
        note={
          addKey.isSuccess || added
            ? "Your new address is ready. Open Show your keys to back it up with the others."
            : addKey.isError
              ? "Couldn't create that address. Try again."
              : undefined
        }
      >
        <SettingLink
          icon={<ShieldCheck />}
          label="Show your keys"
          hint="To back them up. Confirm it's you first."
          disabled={!has}
          onClick={() => setOpen("keys")}
        />
        {walletLacks ? (
          <SettingLink
            icon={<Plus />}
            label={
              walletLacks === "solana"
                ? "Add a Solana address"
                : "Add an address for Monad, Base, and more"
            }
            hint="A new key, kept beside the one you have"
            disabled={addKey.isPending}
            onClick={() => addKey.mutate()}
          />
        ) : null}
        {bringSolana ? (
          <SettingLink
            icon={<KeyRound />}
            label="Use a Solana key you already have"
            hint="Paste it into a private field. Your AI never sees it."
            onClick={() => setOpen("bring")}
          />
        ) : null}
      </SettingsGroup>

      {bringSolana ? (
        <BringSolanaDialog
          field={bringSolana}
          open={open === "bring"}
          onOpenChange={(next) => setOpen(next ? "bring" : null)}
          onDone={() => {
            setOpen(null);
            setAdded(true);
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

/** One address, the networks it receives on by their marks, and a way to copy it whole. */
function AddressRow({ address, networks }: ReturnType<typeof depositAddresses>[number]) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="px-4 sm:px-5">
      <Row
        mark={
          <span className="flex items-center">
            {networks.slice(0, MARKS).map((network, index) => (
              <NetworkMark
                key={network.key}
                network={network}
                size={24}
                className="ring-2 ring-card"
                style={{ marginLeft: index === 0 ? 0 : -8, zIndex: MARKS - index }}
              />
            ))}
          </span>
        }
        title={<span className="font-mono font-normal">{shortAddress(address)}</span>}
        meta={networksInBrief(networks)}
        end={
          <button
            type="button"
            aria-label={`Copy your ${networks[0]?.networkName ?? ""} address`}
            onClick={() => {
              void navigator.clipboard.writeText(address);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_800);
            }}
            className={SETTINGS_BUTTON}
          >
            {copied ? (
              <Check aria-hidden className="size-3.5" />
            ) : (
              <Copy aria-hidden className="size-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        }
      />
    </div>
  );
}
