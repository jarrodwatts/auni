import Image, { type StaticImageData } from "next/image";

import { cn } from "@/lib/utils";

import celebrating from "@/public/brand/auni-celebrating.png";
import color from "@/public/brand/auni-mascot-color.png";
import executing from "@/public/brand/auni-executing.png";
import listening from "@/public/brand/auni-listening.png";
import mono from "@/public/brand/auni-mascot-mono.png";
import sad from "@/public/brand/auni-sad.png";
import thinking from "@/public/brand/auni-thinking.png";

export type MascotState =
  "color" | "mono" | "listening" | "thinking" | "executing" | "celebrating" | "sad";

const SOURCES: Record<MascotState, StaticImageData> = {
  color,
  mono,
  listening,
  thinking,
  executing,
  celebrating,
  sad,
};

interface MascotProps {
  readonly alt?: string;
  readonly state?: MascotState;
  readonly size?: number;
  readonly className?: string;
  readonly eager?: boolean;
  readonly priority?: boolean;
}

export function Mascot({
  alt = "Auni",
  state = "color",
  size = 32,
  className,
  eager,
  priority,
}: MascotProps) {
  return (
    <Image
      alt={alt}
      className={cn("object-contain", className)}
      height={size}
      loading={eager ? "eager" : undefined}
      priority={priority}
      src={SOURCES[state]}
      width={size}
    />
  );
}
