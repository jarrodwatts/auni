"use client";

import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { useId, useState, type Ref } from "react";

import { inputClass } from "@/components/ui/input";
import { CoreApiError } from "@/lib/core";
import { cn } from "@/lib/utils";

/**
 * One input for a secret the owner types or pastes (a wallet key, an app's API key). It is never
 * part of a form a browser could submit to the address bar, never saved as a draft or offered to
 * autofill or a password manager, and hidden until the owner asks to see it. Whoever holds its
 * value keeps it in component state alone and sends it only to core's `/private/:id`.
 */
export function SecretInput({
  label,
  value,
  onChange,
  onEnter,
  placeholder,
  disabled = false,
  inline = false,
  labelHidden = false,
  inputRef,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onEnter?: () => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** One row of a block of several: its label beside it, and no border of its own. */
  readonly inline?: boolean;
  /** Its label is said just above it already (a card's title), so only a screen reader hears it. */
  readonly labelHidden?: boolean;
  /** For whoever puts the cursor in it. */
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly className?: string;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <label
      className={cn(
        "flex min-w-0 text-left",
        inline ? "h-12 items-center gap-3 pl-4" : "flex-col gap-1.5",
        className,
      )}
    >
      <span
        className={cn(
          "text-meta font-medium text-ink",
          inline && "w-[124px] flex-none truncate",
          labelHidden && "sr-only",
        )}
      >
        {label}
      </span>
      <span className="relative min-w-0 flex-1">
        <input
          ref={inputRef}
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onEnter?.();
          }}
          className={cn(
            inline
              ? "w-full bg-transparent text-ui text-ink placeholder:text-faint focus-ring-inset disabled:text-muted-foreground"
              : cn(inputClass, "pl-4"),
            "h-12 pr-12 font-mono placeholder:font-sans",
          )}
        />
        <button
          type="button"
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
          aria-controls={id}
          onClick={() => setVisible((shown) => !shown)}
          className="absolute inset-y-0 right-1.5 my-auto grid size-9 place-items-center rounded-control text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-ink focus-ring-inset"
        >
          {visible ? (
            <EyeOff aria-hidden className="size-4" />
          ) : (
            <Eye aria-hidden className="size-4" />
          )}
        </button>
      </span>
    </label>
  );
}

/** Where what is typed goes, said under every secret's field: in core's words where it says. */
export function SecretNote({ says }: { readonly says?: string }) {
  return (
    <p className="flex items-start gap-2 text-left text-meta leading-[18px] text-muted-foreground">
      <LockKeyhole aria-hidden className="mt-px size-3.5 flex-none" />
      {says ?? "Saved only on this computer. Your AI never sees it."}
    </p>
  );
}

/** Why the values weren't taken, in core's fixed words, which never repeat them. */
export function secretRefusal(error: unknown): string {
  if (error instanceof CoreApiError && error.code === "refused" && error.detail)
    return error.detail;
  return "That didn't reach Auni, so nothing changed. Try again.";
}
