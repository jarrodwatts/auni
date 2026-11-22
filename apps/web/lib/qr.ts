/**
 * A QR code's two colours. A canvas takes colours, not classes, and a code is read by a camera, so
 * it is ink on white in every look: the values of --color-plate-ink and --color-plate.
 */
export const QR_COLORS = { dark: "#101623", light: "#ffffff" } as const;
