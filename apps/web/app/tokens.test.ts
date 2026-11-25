import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { cn, SCALE } from "@/lib/utils";

// Every colour a person sees comes from a token (tokens.css), so a look, light or dark or one an
// app brings, changes them all at once. A colour written into a component is one the look can't
// reach: light words on a card that stayed white. This fails the next one that is written in.

const WEB = fileURLToPath(new URL("..", import.meta.url));
const APPS = join(WEB, "../core/src/apps");

/**
 * The colours that may be written in, by file, each for a reason no token answers. One that is
 * no longer in its file fails the test too, so this list never outlives what it allows.
 */
const WRITTEN_IN: Readonly<Record<string, { readonly why: string; readonly colours: string[] }>> = {
  "components/places/sidebar.css": {
    why: "black inside a CSS mask says where it shows; nobody sees it as a colour",
    colours: ["#000", "rgb(0 0 0 / 0.82)", "rgb(0 0 0 / 0.5)", "rgb(0 0 0 / 0.2)"],
  },
  "components/places/chat-row.css": {
    why: "black inside a CSS mask says where it shows; nobody sees it as a colour",
    colours: ["#000"],
  },
  "components/motion/rolling-number.css": {
    why: "black inside a CSS mask says where it shows; nobody sees it as a colour",
    colours: ["#000"],
  },
  "components/ai-elements/conversation.css": {
    why: "black inside a CSS mask says where it shows; nobody sees it as a colour",
    colours: ["#000"],
  },
  "components/motion/spotlight-shimmer.css": {
    why: "black inside a CSS mask says where it shows; nobody sees it as a colour",
    colours: ["#000", "rgb(0 0 0 / 0.5)", "rgb(0 0 0 / 0.2)"],
  },
  "components/motion/status-mark.module.css": {
    why: "black inside a CSS mask cuts the arc to a ring; nobody sees it as a colour",
    colours: ["#000"],
  },
  "components/ui/auni-sheet.tsx": {
    why: "black inside a CSS mask fades the sheet's handle; nobody sees it as a colour",
    colours: ["#000"],
  },
  "lib/qr.ts": {
    why: "a canvas takes colours, not classes, and a camera reads a QR code as ink on white",
    colours: ["#101623", "#ffffff"],
  },
  "app/layout.tsx": {
    why: "the browser's own bar reads no stylesheet: the light page's colour, written out",
    colours: ["#ffffff"],
  },
};

/** Whole drawings: every colour in them is the picture's own, the same in every look. */
const DRAWINGS: readonly string[] = [
  "components/brand/mascot-art.tsx",
  "components/brand/vault-art.tsx",
  "components/brand/edge-mascot.module.css",
];

/** Where colours live, and the looks apps bring, which may only give those tokens other values. */
const TOKENS: readonly string[] = ["app/tokens.css", "app/app-themes.generated.css"];

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const PAINTS =
  "bg|text|border|ring|ring-offset|fill|stroke|from|to|via|outline|shadow|inset-shadow|drop-shadow|divide|decoration|placeholder|caret|accent";

/** Each way a colour gets written in instead of read from a token. */
const WRITTEN: readonly RegExp[] = [
  // A hex value: #fff, #ffffff, with or without its alpha.
  /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z-])/giu,
  // A colour function given numbers. One given a token or a hue from data (`hsl(var(--hue) …)`,
  // `hsl(${h} …)`) is computed, not written in.
  /(?<![a-z-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[\d.][^)]*\)/giu,
  // A class from Tailwind's fixed palette: bg-white, text-black, border-slate-200.
  new RegExp(`(?<![\\w-])(?:${PAINTS})-(?:white|black|(?:${PALETTE})-\\d{2,3})(?![\\w-])`, "gu"),
  // The two colours CSS names that every look gets wrong.
  /(?<![\w-])(?:white|black)(?![\w-])/gu,
  // A class for the dark look alone: a token holds both looks, so nothing needs a second class.
  /(?<![\w-])dark:[\w[-]+/gu,
];

/** `source` without its comments, which may talk about colours freely. */
const code = (source: string) =>
  source.replace(/\/\*[^]*?\*\//gu, "").replace(/(^|\s)\/\/.*$/gmu, "$1");

/** Every colour written into `source`. */
function writtenIn(source: string): string[] {
  const bare = code(source);
  return WRITTEN.flatMap((pattern) => bare.match(pattern) ?? []);
}

function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" || entry.name.startsWith(".")
        ? []
        : filesUnder(path, keep);
    return keep(entry.name) ? [path] : [];
  });
}

/** What a person sees is drawn by: the web's own code and styles, and the cards apps draw. */
const SEEN: readonly string[] = [
  ...["app", "components", "lib"].flatMap((dir) =>
    filesUnder(join(WEB, dir), (name) => /\.(?:tsx?|css)$/u.test(name) && !name.includes(".test.")),
  ),
  ...filesUnder(APPS, (name) => name.endsWith(".tsx")),
].filter((path) => ![...DRAWINGS, ...TOKENS].includes(relative(WEB, path)));

