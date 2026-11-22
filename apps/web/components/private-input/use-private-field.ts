"use client";

import type { PrivateFieldWire } from "@auni/shared";
import { useCallback, useEffect, useState } from "react";

import { mustPairAgain } from "@/components/auth/pair-again";
import { CoreApiError } from "@/lib/core";
import { readPrivateField } from "@/lib/data/private";

/**
 * A private field as core draws it now, read fresh each time it's shown and never cached. One
 * that takes proof the owner is there says so here (`pair_again`), before anything is typed.
 */
type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly field: PrivateFieldWire }
  | { readonly kind: "pair_again" }
  /** Core takes nothing by this id now: what it asked for is given, or can't be. */
  | { readonly kind: "gone" }
  | { readonly kind: "failed" };

/** The field by `id`, or nothing read while `id` is null; `reload` reads it again. */
export function usePrivateField(id: string | null): Loaded & { readonly reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [reads, setReads] = useState(0);
  const reload = useCallback(() => setReads((count) => count + 1), []);
  useEffect(() => {
    if (id === null) return;
    let current = true;
    readPrivateField(id).then(
      (field) => current && setLoaded({ kind: "ready", field }),
      (error: unknown) =>
        current &&
        setLoaded(
          mustPairAgain(error)
            ? { kind: "pair_again" }
            : error instanceof CoreApiError && error.status === 404
              ? { kind: "gone" }
              : { kind: "failed" },
        ),
    );
    return () => {
      current = false;
    };
  }, [id, reads]);
  return { ...loaded, reload };
}
