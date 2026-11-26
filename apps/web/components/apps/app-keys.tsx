"use client";

import type { AppSettingWire, AppWire } from "@auni/shared";
import { Check } from "lucide-react";
import { useState, type Ref } from "react";

import { Mascot } from "@/components/brand/mascot";
import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { buttonVariants } from "@/components/ui/button";
import { AutoHeight } from "@/components/motion/auto-height";
import { SecretInput, SecretNote, secretRefusal } from "@/components/private-input/secret-input";
import { clearAppSecret, saveAppSecrets, useRefreshApps } from "@/lib/data/apps";

import { keysNeeded, keysWord } from "./app-standing";
import { Section } from "./sheet-section";

/**
 * The keys an app still needs, each pasted into a private field: saved to Auni's settings file
 * on this computer, in use from Auni's next step with no restart, and never shown again.
 */
export function AppKeysNeeded({
  app,
  focusRef,
  holding = null,
  onSaved,
}: {
  readonly app: AppWire;
  /** The money the owner has there already, which stays safe while the keys wait. */
  readonly holding?: string | null;
  /** The first field, for a sheet that opens with the cursor in it. */
  readonly focusRef?: Ref<HTMLInputElement>;
  /** Told once every key it asked for is saved. */
  readonly onSaved?: () => void;
}) {
  const needed = keysNeeded(app);
  if (needed.length === 0) return null;
  const keys = keysWord(app, needed);
  return (
    <Section title={holding ? `Add your ${keys} to trade` : `Add your ${keys} to use ${app.name}`}>
      {holding ? (
        <p className="mb-3 text-ui leading-[1.5] text-ink">
          Your {holding} is safe. Add your {app.name} {keys} to let Auni place orders.
        </p>
      ) : null}
      <KeyForm settings={needed} focusRef={focusRef} onSaved={onSaved} />
    </Section>
  );
}

/**
 * The moment an app's last key went in, as it now stands: connected only when it's on, since a
 * key saved never turns on an app the owner turned off.
 */
