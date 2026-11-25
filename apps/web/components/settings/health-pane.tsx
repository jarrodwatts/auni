"use client";

import type { DoctorFindingWire } from "@auni/shared";
import { ArrowUpRight, Check, CircleAlert, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { mustPairAgain, PairAgain } from "@/components/auth/pair-again";
import { CopyLine } from "@/components/ui/copy-line";
import { CoreApiError } from "@/lib/core";
import { useAbout, useCheckUpdate, useDiagnostics, useLogs, useRunRepair } from "@/lib/data/system";
import { cn } from "@/lib/utils";

import { healthOf, partName } from "./health";
import { Networks } from "./networks";
import {
  Disclosure,
  Refusal,
  Setting,
  SETTINGS_BUTTON,
  SETTINGS_PRIMARY_BUTTON,
  SettingsGroup,
} from "./settings-layout";

const REPO = "https://github.com/jarrodwatts/auni";

/**
 * Health: one line on whether everything's working, then only what needs the owner, each with
 * its fix where one is safe to run from here. Every check, the networks, the logs and the
 * terminal's commands wait behind disclosures for whoever wants them.
 */
export function HealthPane() {
  return (
    <>
      <Checks />
      <Version />
      <Help />
      <Disclosure
        id="setting-developers"
        title="For developers"
        hint="Networks, logs and backups"
        holds={["setting-networks", "setting-logs", "setting-backup"]}
      >
        <Networks />
        <Backup />
        <Logs />
        <Paths />
      </Disclosure>
    </>
  );
}

function Checks() {
  const diagnostics = useDiagnostics(true);
  const repair = useRunRepair();
  const [fixing, setFixing] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; says: string; command?: string } | null>(
    null,
  );
  const [pairAgain, setPairAgain] = useState(false);
  const findings = diagnostics.data?.findings ?? [];
  const { headline, needs } = healthOf(findings);

  const fix = async (id: string) => {
    setFixing(id);
    setResult(null);
    setPairAgain(false);
    try {
      const done = await repair.mutateAsync(id);
      setResult({
        ok: done.ok,
        says: done.message,
        ...(done.sudoCommand ? { command: done.sudoCommand } : {}),
      });
    } catch (caught) {
      if (mustPairAgain(caught)) setPairAgain(true);
      else
        setResult({
          ok: false,
          says:
            caught instanceof CoreApiError && caught.detail
              ? caught.detail
              : "That fix didn't finish. Run auni doctor --fix in your terminal.",
        });
    } finally {
      setFixing(null);
    }
  };

  return (
    <section id="setting-checks" className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex items-center gap-3.5 rounded-card border border-border bg-card px-4 py-4 sm:px-5">
        <span
          className={cn(
            "flex size-10 flex-none items-center justify-center rounded-full",
            needs.length > 0 ? "bg-waiting-surface text-waiting" : "bg-surface text-ink",
          )}
        >
          {!diagnostics.data ? (
            <LoaderCircle aria-hidden className="size-5 animate-spin" />
          ) : needs.length > 0 ? (
            <CircleAlert aria-hidden className="size-5" />
          ) : (
            <Check aria-hidden className="size-5" strokeWidth={2.4} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-reading font-semibold text-ink">
            {diagnostics.data
              ? headline
              : diagnostics.isError
                ? "Auni couldn't check itself"
                : "Checking everything"}
          </span>
          <span className="mt-0.5 block text-meta text-muted-foreground">
            {diagnostics.data
              ? `Checked at ${new Date(diagnostics.data.ranAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
              : diagnostics.isError
                ? "Run auni doctor in your terminal."
                : "Your AI, wallet, networks and apps"}
          </span>
        </span>
        <button
          type="button"
          disabled={diagnostics.isFetching}
          onClick={() => void diagnostics.refetch()}
          className={SETTINGS_BUTTON}
        >
          Check again
        </button>
      </div>

      {needs.length > 0 ? (
        <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {needs.map((finding, index) => (
            <Setting
              key={`${finding.check}-${index}`}
              label={partName(finding.check)}
              hint={sentence(finding.says)}
            >
              {finding.repair ? (
                <button
                  type="button"
                  title={finding.repair.does}
                  disabled={fixing !== null}
                  onClick={() => void fix(finding.repair!.id)}
                  className={SETTINGS_PRIMARY_BUTTON}
                >
                  {fixing === finding.repair.id ? (
                    <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
                  ) : null}
                  Fix it
                </button>
              ) : null}
            </Setting>
          ))}
        </div>
      ) : null}
      {result ? (
        <div
          role="status"
          className="flex flex-col gap-2 px-1 text-meta leading-[1.5] text-ink-soft"
        >
          <span>{result.says}</span>
          {result.command ? <CopyLine value={result.command} command /> : null}
        </div>
      ) : null}
      {pairAgain ? <PairAgain then="Then press Fix it again." /> : null}

      {findings.length > 0 ? (
        <Disclosure id="setting-every-check" title="Show every check">
          <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
            {findings.map((finding, index) => (
              <EveryCheck key={`${finding.check}-${index}`} finding={finding} />
            ))}
          </div>
        </Disclosure>
      ) : null}
    </section>
  );
}

/** A finding as the terminal says it, with what it's about first. */
function EveryCheck({ finding }: { readonly finding: DoctorFindingWire }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
      <span className="mt-0.5 flex-none">
        {finding.status === "ok" ? (
          <Check aria-hidden className="size-4 text-muted-foreground" strokeWidth={2.4} />
        ) : finding.status === "fix" ? (
          <CircleAlert aria-hidden className="size-4 text-waiting" />
        ) : (
          <span aria-hidden className="block size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1 text-meta leading-[1.45]">
        <span className="font-medium text-ink">{partName(finding.check)}</span>{" "}
        <span className="text-muted-foreground break-words">{finding.says}</span>
      </span>
    </div>
  );
}

/** A finding's words as a sentence: its first letter up, a full stop at its end. */
function sentence(says: string): string {
  const said = says.charAt(0).toUpperCase() + says.slice(1);
  return /[.!?]$/u.test(said) ? said : `${said}.`;
}

/** The version running, whether a newer one is out, and how to take it. */
function Version() {
  const about = useAbout(true);
  const check = useCheckUpdate();
  const data = about.data;
  const named = (version: string) => (version.startsWith("v") ? version : `v${version}`);
  return (
    <SettingsGroup id="setting-version" title="Version">
      <Setting
        label={data ? `Auni ${named(data.version)}` : "Auni"}
        hint={
          !data
            ? undefined
            : data.update.available && data.update.latest
              ? `${named(data.update.latest)} is out.`
              : data.checkout
                ? "Running from its source. Pull main for the latest."
                : data.update.checked
                  ? "Up to date."
                  : "Free and open source, with no fees."
        }
      >
        {data?.update.available ? null : (
          <button
            type="button"
            disabled={check.isPending}
            onClick={() => check.mutate()}
            className={SETTINGS_BUTTON}
          >
            {check.isPending ? (
              <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
            ) : null}
            Check for updates
          </button>
        )}
      </Setting>
      {data?.update.available && data.update.latest ? (
        <Setting
          label="To update, run this where Auni runs"
          hint={data.update.note ?? undefined}
          stacked
        >
          <CopyLine value="auni update" command />
        </Setting>
      ) : null}
    </SettingsGroup>
  );
}

function Help() {
  const links = [
    { label: "Report a problem", href: `${REPO}/issues/new` },
    { label: "How Auni keeps your money safe", href: `${REPO}/blob/main/SECURITY.md` },
    { label: "Auni's code", href: REPO },
  ];
  return (
    <SettingsGroup id="setting-help" title="Help">
      {links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between gap-3 px-4 py-3.5 text-ui font-medium text-ink transition-colors hover:bg-foreground/[0.03] sm:px-5"
        >
          {link.label}
          <ArrowUpRight aria-hidden className="size-4 text-faint" />
        </a>
      ))}
    </SettingsGroup>
  );
}

/** What the owner runs in their terminal to have their AI look into a problem, or back up. */
function Backup() {
  return (
    <SettingsGroup id="setting-backup" title="In your terminal">
      <Setting
        label="Ask your AI what's wrong"
        hint="It reads Auni's logs and code, never your keys, and can write up an issue."
        stacked
      >
        <CopyLine value="auni triage" command />
      </Setting>
      <Setting label="Back up and restore" hint="Your records, routines and settings." stacked>
        <div className="flex flex-col gap-2">
          <CopyLine value="auni export" command />
          <CopyLine value="auni import <backup-file>" command />
        </div>
      </Setting>
    </SettingsGroup>
  );
}

function Logs() {
  const [open, setOpen] = useState(false);
  const logs = useLogs(open);
  return (
    <SettingsGroup id="setting-logs" title="Logs">
      <Setting
        label="Recent lines"
        hint={
          logs.data?.path
            ? `The last 200, from ${logs.data.path}, with keys and tokens taken out.`
            : "The last 200, with keys and tokens taken out."
        }
        stacked={open}
      >
        {open ? (
          logs.isPending ? (
            <LoaderCircle aria-hidden className="size-4 animate-spin text-faint" />
          ) : logs.data && logs.data.lines.length > 0 ? (
            <div className="flex flex-col gap-2">
              <pre className="max-h-[280px] overflow-auto rounded-control bg-surface p-3 font-mono text-caption leading-[1.55] break-all whitespace-pre-wrap text-ink-soft">
                {logs.data.lines.join("\n")}
              </pre>
              <div>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(logs.data!.lines.join("\n"))}
                  className={SETTINGS_BUTTON}
                >
                  Copy them
                </button>
              </div>
            </div>
          ) : (
            <p className="text-meta text-muted-foreground">Nothing logged yet.</p>
          )
        ) : (
          <button type="button" onClick={() => setOpen(true)} className={SETTINGS_BUTTON}>
            Show
          </button>
        )}
      </Setting>
      {logs.isError ? (
        <div className="px-4 py-3 sm:px-5">
          <Refusal>The logs couldn&apos;t be read just now.</Refusal>
        </div>
      ) : null}
    </SettingsGroup>
  );
}

function Paths() {
  const about = useAbout(true);
  const data = about.data;
  if (!data) return null;
  const rows = [
    { label: "Data folder", value: data.dataDir },
    { label: "Settings file", value: data.settingsFile },
    { label: "Runtime", value: `Node ${data.nodeVersion}, ${data.platform} ${data.arch}` },
  ];
  return (
    <SettingsGroup title="Where things are">
      {rows.map((row) => (
        <Setting
          key={row.label}
          label={row.label}
          hint={<code className="font-mono text-caption break-all">{row.value}</code>}
        />
      ))}
    </SettingsGroup>
  );
}
