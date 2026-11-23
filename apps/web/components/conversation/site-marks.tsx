"use client";

import { Globe } from "lucide-react";
import Image from "next/image";
import { useState, type CSSProperties } from "react";

import { siteMark } from "@/lib/sources";
import { cn } from "@/lib/utils";

/**
 * The sites a step of the work read, under it: each its own mark and name, coming in one after
 * another, so the owner sees where Auni is reading as it reads.
 */
export function SiteMarks({ sites }: { readonly sites: readonly string[] }) {
  if (sites.length === 0) return null;
  return (
    <ul aria-label="Pages it read" className="auni-sites">
      {sites.map((site, index) => (
        <li key={site} className="auni-site" style={{ "--i": index } as CSSProperties}>
          <SiteMark site={site} size={16} />
          {site}
        </li>
      ))}
    </ul>
  );
}

/**
 * A site's own mark in a circle, or a plain globe for a site core found none for. Drawn as core
 * sends it, not through the image optimizer, which would ask core without the owner's session.
 */
function SiteMark({
  site,
  size,
}: {
  readonly site: string;
  readonly size: number;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const missing = failed === site;
  return (
    <span
      className={cn(
        "inline-flex flex-none items-center justify-center overflow-hidden rounded-full",
        missing ? "text-muted-foreground" : "bg-plate",
      )}
      style={{ width: size, height: size }}
    >
      {missing ? (
        <Globe aria-hidden style={{ width: size * 0.75, height: size * 0.75 }} />
      ) : (
        <Image
          alt=""
          className="size-full object-cover"
          height={size}
          onError={() => setFailed(site)}
          src={siteMark(site)}
          unoptimized
          width={size}
        />
      )}
    </span>
  );
}