export function KeysSaved({ app }: { readonly app: AppWire }) {
  const many =
    app.settings.filter(({ kind, required }) => kind === "secret" && required).length > 1;
  return (
    <div className="mt-8 flex items-center gap-3.5" data-testid="app-keys-saved">
      {app.on ? (
        <Mascot className="auni-onb-mascot flex-none" size={44} state="celebrating" />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-semibold text-ink">
          {app.on ? `${app.name} is connected` : many ? "Keys saved" : "Key saved"}
        </span>
        <span className="mt-0.5 block text-meta text-muted-foreground">
          {app.on
            ? "Auni can use it right away."
            : `${app.name} is off, so Auni won't use it until you turn it on below.`}
        </span>
      </span>
    </div>
  );
}

/**
 * Every other setting an app reads: a key it has (replaceable, never shown), one it could take,
 * and the ones only the owner's settings file changes, since they change whom Auni trusts. One
 * of those that is unset and not needed is nothing the owner came for, so it isn't listed.
 */
export function AppSettings({
  app,
  settingsFile,
}: {
  readonly app: AppWire;
  readonly settingsFile: string;
}) {
  const needed = new Set(keysNeeded(app).map(({ key }) => key));
  const rest = app.settings.filter(
    ({ key, kind, set, required }) => !needed.has(key) && (kind === "secret" || set || required),
  );
  if (rest.length === 0) return null;
  return (
    <Section title={rest.every(({ kind }) => kind === "secret") ? "Keys" : "Settings"}>
      <ul className="flex flex-col gap-4">
        {rest.map((setting) => (
          <li key={setting.key}>
            {setting.field ? (
              <KeyRow setting={setting} />
            ) : (
              <FileRow setting={setting} settingsFile={settingsFile} />
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** What was typed for each key, by the key's name. */
type TypedKeys = Readonly<Record<string, string>>;

/**
 * A private field for each key an app asks for. One key is a field under its name with where
 * to get it; several are one block, a row each, under the one line on where they all come
 * from, so they read as one step. Whoever holds what is typed keeps it in its own state.
 */
function KeyFields({
  settings,
  typed,
  onType,
  onEnter,
  disabled,
  refused,
  focusRef,
}: {
  readonly settings: readonly AppSettingWire[];
  readonly typed: TypedKeys;
  readonly onType: (key: string, value: string) => void;
  readonly onEnter: () => void;
  readonly disabled: boolean;
  /** Why core refused what was typed, in its own words. */
  readonly refused: string | null;
  readonly focusRef?: Ref<HTMLInputElement> | undefined;
}) {
  const refusal = refused ? (
    <p role="alert" className="text-meta leading-[18px] text-destructive">
      {refused}
    </p>
  ) : null;
  const field = (setting: AppSettingWire, index: number, inline: boolean) => (
    <SecretInput
      key={setting.key}
      label={setting.label}
      value={typed[setting.key] ?? ""}
      placeholder="Paste it here"
      disabled={disabled}
      inline={inline}
      {...(index === 0 && focusRef ? { inputRef: focusRef } : {})}
      onChange={(value) => onType(setting.key, value)}
      onEnter={onEnter}
    />
  );
  if (settings.length === 1) {
    const [setting] = settings;
    return (
      <div className="flex flex-col gap-1.5">
        {field(setting!, 0, false)}
        {refusal ??
          (setting!.help ? (
            <p className="text-meta leading-[18px] text-muted-foreground">
              <Linked text={setting!.help} />
            </p>
          ) : null)}
      </div>
    );
  }
  const help = [...new Set(settings.flatMap((setting) => setting.help ?? []))];
  return (
    <div className="flex flex-col gap-2">
      {help.map((line) => (
        <p key={line} className="text-meta leading-[18px] text-muted-foreground">
          <Linked text={line} />
        </p>
      ))}
      <div className="divide-y divide-foreground/[0.07] overflow-hidden rounded-card border border-foreground/[0.12] bg-background transition-[border-color] focus-within:border-foreground/25">
        {settings.map((setting, index) => field(setting, index, true))}
      </div>
      {refusal}
    </div>
  );
}

/**
 * One field for each key, and one Save for all of them. What is typed lives in this component
 * alone and goes only to core's `/private/:id`, all of it in one request, which saves none of it
 * if the service refuses one; core's refusal is said in its own fixed words, which never repeat
 * what was typed.
 */
function KeyForm({
  settings,
  focusRef,
  onSaved,
  onDone,
  onCancel,
}: {
  readonly settings: readonly AppSettingWire[];
  readonly focusRef?: Ref<HTMLInputElement> | undefined;
  readonly onSaved?: (() => void) | undefined;
  readonly onDone?: () => void;
  readonly onCancel?: () => void;
}) {
  const refreshApps = useRefreshApps();
  const [typed, setTyped] = useState<TypedKeys>({});
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const filled = settings.filter(({ key }) => (typed[key] ?? "").trim() !== "");
  // Every secret of an app is typed into the app's one field.
  const field = settings.find((setting) => setting.field)?.field;

  const save = async () => {
    if (filled.length === 0 || saving || !field) return;
    setSaving(true);
    setRefused(null);
    let saved = false;
    try {
      await saveAppSecrets(field, Object.fromEntries(filled.map(({ key }) => [key, typed[key]!])));
      setTyped({});
      saved = true;
    } catch (error) {
      setRefused(secretRefusal(error));
    }
    // Whatever was saved shows as saved, here and on the app's tile, without a reload.
    await refreshApps().catch(() => undefined);
    setSaving(false);
    if (saved && filled.length === settings.length) onSaved?.();
    if (saved) onDone?.();
  };

  return (
    <div className="flex flex-col gap-3" data-testid="app-key-form">
      <KeyFields
        settings={settings}
        typed={typed}
        onType={(key, value) => setTyped((before) => ({ ...before, [key]: value }))}
        onEnter={() => void save()}
        disabled={saving}
        refused={refused}
        focusRef={focusRef}
      />
      <SecretNote />
      <div className={onCancel ? "grid grid-cols-[1fr_1.6fr] gap-2" : "grid"}>
        {onCancel ? (
          <MoneyButton tone="quiet" disabled={saving} onClick={onCancel}>
            Cancel
          </MoneyButton>
        ) : null}
        <MoneyButton
          tone="primary"
          busy={saving}
          busyLabel="Saving"
          disabled={filled.length === 0}
          onClick={() => void save()}
        >
          {settings.length > 1 ? "Save keys" : "Save"}
        </MoneyButton>
      </div>
    </div>
  );
}

/**
 * A key the app has, or could take: that it is saved (never its value), and a way to replace it
 * or clear it.
 */
function KeyRow({ setting }: { readonly setting: AppSettingWire }) {
  const refreshApps = useRefreshApps();
  const [typing, setTyping] = useState(false);
  const [clearing, setClearing] = useState(false);
  const clear = async () => {
    if (!setting.field) return;
    setClearing(true);
    await clearAppSecret(setting.field, setting.key).catch(() => undefined);
    await refreshApps().catch(() => undefined);
    setClearing(false);
  };
  return (
    <AutoHeight>
      {typing ? (
        <KeyForm
          settings={[setting]}
          onDone={() => setTyping(false)}
          onCancel={() => setTyping(false)}
        />
      ) : (
        <div className="flex min-h-10 items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui font-normal text-ink">{setting.label}</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-meta text-muted-foreground">
              {setting.set && !setting.untried ? (
                <Check aria-hidden className="size-3.5 flex-none text-ink" strokeWidth={2.6} />
              ) : null}
              {setting.set === "environment"
                ? "Set on this computer"
                : setting.set && setting.untried
                  ? "Saved, not verified yet (couldn't reach the service)"
                  : setting.set
                    ? "Saved"
                    : (setting.help ?? "Not set")}
            </span>
          </span>
          {/* What this computer's own environment sets can't be changed from the app. */}
          {setting.set === "file" ? (
            <button
              type="button"
              disabled={clearing}
              onClick={() => void clear()}
              className={quietPillClass}
            >
              Clear
            </button>
          ) : null}
          {setting.set === "environment" ? null : (
            <button type="button" onClick={() => setTyping(true)} className={quietPillClass}>
              {setting.set ? "Replace" : "Add"}
            </button>
          )}
        </div>
      )}
    </AutoHeight>
  );
}

/**
 * A setting that changes whom Auni trusts (a wallet's own, a URL an app talks to): shown as set
 * or not, and changed only in the owner's settings file, which a browser session can't write.
 * Where that is sits behind "Where?", open already for one the app can't work without.
 */
function FileRow({
  setting,
  settingsFile,
}: {
  readonly setting: AppSettingWire;
  readonly settingsFile: string;
}) {
  const [where, setWhere] = useState(!setting.set);
  return (
    <AutoHeight>
      <div className="flex min-h-10 items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-normal text-ink">{setting.label}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-meta text-muted-foreground">
            {setting.set ? (
              <Check aria-hidden className="size-3.5 flex-none text-ink" strokeWidth={2.6} />
            ) : null}
            {setting.set === "environment"
              ? "Set on this computer"
              : setting.set
                ? "Set in your settings file"
                : "Not set yet"}
          </span>
        </span>
        {setting.set ? (
          <button
            type="button"
            aria-expanded={where}
            onClick={() => setWhere((shown) => !shown)}
            className={quietPillClass}
          >
            Where?
          </button>
        ) : null}
      </div>
      {where ? (
        <p className="mt-1.5 text-meta leading-[1.55] text-muted-foreground">
          This controls what Auni trusts, so set it directly in your settings file:{" "}
          <code className="font-mono text-caption text-ink wrap-anywhere">{setting.env}</code> in{" "}
          <code className="font-mono text-caption text-ink wrap-anywhere">{settingsFile}</code>.
        </p>
      ) : null}
    </AutoHeight>
  );
}

/** A small quiet action beside a row: "Replace", "Where?". */
const quietPillClass = buttonVariants({ variant: "secondary", size: "sm" });

/** A site an app's help names ("example.com"), anywhere in its words. */
const SITE = /\b((?:[a-z0-9-]+\.)+(?:com|io|ai|xyz|org|net|app|dev|fi|trade|exchange))\b/giu;

/**
 * An app's help line with the site it names as a link there: "From your profile on
 * example.com" takes the owner to example.com.
 */
export function Linked({ text }: { readonly text: string }) {
  const parts = text.split(SITE);
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <a
        key={index}
        href={`https://${part}`}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-ink underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground/60"
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}
