"use client";

import type { AppSettingWire, AppWire } from "@auni/shared";
import { Check } from "lucide-react";
import { useState, type Ref } from "react";

import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { AutoHeight } from "@/components/motion/auto-height";
import { SecretInput, SecretNote, secretRefusal } from "@/components/private-input/secret-input";
import { clearAppSecret, saveAppSecrets, useRefreshApps } from "@/lib/data/apps";

import { keysNeeded } from "./app-standing";
import { Section } from "./sheet-section";

/**
 * The keys an app still needs, each pasted into a private field: saved to Auni's settings file
 * on this computer, in use from Auni's next step with no restart, and never shown again.
 */
export function AppKeysNeeded({
  app,
  focusRef,
  onSaved,
}: {
  readonly app: AppWire;
  /** The first field, for a sheet that opens with the cursor in it. */
  readonly focusRef?: Ref<HTMLInputElement>;
  /** Told once every key it asked for is saved. */
  readonly onSaved?: () => void;
}) {
  const needed = keysNeeded(app);
  if (needed.length === 0) return null;
  return (
    <Section title="To get it working">
      <KeyForm settings={needed} focusRef={focusRef} onSaved={onSaved} />
    </Section>
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
    <Section title={rest.every(({ kind }) => kind === "secret") ? "Its keys" : "Its settings"}>
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
    <p role="alert" className="text-[13px] leading-[18px] text-destructive">
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
            <p className="text-[13px] leading-[18px] text-muted-foreground">{setting!.help}</p>
          ) : null)}
      </div>
    );
  }
  const help = [...new Set(settings.flatMap((setting) => setting.help ?? []))];
  return (
    <div className="flex flex-col gap-2">
      {help.map((line) => (
        <p key={line} className="text-[13px] leading-[18px] text-muted-foreground">
          {line}
        </p>
      ))}
      <div className="divide-y divide-foreground/[0.07] overflow-hidden rounded-[16px] border border-foreground/[0.12] bg-background transition-[border-color,box-shadow] focus-within:border-foreground/25 focus-within:ring-[3px] focus-within:ring-ring/25">
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
                <Check aria-hidden className="size-3.5 flex-none text-positive" strokeWidth={2.6} />
              ) : null}
              {setting.set === "environment"
                ? "Set by this computer"
                : setting.set && setting.untried
                  ? "Saved, not tried yet: the service couldn't be reached"
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
              <Check aria-hidden className="size-3.5 flex-none text-positive" strokeWidth={2.6} />
            ) : null}
            {setting.set === "environment"
              ? "Set by this computer"
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
          It changes whom Auni trusts, so only your settings file sets it:{" "}
          <code className="font-mono text-[12px] text-ink wrap-anywhere">{setting.env}</code> in{" "}
          <code className="font-mono text-[12px] text-ink wrap-anywhere">{settingsFile}</code>.
        </p>
      ) : null}
    </AutoHeight>
  );
}

/** A small quiet action beside a row: "Replace", "Where?". */
export const quietPillClass =
  "flex h-9 flex-none items-center rounded-full bg-foreground/[0.05] px-4 text-[13.5px] font-semibold text-ink transition-colors duration-200 ease-settle hover:bg-foreground/[0.08] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-55";
