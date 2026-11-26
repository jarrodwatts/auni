"use client";

import { Check } from "lucide-react";

import { useOwner } from "@/components/auth/owner-provider";
import { useUpdateMe } from "@/components/personalization/use-me";
import { LOOKS, useLook } from "@/lib/look";
import { cn } from "@/lib/utils";

import { SettingsRow, SettingsSection } from "./settings-layout";

/**
 * Visual theme cards: applies immediately locally AND persists `look` to core so every paired
 * browser and Auni chat stays in sync.
 */
export function AppearancePane({
  highlightedTarget,
}: {
  readonly highlightedTarget: string | null;
}) {
  const [look, setLook] = useLook();
  const updateMe = useUpdateMe();
  const { setOwner } = useOwner();
  const active = look ?? "light";

  const pick = (id: string) => {
    setLook(id === "light" ? null : id);
    updateMe.mutate(
      { look: id },
      {
        onSuccess: (updated) => setOwner(updated),
      },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        id="setting-theme"
        highlighted={highlightedTarget === "setting-theme"}
        title="Theme"
        description="Saved to your Auni profile and applied live across open tabs. You can also ask Auni in chat to switch themes."
      >
        <SettingsRow stacked>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {LOOKS.map((entry) => {
              const selected = entry.id === active;
              const isDark = entry.id === "dark";
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pick(entry.id)}
                  className={cn(
                    "group flex flex-col gap-2.5 rounded-card border p-3 text-left transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35",
                    selected
                      ? "border-primary bg-primary/[0.06]"
                      : "border-foreground/[0.08] bg-background hover:border-foreground/[0.16]",
                  )}
                >
                  {/* A miniature of the look, in its own colours whatever the page wears. */}
                  <div
                    className={cn(
                      "flex h-[74px] w-full overflow-hidden rounded-control border border-border bg-background",
                      isDark ? "look-dark" : "look-light",
                    )}
                  >
                    <div className="flex w-12 flex-col gap-1.5 border-r border-foreground/[0.08] bg-sidebar p-2">
                      <span className="h-2 w-6 rounded-full bg-foreground/20" />
                      <span className="h-1.5 w-7 rounded-full bg-foreground/10" />
                      <span className="h-1.5 w-5 rounded-full bg-foreground/10" />
                    </div>
                    <div className="flex flex-1 flex-col justify-between p-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="size-2.5 rounded-full bg-primary" />
                        <span className="h-2 w-16 rounded-full bg-foreground/20" />
                      </div>
                      <div className="rounded-control border border-foreground/[0.08] bg-card px-2 py-1.5">
                        <span className="block h-1.5 w-20 rounded-full bg-foreground/25" />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 px-0.5">
                    <div>
                      <span className="block text-ui font-medium text-ink">{entry.name}</span>
                      <span className="block text-caption text-muted-foreground">
                        {entry.id === "light"
                          ? "Crisp daylight surface"
                          : entry.id === "dark"
                            ? "Low-glare charcoal surface"
                            : "Provided by an installed app"}
                      </span>
                    </div>
                    {selected ? (
                      <span className="grid size-5 flex-none place-items-center rounded-full bg-primary text-background">
                        <Check className="size-3" strokeWidth={2.8} />
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
