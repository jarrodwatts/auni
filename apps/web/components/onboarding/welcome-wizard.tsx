"use client";

import { splitKeys, type PrivateCheckWire, type PrivateFieldWire } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  GlobeLock,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Wallet,
  WalletMinimal,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { AppKeysNeeded } from "@/components/apps/app-keys";
import { AppMark } from "@/components/apps/app-mark";
import { AppPairing } from "@/components/apps/app-pairing";
import { useOwner } from "@/components/auth/owner-provider";
import { BrainRow } from "@/components/brains/brain-row";
import { Lockup } from "@/components/brand/lockup";
import { Mascot } from "@/components/brand/mascot";
import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { readyBrain } from "@/components/first-run/first-run";
import { useFirstRun } from "@/components/first-run/use-first-run";
import { ME_KEY, useMe, useRefreshMe } from "@/components/personalization/use-me";
import { SecretInput, SecretNote, secretRefusal } from "@/components/private-input/secret-input";
import { SETTINGS_INPUT, SettingsBadge } from "@/components/settings/settings-layout";
import { usePortfolio } from "@/components/portfolio/use-portfolio";
import { ChoicePills } from "@/components/ui/choice-pills";
import { dialogClosedHref, SETTINGS_DIALOG_PARAM, WIZARD_PARAM } from "@/lib/app-links";
import { browserWallet, connect } from "@/lib/browser-wallet";
import { CoreApiError } from "@/lib/core";
import { useApps } from "@/lib/data/apps";
import { useBrains, useSetPreferredBrain } from "@/lib/data/brains";
import { getMe } from "@/lib/data/me";
import { acceptPrivate, checkPrivate } from "@/lib/data/private";
import { useSetup, useSetupStep } from "@/lib/data/setup";
import { useRemoteAccess } from "@/lib/data/system";
import { formatUsdcBalance, formatUsd } from "@/lib/money";
import { cn } from "@/lib/utils";

type StepIndex = 0 | 1 | 2;

const STEPS = [
  { id: 0 as const, label: "AI Brain", icon: Cpu },
  { id: 1 as const, label: "Wallet", icon: WalletMinimal },
  { id: 2 as const, label: "Make it yours", icon: Sparkles },
];

const CHECK_AFTER_MS = 250;

/**
 * Local-first 3-step onboarding wizard (T3 Code-inspired):
 * 1. Connect a local AI CLI brain (Claude Code / Codex)
 * 2. Create a local self-custody wallet or import existing keys
 * 3. Optional zero-friction personalization signals (public X handle, watch-only wallet,
 *    plus quick links for Tailscale remote access and chat channels)
 *
 * Skippable at any time, never forces questionnaires, and never traps open Settings links.
 */
export function WelcomeWizard() {
  const firstRun = useFirstRun();
  const searchParams = useSearchParams();
  const settingsOpen = searchParams.get(SETTINGS_DIALOG_PARAM) !== null;
  const reopened = searchParams.get(WIZARD_PARAM) === "1";

  if (!firstRun && !reopened) return null;
  return <WizardSurface firstRun={firstRun} reopened={reopened} hidden={settingsOpen} />;
}

