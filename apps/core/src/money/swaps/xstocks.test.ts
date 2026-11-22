import { describe, expect, it } from "vitest";

import { stockNamed, type XStock } from "./xstocks.ts";

const stock = (symbol: string, ticker: string, name: string): XStock => ({
  symbol,
  ticker,
  name,
  logoUrl: "",
  solanaMint: null,
  evmAddress: null,
});

// Vertex's ticker is Vertiv's xStock symbol but for the case of its x.
const vertex = stock("VRTXx", "VRTX", "Vertex Pharmaceuticals xStock");
const vertiv = stock("VRTx", "VRT", "Vertiv Holdings Co xStock");
const nvidia = stock("NVDAx", "NVDA", "NVIDIA xStock");
const catalog = [vertex, vertiv, nvidia];

describe("the xStock a name means", () => {
  it("reads a symbol or ticker as written before any case", () => {
    expect(stockNamed(catalog, "VRTx")).toBe(vertiv);
    expect(stockNamed(catalog, "VRT")).toBe(vertiv);
    expect(stockNamed(catalog, "VRTX")).toBe(vertex);
    expect(stockNamed(catalog, "VRTXx")).toBe(vertex);
  });

  it("then a ticker or symbol in any case, then the start of the company's name", () => {
    expect(stockNamed(catalog, "nvda")).toBe(nvidia);
    expect(stockNamed(catalog, "nvdax")).toBe(nvidia);
    expect(stockNamed(catalog, " Vertiv ")).toBe(vertiv);
    expect(stockNamed(catalog, "Nvidia")).toBe(nvidia);
  });

  it("names nothing it doesn't hold", () => {
    expect(stockNamed(catalog, "Vertiginous")).toBeUndefined();
    expect(stockNamed(catalog, " ")).toBeUndefined();
  });
});
