declare module "qrcode" {
  interface QrCodeCanvasOptions {
    readonly color?: {
      readonly dark?: string;
      readonly light?: string;
    };
    readonly errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    readonly margin?: number;
    readonly width?: number;
  }

  interface QrCodeApi {
    toCanvas(canvas: HTMLCanvasElement, text: string, options?: QrCodeCanvasOptions): Promise<void>;
  }

  const qrcode: QrCodeApi;
  export default qrcode;
}
