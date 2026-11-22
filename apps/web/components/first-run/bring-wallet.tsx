"use client";

import { splitKeys, type PrivateCheckWire, type PrivateFieldWire } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { VaultArt } from "@/components/brand/vault-art";
import { useMoney } from "@/components/money/money-provider";
import { COUNT_DELAY_MS, COUNT_UP_MS } from "@/components/money/portal/portal-parts";
import { useCountUp } from "@/components/money/portal/use-count-up";
import { useRefreshMe } from "@/components/personalization/use-me";
import { SecretInput, SecretNote, secretRefusal } from "@/components/private-input/secret-input";
import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { acceptPrivate, checkPrivate } from "@/lib/data/private";
import { useSetup } from "@/lib/data/setup";
import { formatUsdcBalance } from "@/lib/money";

import styles from "./first-run.module.css";
import { NotLooking } from "./not-looking";

/**
 * Where an auni.io wallet's keys come from: auni.io's sign-in, which goes on to its take-home page
 * and Get my keys (signed out, the take-home page itself only sends people back to auni.io's front).
 */
const TAKE_HOME = "https://auni.io/signin";

/** How long after the last change what's pasted is checked. */
const CHECK_AFTER_MS = 250;

/**
 * The door for someone who had Auni at auni.io, as one scene on the landing's sky: their keys,
 * from auni.io's take-home page, into the wallet's private field, with Auni's back turned.
 * Bringing them home goes straight back to the landing (`onDone(true)`), where the wallet
 * settles in at the foot (WalletHome).
 */
export function BringWallet({ onDone }: { readonly onDone: (brought: boolean) => void }) {
  const setup = useSetup();
  const refreshMe = useRefreshMe();
  const queryClient = useQueryClient();
  const [typing, setTyping] = useState(false);
  const field = setup.data?.wallet.bring ?? null;
  // The door's button is gone with the take, so focus comes to the scene's title, and from it
  // Tab goes on to the paste field.
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus({ preventScroll: true }), []);

  return (
    <section className={styles.scene}>
      <NotLooking away={typing} />
      <h1 ref={title} tabIndex={-1} className={styles.sceneTitle}>
        Bring your auni.io wallet
      </h1>
      <p className={styles.sceneLine}>
        Tap <b>Get my keys</b> at{" "}
        <a href={TAKE_HOME} target="_blank" rel="noreferrer" className={styles.sceneLink}>
          auni.io
          <ArrowUpRight aria-hidden className="size-3.5" />
        </a>{" "}
        and paste them here. I won&apos;t look.
      </p>
      <div
        className={styles.sceneField}
        onFocusCapture={() => setTyping(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTyping(false);
        }}
      >
        {field ? (
          <BringKeys
            field={field}
            onDone={() => {
              refreshMe();
              void setup.refetch();
              // What was read before these keys came in says nothing of what they hold.
              void queryClient.resetQueries({ queryKey: ["portfolio"] });
              onDone(true);
            }}
          />
        ) : setup.isPending ? null : (
          <p className={styles.sceneNote}>
            This wallet makes its own keys, so it can&apos;t take yours.
          </p>
        )}
      </div>
      <button type="button" className={styles.door} onClick={() => onDone(false)}>
        Start fresh instead
      </button>
    </section>
  );
}

/**
 * The wallet's private field as the door asks it: one place to paste what Get my keys gave, read
 * as it lands, with the addresses it signs for, then one button. Where what was pasted has no
 * Solana key, one can be added on its own, from a quiet link under what the keys sign for. What's pasted lives here alone and goes only to core's
 * `/private/:id`.
 */
