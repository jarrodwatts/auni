import type { ReactNode } from "react";

/** A section of the sheet: a quiet name over what it holds, as a specialist's pane has them. */
export function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-8">
      <h3 className="mb-2.5 text-[13px] font-medium text-faint">{title}</h3>
      {children}
    </section>
  );
}
