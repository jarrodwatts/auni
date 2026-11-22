import type { ReactNode } from "react";

/** One of Portfolio's sections, under the same label as every other. */
export function PortfolioSection({
  title,
  className,
  children,
}: {
  readonly title: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} className={className}>
      <h2 className="mb-3 text-section text-ink">{title}</h2>
      {children}
    </section>
  );
}
