"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { QR_COLORS } from "@/lib/qr";
import { cn } from "@/lib/utils";

/**
 * Crisp scannable QR code rendered to canvas on `bg-plate` so cameras read it cleanly in both
 * light and dark looks.
 */
export function QrCodeCanvas({
  value,
  label,
  size = 160,
  className,
}: {
  readonly value: string;
  readonly label: string;
  readonly size?: number;
  readonly className?: string;
}) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvas || !value) return;
    void QRCode.toCanvas(canvas, value, {
      width: size * 2,
      margin: 1,
      errorCorrectionLevel: "M",
      color: QR_COLORS,
    });
  }, [canvas, size, value]);

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center rounded-card border border-foreground/[0.08] bg-plate p-2.5",
        className,
      )}
    >
      <canvas
        ref={setCanvas}
        role="img"
        aria-label={label}
        style={{ width: size, height: size }}
        className="block rounded-control"
      />
    </div>
  );
}