function WizardSurface({
  firstRun,
  reopened,
  hidden,
}: {
  readonly firstRun: boolean;
  readonly reopened: boolean;
  readonly hidden: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState<StepIndex>(0);
  const [xHandle, setXHandle] = useState("");
  const [watchedWallet, setWatchedWallet] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const me = useMe();
  const setup = useSetup();
  const brains = useBrains();
  const runStep = useSetupStep();
  const { setOwner } = useOwner();
  const queryClient = useQueryClient();

  const brainReady = readyBrain(brains.data?.rows ?? []) !== null;
  const walletReady = Boolean(
    setup.data?.wallet.addresses?.evm || setup.data?.wallet.addresses?.solana,
  );

  const closeReopened = () => {
    if (reopened) {
      router.replace(dialogClosedHref(pathname, searchParams.toString(), WIZARD_PARAM), {
        scroll: false,
      });
    }
  };

  const complete = async (withSignals: boolean) => {
    if (finishing) return;
    const body = withSignals
      ? {
          ...(xHandle.trim() ? { xHandle: xHandle.trim() } : {}),
          ...(watchedWallet.trim() ? { watchedWallet: watchedWallet.trim() } : {}),
        }
      : {};
    // When re-opened from Settings with no new inputs, simply dismiss without a server round-trip.
    if (!firstRun && Object.keys(body).length === 0) {
      closeReopened();
      return;
    }
    setFinishing(true);
    setFinishError(null);
    try {
      await runStep.mutateAsync({ path: "setup/done", body });
      const fresh = await getMe();
      queryClient.setQueryData(ME_KEY, fresh);
      setOwner(fresh);
      void queryClient.invalidateQueries({ queryKey: ["starting-points"] });
      closeReopened();
    } catch (error) {
      setFinishError(
        (error instanceof CoreApiError && error.detail) ||
          (error instanceof Error && error.message) ||
          "Could not finish setup. Check your inputs or skip for now.",
      );
      setFinishing(false);
    }
  };

  return (
    <div
      id={hidden ? undefined : "main-content"}
      aria-hidden={hidden || undefined}
      className={cn(
        "fixed inset-0 z-40 flex flex-col overflow-y-auto bg-floor",
        hidden && "hidden",
      )}
    >
      {/* Top header bar */}
      <header className="flex flex-none items-center justify-between gap-4 px-5 py-4 sm:px-8 sm:py-5">
        <Lockup height={20} priority />
        <button
          type="button"
          disabled={finishing}
          onClick={() => void complete(false)}
          className="rounded-full px-3 py-1.5 text-meta font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-ink disabled:opacity-50"
        >
          Skip for now
        </button>
      </header>

      {/* Centered wizard card */}
      <div className="mx-auto flex w-full max-w-[660px] flex-1 flex-col justify-center px-4 pt-2 pb-12 sm:px-6">
        {/* Stepper pills */}
        <ol
          aria-label="Setup steps"
          className="mb-5 flex items-center justify-center gap-2 sm:gap-3"
        >
          {STEPS.map((entry) => {
            const active = entry.id === step;
            const done =
              (entry.id === 0 && brainReady && step > 0) ||
              (entry.id === 1 && walletReady && step > 1);
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => setStep(entry.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-full border px-3 py-1.5 text-meta font-medium transition-colors",
                    active
                      ? "border-foreground/20 bg-card text-ink"
                      : done
                        ? "border-positive/25 bg-positive/[0.08] text-positive"
                        : "border-transparent bg-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-ink",
                  )}
                >
                  {done ? (
                    <Check className="size-3.5" strokeWidth={2.6} />
                  ) : (
                    <span className="font-mono text-caption opacity-75">{entry.id + 1}</span>
                  )}
                  <span>{entry.label}</span>
                </button>
              </li>
            );
          })}
        </ol>

        <section className="overflow-hidden rounded-sheet border border-foreground/[0.08] bg-card">
          <div className="p-6 sm:p-8">
            {step === 0 ? (
              <BrainStep
                preferredBrain={me.preferredBrain}
                machine={
                  me.reach.through === "tailscale"
                    ? new URL(me.reach.address).hostname.split(".")[0] || "your machine"
                    : "this computer"
                }
              />
            ) : step === 1 ? (
              <WalletStep />
            ) : (
              <PersonalizeStep
                xHandle={xHandle}
                watchedWallet={watchedWallet}
                onXHandleChange={(v) => {
                  setXHandle(v);
                  setFinishError(null);
                }}
                onWatchedWalletChange={(v) => {
                  setWatchedWallet(v);
                  setFinishError(null);
                }}
              />
            )}

            {finishError ? (
              <p role="alert" className="mt-4 text-meta text-destructive">
                {finishError}
              </p>
            ) : null}
          </div>

          {/* Footer navigation */}
          <footer className="flex items-center justify-between gap-3 border-t border-foreground/[0.06] bg-sidebar px-6 py-4 sm:px-8">
            {step > 0 ? (
              <button
                type="button"
                disabled={finishing}
                onClick={() => setStep((s) => (s - 1) as StepIndex)}
                className="inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-ui font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-ink"
              >
                <ArrowLeft className="size-4" />
                Back
              </button>
            ) : (
              <span className="text-meta text-faint">Everything runs locally on your machine</span>
            )}

            {step < 2 ? (
              <MoneyButton
                tone="primary"
                className="h-10 px-5 text-ui"
                onClick={() => setStep((s) => (s + 1) as StepIndex)}
              >
                <span className="inline-flex items-center gap-1.5">
                  {step === 0 && !brainReady
                    ? "Continue anyway"
                    : step === 1 && !walletReady
                      ? "Skip wallet for now"
                      : "Continue"}
                  <ArrowRight className="size-4" />
                </span>
              </MoneyButton>
            ) : (
              <MoneyButton
                tone="primary"
                className="h-10 px-6 text-ui"
                busy={finishing}
                busyLabel="Opening Auni…"
                onClick={() => void complete(true)}
              >
                <span className="inline-flex items-center gap-1.5">
                  Finish &amp; open Auni
                  <ArrowRight className="size-4" />
                </span>
              </MoneyButton>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}

/* -------------------------------- Step 1: AI Brain -------------------------------- */

function BrainStep({
  preferredBrain,
  machine,
}: {
  readonly preferredBrain: string | null;
  readonly machine: string;
}) {
  const brains = useBrains();
  const setPreferred = useSetPreferredBrain();
  const rows = brains.data?.rows ?? [];
  const readyCount = rows.filter(
    ({ row }) => row.state === "ready" || row.state === "resting",
  ).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3.5">
        <Mascot alt="" size={44} state="listening" />
        <div>
          <h1 className="text-title text-ink">Connect your AI brain</h1>
          <p className="mt-1 text-ui leading-[1.5] text-muted-foreground">
            Auni thinks using your own local AI CLI subscription, with no hosted accounts or API
            markup.
          </p>
        </div>
      </div>

      {brains.data?.blocked ? (
        <p
          role="alert"
          className="rounded-control bg-waiting-surface px-4 py-3 text-meta leading-[1.5] text-waiting"
        >
          {brains.data.blocked}
        </p>
      ) : null}

      {brains.isPending && rows.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-10 text-meta text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Checking installed AI CLIs…
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((item) => (
            <BrainRow key={item.row.id} item={item} machine={machine} />
          ))}
        </ul>
      )}

      {readyCount > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-foreground/[0.07] bg-surface/60 px-4 py-3">
          <div>
            <span className="block text-meta font-medium text-ink">Preferred brain</span>
            <span className="block text-caption text-muted-foreground">
              Falls back automatically if one hits a usage limit
            </span>
          </div>
          <ChoicePills
            label="Preferred AI brain"
            value={preferredBrain ?? ""}
            disabled={setPreferred.isPending}
            options={[
              { value: "", name: "Auto" },
              ...rows.map(({ row }) => ({ value: row.id, name: row.name })),
            ]}
            onChange={(picked) => setPreferred.mutate(picked || null)}
          />
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------- Step 2: Wallet -------------------------------- */

function WalletStep() {
  const setup = useSetup();
  const runStep = useSetupStep();
  const refreshMe = useRefreshMe();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<"choose" | "import">("choose");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const addresses = setup.data?.wallet.addresses ?? null;
  const bringField = setup.data?.wallet.bring ?? null;

  const createFresh = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      await runStep.mutateAsync({ path: "setup/wallet", body: {} });
      refreshMe();
      void queryClient.resetQueries({ queryKey: ["portfolio"] });
    } catch (error) {
      setCreateError(
        (error instanceof CoreApiError && error.detail) ||
          "Could not create a local wallet. Try again.",
      );
    } finally {
      setCreating(false);
    }
  };

  const copy = (id: string, value: string) => {
    void navigator.clipboard.writeText(value);
    setCopied(id);
    window.setTimeout(() => setCopied((prev) => (prev === id ? null : prev)), 1800);
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-title text-ink">Set up your local wallet</h1>
        <p className="mt-1 text-ui leading-[1.5] text-muted-foreground">
          Your private keys stay on this machine (OS keychain or a 0600 file). Every move waits for
          your tap.
        </p>
      </div>

      {addresses?.evm || addresses?.solana ? (
        <div className="flex flex-col gap-3 rounded-card border border-positive/25 bg-positive/[0.06] p-4">
          <div className="flex items-center gap-2 text-ui font-semibold text-positive">
            <ShieldCheck className="size-4.5" />
            <span>Your local wallet is ready</span>
          </div>
          {addresses.evm ? (
            <div className="flex items-center justify-between gap-2 rounded-control bg-card px-3 py-2">
              <div className="min-w-0">
                <span className="block text-caption font-medium text-muted-foreground">
                  EVM (Monad, Base, Arbitrum, Polygon, Ethereum)
                </span>
                <code className="block truncate font-mono text-meta text-ink">{addresses.evm}</code>
              </div>
              <button
                type="button"
                onClick={() => copy("evm", addresses.evm!)}
                className="flex h-8 flex-none items-center gap-1 rounded-control border border-foreground/[0.08] px-2.5 text-caption text-ink hover:bg-foreground/[0.04]"
              >
                {copied === "evm" ? (
                  <Check className="size-3.5 text-positive" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied === "evm" ? "Copied" : "Copy"}
              </button>
            </div>
          ) : null}
          {addresses.solana ? (
            <div className="flex items-center justify-between gap-2 rounded-control bg-card px-3 py-2">
              <div className="min-w-0">
                <span className="block text-caption font-medium text-muted-foreground">Solana</span>
                <code className="block truncate font-mono text-meta text-ink">
                  {addresses.solana}
                </code>
              </div>
              <button
                type="button"
                onClick={() => copy("sol", addresses.solana!)}
                className="flex h-8 flex-none items-center gap-1 rounded-control border border-foreground/[0.08] px-2.5 text-caption text-ink hover:bg-foreground/[0.04]"
              >
                {copied === "sol" ? (
                  <Check className="size-3.5 text-positive" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied === "sol" ? "Copied" : "Copy"}
              </button>
            </div>
          ) : null}
          <WalletBalanceNotice />
          <p className="text-caption text-muted-foreground">
            You can deposit funds or back up your keys anytime from Settings → Wallet &amp; Keys.
          </p>
        </div>
      ) : mode === "import" && bringField ? (
        <div className="flex flex-col gap-4 rounded-card border border-foreground/[0.08] bg-background p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-body font-semibold text-ink">Import existing keys</h2>
              <p className="mt-0.5 text-meta text-muted-foreground">
                Paste an EVM hex private key, a Solana Base58 key, or keys exported from another
                wallet. Sent straight to core&apos;s private field, never seen by the AI.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setMode("choose")}
              className="flex-none text-meta font-medium text-muted-foreground hover:text-ink"
            >
              Back
            </button>
          </div>
          <ImportKeysForm
            field={bringField}
            onDone={() => {
              refreshMe();
              void setup.refetch();
              void queryClient.resetQueries({ queryKey: ["portfolio"] });
            }}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col justify-between gap-4 rounded-card border border-foreground/[0.1] bg-background p-4">
            <div>
              <div className="flex items-center justify-between gap-2">
                <WalletMinimal className="size-5 text-primary" />
                <SettingsBadge tone="accent">Recommended</SettingsBadge>
              </div>
              <h2 className="mt-3 text-body font-semibold text-ink">Create a new local wallet</h2>
              <p className="mt-1 text-meta leading-[1.45] text-muted-foreground">
                Generates fresh EVM and Solana keys on this computer. Start with $0 and fund only
                when you&apos;re ready.
              </p>
            </div>
            <MoneyButton
              tone="primary"
              className="h-10 w-full text-ui"
              busy={creating}
              busyLabel="Creating wallet…"
              onClick={() => void createFresh()}
            >
              Create local wallet
            </MoneyButton>
          </div>

          <div className="flex flex-col justify-between gap-4 rounded-card border border-foreground/[0.08] bg-background p-4">
            <div>
              <KeyRound className="size-5 text-muted-foreground" />
              <h2 className="mt-3 text-body font-semibold text-ink">Import existing keys</h2>
              <p className="mt-1 text-meta leading-[1.45] text-muted-foreground">
                Bring an existing EVM or Solana private key (or exported auni.io keys) directly into
                local storage.
              </p>
            </div>
            <button
              type="button"
              disabled={!bringField}
              onClick={() => setMode("import")}
              className="inline-flex h-10 w-full items-center justify-center rounded-full border border-foreground/[0.12] bg-card px-4 text-ui font-medium text-ink transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
            >
              {bringField ? "Import keys" : "External wallet managed"}
            </button>
          </div>
        </div>
      )}

      {createError ? (
        <p role="alert" className="text-meta text-destructive">
          {createError}
        </p>
      ) : null}
    </div>
  );
}

/** Shows detected balances and recent deposits on an imported or newly funded wallet during onboarding. */
function WalletBalanceNotice() {
  const portfolio = usePortfolio(true);
  const data = portfolio.data;
  if (!data) return null;
  if (data.looking && data.empty) {
    return (
      <p className="flex items-center gap-2 text-meta text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        Checking balances across supported chains…
      </p>
    );
  }
  if (data.empty) return null;
  const total = formatUsdcBalance(BigInt(data.totalUsd.baseUnits));
  const latest = data.deposits[0];
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-positive/25 bg-card px-3 py-2 text-meta">
      <span className="font-medium text-ink">Detected balance: {total}</span>
      {latest ? (
        <span className="text-positive">
          Received {formatUsd(latest.usdValue)} {latest.symbol} on {latest.network}
        </span>
      ) : null}
    </div>
  );
}