function BringKeys({
  field,
  onDone,
}: {
  readonly field: PrivateFieldWire;
  readonly onDone: () => void;
}) {
  const [keys, setKeys] = useState("");
  const [solana, setSolana] = useState("");
  const [check, setCheck] = useState<{ readonly of: string; readonly said: PrivateCheckWire }>();
  const [error, setError] = useState<string | null>(null);
  const [bringing, setBringing] = useState(false);
  const [addingSolana, setAddingSolana] = useState(false);
  const solanaToo = lacksSolana(keys);
  const typed = `${keys}\n${solana}`;
  const checked = check?.of === typed ? check.said : null;

  // Read a moment after each change, so a paste is checked as it lands.
  useEffect(() => {
    if (!keys.trim()) return undefined;
    let current = true;
    const reading = setTimeout(() => {
      checkPrivate(field.id, bringValues(keys, solana)).then(
        (said) => current && setCheck({ of: `${keys}\n${solana}`, said }),
        (refused: unknown) => current && setError(secretRefusal(refused)),
      );
    }, CHECK_AFTER_MS);
    return () => {
      current = false;
      clearTimeout(reading);
    };
  }, [field.id, keys, solana]);

  const bring = async () => {
    if (!checked || bringing) return;
    setBringing(true);
    try {
      await acceptPrivate(field.id, bringValues(keys, solana));
      setKeys("");
      setSolana("");
      onDone();
    } catch (refused) {
      setError(secretRefusal(refused));
      setBringing(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <SecretInput
        label="Your keys from auni.io"
        labelHidden
        value={keys}
        placeholder="Paste your keys"
        disabled={bringing}
        onChange={(value) => {
          setKeys(value);
          setError(null);
        }}
        onEnter={() => void bring()}
      />
      {solanaToo && addingSolana ? (
        <SecretInput
          label="Your Solana key"
          value={solana}
          placeholder="Base58, about 88 characters"
          disabled={bringing}
          onChange={(value) => {
            setSolana(value);
            setError(null);
          }}
          onEnter={() => void bring()}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-left text-[13px] text-destructive">
          {error}
        </p>
      ) : checked ? (
        <div aria-live="polite" className="text-left text-[13px] leading-5">
          <p className="text-ink-soft">
            Signs for{" "}
            <span className="font-mono text-[12.5px] break-all text-ink">{checked.preview}</span>
          </p>
          {checked.notes.map((note) => (
            <p key={note} className="mt-1 text-[12.5px] leading-[18px] text-muted-foreground">
              {note}
            </p>
          ))}
          {/* Asked for only by those who had one, so the field never drops in mid-paste. */}
          {solanaToo && !addingSolana ? (
            <button
              type="button"
              className="mt-1.5 text-[12.5px] font-medium text-primary underline decoration-primary/35 underline-offset-[3px] hover:decoration-current"
              onClick={() => setAddingSolana(true)}
            >
              Add your Solana key too
            </button>
          ) : null}
        </div>
      ) : (
        <SecretNote says={field.goes} />
      )}
      <MoneyButton
        tone="primary"
        className="w-full"
        busy={bringing}
        busyLabel="Bringing it home"
        disabled={!checked}
        onClick={() => void bring()}
      >
        Bring it home
      </MoneyButton>
    </div>
  );
}

/** Whether what was pasted is a whole EVM key and no Solana one, which may then come on its own. */
function lacksSolana(keys: string): boolean {
  const pasted = splitKeys(keys);
  return pasted.solana.length === 0 && pasted.evm.some((key) => /^(0x)?[0-9a-f]{64}$/iu.test(key));
}

/** What goes to the field: what was pasted, and a Solana key on its own only where that lacks one. */
function bringValues(keys: string, solana: string): Record<string, string> {
  return lacksSolana(keys) && solana.trim() ? { keys, solana } : { keys };
}

/**
 * At the landing's foot, once an auni.io wallet has come home: its vault drops in and settles, as it
 * will at the foot of the app, and what it holds counts up as Auni reads it on every network.
 */
export function WalletHome() {
  const { portfolio, watchDeposits } = useMoney();
  // Read often while this shows, so the holdings arrive as soon as Auni has them.
  useEffect(() => watchDeposits(), [watchDeposits]);
  const total = portfolio ? BigInt(portfolio.totalUsd.baseUnits) : null;
  const counted = useCountUp(
    total !== null && total > 0n ? total : null,
    COUNT_UP_MS,
    COUNT_DELAY_MS,
  );
  return (
    <p role="status" className={styles.home} data-arriving>
      <span className={styles.homeVault}>
        <VaultArt className="auni-account-mark size-8" />
      </span>
      {counted !== null ? (
        <span>
          <b className={styles.homeAmount}>{formatUsdcBalance(counted)}</b> came home with your
          wallet
        </span>
      ) : (
        <span>Your auni.io wallet is home</span>
      )}
    </p>
  );
}
