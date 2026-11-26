import { Blocks } from "lucide-react";

import { hasMark, IntegrationMark } from "@/components/integrations/integration-mark";

/**
 * An app's mark at any size: its logo on its own tile, or, for one with no logo, a neutral tile
 * of the same shape, so its name beside it does the naming. Never its initials.
 */
export function AppMark({
  id,
  size,
}: {
  readonly id: string;
  readonly name?: string;
  readonly size: number;
}) {
  if (hasMark(id)) return <IntegrationMark integration={id} size={size} />;
  return (
    <span
      aria-hidden
      data-slot="app-mark"
      className="flex shrink-0 items-center justify-center bg-glyph-plate text-glyph-ink ring-1 ring-mark-line ring-inset"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
    >
      <Blocks style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={1.75} />
    </span>
  );
}
