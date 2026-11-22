"use client";

import type { PrivateCheckWire, PrivateFieldWire } from "@auni/shared";
import { useState, type Ref } from "react";

import { MoneyButton, MoneyButtons } from "@/components/cards/money/money-card-parts";
import { acceptPrivate, askedInputs, checkPrivate } from "@/lib/data/private";

import { SecretInput, SecretNote, secretRefusal } from "./secret-input";

type Stage =
  | { readonly kind: "typing"; readonly error?: string }
  | { readonly kind: "checking" }
  | { readonly kind: "checked"; readonly check: PrivateCheckWire; readonly error?: string }
  | { readonly kind: "accepting"; readonly check: PrivateCheckWire | null };

/** The quiet button beside the main one while nothing is checked yet: "Not now", "Cancel". */
interface Secondary {
  readonly label: string;
  readonly busy?: boolean;
  readonly onClick: () => void;
}

/**
 * A field core declared for a secret the owner types, such as wallet keys or an app's key. What's
 * typed lives only in this component's state and goes only to core's `/private/:id`: never into
 * a form a browser could submit to the address bar, never saved as a draft or offered to
 * autofill, and gone once it's taken in or this leaves the screen. A field that `confirms` first
 * has core say what the values would do (the addresses keys sign for), and takes them in only on
 * Confirm; any other is taken in on its one button.
 */
export function PrivateInput({
  field,
  words,
  secondary,
  named = false,
  inputRef,
  onDone,
}: {
  readonly field: PrivateFieldWire;
  /** Its buttons, and what its preview is: "Check these keys", "These keys sign for", "Bring them in". */
  readonly words: { readonly check: string; readonly preview: string; readonly confirm: string };
  readonly secondary?: Secondary;
  /** The field's name is shown above it, so a lone input carries no label of its own. */
  readonly named?: boolean;
  /** The first input, for whoever puts the cursor in it. */
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly onDone: (said: string | null) => void;
}) {
  const inputs = askedInputs(field);
  const blank = () => Object.fromEntries(inputs.map(({ name }) => [name, ""]));
  const [values, setValues] = useState<Record<string, string>>(blank);
  const [stage, setStage] = useState<Stage>({ kind: "typing" });
  const typed = Object.values(values).some((value) => value.trim() !== "");
  const locked = stage.kind !== "typing";

  const accept = async (checked: PrivateCheckWire | null) => {
    setStage({ kind: "accepting", check: checked });
    try {
      const said = await acceptPrivate(field.id, values);
      setValues(blank());
      onDone(said);
    } catch (error) {
      setStage(
        checked
          ? { kind: "checked", check: checked, error: secretRefusal(error) }
          : { kind: "typing", error: secretRefusal(error) },
      );
    }
  };

  const next = async () => {
    if (!typed || locked) return;
    if (!field.confirms) return void accept(null);
    setStage({ kind: "checking" });
    try {
      setStage({ kind: "checked", check: await checkPrivate(field.id, values) });
    } catch (error) {
      setStage({ kind: "typing", error: secretRefusal(error) });
    }
  };

  const checked = stage.kind === "checked" || stage.kind === "accepting" ? stage.check : null;
  const first = (
    <MoneyButton
      tone="primary"
      busy={stage.kind === "checking" || (stage.kind === "accepting" && !checked)}
      busyLabel={field.confirms ? words.check : words.confirm}
      disabled={!typed}
      onClick={() => void next()}
      className={secondary ? undefined : "w-full"}
    >
      {field.confirms ? words.check : words.confirm}
    </MoneyButton>
  );

  return (
    <div className="flex flex-col gap-3">
      {inputs.map((input, index) => (
        <SecretInput
          key={input.name}
          label={input.label}
          value={values[input.name] ?? ""}
          placeholder={input.placeholder}
          disabled={locked}
          labelHidden={named && inputs.length === 1}
          {...(index === 0 && inputRef ? { inputRef } : {})}
          onChange={(value) => setValues((before) => ({ ...before, [input.name]: value }))}
          onEnter={() => void next()}
        />
      ))}

      <SecretNote says={field.goes} />

      {checked ? (
        <div className="text-left text-[13px] leading-5">
          <p className="text-ink-soft">
            {words.preview}{" "}
            <span className="font-mono text-[12.5px] break-all text-ink">{checked.preview}</span>
          </p>
          {checked.notes.map((note) => (
            <p key={note} className="mt-1 text-[12.5px] leading-[18px] text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      ) : null}

      {"error" in stage && stage.error ? (
        <p role="alert" className="text-left text-[13px] text-destructive">
          {stage.error}
        </p>
      ) : null}

      {checked ? (
        <MoneyButtons>
          <MoneyButton
            tone="quiet"
            disabled={stage.kind === "accepting"}
            onClick={() => setStage({ kind: "typing" })}
          >
            Change
          </MoneyButton>
          <MoneyButton
            tone="primary"
            busy={stage.kind === "accepting"}
            busyLabel={words.confirm}
            onClick={() => void accept(checked)}
          >
            {words.confirm}
          </MoneyButton>
        </MoneyButtons>
      ) : secondary ? (
        <MoneyButtons>
          <MoneyButton
            tone="quiet"
            busy={secondary.busy ?? false}
            busyLabel={secondary.label}
            disabled={locked || secondary.busy}
            onClick={secondary.onClick}
          >
            {secondary.label}
          </MoneyButton>
          {first}
        </MoneyButtons>
      ) : (
        first
      )}
    </div>
  );
}
