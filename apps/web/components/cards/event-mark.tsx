import { knownAsset, NETWORK_KEYS, NETWORKS } from "@auni/shared";

import { LogoImage, NoMark } from "@/components/brand/marks";

const SIZE = 38;

/** A network's logo by the name people read it by ("Base"); null for one Auni has no art for. */
function networkLogo(name: string): string | null {
  const key = NETWORK_KEYS.find((one) => NETWORKS[one].name === name);
  return key ? NETWORKS[key].logo : null;
}

/**
 * What an event card is about: the coin's own logo (or `logoUrl`, when core sent one), with the
 * network it moved on as a small badge; with no mark, the neutral glyph.
 */
export function EventMark({
  coin = null,
  logoUrl = null,
  network = null,
}: {
  readonly coin?: string | null;
  readonly logoUrl?: string | null;
  readonly network?: string | null;
}) {
  const src = logoUrl ?? (coin ? (knownAsset(coin)?.logoUrl ?? null) : null);
  const badge = network ? networkLogo(network) : null;
  return (
    <span className="relative flex flex-none">
      <LogoImage fallback={<NoMark size={SIZE} />} size={SIZE} src={src} />
      {badge && badge !== src ? (
        <LogoImage
          className="absolute -right-1 -bottom-1 shadow-[0_0_0_2px_var(--card)]"
          fallback={null}
          size={16}
          src={badge}
        />
      ) : null}
    </span>
  );
}