function lacksSolana(keys: string): boolean {
  const pasted = splitKeys(keys);
  return pasted.solana.length === 0 && pasted.evm.some((key) => /^(0x)?[0-9a-f]{64}$/iu.test(key));
}

function bringValues(keys: string, solana: string): Record<string, string> {
  return lacksSolana(keys) && solana.trim() ? { keys, solana } : { keys };
}

function ImportKeysForm({
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
  const [importing, setImporting] = useState(false);
  const [addingSolana, setAddingSolana] = useState(false);

  const solanaToo = lacksSolana(keys);
  const typed = `${keys}\n${solana}`;
  const checked = check?.of === typed ? check.said : null;

  useEffect(() => {
    if (!keys.trim()) return undefined;
    let current = true;
    const timer = setTimeout(() => {
      checkPrivate(field.id, bringValues(keys, solana)).then(
        (said) => current && setCheck({ of: `${keys}\n${solana}`, said }),
        (refused: unknown) => current && setError(secretRefusal(refused)),
      );
    }, CHECK_AFTER_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [field.id, keys, solana]);

  const submit = async () => {
    if (!checked || importing) return;
    setImporting(true);
    try {
      await acceptPrivate(field.id, bringValues(keys, solana));
      setKeys("");
      setSolana("");
      onDone();
    } catch (refused) {
      setError(secretRefusal(refused));
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <SecretInput
        label="Private key(s)"
        labelHidden
        value={keys}
        placeholder="Paste EVM hex key or Solana Base58 key…"
        disabled={importing}
        onChange={(value) => {
          setKeys(value);
          setError(null);
        }}
        onEnter={() => void submit()}
      />
      {solanaToo && addingSolana ? (
        <SecretInput
          label="Solana private key (optional)"
          value={solana}
          placeholder="Base58, about 88 characters"
          disabled={importing}
          onChange={(value) => {
            setSolana(value);
            setError(null);
          }}
          onEnter={() => void submit()}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      ) : checked ? (
        <div aria-live="polite" className="text-meta leading-5">
          <p className="text-ink-soft">
            Signs for{" "}
            <span className="font-mono text-caption break-all text-ink">{checked.preview}</span>
          </p>
          {checked.notes.map((note) => (
            <p key={note} className="mt-1 text-muted-foreground">
              {note}
            </p>
          ))}
          {solanaToo && !addingSolana ? (
            <button
              type="button"
              className="mt-1.5 font-medium text-primary underline decoration-primary/35 underline-offset-[3px] hover:decoration-current"
              onClick={() => setAddingSolana(true)}
            >
              Add a Solana key too
            </button>
          ) : null}
        </div>
      ) : (
        <SecretNote says={field.goes} />
      )}
      <MoneyButton
        tone="primary"
        className="h-10 w-full text-ui"
        busy={importing}
        busyLabel="Importing…"
        disabled={!checked}
        onClick={() => void submit()}
      >
        Import wallet keys
      </MoneyButton>
    </div>
  );
}

/* -------------------------------- Step 3: Make it yours -------------------------------- */

function PersonalizeStep({
  xHandle,
  watchedWallet,
  onXHandleChange,
  onWatchedWalletChange,
}: {
  readonly xHandle: string;
  readonly watchedWallet: string;
  readonly onXHandleChange: (value: string) => void;
  readonly onWatchedWalletChange: (value: string) => void;
}) {
  const { openSettings } = useAppDialogs();
  const remote = useRemoteAccess(true);
  const apps = useApps();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const hasBrowserWallet = browserWallet() !== null;
  const channelApps = (apps.data?.apps ?? []).filter((app) => app.pairing !== null);
  const ts = remote.data?.tailscale;

  const connectBrowser = async () => {
    const provider = browserWallet();
    if (!provider) return;
    setConnecting(true);
    setConnectError(null);
    try {
      const address = await connect(provider);
      onWatchedWalletChange(address);
    } catch (error) {
      setConnectError(
        error instanceof Error
          ? error.message
          : "Could not read an address from your browser wallet.",
      );
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-title text-ink">Make it yours</h1>
        <p className="mt-1 text-ui leading-[1.5] text-muted-foreground">
          Optional: drop in read-only signals so your New Chat starts with tailored, live ideas
          instead of a blank page. No forms, no keys needed.
        </p>
      </div>

      {/* Signal 1: Public X handle */}
      <div className="rounded-card border border-foreground/[0.08] bg-background p-4">
        <label htmlFor="wizard-x-handle" className="block text-ui font-medium text-ink">
          Public X / Twitter handle
        </label>
        <p className="mt-0.5 text-meta text-muted-foreground">
          Auni reads your public bio to infer themes you care about (no login or API key).
        </p>
        <input
          id="wizard-x-handle"
          value={xHandle}
          placeholder="@handle or x.com/handle"
          onChange={(event) => onXHandleChange(event.target.value)}
          className={cn(SETTINGS_INPUT, "mt-2.5 w-full")}
        />
      </div>

      {/* Signal 2: Watch-only wallet */}
      <div className="rounded-card border border-foreground/[0.08] bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <label htmlFor="wizard-watch-wallet" className="block text-ui font-medium text-ink">
              Watch-only wallet address
            </label>
            <p className="mt-0.5 text-meta text-muted-foreground">
              Public address only (zero signing) so Auni tailors market ideas to what you hold.
            </p>
          </div>
          {hasBrowserWallet ? (
            <button
              type="button"
              disabled={connecting}
              onClick={() => void connectBrowser()}
              className="inline-flex h-8 items-center gap-1.5 rounded-control border border-foreground/[0.1] bg-card px-3 text-meta font-medium text-ink hover:bg-foreground/[0.04]"
            >
              {connecting ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Wallet className="size-3.5" />
              )}
              Connect browser wallet
            </button>
          ) : null}
        </div>
        <input
          id="wizard-watch-wallet"
          value={watchedWallet}
          placeholder="0x…, name.eth, or Solana address"
          onChange={(event) => {
            onWatchedWalletChange(event.target.value);
            setConnectError(null);
          }}
          className={cn(SETTINGS_INPUT, "mt-2.5 w-full font-mono text-meta")}
        />
        {connectError ? (
          <p className="mt-1.5 text-caption text-destructive">{connectError}</p>
        ) : null}
      </div>

      {/* Optional expandable extras: Remote access & Chat channels */}
      <div className="flex flex-col gap-2">
        <details className="group rounded-card border border-foreground/[0.07] bg-surface/50">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-meta font-medium text-ink select-none">
            <span className="flex items-center gap-2">
              <GlobeLock className="size-4 text-muted-foreground" />
              <span>Remote access (Tailscale &amp; always-on)</span>
              {ts?.state === "ready" ? (
                <SettingsBadge tone={ts.served ? "ok" : "accent"}>
                  {ts.served ? "Active" : "Tailscale ready"}
                </SettingsBadge>
              ) : null}
            </span>
            <ChevronDown className="size-4 text-faint transition-transform group-open:rotate-180" />
          </summary>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-foreground/[0.06] px-4 py-3 text-meta text-muted-foreground">
            <span>
              {ts?.state === "ready"
                ? `Detected ${ts.dnsName} on your tailnet. Enable HTTPS or background service anytime.`
                : "Reach Auni from your phone via Tailscale HTTPS and keep it running in the background."}
            </span>
            <button
              type="button"
              onClick={() => openSettings("remote")}
              className="rounded-control border border-foreground/[0.1] bg-card px-3 py-1.5 text-caption font-medium text-ink hover:bg-foreground/[0.04]"
            >
              Configure in Settings
            </button>
          </div>
        </details>

        {channelApps.length > 0 ? (
          <details className="group rounded-card border border-foreground/[0.07] bg-surface/50">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-meta font-medium text-ink select-none">
              <span className="flex items-center gap-2">
                <MessageSquare className="size-4 text-muted-foreground" />
                <span>Chat on your phone ({channelApps.map((a) => a.name).join(", ")})</span>
              </span>
              <ChevronDown className="size-4 text-faint transition-transform group-open:rotate-180" />
            </summary>
            <div className="flex flex-col gap-4 border-t border-foreground/[0.06] p-4">
              {channelApps.map((app) => (
                <div key={app.id} className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <AppMark id={app.id} name={app.name} size={24} />
                    <span className="text-ui font-medium text-ink">{app.name}</span>
                  </div>
                  <AppKeysNeeded app={app} />
                  <AppPairing app={app} name={app.name} />
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