describe("colours", () => {
  it("come from a token, never written into a component", () => {
    const stray = SEEN.flatMap((path) => {
      const name = relative(WEB, path);
      const allowed = new Set(WRITTEN_IN[name]?.colours);
      return writtenIn(readFileSync(path, "utf8"))
        .filter((colour) => !allowed.has(colour.toLowerCase()))
        .map((colour) => `${name}: ${colour}`);
    });
    expect(stray, "use a token from app/tokens.css, or add the one the set lacks").toEqual([]);
  });

  it("are allowed in a file only while they are still there", () => {
    for (const [name, { colours }] of Object.entries(WRITTEN_IN)) {
      const found = new Set(
        writtenIn(readFileSync(join(WEB, name), "utf8")).map((colour) => colour.toLowerCase()),
      );
      expect(
        colours.filter((colour) => !found.has(colour)),
        name,
      ).toEqual([]);
    }
  });

  it("are found however they are written", () => {
    expect(
      writtenIn(
        'className="bg-white text-[#5c6472] ring-slate-200 shadow-[0_1px_2px_rgb(16_22_35/0.05)]" // #fff here is talk',
      ),
    ).toEqual(["#5c6472", "rgb(16_22_35/0.05)", "bg-white", "ring-slate-200"]);
    // Tailwind writes a space as an underscore, so a colour there ends at one.
    expect(writtenIn('"bg-[linear-gradient(180deg,#fdfdfe_0%,#f1f4f8_100%)]"')).toEqual([
      "#fdfdfe",
      "#f1f4f8",
    ]);
    expect(writtenIn('style={{ color: "white", background: "hsl(210 40% 96%)" }}')).toEqual([
      "hsl(210 40% 96%)",
      "white",
    ]);
    expect(writtenIn('className="bg-card dark:bg-popover"')).toEqual(["dark:bg-popover"]);
    // A hue from data and a token are computed, and `whitespace-nowrap` is no colour.
    expect(
      writtenIn(
        "bg-card text-ink whitespace-nowrap hsl(${hue} 78% 95%) hsl(var(--orb-h)_95%_97%) href='#main-content'",
      ),
    ).toEqual([]);
  });
});

// Type and shape come from the same file: a font size is one of the scale's steps (`text-meta`,
// `text-card-money`) and a corner one of three radii or a pill (`rounded-control`,
// `rounded-card`, `rounded-sheet`, `rounded-full`). A size or a radius written in is the next
// screen that looks a little different from the rest, so this fails one.

/** Each way a size or a corner gets written in instead of read from a token. */
const OFF_SCALE: readonly RegExp[] = [
  // An arbitrary size or radius: text-[13.5px], rounded-[14px], rounded-t-[22px].
  /(?<![\w-])text-\[(?:length:)?[\d.]+(?:px|rem|em)\]/gu,
  /(?<![\w-])rounded(?:-[a-z]{1,2})?-\[[^\]]+\]/gu,
  // Tailwind's own steps, which say a size, not what it's for.
  /(?<![\w-])text-(?:xs|sm|base|lg|[2-9]?xl)(?![\w-])/gu,
  /(?<![\w-])rounded(?:-[a-z]{1,2})?-(?:xs|sm|md|lg|[2-4]?xl)(?![\w-])/gu,
  // In a stylesheet: a size or a corner that isn't a token (a pill, 999px or 50%, is a shape).
  /font-size:(?!\s*(?:var\(--text-|inherit|calc\(var\())[^;]+/gu,
  /border-radius:(?!\s*(?:var\(--radius-|999px|9999px|50%|0[;\s]|inherit))[^;]+/gu,
];

function offScale(source: string): string[] {
  const bare = code(source);
  return OFF_SCALE.flatMap((pattern) => bare.match(pattern) ?? []);
}

describe("type and shape", () => {
  it("come from the scale, never written into a component", () => {
    const stray = SEEN.flatMap((path) =>
      offScale(readFileSync(path, "utf8")).map((found) => `${relative(WEB, path)}: ${found}`),
    );
    expect(stray, "use a text-* step or a radius from app/tokens.css").toEqual([]);
  });

  it("are found however they are written", () => {
    expect(
      offScale(
        'className="text-[12.5px] sm:text-[40px] rounded-[14px] rounded-t-[22px] text-sm rounded-md rounded-tl-xl"',
      ),
    ).toEqual([
      "text-[12.5px]",
      "text-[40px]",
      "rounded-[14px]",
      "rounded-t-[22px]",
      "text-sm",
      "rounded-md",
      "rounded-tl-xl",
    ]);
    expect(offScale("a { font-size: 13px; border-radius: 18px; }")).toEqual([
      "font-size: 13px",
      "border-radius: 18px",
    ]);
    expect(
      offScale(
        'className="text-meta text-card-money rounded-control rounded-full text-ink text-[color:var(--x)]" a { font-size: var(--text-ui); border-radius: 999px; }',
      ),
    ).toEqual([]);
  });
});

describe("the scale cn knows", () => {
  const tokens = readFileSync(join(WEB, "app/tokens.css"), "utf8");
  const declared = (prefix: string) =>
    [...tokens.matchAll(new RegExp(`^\\s*--${prefix}-([a-z-]+):`, "gmu"))]
      .map(([, name]) => name!)
      .filter((name) => !name.includes("--") && !/^(?:xs|sm|md|lg|base|[2-9]?xl)$/u.test(name));

  it("is every step tokens.css declares", () => {
    expect(SCALE.text).toEqual(declared("text").filter((name) => !name.includes("-line")));
    expect([...SCALE.radius]).toEqual(declared("radius"));
    expect([...SCALE.shadow]).toEqual(declared("shadow"));
  });

  it("keeps a size beside a colour", () => {
    expect(cn("text-hero-money text-foreground", "mt-1")).toBe(
      "text-hero-money text-foreground mt-1",
    );
    expect(cn("rounded-card", "rounded-sheet")).toBe("rounded-sheet");
  });
});
