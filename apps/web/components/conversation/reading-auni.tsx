"use client";

import { Quote } from "lucide-react";
import { useEffect, useState } from "react";

import { MascotArt } from "@/components/brand/mascot-art";
import { SiteMark } from "@/components/conversation/site-marks";
import { LogoImage, Monogram } from "@/components/brand/marks";
import type { ReadPage } from "@/lib/pages-read";
import { nextLandingIn, nextPage, pileOf } from "@/lib/reading-pile";

import styles from "./reading-auni.module.css";

/**
 * Auni at work on a chat's first answer, as the newest line of its work, from the moment it's
 * sent: reading the owner's take first, its page at the bottom of the pile, then each page the
 * work reads, landing on the pile the moment it's read as Auni nods to it: a site wearing its own
 * mark, or a pick Auni is weighing wearing its logo. Once all have landed it goes round them again
 * while the work goes on (lib/reading-pile.ts). While the web is searched it looks along the pile
 * instead, which riffles. So the longest wait has Auni in it, busy with their words and what it
 * found, rather than a list alone.
 */
export function ReadingAuni({
  pages,
  searching,
}: {
  readonly pages: readonly ReadPage[];
  /** The web is being searched or a page opened, which the pile riffles through as it waits. */
  readonly searching: boolean;
}) {
  const [landed, setLanded] = useState<readonly number[]>([]);
  const read = pages.length;
  useEffect(() => {
    const wait = nextLandingIn(landed, read);
    if (wait === null) return undefined;
    const landing = window.setTimeout(
      () => setLanded((was) => [...was, nextPage(was, read)]),
      wait,
    );
    return () => window.clearTimeout(landing);
  }, [landed, read]);
  const pile = pileOf(landed, pages);
  const reading = pile.at(-1)?.page ?? null;
  return (
    <div
      aria-hidden
      className={styles.desk}
      data-searching={searching || undefined}
      data-take-lands
    >
      {/* A new key each landing, so each page it reads gets its own nod. */}
      <span key={`auni-${landed.length}`} className={styles.auni}>
        <MascotArt />
      </span>
      <span className={styles.pile}>
        {pile.map(({ landing, page }, index) => (
          <span key={landing} className={styles.page} data-depth={pile.length - 1 - index}>
            <PageMark page={page} />
            <i />
            <i />
            <i />
          </span>
        ))}
      </span>
      <span key={`site-${landed.length}-${searching}`} className={styles.site} data-reading-site>
        {searching ? (
          "Searching the web"
        ) : reading?.kind === "pick" ? (
          <>
            Weighing <b>{reading.name}</b>
          </>
        ) : (
          <>
            Reading <b>{reading?.site ?? "your take"}</b>
          </>
        )}
      </span>
    </div>
  );
}

/** What a page on the pile wears: the take's quote, a site's mark, or a pick's logo. */
function PageMark({ page }: { readonly page: ReadPage | null }) {
  if (page === null)
    return <Quote className="size-[18px] fill-current text-primary/50" strokeWidth={0} />;
  if (page.kind === "site") return <SiteMark site={page.site} size={22} />;
  return <LogoImage fallback={<Monogram name={page.name} size={22} />} size={22} src={page.logo} />;
}
