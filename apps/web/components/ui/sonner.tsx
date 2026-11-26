"use client";

import "./sonner.css";

import { InfoIcon, TriangleAlertIcon } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { Mascot } from "@/components/brand/mascot";
import { useMediaQuery } from "@/lib/use-viewport";

/** Toasts dock bottom-right beside the workspace on desktop, centered on mobile. */
const DESKTOP_QUERY = "(min-width: 640px)";

/** The mascot fronts every toast that is about something Auni did; the look lives in globals.css (`.auni-toaster`). */
const MASCOT_SIZE = 36;

const Toaster = ({ ...props }: ToasterProps) => {
  const desktop = useMediaQuery(DESKTOP_QUERY);

  return (
    <Sonner
      theme="light"
      className="toaster auni-toaster group"
      position={desktop ? "bottom-right" : "bottom-center"}
      icons={{
        success: <Mascot className="auni-onb-mascot" size={MASCOT_SIZE} state="celebrating" />,
        info: <InfoIcon className="size-4 text-ring" />,
        warning: <TriangleAlertIcon className="size-4 text-ink-soft" />,
        error: <Mascot className="auni-onb-mascot" size={MASCOT_SIZE} state="sad" />,
        loading: <Mascot className="auni-loading-mascot" size={MASCOT_SIZE} state="thinking" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--color-ink)",
          "--normal-border": "color-mix(in oklab, var(--foreground) 8%, transparent)",
          "--border-radius": "20px",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
