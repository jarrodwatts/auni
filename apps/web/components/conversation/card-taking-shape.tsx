"use client";

import { AutoHeight } from "@/components/motion/auto-height";
import { LogoImage, Monogram } from "@/components/specialist/marks";
import type { PickWeighed } from "@/lib/tool-results";

import styles from "./card-taking-shape.module.css";

/** The rows the outline holds until Auni has chosen, the most a first card usually holds. */
const ROWS = 3;

/**
 * The card a chat's first answer is building, in outline under the work while Auni researches: its
 * frame, header and empty rows as the research starts, its buttons as Auni puts the card together,
 * and a row for each pick only once its proposal chose them. A pick it is only weighing stays on
 * the reading pile, so the outline never shows a company the card won't hold. The card itself
 * takes its place when the answer lands, so the card grows out of the wait.
 */
export function CardTakingShape({
  chosen,
  making,
}: {
  /** The picks its proposal put on the card, once it has. */
  readonly chosen: readonly PickWeighed[] | null;
  /** Auni is putting the card together. */
  readonly making: boolean;
}) {
  const picks = chosen ?? [];
  const rows = picks.length > 0 ? picks.length : ROWS;
  return (
    <div aria-hidden className={styles.outline} data-card-taking-shape>
      <AutoHeight>
        <div className={styles.inside}>
          <div className={styles.head}>
            <i className={styles.orb} />
            <span className={styles.lines}>
              <i />
              <i />
            </span>
            <i className={styles.amount} />
          </div>
          <div className={styles.rows}>
            {Array.from({ length: rows }, (_, row) => {
              const pick = picks[row];
              return (
                <div
                  key={pick?.name ?? row}
                  className={styles.row}
                  data-pick={pick ? "" : undefined}
                >
                  {pick ? (
                    <span className={styles.mark}>
                      <LogoImage
                        fallback={<Monogram name={pick.name} size={36} />}
                        size={36}
                        src={pick.logo}
                      />
                    </span>
                  ) : (
                    <i className={styles.logo} />
                  )}
                  <span className={styles.lines}>
                    {pick ? <b>{pick.name}</b> : <i />}
                    <i />
                  </span>
                  <i className={styles.sum} />
                </div>
              );
            })}
          </div>
          {making ? (
            <div className={styles.foot}>
              <i />
              <i />
            </div>
          ) : null}
        </div>
      </AutoHeight>
    </div>
  );
}
