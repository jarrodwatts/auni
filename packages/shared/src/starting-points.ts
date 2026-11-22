import { z } from "zod";

import { TEXT_WIDTHS } from "./text-widths.ts";

/** Where a fact came from: the app that saw it ("auni" for Auni's own), and what it was. */
const factSourceSchema = z.object({
  app: z.string(),
  /** "Will the Fed cut in December?", "BTC on Hyperliquid", "Your money". */
  label: z.string(),
  link: z.string().nullable(),
});
export type FactSource = z.infer<typeof factSourceSchema>;

/**
 * How wide a starting point's line may be, in pixels, as a phone 360 wide draws the rows: the
 * room the web's layout leaves there (274), less 6 to spare. The web's starting-points.test.ts
 * holds its layout to it.
 */
export const LINE_WIDTH_PX = 268;
/** The rows' text size on a phone, where room is shortest. */
export const PHONE_TEXT_PX = 15;
/**
 * How many starting points a new chat shows: always this many, so the rows drawn while they're
 * written are as many as come, and nothing on the page moves when they arrive.
 */
export const STARTING_POINTS = 4;
/** The most characters an action may have ("Put it to work"), so it stays a few words. */
export const ACTION_MAX = 14;
/** SF Pro, which an iPhone draws, runs about 6% wider than the Helvetica metrics measured. */
const WIDER_FONT = 1.06;
/** The rows' letter spacing, -0.01em. */
const TRACKING_EM = -0.01;
/** A blank a title leaves to be filled in ("AI bubble burst by...?", "Anthropic IPO by __?"). */
const BLANK = /…|\.\.\.|__/u;

/** A starting point's two parts, what's true and what to do about it. */
export interface StartingLine {
  readonly statement: string;
  readonly action: string;
}

/**
 * How wide a line is drawn on an iPhone, in pixels at the phone's text size: each character's
 * own width (a character the table lacks counts as a W), the gap between the parts, and room for
 * SF Pro being wider than the metrics.
 */
export function lineWidth({ statement, action }: StartingLine): number {
  const width = [...`${statement} ${action}`].reduce(
    (sum, char) => sum + ((TEXT_WIDTHS[char] ?? TEXT_WIDTHS.W!) / 1000 + TRACKING_EM),
    0,
  );
  return width * PHONE_TEXT_PX * WIDER_FONT;
}

/**
 * Whether a statement and an action, whole, fit one row on a phone 360 wide, measured rather
 * than counted. A part with a blank in it, cut or left to be filled in, is no line to show.
 */
export function lineFits(line: StartingLine): boolean {
  const { statement, action } = line;
  return (
    statement.length > 0 &&
    action.length > 0 &&
    action.length <= ACTION_MAX &&
    !BLANK.test(statement) &&
    !BLANK.test(action) &&
    lineWidth(line) <= LINE_WIDTH_PX
  );
}

/**
 * The first of `lines`, the fullest way of saying it first, that fits one row whole; null when
 * none does. A line is never cut to fit: a cut phrase ("Fed decision in…") reads as broken.
 */
export function firstThatFits(lines: readonly StartingLine[]): StartingLine | null {
  return lines.find(lineFits) ?? null;
}

/**
 * A way into a new chat, drawn from what Auni sees of the owner: one line in two parts, what's
 * true and what to do about it ("PUMP fell 16.7% today." "Why?"), a picture of what it's
 * about, the message a tap sends, and the facts it came from.
 */
const startingPointSchema = z
  .object({
    statement: z.string(),
    action: z.string(),
    /** The full message, with the numbers it rests on. */
    prompt: z.string(),
    /**
     * What it's about, as its own picture: a coin's logo, a market's image as its venue publishes
     * it. Null for the owner's own money or Auni, which wear Auni's mascot.
     */
    image: z.string().nullable(),
    sources: z.array(factSourceSchema).min(1),
  })
  .refine(lineFits, "A starting point's line must fit one row.");
export type StartingPoint = z.infer<typeof startingPointSchema>;

/** `GET /starting-points`: those saved, and whether new ones are on their way. */
export const startingPointsWireSchema = z.object({
  points: z.array(startingPointSchema),
  pending: z.boolean(),
});
export type StartingPointsWire = z.infer<typeof startingPointsWireSchema>;
