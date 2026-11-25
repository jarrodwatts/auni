"use client";

import type { NetworkKey } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { mustPairAgain, PairAgain } from "@/components/auth/pair-again";
import { SecretInput, secretRefusal } from "@/components/private-input/secret-input";
import { acceptPrivate, clearPrivate } from "@/lib/data/private";
import { RPCS_KEY, useRpcs } from "@/lib/data/system";

import {
  Refusal,
  Setting,
  SETTINGS_BUTTON,
  SETTINGS_PRIMARY_BUTTON,
  SettingsGroup,
} from "./settings-layout";

const SOURCE = { own: "Your own URL", alchemy: "Alchemy", public: "Public" } as const;

/**
 * The networks Auni reads and sends on: one Alchemy key for all of them, or a URL of the owner's
 * own for any one. Each is typed only into core's private field and never shown again; what
 * core says back is which source each network uses now.
 */
export function Networks() {
  const rpcs = useRpcs(true);
  if (!rpcs.data) return null;
  const data = rpcs.data;
  return (
    <SettingsGroup
      id="setting-networks"
      title="Networks"
      note={`A network's own URL comes first, then Alchemy, then public ones. They're saved in ${data.settingsFile}.`}
    >
      <Secret
        label="Alchemy key"
        hint={
          data.alchemy.source === "environment"
            ? "Set by this computer's environment, so it can't be changed here."
            : data.alchemy.set
              ? "Saved. Every network goes through Alchemy unless it has its own URL."
              : "Optional. One key for steadier access on every network."
        }
        field={data.alchemy.field}
        name="apiKey"
        set={data.alchemy.set}
      />
      {data.chains.map((chain) => (
        <Secret
          key={chain.key}
          label={chain.name}
          hint={
            chain.envLocked
              ? `${SOURCE[chain.source]}, set by this computer's environment (${chain.envVar})`
              : chain.customHost
                ? `${SOURCE.own}: ${chain.customHost}`
                : SOURCE[chain.source]
          }
          field={chain.field}
          name="url"
          set={Boolean(chain.customHost)}
          chain={chain.key}
        />
      ))}
    </SettingsGroup>
  );
}

/** One secret a network setting takes: Replace or Add opens its private field. */
function Secret({
  label,
  hint,
  field,
  name,
  set,
  chain,
}: {
  readonly label: string;
  readonly hint: string;
  readonly field: string | null;
  readonly name: "apiKey" | "url";
  readonly set: boolean;
  readonly chain?: NetworkKey;
}) {
  const queryClient = useQueryClient();
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairAgain, setPairAgain] = useState(false);

  const save = async (value: string | null) => {
    if (!field) return;
    setSaving(true);
    setError(null);
    setPairAgain(false);
    try {
      if (value === null) await clearPrivate(field, name);
      else await acceptPrivate(field, { [name]: value });
      await queryClient.invalidateQueries({ queryKey: RPCS_KEY });
      setTyping(false);
      setTyped("");
    } catch (caught) {
      if (mustPairAgain(caught)) setPairAgain(true);
      else setError(secretRefusal(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Setting label={label} hint={hint} stacked={typing}>
      {typing ? (
        <div className="flex flex-col gap-2">
          <SecretInput
            label={name === "url" ? `${label} URL` : label}
            labelHidden
            value={typed}
            placeholder={name === "url" ? "https://" : "Paste it here"}
            disabled={saving}
            onChange={(value) => {
              setTyped(value);
              setError(null);
            }}
            onEnter={() => void (typed.trim() ? save(typed.trim()) : undefined)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!typed.trim() || saving}
              onClick={() => void save(typed.trim())}
              className={SETTINGS_PRIMARY_BUTTON}
            >
              Save
            </button>
            <button type="button" onClick={() => setTyping(false)} className={SETTINGS_BUTTON}>
              Cancel
            </button>
          </div>
        </div>
      ) : field ? (
        <div className="flex gap-2" data-chain={chain}>
          {set ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(null)}
              className={SETTINGS_BUTTON}
            >
              {name === "url" ? "Reset" : "Remove"}
            </button>
          ) : null}
          <button type="button" onClick={() => setTyping(true)} className={SETTINGS_BUTTON}>
            {set ? "Replace" : name === "url" ? "Use my own" : "Add"}
          </button>
        </div>
      ) : null}
      {error ? <Refusal>{error}</Refusal> : null}
      {pairAgain ? <PairAgain then="Then save it again." /> : null}
    </Setting>
  );
}
